Render pages VS Code keeps open through an extension host restart

Reinstalling the vsix restarts the extension host while the window keeps its cabaret: tabs and documents. The new host has no renders of them, so Enter, links, folds and colours are dead on those tabs, and a home-page selection action fails with "… is not rendered" until the page is reopened. Activation now renders every open page.

Also stop rerender waiting forever when the document closes while the page renders: no change or close event follows then.

The "cabaret:/home/owned is not rendered" error seen from open() came from the build before fresh-page-on-reopen, which fired the change and then opened the document without waiting for the re-read; rerender already fixes that.
