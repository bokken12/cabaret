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

## Script

### Intro

The next git platform shouldn't be another walled garden, locking you into a specific hosting provider. Instead, it should fit natively within the git protocol and data, so that you can pick up your GitHub repository and move it to Artifacts, Origin, or Codeberg without losing collaborative features like PRs. The next git platform should be Cabaret.

When Linus Torvalds first wrote git, collaboration happened outside git itself: patches were emailed, discussed, and reviewed on mailing lists. Hosting platforms like GitHub later made that coordination approachable for everyone, but they kept it in their own databases.

Cabaret's thesis is that agents have grown past the point of being treated like a tool that you wield carefully with your full attention, and into real collaborators that can work independently before raising the results to your attention. This means the same collaborative tooling that's good for humans is also good for agents, and needs to be first-class even for projects where you are the only human participant.

### Review & Efficiency

Collaboration with others introduces many challenges. You need to align on what you want to build, and how to structure it. You need to maintain understanding of the system as a whole, even when there are large parts of it you didn't personally write. Luckily, these are a class of problem that has been faced many times before: by human agents working at tech companies.

Code review has been central to resolving these problems: keeping the relevant parties in agreement and in the loop for key decisions. Cabaret is, at its core, a code review tool, and takes direct inspiration from the best industry equivalents like Critique, Differential, and Iron.

However, as LLMs have made producing code faster and easier than ever before, existing code review processes have struggled to keep up. As reviewing agent output is quickly coming to dominate the development experience, we need tools to help us move faster and more reliably.

Cabaret moves the review experience out of GitHub's clunky website and directly into the IDE where you're already fastest. Its easy-to-learn UI elements all push you towards the equivalent keybindings, so that you can race through code review without touching your mouse, just like vim sped up writing code.

Review comments in Cabaret are written inline with the code, which means that making a trivial fix yourself follows the same uniform workflow as leaving feedback. Plus, since you're right in the editor, it's easy for you to jump to definitions or gather other context you need to understand changes. The goal is to return you to being an active participant and co-author, rather than peering at your project through a glass pane.

Rather than a single "approve" button, Cabaret tracks the versions of code you've reviewed. That means when you're iterating with your agents on a feature, you'll see only what changed since your last review, rather than needing to hunt for the crucial fix in a larger change. Cabaret lets you specify varying scrutiny levels so you only review critical files, and understands workflows like rebasing which won't require duplicate review.

### Stacking & Concurrency

Even with all these niceties, it can still be possible for review processes to feel like blockers which slow things down, especially with lots of people or agents performing concurrent changes. An important innovation here, that GitHub has only recently picked up on, is "stacked" PRs, which Cabaret would call stacked "changes".

One commonly noted feature of stacked changes that can help with review is the ability to use the pieces to tell a story: separating out higher and lower scrutiny items, or semantically distinct parts. Yet, I would claim that the more important primitive here is that a change can stack on another when it depends on or builds upon that work. In this manner, an agent can continue making progress even while their early work is still in review.

However, the linear structure of GitHub's stacks is unnecessarily limiting here. It should be possible for multiple agents to do follow-ups depending on the same work without needing to interact with each other, forming a tree structure. Perhaps they are even prototyping a few distinct designs for you to compare in the review process and choose the best of. It should even be possible for a change to depend on two or more other pieces of work, perhaps integrating them together, forming a DAG.

Cabaret's changes natively accommodate all these different concurrent workflows, and are designed to push best practices and minimize the friction of working on multiple things at once. By default, changes live in dedicated workspaces so agents on the same machine don't fight over shared resources, and nudge you to clean them up when they're no longer needed.

Under the hood, all Cabaret metadata consists of atomic transactions on append-only logs. A git operations can be append-only too, since merges don't confuse Cabaret's review obligations the way they do GitHub's and Cabaret's change graph and change log neatly substitute for a manicured git commit graph. Combined, this leads to a system with fewer conflicts, more automatic resolution, and no need for conventions like one engineer per branch to stay out of trouble.

### Conclusion & Disclaimers

Cabaret is built in Rust on top of a git backend via Gitoxide, and everything, including review state and change metadata, lives in git. That means it works with any forge or even offline, and you can incrementally adopt while your teammates stick to what they're familiar with.

Cabaret is under active development and still pre-1.0, so does not yet promise no breaking changes. Cabaret is currently available as a CLI (for agents) and a VSCode extension (for humans). More details on the nuances of getting review state and similar right are available in the docs. I hope that Cabaret and its ideas can help make better interfaces to version control and code review available for everyone!
