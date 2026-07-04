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

## cabaret create

USAGE
  cabaret create [--parent value] <change>
  cabaret create --help

Create a change, initializing its log with a parent, a base, and you as its owner. A branch that does not exist yet is created at the parent's tip; an existing branch is adopted with the last revision shared with the parent as its base. The change must not already have a log.

FLAGS
     [--parent]  The new change's parent (defaults to the current branch)
  -h  --help     Print help information and exit

ARGUMENTS
  change  name for the new change

## cabaret diff

USAGE
  cabaret diff [--change value] [--for value] <file>
  cabaret diff --help

Show the diff of a file left to review, given the reviewer's brain: the full base → tip diff when the file is unreviewed, the diff from the previously reviewed tip when that still covers everything left — the file is the same at both bases, or the new base took the reviewed tip's copy — or a 4-way diff of the reviewed and current diffs when the base's copy changed underneath the review.

FLAGS
     [--change]  Change to diff (defaults to current)
     [--for]     Show the diff for another user (defaults to self)
  -h  --help     Print help information and exit

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

### cabaret gh pull

USAGE
  cabaret gh pull
  cabaret gh pull --help

Pull PR activity from GitHub

FLAGS
  -h --help  Print help information and exit

### cabaret gh push

USAGE
  cabaret gh push
  cabaret gh push --help

Push PR activity to GitHub

FLAGS
  -h --help  Print help information and exit

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
  cabaret land
  cabaret land --help

Land a change (if fully reviewed)

FLAGS
  -h --help  Print help information and exit

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

Show a change's owner. A change with no recorded owner prints nothing.

FLAGS
  -h --help  Print help information and exit

ARGUMENTS
  [change]  change to inspect (defaults to current)

### cabaret owner transfer

USAGE
  cabaret owner transfer [--change value] [--even-though-not-owner] <user>
  cabaret owner transfer --help

Transfer ownership of a change. A change has a single owner, so the new owner replaces the current one. Only the owner may transfer ownership, unless --even-though-not-owner is passed.

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

Rebase a change onto its parent's tip, then record the new base in the log. Replays only the commits after the change's base (`git rebase --onto`), so commits the change shares with an old version of the parent are never reapplied. Only the change's owner may rebase it, unless --even-though-not-owner is passed.

FLAGS
     [--even-though-not-owner]  Proceed even though you do not own the change [default = false]
  -h  --help                    Print help information and exit

ARGUMENTS
  [change]  change to rebase (defaults to current)

## cabaret rename

USAGE
  cabaret rename <old> <new>
  cabaret rename --help

Rename a change and its underlying branch atomically

FLAGS
  -h --help  Print help information and exit

ARGUMENTS
  old  change's old name
  new  change's new name

## cabaret reparent

USAGE
  cabaret reparent [--even-though-not-owner] <change> <parent>
  cabaret reparent --help

Update a change's parent. This is a metadata/log change only, and does not touch code without a subsequent `rebase`. Only the change's owner may reparent it, unless --even-though-not-owner is passed.

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

## cabaret todos

USAGE
  cabaret todos [--for value] [--all]
  cabaret todos --help

Show TODOs in a change's diff

FLAGS
     [--for]  Show TODOs for another user (defaults to self)
     [--all]  Show TODOs for all users                       [default = false]
  -h  --help  Print help information and exit
