// CI splits the end-to-end suite across runners by the lists in e2e/shards/, one per runner,
// chosen by how long each file takes (#485). A spec file in no list still runs, on the last
// runner; one in two lists would run twice, and a list naming a missing file is a mistake.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { shardFiles, shardLists, shardProblems, unlisted } from "../e2e/shards.ts";

const E2E = fileURLToPath(new URL("../e2e/", import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An e2e folder of its own: these spec files, and these lists in its shards/. */
function folder(specs: string[], lists: string[][]): string {
  const dir = mkdtempSync(join(tmpdir(), "clawtrate-shards-"));
  dirs.push(dir);
  mkdirSync(join(dir, "shards"));
  for (const spec of specs) {
    mkdirSync(dirname(join(dir, spec)), { recursive: true });
    writeFileSync(join(dir, spec), "");
  }
  lists.forEach((files, i) =>
    writeFileSync(join(dir, "shards", `${i + 1}.txt`), `# runner ${i + 1}\n${files.join("\n")}\n`),
  );
  return dir;
}

describe("the e2e shard lists", () => {
  it("name no spec file twice and no file that is missing", () => {
    expect(shardProblems(E2E)).toEqual([]);
    const left = unlisted(E2E);
    // Not a failure: it runs on the last runner until someone places it.
    if (left.length > 0)
      console.log(`In no list yet, so on the last e2e runner: ${left.join(", ")}`);
  });

  it("are the ones CI's e2e job runs, one runner each", () => {
    const lists = shardLists(E2E);
    expect(lists.map((list) => list.name)).toEqual(lists.map((_, i) => `${i + 1}.txt`));
    const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const job = ci.slice(ci.indexOf("\n  e2e:\n"), ci.indexOf("\n  macos:\n"));
    expect(job).toContain(`shard: [${lists.map((_, i) => i + 1).join(", ")}]`);
    expect(job).toContain(
      'node e2e/shards.ts ${{ matrix.shard }} | tee "$RUNNER_TEMP/e2e-shard.txt"',
    );
    expect(job).toContain('pnpm e2e --test-list "$RUNNER_TEMP/e2e-shard.txt"');
  });

  it("put a spec file in no list on the last runner, and on no other", () => {
    const dir = folder(
      ["a.spec.ts", "b.spec.ts", "c.spec.ts", "scratch.spec.ts"],
      [["a.spec.ts"], ["b.spec.ts"], ["c.spec.ts"]],
    );
    expect(shardProblems(dir)).toEqual([]);
    expect(unlisted(dir)).toEqual(["scratch.spec.ts"]);
    expect(shardFiles(dir, 1)).toEqual(["a.spec.ts"]);
    expect(shardFiles(dir, 2)).toEqual(["b.spec.ts"]);
    expect(shardFiles(dir, 3)).toEqual(["c.spec.ts", "scratch.spec.ts"]);
    expect(() => shardFiles(dir, 4)).toThrow(/3 e2e runners/);
  });

  it("name a nested spec file by its path from e2e/, placed or not", () => {
    const dir = folder(
      ["a.spec.ts", "nested/b.spec.ts", "nested/deeper/c.spec.ts"],
      [["a.spec.ts"], ["nested/b.spec.ts"]],
    );
    expect(shardProblems(dir)).toEqual([]);
    expect(unlisted(dir)).toEqual(["nested/deeper/c.spec.ts"]);
    expect(shardFiles(dir, 2)).toEqual(["nested/b.spec.ts", "nested/deeper/c.spec.ts"]);
    // A nested file named only by its own name is not that file.
    const bare = folder(["nested/b.spec.ts"], [["b.spec.ts"]]);
    expect(shardProblems(bare)).toEqual([
      "1.txt names b.spec.ts, which is not a spec file in e2e/",
    ]);
    expect(unlisted(bare)).toEqual(["nested/b.spec.ts"]);
    const twice = folder(["nested/b.spec.ts"], [["nested/b.spec.ts"], ["nested/b.spec.ts"]]);
    expect(shardProblems(twice)).toEqual(["nested/b.spec.ts is in both 1.txt and 2.txt"]);
  });

  it("find a spec file in two lists, and a list naming a file that doesn't exist", () => {
    const twice = folder(["a.spec.ts", "b.spec.ts"], [["a.spec.ts"], ["a.spec.ts", "b.spec.ts"]]);
    expect(shardProblems(twice)).toEqual(["a.spec.ts is in both 1.txt and 2.txt"]);
    const missing = folder(["a.spec.ts"], [["a.spec.ts", "gone.spec.ts"]]);
    expect(shardProblems(missing)).toEqual([
      "1.txt names gone.spec.ts, which is not a spec file in e2e/",
    ]);
  });
});
