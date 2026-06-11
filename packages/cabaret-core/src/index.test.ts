import { expect, test } from "vitest";
import { CABARET } from "./index.js";

test("workspace wiring", () => {
  expect(CABARET).toBe("cabaret");
});
