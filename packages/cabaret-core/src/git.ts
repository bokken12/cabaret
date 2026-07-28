/** Typed interface to `git` onto which Cabaret can translate its operations. */
export interface Git {

}

/** In-process for unit testing without suprocess spawns. Built on the `isomorphic-git` library. */
export class IsomorphicGit implements Git {}

/** Shells out to the local `git` binary. Built on the `simple-git` library. */
export class SimpleGit implements Git {}
