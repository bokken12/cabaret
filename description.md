Test that a conflicted rebase can't land into a root

Landing after a rebase that committed conflict markers is a fast-forward, so the land merge itself reports no conflicts. `land` also checks the child's own conflicted files, so it refuses. This test covers that case, and the now-fixed entry comes out of docs/agent/bugs.md.