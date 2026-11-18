// The table of what establishes each kind's Done, in the engine's guide, is
// the one the code reads by (`DONE_EVIDENCE`): the same kinds, the same words.

import { readFileSync } from "node:fs";
import { DONE_EVIDENCE } from "@clawtrate/core";
import { expect, it } from "vitest";

const README = new URL("../../../packages/core/README.md", import.meta.url);

it("the guide's evidence table and the code's are the same, row by row", () => {
  const text = readFileSync(README, "utf8");
  const table = text.slice(
    text.indexOf("<!-- evidence:start -->"),
    text.indexOf("<!-- evidence:end -->"),
  );
  const rows = table
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => {
      const cells = line
        .slice(2, -2)
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim().replaceAll("\\|", "|"));
      return [cells[0]!.replaceAll("`", ""), { done: cells[1], lesser: cells[2] }] as const;
    });
  expect(Object.fromEntries(rows)).toEqual(DONE_EVIDENCE);
});
