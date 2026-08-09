use std::error::Error;
use std::process::ExitCode;

use cabaret_lib::Cabaret;
use clap::{Parser, Subcommand};

#[derive(Subcommand)]
enum OwnersCommand {
    Show,
}

#[derive(Subcommand)]
enum Command {
    Config,
    Diff,
    Fetch,
    Land,
    Mark,
    Owners {
        #[command(subcommand)]
        command: OwnersCommand,
    },
    Parents,
    Rebase,
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
        Command::Config => todo!(),
        Command::Diff => todo!(),
        Command::Fetch => todo!(),
        Command::Land => todo!(),
        Command::Mark => todo!(),
        Command::Owners { command } => match command {
            OwnersCommand::Show => todo!(),
        },
        Command::Parents => {
            let change = cabaret.change(&cabaret.current_change()?)?;
            for parent in &change.parents {
                println!("{parent}");
            }
        }
        Command::Rebase => todo!(),
    }

    Ok(())
}
