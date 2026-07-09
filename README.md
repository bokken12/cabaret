# Cabaret - code review

Cabaret is a code review system built on top of Git. Cabaret is inspired by Jane Street's [Iron](https://github.com/janestreet/iron), Google's [git-appraise](https://github.com/google/git-appraise), and others.

## Ambitions and dreams

- **Diff-Based**: Cabaret does stateful and incremental diff-based review, so that as a feature evolves you can think about only what has changed.
- **In-Editor**: Cabaret encourages you to stay in your IDE and terminal with your code rather than forcing you into an unwieldy sidecar.
- **Distributed**: Cabaret allows you to review code across devices or offline without introducing conflicts.
- **Incremental Adoption**: Cabaret aims to be helpful for a single user with no org-wide support, infrastructure, or permissions.
