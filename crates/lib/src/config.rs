use cabaret_config::{Scope, Setting};
use cabaret_types::Result;

use crate::cabaret::Cabaret;

impl Cabaret {
    // Config operations

    /// `S` as git config reads it here, from whichever scope sets it.
    pub fn config<S: Setting>(&self) -> Result<Option<S>> { cabaret_config::get(&self.store.repo.to_thread_local()) }

    pub fn set_config<S: Setting>(&mut self, scope: Scope, value: &S) -> Result<()> {
        cabaret_config::set(&self.store.repo.to_thread_local(), scope, value)?;
        self.reload()
    }

    pub fn unset_config<S: Setting>(&mut self, scope: Scope) -> Result<()> {
        cabaret_config::unset::<S>(&self.store.repo.to_thread_local(), scope)?;
        self.reload()
    }

    /// Reread the repository, so config written since it was opened is seen.
    fn reload(&mut self) -> Result<()> {
        let mut repo = self.store.repo.to_thread_local();
        repo.reload()?;
        self.store.repo = repo.into_sync();
        Ok(())
    }
}
