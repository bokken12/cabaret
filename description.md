Re-render pages whenever what they show may have changed, rather than only the active page after one of this window's own actions.

A page shows repository state that anything may change: this window, another window, the CLI, an agent. Tracking which pages an action affects is what left pages stale, so instead every open page is re-rendered:

- after any action, not only the active page;
- when the window regains focus, as after using a terminal or another window;
- when a file is saved, for the workspace page and descriptions.

And each page again as it comes into view, which catches whatever nothing reports, such as an edit to another workspace's files.

Updates to one page are serialized, so a slow render cannot land over a newer one. A show page keeps its last-listed sessions until they are relisted, so a refresh does not make them blink. A background refresh that fails shows the failure on the page instead of popping up an error on every focus.