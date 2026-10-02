use std::process::ExitCode;

use cabaret_lib::gix::tempfile::signal;
use clap::CommandFactory;
use clap_complete::CompleteEnv;

fn main() -> ExitCode {
    // Transaction locks are tempfiles; without this a Ctrl-C would leave them held.
    signal::setup(signal::handler::Mode::default());
    // Die quietly when a reader like `head` closes the pipe, as other Unix tools do, rather than
    // fail every write. Output follows the transactions, so no lock is held by then.
    // SAFETY: nothing else is running yet to race on the signal disposition.
    unsafe { libc::signal(libc::SIGPIPE, libc::SIG_DFL) };
    CompleteEnv::with_factory(cabaret_cli::Cli::command).complete();
    match cabaret_cli::run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("cab: {error:?}");
            ExitCode::FAILURE
        }
    }
}
