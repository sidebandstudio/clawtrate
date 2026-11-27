// The install engine (packages/core/src/plugin-install.ts) against a stand-in gateway answering
// with each OpenClaw version's captured frames (plugin-gateway.ts). One test per row of
// docs/design/plugins-install.md's walk table (section 3.5), the four resume rules of issue #832,
// step 0, and the rules every attempt keeps: no uninstall, `allowlistPolicy: "preserve"` on every
// enable, no acknowledged install-policy warning, and an explicit `enabled: false` from the first
// write until the enable.

import { afterEach, describe, expect, it } from "vitest";
import { PluginInstaller, type PluginRecord } from "../src/plugin-install.ts";
import {
  ARCHIVE,
  CONFIRM,
  contextFor,
  FakeGateway,
  ID,
  OTHER_ARCHIVE,
  OTHER_DIGEST,
  PIN,
  PIN_DIGEST,
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
      expect(await new PluginInstaller(ctx).install(PIN, ARCHIVE, CONFIRM)).toEqual({
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
      const outcome = await new PluginInstaller(contextFor(g)).addAgain(PIN, ARCHIVE, CONFIRM);
      expect(outcome).toEqual({ kind: "enabled" });
      expect(writeLog(g)[0]).toMatch(/^plugins\.install /);
      expect(g.shape()).toBe("ON+G");
    });

    it.each(["off", "off-no-grant"] as const)(
      "row 3: Turn on a listed plugin whose entry is %s",
      async (start) => {
        const g = at(version, start);
        expect(await new PluginInstaller(contextFor(g)).turnOn(PIN, ARCHIVE, CONFIRM)).toEqual({
          kind: "enabled",
        });
        expect(g.writes().some((c) => c.method === "plugins.install")).toBe(false);
        expect(writeLog(g).at(-1)).toMatch(/"enabled":true/);
        expect(g.shape()).toBe("ON+G");
      },
    );

    it("row 4: an update the person asks for turns it off first, then stages the newer copy", async () => {
      const g = at(version, "older-on");
      expect(await new PluginInstaller(contextFor(g)).update(PIN, ARCHIVE, CONFIRM)).toEqual({
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
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN, ARCHIVE, CONFIRM);
      expect(outcome).toMatchObject({ kind: "stopped", stop: "other-copy" });
      expect(g.writes()).toEqual([]);
    });

    it("row 4: an older copy this app never shipped is left as it is", async () => {
      const g = at(version, "older-on");
      const ctx = { ...contextFor(g), shipped: [] };
      const outcome = await new PluginInstaller(ctx).update(PIN, ARCHIVE, CONFIRM);
      expect(outcome).toMatchObject({ kind: "stopped", stop: "other-copy" });
      expect(g.writes()).toEqual([]);
    });

    it("row 5a: a lost reply before the stage applied: off, and the record resumes at step 3", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.install", nth: 1, lose: "before" });
      const ctx = contextFor(g);
      const first = await new PluginInstaller(ctx).install(PIN, ARCHIVE, CONFIRM);
      expect(first).toMatchObject({ kind: "stopped", stop: "lost", mayBeRunning: false });
      expect(g.shape()).toBe("OFF");
      expect(ctx.records.get(ID)).toMatchObject({ step: 2, pending: 3 });
      expect(await new PluginInstaller(ctx).resume(PIN, ARCHIVE, CONFIRM)).toEqual({
        kind: "enabled",
      });
    });

    it("row 5b: a lost reply after the stage applied: the record finds it and goes on at step 4", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.install", nth: 1, lose: "after" });
      const ctx = contextFor(g);
      expect(await new PluginInstaller(ctx).install(PIN, ARCHIVE, CONFIRM)).toMatchObject({
        stop: "lost",
      });
      expect(g.loaded).toBe(false);
      expect(await new PluginInstaller(ctx).resume(PIN, ARCHIVE, CONFIRM)).toEqual({
        kind: "enabled",
      });
      // Staged once: the resume didn't stage again.
      expect(g.calls.filter((c) => c.method === "plugins.install")).toHaveLength(1);
    });

    it("row 5c: bots busy for five minutes after the stage: off, and resumes at step 4", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.inspect", nth: 1, before: (gw) => (gw.busy = true) });
      const ctx = contextFor(g);
      expect(await new PluginInstaller(ctx).install(PIN, ARCHIVE, CONFIRM)).toMatchObject({
        stop: "bots-busy",
        mayBeRunning: false,
      });
      expect(ctx.slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(5 * 60_000);
      expect(g.shape()).toBe("OFF");
      g.busy = false;
      expect(await new PluginInstaller(ctx).resume(PIN, ARCHIVE, CONFIRM)).toEqual({
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
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN, ARCHIVE, CONFIRM);
      expect(outcome).toMatchObject({ kind: "stopped", stop: "mismatch", mayBeRunning: false });
      expect(g.shape()).toBe("OFF");
      expect(g.loaded).toBe(false);
      expect(g.ran).toEqual([]);
    });

    it("row 5e: a lost reply after the grant applied resumes at step 6", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "config.patch", nth: 2, lose: "after" });
      const ctx = contextFor(g);
      expect(await new PluginInstaller(ctx).install(PIN, ARCHIVE, CONFIRM)).toMatchObject({
        stop: "lost",
        mayBeRunning: false,
      });
      expect(g.shape()).toBe("OFF+G");
      expect(g.loaded).toBe(false);
      expect(await new PluginInstaller(ctx).resume(PIN, ARCHIVE, CONFIRM)).toEqual({
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
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN, ARCHIVE, CONFIRM);
      expect(outcome).toMatchObject({ kind: "stopped", stop: "owner-settings" });
      expect(g.loaded).toBe(false);
    });

    it("row 5g: a lost step 7 reply that applied: off, then steps 6 and 7 again for the digest", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.setEnabled", nth: 1, lose: "after" });
      const ctx = contextFor(g);
      const first = await new PluginInstaller(ctx).install(PIN, ARCHIVE, CONFIRM);
      // After step 7 the line says only that contact was lost, never that it is off.
      expect(first).toMatchObject({ kind: "stopped", stop: "lost", mayBeRunning: true });
      expect(g.loaded).toBe(true);
      expect(await new PluginInstaller(ctx).resume(PIN, ARCHIVE, CONFIRM)).toEqual({
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
      await new PluginInstaller(ctx).install(PIN, ARCHIVE, CONFIRM);
      expect(await new PluginInstaller(ctx).resume(PIN, ARCHIVE, CONFIRM)).toMatchObject({
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
      const outcome = await new PluginInstaller(ctx).install(PIN, ARCHIVE, CONFIRM);
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
      expect(await new PluginInstaller(ctx).install(PIN, ARCHIVE, CONFIRM)).toMatchObject({
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
          bOutcome = new PluginInstaller(b).install(PIN, ARCHIVE, CONFIRM);
        },
      });
      const first = new PluginInstaller(a).install(PIN, ARCHIVE, CONFIRM);
      aDone = first;
      expect(await first).toEqual({ kind: "enabled" });
      // B said nothing until A finished, then what it read: on.
      expect(await bOutcome).toMatchObject({ kind: "stopped", stop: "already-on" });
      expect(b.records.get(ID) ?? null).toBeNull();
      expect(g.calls.filter((c) => c.method === "plugins.install")).toHaveLength(1);
      // Read now, B shows it on.
      expect(await new PluginInstaller(b).install(PIN, ARCHIVE, CONFIRM)).toMatchObject({
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
      const outcome = await new PluginInstaller(ctx).install(PIN, ARCHIVE, CONFIRM);
      expect(outcome).toMatchObject({ kind: "stopped", stop: "not-listed-off" });
      expect(g.writes()).toHaveLength(1);
      expect(ctx.records.get(ID)).toBeNull();
    });

    it("row 7a: the owner denies it after step 1: a stop at the next read, nothing staged loads", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.inspect", nth: 1, before: (gw) => gw.deny.push(ID) });
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN, ARCHIVE, CONFIRM);
      expect(outcome).toMatchObject({ stop: "owner-settings" });
      expect(g.loaded).toBe(false);
      expect(g.deny).toEqual([ID]);
      // Nothing written after the deny: the off-first patch and the stage only.
      expect(g.writes().map((c) => c.method)).toEqual(["config.patch", "plugins.install"]);
    });

    it("row 7b: the owner denies it between the last check and the enable: blocked, off", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.setEnabled", nth: 1, before: (gw) => gw.deny.push(ID) });
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN, ARCHIVE, CONFIRM);
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
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN, ARCHIVE, CONFIRM);
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
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN, ARCHIVE, CONFIRM);
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
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN, ARCHIVE, CONFIRM);
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
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN, ARCHIVE, CONFIRM);
      expect(outcome).toMatchObject({ stop: "owner-settings", mayBeRunning: false });
      expect(g.loaded).toBe(false);
      expect(g.shape()).toBe("OFF");
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
      expect(await new PluginInstaller(contextFor(g)).install(PIN, ARCHIVE, CONFIRM)).toEqual({
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
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN, ARCHIVE, CONFIRM);
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
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN, ARCHIVE, CONFIRM);
      expect(outcome).toMatchObject({ stop: "turned-off", mayBeRunning: false });
      // The replaced code ran once: this detects, it doesn't prevent (3.2).
      expect(g.ran).toEqual([OTHER_DIGEST]);
      expect(g.loaded).toBe(false);
    });

    it("row 9: a gateway reached by its address gets nothing yet", async () => {
      const g = at(version, "fresh");
      const outcome = await new PluginInstaller(contextFor(g, { route: "other" })).install(
        PIN,
        ARCHIVE,
        CONFIRM,
      );
      expect(outcome).toMatchObject({ stop: "route" });
      expect(g.calls).toEqual([]);
    });
  });

  describe("the resume rules of #832", () => {
    it("1: after a lost step 7 reply, an entry still OFF+G is a stop, never a retry", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.setEnabled", nth: 1, lose: "before" });
      const ctx = contextFor(g);
      await new PluginInstaller(ctx).install(PIN, ARCHIVE, CONFIRM);
      const before = g.writes().length;
      const outcome = await new PluginInstaller(ctx).resume(PIN, ARCHIVE, CONFIRM);
      expect(outcome).toMatchObject({ kind: "stopped", stop: "listed-off", mayBeRunning: false });
      expect(g.writes()).toHaveLength(before);
      expect(g.loaded).toBe(false);
      expect(ctx.records.get(ID)).toBeNull();
    });

    it("2: step 7's digest is kept in the record, so a resume at step 8 has it", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.inspect", nth: 3, lose: "before" });
      const ctx = contextFor(g);
      expect(await new PluginInstaller(ctx).install(PIN, ARCHIVE, CONFIRM)).toMatchObject({
        stop: "lost",
      });
      expect(ctx.records.get(ID)).toMatchObject({ step: 7, sourceDigest: PIN_DIGEST });
      expect(await new PluginInstaller(ctx).resume(PIN, ARCHIVE, CONFIRM)).toEqual({
        kind: "enabled",
      });
      expect(g.calls.filter((c) => c.method === "plugins.setEnabled")).toHaveLength(1);
    });

    it("3: a resume at step 6 inspects again and acknowledges that inspect's review token", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "config.patch", nth: 2, lose: "after" });
      const ctx = contextFor(g);
      await new PluginInstaller(ctx).install(PIN, ARCHIVE, CONFIRM);
      g.token = "f".repeat(64);
      expect(await new PluginInstaller(ctx).resume(PIN, ARCHIVE, CONFIRM)).toEqual({
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
      const outcome = await new PluginInstaller(contextFor(g)).update(PIN, ARCHIVE, CONFIRM);
      expect(outcome).toMatchObject({ kind: "stopped", stop: "lost", mayBeRunning: true });
      expect(g.loaded).toBe(true);
    });
  });

  describe("step 0 and the gateway's own answers", () => {
    it("writes nothing without a confirmed admin grant, and asks for none", async () => {
      const g = at(version, "fresh");
      const outcome = await new PluginInstaller(contextFor(g, { admin: () => false })).install(
        PIN,
        ARCHIVE,
        CONFIRM,
      );
      expect(outcome).toMatchObject({ stop: "no-admin" });
      expect(g.calls).toEqual([]);
    });

    it("stops mid-sequence when the grant goes", async () => {
      const g = at(version, "fresh");
      let admin = true;
      g.hooks.push({ method: "plugins.inspect", nth: 1, before: () => (admin = false) });
      const outcome = await new PluginInstaller(contextFor(g, { admin: () => admin })).install(
        PIN,
        ARCHIVE,
        CONFIRM,
      );
      expect(outcome).toMatchObject({ stop: "no-admin" });
      expect(g.loaded).toBe(false);
    });

    it("installs nothing on an OpenClaw version the pin has no source digest for", async () => {
      const g = at(version, "fresh");
      const ctx = contextFor(g, { serverVersion: "2026.12.1" });
      expect(await new PluginInstaller(ctx).install(PIN, ARCHIVE, CONFIRM)).toMatchObject({
        stop: "openclaw-version",
      });
      expect(g.calls).toEqual([]);
    });

    it("runs over SSH as on this computer", async () => {
      const g = at(version, "fresh");
      expect(
        await new PluginInstaller(contextFor(g, { route: "ssh" })).install(PIN, ARCHIVE, CONFIRM),
      ).toEqual({
        kind: "enabled",
      });
    });

    it("an entry already enabled: true for a plugin not yet staged is the owner's: nothing staged (3.1)", async () => {
      const g = at(version, "fresh");
      g.entry = { enabled: true };
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN, ARCHIVE, CONFIRM);
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
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN, ARCHIVE, CONFIRM);
      expect(outcome).toMatchObject({ kind: "stopped", stop: "turned-off" });
      expect(g.ran).toEqual([PIN_DIGEST]);
      expect(g.loaded).toBe(false);
    });

    it("waits out the gateway's own 'already running', then goes on", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.setEnabled", nth: 1, refuse: "busy" });
      const ctx = contextFor(g);
      expect(await new PluginInstaller(ctx).install(PIN, ARCHIVE, CONFIRM)).toEqual({
        kind: "enabled",
      });
      expect(ctx.slept).toContain(g.f.errors.busy.retryAfterMs);
    });

    it("stops after three answers of 'already running'", async () => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.install", refuse: "busy" });
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN, ARCHIVE, CONFIRM);
      expect(outcome).toMatchObject({ stop: "gateway-busy", mayBeRunning: false });
      expect(g.calls.filter((c) => c.method === "plugins.install")).toHaveLength(3);
    });

    it.each([
      ["alreadyExists", "another-device"],
      ["missingArchive", "refused"],
    ])("a stage the gateway refuses (%s) stops, off", async (refusal, stop) => {
      const g = at(version, "fresh");
      g.hooks.push({ method: "plugins.install", refuse: refusal });
      const outcome = await new PluginInstaller(contextFor(g)).install(PIN, ARCHIVE, CONFIRM);
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
      expect(await new PluginInstaller(contextFor(g)).install(PIN, ARCHIVE, CONFIRM)).toMatchObject(
        {
          stop: "policy-warning",
        },
      );
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
      expect(await new PluginInstaller(contextFor(g)).install(PIN, ARCHIVE, CONFIRM)).toMatchObject(
        {
          stop: "route",
        },
      );
    });

    it("one attempt at a time on a device", async () => {
      const g = at(version, "fresh");
      const engine = new PluginInstaller(contextFor(g));
      const [a, b] = await Promise.all([
        engine.install(PIN, ARCHIVE, CONFIRM),
        engine.install(PIN, ARCHIVE, CONFIRM),
      ]);
      expect(a).toEqual({ kind: "enabled" });
      expect(b).toMatchObject({ stop: "in-progress" });
    });

    it("an attempt whose connection changed sends nothing more", async () => {
      const g = at(version, "fresh");
      let epoch = 1;
      g.hooks.push({ method: "plugins.inspect", nth: 1, before: () => (epoch = 2) });
      const outcome = await new PluginInstaller(contextFor(g, { epoch: () => epoch })).install(
        PIN,
        ARCHIVE,
        CONFIRM,
      );
      expect(outcome).toMatchObject({ stop: "connection-changed" });
      expect(g.writes().map((c) => c.method)).toEqual(["config.patch", "plugins.install"]);
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
      expect(await engine.install(PIN, ARCHIVE, CONFIRM)).toMatchObject({ stop: "listed-off" });
      expect(await engine.turnOn(PIN, ARCHIVE, CONFIRM)).toEqual({ kind: "enabled" });
    });
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
    expect(await new PluginInstaller(ctx).resume(PIN, ARCHIVE, CONFIRM)).toMatchObject({
      stop: "lost",
    });
    expect(records.get(ID)).toBeNull();
    expect(g.writes()).toEqual([]);
  });
});
