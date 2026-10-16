---
title: Your first review
---

## Install Cabaret

To install Cabaret, open a terminal and run:

```sh
cargo install --git https://github.com/bokken12/cabaret cabaret-cli --locked
```

> Upon installing, the installed command is `cab`.

## Make a test repo

Create a disposable local Git repo with one JavaScript file. Run these commands in a directory where you keep projects. Use a fresh folder name if `cabaret-playground` already exists.

```sh
mkdir cabaret-playground
cd cabaret-playground
git init -b main
printf 'export const greet = (name) => "Hello, " + name;\n' > greeting.js
git add greeting.js
git commit -m "Initialize test repo"
```

> Cabaret works with the existing Git repo; no remote or account is needed for this exercise.

## Create a change

Create a child of `main`, then switch this workspace to it. Cabaret keeps the relationship between the two changes.

```sh
cab change create a-warmer-welcome
cab workspace switch a-warmer-welcome
printf 'export const greet = (name) => "Hello, " + (name.trim() || "world") + "!";\n' > greeting.js
cab change commit greeting.js
cab home
```

> Your change now handles blank names and adds a little enthusiasm. `cab home` shows the stack of open changes.

## Review the diff

Read the diff for your greeting. Once you’re happy with it, mark the file reviewed and check what’s left.

```sh
cab change diff greeting.js
cab change mark greeting.js
cab change diff
```

> The last command should show no files left to review. Want to see the entire change again? Run `cab change diff --full greeting.js`.
