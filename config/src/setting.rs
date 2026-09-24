use std::{fmt, fmt::Display, fs, str::FromStr};

use cabaret_types::{Error, Result};
use gix::{Repository, bstr::ByteSlice};

/// A value cabaret keeps in git config under `KEY`, stored as its `Display` and read back by
/// its `FromStr`.
pub trait Setting: FromStr<Err = Error> + Display {
    const KEY: &'static str;
}

/// Which git config file a setting is written to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// The repository's own, shared by all its workspaces.
    Local,
    /// The user's, read by every repository.
    Global,
}

impl Display for Scope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Scope::Local => "local",
            Scope::Global => "global",
        })
    }
}

/// `S` as git config reads it in `repo`, from whichever scope sets it.
pub fn get<S: Setting>(repo: &Repository) -> Result<Option<S>> {
    repo.config_snapshot().string(S::KEY).map(|value| value.to_str()?.parse()).transpose()
}

/// Write `value` to `scope`'s config file; `repo` reads it only once reloaded.
pub fn set<S: Setting>(repo: &Repository, scope: Scope, value: &S) -> Result<()> {
    edit(repo, scope, |file| Ok(file.set_raw_value(S::KEY, value.to_string().as_str()).map(drop)?))
}

/// Remove `S` from `scope`'s config file; `repo` reads it only once reloaded.
pub fn unset<S: Setting>(repo: &Repository, scope: Scope) -> Result<()> {
    let key = gix::config::KeyRef::parse_unvalidated(S::KEY.into()).expect("a setting's key is section.name");
    edit(repo, scope, |file| {
        let removed = file
            .section_mut(key.section_name, key.subsection_name)
            .ok()
            .and_then(|mut section| section.remove(key.value_name));
        match removed {
            Some(_) => Ok(()),
            None => Err(format!("{} is not set in {scope} config", S::KEY))?,
        }
    })
}

/// Rewrite `scope`'s config file under the lock git itself takes to edit it.
fn edit(repo: &Repository, scope: Scope, edit: impl FnOnce(&mut gix::config::File) -> Result<()>) -> Result<()> {
    let (path, source) = match scope {
        Scope::Local => (repo.common_dir().join("config"), gix::config::Source::Local),
        Scope::Global => {
            let source = gix::config::Source::User;
            let path =
                source.storage_location(&mut |name| std::env::var_os(name)).ok_or("no home for global config")?;
            (path, source)
        }
    };
    let mut lock = gix::lock::File::acquire_to_update_resource(&path, gix::lock::acquire::Fail::Immediately, None)?;
    let mut file = match fs::exists(&path)? {
        true => gix::config::File::from_path_no_includes(path.clone(), source)?,
        false => gix::config::File::new(gix::config::file::Metadata::from(source)),
    };
    edit(&mut file)?;
    file.write_to(&mut lock)?;
    lock.commit()?;
    Ok(())
}
