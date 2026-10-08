```
npm run dev
```

then open localhost:3000

## favicon
<img width="113" height="40" alt="image" src="https://github.com/user-attachments/assets/8947bdad-7f06-4df9-b788-beace9e05426" />


## landing page
<img width="1556" height="850" alt="image" src="https://github.com/user-attachments/assets/f10e5218-550b-4d95-bc91-d99e34e3c4ca" />
<img width="1436" height="581" alt="image" src="https://github.com/user-attachments/assets/3db4fbfc-29f0-4fee-ab83-b9f0854bef06" />

<img width="1433" height="869" alt="image" src="https://github.com/user-attachments/assets/53d3e5c5-fa55-4fc9-b49d-cd05f14af1f8" />
<img width="1413" height="739" alt="image" src="https://github.com/user-attachments/assets/87ecd023-8b9b-4735-ab7e-b0e1d0dc8086" />
<img width="1423" height="615" alt="image" src="https://github.com/user-attachments/assets/ede0be74-9fb5-427d-93f5-48607e77eae2" />
<img width="1411" height="606" alt="image" src="https://github.com/user-attachments/assets/d0364e00-719e-4e98-9153-0b106472bcf9" />

## quickstart

this needs to be properly written, it was vibe-written by codex and i only focused on the design
<img width="1409" height="877" alt="image" src="https://github.com/user-attachments/assets/62086b39-4e54-4228-980d-377aa99e3efa" />
<img width="1233" height="865" alt="image" src="https://github.com/user-attachments/assets/13896de2-d658-4ea5-8460-036d127b71f4" />
<img width="1335" height="860" alt="image" src="https://github.com/user-attachments/assets/26f25dfe-9087-416e-8e65-c6d93cfa226e" />


## Writing documentation

Documentation is a book made from Markdown files in `posts/`. Filenames determine chapter numbers, hierarchy, and reading order:

```text
posts/
  quickstart.md
  ch01-00-getting-started.md     → 1. Getting started
  ch01-01-review-memory.md       → 1.1. Review memory
  ch01-02-built-on-git.md        → 1.2. Built on Git
  ch02-00-your-next-chapter.md   → 2. Your next chapter
  ch02-01-a-subsection.md        → 2.1. A subsection
```

`chNN-00-name.md` is a chapter introduction. `chNN-MM-name.md` belongs to that chapter, with a positive subsection number. Numbers sort numerically, so chapter 10 follows chapter 9. Use two digits for filenames to keep them tidy in your editor. Rename files to reorder or move chapters and subsections; update links pointing to renamed files. Duplicate numbers and subsections without a chapter introduction produce a clear build error.

Each documentation file starts with a Markdown title, with no YAML needed:

```markdown
# Your next chapter

Write the chapter introduction here.

## A heading within this page

Use links, lists, tables, and fenced code blocks as usual.
```

The first `#` heading supplies the page and navigation title; the layout adds its chapter number. `##` headings are headings within the page. To add a numbered subsection in the sidebar, create another file such as `ch02-01-a-subsection.md`.

The sidebar has expandable chapters and opens the chapter containing the current page. Click a chapter title to read its introduction and expand its subsections at the same time; click its disclosure triangle to expand or collapse subsections. Clicking the current chapter title also reopens it if you have collapsed it. Previous/next links follow filename order.

The filename becomes its URL: `[Review memory](/docs/ch01-01-review-memory/)`. Markdown supports GitHub-style tables, task lists, and strikethrough. Fenced code blocks have copy buttons. Raw HTML is not rendered.

`posts/quickstart.md` is separate from the book: its `##` headings become numbered steps and sidebar links at `/quickstart/`. Its celebratory ending is maintained in `app/quickstart/page.tsx`.

Run `npm run dev` to preview edits. Run `npm run build` to regenerate the static website in `out/`; no content server is needed in production.
