import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/chrome";
import { DocsNavigation } from "@/components/docs";
import { getChapters } from "@/lib/posts";

export const metadata: Metadata = { title: "Documentation — Cabaret" };
export default function Documentation() {
  const chapters = getChapters();
  return (
    <>
      <Header docs />
      <main id="main" className="wrap">
        <div className="guide-layout">
          <DocsNavigation />
          <article className="docs-content">
            <h1>Documentation</h1>
            <p>
              Start with <Link href="/quickstart/">your first review</Link>, or explore the chapters below.
            </p>
            <ol className="book-index">
              {chapters.map(({ page, children }) => (
                <li key={page.slug}>
                  <Link href={`/docs/${page.slug}/`}>
                    {page.number}. {page.title}
                  </Link>
                  {children.length > 0 && (
                    <ol>
                      {children.map((child) => (
                        <li key={child.slug}>
                          <Link href={`/docs/${child.slug}/`}>
                            {child.number}. {child.title}
                          </Link>
                        </li>
                      ))}
                    </ol>
                  )}
                </li>
              ))}
            </ol>
          </article>
        </div>
      </main>
    </>
  );
}
