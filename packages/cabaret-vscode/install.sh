#!/bin/sh
# Build, package, and install the extension into VS Code.
set -eu
cd "$(dirname "$0")"
pnpm --filter cabaret-vscode build
# VS Code trusts version numbers over content, so reinstalling an unchanged
# version can keep serving the old code. Stamp each build with a fresh version
# so every install is an upgrade; package.json itself stays untouched.
version="0.0.$(date +%s)"
pnpm dlx @vscode/vsce package "$version" --no-update-package-json --no-git-tag-version --no-dependencies --allow-missing-repository --skip-license -o cabaret-vscode.vsix
code=$(command -v code || echo "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")
"$code" --install-extension cabaret-vscode.vsix --force
echo "Installed; reload any open VS Code windows to pick it up."
