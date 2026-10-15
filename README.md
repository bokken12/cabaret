# Cabaret: A Code Review Tool

Cabaret is a diff-based in-editor code review tool built on top of `git`.

Work happens in _changes_: named branches with owners, reviewers, and a log of who has reviewed what. Each change can be checked out in its own _workspace_, so you can hop between them without stashing.

## Installation

Cabaret builds from source. You'll need [Rust](https://rustup.rs) (1.97.1 or newer), [pnpm](https://pnpm.io), and, for the extension, [VS Code](https://code.visualstudio.com) with its `code` command on your `PATH`.

```sh
git clone https://github.com/bokken12/cabaret
cd cabaret

# The `cab` command line tool
cargo install --path crates/cli

# The VS Code extension
pnpm install
pnpm install:vscode
```

## Getting Started

Cabaret uses `git`'s `user.email` as your identity, so make sure it's set:

```sh
git config --global user.email you@example.com
```

Any `git` clone works as Cabaret's main workspace. From inside one, a typical change goes like this:

```sh
cab change create my-feature                # branch off the change you're in
cab workspace add my-feature                # check it out beside this workspace
cd "$(cab workspace path my-feature)"
# ...edit...
cab change commit                           # record your work
cab change describe "Add my feature"
cab change owners add teammate@example.com  # who must sign off
cab fetch                                   # share it through origin
```

Reviewers work through what's left for them, owners endorse, and then it lands:

```sh
cab change diff --change my-feature         # what's left to review
cab change mark --change my-feature <paths> # mark files reviewed
cab change endorse --change my-feature      # owners approve the change as a whole
cab change land --change my-feature         # once every owner has endorsed
```

`cab home` shows your open changes as a stack, and `cab --help` lists everything else.

In VS Code, run **Cabaret: Home** from the command palette for the same view. From there you can open changes, review diffs, and commit, mark, endorse, and land without leaving the editor.
