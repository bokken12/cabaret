//! Local Codex history. Read session metadata and bounded transcript excerpts, never the entire
//! history on each refresh. Persisted activity does not establish whether another host is running.
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};

use cabaret_types::{Result, TimestampMs};
use serde_json::Value;

use crate::{Provider, Session, SessionId, validate_session_id};

const EXCERPT_BYTES: u64 = 64 * 1024;
const INDEX_INTERVAL: Duration = Duration::from_secs(15);

struct Entry {
    id: SessionId,
    directory: PathBuf,
    created: Option<TimestampMs>,
    cached: Option<(SystemTime, u64, Session)>,
}

#[derive(Default)]
struct Index {
    scanned: Option<Instant>,
    entries: HashMap<PathBuf, Entry>,
}

pub struct Codex {
    config_dir: PathBuf,
    index: Mutex<Index>,
}

impl Codex {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            config_dir,
            index: Mutex::new(Index::default()),
        }
    }

    pub fn locate() -> Result<Self> {
        let config_dir = match std::env::var_os("CODEX_HOME") {
            Some(dir) => PathBuf::from(dir),
            None => std::env::home_dir()
                .ok_or("cannot determine the home directory")?.join(".codex"),
        };
        Ok(Self::new(config_dir))
    }

    /// Sessions launched within a worktree; a session launched above it needs an explicit link.
    pub fn sessions_in(&self, dir: &Path) -> Result<Vec<Session>> {
        let dir = normalized(dir);
        self.lookup(|entry| entry.directory.starts_with(&dir))
    }

    pub fn session(&self, id: &SessionId) -> Result<Option<Session>> {
        validate_session_id(id)?;
        Ok(self.lookup(|entry| entry.id == *id)?.into_iter().next())
    }

    fn lookup(&self, matches: impl Fn(&Entry) -> bool) -> Result<Vec<Session>> {
        let mut index = self.index.lock().map_err(|_| "Codex session index lock poisoned")?;
        if index.scanned.is_none_or(|at| at.elapsed() >= INDEX_INTERVAL) {
            let mut paths = Vec::new();
            history_files(&self.config_dir.join("sessions"), 3, &mut paths)?;
            let mut old = std::mem::take(&mut index.entries);
            for path in paths {
                let entry = old.remove(&path).or_else(|| read_metadata(&path));
                if let Some(entry) = entry {
                    index.entries.insert(path, entry);
                }
            }
            index.scanned = Some(Instant::now());
        }
        let mut sessions = Vec::new();
        for (path, entry) in &mut index.entries {
            if matches(entry) {
                match read_session(path, entry) {
                    Ok(session) => sessions.push(session),
                    // Rotation/deletion can race with directory discovery.
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
        sessions.sort_by_key(|session| std::cmp::Reverse(session.last_active));
        Ok(sessions)
    }
}

fn normalized(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_owned())
}

/// Codex stores rollouts under sessions/YYYY/MM/DD. Do not follow directory symlinks or scan
/// arbitrary trees; archived history is intentionally excluded from automatic discovery.
fn history_files(dir: &Path, depth: usize, paths: &mut Vec<PathBuf>) -> std::io::Result<()> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        let kind = entry.file_type()?;
        let path = entry.path();
        if kind.is_dir() && depth > 0 {
            history_files(&path, depth - 1, paths)?;
        } else if kind.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") {
            paths.push(path);
        }
    }
    Ok(())
}

fn timestamp(value: &Value) -> Option<TimestampMs> {
    value
        .get("timestamp")?
        .as_str()
        .and_then(|text| humantime::parse_rfc3339(text).ok())
        .filter(|time| *time >= SystemTime::UNIX_EPOCH)
        .map(TimestampMs::from)
}

fn read_metadata(path: &Path) -> Option<Entry> {
    let mut head = Vec::new();
    BufReader::new(fs::File::open(path).ok()?)
        .take(EXCERPT_BYTES)
        .read_until(b'\n', &mut head)
        .ok()?;
    let first = head.split(|byte| *byte == b'\n').next()?;
    let value: Value = serde_json::from_slice(first).ok()?;
    if value.get("type")?.as_str()? != "session_meta" {
        return None;
    }
    let payload = value.get("payload")?;
    let id = SessionId(payload.get("id")?.as_str()?.to_owned());
    validate_session_id(&id).ok()?;
    let directory = Path::new(payload.get("cwd")?.as_str()?);
    if !directory.is_absolute() {
        return None;
    }
    Some(Entry {
        id,
        directory: normalized(directory),
        created: timestamp(&value),
        cached: None,
    })
}

fn read_session(path: &Path, entry: &mut Entry) -> std::io::Result<Session> {
    let mut file = fs::File::open(path)?;
    let metadata = file.metadata()?;
    let modified = metadata.modified()?;
    if let Some((previous, size, session)) = &entry.cached {
        if *previous == modified && *size == metadata.len() {
            return Ok(session.clone());
        }
    }
    let mut head = Vec::new();
    (&mut file).take(EXCERPT_BYTES).read_to_end(&mut head)?;
    let mut session = Session {
        id: entry.id.clone(),
        provider: Provider::Codex,
        directory: entry.directory.clone(),
        title: None,
        last_active: entry.created,
        live: None,
    };
    for line in head.split(|byte| *byte == b'\n') {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        if value["type"] == "event_msg" && value["payload"]["type"] == "user_message" {
            session.title = value["payload"]["message"]
                .as_str()
                .and_then(|message| message.lines().find(|line| !line.trim().is_empty()))
                .filter(|line| !line.starts_with('<'))
                .map(|line| line.chars().take(160).collect());
            if session.title.is_some() {
                break;
            }
        }
    }
    let offset = metadata.len().saturating_sub(EXCERPT_BYTES);
    file.seek(SeekFrom::Start(offset))?;
    let mut tail = Vec::new();
    file.take(EXCERPT_BYTES).read_to_end(&mut tail)?;
    for line in tail.split(|byte| *byte == b'\n').rev() {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        if let Some(at) = timestamp(&value) {
            session.last_active = Some(at);
            break;
        }
    }
    entry.cached = Some((modified, metadata.len(), session.clone()));
    Ok(session)
}

impl crate::Harness for Codex {
    fn info(&self) -> crate::HarnessInfo {
        crate::HarnessInfo {
            provider: Provider::Codex,
            label: "Codex".into(),
            requires_directory: false,
            identification: "Reads CODEX_THREAD_ID; otherwise supply --id. Launch directory comes from history.".into(),
        }
    }

    fn sessions_in(&self, directory: &Path) -> Result<Vec<Session>> { self.sessions_in(directory) }

    fn session(&self, id: &SessionId, _directory: Option<&Path>) -> Result<Option<Session>> { self.session(id) }

    fn current_session_id(&self) -> Result<Option<SessionId>> {
        std::env::var("CODEX_THREAD_ID").ok().map(|id| {
            let id = SessionId(id);
            validate_session_id(&id)?;
            Ok(id)
        }).transpose()
    }

    fn resume(&self, id: &SessionId, directory: &Path) -> Result<crate::ResumeCommand> {
        crate::harness::resume_command("codex", &["resume"], id, directory)
    }
}
