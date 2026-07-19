// The packaged grammar file: an empty seed so the contribution's path always
// resolves. Activation regenerates it from the installed language registry.
import { writeFileSync } from "node:fs";

writeFileSync(
  new URL("../dist/cabaret.tmLanguage.json", import.meta.url),
  JSON.stringify({ scopeName: "text.cabaret", patterns: [] }),
);
