use clap::{Parser, Subcommand};

#[derive(Subcommand)]
enum Command {
    Diff,
    Mark,
    Owners,
    Parents,
}

#[derive(Parser)]
#[command(name = "cab", version, about = "Cabaret Code Review")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

fn main() {
    let cli = Cli::parse();

    match cli.command {
        Command::Diff => todo!(),
        Command::Mark => todo!(),
        Command::Owners => todo!(),
        Command::Parents => todo!(),
    }
}