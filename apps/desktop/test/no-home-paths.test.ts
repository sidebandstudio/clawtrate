// The repository is public: a path in a fixture names a made-up workspace,
// never a home directory, which would read as a real machine's user.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const PLACES = ["packages/core/src", "packages/core/test", "docs/design/prototype/js"];
const HOME = /\/home\/[^/\s"'`]+|\/Users\/[^/\s"'`]+/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

it("names no home directory in the reading's sources, its tests or the prototype", () => {
  const found = PLACES.flatMap((place) => files(join(ROOT, place)))
    .filter((path) => path !== SELF)
    .flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .map((line, i) => (HOME.test(line) ? `${path.slice(ROOT.length)}:${i + 1}` : null))
        .filter((hit): hit is string => hit !== null),
    );
  expect(found).toEqual([]);
});
