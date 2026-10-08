"use client";

import { useEffect, useRef, useState } from "react";

export function CopyCommand({
  command,
  compact = false,
}: {
  command: string;
  compact?: boolean;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setStatus("copied");
    } catch {
      setStatus("error");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <div className={`command-block ${compact ? "compact" : ""}`}>
      <div className="command-row">
        <span className="prompt" aria-hidden="true">
          $
        </span>
        <pre>
          <code>{command}</code>
        </pre>
        <button
          onClick={copy}
          className="copy-button"
          aria-label={status === "copied" ? "Command copied" : "Copy command"}
        >
          {status === "copied" ? (
            <span aria-hidden="true">✓</span>
          ) : (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <rect x="8" y="8" width="12" height="12" rx="1" />
              <path d="M16 8V4H4v12h4" />
            </svg>
          )}
          <span>{status === "copied" ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <span
        role="status"
        className={status === "error" ? "copy-error" : "sr-only"}
      >
        {status === "copied"
          ? "Command copied to clipboard."
          : status === "error"
            ? "Clipboard unavailable. Select and copy the command above."
            : ""}
      </span>
    </div>
  );
}
