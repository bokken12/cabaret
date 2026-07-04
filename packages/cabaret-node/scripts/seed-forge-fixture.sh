#!/usr/bin/env bash
# Bootstrap the fixture repository that github.test.ts's live suite runs
# against: creates <owner>/<repo> with a `base2` branch and PR #1 merged
# carrying 105 comments — enough to span two pages of the comment API.
#
# Usage: seed-forge-fixture.sh <owner>/<repo>
set -euo pipefail

repo=$1
gh repo create "$repo" --private --description "cabaret GitHubForge live-test fixture" --clone=false

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
git init -qb main "$dir"
cd "$dir"
git config user.name "Cabaret Fixture"
git config user.email "fixture@example.com"
echo "cabaret GitHubForge live-test fixture; recreate with seed-forge-fixture.sh" > README.md
git add README.md
git commit -qm "root"
git branch base2
git checkout -qb seeded
echo seeded > seeded.txt
git add seeded.txt
git commit -qm "seeded work"
git remote add origin "$(gh repo view "$repo" --json sshUrl --jq .sshUrl)"
git push -q origin main base2 seeded

gh pr create --title "seeded" --body "" --head seeded --base main
# Paced, with retries: bursts of comment creation trip GitHub's secondary
# rate limit.
for i in $(seq 1 105); do
  until gh api "repos/$repo/issues/1/comments" -f body="seed comment $i" --silent; do sleep 30; done
  sleep 2
done
gh pr merge 1 --merge
