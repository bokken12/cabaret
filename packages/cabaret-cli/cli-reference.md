# Cabaret CLI Reference

<!-- Generated from the command tree; do not edit by hand. Regenerate with `pnpm test -u`. -->

## cab approve

USAGE
  cab approve [--allow-empty] [--allow-owner]
  cab approve --help

Approve a change

FLAGS
     [--allow-empty]  Allow approving an empty change  [default = false]
     [--allow-owner]  Allow approving a change you own [default = false]
  -h  --help          Print help information and exit

## cab archive

USAGE
  cab archive [--change value] [--undo]
  cab archive --help

Set a change aside without landing it: the change leaves the home page and refuses to land, but its branch and log stay. A push closes its forge change. `cab archive --undo` brings it back.

FLAGS
     [--change]  Change to archive (defaults to current)
     [--undo]    Bring the change back: it may land again, and a push reopens its forge change [default = false]
  -h  --help     Print help information and exit

## cab comment

USAGE
  cab comment [--change value] <text>
  cab comment --help

Add a comment to a change. Appends one `comment` entry to the change's log; `show` displays the comments.

FLAGS
     [--change]  Change to comment on (defaults to current)
  -h  --help     Print help information and exit

ARGUMENTS
  text  the comment text

## cab commit

USAGE
  cab commit <file>...
  cab commit --help

Commit the workspace's edits — modified, added, and deleted files alike — to the current change in one step, with no separate staging and no message to compose: the change is the reviewable unit, so its commits just carry its name. Arguments narrow what is committed to the named files or patterns.

FLAGS
  -h --help  Print help information and exit

ARGUMENTS
  file...  files or patterns to commit (defaults to every edit)

### cab config list

USAGE
  cab config list [--global] [--local]
  cab config list --help

Show every setting

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

#### cab config alias show

USAGE
  cab config alias show [--global] [--local]
  cab config alias show --help

Show the values

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

#### cab config alias add

USAGE
  cab config alias add [--global] [--local] <value>
  cab config alias add --help

Add a value

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  value  value to add

#### cab config alias remove

USAGE
  cab config alias remove [--global] [--local] <value>
  cab config alias remove --help

Remove a value

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  value  value to remove

#### cab config alias clear

USAGE
  cab config alias clear [--global] [--local]
  cab config alias clear --help

Remove every value

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

##### cab config alias github show

USAGE
  cab config alias github show [--global] [--local]
  cab config alias github show --help

Show the accounts

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

##### cab config alias github add

USAGE
  cab config alias github add [--global] [--local] <account>
  cab config alias github add --help

Add an account

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  account  account name, without the scheme

##### cab config alias github remove

USAGE
  cab config alias github remove [--global] [--local] <account>
  cab config alias github remove --help

Remove an account

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  account  account name, without the scheme

##### cab config alias github clear

USAGE
  cab config alias github clear [--global] [--local]
  cab config alias github clear --help

Remove every github account

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

##### cab config alias gitlab show

USAGE
  cab config alias gitlab show [--global] [--local]
  cab config alias gitlab show --help

Show the accounts

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

##### cab config alias gitlab add

USAGE
  cab config alias gitlab add [--global] [--local] <account>
  cab config alias gitlab add --help

Add an account

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  account  account name, without the scheme

##### cab config alias gitlab remove

USAGE
  cab config alias gitlab remove [--global] [--local] <account>
  cab config alias gitlab remove --help

Remove an account

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  account  account name, without the scheme

##### cab config alias gitlab clear

USAGE
  cab config alias gitlab clear [--global] [--local]
  cab config alias gitlab clear --help

Remove every gitlab account

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

##### cab config alias codeberg show

USAGE
  cab config alias codeberg show [--global] [--local]
  cab config alias codeberg show --help

Show the accounts

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

##### cab config alias codeberg add

USAGE
  cab config alias codeberg add [--global] [--local] <account>
  cab config alias codeberg add --help

Add an account

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  account  account name, without the scheme

##### cab config alias codeberg remove

USAGE
  cab config alias codeberg remove [--global] [--local] <account>
  cab config alias codeberg remove --help

Remove an account

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  account  account name, without the scheme

##### cab config alias codeberg clear

USAGE
  cab config alias codeberg clear [--global] [--local]
  cab config alias codeberg clear --help

Remove every codeberg account

FLAGS
     [--global]  Use the person's global config  [default = false]
     [--local]   Use this repository's config    [default = false]
  -h  --help     Print help information and exit

### cab config context

USAGE
  cab config context [--global] [--local] [--unset] [<value>]
  cab config context --help

Lines of diff context, -1 for whole files

FLAGS
     [--global]  Use the person's global config           [default = false]
     [--local]   Use this repository's config             [default = false]
     [--unset]   Unset the setting, restoring its default [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  [value]  value to set (shows the current value when omitted)

### cab config land-method

USAGE
  cab config land-method [--global] [--local] [--unset] [<value>]
  cab config land-method --help

How a land writes a change onto its parent: merge or squash

FLAGS
     [--global]  Use the person's global config           [default = false]
     [--local]   Use this repository's config             [default = false]
     [--unset]   Unset the setting, restoring its default [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  [value]  value to set (shows the current value when omitted)

### cab config land-via

USAGE
  cab config land-via [--global] [--local] [--unset] [<value>]
  cab config land-via --help

Where a land executes: local, forge, or auto

FLAGS
     [--global]  Use the person's global config           [default = false]
     [--local]   Use this repository's config             [default = false]
     [--unset]   Unset the setting, restoring its default [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  [value]  value to set (shows the current value when omitted)

### cab config workspace-style

USAGE
  cab config workspace-style [--global] [--local] [--unset] [<value>]
  cab config workspace-style --help

Where going to a change with no workspace checks it out: shared or dedicated

FLAGS
     [--global]  Use the person's global config           [default = false]
     [--local]   Use this repository's config             [default = false]
     [--unset]   Unset the setting, restoring its default [default = false]
  -h  --help     Print help information and exit

ARGUMENTS
  [value]  value to set (shows the current value when omitted)

## cab conflicts

USAGE
  cab conflicts [<change>]
  cab conflicts --help

Show each conflict marker left in a change's files, as file:line: text. A rebase that conflicts commits the markers in place; this lists what remains to fix.

FLAGS
  -h --help  Print help information and exit

ARGUMENTS
  [change]  change to inspect (defaults to current)

## cab create

USAGE
  cab create [--parent value] [--owner value] [--permanent] [--even-though-parent-archived] <change>
  cab create --help

Create a change, initializing its log with a parent, a base, and an owner. A change with no code yet starts at the parent's tip; an existing branch is adopted with the last revision shared with the parent as its base. The change must not already exist.

FLAGS
     [--parent]                       The new change's parent (defaults to what is checked out)
     [--owner]                        The new change's owner (defaults to you)
     [--permanent]                    Mark the new change permanent: structure expected to outlive its lands [default = false]
     [--even-though-parent-archived]  Proceed even though the parent is archived                             [default = false]
  -h  --help                          Print help information and exit

ARGUMENTS
  change  name for the new change

### cab dev log

USAGE
  cab dev log [<change>]
  cab dev log --help

Dump a change's raw log

FLAGS
  -h --help  Print help information and exit

ARGUMENTS
  [change]  change to inspect (defaults to current)

### cab dev review-all

USAGE
  cab dev review-all [--for value]
  cab dev review-all --help

Mark every file the home page asks you to review: one `review` entry per owed file, at its change's current tip.

FLAGS
     [--for]  Identity to mark as (defaults to you)
  -h  --help  Print help information and exit

### cab dev wipe

USAGE
  cab dev wipe [--remote]
  cab dev wipe --help

Delete the review state this repository holds: every change's log and the fetched copies of origin's logs. Branches and commits stay, and origin keeps its logs, so `cab fetch` restores them. --remote deletes origin's logs too, for every user of the repository.

FLAGS
     [--remote]  Also delete every log on origin (unrecoverable) [default = false]
  -h  --help     Print help information and exit

## cab diff

USAGE
  cab diff [--change value] [--context value] <file>...
  cab diff --help

Show a change's diff: each changed file, base to tip. Arguments narrow what is shown — a path, or a gitignore-style pattern against repo-relative paths.

FLAGS
     [--change]   Change to diff (defaults to current)
     [--context]  Lines of context around each hunk, -1 for whole files (defaults to the cabaret.context setting, or 3)
  -h  --help      Print help information and exit

ARGUMENTS
  file...  files or patterns to show (defaults to every changed file)

## cab fetch

USAGE
  cab fetch [--full]
  cab fetch --help

Fetch remote activity: refresh origin's copies, fast-forward branches origin is strictly ahead of, merge every change's log with origin's, and absorb forge activity — import every open forge change that is not yet a change, refresh tracked ones, record lands, and prune closed imports nobody engaged with. The account the forge credentials authenticate, and its profile emails, are recorded as aliases of you, so their changes read as yours. Without a forge, the origin half still runs.

FLAGS
     [--full]  Sweep every open forge change, not just what moved since the last fetch [default = false]
  -h  --help   Print help information and exit

## cab forget

USAGE
  cab forget [--change value] <file>...
  cab forget --help

Forget files of a change, so they need review again. Appends one `forget` entry per file to the change's log.

FLAGS
     [--change]  Change to forget in (defaults to current)
  -h  --help     Print help information and exit

ARGUMENTS
  file...  files to forget

## cab home

USAGE
  cab home
  cab home --help

Show your reviews, changes, and workspaces

FLAGS
  -h --help  Print help information and exit

## cab land

USAGE
  cab land [--even-though-not-owner] [--even-though-unreviewed] [--even-though-parent-unreviewed] [<change>]
  cab land --help

Land a change: write it onto its parent as a commit marked as landing (a merge, or a squash with cab config land-method squash), so the parent's reviewers are not asked to re-review the change's diff, and record the landing in the change's log. A change tracked on a forge lands by merging there and fetching the result; cab config land-via local (or forge) picks one side unconditionally. A change whose parent moved on lands as it stands when it merges cleanly onto the new tip; `cab rebase` first when it conflicts. Landing concludes the change: it archives, and its children are reparented onto its parent, where their code now lives, their forge changes retargeted to match. A permanent change stays live instead, at the landing commit with an empty diff, ready for its next cycle of work. A range `ancestor..descendant` lands every change after `ancestor` on `descendant`'s parent chain, `descendant` first, skipping archived changes; when one fails, the landings before it stand, and rerunning the range resumes.

FLAGS
     [--even-though-not-owner]          Proceed even though you do not own the change                    [default = false]
     [--even-though-unreviewed]         Land even though review obligations are unsatisfied              [default = false]
     [--even-though-parent-unreviewed]  Land even though the parent's review obligations are unsatisfied [default = false]
  -h  --help                            Print help information and exit

ARGUMENTS
  [change]  change or ancestor..descendant range to land (defaults to current)

## cab mark

USAGE
  cab mark [--change value] (--tip value) [--even-though-not-reviewing] <file>...
  cab mark --help

Record review of files: one `review` entry per file, recording the change's base and the tip the diff you read ended at — `review` prints the exact command. Arguments select files the way `review` does.

FLAGS
     [--change]                     Change to mark (defaults to current)
      --tip                         The revision the diff you read reviewed up to, as `review` printed it
     [--even-though-not-reviewing]  Record review even though the reviewing set does not include you      [default = false]
  -h  --help                        Print help information and exit

ARGUMENTS
  file...  files or patterns to mark reviewed

### cab owner show

USAGE
  cab owner show [--change value]
  cab owner show --help

Show a change's owner

FLAGS
     [--change]  Change to show (defaults to current)
  -h  --help     Print help information and exit

### cab owner set

USAGE
  cab owner set [--change value] [--even-though-not-owner] <user>
  cab owner set --help

Set a change's owner, replacing the current one. Only the owner may transfer ownership.

FLAGS
     [--change]                 Change to transfer (defaults to current)
     [--even-though-not-owner]  Proceed even though you do not own the change [default = false]
  -h  --help                    Print help information and exit

ARGUMENTS
  user  the new owner

### cab permanent show

USAGE
  cab permanent show [--change value]
  cab permanent show --help

Show whether a change is permanent

FLAGS
     [--change]  Change to show (defaults to current)
  -h  --help     Print help information and exit

### cab permanent set

USAGE
  cab permanent set [--change value] <permanent>
  cab permanent set --help

Set whether a change is permanent: structure — an umbrella others stack work under, say — expected to outlive its lands rather than archive on them. A permanent change refuses to archive until set back to false.

FLAGS
     [--change]  Change to act on (defaults to current)
  -h  --help     Print help information and exit

ARGUMENTS
  permanent  true or false

## cab rebase

USAGE
  cab rebase [--even-though-not-owner] [--even-though-parent-diverged] [<change>]
  cab rebase --help

Move a change onto its parent's tip by merging the tip into the change, then record the new base in the log. A conflicting merge is committed with its markers in place; fix them and amend, then continue. Only the change's owner may rebase it. A range `ancestor..descendant` rebases every change after `ancestor` on `descendant`'s parent chain, ancestormost first, skipping changes that have landed; a conflict stops the range there, and rerunning it resumes once the conflict is fixed.

FLAGS
     [--even-though-not-owner]        Proceed even though you do not own the change                                    [default = false]
     [--even-though-parent-diverged]  Rebase onto the parent's local reading even though origin's has diverged from it [default = false]
  -h  --help                          Print help information and exit

ARGUMENTS
  [change]  change or ancestor..descendant range to rebase (defaults to current)

## cab reparent

USAGE
  cab reparent [--even-though-not-owner] [--even-though-parent-archived] [--even-though-parent-diverged] <change> <parent>
  cab reparent --help

Update a change's parent. This is a metadata/log change only, and does not touch code without a subsequent `rebase`. Only the change's owner may reparent it.

FLAGS
     [--even-though-not-owner]        Proceed even though you do not own the change               [default = false]
     [--even-though-parent-archived]  Proceed even though the new parent is archived              [default = false]
     [--even-though-parent-diverged]  Proceed even though the new parent's readings have diverged [default = false]
  -h  --help                          Print help information and exit

ARGUMENTS
  change  change to reparent
  parent  the new parent

## cab review

USAGE
  cab review [--change value] [--context value] <file>...
  cab review --help

Show the diff of a change left for you to review: the files with review left, then each file's remaining diff. Arguments narrow what is shown — a path, or a gitignore-style pattern against repo-relative paths. What is shown is remembered, and `mark` records review of it.

FLAGS
     [--change]   Change to review (defaults to current)
     [--context]  Lines of context around each hunk, -1 for whole files (defaults to the cabaret.context setting, or 3)
  -h  --help      Print help information and exit

ARGUMENTS
  file...  files or patterns to show (defaults to everything left)

### cab reviewers add

USAGE
  cab reviewers add [--change value] <user>
  cab reviewers add --help

Add a reviewer to a change. A reviewer owes review of the change's whole diff, as the owner does; `show` displays the reviewers, and `sync` settles them with the forge.

FLAGS
     [--change]  Change to add the reviewer to (defaults to current)
  -h  --help     Print help information and exit

ARGUMENTS
  user  user to add

### cab reviewers remove

USAGE
  cab reviewers remove [--change value] <user>
  cab reviewers remove --help

Remove a reviewer from a change

FLAGS
     [--change]  Change to remove the reviewer from (defaults to current)
  -h  --help     Print help information and exit

ARGUMENTS
  user  user to remove

### cab reviewing show

USAGE
  cab reviewing show [--change value]
  cab reviewing show --help

Show who is asked to review a change

FLAGS
     [--change]  Change to show (defaults to current)
  -h  --help     Print help information and exit

### cab reviewing set

USAGE
  cab reviewing set [--change value] <reviewing>
  cab reviewing set --help

Set who is asked to review a change: none, the owner, the reviewers, or everyone. The set gates what todos ask of people; landing still requires every obligation. A change whose reviewing is none shows on its forge as a draft.

FLAGS
     [--change]  Change to act on (defaults to current)
  -h  --help     Print help information and exit

ARGUMENTS
  reviewing  reviewing set to record

### cab reviewing widen

USAGE
  cab reviewing widen [--change value]
  cab reviewing widen --help

Widen a change's reviewing set to the next level with review to do — owner, reviewers, everyone — skipping levels whose users have already read the whole diff.

FLAGS
     [--change]  Change to widen (defaults to current)
  -h  --help     Print help information and exit

### cab setup list

USAGE
  cab setup list
  cab setup list --help

Show each recommendation and its status

FLAGS
  -h --help  Print help information and exit

### cab setup apply

USAGE
  cab setup apply
  cab setup apply --help

Apply the recommendations not yet set

FLAGS
  -h --help  Print help information and exit

## cab show

USAGE
  cab show [<change>]
  cab show --help

Show a change's status

FLAGS
  -h --help  Print help information and exit

ARGUMENTS
  [change]  change to show (defaults to current)

## cab sync

USAGE
  cab sync [--change value]
  cab sync --help

Sync a change: merge origin's copy of its branch into the local one — a conflicted merge commits its markers, to fix and amend — push the result, reconcile its forge change (opening one if none exists, retargeting it, settling comments, reviewers, draft and archived state both ways), and sync its log. Offline, the merge against origin's last-fetched copy still runs; syncing again online finishes the exchange.

FLAGS
     [--change]  Change to sync (defaults to current)
  -h  --help     Print help information and exit

## cab todos

USAGE
  cab todos [<change>]
  cab todos --help

Show the TODOs a change adds: the TODO comments in the tip's copy of each changed file with no matching TODO in the base's copy. Matching ignores position and whitespace, so a pre-existing TODO that merely moves does not appear.

FLAGS
  -h --help  Print help information and exit

ARGUMENTS
  [change]  change to inspect (defaults to current)

## cab tui

USAGE
  cab tui [<change>]
  cab tui --help

Browse pages in the terminal

FLAGS
  -h --help  Print help information and exit

ARGUMENTS
  [change]  change to open (defaults to the home page)

### cab workspace list

USAGE
  cab workspace list
  cab workspace list --help

List this repository's workspaces

FLAGS
  -h --help  Print help information and exit

### cab workspace add

USAGE
  cab workspace add [--at value] <change>
  cab workspace add --help

Create a workspace — a new working tree — with the change checked out, beside the primary workspace. Prints where it went.

FLAGS
     [--at]   Where to create the workspace (defaults beside the primary workspace)
  -h  --help  Print help information and exit

ARGUMENTS
  change  change the workspace holds

### cab workspace remove

USAGE
  cab workspace remove [--even-though-dirty] <change>
  cab workspace remove --help

Remove the workspace holding the change. The change itself — its code and its log — is untouched.

FLAGS
     [--even-though-dirty]  Remove the workspace even though it has uncommitted changes, discarding them [default = false]
  -h  --help                Print help information and exit

ARGUMENTS
  change  change the workspace holds

### cab workspace reclaim

USAGE
  cab workspace reclaim [--all]
  cab workspace reclaim --help

Remove every workspace whose change has landed or is archived. A workspace with uncommitted changes is kept, as are the primary workspace and the one this command runs in; each is reported.

FLAGS
     [--all]  Reclaim every clean workspace, not only those of landed and archived changes [default = false]
  -h  --help  Print help information and exit

### cab workspace dir

USAGE
  cab workspace dir <change>
  cab workspace dir --help

Print the directory of the workspace holding a change

FLAGS
  -h --help  Print help information and exit

ARGUMENTS
  change  change the workspace holds
