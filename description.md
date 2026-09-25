Restore the cursor on reopening a page.

Stepping into a file diff closes the page tab, and stepping out reopens it with the cursor at the top. VSCodeVim keeps its own per-document cursor where it was (and ignores a (0,0) selection when syncing), so the drawn cursor and the one motions move from disagree. Remember each page's last selection and pass it back to showTextDocument.
