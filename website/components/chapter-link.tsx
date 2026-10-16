"use client";

import Link from "next/link";
import type { ReactNode } from "react";

export function ChapterLink({ href, current, children }: { href: string; current: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      onClick={(event) => {
        const chapter = event.currentTarget.closest("details");
        if (chapter) chapter.open = true;
      }}
    >
      {children}
    </Link>
  );
}
