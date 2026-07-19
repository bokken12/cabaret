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

## cabaret archive

USAGE
  cabaret archive [--change value]
  cabaret archive --help

Set a change aside without landing it: the change leaves the home page and refuses to land, but its branch and log stay. A push closes its forge change. `cabaret unarchive` brings it back.

FLAGS
     [--change]  Change to archive (defaults to current)
  -h  --help     Print help information and exit

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
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

#### cabaret config alias show

USAGE
  cabaret config alias show [--global] [--local]
  cabaret config alias show --help

Show the values

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

#### cabaret config alias add

USAGE
  cabaret config alias add [--global] [--local] <value>
  cabaret config alias add --help

Add a value

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  value  value to add

#### cabaret config alias remove

USAGE
  cabaret config alias remove [--global] [--local] <value>
  cabaret config alias remove --help

Remove a value

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  value  value to remove

#### cabaret config alias clear

USAGE
  cabaret config alias clear [--global] [--local]
  cabaret config alias clear --help

Remove every value

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

##### cabaret config alias github show

USAGE
  cabaret config alias github show [--global] [--local]
  cabaret config alias github show --help

Show the accounts

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

##### cabaret config alias github add

USAGE
  cabaret config alias github add [--global] [--local] <account>
  cabaret config alias github add --help

Add an account

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  account  account name, without the scheme

##### cabaret config alias github remove

USAGE
  cabaret config alias github remove [--global] [--local] <account>
  cabaret config alias github remove --help

Remove an account

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  account  account name, without the scheme

##### cabaret config alias github clear

USAGE
  cabaret config alias github clear [--global] [--local]
  cabaret config alias github clear --help

Remove every github account

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

##### cabaret config alias gitlab show

USAGE
  cabaret config alias gitlab show [--global] [--local]
  cabaret config alias gitlab show --help

Show the accounts

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

##### cabaret config alias gitlab add

USAGE
  cabaret config alias gitlab add [--global] [--local] <account>
  cabaret config alias gitlab add --help

Add an account

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  account  account name, without the scheme

##### cabaret config alias gitlab remove

USAGE
  cabaret config alias gitlab remove [--global] [--local] <account>
  cabaret config alias gitlab remove --help

Remove an account

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  account  account name, without the scheme

##### cabaret config alias gitlab clear

USAGE
  cabaret config alias gitlab clear [--global] [--local]
  cabaret config alias gitlab clear --help

Remove every gitlab account

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

##### cabaret config alias codeberg show

USAGE
  cabaret config alias codeberg show [--global] [--local]
  cabaret config alias codeberg show --help

Show the accounts

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

##### cabaret config alias codeberg add

USAGE
  cabaret config alias codeberg add [--global] [--local] <account>
  cabaret config alias codeberg add --help

Add an account

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  account  account name, without the scheme

##### cabaret config alias codeberg remove

USAGE
  cabaret config alias codeberg remove [--global] [--local] <account>
  cabaret config alias codeberg remove --help

Remove an account

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  account  account name, without the scheme

##### cabaret config alias codeberg clear

USAGE
  cabaret config alias codeberg clear [--global] [--local]
  cabaret config alias codeberg clear --help

Remove every codeberg account

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

### cabaret config context

USAGE
  cabaret config context [--global] [--local] [--unset] [<value>]
  cabaret config context --help

Lines of diff context, -1 for whole files

FLAGS
     [--global]  Use the person's global config           [default = false]
     [--local]   Use this repository's config             [default = false]
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
     [--global]  Use the person's global config           [default = false]
     [--local]   Use this repository's config             [default = false]
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
     [--global]  Use the person's global config           [default = false]
     [--local]   Use this repository's config             [default = false]
     [--unset]   Unset the setting, restoring its default [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  [value]  value to set (shows the current value when omitted)

### cabaret config workspace-style

USAGE
  cabaret config workspace-style [--global] [--local] [--unset] [<value>]
  cabaret config workspace-style --help

Where going to a change with no workspace checks it out: shared or dedicated

FLAGS
     [--global]  Use the person's global config           [default = false]
     [--local]   Use this repository's config             [default = false]
     [--unset]   Unset the setting, restoring its default [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  [value]  value to set (shows the current value when omitted)

## cabaret conflicts

USAGE
  cabaret conflicts [<change>]
  cabaret conflicts --help

Show each conflict marker left in a change's files, as file:line: text. A rebase that conflicts commits the markers in place; this lists what remains to fix.

FLAGS
  -h --help  Print help information and exit

ARGUMENTS
  [change]  change to inspect (defaults to current)

## cabaret create

USAGE
  cabaret create [--parent value] [--owner value] <change>
  cabaret create --help

Create a change, initializing its log with a parent, a base, and an owner. A change with no code yet starts at the parent's tip; an existing branch is adopted with the last revision shared with the parent as its base. The change must not already exist.

FLAGS
     [--parent]  The new change's parent (defaults to what is checked out)
     [--owner]   The new change's owner (defaults to you)
  -h  --help     Print help information and exit

ARGUMENTS
  change  name for the new change

### cabaret dev wipe

USAGE
  cabaret dev wipe [--remote]
  cabaret dev wipe --help

Delete the review state this repository holds: every change's log and the fetched copies of origin's logs. Branches and commits stay, and origin keeps its logs, so `cabaret fetch` restores them. --remote deletes origin's logs too, for every user of the repository.

FLAGS
     [--remote]  Also delete every log on origin (unrecoverable) [default = false]
  -h  --help     Print help information and exit

## cabaret fetch

USAGE
  cabaret fetch
  cabaret fetch --help

Fetch remote activity: refresh origin's copies, fast-forward branches origin is strictly ahead of, merge every change's log with origin's, and absorb forge activity — import every open forge change that is not yet a change, refresh tracked ones, record lands, and prune closed imports nobody engaged with. The account the forge credentials authenticate, and its profile emails, are recorded as aliases of you, so their changes read as yours. Without a forge, the origin half still runs.

FLAGS
  -h --help  Print help information and exit

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

## cabaret home

USAGE
  cabaret home
  cabaret home --help

Show your reviews, changes, and workspaces

FLAGS
  -h --help  Print help information and exit

## cabaret land

USAGE
  cabaret land [--even-though-not-owner] [--even-though-unreviewed] [<change>]
  cabaret land --help

Land a change: write it onto its parent as a commit marked as landing (a merge, or a squash with cabaret config land-method squash), so the parent's reviewers are not asked to re-review the change's diff, and record the landing in the change's log. A change tracked on a forge lands by merging there and fetching the result; cabaret config land-via local (or forge) picks one side unconditionally. A change whose parent moved on lands as it stands when it merges cleanly onto the new tip; `cabaret rebase` first when it conflicts. Children of the landed change are reparented onto its parent, where their code now lives. A landed change can no longer be rebased, renamed, reparented, or transferred, though reviewing it is still recorded. A range `ancestor..descendant` lands every change after `ancestor` on `descendant`'s parent chain, `descendant` first, skipping changes that already landed; when one fails, the landings before it stand, and rerunning the range resumes.

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

## cabaret mark

USAGE
  cabaret mark [--change value] (--tip value) [--even-though-not-reviewing] <file>...
  cabaret mark --help

Record review of files: one `review` entry per file, recording the change's base and the tip the diff you read ended at — `review` prints the exact command. Arguments select files the way `review` does.

FLAGS
     [--change]                     Change to mark (defaults to current)
      --tip                         The revision the diff you read reviewed up to, as `review` printed it
     [--even-though-not-reviewing]  Record review even though the reviewing set does not include you      [default = false]
  -h  --help                        Print help information and exit

ARGUMENTS
  file...  files or patterns to mark reviewed

## cabaret rebase

USAGE
  cabaret rebase [--even-though-not-owner] [--even-though-parent-diverged] [<change>]
  cabaret rebase --help

Move a change onto its parent's tip by merging the tip into the change, then record the new base in the log. A conflicting merge is committed with its markers in place; fix them and amend, then continue. Only the change's owner may rebase it. A range `ancestor..descendant` rebases every change after `ancestor` on `descendant`'s parent chain, ancestormost first, skipping changes that have landed; a conflict stops the range there, and rerunning it resumes once the conflict is fixed.

FLAGS
     [--even-though-not-owner]        Proceed even though you do not own the change                                    [default = false]
     [--even-though-parent-diverged]  Rebase onto the parent's local reading even though origin's has diverged from it [default = false]
  -h  --help                          Print help information and exit

ARGUMENTS
  [change]  change or ancestor..descendant range to rebase (defaults to current)

## cabaret rename

USAGE
  cabaret rename [--even-though-not-owner] <old> <new>
  cabaret rename --help

Rename a change: move its code and its log to the new name together, atomically. Only the change's owner may rename it.

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
  cabaret review [--change value] [--context value] <file>...
  cabaret review --help

Show the diff of a change left for you to review: the files of the current review round, then each file's remaining diff. Arguments narrow what is shown — a path, or a gitignore-style pattern against repo-relative paths. What is shown is remembered, and `mark` records review of it.

FLAGS
     [--change]   Change to review (defaults to current)
     [--context]  Lines of context around each hunk, -1 for whole files (defaults to the cabaret.context setting, or 3)
  -h  --help      Print help information and exit

ARGUMENTS
  file...  files or patterns to show (defaults to the whole round)

### cabaret reviewers add

USAGE
  cabaret reviewers add [--change value] <user>
  cabaret reviewers add --help

Add a reviewer to a change. A reviewer owes review of the change's whole diff, as the owner does; `show` displays the reviewers, and `sync` settles them with the forge.

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

## cabaret reviewing

USAGE
  cabaret reviewing [--change value] [<reviewing>]
  cabaret reviewing --help

Show or set who is asked to review a change: none, the owner, the reviewers, or everyone. The set gates what todos ask of people; landing still requires every obligation. A change whose reviewing is none shows on its forge as a draft.

FLAGS
     [--change]  Change to act on (defaults to current)
  -h  --help     Print help information and exit

ARGUMENTS
  [reviewing]  reviewing set to record (prints the current one when omitted)

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

### cabaret setup list

USAGE
  cabaret setup list
  cabaret setup list --help

Show each recommendation and its status

FLAGS
  -h --help  Print help information and exit

### cabaret setup apply

USAGE
  cabaret setup apply
  cabaret setup apply --help

Apply the recommendations not yet set

FLAGS
  -h --help  Print help information and exit

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
  cabaret sync [--change value]
  cabaret sync --help

Sync a change: merge origin's copy of its branch into the local one — a conflicted merge commits its markers, to fix and amend — push the result, reconcile its forge change (opening one if none exists, retargeting it, settling comments, reviewers, draft and archived state both ways), and sync its log. Offline, the merge against origin's last-fetched copy still runs; syncing again online finishes the exchange.

FLAGS
     [--change]  Change to sync (defaults to current)
  -h  --help     Print help information and exit

## cabaret todos

USAGE
  cabaret todos [<change>]
  cabaret todos --help

Show the TODOs a change adds: the TODO comments in the tip's copy of each changed file with no matching TODO in the base's copy. Matching ignores position and whitespace, so a pre-existing TODO that merely moves does not appear.

FLAGS
  -h --help  Print help information and exit

ARGUMENTS
  [change]  change to inspect (defaults to current)

## cabaret unarchive

USAGE
  cabaret unarchive [--change value]
  cabaret unarchive --help

Bring an archived change back: it returns to the home page and may land again. A push reopens its forge change.

FLAGS
     [--change]  Change to unarchive (defaults to current)
  -h  --help     Print help information and exit

## cabaret widen

USAGE
  cabaret widen [--change value]
  cabaret widen --help

Widen a change's reviewing set to the next level with review to do — owner, reviewers, everyone — skipping levels whose users have already read the whole diff.

FLAGS
     [--change]  Change to widen (defaults to current)
  -h  --help     Print help information and exit

### cabaret workspace list

USAGE
  cabaret workspace list
  cabaret workspace list --help

List this repository's workspaces

FLAGS
  -h --help  Print help information and exit

### cabaret workspace add

USAGE
  cabaret workspace add [--at value] <change>
  cabaret workspace add --help

Create a workspace — a new working tree — with the change checked out, beside the primary workspace. Prints where it went.

FLAGS
     [--at]   Where to create the workspace (defaults beside the primary workspace)
  -h  --help  Print help information and exit

ARGUMENTS
  change  change the workspace holds

### cabaret workspace remove

USAGE
  cabaret workspace remove [--even-though-dirty] <change>
  cabaret workspace remove --help

Remove the workspace holding the change. The change itself — its code and its log — is untouched.

FLAGS
     [--even-though-dirty]  Remove the workspace even though it has uncommitted changes, discarding them [default = false]
  -h  --help                Print help information and exit

ARGUMENTS
  change  change the workspace holds

### cabaret workspace dir

USAGE
  cabaret workspace dir <change>
  cabaret workspace dir --help

Print the directory of the workspace holding a change

FLAGS
  -h --help  Print help information and exit

ARGUMENTS
  change  change the workspace holds
