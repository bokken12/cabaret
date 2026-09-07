//! Cabaret's local settings, kept in git config under the `cabaret` section so that `git config
//! cabaret.identity` and `cab config identity` read and write the same value.

use std::path::PathBuf;

use cabaret_types::{Identity, Result};
use gix::{
    bstr::ByteSlice,
    config::{File, Source},
    lock::{File as LockFile, acquire::Fail},
};

use crate::{
    context::TransactionContext,
    store::{LOCK_TIMEOUT, Store},
};

/// A setting's type says which values it takes: its text is parsed into the type once, so a
/// value that cannot be represented cannot be set.
pub trait Setting: Sized {
    /// Its name under the `cabaret` section: `cabaret.identity` for `"identity"`.
    const NAME: &'static str;
    fn parse(text: &str) -> Result<Self>;
    fn render(&self) -> String;
}

impl Setting for Identity {
    const NAME: &'static str = "identity";

    fn parse(text: &str) -> Result<Self> { Ok(Identity(text.to_owned())) }

    fn render(&self) -> String { self.0.clone() }
}

fn key<S: Setting>() -> String { format!("cabaret.{}", S::NAME) }

/// The repository's own config file, shared by every workspace of the repository.
fn local_config(repo: &gix::Repository) -> PathBuf { repo.common_dir().join("config") }

impl TransactionContext<'_> {
    /// Every level of git config as it stands now, the repository's own over the user's and the
    /// system's. Read afresh, as `repo` holds only what was loaded when the store was opened.
    fn config(&self) -> Result<File> {
        let mut config = File::from_globals()?;
        config.append(File::from_path_no_includes(local_config(&self.repo), Source::Local)?)?;
        Ok(config)
    }

    pub fn setting<S: Setting>(&self) -> Result<Option<S>> {
        match self.config()?.string(&key::<S>()) {
            Some(text) => Ok(Some(S::parse(text.to_str()?)?)),
            None => Ok(None),
        }
    }

    /// The identity this repository acts as: `cabaret.identity`, else git's `user.email`.
    pub fn identity(&self) -> Result<Identity> {
        if let Some(identity) = self.setting::<Identity>()? {
            return Ok(identity);
        }
        let committer = self.repo.committer().ok_or("no identity; set cabaret.identity or user.email")??;
        Ok(Identity(committer.email.to_string()))
    }
}

impl Store {
    /// Write `value` into the repository's own config, or remove the setting for `None`, under
    /// the same lock file git takes to edit it.
    pub fn set_setting<S: Setting>(&self, value: Option<&S>) -> Result<()> {
        let path = local_config(&self.repo.to_thread_local());
        let mut lock = LockFile::acquire_to_update_resource(&path, Fail::AfterDurationWithBackoff(LOCK_TIMEOUT), None)?;
        let mut config = File::from_path_no_includes(path, Source::Local)?;
        match value {
            Some(value) => {
                config.set_raw_value(&key::<S>(), value.render())?;
            }
            None => {
                if let Ok(mut section) = config.section_mut("cabaret", None) {
                    while section.remove(S::NAME).is_some() {}
                }
            }
        }
        lock.with_mut(|file| config.write_to(file))?;
        lock.commit()?;
        Ok(())
    }
}
