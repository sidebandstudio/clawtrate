// The repository is public: a path in a fixture names a made-up folder, never
// a home directory, which would read as a real machine's user. Every tracked
// text file is read.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SELF = relative(ROOT, fileURLToPath(import.meta.url));
const BINARY = /\.(png|jpe?g|gif|ico|icns|webp|woff2?|ttf|otf|dmg|zip|pdf|mp3|mp4|wav)$/i;
const HOME = /\/home\/[^/\s"'`]+|\/Users\/[^/\s"'`]+/;

it("names no home directory in any tracked file", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((path) => path && path !== SELF && !BINARY.test(path));
  const found = tracked.flatMap((path) => {
    let text: string;
    try {
      text = readFileSync(join(ROOT, path), "utf8");
    } catch {
      return [];
    }
    return text
      .split("\n")
      .map((line, i) => (HOME.test(line) ? `${path}:${i + 1}` : null))
      .filter((hit): hit is string => hit !== null);
  });
  expect(found).toEqual([]);
});
