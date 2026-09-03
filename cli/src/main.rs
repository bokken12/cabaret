use std::process::ExitCode;

use cabaret_lib::gix::tempfile::signal;
use clap::CommandFactory;
use clap_complete::CompleteEnv;

fn main() -> ExitCode {
    // Transaction locks are tempfiles; without this a Ctrl-C would leave them held.
    signal::setup(signal::handler::Mode::default());
    CompleteEnv::with_factory(cabaret_cli::Cli::command).complete();
    match cabaret_cli::run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("cab: {error:?}");
            ExitCode::FAILURE
        }
    }
}
