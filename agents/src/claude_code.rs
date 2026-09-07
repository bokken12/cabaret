//! Claude Code keeps its state under `~/.claude` (or `$CLAUDE_CONFIG_DIR`). Two pieces matter here:
//! transcripts under `projects/<launch directory>/`, one JSON-Lines file per session, and the
//! registry of running sessions under `sessions/`, one JSON file per process. Neither format is
//! documented, so only the fields used here are parsed and line types we do not know are skipped.

use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

use cabaret_types::{Result, TimestampMs};
use serde::{Deserialize, de::IgnoredAny};

use crate::{Session, SessionId, Status};

pub struct ClaudeCode {
    config_dir: PathBuf,
}

/// One line of a transcript. Every line has a `type`; the other fields depend on it.
#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Line {
    r#type: String,
    timestamp: Option<String>,
    ai_title: Option<String>,
    /// Context Claude Code injects on the user's behalf rather than something they typed.
    is_meta: bool,
    message: Option<Message>,
}

#[derive(Deserialize)]
struct Message {
    content: Content,
}

/// Prompts are plain strings; tool results and assistant turns are arrays of blocks.
#[derive(Deserialize)]
#[serde(untagged)]
enum Content {
    Text(String),
    Blocks(IgnoredAny),
}

/// A `sessions/<pid>.json` registry entry.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registered {
    session_id: SessionId,
    status: Option<Status>,
}

struct Transcript {
    title: Option<String>,
    last_active: TimestampMs,
}

impl ClaudeCode {
    pub fn new(config_dir: PathBuf) -> Self { Self { config_dir } }

    /// `$CLAUDE_CONFIG_DIR`, else `~/.claude`.
    pub fn locate() -> Result<Self> {
        let config_dir = match std::env::var_os("CLAUDE_CONFIG_DIR") {
            Some(dir) => PathBuf::from(dir),
            None => std::env::home_dir().ok_or("cannot determine the home directory")?.join(".claude"),
        };
        Ok(Self::new(config_dir))
    }

    /// Sessions launched from `dir`, most recently active first. Claude Code files transcripts by
    /// launch directory and where a session later worked is not consulted, so a session launched
    /// anywhere else is invisible here.
    // TODO(joel): a session launched from a subdirectory of a workspace is filed under that
    // subdirectory and missed.
    pub fn sessions_in(&self, dir: &Path) -> Result<Vec<Session>> {
        let live = self.live()?;
        let mut sessions = Vec::new();
        for entry in read_dir_or_empty(&self.config_dir.join("projects").join(project_folder(dir)?))? {
            let path = entry?.path();
            let Some(id) = path.file_name().and_then(|name| name.to_str()).and_then(|name| name.strip_suffix(".jsonl"))
            else {
                continue;
            };
            if let Some(Transcript { title, last_active }) = read_transcript(&path)? {
                let id = SessionId(id.to_owned());
                let live = live.get(&id).copied();
                sessions.push(Session { id, title, last_active, live });
            }
        }
        sessions.sort_by_key(|session| std::cmp::Reverse(session.last_active));
        Ok(sessions)
    }

    fn live(&self) -> Result<HashMap<SessionId, Status>> {
        let mut live = HashMap::new();
        for entry in read_dir_or_empty(&self.config_dir.join("sessions"))? {
            let path = entry?.path();
            if path.extension() != Some("json".as_ref()) {
                continue;
            }
            let Registered { session_id, status } = serde_json::from_reader(fs::File::open(&path)?)?;
            live.insert(session_id, status.unwrap_or(Status::Unknown));
        }
        Ok(live)
    }
}

/// Claude Code names a project folder after the launch directory with every character that is
/// not ASCII alphanumeric replaced by `-`, so `a_b` and `a-b` share a folder.
fn project_folder(dir: &Path) -> Result<String> {
    let dir = dir.to_str().ok_or_else(|| format!("{} is not UTF-8", dir.display()))?;
    Ok(dir.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect())
}

/// `None` when the session never got past slash commands and has no message to show.
fn read_transcript(path: &Path) -> Result<Option<Transcript>> {
    let mut lines = BufReader::new(fs::File::open(path)?).lines().peekable();
    let mut ai_title = None;
    let mut first_prompt = None;
    let mut last_message = None;
    while let Some(line) = lines.next() {
        let line = line?;
        let parsed: Line = match serde_json::from_str(&line) {
            Ok(parsed) => parsed,
            // A running session appends concurrently, so the final line may be incomplete.
            Err(_) if lines.peek().is_none() => break,
            Err(error) => return Err(format!("{}: {error}", path.display()).into()),
        };
        if parsed.ai_title.is_some() {
            ai_title = parsed.ai_title;
        }
        if matches!(parsed.r#type.as_str(), "user" | "assistant")
            && let Some(timestamp) = &parsed.timestamp
        {
            last_message = Some(TimestampMs::from(humantime::parse_rfc3339(timestamp)?));
        }
        if parsed.r#type == "user"
            && !parsed.is_meta
            && first_prompt.is_none()
            && let Some(Message { content: Content::Text(text) }) = parsed.message
            // Slash commands and other injected context arrive wrapped in tags.
            && !text.starts_with('<')
        {
            first_prompt = text.lines().next().map(str::to_owned);
        }
    }
    Ok(last_message.map(|last_active| Transcript { title: ai_title.or(first_prompt), last_active }))
}

/// Claude Code creates these directories on first use, so their absence means no sessions.
fn read_dir_or_empty(dir: &Path) -> Result<impl Iterator<Item = std::io::Result<fs::DirEntry>>> {
    match fs::read_dir(dir) {
        Ok(entries) => Ok(Some(entries).into_iter().flatten()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None.into_iter().flatten()),
        Err(error) => Err(error.into()),
    }
}
