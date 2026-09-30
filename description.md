Show line counts on files pages

Each file on a files page shows how many lines its diff adds and removes, counted with the same diff options as `cab diff`, or `binary`; each folder shows the total over the text files under it. Beyond 100 files a page skips counting, so a huge change still lists quickly.