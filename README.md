# Cabaret - code review

Cabaret is a code review system built on top of Git. Caberet is inspired by Jane Street's [Iron](https://github.com/janestreet/iron), Google's [git-appraise](https://github.com/google/git-appraise), and others.

## Goals

- **Diff-Based**: Cabaret does stateful diff-based review, so that as a feature evolves you can think about only what has changed.
- **In-Editor**: Cabaret encourages you to stay in your IDE and terminal with your code rather than forcing you into an unwieldy sidecar.
- **Distributed**: Cabaret allows you to review code across multiple devices or offline without introducing conflicts.
- **Incremental Adoption**: Cabaret aims to be helpful for a single user with no org-wide support, infrastructure, or permissions.

## Supported forges

Cabaret selects the forge from the repository's `origin` URL:

- `github.com` uses `GH_TOKEN` or `GITHUB_TOKEN`, falling back to `gh auth token`.
- `gitlab.com` uses `GITLAB_TOKEN` (also accepting `GITLAB_ACCESS_TOKEN`).
- `codeberg.org` uses `CODEBERG_TOKEN`.

HTTPS, scp-like SSH, and `ssh://git@…` origin URLs are supported. Self-hosted GitLab and Forgejo instances are not yet supported.
