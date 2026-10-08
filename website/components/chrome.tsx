import Link from "next/link";

export function Header({ quickstart = false, docs = false }: { quickstart?: boolean; docs?: boolean }) {
  return (
    <header className="site-header wrap">
      <Link href="/" className="wordmark" aria-label="Cabaret home">
        c
        <span className="wordmark-star" aria-hidden="true">
          ✳
        </span>
        baret
      </Link>
      <nav aria-label="Main navigation">
        <Link
          href="/quickstart/"
          aria-current={quickstart ? "page" : undefined}
        >
          Quickstart
        </Link>
        <Link href="/docs/" aria-current={docs ? "page" : undefined}>Docs</Link>
        <a href="https://github.com/bokken12/cabaret">
          GitHub <span aria-hidden="true">↗</span>
        </a>
      </nav>
    </header>
  );
}
