#!/bin/sh
# Build, package, and install the extension into VS Code.
set -eu
cd "$(dirname "$0")"
pnpm --filter cabaret-vscode build
pnpm dlx @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license -o cabaret-vscode.vsix
code=$(command -v code || echo "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")
"$code" --install-extension cabaret-vscode.vsix
echo "Installed; reload any open VS Code windows to pick it up."
