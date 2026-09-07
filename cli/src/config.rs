use cabaret_lib::{Cabaret, Identity, Result};
use clap::Subcommand;

#[derive(Subcommand)]
pub enum IdentityCommand {
    Show,
    Set {
        identity: Identity,
    },
    /// Go back to git's user.email.
    Unset,
}

#[derive(Subcommand)]
pub enum ConfigCommand {
    /// The identity you act as: whose changes are yours and who your review is recorded under.
    Identity {
        #[command(subcommand)]
        command: IdentityCommand,
    },
}

impl ConfigCommand {
    pub fn run(self, cabaret: &Cabaret) -> Result<()> {
        match self {
            ConfigCommand::Identity { command } => match command {
                IdentityCommand::Show => println!("{}", cabaret.identity()?),
                IdentityCommand::Set { identity } => cabaret.set_setting(Some(&identity))?,
                IdentityCommand::Unset => cabaret.set_setting::<Identity>(None)?,
            },
        }
        Ok(())
    }
}
