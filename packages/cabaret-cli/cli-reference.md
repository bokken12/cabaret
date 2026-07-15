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

## cabaret comment

USAGE
  cabaret comment [--change value] <text>
  cabaret comment --help

Add a comment to a change. Appends one `comment` entry to the change's log; `show` displays the comments.

FLAGS
     [--change]  Change to comment on (defaults to current)
  -h  --help     Print help information and exit

ARGUMENTS
  text  the comment text

### cabaret config list

USAGE
  cabaret config list [--global] [--local]
  cabaret config list --help

Show every setting

FLAGS
     [--global]  Use the person's global git config [default = false]
     [--local]   Use this repository's git config   [default = false]
  -h  --help     Print help information and exit

#### cabaret config alias add

USAGE
  cabaret config alias add [--global] [--local] <value>
  cabaret config alias add --help

Add a value

FLAGS
     [--global]  Use the person's global git config [default = false]
     [--local]   Use this repository's git config   [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  value  value to add

#### cabaret config alias remove

USAGE
  cabaret config alias remove [--global] [--local] <value>
  cabaret config alias remove --help

Remove a value

FLAGS
     [--global]  Use the person's global git config [default = false]
     [--local]   Use this repository's git config   [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  value  value to remove

#### cabaret config alias clear

USAGE
  cabaret config alias clear [--global] [--local]
  cabaret config alias clear --help

Remove every value

FLAGS
     [--global]  Use the person's global git config [default = false]
     [--local]   Use this repository's git config   [default = false]
  -h  --help     Print help information and exit

### cabaret config context

USAGE
  cabaret config context [--global] [--local] [--unset] [<value>]
  cabaret config context --help

Lines of diff context, -1 for whole files

FLAGS
     [--global]  Use the person's global git config       [default = false]
     [--local]   Use this repository's git config         [default = false]
     [--unset]   Unset the setting, restoring its default [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  [value]  value to set (shows the current value when omitted)

### cabaret config land-method

USAGE
  cabaret config land-method [--global] [--local] [--unset] [<value>]
  cabaret config land-method --help

How a land writes a change onto its parent: merge or squash

FLAGS
     [--global]  Use the person's global git config       [default = false]
     [--local]   Use this repository's git config         [default = false]
     [--unset]   Unset the setting, restoring its default [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  [value]  value to set (shows the current value when omitted)

### cabaret config land-via

USAGE
  cabaret config land-via [--global] [--local] [--unset] [<value>]
  cabaret config land-via --help

Where a land executes: local, forge, or auto

FLAGS
     [--global]  Use the person's global git config       [default = false]
     [--local]   Use this repository's git config         [default = false]
     [--unset]   Unset the setting, restoring its default [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  [value]  value to set (shows the current value when omitted)

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

### cabaret dev wipe

USAGE
  cabaret dev wipe [--remote]
  cabaret dev wipe --help

Delete the review state this repository holds: every change's log and the fetched copies of origin's logs. Branches and commits stay, and origin keeps its logs, so `cabaret sync` restores them. --remote deletes origin's logs too, for every user of the repository.

FLAGS
     [--remote]  Also delete every log on origin (unrecoverable) [default = false]
  -h  --help     Print help information and exit

## cabaret diff

USAGE
  cabaret diff [--change value] [--for value] [--context value] <file>
  cabaret diff --help

Show the diff of a file left to review, given the reviewer's brain: the full base → tip diff when the file is unreviewed, the diff from the previously reviewed tip when that still covers everything left — the file is the same at both bases, or the new base took the reviewed tip's copy — or a 4-way diff of the reviewed and current diffs when the base's copy changed underneath the review. The diff a land merge brings in was reviewed in the landed change, so it is skipped: what prints is one diff per span of history between land merges.

FLAGS
     [--change]   Change to diff (defaults to current)
     [--for]      Show the diff for another user (defaults to self)
     [--context]  Lines of context around each hunk, -1 for whole files (defaults to git config cabaret.context, or 3)
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

## cabaret land

USAGE
  cabaret land [--even-though-not-owner] [--even-though-unreviewed] [<change>]
  cabaret land --help

Land a change: write it onto its parent as a commit marked as landing (a merge, or a squash with git config cabaret.landMethod squash), so the parent's reviewers are not asked to re-review the change's diff, and record the landing in the change's log. A change tracked on a forge lands by merging there and fetching the result; git config cabaret.landVia local (or forge) picks one side unconditionally. The change must sit on its parent's tip; `cabaret rebase` first if it does not. A landed change can no longer be rebased, renamed, reparented, or transferred, though reviewing it is still recorded. A range `ancestor..descendant` lands every change after `ancestor` on `descendant`'s parent chain, `descendant` first, skipping changes that already landed; when one fails, the landings before it stand, and rerunning the range resumes.

FLAGS
     [--even-though-not-owner]   Proceed even though you do not own the change       [default = false]
     [--even-though-unreviewed]  Land even though review obligations are unsatisfied [default = false]
  -h  --help                     Print help information and exit

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

## cabaret pull

USAGE
  cabaret pull [--change value]
  cabaret pull --help

Pull activity from the forge: import every open forge change that is not yet a change — owned by its author, parented on the branch it merges into — import forge comments into change logs, and record merged forge changes as landing their changes. Pulls every unlanded change with a forge change; --change restricts it to one.

FLAGS
     [--change]  Only change to pull
  -h  --help     Print help information and exit

## cabaret push

USAGE
  cabaret push [--change value]
  cabaret push --help

Push activity to the forge: push the change's branch, open its forge change if there is none (merging into the change's parent), retarget it to the parent, and post the change's comments the forge lacks.

FLAGS
     [--change]  Change to push (defaults to current)
  -h  --help     Print help information and exit

## cabaret rebase

USAGE
  cabaret rebase [--even-though-not-owner] [<change>]
  cabaret rebase --help

Move a change onto its parent's tip by merging the tip into the change, then record the new base in the log. Only the change's owner may rebase it. A range `ancestor..descendant` rebases every change after `ancestor` on `descendant`'s parent chain, ancestormost first, skipping changes that have landed; when one fails, the rebases before it stand, and rerunning the range resumes.

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

### cabaret reviewers add

USAGE
  cabaret reviewers add [--change value] <user>
  cabaret reviewers add --help

Add a reviewer to a change. A reviewer owes review of the change's whole diff, as the owner does; `show` displays the reviewers, and `pull`/`push` sync them with the forge.

FLAGS
     [--change]  Change to add the reviewer to (defaults to current)
  -h  --help     Print help information and exit

ARGUMENTS
  user  user to add

### cabaret reviewers remove

USAGE
  cabaret reviewers remove [--change value] <user>
  cabaret reviewers remove --help

Remove a reviewer from a change

FLAGS
     [--change]  Change to remove the reviewer from (defaults to current)
  -h  --help     Print help information and exit

ARGUMENTS
  user  user to remove

## cabaret set-owner

USAGE
  cabaret set-owner [--change value] [--even-though-not-owner] <user>
  cabaret set-owner --help

Set a change's owner, replacing the current one. Only the owner may transfer ownership; `show` displays the owner.

FLAGS
     [--change]                 Change to transfer (defaults to current)
     [--even-though-not-owner]  Proceed even though you do not own the change [default = false]
  -h  --help                    Print help information and exit

ARGUMENTS
  user  the new owner

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

Sync review state with origin: fetch every change's log, merge it with the local log, and push the result. Only logs move; branches sync through git or `cabaret pull`/`cabaret push`.

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
