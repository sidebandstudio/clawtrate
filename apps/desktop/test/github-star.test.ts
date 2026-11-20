import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { findGitHubCli, starRepository } from "../src/main/github-star.ts";
import { createDesktopBridge } from "../src/renderer/bridge-desktop.ts";
import type { DesktopHostApi } from "../src/preload/index.ts";

let dir: string;
let gh: string;
let log: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clawtrate-star-"));
  gh = join(dir, "gh");
  log = join(dir, "arguments");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { force: true, recursive: true });
});
function script(body: string) {
  writeFileSync(gh, "#!/bin/sh\n" + body, { mode: 0o700 });
}

it("F-521: discovery runs nothing and only the fixed command reaches the CLI on a click", async () => {
  vi.stubEnv("CLAWTRATE_TEST_UNRELATED", "unrelated");
  script(`test -z "$CLAWTRATE_TEST_UNRELATED" && test "$GH_PROMPT_DISABLED" = 1 || exit 1
printf '%s\\n' "$@" > "${log}"`);
  const found = findGitHubCli({ PATH: dir }, "linux");
  expect(found).toBe(gh);
  const bridge = await createDesktopBridge({
    hello: async () => ({ info: { canStarWithCli: true } }),
    onState: () => {},
    starWithCli: (...args: unknown[]) => {
      expect(args).toEqual([]);
      return starRepository(found);
    },
  } as unknown as DesktopHostApi);
  expect(existsSync(log)).toBe(false);
  expect(await Reflect.apply(bridge.starWithCli!, bridge, ["ignored"])).toBe(true);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    "api",
    "--method",
    "PUT",
    "/user/starred/sidebandstudio/clawtrate",
    "--hostname",
    "github.com",
    "--silent",
  ]);
});

it("F-521: a missing executable removes the action, and nonzero exit, timeout and spawn error fail", async () => {
  expect(findGitHubCli({ PATH: dir }, "linux")).toBeNull();
  const bridge = await createDesktopBridge({
    hello: async () => ({ info: { canStarWithCli: false } }),
    onState: () => {},
  } as unknown as DesktopHostApi);
  expect(bridge.starWithCli).toBeUndefined();
  expect(await starRepository(gh)).toBe(false);
  script("exit 2");
  expect(await starRepository(gh)).toBe(false);
  script("exec /bin/sleep 5");
  expect(await starRepository(gh, 30)).toBe(false);
});
