use cabaret_lib::{Cabaret, ChangeId, ClaudeCode, Codex, Provider, Result, SessionId};
use clap::{Subcommand, ValueHint};
use std::path::PathBuf;

#[derive(Subcommand)]
pub enum SessionCommand {
    /// Link a session to one change. Unlink its previous explicit association before switching.
    /// The session may have been launched from a parent directory.
    Link {
        #[arg(long)]
        change: Option<ChangeId>,
        #[arg(long, default_value = "codex", value_parser = ["codex", "claude"])]
        provider: String,
        /// Defaults to CODEX_THREAD_ID for Codex. Required for Claude Code.
        #[arg(long)]
        id: Option<String>,
        /// Original launch directory; required for Claude Code, discovered for Codex.
        #[arg(long, value_hint = ValueHint::DirPath)]
        directory: Option<PathBuf>,
    },
    /// Release an explicit link after landing or before switching tasks.
    /// Keep the link through commits and review; landing does not unlink automatically.
    /// This leaves the session, its history, and automatic discovery intact.
    Unlink {
        #[arg(long)]
        change: Option<ChangeId>,
        #[arg(long, default_value = "codex", value_parser = ["codex", "claude"])]
        provider: String,
        /// Defaults to CODEX_THREAD_ID for Codex. Required for Claude Code.
        #[arg(long)]
        id: Option<String>,
    },
    /// List inferred and linked sessions for a change.
    List {
        #[arg(long)]
        change: Option<ChangeId>,
    },
}

fn provider(name: &str) -> Provider {
    match name {
        "codex" => Provider::Codex,
        "claude" => Provider::Claude,
        _ => unreachable!("clap validates provider names"),
    }
}

impl SessionCommand {
    pub fn run(self, cabaret: &Cabaret) -> Result<()> {
        let change = |change: Option<ChangeId>| change.map_or_else(|| cabaret.current_change(), Ok);
        match self {
            Self::Link {
                change: id_change,
                provider: name,
                id,
                directory,
            } => {
                let change = change(id_change)?;
                let provider = provider(&name);
                let id = SessionId(
                    id.or_else(|| {
                        (provider == Provider::Codex)
                            .then(|| std::env::var("CODEX_THREAD_ID").ok())
                            .flatten()
                    })
                    .ok_or("provide --id (or CODEX_THREAD_ID for Codex)")?,
                );
                let session = match provider {
                    Provider::Codex => Codex::locate()?.session(&id)?,
                    Provider::Claude => ClaudeCode::locate()?
                        .session_in(&directory.ok_or("provide --directory for Claude Code")?, &id)?,
                }
                .ok_or("session not found in local history; check provider, ID and launch directory")?;
                cabaret.link_session(&change, &session)?;
                println!("linked {provider} {id} to {change}");
            }
            Self::Unlink {
                change: id_change,
                provider: name,
                id,
            } => {
                let change = change(id_change)?;
                let provider = provider(&name);
                let id = id.or_else(|| (provider == Provider::Codex)
                    .then(|| std::env::var("CODEX_THREAD_ID").ok()).flatten())
                    .ok_or("provide --id (or CODEX_THREAD_ID for Codex)")?;
                cabaret.unlink_session(&change, provider, &SessionId(id))?;
                println!("unlinked session from {change}");
            }
            Self::List { change: id_change } => {
                for session in cabaret.agent_sessions(&change(id_change)?, &ClaudeCode::locate()?, &Codex::locate()?)? {
                    let activity = session.last_active.map_or("unknown".to_owned(), |at| at.0.to_string());
                    let status = session.live.map_or("unknown".to_owned(), |live| format!("{live:?}"));
                    println!(
                        "{}\t{}\tlast_activity_ms={activity}\tlive={status}",
                        session.provider, session.id
                    );
                }
            }
        }
        Ok(())
    }
}
