import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Header } from "@/components/chrome";
import { DocsNavigation } from "@/components/docs";
import { Markdown } from "@/components/markdown";
import { getDocumentation } from "@/lib/posts";

export const dynamicParams = false;
export function generateStaticParams() {
  return getDocumentation().map(({ slug }) => ({ slug }));
}
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const post = getDocumentation().find((post) => post.slug === slug);
  return { title: `${post?.title ?? "Documentation"} — Cabaret` };
}
export default async function DocumentationPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const posts = getDocumentation();
  const index = posts.findIndex((post) => post.slug === slug);
  if (index === -1) notFound();
  const post = posts[index];
  return (
    <>
      <Header docs />
      <main id="main" className="wrap">
        <div className="guide-layout">
          <DocsNavigation current={slug} />
          <article className="docs-content">
            <h1>
              <span className="docs-page-number">{post.number}.</span> {post.title}
            </h1>
            <Markdown>{post.content}</Markdown>
            <nav className="chapter-navigation" aria-label="Adjacent chapters">
              {posts[index - 1] && (
                <Link href={`/docs/${posts[index - 1].slug}/`}>
                  ← {posts[index - 1].number}. {posts[index - 1].title}
                </Link>
              )}
              {posts[index + 1] && (
                <Link href={`/docs/${posts[index + 1].slug}/`}>
                  {posts[index + 1].number}. {posts[index + 1].title} →
                </Link>
              )}
            </nav>
          </article>
        </div>
      </main>
    </>
  );
}
