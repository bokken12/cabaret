import Link from "next/link";
import { Header } from "@/components/chrome";
import { CopyCommand } from "@/components/copy-command";
import { ReviewMemoryIllustration, GitIllustration, EditorIllustration } from "@/components/feature-illustrations";
import { StackComparison } from "@/components/stack-comparison";
import { installCommand } from "@/lib/content";

export default function Home() {
  return (
    <>
      <Header />
      <main id="main">
        <section className="hero wrap" aria-labelledby="hero-title">
          <h1 id="hero-title" className="hero-title">
            CABARET.
          </h1>
          <div className="hero-under-title">
            <span className="small-star" aria-hidden="true">
              ✳
            </span>
            <span className="rule" />
          </div>
          <div className="hero-content">
            <div className="hero-copy">

              <p>
                Code review from the comforts of your editor.
              </p>
              <Link className="button button-red" href="/quickstart/">
                Quickstart
              </Link>
            </div>
            <div className="install-card" id="install">
              <p>Install and get started today.</p>
              <CopyCommand command={installCommand} />
            </div>
          </div>
        </section>
        <div className="marquee" aria-label="Git underneath. Cabaret up front.">
          <div>
             <span>✳</span>  <span>✳</span>
            <span>✳</span> <span>✳</span> <span>✳</span>{" "}
            <span>✳</span>
          </div>
        </div>
        <section className="review-section wrap" aria-label="Cabaret features">

          <div className="features">
            <article className="feature-with-illustration">
              <div className="feature-copy">
              <span className="feature-number">I.</span>
              <h3>Never re-review the same code twice.</h3>
              <p>
                Cabaret remembers what you've reviewed and shows you only what changed since your last review, even after a rebase.
              </p>
              </div>
              <ReviewMemoryIllustration />
            </article>
            <article className="stack-feature">
              <span className="feature-number">II.</span>
              <h3>Stacks, stacks, stacks, now with multiple parents.</h3>
              <p>
                Many developers "stack" their work, where each new change builds on the one before it, so they keep working without waiting for review, and then land the changes together.

              </p>
              <br/>
              <p>However, stacking can create artificial dependencies.</p>
              <br/>
              <p>Suppose you're introducing a feature C that depends on A and B, who are perfectly independent changes.</p>
              <StackComparison />
            </article>
            <article className="feature-with-illustration">
              <div className="feature-copy">
              <span className="feature-number">III.</span>
              <h3>It's all still Git.</h3>
              <p>
                Cabaret runs on top of git and syncs with your forge of choice, like Github. So you can start using Cabaret today without uprooting your entire team anywhere; they can keep reviewing the way they always have... for now.
              </p>
              </div>
              <GitIllustration />
            </article>
            <article className="feature-with-illustration">
              <div className="feature-copy">
              <span className="feature-number">IV.</span>
              <h3>All from the comforts of your editor.</h3>
              <p>
                Have you ever been reviewing code and wished you could fix a typo or leave a comment right there in your editor? Well, with Cabaret, you can push the fix yourself or comment a TODO right there in the code. No more switching between your browser and editor.
              </p>
              </div>
              <EditorIllustration />
            </article>
          </div>
        </section>
        <section className="landing-quickstart wrap" aria-label="Get started">
          <Link className="button button-red" href="/quickstart/">Quickstart</Link>
        </section>
      </main>
    </>
  );
}
