# Home

Cabaret hopes to be a tool that speeds up the development process and code review turnaround time. To that end, it is valuable for its home page to direct your attention to what is most valuable for you to see or work on.

## What To Show?

### Needs Review

The first priority for most people should be performing their code reivew obligations before writing code of their own, since this unblocks others. Within the space of changes that need your review, there may be further distinction for e.g. changes that are blocked on your review specifically and cannot be reviewed by others, or changes which have been waiting on your review for a long time.

### Owned

Changes of which you are an owner are those which you are expected to shepherd to release. These might include changes that are still in progress, or where you need to take steps like fulfilling TODOs or rebasing after other changes were landed into the parent.

### Workspaces

Workspaces on your machine consume resources and likely want to be cleaned up if they are not used, but this is lower priority. They may also serve as a reminder of what is currently in progress.

### Combining

Cabaret hopes to surface all of these in approximate priority order - either in a combined view or in adjacent tabs where appropriate.

## How To Show?

### Flat Inbox

Tools like GitHub's inbox simply show a list of changes requiring your attention. This gives maximal flexibility to order by priority, time, or other user-defined criteria. However it loses a lot of information about how stacks of features relate to each other. Since Cabaret encourages a heavy-stacking workflow where this info becomes essential, this seems insufficient.

### Tree

Tools with more emphasis on stacking like Iron or Graphite represent the parent-child relationship as a tree, where you can visualize depth on the x axis and see parent/sibling relationships by looking nearby. This is quite an intuituive mechanism for thinking of stacks, and can be efficiently represented in plain text. However, this requires features to have a single parent, or creating duplicate entries below each parent.

### Gutter Graph

Tools like Sapling and JJ with proper DAGs often represent this as a unicode graph. This is in some ways a better representation of Cabaret's data model, but optimizes for the wrong scenario. It is great at showing changes which are sequential or depend on each other, and less effective at representing lots of independent parallel changes that might have been children in a tree, which is by far the most common case.

### Cabaret

Cabaret chooses to do a bit of a combination of these last two options. It uses a custom graph renderer to handle DAGs correctly when necessary, but one which reduces exactly to tree representation in the common single-parent case. This way it hopes to get the best of both worlds, with complex ancestry represented correctly, but not infecting changes that can be shown more simply.

## Performance

Figuring out the ideal graph representation and even just reading all of the changes to assemble this home page can be expensive in the worst case, so we must always be attentive to performance here. In the future we may want to precompute/cache some data to avoid assembling it all on demand.
