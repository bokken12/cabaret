# Cabaret CLI Reference

<!-- Generated from the command tree; do not edit by hand. Regenerate with `pnpm test -u`. -->

## cabaret approve

USAGE
  cabaret approve [--allow-empty] [--allow-owner]
  cabaret approve --help

Approve a change

FLAGS
     [--allow-empty]  Allow approving an empty change  [default = false]
     [--allow-owner]  Allow approving a change you own [default = false]
  -h  --help          Print help information and exit

### cabaret approvers add

USAGE
  cabaret approvers add <user>
  cabaret approvers add --help

Add an approver

FLAGS
  -h --help  Print help information and exit

ARGUMENTS
  user  user to add

### cabaret approvers remove

USAGE
  cabaret approvers remove <user>
  cabaret approvers remove --help

Remove an approver

FLAGS
  -h --help  Print help information and exit

ARGUMENTS
  user  user to remove

### cabaret comments add

USAGE
  cabaret comments add [--change value] <text>
  cabaret comments add --help

Add a comment to a change. Appends one `comment` entry to the change's log.

FLAGS
     [--change]  Change to comment on (defaults to current)
  -h  --help     Print help information and exit

ARGUMENTS
  text  the comment text

### cabaret comments show

USAGE
  cabaret comments show [<change>]
  cabaret comments show --help

Show the comments on a change, oldest first: each comment's time and author, then its text.

FLAGS
  -h --help  Print help information and exit

ARGUMENTS
  [change]  change to inspect (defaults to current)

## cabaret create

USAGE
  cabaret create [--parent value] [--owner value] <change>
  cabaret create --help

Create a change, initializing its log with a parent, a base, and an owner. A branch that does not exist yet is created at the parent's tip; an existing branch is adopted with the last revision shared with the parent as its base. The change must not already exist.

FLAGS
     [--parent]  The new change's parent (defaults to the current branch)
     [--owner]   The new change's owner (defaults to you)
  -h  --help     Print help information and exit

ARGUMENTS
  change  name for the new change

## cabaret diff

USAGE
  cabaret diff [--change value] [--for value] [--context value] <file>
  cabaret diff --help

Show the diff of a file left to review, given the reviewer's brain: the full base → tip diff when the file is unreviewed, the diff from the previously reviewed tip when that still covers everything left — the file is the same at both bases, or the new base took the reviewed tip's copy — or a 4-way diff of the reviewed and current diffs when the base's copy changed underneath the review. The diff a land merge brings in was reviewed in the landed change, so it is skipped: what prints is one diff per span of history between land merges.

FLAGS
     [--change]   Change to diff (defaults to current)
     [--for]      Show the diff for another user (defaults to self)
     [--context]  Lines of context around each hunk, -1 for whole files (defaults to 3)
  -h  --help      Print help information and exit

ARGUMENTS
  file  file to diff

## cabaret forget

USAGE
  cabaret forget [--change value] <file>...
  cabaret forget --help

Forget files of a change, so they need review again. Appends one `forget` entry per file to the change's log.

FLAGS
     [--change]  Change to forget in (defaults to current)
  -h  --help     Print help information and exit

ARGUMENTS
  file...  files to forget

### cabaret gh import

USAGE
  cabaret gh import <number>
  cabaret gh import --help

Import a PR as a change to review: fetch its head branch, create the change owned by the PR's author with the PR's base branch as its parent, and pull the PR's comments.

FLAGS
  -h --help  Print help information and exit

ARGUMENTS
  number  PR number to import

### cabaret gh pull

USAGE
  cabaret gh pull [--change value]
  cabaret gh pull --help

Pull PR activity from GitHub: import the PR's comments — new ones, and new versions of ones edited in place — into the change's log, and record a merged PR as landing the change.

FLAGS
     [--change]  Change to pull (defaults to current)
  -h  --help     Print help information and exit

### cabaret gh push

USAGE
  cabaret gh push [--change value]
  cabaret gh push --help

Push PR activity to GitHub: push the change's branch, open its PR if there is none (based on the change's parent), retarget the PR's base to the parent, and post the change's comments the PR lacks.

FLAGS
     [--change]  Change to push (defaults to current)
  -h  --help     Print help information and exit

### cabaret glab pull

USAGE
  cabaret glab pull
  cabaret glab pull --help

Pull MR activity from GitLab

FLAGS
  -h --help  Print help information and exit

### cabaret glab push

USAGE
  cabaret glab push
  cabaret glab push --help

Push MR activity to GitLab

FLAGS
  -h --help  Print help information and exit

## cabaret land

USAGE
  cabaret land [--even-though-not-owner] [<change>]
  cabaret land --help

Land a change: merge it into its parent with a merge commit marked as landing, so the parent's reviewers are not asked to re-review the change's diff, and record the landing in the change's log. The change must sit on its parent's tip; `cabaret rebase` first if it does not. A landed change can no longer be rebased, renamed, reparented, or transferred, though reviewing it is still recorded. A range `ancestor..descendant` lands every change after `ancestor` on `descendant`'s parent chain, `descendant` first, skipping changes that already landed; when one fails, the landings before it stand, and rerunning the range resumes.

FLAGS
     [--even-though-not-owner]  Proceed even though you do not own the change [default = false]
  -h  --help                    Print help information and exit

ARGUMENTS
  [change]  change or ancestor..descendant range to land (defaults to current)

## cabaret log

USAGE
  cabaret log [<change>]
  cabaret log --help

Show a log of actions on a change

FLAGS
  -h --help  Print help information and exit

ARGUMENTS
  [change]  change to inspect (defaults to current)

### cabaret owner show

USAGE
  cabaret owner show [<change>]
  cabaret owner show --help

Show a change's owner

FLAGS
  -h --help  Print help information and exit

ARGUMENTS
  [change]  change to inspect (defaults to current)

### cabaret owner transfer

USAGE
  cabaret owner transfer [--change value] [--even-though-not-owner] <user>
  cabaret owner transfer --help

Transfer ownership of a change, replacing the current owner. Only the owner may transfer ownership.

FLAGS
     [--change]                 Change to transfer (defaults to current)
     [--even-though-not-owner]  Proceed even though you do not own the change [default = false]
  -h  --help                    Print help information and exit

ARGUMENTS
  user  the new owner

## cabaret rebase

USAGE
  cabaret rebase [--even-though-not-owner] [<change>]
  cabaret rebase --help

Rebase a change onto its parent's tip, then record the new base in the log. Replays only the commits after the change's base (`git rebase --onto`), so commits the change shares with an old version of the parent are never reapplied. Only the change's owner may rebase it. A range `ancestor..descendant` rebases every change after `ancestor` on `descendant`'s parent chain, ancestormost first, skipping changes that have landed; when one fails, the rebases before it stand, and rerunning the range resumes.

FLAGS
     [--even-though-not-owner]  Proceed even though you do not own the change [default = false]
  -h  --help                    Print help information and exit

ARGUMENTS
  [change]  change or ancestor..descendant range to rebase (defaults to current)

## cabaret rename

USAGE
  cabaret rename [--even-though-not-owner] <old> <new>
  cabaret rename --help

Rename a change: move its branch and its log to the new name together, atomically. Only the change's owner may rename it.

FLAGS
     [--even-though-not-owner]  Proceed even though you do not own the change [default = false]
  -h  --help                    Print help information and exit

ARGUMENTS
  old  change's old name
  new  change's new name

## cabaret reparent

USAGE
  cabaret reparent [--even-though-not-owner] <change> <parent>
  cabaret reparent --help

Update a change's parent. This is a metadata/log change only, and does not touch code without a subsequent `rebase`. Only the change's owner may reparent it.

FLAGS
     [--even-though-not-owner]  Proceed even though you do not own the change [default = false]
  -h  --help                    Print help information and exit

ARGUMENTS
  change  change to reparent
  parent  the new parent

## cabaret review

USAGE
  cabaret review [--change value] [--tip value] <file>...
  cabaret review --help

Mark files of a change as reviewed. Appends one `review` entry per file recording the base and tip of the reviewed diff, where the base is the last revision shared with the change's parent.

FLAGS
     [--change]  Change to review (defaults to current)
     [--tip]     Mark as reviewed at this tip revision (defaults to the change's tip)
  -h  --help     Print help information and exit

ARGUMENTS
  file...  files to mark as reviewed

## cabaret show

USAGE
  cabaret show [<change>]
  cabaret show --help

Show a change's status

FLAGS
  -h --help  Print help information and exit

ARGUMENTS
  [change]  change to show (defaults to current)

## cabaret sync

USAGE
  cabaret sync
  cabaret sync --help

Sync review state with origin: fetch every change's log, merge it with the local log, and push the result. Only logs move; branches sync through git or `cabaret gh`.

FLAGS
  -h --help  Print help information and exit

## cabaret todo

USAGE
  cabaret todo
  cabaret todo --help

Show the changes awaiting your attention

FLAGS
  -h --help  Print help information and exit

## cabaret todos

USAGE
  cabaret todos [<change>]
  cabaret todos --help

Show the TODOs a change adds: the TODO comments in the tip's copy of each changed file with no matching TODO in the base's copy. Matching ignores position and whitespace, so a pre-existing TODO that merely moves does not appear.

FLAGS
  -h --help  Print help information and exit

ARGUMENTS
  [change]  change to inspect (defaults to current)
