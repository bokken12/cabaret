/** [-readme] flag handler: prints the embedded man-page documentation.
 *
 *  The OCaml version pipes through [groff -Tascii -man | less]. We don't have
 *  a portable substitute, so we just print the raw man-page text — that
 *  matches what users actually get when they redirect to a file. */

import { readme } from "./text.js";

export const doc = " Display documentation for the configuration file and other help";

export const main = (): void => {
  process.stdout.write(readme);
  if (!readme.endsWith("\n")) process.stdout.write("\n");
};
