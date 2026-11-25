// CI splits the end-to-end suite across runners by the lists in e2e/shards/, one per runner,
// chosen by how long each file takes (#485). A spec file left out of every list would never run
// on CI, and one in two lists would run twice.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const E2E = new URL("../e2e/", import.meta.url);
const SHARDS = new URL("../e2e/shards/", import.meta.url);

const lists = readdirSync(SHARDS)
  .filter((name) => name.endsWith(".txt"))
  .sort()
  .map((name) => ({
    name,
    files: readFileSync(new URL(name, SHARDS), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  }));

describe("the e2e shard lists", () => {
  it("name every spec file once, and nothing else", () => {
    const specs = readdirSync(E2E)
      .filter((name) => name.endsWith(".spec.ts"))
      .sort();
    const listed = lists.flatMap((list) => list.files);
    expect([...listed].sort()).toEqual(specs);
    for (const file of listed) expect(existsSync(new URL(file, E2E)), file).toBe(true);
  });

  it("are the ones CI's e2e job runs, one runner each", () => {
    expect(lists.map((list) => list.name)).toEqual(lists.map((_, i) => `${i + 1}.txt`));
    const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const job = ci.slice(ci.indexOf("\n  e2e:\n"), ci.indexOf("\n  macos:\n"));
    expect(job).toContain(`shard: [${lists.map((_, i) => i + 1).join(", ")}]`);
    expect(job).toContain("pnpm e2e --test-list e2e/shards/${{ matrix.shard }}.txt");
  });
});
