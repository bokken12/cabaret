/**
 * A failure the user can correct: bad input, or repository state that a
 * suggested command repairs. The message is the complete diagnostic, so the
 * CLI prints it bare. Any other exception is a bug in Cabaret and keeps its
 * stack trace.
 */
export class UserError extends Error {}

/**
 * The repository's version-control tool is not installed: nothing on PATH
 * answers to its name. Frontends may pair the message with `downloadUrl` —
 * a button, a link — to offer the install.
 */
export class VcsUnavailableError extends UserError {
  constructor(
    message: string,
    readonly downloadUrl: string,
  ) {
    super(message);
  }
}
