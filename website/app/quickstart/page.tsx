import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/chrome";
import { Markdown } from "@/components/markdown";
import { getPosts, getSteps } from "@/lib/posts";

export const metadata: Metadata = {
  title: "Your first review — Cabaret Quickstart",
};

export default function Quickstart() {
  const post = getPosts().find((post) => post.slug === "quickstart")!;
  const steps = getSteps(post.content);
  return (
    <>
      <Header quickstart />
      <main id="main" className="wrap quickstart-main">
        <div className="guide-layout">
          <aside className="guide-sidebar">
            <nav aria-label="Quickstart steps">
              {steps.map((step, i) => (
                <a href={`#${step.id}`} key={step.id}>
                  <span>{String(i + 1).padStart(2, "0")}</span>
                  {step.title}
                </a>
              ))}
            </nav>
          </aside>
          <div className="guide-content">
            {steps.map((step, i) => (
              <section id={step.id} key={step.id} className="guide-step">
                <h2>
                  <span className="step-number">{String(i + 1).padStart(2, "0")}</span>
                  {step.title}
                </h2>
                <Markdown>{step.content}</Markdown>
              </section>
            ))}
            <section className="guide-done">
              <span className="small-star" aria-hidden="true">
                ✳
              </span>
              <h2>That's your first review!</h2>
              <p>
                Explore what else Cabaret has to offer and the philosophy behind
                how it approaches code review.
              </p>
              <Link
                className="button button-blue"
                href="/docs/"
              >
                Read the docs
              </Link>
              <Link href="/" className="back-home">
                Back to home
              </Link>
            </section>
          </div>
        </div>
      </main>
    </>
  );
}
