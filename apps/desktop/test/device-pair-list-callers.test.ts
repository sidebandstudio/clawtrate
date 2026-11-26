// Who sends `device.pair.list` (docs/design/setup-effortless.md §5, "The reads are ordered").
// The device approval engine numbers every send of it and applies every reply, so an older
// decision can't act after a newer reply from any of its paths. That holds only while its one
// function, `list()`, is the only place it sends the method: this reads the source of every
// package and app and fails for any other sender, so a new one is looked at on purpose.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** Each file allowed to send the method, how many times, and why. */
const SENDERS: Record<string, { count: number; why: string }> = {
  "packages/core/src/device-approval.ts": {
    count: 1,
    why: "`list()`, the one numbered send whose reply is applied",
  },
  "packages/core/src/machines.ts": {
    count: 4,
    why: "Settings, Machines: its own paired-device list, rename and removal; it never reads or decides waiting requests",
  },
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "test" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(path);
  }
  return out;
}

/**
 * A send of the method: a `request(` call naming it, the way every engine sends a gateway
 * method (`ctx.request`, `client.request`), however the call is wrapped across lines. A
 * comment's mention isn't one.
 */
const SEND = /\brequest\s*(?:<[^>]*>)?\(\s*["'`]device\.pair\.list["'`]/g;

describe("device.pair.list's senders", () => {
  it("are the approval engine's one numbered function, and the places listed with their reason", () => {
    const found: Record<string, number> = {};
    for (const top of ["packages", "apps"]) {
      for (const file of sources(join(root, top))) {
        const count = readFileSync(file, "utf8").match(SEND)?.length ?? 0;
        if (count > 0) found[relative(root, file)] = count;
      }
    }
    expect(found).toEqual(
      Object.fromEntries(Object.entries(SENDERS).map(([file, { count }]) => [file, count])),
    );
  });
});
