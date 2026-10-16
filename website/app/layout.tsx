import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cabaret — Give your code a proper review.",
  description:
    "Diff-based code review, built on Git. Meet Cabaret and take your first change from the command line to reviewed.",
  icons: { icon: "/icon.svg?v=ticket" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
