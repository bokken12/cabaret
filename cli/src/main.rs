use std::process::ExitCode;

use clap::CommandFactory;
use clap_complete::CompleteEnv;
fn main() -> ExitCode {
    CompleteEnv::with_factory(cabaret_cli::Cli::command).complete();
    match cabaret_cli::run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("cab: {error:?}");
            ExitCode::FAILURE
        }
    }
}
