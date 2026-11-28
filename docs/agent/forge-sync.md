# Forge Sync

How Cabaret changes sync with a forge's pull requests, and what is left to build. GitHub is the first forge; "forge change" and "forge event" are the forge-neutral words (see `docs/terminology.md`).

## Design

### Forge Events Live in the Log

The log stays the source of truth: a device without forge credentials, or offline, reads everything from it. Each event in a forge change's history (a rename, a review, a merge) is recorded as one log commit.

- **Written from the event alone.** Tree, author, time, and message all come from the forge, and the commit has no parents. Every device importing the event writes the same commit, so two logs that both imported it hold it once.
- **Marked by a `forge-event` file** holding the forge's id for the event, beside `actions.jsonl`. A commit with that file and parents is refused.
- **Joined by a commit taking no actions**, whose parents are the log's head and the new event commits. Joins differ between devices and carry nothing to disagree about.
- **One commit per event, never a batch.** A batch depends on what one poll happened to see, so two devices' batches would overlap without git knowing.

### Ordering Uses No Clocks Across the Boundary

Among commits ready to fold, forge events go last, and are ordered among themselves by the forge's own time.

- A local write folds after exactly the forge events it descends from, through a join.
- A forge event beats any local write that had not seen it.

So for a field written from both sides, the value is the latest forge event's unless a local write has seen that event, in which case the local write wins and is waiting to be pushed. Outbound sync needs no record of what was sent: push when the folded value differs from the latest forge value. A local edit made without seeing a newer forge event loses silently.

### Everyone Is the Bridge

Any device with a forge credential imports during `cab sync`. Identical event commits make any number of importers safe, so a solo user, a small team, and a headless `cab sync` run by a bot are the same code. Actions the forge attributes to a person (an approval, a comment) can only be pushed by that person's own device.

### Linkage

Every imported commit carries its forge event id. Nothing links a local write to the event the forge made of it; single-value fields do not need it. Objects that would otherwise appear twice once imported back (comments, review bodies) will need a marker stored in the object on the forge.

## Decisions

- Every open pull request whose head branch is on origin is imported. Pull requests from forks are skipped.
- The change is the one named for the head branch.
- Requested reviewers and reviewers become owners; there is no separate reviewer concept. An approval is an endorsement; "changes requested" and a dismissal remove it.
- A draft is `reviewing: none`; ready is `reviewing: owners`.
- The base branch is the change's parent. A change with several parents gets no pull request.
- Merged and closed both archive.
- A pull request is opened when review is requested.
- Identities imported from GitHub are `github:<login>` and are never mapped to an email while importing, which would make devices write different commits.
- The token is `GITHUB_TOKEN`, else `gh auth token`.
- Descriptions do not sync in either direction.
- The log stays strict: a device that meets an action it does not know must update.

## Built

- The fold rule and the `forge-event` marker, in `crates/transaction/src/metadata.rs`.
- `Cabaret::import_forge_events`, which writes and joins event commits and skips events the log already holds.
- `cabaret-forge`, whose `github` module holds the GraphQL query for a pull request's history, lenient response types, and the reading of that history as events. Opening is synthesized under the pull request's own id, since GitHub keeps no event for it.
- `github::GitHub`, the client: it lists pull requests by last update over REST, and fetches one pull request's history over GraphQL a page at a time. It uses the `curl` crate gix already builds, so it adds no dependencies and nothing is async.

## Remaining

1. **Read-only import in `cab sync`.** List what changed since a locally kept time, import each history, and skip forks.
2. **Outbound, single-value fields.** Open a pull request; push title and base.
3. **Outbound approval.** Endorsing approves, with the endorser's own token.
4. **Landing through the forge**, including recognising squash merges.

Needed before the import runs against a real repository: `cab sync` reporting push results per ref, and following a branch another tool force-pushed.

## Open Questions

- **Pull request authors never endorse.** GitHub does not let an author approve their own pull request, so every imported one has an owner who has not endorsed. Opening could count as endorsing.
- **Owners need not review every line.** The intended end state is that an owner must endorse and is offered every file, but is not required to review each. Until then a GitHub approver who marks nothing blocks landing, and is overridden.
- **Base changes do not strictly replace parents.** An event can only remove the old base and add the new one, so a parent added only in Cabaret survives.
- **Cost of polling.** Listing is one REST request per sync and each changed pull request one GraphQL request; neither is conditional yet, though REST lists support `ETag`s.
- **Paging is untested.** No recorded pull request has more than one page of events.
- **A per-repository setting** saying a dedicated bridge exists, so other devices stop polling.
- **Two versions serializing one event differently** write it twice. Importing skips an event id the log holds, which does not cover two devices importing at once.
- **A renamed login** changes the identity an old event imports under.
- **Surfacing a local edit that lost** to a forge event.
- **Deleted head branches.** GitHub may delete the branch on merge, leaving a log without a branch.
- **Comments**, and the other objects that need outbound linkage.
