/** Forges often have "pull requests" which must be synced back/forth with Cabaret. */
export interface Forge {}

/** https://github.com/ is the dominant forge, with easy integration via `octokit`. */
export class GitHub implements Forge {}