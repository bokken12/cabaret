Render pages from one route

`Route` (home section, show, or a view's files) moves from the extension into the page crate, and `Cabaret::page` renders any of them, putting a change's tabs under its heading. The node bindings expose that one method in place of `showPage`, `filesPage`, `changeTabsPage` and `homeSectionPage`, and the extension drops `renderRoute` and its page splicing for the generated `Route` type.

Tabs and page are now read one after the other on a single blocking thread, where the extension used to request them in parallel.