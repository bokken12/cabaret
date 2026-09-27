# Comparison with Iron

- **Iron is built on mercurial, while Cabaret is built on git.** Each operates at a similar abstraction/layer relative to their chosen backend.
- **Iron enforces a tree, while Cabaret permits a DAG.** Cabaret allows individual changes to have multiple parents if they depend on independent workstreams, while Iron's features must have a single parent.
- **Iron tracks diffs, while Cabaret tracks revisions.** Iron's brain contains base->tip pairs, and builds an algebra on top of these which can lead to diffs-of-diffs (diff4s). Cabaret stores only reviewed tips, and so always presents as a single diff, but may do so against a synthetic base.
