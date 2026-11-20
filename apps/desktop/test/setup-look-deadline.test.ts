// The look's own checks of files share the design's time limit (§4): a file
// check that never answers, as on a hung mount, ends the look as "can't tell"
// instead of keeping the person on "Finding OpenClaw".
import type * as FsPromises from "node:fs/promises";
import { expect, it, vi } from "vitest";

// Any path under a "hangs" folder never answers; every other check is the real one.
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof FsPromises>();
  const hangs = (path: unknown) => String(path).includes("/hangs/");
  return {
    ...fs,
    stat: (path: string) => (hangs(path) ? new Promise(() => {}) : fs.stat(path)),
  };
});

const { FILE_CHECK_MS, lookHere } = await import("../src/setup/look.ts");
import type { LookWorld } from "../src/setup/world.ts";

function world(values: Partial<LookWorld>): LookWorld {
  return {
    kind: "sandbox",
    platform: "darwin",
    home: "/nowhere/home",
    cwd: "/nowhere/home",
    candidates: [],
    profiles: [],
    env: {},
    serviceFiles: [],
    deep: false,
    portAllowed: () => false,
    ...values,
  };
}

it("a program search that never answers ends the look as can't tell, within the file checks' limit, and starts nothing", async () => {
  const run = vi.fn();
  const started = Date.now();
  const result = await lookHere(world({ candidates: ["/hangs/openclaw"] }), run);
  expect(result?.look).toMatchObject({ outcome: "cant-tell", reason: "timeout" });
  expect(Date.now() - started).toBeLessThan(FILE_CHECK_MS + 1_000);
  expect(run).not.toHaveBeenCalled();
});

it("a check for signs of OpenClaw that never answers ends the look as can't tell, and starts nothing", async () => {
  const run = vi.fn();
  const result = await lookHere(
    world({
      candidates: ["/nowhere/openclaw"],
      serviceFiles: ["/hangs/ai.openclaw.gateway.plist"],
    }),
    run,
  );
  expect(result?.look).toMatchObject({ outcome: "cant-tell", reason: "timeout" });
  expect(run).not.toHaveBeenCalled();
});
