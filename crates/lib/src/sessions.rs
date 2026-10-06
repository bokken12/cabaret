use crate::{
    Cabaret, ChangeId, ChangeIdRef, ClaudeCode, Codex, Provider, Result, Session, SessionId, validate_session_id,
};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

/// Device-local association, shared by all worktrees but never committed or pushed to a remote.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct SessionLink {
    pub change: ChangeId,
    pub provider: Provider,
    pub id: SessionId,
    pub directory: PathBuf,
}

impl Cabaret {
    fn session_links_path(&self) -> PathBuf {
        self.common_dir().join("cabaret/session-links.json")
    }

    pub fn session_links(&self, change: &ChangeIdRef) -> Result<Vec<SessionLink>> {
        self.snapshot(change)?;
        Ok(self
            .read_session_links()?
            .into_iter()
            .filter(|link| *link.change == *change)
            .collect())
    }

    fn read_session_links(&self) -> Result<Vec<SessionLink>> {
        match fs::read(self.session_links_path()) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(error.into()),
        }
    }

    /// Attach only a known provider-qualified session, preserving its real launch directory.
    pub fn link_session(&self, change: &ChangeIdRef, session: &Session) -> Result<()> {
        validate_session_id(&session.id)?;
        self.snapshot(change)?;
        if !session.directory.is_absolute() {
            return Err("session launch directory must be absolute".into());
        }
        let link = SessionLink {
            change: change.to_owned(),
            provider: session.provider,
            id: session.id.clone(),
            directory: session.directory.clone(),
        };
        self.edit_session_links(|links| {
            links.retain(|old| !(old.change == link.change && old.provider == link.provider && old.id == link.id));
            links.push(link);
        })
    }

    pub fn unlink_session(&self, change: &ChangeIdRef, provider: Provider, id: &SessionId) -> Result<()> {
        validate_session_id(id)?;
        self.snapshot(change)?;
        self.edit_session_links(|links| {
            links.retain(|link| !(*link.change == *change && link.provider == provider && link.id == *id))
        })
    }

    fn edit_session_links(&self, edit: impl FnOnce(&mut Vec<SessionLink>)) -> Result<()> {
        let path = self.session_links_path();
        fs::create_dir_all(path.parent().expect("session links have a parent"))?;
        let mut lock = gix::lock::File::acquire_to_update_resource(&path, gix::lock::acquire::Fail::Immediately, None)?;
        let mut links = self.read_session_links()?;
        edit(&mut links);
        serde_json::to_writer_pretty(&mut lock, &links)?;
        lock.commit()?;
        Ok(())
    }

    /// Infer sessions launched in the worktree, then add explicit links made from anywhere.
    /// Unavailable linked history remains visible, without inventing a last-active timestamp.
    pub fn agent_sessions(&self, change: &ChangeIdRef, claude: &ClaudeCode, codex: &Codex) -> Result<Vec<Session>> {
        let mut sessions = self.sessions(change, claude)?;
        // There is no launch-directory inference when the change is checked out nowhere.
        if let Some(workspace) = self.workspace_holding(change)? {
            sessions.extend(codex.sessions_in(&self.workspace_path(workspace.to_ref())?)?);
        }
        for link in self.session_links(change)? {
            if sessions
                .iter()
                .any(|session| session.provider == link.provider && session.id == link.id)
            {
                continue;
            }
            let found = match link.provider {
                Provider::Claude => claude.session_in(&link.directory, &link.id)?,
                Provider::Codex => codex.session(&link.id)?,
            };
            sessions.push(found.unwrap_or(Session {
                id: link.id,
                provider: link.provider,
                directory: link.directory,
                title: None,
                last_active: None,
                live: None,
            }));
        }
        sessions.sort_by_key(|session| std::cmp::Reverse(session.last_active));
        Ok(sessions)
    }
}
