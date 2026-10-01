use cabaret_lib::{Cabaret, Hints, Identity, Prefix, Result, Scope, Setting};
use clap::Subcommand;

#[derive(Subcommand)]
pub enum ConfigCommand {
    /// Who you act as: git's user.email.
    Identity {
        #[command(subcommand)]
        command: SettingCommand<Identity>,
    },
    /// Put before the id of each change you create; strftime escapes like %Y%m%d expand to the
    /// date it is created. Unset, there is none.
    Prefix {
        #[command(subcommand)]
        command: SettingCommand<Prefix>,
    },
    /// Whether editors show keybinding hints, such as on a change's tabs; true unless set false.
    Hints {
        #[command(subcommand)]
        command: SettingCommand<Hints>,
    },
}

#[derive(Subcommand)]
pub enum SettingCommand<S: Setting + Clone + Send + Sync + 'static> {
    Show,
    Set {
        #[arg(value_parser = parse::<S>)]
        value: S,
        /// Set it for every repository, not just this one.
        #[arg(long)]
        global: bool,
    },
    Unset {
        /// Unset it for every repository, not just this one.
        #[arg(long)]
        global: bool,
    },
}

fn parse<S: Setting>(value: &str) -> std::result::Result<S, String> {
    value.parse().map_err(|error| format!("{error:?}"))
}

fn scope(global: bool) -> Scope {
    match global {
        false => Scope::Local,
        true => Scope::Global,
    }
}

impl ConfigCommand {
    pub fn run(self, cabaret: Cabaret) -> Result<()> {
        match self {
            ConfigCommand::Identity { command } => command.run(cabaret),
            ConfigCommand::Prefix { command } => command.run(cabaret),
            ConfigCommand::Hints { command } => command.run(cabaret),
        }
    }
}

impl<S: Setting + Clone + Send + Sync + 'static> SettingCommand<S> {
    fn run(self, mut cabaret: Cabaret) -> Result<()> {
        match self {
            SettingCommand::Show => match cabaret.config::<S>()? {
                Some(value) => println!("{value}"),
                None => Err(format!("{} is not set", S::KEY))?,
            },
            SettingCommand::Set { value, global } => cabaret.set_config(scope(global), &value)?,
            SettingCommand::Unset { global } => cabaret.unset_config::<S>(scope(global))?,
        }
        Ok(())
    }
}
