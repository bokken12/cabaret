use std::{error::Error, process::ExitCode};

use cabaret_lib::{CONTEXT_KEY, Cabaret, ChangeId, ConfigScope, Context, Identity};
use clap::{Args, Parser, Subcommand};

/// The git-style scope flags every config subcommand takes.
#[derive(Args)]
struct Scope {
    /// Use the person's global config
    #[arg(long, conflicts_with = "local")]
    global: bool,
    /// Use this repository's config
    #[arg(long)]
    local: bool,
}

impl Scope {
    fn flagged(&self) -> Option<ConfigScope> {
        match (self.global, self.local) {
            (true, _) => Some(ConfigScope::Global),
            (_, true) => Some(ConfigScope::Local),
            (false, false) => None,
        }
    }
}

#[derive(Subcommand)]
enum ConfigCommand {
    /// Lines of diff context, -1 for whole files
    Context {
        /// Value to set (shows the current value when omitted)
        #[arg(allow_negative_numbers = true)]
        value: Option<Context>,
        /// Unset the setting, restoring its default
        #[arg(long, conflicts_with = "value")]
        unset: bool,
        #[command(flatten)]
        scope: Scope,
    },
    /// Show every setting
    List {
        #[command(flatten)]
        scope: Scope,
    },
}

#[derive(Subcommand)]
enum OwnersCommand {
    Show,
    Add { owner: Identity },
    Remove { owner: Identity },
}

#[derive(Subcommand)]
enum ParentsCommand {
    Show,
    Add { parent: ChangeId },
    Remove { parent: ChangeId },
}

#[derive(Subcommand)]
enum ChangeCommand {
    Diff,
    Land,
    Mark,
    Owners {
        #[command(subcommand)]
        command: OwnersCommand,
    },
    Parents {
        #[command(subcommand)]
        command: ParentsCommand,
    },
    Rebase,
}

#[derive(Subcommand)]
enum Command {
    Change {
        #[command(subcommand)]
        command: ChangeCommand,
    },
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
    },
    Fetch,
    Workspace,
}

#[derive(Parser)]
#[command(name = "cab", version, about = "Cabaret Code Review")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("cab: {error}");
            ExitCode::FAILURE
        }
    }
}

/// `cabaret.context` as one line: `scope`'s value alone, or all scopes merged.
fn shown_context(cabaret: &Cabaret, scope: Option<ConfigScope>) -> Result<String, Box<dyn Error>> {
    Ok(match (cabaret.config_get(CONTEXT_KEY, scope)?, scope) {
        (Some(value), _) => value,
        // One scope's gap may be filled by another, so alone it is just unset.
        (None, Some(_)) => "(unset)".into(),
        (None, None) => format!("{} (default)", Context::default()),
    })
}

fn run() -> Result<(), Box<dyn Error>> {
    let cli = Cli::parse();
    let cabaret = Cabaret::open(std::env::current_dir()?)?;

    match cli.command {
        Command::Change { command } => match command {
            ChangeCommand::Diff => todo!(),
            ChangeCommand::Land => todo!(),
            ChangeCommand::Mark => todo!(),
            ChangeCommand::Owners { command } => {
                let change = &cabaret.current_change()?;
                match command {
                    OwnersCommand::Show => {
                        let change = cabaret.change(change)?;
                        for owner in &change.owners {
                            println!("{owner}");
                        }
                    }
                    OwnersCommand::Add { owner } => cabaret.add_owner(change, &owner)?,
                    OwnersCommand::Remove { owner } => cabaret.remove_owner(change, &owner)?,
                }
            }
            ChangeCommand::Parents { command } => {
                let change = &cabaret.current_change()?;
                match command {
                    ParentsCommand::Show => {
                        let change = cabaret.change(change)?;
                        for parent in &change.parents {
                            println!("{parent}");
                        }
                    }
                    ParentsCommand::Add { parent } => cabaret.add_parent(change, &parent)?,
                    ParentsCommand::Remove { parent } => cabaret.remove_parent(change, &parent)?,
                }
            }
            ChangeCommand::Rebase => todo!(),
        },
        Command::Config { command } => match command {
            ConfigCommand::Context { value, unset, scope } => {
                // Context describes the person, so writes default to global config.
                let write_scope = scope.flagged().unwrap_or(ConfigScope::Global);
                if unset {
                    if !cabaret.config_unset(CONTEXT_KEY, write_scope)? {
                        return Err(format!("config {CONTEXT_KEY} has no {write_scope} value").into());
                    }
                } else if let Some(value) = value {
                    cabaret.config_set(CONTEXT_KEY, &value.to_string(), write_scope)?;
                } else {
                    println!("{}", shown_context(&cabaret, scope.flagged())?);
                }
            }
            ConfigCommand::List { scope } => {
                println!("context  {}", shown_context(&cabaret, scope.flagged())?);
            }
        },
        Command::Fetch => todo!(),
        Command::Workspace => todo!(),
    }

    Ok(())
}
