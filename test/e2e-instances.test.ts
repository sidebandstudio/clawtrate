// The end-to-end run starts the instance with the computer plugin only when it can run the
// Computer tab's checks: every run with no file filter, and a run whose filters match them.
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { runIncludes } from "../e2e/run-record.ts";

const FILE = "e2e/work-computer.spec.ts";
const argv = (...args: string[]) => ["node", "playwright/cli.js", "test", ...args];

describe("which end-to-end runs start the computer instance", () => {
  it("every run without a file filter, sharded or grepped, may run the Computer checks", () => {
    expect(runIncludes(argv(), FILE)).toBe(true);
    expect(runIncludes(argv("--shard=1/3"), FILE)).toBe(true);
    expect(runIncludes(argv("-g", "F-027|F-323", "--repeat-each", "3"), FILE)).toBe(true);
  });

  it("a run of other files does not, and one naming the Computer spec does", () => {
    expect(runIncludes(argv("e2e/preview.spec.ts", "-g", "work-computer"), FILE)).toBe(false);
    expect(runIncludes(argv("e2e/preview.spec.ts", "e2e/rail-tasks.spec.ts"), FILE)).toBe(false);
    expect(runIncludes(argv("e2e/work-computer.spec.ts"), FILE)).toBe(true);
    expect(runIncludes(argv("work-computer"), FILE)).toBe(true);
  });

  it("an option's separate value is not read as a file filter", () => {
    expect(runIncludes(argv("--global-timeout", "900000"), FILE)).toBe(true);
    expect(runIncludes(argv("-G", "F-027", "work-computer"), FILE)).toBe(true);
    expect(runIncludes(argv("-G", "work-computer", "e2e/preview.spec.ts"), FILE)).toBe(false);
    expect(runIncludes(argv("--tsconfig", "tsconfig.json", "--browser", "chromium"), FILE)).toBe(
      true,
    );
    expect(runIncludes(argv("--project", "a", "b", "-g", "x"), FILE)).toBe(true);
    expect(runIncludes(argv("--shuffle", "--project", "a", "work-computer"), FILE)).toBe(true);
  });

  it("handles grouped short options and their attached or separate values", () => {
    const file = resolve(sep, FILE);
    expect(runIncludes(argv("-xj", "1"), file)).toBe(true);
    expect(runIncludes(argv("-x", "-j", "1"), file)).toBe(true);
    expect(runIncludes(argv("-xxj", "1"), file)).toBe(true);
    expect(runIncludes(argv("-xg", "work-computer", "preview.spec.ts"), file)).toBe(false);
    expect(runIncludes(argv("-xj1", "preview.spec.ts"), file)).toBe(false);
    expect(runIncludes(argv("-xu", "changed"), file)).toBe(true);
    expect(runIncludes(argv("-xuchanged", FILE), file)).toBe(true);
  });

  it("ignores arguments after the Playwright separator", () => {
    expect(runIncludes(argv("--", "run-label"), FILE)).toBe(true);
    expect(runIncludes(argv("preview.spec.ts", "--", FILE), FILE)).toBe(false);
  });

  it("matches the absolute spec path and Playwright's regular-expression flags", () => {
    const absolute = resolve(FILE).split(sep).join("/");
    const escaped = absolute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(runIncludes(argv(`^${escaped}$`), FILE)).toBe(true);
    expect(runIncludes(argv("WORK-COMPUTER"), FILE)).toBe(true);
    expect(runIncludes(argv("/WORK-COMPUTER/"), FILE)).toBe(false);
  });

  it("a file filter with a line, or a line and column, still names its file", () => {
    expect(runIncludes(argv("e2e/work-computer.spec.ts:42"), FILE)).toBe(true);
    expect(runIncludes(argv("work-computer.spec.ts:42:7"), FILE)).toBe(true);
    expect(runIncludes(argv("e2e/preview.spec.ts:42"), FILE)).toBe(false);
  });
});

describe("which end-to-end runs start the bot voice instance", () => {
  const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

  it("only the shard that runs its spec: the spec starts it, and global setup never does", () => {
    // CI names no file, only a shard, so every shard's command line may include any spec.
    expect(runIncludes(argv("--shard=3/3"), "e2e/bot-voice.spec.ts")).toBe(true);
    // So global setup can't tell, and starts no voice instance at all.
    expect(source("e2e/global-setup.ts")).not.toMatch(/clawtrate-voice|-voice`/);
    // The spec's beforeAll starts it, recorded first, and its afterAll resets it.
    const spec = source("e2e/bot-voice.spec.ts");
    const before = spec.slice(spec.indexOf("test.beforeAll("), spec.indexOf("test.afterAll("));
    const after = spec.slice(spec.indexOf("test.afterAll("));
    expect(spec).toMatch(/const INSTANCE = `e2e-\$\{record\.run\}-voice`;/);
    expect(before.indexOf("saveRecord(RECORDS, record)")).toBeGreaterThan(-1);
    expect(before.indexOf("saveRecord(RECORDS, record)")).toBeLessThan(
      before.indexOf('"--with-plugin", "clawtrate-voice"'),
    );
    expect(after).toContain("cleanUp(RECORDS, record, resetInstance)");
  });
});
