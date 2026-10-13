# Video

I'm considering submitting Cabaret to https://blog.cloudflare.com/next-git-platform-on-cloudflare/. In many ways, they fit together well: Artifacts wants to be a forge but hasn't sorted out its social layer, while Cabaret has meaningfully rethought the representation and interactions around PRs and similar to provide a social layer, but doesn't want to build out a forge.

This will be a bit hacked together since I was sick for the wrong stretch of time and may even preview a few features that Cabaret hasn't fully refined yet, but I think it's still worth having a go, since Cabaret's core logic is here and has I suspect been thought out better than many of the competitors.

To appeal to the judges here, Cabaret may have to focus somewhat on its capacity to enhance agentic development, but it should do so only honestly, in ways that remain true to its core ethos.

## Possible Emphases

Some through lines I sometimes tell as being important to Cabaret which may make it into the story.

### Repo Sovereignty

- Everyone is annoyed by GitHub reliability lately (probably part of why Cloudflare is competing to build a forge)
- The social layer on top (PRs, issues, actions, etc) makes it hard to leave, you're tied to a vendor
- Cabaret puts all of that natively in git so that it can live on any forge and you can move easily
- Cabaret also syncs back and forth with GitHub, so this transition is non-scary and can be done gradually

In some sense this isn't the ideal Cloudflare story, they might like their own lock-in, but to the extent they're the upstart that needs some way to pull people towards them, maybe backing something more open and just providing better infra would sound okay?

### Code Review

- In the agentic era, more and more of developer's time is spent not typing out but instead reviewing code, this is Cabaret's focus
- Cabaret offers diff-based code review, making it easy to iterate and see just the changes, even in the presence of rebasing/similar
- Code review happens right in the editor with keybindings, so it's fast, familiar, and seamless with making small edits along with review (or in CLI for agents)
- Cabaret generally embraces a "co-ownership" model, where you and your agents are individuals jointly responsible for reading and writing
- Cabaret offers more detailed review obligations than code owners so you can focus only on the critical sections of code you care about

Some people (possibly even including the judges) are true believers that nobody should read code anymore, and I don't think Cabaret can meaningfully appeal to those people, but I do think there's a real story that it wasn't tenable to do the review in the bad system but still can be at least for some time when review is improved.

### Stacking

- Stacks are essential for good code review: they allow you to slice finely and tell a structured story in your changes rather than a big blob
- Stacks are also essential for concurrency: they allow you to keep working on changes which depend on prior work while that work is under review
- GitHub's stacks are uniquely bad. In addition to wrecking CI with big all-stack changes, they force a single linear order and landing together
- The fundamental unit of stacking is just the ability to declare "one change depends on or builds on another"
- Cabaret is much more flexible: it can have trees, where multiple changes depend on the same base, but have no interaction with each other
- Cabaret can even have DAGs, where a change depends on multiple in-progress changes, without imposing order between them

Stacks were GitHub's big recent feature that everyone had been waiting on for ages, and frankly they were disappointing. It feels good to one-up them here and just produce a better product.

### Concurrency

- In practice on GitHub, most adopt workflows where a single dev owns a branch to avoid conflicts because they can easily get hairy. Cabaret wants real co-ownership and isn't content with that
- All operations in Cabaret are append-only logs (for metadata and commits), so they compose well with multiple concurrent writers and this doesn't mess up review as a merge would in GitHub
- All operations in Cabaret are atomic: so they either completely happen or completely fail, and never stop at an in-progress state like git does with conflicts
- Cabaret offers good workspace management to help manage multiple agents running on a single machine and avoid them leaving behind garbage
- Cabaret's change graph also makes semantic concurrency and multiple possible implementations or overlapping feature work easy

Cloudflare's announcement has a big focus on allowing thousands of concurrent agents, and in classic Cabaret fashion, what is good for agents is also good for humans, benefitting large teams with monorepos and similar.

### A Demo

Quite possibly it'd be good to not just talk theoretically about Cabaret but also show some concrete work?

Task some agents to make 3 possible versions of a change as siblings (possibly split into stacks), review them, give some feedback, make some small edits, see only the diff in the further review, etc?

### Misc

There are some other things that could be mentioned but maybe don't have as obvious a section / similar

- Good defaults: Cabaret attempts to nudge towards the right workflows and next steps, which helps ensure agents will be doing the right things
- Offline capability: since everything is in git, you can do code review and similar actions even while offline
- Possibly sensible to mention inspiration from JJ, since it's gaining popularity, or Iron, since Jane Street has some mystique

I think there's even an argument of sorts that essentially the world is outgrowing the sort of Claude Code / Codex style harnesses that ask you to have a dialog with your agent and approve its next action. Instead it now makes much more sense to treat them as coworkers in much the same way you would've interacted with other humans (or maybe you couldn't have, but how the companies with the best infrastructure that don't rely on GitHub would have).
