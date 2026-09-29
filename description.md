Hermetic tests: results no longer depend on who runs them.

Cabaret gains From<gix::ThreadSafeRepository>, so the Rust test fixture opens every repository with gix's Options::isolated(): only the repository's own config, none of git's environment variables (an agent's GIT_COMMITTER_EMAIL) or the user's and system's config (~/.gitconfig). Production opening is unchanged. cab init's one user-dependent outcome, the branch init.defaultBranch names, is no longer asserted. The VS Code tests pin GIT_AUTHOR_*/GIT_COMMITTER_* in their environment, since they run in their own process.

Also drops default_prefix_is_date: the default prefix is no longer the date.