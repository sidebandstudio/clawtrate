// `--install-plugin`: which plugins it takes, how it packs them, and what it says. The install
// itself is the engine's (packages/core/test/plugin-install.test.ts) and the e2e spec's
// (e2e/plugin-install.spec.ts).
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  describeOutcome,
  INSTALLABLE,
  installPlugin,
  operatorContext,
  packCarried,
} from "../src/install-plugin.ts";
import type { OperatorSession } from "../src/operator.ts";
import type { PluginRecord } from "../../../packages/core/src/plugin-install.ts";
import {
  ARCHIVE,
  FakeGateway,
  ID,
  PIN,
  Refusal,
} from "../../../packages/core/test/plugin-gateway.ts";

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

  it("says when the plugin may still be running", () => {
    expect(
      describeOutcome("clawtrate-voice", "2026.10.6", {
        kind: "stopped",
        stop: "lost",
        mayBeRunning: true,
      }),
    ).toBe(
      "Didn't install clawtrate-voice: lost.\nIt may still be running: no read has shown it off since.",
    );
  });

  it("refuses the option before any command runs or any instance changes", () => {
    const cli = join(CHECKOUT, "tools/dev-gateway/src/cli.ts");
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    const prune = run("prune", "--install-plugin", "clawtrate-voice");
    expect(prune.status).toBe(1);
    expect(prune.stderr).toContain("--install-plugin is a start option; prune does not take it");
    const typo = run("start", "--instance", "never-made", "--install-plugin", "clawtrate-vioce");
    expect(typo.status).toBe(1);
    expect(typo.stderr).toContain('--install-plugin takes clawtrate-voice, not "clawtrate-vioce"');
    // Two Node processes start the tool's CLI, which takes more than Vitest's 5 s under load.
  }, 40_000);

  /** An operator session over the engine tests' stand-in gateway, one connection at a time. */
  function session(gateway: FakeGateway): OperatorSession {
    const fake = {
      generation: 1,
      serverVersion: gateway.version,
      events: [],
      waitFor: () => Promise.reject(new Error("no event")),
      requestOnce: (method: string, params: unknown) => gateway.request(method, params),
    };
    return fake as unknown as OperatorSession;
  }

  it("resumes an attempt it left, and never turns its stop into a fresh enable", async () => {
    const gateway = FakeGateway.at("2026.10.6", "off");
    const records = new Map<string, PluginRecord | null>([
      [
        ID,
        {
          mode: "install",
          integrity: PIN.integrity,
          step: 6,
          pending: 7,
          turningOff: false,
          sourceDigest: null,
          configHash: null,
        },
      ],
    ]);
    const packed = { pin: PIN, archive: ARCHIVE, unrecorded: false };
    const outcome = await installPlugin(session(gateway), packed, records);
    // A lost enable with the entry still off is a stop (#832): no Turn on after it.
    expect(outcome).toMatchObject({ kind: "stopped", stop: "listed-off" });
    expect(gateway.calls.some((c) => c.method === "plugins.setEnabled")).toBe(false);
  });

  it("tells the gateway's refusals from a request that wasn't answered", () => {
    const ctx = operatorContext(session(FakeGateway.at("2026.10.6", "fresh")), new Map());
    expect(ctx.answered(new Refusal({ message: "no", code: "INVALID_REQUEST" }))).toBe(true);
    expect(ctx.answered(new Error("not connected"))).toBe(false);
  });
});
