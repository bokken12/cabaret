use std::error::Error;
use std::process::ExitCode;

use cabaret_lib::Cabaret;
use clap::{Parser, Subcommand};

#[derive(Subcommand)]
enum Command {
    Config,
    Diff,
    Fetch,
    Land,
    Mark,
    Owners,
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
    let _cabaret = Cabaret::open(std::env::current_dir()?)?;

    match cli.command {
        Command::Config => todo!(),
        Command::Diff => todo!(),
        Command::Fetch => todo!(),
        Command::Land => todo!(),
        Command::Mark => todo!(),
        Command::Owners => todo!(),
        Command::Parents => todo!(),
        Command::Rebase => todo!(),
    }
}
