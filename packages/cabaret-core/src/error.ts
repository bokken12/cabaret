/**
 * A failure the user can correct: bad input, or repository state that a
 * suggested command repairs. The message is the complete diagnostic, so the
 * CLI prints it bare. Any other exception is a bug in Cabaret and keeps its
 * stack trace.
 */
export class UserError extends Error {}
