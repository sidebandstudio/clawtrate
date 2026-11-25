// The files each of CI's e2e runners runs (#485): the spec files its list in e2e/shards/ names,
// and for the last runner also every spec file no list names, so a new spec runs before anyone
// places it. CI writes what this prints to a file for `playwright test --test-list`.
//
//   node e2e/shards.ts <runner>   prints that runner's files, one per line, from e2e/
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The lists, in runner order (`1.txt`, `2.txt`, …), each with the files it names. */
export function shardLists(e2e: string): { name: string; files: string[] }[] {
  const dir = join(e2e, "shards");
  return readdirSync(dir)
    .filter((name) => /^\d+\.txt$/.test(name))
    .sort((a, b) => parseInt(a) - parseInt(b))
    .map((name) => ({
      name,
      files: readFileSync(join(dir, name), "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")),
    }));
}

const specFiles = (e2e: string) =>
  readdirSync(e2e)
    .filter((name) => name.endsWith(".spec.ts"))
    .sort();

/** The spec files no list names: they run with the last runner. */
export function unlisted(e2e: string): string[] {
  const listed = new Set(shardLists(e2e).flatMap((list) => list.files));
  return specFiles(e2e).filter((name) => !listed.has(name));
}

/** What is wrong with the lists: a file in two of them, or one that doesn't exist. */
export function shardProblems(e2e: string): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  const specs = new Set(specFiles(e2e));
  for (const { name, files } of shardLists(e2e)) {
    for (const file of files) {
      const first = seen.get(file);
      if (first) problems.push(`${file} is in both ${first} and ${name}`);
      else seen.set(file, name);
      if (!specs.has(file))
        problems.push(`${name} names ${file}, which is not a spec file in e2e/`);
    }
  }
  return problems;
}

/** The files runner `shard` (from 1) runs. */
export function shardFiles(e2e: string, shard: number): string[] {
  const lists = shardLists(e2e);
  if (!Number.isInteger(shard) || shard < 1 || shard > lists.length)
    throw new Error(`there are ${lists.length} e2e runners; ${shard} is not one of them`);
  const own = lists[shard - 1]!.files;
  return shard === lists.length ? [...own, ...unlisted(e2e)] : own;
}

if (import.meta.main) {
  const e2e = import.meta.dirname;
  const problems = shardProblems(e2e);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  const shard = Number(process.argv[2]);
  const lists = shardLists(e2e);
  if (shard === lists.length)
    for (const file of unlisted(e2e))
      console.error(
        `Note: ${file} is in no list in e2e/shards/, so it runs here, on the last runner.`,
      );
  console.log(shardFiles(e2e, shard).join("\n"));
}
