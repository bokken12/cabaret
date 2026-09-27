# Comparison with GitHub

- **Both GitHub and Cabaret offer code review and social features on top of git.** GitHub's pull requests can be thought of as similar to Cabaret's changes. Cabaret seamlessly interoperates with pull requests to allow collaboration with GitHub authors & reviewers.
- **GitHub is a forge, while Cabaret is not.** Cabaret does not offer to host your code for you. However, it will easily integrate with any forge you may choose to use (including GitLab, Codeberg, and others).
- **Cabaret tracks review by file and revision, while GitHub uses a binary.** If a change is updated since you last reviewed it, Cabaret will show you the appropriate diff and require the author wait for your review.
- **GitHub offers broader infra than Cabaret.** GitHub has built-in CI (actions) and project planning (issues). Cabaret may someday gain equivalents or have such things built on top of it or as extensions, but doesn't see them as core offerings.
