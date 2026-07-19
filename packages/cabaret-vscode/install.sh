#!/bin/sh
# Build, package, and install the extension into VS Code.
set -eu
cd "$(dirname "$0")"
pnpm --filter cabaret-vscode build
# vsce can't resolve README-relative links (keybindings-reference.md) without
# a base URL; package.json's repository field won't do, since it points at the
# monorepo root rather than this package.
base=https://github.com/bokken12/cabaret/blob/main/packages/cabaret-vscode/
pnpm dlx @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license \
  --baseContentUrl "$base" --baseImagesUrl "$base" -o cabaret-vscode.vsix
# The version never changes, so --force keeps a same-version reinstall from
# being skipped as already installed.
code=$(command -v code || echo "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")
"$code" --install-extension cabaret-vscode.vsix --force
echo "Installed; reload any open VS Code windows to pick it up."
