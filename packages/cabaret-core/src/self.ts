import { type Backend, type UserName, userName } from "./backend.js";
import { UserError } from "./error.js";

/**
 * A user: the identity they write under, and the identities that also count
 * as them — an agent of theirs, another machine's email. Aliases never change
 * what is written (entries keep the identity that wrote them); they only
 * widen who counts as this user, as in ownership checks and the reviewing
 * set. Obligations stay per identity: a review counts only toward demands
 * naming the identity it was recorded under, so neither the user's review
 * nor an alias's ever stands in for the other's.
 */
export interface Self {
  readonly user: UserName;
  readonly aliases: ReadonlySet<UserName>;
}

/** Whether `user` is `self`: their writing identity or one of their aliases. */
export function isSelf(self: Self, user: UserName): boolean {
  return user === self.user || self.aliases.has(user);
}

/** A self of `user` alone — for reading as an identity whose aliases are unknown. */
export function soleUser(user: UserName): Self {
  return { user, aliases: new Set() };
}

/**
 * The current user's `Self`: their writing identity plus the aliases the
 * multi-valued config `cabaret.alias` declares. Aliases are a property of
 * the person, not the repository, so they normally live in `--global` config.
 */
export async function currentSelf(backend: Backend): Promise<Self> {
  const user = await backend.currentUser();
  const aliases = new Set<UserName>();
  for (const alias of await backend.configAll("cabaret.alias")) {
    if (alias === "") {
      throw new UserError("config cabaret.alias must be nonempty");
    }
    aliases.add(userName(alias));
  }
  aliases.delete(user);
  return { user, aliases };
}
