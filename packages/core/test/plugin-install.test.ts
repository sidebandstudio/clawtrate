// The install engine (packages/core/src/plugin-install.ts) against a stand-in gateway answering
// with each OpenClaw version's captured frames (plugin-gateway.ts). One test per row of
// docs/design/plugins-install.md's walk table (section 3.5), the four resume rules of issue #832,
// step 0, and the rules every attempt keeps: no uninstall, `allowlistPolicy: "preserve"` on every
// enable, no acknowledged install-policy warning, and an explicit `enabled: false` from the first
// write until the enable.

import { afterEach, describe, expect, it } from "vitest";
import {
  artifactProblem,
  PluginInstaller,
  type PluginOutcome,
  type PluginRecord,
} from "../src/plugin-install.ts";
import {
  ARCHIVE,
  committedError,
  contextFor,
  FakeGateway,
  ID,
  LOOKUP_FAILED,
  OTHER_ARCHIVE,
  OTHER_DIGEST,
  PIN,
  PIN_DIGEST,
  RESOURCES,
  TARBALLS,
  VERSIONS,
  type Version,
} from "./plugin-gateway.ts";

const gateways: FakeGateway[] = [];
const at = (version: Version, start: Parameters<typeof FakeGateway.at>[1]) => {
  const g = FakeGateway.at(version, start);
  gateways.push(g);
  return g;
};

// The rules every attempt keeps, whatever it did.
afterEach(() => {
  for (const g of gateways.splice(0)) {
    expect(
      g.calls.some((c) => c.method === "plugins.uninstall"),
      "never uninstalls",
    ).toBe(false);
    for (const c of g.calls.filter((c) => c.method === "plugins.setEnabled"))
      expect(c.params.allowlistPolicy, "every setEnabled preserves the allowlist").toBe("preserve");
    for (const c of g.calls.filter((c) => c.method === "plugins.install")) {
      expect(c.params.enable, "every stage is staged off").toBe(false);
      expect(c.params.acknowledgeInstallPolicyWarning).toBeUndefined();
      expect(c.params.acknowledgeCapabilities).toBeUndefined();
    }
    for (const c of g.calls.filter((c) => c.method === "config.patch")) {
      const raw = JSON.parse(String(c.params.raw)) as {
        plugins: {
          entries?: Record<string, { enabled?: unknown }>;
          allow?: unknown;
          deny?: unknown;
        };
      };
      expect(raw.plugins.allow, "never writes plugins.allow").toBeUndefined();
      expect(raw.plugins.deny, "never writes plugins.deny").toBeUndefined();
      expect(raw.plugins.entries?.[ID]?.enabled, "every patch says enabled: false").toBe(false);
    }
  }
});

/** The calls a write sends, with the parameters a security review reads. */
const writeLog = (g: FakeGateway) =>
  g.writes().map((c) => {
    if (c.method === "config.patch") return `config.patch ${String(c.params.raw)}`;
    if (c.method === "plugins.install")
      return `plugins.install ${JSON.stringify({ ...c.params, archivePath: "<tarball>" })}`;
    return `plugins.setEnabled ${JSON.stringify({ ...c.params, acknowledgeCapabilities: c.params.acknowledgeCapabilities ? "<reviewToken>" : undefined })}`;
  });

describe.each(VERSIONS)("on OpenClaw %s", (version) => {
  describe("the walk table", () => {
    it("row 1: installs, staged off, granted off, then enabled and confirmed", async () => {
      const g = at(version, "fresh");
      const ctx = contextFor(g);
      expect(await new PluginInstaller(ctx).install(PIN)).toEqual({
        kind: "enabled",
      });
      expect(writeLog(g)).toEqual([
        'config.patch {"plugins":{"entries":{"clawtrate-voice":{"enabled":false}}}}',
        'plugins.install {"source":"npm-pack","archivePath":"<tarball>","enable":false}',
        'config.patch {"plugins":{"entries":{"clawtrate-voice":{"enabled":false,"hooks":{"allowConversationAccess":true}}}}}',
        'plugins.setEnabled {"pluginId":"clawtrate-voice","enabled":true,"allowlistPolicy":"preserve","acknowledgeCapabilities":"<reviewToken>"}',
      ]);
      expect(g.shape()).toBe("ON+G");
      expect(g.loaded).toBe(true);
      // Its code ran once, and only after the enable: the last write.
      expect(g.ran).toEqual([PIN_DIGEST]);
      expect(ctx.records.get(ID)).toBeNull();
      // The review token step 7 acknowledged is the one plugins.inspect gave.
      const enable = g.calls.find((c) => c.method === "plugins.setEnabled")!;
      expect(enable.params.acknowledgeCapabilities).toEqual({ reviewToken: g.token });
    });

    it("row 2: Add again after an uninstall elsewhere left the entry OFF", async () => {
      const g = at(version, "uninstalled");
      const outcome = await new PluginInstaller(contextFor(g)).addAgain(PIN);
      expect(outcome).toEqual({ kind: "enabled" });
      expect(writeLog(g)[0]).toMatch(/^plugins\.install /);
      expect(g.shape()).toBe("ON+G");
    });

    it.each(["off", "off-no-grant"] as const)(
      "row 3: Turn on a listed plugin whose entry is %s",
      async (start) => {
        const g = at(version, start);
        expect(await new PluginInstaller(contextFor(g)).turnOn(PIN)).toEqual({
          kind: "enabled",
        });
        expect(g.writes().some((c) => c.method === "plugins.install")).toBe(false);
        expect(writeLog(g).at(-1)).toMatch(/"enabled":true/);
        expect(g.shape()).toBe("ON+G");
      },
    );

    it("row 4: an update the person asks for turns it off first, then stages the newer copy", async () => {
      const g = at(version, "older-on");
      expect(await new PluginInstaller(contextFor(g)).update(PIN)).toEqual({
        kind: "enabled",
      });
      expect(writeLog(g)).toEqual([
        'plugins.setEnabled {"pluginId":"clawtrate-voice","enabled":false,"allowlistPolicy":"preserve"}',
        'plugins.install {"source":"npm-pack","archivePath":"<tarball>","enable":false,"mode":"update"}',
        'plugins.setEnabled {"pluginId":"clawtrate-voice","enabled":true,"allowlistPolicy":"preserve","acknowledgeCapabilities":"<reviewToken>"}',
      ]);
      expect(g.staged?.version).toBe("0.1.0");
      // The new code never ran before the enable.
      expect(g.ran).toEqual([PIN_DIGEST]);
    });

    it("row 4: nothing updates by itself: an install finding an older copy leaves it", async () => {
      const g = at(version, "older-on");
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN);
      expect(outcome).toMatchObject({ kind: "stopped", stop: "other-copy" });
      expect(g.writes()).toEqual([]);
    });

    it("row 4: a newer copy than this app's pin is never touched, by install or update", async () => {
      // An app pinned to 0.1.0 meeting what a newer Clawtrate installed: never an older over a newer.
      const g = at(version, "on");
      g.staged = { version: "0.2.0", integrity: "sha512-newer", digest: "2".repeat(64) };
      const engine = new PluginInstaller(contextFor(g));
      expect(await engine.install(PIN)).toMatchObject({ stop: "other-copy" });
      expect(await engine.update(PIN)).toMatchObject({ stop: "other-copy" });
      expect(await engine.turnOn(PIN)).toMatchObject({ stop: "other-copy" });
      expect(g.writes()).toEqual([]);
      expect(g.staged.version).toBe("0.2.0");
    });

    it("row 4: an older copy this app never shipped is left as it is", async () => {
      const g = at(version, "older-on");
      const ctx = { ...contextFor(g), shipped: [] };
      const outcome = await new PluginInstaller(ctx).update(PIN);
      expect(outcome).toMatchObject({ kind: "stopped", stop: "other-copy" });
      expect(g.writes()).toEqual([]);
    });

    it("row 5a: a lost reply before the stage applied: off, and the lost write is never sent again", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.install", nth: 1, lose: "before" });
      const ctx = contextFor(g);
      const first = await new PluginInstaller(ctx).install(PIN);
      expect(first).toMatchObject({ kind: "stopped", stop: "lost", mayBeRunning: false });
      expect(g.shape()).toBe("OFF");
      expect(ctx.records.get(ID)).toMatchObject({ step: 2, pending: 3 });
      // The state its last step left, with a write lost on the way: that is also what another
      // device's Take it off leaves, so nothing is put back (3.3, "Resume").
      const before = g.writes().length;
      expect(await new PluginInstaller(ctx).resume(PIN)).toMatchObject({
        stop: "taken-off-elsewhere",
        mayBeRunning: false,
      });
      expect(g.writes()).toHaveLength(before);
      expect(ctx.records.get(ID)).toBeNull();
    });

    it("row 5b: a lost reply after the stage applied: the record finds it and goes on at step 4", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.install", nth: 1, lose: "after" });
      const ctx = contextFor(g);
      expect(await new PluginInstaller(ctx).install(PIN)).toMatchObject({
        stop: "lost",
      });
      expect(g.loaded).toBe(false);
      expect(await new PluginInstaller(ctx).resume(PIN)).toEqual({
        kind: "enabled",
      });
      // Staged once: the resume didn't stage again.
      expect(g.calls.filter((c) => c.method === "plugins.install")).toHaveLength(1);
    });

    it("row 5c: bots busy for five minutes after the stage: off, and resumes at step 4", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.inspect", nth: 1, before: (gw) => (gw.busy = true) });
      const ctx = contextFor(g);
      expect(await new PluginInstaller(ctx).install(PIN)).toMatchObject({
        stop: "bots-busy",
        mayBeRunning: false,
      });
      expect(ctx.slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(5 * 60_000);
      expect(g.shape()).toBe("OFF");
      g.busy = false;
      expect(await new PluginInstaller(ctx).resume(PIN)).toEqual({
        kind: "enabled",
      });
    });

    it("row 5d: a stage that isn't the app's copy stops at step 4, installed and off, nothing removed", async () => {
      const g = at(version, "fresh");
      // The gateway's copy is other bytes than the app's tarball.
      g.hooks.push({ method: "plugins.install", before: (gw) => void gw, answer: (a) => a });
      g.hooks.push({
        method: "plugins.inspect",
        before: (gw) => {
          gw.staged = { ...TARBALLS[OTHER_ARCHIVE]! };
        },
      });
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN);
      expect(outcome).toMatchObject({ kind: "stopped", stop: "mismatch", mayBeRunning: false });
      expect(g.shape()).toBe("OFF");
      expect(g.loaded).toBe(false);
      expect(g.ran).toEqual([]);
    });

    it("row 5e: a lost reply after the grant applied resumes at step 6", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "config.patch", nth: 2, lose: "after" });
      const ctx = contextFor(g);
      expect(await new PluginInstaller(ctx).install(PIN)).toMatchObject({
        stop: "lost",
        mayBeRunning: false,
      });
      expect(g.shape()).toBe("OFF+G");
      expect(g.loaded).toBe(false);
      expect(await new PluginInstaller(ctx).resume(PIN)).toEqual({
        kind: "enabled",
      });
      expect(g.calls.filter((c) => c.method === "config.patch")).toHaveLength(2);
    });

    it("row 5f: the state changed before the last check: a stop, nothing enabled", async () => {
      const g = at(version, "fresh");
      // An unrelated write by the owner that leaves a field of theirs in the entry.
      g.hooks.push({
        method: "plugins.inspect",
        nth: 2,
        before: (gw) => (gw.entry = { ...gw.entry, config: { mine: true } }),
      });
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN);
      expect(outcome).toMatchObject({ kind: "stopped", stop: "owner-settings" });
      expect(g.loaded).toBe(false);
    });

    it("row 5g: a lost step 7 reply that applied: off, then steps 6 and 7 again for the digest", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.setEnabled", nth: 1, lose: "after" });
      const ctx = contextFor(g);
      const first = await new PluginInstaller(ctx).install(PIN);
      // After step 7 the line says only that contact was lost, never that it is off.
      expect(first).toMatchObject({ kind: "stopped", stop: "lost", mayBeRunning: true });
      expect(g.loaded).toBe(true);
      expect(await new PluginInstaller(ctx).resume(PIN)).toEqual({
        kind: "enabled",
      });
      const sets = g.calls
        .filter((c) => c.method === "plugins.setEnabled")
        .map((c) => c.params.enabled);
      expect(sets).toEqual([true, false, true]);
    });

    it("row 5g: a second lost step 7 reply turns it off and stops", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.setEnabled", nth: 1, lose: "after" });
      g.hooks.push({ method: "plugins.setEnabled", nth: 3, lose: "after" });
      const ctx = contextFor(g);
      await new PluginInstaller(ctx).install(PIN);
      expect(await new PluginInstaller(ctx).resume(PIN)).toMatchObject({
        stop: "lost",
        mayBeRunning: false,
      });
      expect(g.loaded).toBe(false);
      expect(g.shape()).toBe("OFF+G");
      expect(ctx.records.get(ID)).toBeNull();
    });

    it("row 5h: step 8 finds a difference: turned off by the write that skips the checks", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "clawtrate-voice.get", answer: (a) => ({ ...a, version: "9.9.9" }) });
      const ctx = contextFor(g);
      const outcome = await new PluginInstaller(ctx).install(PIN);
      expect(outcome).toMatchObject({ kind: "stopped", stop: "turned-off", mayBeRunning: false });
      expect(g.shape()).toBe("OFF+G");
      expect(g.loaded).toBe(false);
      expect(ctx.records.get(ID)).toBeNull();
    });

    it("row 5h: a disable that doesn't apply is tried again, and the line says it may be running", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "clawtrate-voice.get", answer: (a) => ({ ...a, version: "9.9.9" }) });
      for (const nth of [2, 3, 4])
        g.hooks.push({ method: "plugins.setEnabled", nth, lose: "before" });
      const ctx = contextFor(g);
      expect(await new PluginInstaller(ctx).install(PIN)).toMatchObject({
        stop: "turned-off",
      });
      expect(ctx.slept.slice(0, 3)).toEqual([1_000, 2_000, 4_000]);
      expect(g.loaded).toBe(false);
    });

    it("row 6: a second device that finds the first one's OFF waits for plugins.changed, then shows it on", async () => {
      const g = at(version, "fresh");
      const a = contextFor(g);
      let aDone: Promise<unknown> = Promise.resolve();
      // B's plugins.changed comes when A's attempt ends.
      const b = { ...contextFor(g), changed: async () => (await aDone, true) };
      // Device B reads while A's attempt is between its off-first write and its enable.
      let bOutcome: Promise<unknown> | null = null;
      g.hooks.push({
        method: "plugins.install",
        nth: 1,
        before: () => {
          bOutcome = new PluginInstaller(b).install(PIN);
        },
      });
      const first = new PluginInstaller(a).install(PIN);
      aDone = first;
      expect(await first).toEqual({ kind: "enabled" });
      // B said nothing until A finished, then what it read: on.
      expect(await bOutcome).toMatchObject({ kind: "stopped", stop: "already-on" });
      expect(b.records.get(ID) ?? null).toBeNull();
      expect(g.calls.filter((c) => c.method === "plugins.install")).toHaveLength(1);
      // Read now, B shows it on.
      expect(await new PluginInstaller(b).install(PIN)).toMatchObject({
        stop: "already-on",
      });
    });

    it("row 6: on a stale base hash the second device goes back to step 1 and writes nothing more", async () => {
      const g = at(version, "fresh");
      // Another device writes the same off-first entry just before this one's patch.
      g.hooks.push({
        method: "config.patch",
        nth: 1,
        before: (gw) => ((gw.entry = { enabled: false }), (gw.hash += 1)),
      });
      const ctx = contextFor(g);
      const outcome = await new PluginInstaller(ctx).install(PIN);
      expect(outcome).toMatchObject({ kind: "stopped", stop: "not-listed-off" });
      expect(g.writes()).toHaveLength(1);
      expect(ctx.records.get(ID)).toBeNull();
    });

    it("row 7a: the owner denies it after step 1: a stop at the next read, nothing staged loads", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.inspect", nth: 1, before: (gw) => gw.deny.push(ID) });
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN);
      expect(outcome).toMatchObject({ stop: "owner-settings" });
      expect(g.loaded).toBe(false);
      expect(g.deny).toEqual([ID]);
      // Nothing written after the deny: the off-first patch and the stage only.
      expect(g.writes().map((c) => c.method)).toEqual(["config.patch", "plugins.install"]);
    });

    it("row 7b: the owner denies it between the last check and the enable: blocked, off", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.setEnabled", nth: 1, before: (gw) => gw.deny.push(ID) });
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN);
      expect(outcome).toMatchObject({ stop: "owner-settings" });
      expect(outcome).toHaveProperty("gateway", g.f.errors.blockedDeny.message);
      expect(g.loaded).toBe(false);
    });

    it("row 7b: an allowlist that leaves it out is kept, not widened", async () => {
      const g = at(version, "fresh");
      g.hooks.push({
        method: "plugins.setEnabled",
        nth: 1,
        before: (gw) => gw.allow.push("memory-core"),
      });
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN);
      expect(outcome).toMatchObject({
        stop: "owner-settings",
        gateway: g.f.errors.blockedAllow.message,
      });
      expect(g.allow).toEqual(["memory-core"]);
      expect(g.loaded).toBe(false);
    });

    it("row 7c: the owner writes enabled: true before the stage: Clawtrate stages nothing", async () => {
      const g = at(version, "fresh");
      g.hooks.push({
        method: "config.get",
        nth: 2,
        before: (gw) => (gw.entry = { enabled: true }),
      });
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN);
      expect(outcome).toMatchObject({ stop: "owner-turned-on" });
      expect(g.calls.some((c) => c.method === "plugins.install")).toBe(false);
    });

    it("row 7d: the owner turns it on after the stage: Clawtrate stops at step 4", async () => {
      const g = at(version, "fresh");
      g.hooks.push({
        method: "config.get",
        nth: 4,
        before: (gw) => {
          gw.entry = { enabled: true };
          gw.loaded = true;
        },
      });
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN);
      expect(outcome).toMatchObject({ stop: "owner-turned-on" });
      expect(g.calls.filter((c) => c.method === "plugins.inspect")).toHaveLength(0);
      expect(g.writes().filter((c) => c.method === "plugins.setEnabled")).toEqual([]);
    });

    it("row 7e: the owner revokes the grant before the enable: step 8 turns it off", async () => {
      const g = at(version, "fresh");
      g.hooks.push({
        method: "plugins.setEnabled",
        nth: 1,
        before: (gw) => (gw.entry = { enabled: false }),
      });
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN);
      expect(outcome).toMatchObject({ stop: "owner-settings", mayBeRunning: false });
      expect(g.loaded).toBe(false);
      expect(g.shape()).toBe("OFF");
    });

    it("row 7e: when the enable is answered 'already running', the read before it is sent again sees the revoked grant", async () => {
      const g = at(version, "fresh");
      g.hooks.push({
        method: "plugins.setEnabled",
        nth: 1,
        before: (gw) => (gw.entry = { enabled: false }),
        refuse: "busy",
      });
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN);
      expect(outcome).toMatchObject({ stop: "listed-off", mayBeRunning: false });
      expect(g.calls.filter((c) => c.method === "plugins.setEnabled")).toHaveLength(1);
      expect(g.ran).toEqual([]);
    });

    it("row 7f ⚠: the owner's enabled: false between the last check and the enable is enabled over (3.2)", async () => {
      const g = at(version, "fresh");
      g.hooks.push({
        method: "plugins.setEnabled",
        nth: 1,
        before: (gw) => (gw.entry = { ...gw.entry, enabled: false }),
      });
      // The owner's write changes nothing a client can see: the engine enables over it, the
      // design's one owner change it can't preserve without a gateway-side precondition.
      expect(await new PluginInstaller(contextFor(g)).install(PIN)).toEqual({
        kind: "enabled",
      });
    });

    it("row 7g: the owner uninstalls between the last check and the enable: Add again", async () => {
      const g = at(version, "fresh");
      g.hooks.push({
        method: "plugins.setEnabled",
        nth: 1,
        before: (gw) => {
          gw.staged = null;
          gw.entry = { enabled: false };
        },
      });
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN);
      expect(outcome).toMatchObject({
        stop: "not-listed-off",
        gateway: g.f.errors.notInstalled.message,
      });
    });

    it("row 8 ⚠: another admin replaces the stage before the enable: the other digest is turned off at once", async () => {
      const g = at(version, "fresh");
      g.hooks.push({
        method: "plugins.setEnabled",
        nth: 1,
        before: (gw) => (gw.staged = { ...TARBALLS[OTHER_ARCHIVE]! }),
      });
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN);
      expect(outcome).toMatchObject({ stop: "turned-off", mayBeRunning: false });
      // The replaced code ran once: this detects, it doesn't prevent (3.2).
      expect(g.ran).toEqual([OTHER_DIGEST]);
      expect(g.loaded).toBe(false);
    });

    it("row 5i: the gateway doesn't report the hook's grant in effect: no enable", async () => {
      // The one gateway report of the hook the plugin's code registers (its grant): a plugin
      // that isn't a bundle can't declare its hooks.
      const g = at(version, "fresh");
      g.hooks.push({
        method: "plugins.inspect",
        nth: 2,
        answer: (a) => ({
          ...a,
          grants: { hooks: { ...a.grants.hooks, allowConversationAccess: { effective: false } } },
        }),
      });
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN);
      expect(outcome).toMatchObject({ stop: "mismatch", mayBeRunning: false });
      expect(g.calls.some((c) => c.method === "plugins.setEnabled")).toBe(false);
      expect(g.loaded).toBe(false);
    });

    it("row 5i: the hook's grant not in effect after the enable: turned off", async () => {
      const g = at(version, "fresh");
      g.hooks.push({
        method: "plugins.inspect",
        nth: 3,
        answer: (a) => ({
          ...a,
          grants: { hooks: { ...a.grants.hooks, allowPromptInjection: { effective: false } } },
        }),
      });
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN);
      expect(outcome).toMatchObject({ stop: "turned-off", mayBeRunning: false });
      expect(g.loaded).toBe(false);
    });

    it("row 9: a gateway reached by its address gets nothing yet", async () => {
      const g = at(version, "fresh");
      const outcome = await new PluginInstaller(contextFor(g, { route: "other" })).install(PIN);
      expect(outcome).toMatchObject({ stop: "route" });
      expect(g.calls).toEqual([]);
    });
  });

  describe("the resume rules of #832", () => {
    it("1: after a lost step 7 reply, an entry still OFF+G is a stop, never a retry", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.setEnabled", nth: 1, lose: "before" });
      const ctx = contextFor(g);
      await new PluginInstaller(ctx).install(PIN);
      const before = g.writes().length;
      const outcome = await new PluginInstaller(ctx).resume(PIN);
      expect(outcome).toMatchObject({ kind: "stopped", stop: "listed-off", mayBeRunning: false });
      // Never a retry: the one write is the disable whose acceptance proves the lost enable is no
      // longer under way (3.3, "A lost enable").
      expect(writeLog(g).slice(before)).toEqual([
        'plugins.setEnabled {"pluginId":"clawtrate-voice","enabled":false,"allowlistPolicy":"preserve"}',
      ]);
      expect(g.loaded).toBe(false);
      expect(ctx.records.get(ID)).toBeNull();
    });

    it("2: step 7's digest is kept in the record, so a resume at step 8 has it", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.inspect", nth: 3, lose: "before" });
      const ctx = contextFor(g);
      expect(await new PluginInstaller(ctx).install(PIN)).toMatchObject({
        stop: "lost",
      });
      expect(ctx.records.get(ID)).toMatchObject({ step: 7, sourceDigest: PIN_DIGEST });
      expect(await new PluginInstaller(ctx).resume(PIN)).toEqual({
        kind: "enabled",
      });
      expect(g.calls.filter((c) => c.method === "plugins.setEnabled")).toHaveLength(1);
    });

    it("3: a resume at step 6 inspects again and acknowledges that inspect's review token", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "config.patch", nth: 2, lose: "after" });
      const ctx = contextFor(g);
      await new PluginInstaller(ctx).install(PIN);
      g.token = "f".repeat(64);
      expect(await new PluginInstaller(ctx).resume(PIN)).toEqual({
        kind: "enabled",
      });
      const enable = g.calls.find(
        (c) => c.method === "plugins.setEnabled" && c.params.enabled === true,
      )!;
      expect(enable.params.acknowledgeCapabilities).toEqual({ reviewToken: "f".repeat(64) });
    });

    it("4: a lost reply at Update's step 2 says the plugin may still be running", async () => {
      const g = at(version, "older-on");
      g.hooks.push({ method: "plugins.setEnabled", nth: 1, lose: "before" });
      const outcome = await new PluginInstaller(contextFor(g)).update(PIN);
      expect(outcome).toMatchObject({ kind: "stopped", stop: "lost", mayBeRunning: true });
      expect(g.loaded).toBe(true);
    });
  });

  describe("what the automated review found", () => {
    const record = (patch: Partial<PluginRecord>): PluginRecord => ({
      mode: "install",
      integrity: PIN.integrity,
      step: 1,
      pending: null,
      turningOff: false,
      sourceDigest: null,
      configHash: null,
      ...patch,
    });
    const withRecord = (g: FakeGateway, r: PluginRecord, options = {}) =>
      contextFor(g, { records: new Map([[ID, r]]), ...options });

    it("reads again before it sends a write the gateway asked to send later", async () => {
      const g = at(version, "fresh");
      // Refused as busy, and a bot starts a run during the wait.
      g.hooks.push({
        method: "plugins.setEnabled",
        nth: 1,
        before: (gw) => (gw.busy = true),
        refuse: "busy",
      });
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN);
      expect(outcome).toMatchObject({ stop: "bots-busy" });
      expect(g.calls.filter((c) => c.method === "plugins.setEnabled")).toHaveLength(1);
      expect(g.loaded).toBe(false);
    });

    it("clears the enable's in-flight mark when the gateway refused it and the retry stopped", async () => {
      // Ran on a real gateway: "already running" to the enable, the owner's deny during the wait.
      const g = at(version, "off");
      g.hooks.push({
        method: "plugins.setEnabled",
        nth: 1,
        before: (gw) => gw.deny.push(ID),
        refuse: "busy",
      });
      const ctx = contextFor(g);
      expect(await new PluginInstaller(ctx).turnOn(PIN)).toMatchObject({
        stop: "owner-settings",
        mayBeRunning: false,
      });
      expect(ctx.records.get(ID)).toMatchObject({ pending: null });
      // With the deny gone, Turn on goes on and enables: the refused enable isn't a lost one.
      g.deny = [];
      expect(await new PluginInstaller(ctx).turnOn(PIN)).toEqual({
        kind: "enabled",
      });
    });

    it("reads every page of sessions.list before it calls the gateway idle", async () => {
      const g = at(version, "fresh");
      g.sessionPages = [[{ key: "agent:main:a" }], [{ key: "agent:pip:b", hasActiveRun: true }]];
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN);
      expect(outcome).toMatchObject({ stop: "bots-busy" });
      expect(g.writes()).toEqual([]);
      const offsets = g.calls
        .filter((c) => c.method === "sessions.list")
        .map((c) => c.params.offset);
      expect(offsets).toContain(1);
    });

    it("keeps saying it may be running when a resume after a lost Update step 2 can't read", async () => {
      const g = at(version, "older-on");
      g.hooks.push({ method: "config.get", nth: 1, lose: "before" });
      const ctx = withRecord(g, record({ mode: "update", step: 1, pending: 2 }));
      const outcome = await new PluginInstaller(ctx).resume(PIN);
      expect(outcome).toMatchObject({ stop: "lost", mayBeRunning: true });
    });

    it("keeps a turning-off record until a read shows the plugin off", async () => {
      const g = at(version, "on");
      let epoch = 1;
      // The connection goes while the disable is on its way: no read shows the plugin off.
      g.hooks.push({ method: "plugins.setEnabled", nth: 1, before: () => (epoch = 2) });
      const ctx = withRecord(g, record({ step: 7, turningOff: true }), { epoch: () => epoch });
      expect(await new PluginInstaller(ctx).resume(PIN)).toMatchObject({
        stop: "lost",
        mayBeRunning: true,
      });
      expect(ctx.records.get(ID)).toMatchObject({ turningOff: true });
    });

    it("sends the disable only with a confirmed admin grant", async () => {
      const g = at(version, "on");
      let checks = 0;
      // Admin at step 0, gone by the time the disable would go.
      const ctx = withRecord(g, record({ step: 7, turningOff: true }), {
        admin: () => (checks += 1) === 1,
      });
      expect(await new PluginInstaller(ctx).resume(PIN)).toMatchObject({
        stop: "lost",
        mayBeRunning: true,
      });
      expect(g.writes()).toEqual([]);
      expect(ctx.records.get(ID)).toMatchObject({ turningOff: true });
    });

    it("never enables a third time after the second enable's reply was lost", async () => {
      const g = at(version, "on");
      const ctx = withRecord(g, record({ step: 6, pending: 7, again: true }));
      const outcome = await new PluginInstaller(ctx).resume(PIN);
      expect(outcome).toMatchObject({ stop: "turned-off", mayBeRunning: false });
      expect(g.writes().map((c) => c.params.enabled)).toEqual([false]);
      expect(g.loaded).toBe(false);
    });

    it("checks the installed copy is a shipped release again when it resumes an Update", async () => {
      const g = at(version, "older-on");
      // The owner replaced the shipped copy with another at the same version before the resume.
      g.staged = { ...g.staged!, integrity: "sha512-another" };
      const ctx = withRecord(
        g,
        record({ mode: "update", step: 1, pending: null, configHash: g.configHash }),
      );
      const outcome = await new PluginInstaller(ctx).resume(PIN);
      expect(outcome).toMatchObject({ stop: "other-copy" });
      expect(g.writes()).toEqual([]);
    });

    it("decides step 8 from reads taken after the plugin's own answer", async () => {
      const g = at(version, "fresh");
      g.hooks.push({
        method: "clawtrate-voice.get",
        before: (gw) => (gw.entry = { ...gw.entry, config: { mine: true } }),
      });
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN);
      expect(outcome).toMatchObject({ kind: "stopped", stop: "owner-settings" });
    });

    it("on a route the engine doesn't write on, sends nothing and takes it off later", async () => {
      const g = at(version, "on");
      const ctx = contextFor(g, { route: "other" });
      const outcome = await new PluginInstaller(ctx).takeOff(PIN);
      expect(outcome).toMatchObject({ stop: "taking-off-later", mayBeRunning: true });
      expect(g.calls).toEqual([]);
      expect(ctx.records.get(ID)).toMatchObject({ takingOff: true });
    });

    it("ends an attempt under way when the person takes the plugin off", async () => {
      const g = at(version, "off");
      const ctx = withRecord(g, record({ step: 4, pending: 5 }));
      expect(await new PluginInstaller(ctx).takeOff(PIN)).toEqual({ kind: "taken-off" });
      expect(ctx.records.get(ID)).toBeNull();
      // A later connection resumes nothing: the grant stays off.
      expect(await new PluginInstaller(ctx).resume(PIN)).toMatchObject({
        stop: "lost",
      });
      expect(g.loaded).toBe(false);
      expect(g.shape()).toBe("OFF");
    });

    it("a resume at step 7 inspects again and acknowledges that inspect's token (#832, 3)", async () => {
      const g = at(version, "off");
      g.token = "d".repeat(64);
      const ctx = withRecord(g, record({ step: 6, pending: null, configHash: g.configHash }));
      expect(await new PluginInstaller(ctx).resume(PIN)).toEqual({
        kind: "enabled",
      });
      const enable = g.calls.find((c) => c.method === "plugins.setEnabled" && c.params.enabled)!;
      expect(enable.params.acknowledgeCapabilities).toEqual({ reviewToken: "d".repeat(64) });
      const before = g.calls.findIndex((c) => c === enable);
      expect(g.calls.slice(0, before).some((c) => c.method === "plugins.inspect")).toBe(true);
    });
  });

  describe("step 0 and the gateway's own answers", () => {
    it("writes nothing without a confirmed admin grant, and asks for none", async () => {
      const g = at(version, "fresh");
      const outcome = await new PluginInstaller(contextFor(g, { admin: () => false })).install(PIN);
      expect(outcome).toMatchObject({ stop: "no-admin" });
      expect(g.calls).toEqual([]);
    });

    it("stops mid-sequence when the grant goes", async () => {
      const g = at(version, "fresh");
      let admin = true;
      g.hooks.push({ method: "plugins.inspect", nth: 1, before: () => (admin = false) });
      const outcome = await new PluginInstaller(contextFor(g, { admin: () => admin })).install(PIN);
      expect(outcome).toMatchObject({ stop: "no-admin" });
      expect(g.loaded).toBe(false);
    });

    it("installs nothing on an OpenClaw version the pin has no source digest for", async () => {
      const g = at(version, "fresh");
      const ctx = contextFor(g, { serverVersion: "2026.12.1" });
      expect(await new PluginInstaller(ctx).install(PIN)).toMatchObject({
        stop: "openclaw-version",
      });
      expect(g.calls).toEqual([]);
    });

    it("runs over SSH as on this computer", async () => {
      const g = at(version, "fresh");
      expect(await new PluginInstaller(contextFor(g, { route: "ssh" })).install(PIN)).toEqual({
        kind: "enabled",
      });
    });

    it("an entry already enabled: true for a plugin not yet staged is the owner's: nothing staged (3.1)", async () => {
      const g = at(version, "fresh");
      g.entry = { enabled: true };
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN);
      expect(outcome).toMatchObject({ stop: "owner-turned-on" });
      expect(g.writes()).toEqual([]);
    });

    it("a stage whose answer says its code ran is turned off at once", async () => {
      const g = at(version, "fresh");
      g.hooks.push({
        method: "plugins.install",
        // The grant written beside the stage with `enabled` unset, which loads it on both versions.
        before: (gw) => (gw.entry = { hooks: { allowConversationAccess: true } }),
      });
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN);
      expect(outcome).toMatchObject({ kind: "stopped", stop: "turned-off" });
      expect(g.ran).toEqual([PIN_DIGEST]);
      expect(g.loaded).toBe(false);
    });

    it("waits out the gateway's own 'already running', then goes on", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.setEnabled", nth: 1, refuse: "busy" });
      const ctx = contextFor(g);
      expect(await new PluginInstaller(ctx).install(PIN)).toEqual({
        kind: "enabled",
      });
      expect(ctx.slept).toContain(g.f.errors.busy.retryAfterMs);
    });

    it("stops after three answers of 'already running'", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.install", refuse: "busy" });
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN);
      expect(outcome).toMatchObject({ stop: "gateway-busy", mayBeRunning: false });
      expect(g.calls.filter((c) => c.method === "plugins.install")).toHaveLength(3);
    });

    it.each([
      ["alreadyExists", "another-device"],
      ["missingArchive", "refused"],
    ])("a stage the gateway refuses (%s) stops, off", async (refusal, stop) => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.install", refuse: refusal });
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN);
      expect(outcome).toMatchObject({
        stop,
        gateway: g.f.errors[refusal].message,
        mayBeRunning: false,
      });
      expect(g.shape()).toBe("OFF");
    });

    it("an install-policy warning is a stop, never acknowledged", async () => {
      const g = at(version, "fresh");
      g.hooks.push({
        method: "plugins.install",
        refuse: {
          message: "install_policy_warning_acknowledgement_required: the policy warned",
          code: "INVALID_REQUEST",
        },
      });
      expect(await new PluginInstaller(contextFor(g)).install(PIN)).toMatchObject({
        stop: "policy-warning",
      });
      expect(g.calls.filter((c) => c.method === "plugins.install")).toHaveLength(1);
    });

    it("a refusal of local artifacts is the route by address", async () => {
      const g = at(version, "fresh");
      g.hooks.push({
        method: "plugins.install",
        refuse: {
          message: "Local plugin artifacts require a connection from the Gateway host.",
          code: "INVALID_REQUEST",
        },
      });
      expect(await new PluginInstaller(contextFor(g)).install(PIN)).toMatchObject({
        stop: "route",
      });
    });

    it("one attempt at a time on a device", async () => {
      const g = at(version, "fresh");
      const engine = new PluginInstaller(contextFor(g));
      const [a, b] = await Promise.all([engine.install(PIN), engine.install(PIN)]);
      expect(a).toEqual({ kind: "enabled" });
      expect(b).toMatchObject({ stop: "in-progress" });
    });

    it("an attempt whose connection changed sends nothing more", async () => {
      const g = at(version, "fresh");
      let epoch = 1;
      g.hooks.push({ method: "plugins.inspect", nth: 1, before: () => (epoch = 2) });
      const outcome = await new PluginInstaller(contextFor(g, { epoch: () => epoch })).install(PIN);
      expect(outcome).toMatchObject({ stop: "connection-changed" });
      expect(g.writes().map((c) => c.method)).toEqual(["config.patch", "plugins.install"]);
    });
  });

  describe("what the independent review found", () => {
    const record = (patch: Partial<PluginRecord>): PluginRecord => ({
      mode: "install",
      integrity: PIN.integrity,
      step: 1,
      pending: null,
      turningOff: false,
      sourceDigest: null,
      configHash: null,
      ...patch,
    });
    const withRecord = (g: FakeGateway, r: PluginRecord, options = {}) =>
      contextFor(g, { records: new Map([[ID, r]]), ...options });
    const DISABLE =
      'plugins.setEnabled {"pluginId":"clawtrate-voice","enabled":false,"allowlistPolicy":"preserve"}';

    // 1. An answered error is no proof a change didn't apply.
    it("an error answered after the enable committed: the read that shows it on turns it off", async () => {
      const g = at(version, "fresh");
      g.hooks.push({
        method: "plugins.setEnabled",
        nth: 1,
        refuseAfter: committedError(PIN_DIGEST),
      });
      const ctx = contextFor(g);
      const outcome = await new PluginInstaller(ctx).install(PIN);
      expect(outcome).toMatchObject({ kind: "stopped", stop: "refused", mayBeRunning: false });
      expect(g.loaded).toBe(false);
      expect(g.shape()).toBe("OFF+G");
      expect(writeLog(g).at(-1)).toBe(DISABLE);
      expect(ctx.records.get(ID)).toBeNull();
    });

    it("an error answered after the enable, then no read: the mark and the warning stay", async () => {
      const g = at(version, "fresh");
      g.hooks.push({
        method: "plugins.setEnabled",
        nth: 1,
        refuseAfter: committedError(PIN_DIGEST),
        before: (gw) => gw.hooks.unshift({ method: "config.get", lose: "before" }),
      });
      const ctx = contextFor(g);
      const outcome = await new PluginInstaller(ctx).install(PIN);
      expect(outcome).toMatchObject({ kind: "stopped", stop: "lost", mayBeRunning: true });
      expect(ctx.records.get(ID)).toMatchObject({ pending: 7 });
    });

    it("an error answered after Update's disable committed: the read shows it off, and it goes on", async () => {
      const g = at(version, "older-on");
      g.hooks.push({
        method: "plugins.setEnabled",
        nth: 1,
        // After a disable the change leaves nothing loaded: empty runtime maps, and the lookup
        // that failed after it.
        refuseAfter: committedError(null, LOOKUP_FAILED),
      });
      expect(await new PluginInstaller(contextFor(g)).update(PIN)).toEqual({
        kind: "enabled",
      });
      expect(g.staged?.version).toBe("0.1.0");
    });

    it.each([
      ["a pending enable", { step: 6, pending: 7 }],
      ["a stage under way", { step: 3 }],
    ])(
      "a resume of %s that reads it active in a shape it didn't confirm keeps the record and the warning",
      async (_, patch) => {
        const g = at(version, "on");
        g.entry = {
          enabled: true,
          hooks: { allowConversationAccess: true },
          config: { tone: "dry" },
        };
        const ctx = withRecord(g, record(patch));
        const outcome = await new PluginInstaller(ctx).resume(PIN);
        expect(outcome).toMatchObject({ stop: "owner-turned-on", mayBeRunning: true });
        expect(ctx.records.get(ID)).toMatchObject(patch);
        expect(g.writes()).toEqual([]);
      },
    );

    it("another pin's record that may have left it running is finished first: turned off, then dropped", async () => {
      const g = at(version, "on");
      const ctx = withRecord(
        g,
        record({ integrity: "sha512-an-earlier-pin", step: 6, pending: 7 }),
      );
      const outcome = await new PluginInstaller(ctx).install(PIN);
      expect(writeLog(g)[0]).toBe(DISABLE);
      expect(g.loaded).toBe(false);
      expect(outcome).toMatchObject({ kind: "stopped", mayBeRunning: false });
      expect(ctx.records.get(ID) ?? null).toBeNull();
    });

    it("another pin's record whose plugin won't turn off is kept, and says it may be running", async () => {
      const g = at(version, "on");
      g.hooks.push({ method: "plugins.setEnabled", lose: "before" });
      const ctx = withRecord(g, record({ integrity: "sha512-an-earlier-pin", step: 7 }));
      const outcome = await new PluginInstaller(ctx).install(PIN);
      expect(outcome).toMatchObject({ stop: "lost", mayBeRunning: true });
      expect(ctx.records.get(ID)).toMatchObject({
        integrity: "sha512-an-earlier-pin",
        turningOff: true,
      });
    });

    // 2. Take it off cancels the installation, durably.
    it("Take it off during an attempt: the attempt stops at its next check, then the take-off runs", async () => {
      const g = at(version, "fresh");
      const ctx = contextFor(g);
      const engine = new PluginInstaller(ctx);
      let takeOff: Promise<PluginOutcome> | undefined;
      g.hooks.push({
        method: "plugins.install",
        nth: 1,
        before: () => (takeOff = engine.takeOff(PIN)),
      });
      expect(await engine.install(PIN)).toMatchObject({ stop: "cancelled" });
      expect(await takeOff).toEqual({ kind: "taken-off" });
      expect(g.shape()).toBe("OFF");
      expect(g.loaded).toBe(false);
      expect(ctx.records.get(ID)).toBeNull();
      // Nothing resumes the install.
      expect(await engine.resume(PIN)).toMatchObject({ stop: "lost" });
      expect(g.writes().some((c) => c.params.enabled === true)).toBe(false);
    });

    it("Take it off after an interrupted install whose grant removal is lost: a resume finishes the take-off, never the install", async () => {
      const g = at(version, "off");
      const ctx = withRecord(g, record({ step: 5 }));
      g.hooks.push({ method: "config.patch", nth: 1, lose: "before" });
      const engine = new PluginInstaller(ctx);
      expect(await engine.takeOff(PIN)).toMatchObject({ stop: "lost", mayBeRunning: false });
      expect(ctx.records.get(ID)).toMatchObject({ takingOff: true });
      expect(await engine.resume(PIN)).toEqual({ kind: "taken-off" });
      expect(g.writes().some((c) => c.params.enabled === true)).toBe(false);
      expect(g.shape()).toBe("OFF");
      expect(ctx.records.get(ID)).toBeNull();
    });

    it("Take it off never deletes hook settings it didn't read under the hash it sends", async () => {
      const g = at(version, "off");
      // The owner sets the plugin's hooks after Clawtrate's check of the entry.
      g.hooks.push({
        method: "config.get",
        nth: 3,
        before: (gw) => {
          gw.entry = {
            enabled: false,
            hooks: { allowConversationAccess: true, allowPromptInjection: false },
          };
          gw.hash += 1;
        },
      });
      const outcome = await new PluginInstaller(contextFor(g)).takeOff(PIN);
      expect(g.entry?.hooks).toEqual({
        allowConversationAccess: true,
        allowPromptInjection: false,
      });
      expect(outcome).toMatchObject({ stop: "owner-settings" });
    });

    it("Take it off waits while a run goes, and stops with its record kept", async () => {
      const g = at(version, "on");
      g.busy = true;
      const ctx = contextFor(g);
      expect(await new PluginInstaller(ctx).takeOff(PIN)).toMatchObject({
        stop: "bots-busy",
        mayBeRunning: true,
      });
      expect(g.writes()).toEqual([]);
      expect(ctx.records.get(ID)).toMatchObject({ takingOff: true });
    });

    it("a call during an attempt says what the attempt knows: may be running after its enable", async () => {
      const g = at(version, "fresh");
      const engine = new PluginInstaller(contextFor(g));
      let during: Promise<PluginOutcome> | undefined;
      g.hooks.push({
        method: "clawtrate-voice.get",
        nth: 1,
        before: () => (during = engine.install(PIN)),
      });
      expect(await engine.install(PIN)).toEqual({ kind: "enabled" });
      expect(await during).toMatchObject({ stop: "in-progress", mayBeRunning: true });
    });

    // 3. Only a carried pin, and a tarball the host checked.
    it("refuses another plugin's pin, even one the host's list names, before any gateway call", async () => {
      const g = at(version, "fresh");
      const pin = { ...PIN, pluginId: "clawtrate-tool-rules" };
      const engine = new PluginInstaller(contextFor(g, { carried: [PIN, pin] }));
      for (const outcome of [
        await engine.install(pin),
        await engine.update(pin),
        await engine.resume(pin),
        await engine.takeOff(pin),
      ])
        expect(outcome).toMatchObject({ stop: "not-carried" });
      expect(g.calls).toEqual([]);
    });

    it.each([
      ["another version", { version: "0.2.0" }],
      ["another integrity", { integrity: "sha512-other" }],
      ["another grant", { grants: { hooks: { allowConversationAccess: true, extra: true } } }],
    ])(
      "refuses a pin that isn't the carried list's (%s) before any gateway call",
      async (_, patch) => {
        const g = at(version, "fresh");
        const pin = { ...PIN, ...patch };
        const engine = new PluginInstaller(contextFor(g));
        expect(await engine.install(pin)).toMatchObject({ stop: "not-carried" });
        expect(await engine.takeOff(pin)).toMatchObject({ stop: "not-carried" });
        expect(g.calls).toEqual([]);
      },
    );

    it.each([
      ["a relative path", { path: "plugins/clawtrate-clawtrate-voice-0.1.0.tgz" }],
      ["a parent step", { path: `${RESOURCES}/../other/clawtrate-clawtrate-voice-0.1.0.tgz` }],
      ["a path outside the resources", { path: "/tmp/clawtrate-clawtrate-voice-0.1.0.tgz" }],
      ["the resources folder itself", { path: RESOURCES }],
      ["other bytes", { integrity: TARBALLS[OTHER_ARCHIVE]!.integrity }],
    ])("refuses the host's tarball with %s before anything is written", async (_, patch) => {
      const g = at(version, "fresh");
      const ctx = contextFor(g, {
        artifact: async () => ({
          path: ARCHIVE,
          root: RESOURCES,
          integrity: PIN.integrity,
          ...patch,
        }),
      });
      expect(await new PluginInstaller(ctx).install(PIN)).toMatchObject({
        stop: "artifact",
        mayBeRunning: false,
      });
      expect(g.writes()).toEqual([]);
    });

    it("refuses a tarball the host can't read", async () => {
      const g = at(version, "fresh");
      const ctx = contextFor(g, {
        artifact: async () => {
          throw new Error("EACCES: permission denied");
        },
      });
      expect(await new PluginInstaller(ctx).install(PIN)).toMatchObject({
        stop: "artifact",
        gateway: "EACCES: permission denied",
      });
      expect(g.writes()).toEqual([]);
    });

    it("checks the host's tarball again at the stage: changed since step 0, nothing is staged", async () => {
      const g = at(version, "fresh");
      let checks = 0;
      const ctx = contextFor(g, {
        artifact: async () => ({
          path: ARCHIVE,
          root: RESOURCES,
          integrity: (checks += 1) === 1 ? PIN.integrity : "sha512-changed-since",
        }),
      });
      expect(await new PluginInstaller(ctx).install(PIN)).toMatchObject({
        stop: "artifact",
      });
      expect(writeLog(g)).toEqual([
        'config.patch {"plugins":{"entries":{"clawtrate-voice":{"enabled":false}}}}',
      ]);
      expect(g.shape()).toBe("OFF");
    });

    it("a stage of another package than the host checked is a mismatch, never turned on or off", async () => {
      const g = at(version, "fresh");
      g.hooks.push({
        method: "plugins.install",
        nth: 1,
        answer: (a) => ({
          ...a,
          plugin: { ...a.plugin, id: "other-plugin", packageName: "other" },
        }),
      });
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN);
      expect(outcome).toMatchObject({ stop: "mismatch", mayBeRunning: false });
      expect(g.writes().filter((c) => c.method === "plugins.setEnabled")).toEqual([]);
    });

    // 4. Every run a read can show.
    it("a routine's run, which no sessions page lists, holds every write", async () => {
      const g = at(version, "fresh");
      g.routineRunning = true;
      expect(await new PluginInstaller(contextFor(g)).install(PIN)).toMatchObject({
        stop: "bots-busy",
      });
      expect(g.writes()).toEqual([]);
      expect(g.calls.find((c) => c.method === "cron.list")!.params).toMatchObject({
        includeDisabled: true,
        compact: true,
      });
      expect(g.calls.find((c) => c.method === "sessions.list")!.params).toMatchObject({
        includeGlobal: true,
        includeUnknown: true,
      });
    });

    it("reads every page of the routines before it calls the gateway idle", async () => {
      const g = at(version, "fresh");
      g.routinePages = [
        [{ id: "a", name: "A", enabled: true }],
        [{ id: "b", name: "B", enabled: false, runningAtMs: 1_795_800_000_000 }],
      ];
      expect(await new PluginInstaller(contextFor(g)).install(PIN)).toMatchObject({
        stop: "bots-busy",
      });
      expect(g.writes()).toEqual([]);
    });

    it.each(["sessions.list", "cron.list"])(
      "a %s page that says there are more without saying where is busy",
      async (method) => {
        const g = at(version, "fresh");
        g.hooks.push({ method, answer: (a) => ({ ...a, hasMore: true, nextOffset: null }) });
        expect(await new PluginInstaller(contextFor(g)).install(PIN)).toMatchObject({
          stop: "bots-busy",
        });
        expect(g.writes()).toEqual([]);
      },
    );
  });

  describe("what the confirming review found", () => {
    const record = (patch: Partial<PluginRecord>): PluginRecord => ({
      mode: "install",
      integrity: PIN.integrity,
      step: 1,
      pending: null,
      turningOff: false,
      sourceDigest: null,
      configHash: null,
      ...patch,
    });
    const withRecord = (g: FakeGateway, r: PluginRecord, options = {}) =>
      contextFor(g, { records: new Map([[ID, r]]), ...options });
    const enables = (g: FakeGateway) =>
      g.calls.filter((c) => c.method === "plugins.setEnabled" && c.params.enabled === true);
    const settle = () => new Promise<void>((done) => setTimeout(() => done(), 0));

    // 1. Take it off holds in every case.
    it("Take it off without full control is saved first, and the next connection finishes it, never the install", async () => {
      const g = at(version, "off");
      let admin = false;
      const ctx = withRecord(g, record({ step: 4, pending: 5 }), { admin: () => admin });
      expect(await new PluginInstaller(ctx).takeOff(PIN)).toMatchObject({
        stop: "taking-off-later",
      });
      expect(g.calls).toEqual([]);
      expect(ctx.records.get(ID)).toMatchObject({ takingOff: true });
      admin = true;
      expect(await new PluginInstaller(ctx).resume(PIN)).toEqual({ kind: "taken-off" });
      expect(enables(g)).toEqual([]);
      expect(g.shape()).toBe("OFF");
    });

    it("an exit while the attempt's write is unanswered keeps the take-off, and the next run finishes it", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.install", nth: 1, hang: true });
      const records = new Map<string, PluginRecord | null>();
      const first = new PluginInstaller(contextFor(g, { records }));
      void first.install(PIN);
      await settle();
      void first.takeOff(PIN);
      await settle();
      // The process ends here: only the record is left.
      expect(records.get(ID)).toMatchObject({ takingOff: true });
      const next = new PluginInstaller(contextFor(g, { records, epoch: () => 2 }));
      expect(await next.resume(PIN)).toEqual({ kind: "nothing-installed" });
      expect(enables(g)).toEqual([]);
      expect(records.get(ID)).toBeNull();
    });

    it("another device's completed Take it off is never undone by this device's resume", async () => {
      const g = at(version, "fresh");
      // This device's grant applies and its reply is lost.
      g.hooks.push({ method: "config.patch", nth: 2, lose: "after" });
      const mine = contextFor(g);
      expect(await new PluginInstaller(mine).install(PIN)).toMatchObject({ stop: "lost" });
      expect(mine.records.get(ID)).toMatchObject({ step: 4, pending: 5 });
      // The other device, with a record store of its own, takes it off.
      expect(await new PluginInstaller(contextFor(g)).takeOff(PIN)).toEqual({ kind: "taken-off" });
      const before = g.writes().length;
      expect(await new PluginInstaller(mine).resume(PIN)).toMatchObject({
        stop: "taken-off-elsewhere",
      });
      expect(g.writes()).toHaveLength(before);
      expect(g.shape()).toBe("OFF");
      expect(mine.records.get(ID)).toBeNull();
    });

    it("Take it off before any package exists says nothing was installed", async () => {
      const g = at(version, "fresh");
      const ctx = contextFor(g);
      expect(await new PluginInstaller(ctx).takeOff(PIN)).toEqual({ kind: "nothing-installed" });
      expect(g.writes()).toEqual([]);
      expect(ctx.records.get(ID)).toBeNull();
    });

    // 2. An unresolved enable is never reported off, and its record is never lost.
    it.each([
      ["no full control", { admin: () => false }, "no-admin"],
      ["an unsupported version", { serverVersion: "2026.1.1" }, "openclaw-version"],
      [
        "an unreadable tarball",
        {
          artifact: async () => {
            throw new Error("EACCES");
          },
        },
        "artifact",
      ],
    ])(
      "a pending enable with %s says it may be running and keeps its record",
      async (_, options, stop) => {
        const g = at(version, "on");
        const ctx = withRecord(g, record({ step: 6, pending: 7 }), options);
        expect(await new PluginInstaller(ctx).resume(PIN)).toMatchObject({
          stop,
          mayBeRunning: true,
        });
        expect(ctx.records.get(ID)).toMatchObject({ pending: 7 });
      },
    );

    it("a turning-off record goes on with no tarball and no supported version", async () => {
      const g = at(version, "on");
      const ctx = withRecord(g, record({ step: 7, turningOff: true }), {
        serverVersion: "2026.1.1",
        artifact: async () => {
          throw new Error("EACCES");
        },
      });
      expect(await new PluginInstaller(ctx).resume(PIN)).toMatchObject({
        stop: "turned-off",
        mayBeRunning: false,
      });
      expect(g.loaded).toBe(false);
    });

    it("an enable still under way after its reply timed out can't publish once the record goes", async () => {
      const g = at(version, "off");
      // The read shows it off; the enable holds the lease through the first change sent after
      // it, which is refused while every read still shows it off, then publishes.
      g.delayedEnable = true;
      g.delayedRefusals = 1;
      const ctx = withRecord(g, record({ step: 6, pending: 7 }));
      expect(await new PluginInstaller(ctx).resume(PIN)).toMatchObject({
        stop: "listed-off",
        mayBeRunning: false,
      });
      g.finishDelayed();
      expect(g.loaded).toBe(false);
      expect(ctx.records.get(ID)).toBeNull();
    });

    it("a pending enable whose listing is service-failed under an entry that says off keeps its record", async () => {
      const g = at(version, "off");
      g.runtimeState = "service-failed";
      const ctx = withRecord(g, record({ step: 6, pending: 7 }));
      expect(await new PluginInstaller(ctx).resume(PIN)).toMatchObject({ mayBeRunning: true });
      expect(ctx.records.get(ID)).toMatchObject({ pending: 7 });
    });

    it("Take it off never reports a service-failed plugin taken off", async () => {
      const g = at(version, "off");
      g.runtimeState = "service-failed";
      const outcome = await new PluginInstaller(contextFor(g)).takeOff(PIN);
      expect(outcome).toMatchObject({ kind: "stopped", mayBeRunning: true });
    });

    it("an enable the owner's deny refused ends its attempt, and the person's Turn on starts afresh", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.setEnabled", nth: 1, before: (gw) => gw.deny.push(ID) });
      const ctx = contextFor(g);
      const engine = new PluginInstaller(ctx);
      expect(await engine.install(PIN)).toMatchObject({ stop: "owner-settings" });
      expect(ctx.records.get(ID)).toBeNull();
      // The owner lifts the deny, which moves the config hash; Turn on is the person's own.
      g.deny = [];
      g.hash += 1;
      expect(await engine.turnOn(PIN)).toEqual({ kind: "enabled" });
    });

    // 3. The stage sends the archive it just checked.
    it("a tarball changed during the stage's idle wait is refused before the send", async () => {
      const g = at(version, "fresh");
      let changed = false;
      // A run starts with the off-first write and ends during the wait.
      g.hooks.push({ method: "config.patch", nth: 1, before: (gw) => (gw.busy = true) });
      const ctx = contextFor(g, {
        artifact: async () => ({
          path: ARCHIVE,
          root: RESOURCES,
          integrity: changed ? "sha512-changed-during-the-wait" : PIN.integrity,
        }),
      });
      ctx.sleep = async () => {
        changed = true;
        g.busy = false;
      };
      expect(await new PluginInstaller(ctx).install(PIN)).toMatchObject({ stop: "artifact" });
      expect(g.calls.some((c) => c.method === "plugins.install")).toBe(false);
    });

    // 4. Step 8 sends only the fixed method, and the pin is a snapshot.
    it("a confirmation the caller substitutes never reaches the gateway", async () => {
      const g = at(version, "fresh");
      const engine = new PluginInstaller(contextFor(g)) as unknown as {
        install(pin: unknown, confirm: unknown): Promise<unknown>;
      };
      const other = { method: "agents.files.get", params: { agentId: "main", name: "AGENTS.md" } };
      expect(await engine.install(PIN, other)).toEqual({ kind: "enabled" });
      expect(g.calls.some((c) => c.method === "agents.files.get")).toBe(false);
      expect(g.calls.filter((c) => c.method === "clawtrate-voice.get")).toHaveLength(1);
    });

    it("a pin field the caller changes during an awaited host check changes nothing sent", async () => {
      const g = at(version, "fresh");
      const pin = JSON.parse(JSON.stringify(PIN)) as typeof PIN;
      const ctx = contextFor(g, {
        artifact: async () => {
          pin.grants = { hooks: { allowConversationAccess: true, allowPromptInjection: true } };
          pin.integrity = "sha512-changed";
          return { path: ARCHIVE, root: RESOURCES, integrity: PIN.integrity };
        },
      });
      expect(await new PluginInstaller(ctx).install(pin)).toEqual({ kind: "enabled" });
      expect(writeLog(g)[2]).toBe(
        'config.patch {"plugins":{"entries":{"clawtrate-voice":{"enabled":false,"hooks":{"allowConversationAccess":true}}}}}',
      );
    });

    // 5. Idle means every page agreed.
    it("a row that moves across a page boundary while it runs answers busy", async () => {
      const g = at(version, "fresh");
      const idle = Array.from({ length: 200 }, (_, i) => ({
        key: `agent:main:s${i}`,
        hasActiveRun: false,
      }));
      g.sessionRows = [...idle, { key: "agent:main:busy", hasActiveRun: true }];
      // Step 1's read finds it on the second page. Then, after the first page of the read before
      // the first write, a row of that page ends: the running row moves before the next offset.
      g.hooks.push({
        method: "sessions.list",
        nth: 3,
        answer: (a) => {
          g.sessionRows = g.sessionRows!.slice(1);
          return a;
        },
      });
      expect(await new PluginInstaller(contextFor(g)).install(PIN)).toMatchObject({
        stop: "bots-busy",
      });
      expect(g.writes()).toEqual([]);
    });

    it("Take it off's disable isn't sent again after a read shows a run going", async () => {
      const g = at(version, "on");
      g.hooks.push({
        method: "plugins.setEnabled",
        nth: 1,
        before: (gw) => (gw.routineRunning = true),
        refuse: "busy",
      });
      expect(await new PluginInstaller(contextFor(g)).takeOff(PIN)).toMatchObject({
        stop: "bots-busy",
        mayBeRunning: true,
      });
      expect(g.calls.filter((c) => c.method === "plugins.setEnabled")).toHaveLength(1);
    });
  });

  describe("Take it off", () => {
    it("turns it off and removes its grant, leaving it installed; the marker then stops an install", async () => {
      const g = at(version, "on");
      const engine = new PluginInstaller(contextFor(g));
      expect(await engine.takeOff(PIN)).toEqual({ kind: "taken-off" });
      expect(writeLog(g)).toEqual([
        'plugins.setEnabled {"pluginId":"clawtrate-voice","enabled":false,"allowlistPolicy":"preserve"}',
        'config.patch {"plugins":{"entries":{"clawtrate-voice":{"enabled":false,"hooks":null}}}}',
      ]);
      expect(g.shape()).toBe("OFF");
      expect(g.staged).not.toBeNull();
      // Every device reads the marker: nothing installs it again by itself.
      expect(await engine.install(PIN)).toMatchObject({ stop: "listed-off" });
      expect(await engine.turnOn(PIN)).toEqual({ kind: "enabled" });
    });
  });
});

describe("the host's tarball", () => {
  const verified = (path: string, root: string) => ({ path, root, integrity: PIN.integrity });
  it("takes a resolved path inside the resources, on either system", () => {
    expect(artifactProblem(verified(ARCHIVE, RESOURCES), PIN)).toBeNull();
    expect(
      artifactProblem(
        verified(
          "C:\\Program Files\\Clawtrate\\resources\\plugins\\clawtrate-clawtrate-voice-0.1.0.tgz",
          "C:\\Program Files\\Clawtrate\\resources\\plugins",
        ),
        PIN,
      ),
    ).toBeNull();
  });
  it("refuses another drive, a doubled separator, a dot step and a sibling with the same prefix", () => {
    for (const [path, root] of [
      ["D:\\Clawtrate\\plugins\\a.tgz", "C:\\Clawtrate\\plugins"],
      ["/app/plugins//a.tgz", "/app/plugins"],
      ["/app/plugins/./a.tgz", "/app/plugins"],
      ["/app/plugins-other/a.tgz", "/app/plugins"],
      ["/app/plugins/a.tgz", "app/plugins"],
      // On POSIX a backslash is part of a name: this is a sibling of the folder, not inside it.
      ["/app/plugins\\a.tgz", "/app/plugins"],
    ])
      expect(artifactProblem(verified(path!, root!), PIN), path).not.toBeNull();
  });
});

describe("the device's record", () => {
  it("is dropped for another pin's attempt", async () => {
    const g = FakeGateway.at("2026.10.6", "fresh");
    const records = new Map<string, PluginRecord | null>([
      [
        ID,
        {
          mode: "install",
          integrity: "sha512-other",
          step: 2,
          pending: null,
          turningOff: false,
          sourceDigest: null,
          configHash: null,
        },
      ],
    ]);
    const ctx = contextFor(g, { records });
    expect(await new PluginInstaller(ctx).resume(PIN)).toMatchObject({
      stop: "lost",
    });
    expect(records.get(ID)).toBeNull();
    expect(g.writes()).toEqual([]);
  });
});
