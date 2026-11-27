// `--install-plugin`: which plugins it takes, how it packs them, and what it says. The install
// itself is the engine's (packages/core/test/plugin-install.test.ts) and the e2e spec's
// (e2e/plugin-install.spec.ts).
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeOutcome, INSTALLABLE, packCarried } from "../src/install-plugin.ts";

const CHECKOUT = resolve(import.meta.dirname, "../../..");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("--install-plugin", () => {
  it("takes only the plugins the desktop app carries", () => {
    expect(INSTALLABLE).toEqual(["clawtrate-voice"]);
    for (const name of ["clawtrate-tool-rules", "clawtrate-bots", "../x"])
      expect(() => packCarried(CHECKOUT, "/nowhere", name)).toThrow(
        `--install-plugin takes clawtrate-voice, not ${JSON.stringify(name)}`,
      );
  });

  it("packs with the app's own packer, as its build does", () => {
    const dir = mkdtempSync(join(tmpdir(), "install-plugin-test-"));
    dirs.push(dir);
    const packed = packCarried(CHECKOUT, dir, "clawtrate-voice");
    expect(existsSync(packed.archive)).toBe(true);
    expect(packed.pin).toMatchObject({
      packageName: "@clawtrate/clawtrate-voice",
      pluginId: "clawtrate-voice",
      grants: { hooks: { allowConversationAccess: true } },
    });
    expect(packed.unrecorded).toBe(false);
  });

  it("says the digest a gateway reported and the one command that records it", () => {
    expect(
      describeOutcome("clawtrate-voice", "2026.11.10", {
        kind: "stopped",
        stop: "turned-off",
        mayBeRunning: false,
        reported: "a".repeat(64),
      }),
    ).toBe(
      `Didn't install clawtrate-voice: turned-off.\nThe gateway reported the source digest ${"a".repeat(64)}. If this packing is the one to ship, record it: node apps/desktop/packaging/carried-plugins.ts source-digest clawtrate-voice 2026.11.10 ${"a".repeat(64)}`,
    );
    expect(describeOutcome("clawtrate-voice", "2026.10.6", { kind: "enabled" })).toBe(
      "Installed clawtrate-voice on OpenClaw 2026.10.6: enabled and confirmed.",
    );
  });
});
