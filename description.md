Hermetic tests: results no longer depend on who runs them.

Cabaret::open and Cabaret::init take an Environment. User reads git's environment variables and the user's and system's config, as before; Isolated reads only the repository's own config, via gix's Options::isolated(). The CLI and napi pass User and every Rust test passes Isolated, so an agent's GIT_COMMITTER_EMAIL or a developer's ~/.gitconfig (e.g. init.defaultBranch, cabaret.prefix) no longer leaks into the fixture. The VS Code tests pin GIT_AUTHOR_*/GIT_COMMITTER_* in their environment, since they run in their own process.

Also drops default_prefix_is_date: the default prefix is no longer the date.