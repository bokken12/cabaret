# Terminology

Brainstorming proper terminology for Cabaret

## Reviewable Unit

What should one call the item which can be reviewed?

- GitHub calls this a "pull request (PR)"
- Iron calls this a "feature"
- Critique calls this a "change list (CL)"

People probably come in most familiar with GitHub terminology, although I'm a bit partial to descriptive words like "feature" over acronyms, but some people think of that as being a more precise term which might not include e.g. a bug fix.

Possibly something like a "change" following JJ might be reasonable? Although if it doesn't always line up 1:1 with JJ changes that could be confusing.

Tentative: I'm going to call this a "change" - and in a future JJ backend I think a JJ change would line up 1:1 with a Cabaret change. If this turns out badly, my second choice is "feature".

### Forge counterpart

What should one call the forge-side object a change syncs with — GitHub's "pull request", GitLab's "merge request"?

It is the external equivalent of a change, so: a "forge change" (`ForgeChange`, numbered by `ForgeChangeId`). PR/MR vocabulary stays confined to code that speaks a specific forge's API. Likewise the branch a forge change merges into is its "parent", not its "base" — in Cabaret a change's base is the commit its diff is computed against, and the forge's target branch is the counterpart of the change's parent.

## Groups

What should one call a set of people responsible for review?

- GitHub calls this a "team"
- Iron calls this a "role"

I'm pretty ambivalent here - both seem like good short names, but "team" maybe implies a certain organizational meaning that is not always true.

Tentative: I'm going to call this a "role". If this turns out badly, my second choice is "group".

## Endorsement

What should one call a successful review?

- GitHub calls this "approve"
- Iron calls this "second"
- Critique calls this "looks good to me (LGTM)"

To me "approve" seems like the clearest here, although maybe "second" emphasizes a slightly different meaning and I should think if there's a clearer way to have that? Maybe something like "vouch"?

Tentative: I'm going to call this "approve". If this turns out badly, my second choice is "endorse".

## Requirements

What should one call requirements to review code?

- GitHub and Critique call this "ownership"
- Iron calls this "obligations"

In general I like the implications of "obligations" more than that of "ownership". Owning things sounds good, like it makes you important and should be encouraged. In contrast obligations sounds like you have created for yourself a task and a responsibility, which I think is more how people should feel about it. On the other hand the word "obligation" feels imperfect to me - slightly outside of common parlance.

## Landing

What should one call the final step after approval?

- GitHub just calls this "merge" like git
- Iron calls this "release"
- Critique calls this "submit"

Also fairly happy with any of these, although I think "release" perhaps falsely implies rollout, and "submit" perhaps falsely implies a merge queue.

Tenatative: I'm going to call this "land". If this turns out badly, my second choice is "merge".

## Comments

What should signify a comment needing to be addressed?

- Iron uses "CR"

honestly I kind of like "TODO"? It's longer, but feels more universally acknowledged - and in general I prefer to avoid acronyms?

## The landing page

What should one call the page surveying your reviews, changes, and workspaces?

- Iron calls this "todo"
- Graphite calls this "inbox"
- Gerrit has a "dashboard" with an "attention set"

Iron's "todo" sat one letter from `todos` (the code TODOs a change adds — Iron's CRs), a clash Iron never had: a typo in either direction silently ran the other command. And the page holds more than obligations — your own changes and this device's workspaces live there too, so "todo" over-promised that every row was actionable. "Inbox" has the same problem from the other side: your own changes and workspaces don't arrive from anyone.

Decided: "home". Names the page by its role (where you start, where you return) rather than its contents, so it stays right as sections are added.

## Working trees

What should one call a working tree of the repository, each holding a checked-out change?

- git calls this a "worktree"
- Iron calls this a "workspace"
- VS Code also says "workspace", for the folder(s) a window has open

"Workspace" reads as a place you work rather than a data structure, which is the point. The VS Code collision is tolerable: in practice a Cabaret workspace opened in VS Code *is* the window's workspace.

Decided: "workspace". Git's "worktree" appears only in the code that shells out to git.

## Named pointers

What should one call the named, movable pointer to a line of code — what a change (or a parent like trunk) is named by?

- git calls this a "branch"
- hg calls this a "bookmark" (its "branch" is a different, permanent thing)
- JJ calls this a "bookmark" too

Decided: there is no third word — everything is referred to by its change name (`ChangeName`, per-backend grammar), and the `Backend` interface speaks of changes even for parents that are not changes themselves. "Branch" appears only in the code that shells out to git, and in messages it emits, where the native word is what the user can act on.

## The remote

What should one call the repository changes are shared through — where fetches read from and lands end up?

- git calls it a "remote", conventionally named "origin"
- hg calls it a "path", conventionally named "default"

Decided: "origin", everywhere — Cabaret pins a single remote, so the conventional git name doubles as the concept's name.

## Abandoning

What should one call setting a change aside without landing it?

- GitHub calls this "close"
- Iron calls this "archive"
- Gerrit calls this "abandon"

"Close" reads as final and says nothing about what happens to the work; "abandon" is accurate but harsh, and both undersell that the operation is reversible. "Archive" says exactly what Cabaret does: nothing is deleted, the change is set aside and can be brought back.

Tentative: I'm going to call this "archive" (undone by "unarchive"). If this turns out badly, my second choice is "abandon". A change's archived state syncs with its forge change's open/closed state.

## Exchanging with origin

What should one call moving state between this clone and origin?

- git splits it by direction: "fetch"/"pull" inbound, "push" outbound
- fossil has one word, "sync", and autosyncs by default
- hg has symmetric but manual "pull"/"push"

Everything cabaret shares is append-only (logs union; branches only gain
descendants, since rebase and land are merges), so the two copies of
anything always have a join and direction carries no meaning. Directional
verbs earn their keep when direction changes whose work wins (rewrites) or
when publication is itself a speech act; cabaret has neither — attention is
gated by the reviewing state, and release is `land`.

Decided: "sync" for the explicit per-change join (merge origin's copy,
conflicts committed; push; reconcile the forge change both ways), and
"fetch" for the ambient unobtrusive sweep (refresh origin readings,
fast-forward branches losing nothing — dirty workspaces hold theirs put —
union logs, absorb forge activity). "Fetch" is git's word with a wider
meaning here, adopted like "origin" because the instinct it imports — gets
remote state, never disturbs my work — is exactly right. "Merge" was
rejected for sync: GitHub-reared users read "merge" as landing, and it
already names a land method.

# Versions

I like JJ's "revision" over git's "commit", the commit feels like the action
