// Nothing may automate a packaged app without the sandbox switch: started
// with none of the markers, it is a person's app and looks at the real
// computer (docs/development/setup.md). Every launch of the packaged app the
// launch check makes carries `--clawtrate-setup-sandbox`.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launchArgs } from "../e2e-packaged/global-setup.ts";

const ROOT = join(import.meta.dirname, "..");

describe("the packaged app's launches", () => {
  it("always carry the sandbox switch, beside the data folder and the debugging port", () => {
    expect(launchArgs("/data", "/tmp/run/sandbox.json", "/checkout")).toEqual([
      "--user-data-dir=/data",
      "--remote-debugging-port=0",
      "--clawtrate-setup-sandbox=/tmp/run/sandbox.json",
      "--clawtrate-setup-checkout=/checkout",
    ]);
  });

  it("every spawn of the packaged executable in the launch check names a sandbox", () => {
    const folder = join(ROOT, "e2e-packaged");
    const launches: string[] = [];
    for (const file of readdirSync(folder).filter((name) => name.endsWith(".ts"))) {
      const lines = readFileSync(join(folder, file), "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!/spawn\(|gatedSpawn\(/.test(line)) return;
        const call = lines.slice(index, index + 8).join("\n");
        if (!/packagedExecutable\(|\bexe\b/.test(call)) return;
        launches.push(`${file}:${index + 1}`);
        expect(call, `${file}:${index + 1}`).toMatch(/launchArgs\(|--clawtrate-setup-sandbox=/);
      });
    }
    // The main launch, the Windows launch and the second launch.
    expect(launches.length).toBeGreaterThanOrEqual(3);
  });
});
