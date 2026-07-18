/** Node/libuv codes for a network failure: no DNS, refused, reset, timed out, no route. */
const CONNECTIVITY_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
]);

/** Substrings git and ssh use for a network failure, distinct from an auth or repository problem. */
const CONNECTIVITY_PATTERNS = [
  /could not resolve host/i,
  /could not resolve hostname/i,
  /network is unreachable/i,
  /operation timed out/i,
  /connection timed out/i,
  /connection refused/i,
  /no route to host/i,
];

/** `error`'s libuv code, or its cause's — Node's `fetch` wraps a connection failure one level down. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    return code;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) {
    return undefined;
  }
  const causeCode = (cause as { code?: unknown }).code;
  return typeof causeCode === "string" ? causeCode : undefined;
}

/**
 * Whether `error` looks like "no network" — worth backing off quietly for,
 * rather than a real failure (bad auth, a repository that is actually gone)
 * that backing off would not fix and so should surface instead.
 *
 * Best effort: a forge call's network failure carries a libuv code (`fetch`
 * wraps it in `.cause`), but git and ssh only report one as plain text, so
 * this also matches the messages they're known to use for it. An ambiguous
 * message — git's generic "could not read from remote repository," which an
 * auth failure shares — is left classified as a real failure rather than
 * risk silently swallowing one.
 */
export function isConnectivityError(error: unknown): boolean {
  const code = errorCode(error);
  if (code !== undefined && CONNECTIVITY_CODES.has(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return CONNECTIVITY_PATTERNS.some((pattern) => pattern.test(message));
}
