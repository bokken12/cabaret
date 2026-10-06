use cabaret_lib::{Cabaret, ChangeId, Harnesses, Result, SessionId};
use clap::{Subcommand, ValueHint};
use std::path::PathBuf;

#[derive(Subcommand)]
pub enum SessionCommand {
    /// List supported harnesses and current automatic-identification limitations.
    Providers,
    /// Link a session to one change. Unlink its previous explicit association before switching.
    /// The session may have been launched from a parent directory.
    /// Claude automatic identification is not implemented: supply --provider claude --id ID
    /// --directory ORIGINAL_LAUNCH_DIRECTORY. See session providers for capabilities.
    Link {
        #[arg(long)]
        change: Option<ChangeId>,
        #[arg(long, default_value = "codex", value_name = "PROVIDER")]
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
        #[arg(long, default_value = "codex", value_name = "PROVIDER")]
        provider: String,
        /// Defaults to the harness-provided caller ID, as with session link.
        #[arg(long)]
        id: Option<String>,
    },
    /// List inferred and linked sessions for a change.
    List {
        #[arg(long)]
        change: Option<ChangeId>,
    },
}

pub fn print_providers() -> Result<()> {
    for harness in Harnesses::locate()?.iter() {
        let info = harness.info();
        println!("{}: {}", info.provider, info.identification);
    }
    Ok(())
}

impl SessionCommand {
    pub fn run(self, cabaret: &Cabaret) -> Result<()> {
        let harnesses = Harnesses::locate()?;
        let change = |change: Option<ChangeId>| change.map_or_else(|| cabaret.current_change(), Ok);
        match self {
            Self::Providers => print_providers()?,
            Self::Link {
                change: id_change,
                provider: name,
                id,
                directory,
            } => {
                let change = change(id_change)?;
                let harness = harnesses.named(&name)?;
                let info = harness.info();
                let provider = info.provider;
                let id = match id {
                    Some(id) => SessionId(id),
                    None => harness.current_session_id()?.ok_or_else(||
                        format!("cannot identify the calling {provider} session. {}", info.identification))?,
                };
                let session = harness.session(&id, directory.as_deref())?
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
                let harness = harnesses.named(&name)?;
                let id = match id {
                    Some(id) => SessionId(id),
                    None => harness.current_session_id()?.ok_or("provide --id to identify the session to unlink")?,
                };
                cabaret.unlink_session(&change, harness.info().provider, &id)?;
                println!("unlinked session from {change}");
            }
            Self::List { change: id_change } => {
                for session in cabaret.agent_sessions(&change(id_change)?, &harnesses)? {
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
