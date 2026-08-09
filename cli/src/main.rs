use std::error::Error;
use std::process::ExitCode;

use cabaret_lib::Cabaret;
use clap::{Parser, Subcommand};

#[derive(Subcommand)]
enum OwnersCommand {
    Show,
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
    Parents,
    Rebase,
}

#[derive(Subcommand)]
enum Command {
    Change {
        #[command(subcommand)]
        command: ChangeCommand,
    },
    Config,
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

fn run() -> Result<(), Box<dyn Error>> {
    let cli = Cli::parse();
    let cabaret = Cabaret::open(std::env::current_dir()?)?;

    match cli.command {
        Command::Change { command } => match command {
            ChangeCommand::Diff => todo!(),
            ChangeCommand::Land => todo!(),
            ChangeCommand::Mark => todo!(),
            ChangeCommand::Owners { command } => match command {
                OwnersCommand::Show => todo!(),
            },
            ChangeCommand::Parents => {
                let change = cabaret.change(&cabaret.current_change()?)?;
                for parent in &change.parents {
                    println!("{parent}");
                }
            }
            ChangeCommand::Rebase => todo!(),
        },
        Command::Config => todo!(),
        Command::Fetch => todo!(),
        Command::Workspace => todo!(),
    }

    Ok(())
}
