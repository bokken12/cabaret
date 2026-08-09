use gix::Repository;
use std::path::Path;

use crate::{Error, Result};

pub struct Cabaret {
    pub repo: Repository,
}

impl Cabaret {
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> {
        let repo = gix::discover(dir).map_err(|e| Error::new(e))?;
        Ok(Cabaret { repo })
    }
}
