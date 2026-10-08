import Link from "next/link";
import { ChapterLink } from "@/components/chapter-link";
import { getChapters } from "@/lib/posts";

export function DocsNavigation({ current }: { current?: string }) {
  const chapters = getChapters();
  return <aside className="guide-sidebar docs-sidebar"><nav aria-label="Documentation chapters">
    <Link href="/docs/" aria-current={current === undefined ? "page" : undefined}>Documentation</Link>
    <ol className="book-chapters">
      {chapters.map(({ page, children }) => <li key={page.slug}>
        {children.length ? <details key={`${page.slug}-${current ?? "index"}`} open={current === page.slug || children.some((child) => child.slug === current)}>
          <summary aria-label={`Expand or collapse chapter ${page.number}: ${page.title}`}>
            <ChapterLink href={`/docs/${page.slug}/`} current={current === page.slug}><span className="chapter-number">{page.number}.</span> {page.title}</ChapterLink>
          </summary>
          <ol className="book-subsections">{children.map((child) => <li key={child.slug}>
            <Link href={`/docs/${child.slug}/`} aria-current={current === child.slug ? "page" : undefined}><span className="chapter-number">{child.number}.</span> {child.title}</Link>
          </li>)}</ol>
        </details> : <Link href={`/docs/${page.slug}/`} aria-current={current === page.slug ? "page" : undefined}><span className="chapter-number">{page.number}.</span> {page.title}</Link>}
      </li>)}
    </ol>
  </nav></aside>;
}
