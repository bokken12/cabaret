use std::{
    fmt,
    path::{Path, PathBuf},
    str::FromStr,
};

use gix::config::{AsKey, Source, source::Kind};

use crate::{
    cabaret::Cabaret,
    error::{Error, Result},
};

pub const CONTEXT_KEY: &str = "cabaret.context";

/// Lines of context around diff hunks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Context {
    Lines(u32),
    WholeFiles,
}

impl Context {
    /// Parse a count of diff context lines from `source`: a nonnegative integer, or -1 for whole files.
    pub fn parse(raw: &str, source: &str) -> Result<Self> {
        let error = || Error::new(format!("{source} must be a nonnegative integer or -1: {raw:?}"));
        let lines: i64 = raw.parse().map_err(|_| error())?;
        if lines == -1 {
            return Ok(Self::WholeFiles);
        }
        u32::try_from(lines).map(Self::Lines).map_err(|_| error())
    }
}

impl Default for Context {
    /// As git.
    fn default() -> Self { Self::Lines(3) }
}

impl FromStr for Context {
    type Err = Error;

    fn from_str(raw: &str) -> Result<Self> { Self::parse(raw, "context") }
}

impl fmt::Display for Context {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Lines(lines) => write!(f, "{lines}"),
            Self::WholeFiles => f.write_str("-1"),
        }
    }
}

/// Which config a setting lives in: the person's, or this repository's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigScope {
    Global,
    Local,
}

impl ConfigScope {
    const fn kind(self) -> Kind {
        match self {
            Self::Global => Kind::Global,
            Self::Local => Kind::Repository,
        }
    }
}

impl fmt::Display for ConfigScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Global => "global",
            Self::Local => "local",
        })
    }
}

fn read_file(path: PathBuf, source: Source) -> Result<gix::config::File> {
    if path.exists() {
        gix::config::File::from_path_no_includes(path, source).map_err(Error::new)
    } else {
        Ok(gix::config::File::new(gix::config::file::Metadata::from(source)))
    }
}

/// Write `file` to `path` as git: through a `.lock` sibling that excludes
/// concurrent writers and renames into place whole.
fn write_file(path: &Path, file: &gix::config::File) -> Result<()> {
    let mut name =
        path.file_name().ok_or_else(|| Error::new(format!("no config file at {}", path.display())))?.to_owned();
    name.push(".lock");
    let lock = path.with_file_name(name);
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock)
        .map_err(|error| Error::new(format!("cannot lock {}: {error}", path.display())))?;
    file.write_to(&mut out).map_err(Error::new)?;
    std::fs::rename(&lock, path).map_err(Error::new)?;
    Ok(())
}

impl Cabaret {
    /// The lines of diff context to show, from `cabaret.context`.
    pub fn context(&self) -> Result<Context> {
        match self.config_get(CONTEXT_KEY, None)? {
            Some(raw) => Context::parse(&raw, &format!("config {CONTEXT_KEY}")),
            None => Ok(Context::default()),
        }
    }

    /// The value of `key`: `scope`'s alone, or all scopes merged as git.
    pub fn config_get(&self, key: &str, scope: Option<ConfigScope>) -> Result<Option<String>> {
        let snapshot = self.repo.config_snapshot();
        let config = snapshot.plumbing();
        let value = match scope {
            None => config.string(key),
            Some(scope) => config.string_filter(key, |meta| meta.source.kind() == scope.kind()),
        };
        Ok(value.map(|value| value.to_string()))
    }

    /// Set `key` to `value` in `scope`'s config file.
    pub fn config_set(&self, key: &str, value: &str, scope: ConfigScope) -> Result<()> {
        let (path, source) = self.config_file(scope)?;
        let mut file = read_file(path.clone(), source)?;
        file.set_raw_value(key, value).map_err(Error::new)?;
        write_file(&path, &file)
    }

    /// Remove `key` from `scope`'s config file: `false` when it holds no value.
    pub fn config_unset(&self, key: &str, scope: ConfigScope) -> Result<bool> {
        let key = key.try_as_key().ok_or_else(|| Error::new(format!("invalid config key {key:?}")))?;
        let (path, source) = self.config_file(scope)?;
        let mut file = read_file(path.clone(), source)?;
        let Ok(mut section) = file.section_mut(key.section_name, key.subsection_name) else {
            return Ok(false);
        };
        let mut removed = false;
        while section.remove(key.value_name).is_some() {
            removed = true;
        }
        if !removed {
            return Ok(false);
        }
        write_file(&path, &file)?;
        Ok(true)
    }

    fn config_file(&self, scope: ConfigScope) -> Result<(PathBuf, Source)> {
        match scope {
            ConfigScope::Local => Ok((self.repo.common_dir().join("config"), Source::Local)),
            ConfigScope::Global => {
                let env = &mut |name: &str| std::env::var_os(name);
                let user = Source::User.storage_location(env);
                match user {
                    Some(user) if user.exists() => Ok((user, Source::User)),
                    // As git: the XDG file only when it alone exists.
                    _ => Source::Git
                        .storage_location(env)
                        .filter(|xdg| xdg.exists())
                        .map(|xdg| (xdg, Source::Git))
                        .or(user.map(|user| (user, Source::User)))
                        .ok_or_else(|| Error::new("no global git config location")),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_round_trips() {
        for context in [Context::Lines(0), Context::Lines(3), Context::Lines(u32::MAX), Context::WholeFiles] {
            assert_eq!(context.to_string().parse::<Context>().unwrap(), context);
        }
        for raw in ["-1", "0", "3", "9000"] {
            assert_eq!(raw.parse::<Context>().unwrap().to_string(), raw);
        }
    }

    #[test]
    fn context_rejects_bad_values() {
        for raw in ["", "x", "-2", "1.5", " 3", "4294967296"] {
            assert_eq!(
                raw.parse::<Context>().unwrap_err().to_string(),
                format!("context must be a nonnegative integer or -1: {raw:?}")
            );
        }
    }

    /// Opens skip the developer's own git config, keeping reads hermetic.
    fn open(dir: &Path) -> Cabaret { Cabaret { repo: gix::open_opts(dir, gix::open::Options::isolated()).unwrap() } }

    #[test]
    fn context_setting_round_trips_through_local_config() {
        let dir = tempfile::tempdir().unwrap();
        gix::init(dir.path()).unwrap();

        let cabaret = open(dir.path());
        assert_eq!(cabaret.context().unwrap(), Context::default());
        assert_eq!(cabaret.config_get(CONTEXT_KEY, None).unwrap(), None);

        cabaret.config_set(CONTEXT_KEY, "8", ConfigScope::Local).unwrap();
        let cabaret = open(dir.path());
        assert_eq!(cabaret.context().unwrap(), Context::Lines(8));
        assert_eq!(cabaret.config_get(CONTEXT_KEY, None).unwrap(), Some("8".into()));
        assert_eq!(cabaret.config_get(CONTEXT_KEY, Some(ConfigScope::Local)).unwrap(), Some("8".into()));
        assert_eq!(cabaret.config_get(CONTEXT_KEY, Some(ConfigScope::Global)).unwrap(), None);

        assert!(cabaret.config_unset(CONTEXT_KEY, ConfigScope::Local).unwrap());
        assert!(!cabaret.config_unset(CONTEXT_KEY, ConfigScope::Local).unwrap());
        let cabaret = open(dir.path());
        assert_eq!(cabaret.context().unwrap(), Context::default());
    }

    #[test]
    fn config_set_preserves_unrelated_content() {
        let dir = tempfile::tempdir().unwrap();
        gix::init(dir.path()).unwrap();
        let config = dir.path().join(".git/config");
        let before = std::fs::read_to_string(&config).unwrap();

        open(dir.path()).config_set(CONTEXT_KEY, "5", ConfigScope::Local).unwrap();
        assert_eq!(std::fs::read_to_string(&config).unwrap(), format!("{before}[cabaret]\n\tcontext = 5\n"));
    }

    #[test]
    fn bad_stored_context_reads_as_an_error() {
        let dir = tempfile::tempdir().unwrap();
        gix::init(dir.path()).unwrap();

        open(dir.path()).config_set(CONTEXT_KEY, "x", ConfigScope::Local).unwrap();
        assert_eq!(
            open(dir.path()).context().unwrap_err().to_string(),
            "config cabaret.context must be a nonnegative integer or -1: \"x\""
        );
    }
}
