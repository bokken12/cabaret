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
  cabaret create [--parent value] [--child value] [<change>]
  cabaret create --help

Create a change based on the current change

FLAGS
     [--parent]  Set the new change's parent (exclusive with --child)
     [--child]   Set the new change's child (exclusive with --parent)
  -h  --help     Print help information and exit

ARGUMENTS
  [change]  name for the new change

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

### cabaret owners add

USAGE
  cabaret owners add <user>
  cabaret owners add --help

Add an owner

FLAGS
  -h --help  Print help information and exit

ARGUMENTS
  user  user to add

### cabaret owners remove

USAGE
  cabaret owners remove <user>
  cabaret owners remove --help

Remove an owner

FLAGS
  -h --help  Print help information and exit

ARGUMENTS
  user  user to remove

## cabaret rebase

USAGE
  cabaret rebase [--allow-invalid-base] <change>
  cabaret rebase --help

Rebase a change onto its parent. Uses `git rebase --onto` internally to avoid conflicts, which requires the base recorded in metadata to be valid.

FLAGS
     [--allow-invalid-base]  Skip --onto, for when history was changed outside Cabaret [default = false]
  -h  --help                 Print help information and exit

ARGUMENTS
  change  change to rebase

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
  cabaret reparent <change> <parent>
  cabaret reparent --help

Update a change's parent. This is a metadata/log change only, and does not touch code without a subsequent `rebase`.

FLAGS
  -h --help  Print help information and exit

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
