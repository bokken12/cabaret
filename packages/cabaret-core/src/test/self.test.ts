import { expect, test } from "vitest";
import { type Backend, currentSelf, userName } from "../index.js";

/** A backend of just an identity and its `cabaret.alias` config values. */
function configBackend(user: string, aliases: readonly string[]): Backend {
  const stub: Pick<Backend, "currentUser" | "configAll"> = {
    async currentUser() {
      return userName(user);
    },
    async configAll(key) {
      return key === "cabaret.alias" ? aliases : [];
    },
  };
  return stub as Backend;
}

test("currentSelf collects aliases, dropping duplicates and the user themselves", async () => {
  const backend = configBackend("alice@example.com", [
    "agent@example.com",
    "alice@example.com",
    "agent@example.com",
    "alice@work.example",
  ]);
  expect(await currentSelf(backend)).toEqual({
    user: userName("alice@example.com"),
    aliases: new Set([userName("agent@example.com"), userName("alice@work.example")]),
  });
});

test("currentSelf rejects an empty alias", async () => {
  const backend = configBackend("alice@example.com", [""]);
  await expect(currentSelf(backend)).rejects.toThrow("git config cabaret.alias must be nonempty");
});
