// CI runs each e2e shard with a list of files and nothing else on the command line, so global
// setup can't tell which specs its shard runs. A spec that needs a gateway instance of its own
// starts it in its own beforeAll, recorded first, and resets it in its afterAll: only the shard
// that runs the file starts it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

/** The spec's beforeAll and afterAll, as written. */
function hooks(file: string) {
  const spec = source(file);
  const start = spec.indexOf("test.beforeAll(");
  const end = spec.indexOf("test.afterAll(");
  expect(start, `${file} has a beforeAll`).toBeGreaterThan(-1);
  expect(end, `${file} has an afterAll after its beforeAll`).toBeGreaterThan(start);
  return { spec, before: spec.slice(start, end), after: spec.slice(end) };
}

describe.each([
  { file: "e2e/bot-voice.spec.ts", suffix: "voice", plugin: '"--with-plugin", "clawtrate-voice"' },
  {
    file: "e2e/work-computer.spec.ts",
    suffix: "computer",
    plugin: '"--with-plugin",\n      "clawtrate-computer"',
  },
])("which end-to-end runs start the $suffix instance", ({ file, suffix, plugin }) => {
  it("only the shard that runs its spec: the spec starts it, and global setup never does", () => {
    const setup = source("e2e/global-setup.ts");
    expect(setup).not.toContain(`-${suffix}\``);
    expect(setup).not.toMatch(new RegExp(`clawtrate-${suffix}\\b`));
    const { spec, before, after } = hooks(file);
    expect(spec).toContain(`= \`e2e-\${record.run}-${suffix}\`;`);
    // Recorded before it starts, and started in the beforeAll.
    expect(before.indexOf("saveRecord(RECORDS, record)")).toBeGreaterThan(-1);
    expect(before.indexOf(plugin)).toBeGreaterThan(before.indexOf("saveRecord(RECORDS, record)"));
    // Reset in the afterAll, with its record removed.
    expect(after).toContain("cleanUp(RECORDS, record, resetInstance)");
  });
});
