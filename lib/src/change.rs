use std::collections::BTreeSet;

use crate::{ChangeId, cabaret::Cabaret, error::Result};

impl Cabaret {
    pub fn parents(&self, change: &ChangeId) -> Result<BTreeSet<ChangeId>> {
        // TODO(joel): walk archived parents, remove dominated
        Ok(self.log(change)?.parents)
    }

    /// `title(change)` is `change`'s title if set, otherwise its ID.
    pub fn title(&self, change: &ChangeId) -> Result<String> {
        Ok(self.log(change)?.title.unwrap_or_else(|| change.to_string()))
    }
}
