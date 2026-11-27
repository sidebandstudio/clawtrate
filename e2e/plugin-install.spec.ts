// The plugin install engine (packages/core/src/plugin-install.ts) against a real development
// gateway of its own: it installs the voice plugin from the tarball the desktop app's packer makes,
// takes it off, turns it on, adds it again after an uninstall elsewhere, updates it from an older
// release the person asks to update, and stops for an owner's deny and an owner's revoked grant
// between its last check and its enable: rows 1 to 4, 7b and 7e of docs/design/plugins-install.md's
// walk table, on whichever OpenClaw version the instance runs. The source digest each version
// reports must be the one carried-plugins.json records, or the enable is turned off.
//
// The instance is this file's own, unseeded: started in its beforeAll and reset in its afterAll,
// and recorded first, so only the shard that runs this file starts it and a run killed outright
// is cleaned up by the next `pnpm e2e`.
import { expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  digestNow,
  packCarried,
  PLUGINS_DIR,
  readRecord,
} from "../apps/desktop/packaging/carried-plugins.ts";
import { PluginInstaller, type PluginRecord } from "../packages/core/src/plugin-install.ts";
import { openInstance, readDevConnection } from "../tools/dev-gateway/src/cli.ts";
import { operatorContext } from "../tools/dev-gateway/src/install-plugin.ts";
import { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { newRunId, ownIdentity } from "../tools/dev-gateway/src/state-guard.ts";
import { devGateway, FORBIDDEN_PORTS, listInstances, resetInstance } from "./global-setup.ts";
import { cleanUp, recordPath, saveRecord, TEMP_PREFIX, type RunRecord } from "./run-record.ts";

const RECORDS = join(import.meta.dirname, "../tools/dev-gateway/.run/e2e");
const record: RunRecord = {
  run: randomBytes(4).toString("hex"),
  runner: { pid: process.pid, identity: "" },
  instances: [],
  host: null,
  dirs: [],
};
/** This spec's own unseeded instance, which no other spec uses. */
const INSTANCE = `e2e-${record.run}-install`;
const ID = "clawtrate-voice";
const CONFIRM = { method: "clawtrate-voice.get", params: {} };
const SCOPES = ["operator.admin", "operator.read", "operator.write"];

type Pin = Parameters<PluginInstaller["install"]>[0];
let owner: OperatorSession;
let device: OperatorSession;
let pin: Pin;
let archive: string;
let older: { archive: string; version: string; integrity: string };
const records = new Map<string, PluginRecord | null>();

/**
 * A paired full-control connection to this spec's instance. Its hello may take minutes on a
 * loaded machine, as approving its request starts the gateway's own command line.
 */
async function operator(displayName: string): Promise<OperatorSession> {
  const inst = openInstance(INSTANCE);
  const connection = readDevConnection(inst.connectionFile)!;
  return OperatorSession.open({
    url: connection.url,
    token: connection.token,
    scopes: SCOPES,
    caps: [],
    displayName,
    timeoutMs: 240_000,
    approvePairing: async (requestId) => {
      const result = await inst.runner.run(["devices", "approve", requestId]);
      if (result.status !== 0) throw new Error(`approving ${requestId} failed: ${result.stderr}`);
    },
  });
}

/** The engine on this device's connection; `before` runs before each request it sends. */
function engine(before?: (method: string, params: Record<string, unknown>) => Promise<void>) {
  const ctx = operatorContext(device, records, [
    { version: older.version, integrity: older.integrity },
  ]);
  return new PluginInstaller({
    ...ctx,
    request: async (method, params) => {
      await before?.(method, (params ?? {}) as Record<string, unknown>);
      return ctx.request(method, params);
    },
  });
}

/** Waits out the gateway's "already running" after a change, for the owner's own writes. */
async function ownerCall(method: string, params: unknown): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await owner.request(method, params, 120_000);
    } catch (error) {
      if (!/already running/.test(String(error)) || attempt >= 10) throw error;
      await new Promise((done) => setTimeout(done, 1000));
    }
  }
}
async function ownerPatch(raw: unknown, replacePaths?: string[]) {
  const { hash } = await ownerCall("config.get", {});
  return ownerCall("config.patch", {
    baseHash: hash,
    raw: JSON.stringify(raw),
    ...(replacePaths ? { replacePaths } : {}),
  });
}
async function state() {
  const config = (await ownerCall("config.get", {})) as {
    config: { plugins?: { entries?: Record<string, unknown>; deny?: string[]; allow?: string[] } };
  };
  const list = (await ownerCall("plugins.list", {})) as {
    plugins: { id: string; version?: string; runtime?: { state?: string } }[];
  };
  const row = list.plugins.find((p) => p.id === ID);
  const { config: inner, ...entry } = (config.config.plugins?.entries?.[ID] ?? {}) as Record<
    string,
    unknown
  >;
  void inner;
  return {
    entry: config.config.plugins?.entries?.[ID] ? entry : undefined,
    listed: row ? { version: row.version, state: row.runtime?.state } : null,
    deny: config.config.plugins?.deny ?? [],
  };
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(480_000);
  record.runner.identity = ownIdentity();
  const runId = newRunId();
  record.instances.push({ name: INSTANCE, runId });
  saveRecord(RECORDS, record);
  expect(INSTANCE).not.toBe(process.env.CLAWTRATE_DEV_INSTANCE);
  process.stdout.write(devGateway(INSTANCE, "start", "--run-id", runId, "--no-seed"));
  const mine = listInstances().find((row) => row.name === INSTANCE);
  if (!mine?.gatewayRunning) throw new Error(`instance ${INSTANCE} is not running`);
  for (const port of [mine.gatewayPort, mine.providerPort])
    if (port === null || FORBIDDEN_PORTS.includes(port))
      throw new Error(`instance ${INSTANCE} is on port ${port}, which e2e never uses`);

  // The app's own tarball, as its build packs it, with the pin its build writes.
  const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  record.dirs.push(dir);
  saveRecord(RECORDS, record);
  const list = packCarried(join(dir, "app"));
  const { file, ...entry } = list.plugins.find((plugin) => plugin.pluginId === ID)!;
  pin = entry;
  archive = join(dir, "app", file);
  // An older release of the same plugin, as an earlier Clawtrate shipped it.
  const plugins = join(dir, "plugins");
  cpSync(join(PLUGINS_DIR, ID), join(plugins, ID), { recursive: true });
  const pkg = join(plugins, ID, "package.json");
  writeFileSync(pkg, readFileSync(pkg, "utf8").replace('"version": "0.1.0"', '"version": "0.0.9"'));
  const code = join(plugins, ID, "index.js");
  writeFileSync(
    code,
    readFileSync(code, "utf8").replace('PLUGIN_VERSION = "0.1.0"', 'PLUGIN_VERSION = "0.0.9"'),
  );
  const now = digestNow(ID, plugins);
  const own = readRecord();
  const oldList = packCarried(join(dir, "older"), {
    pluginsDir: plugins,
    record: {
      openclaw: [],
      plugins: {
        [ID]: { ...own.plugins[ID]!, version: now.version, digest: now.digest, sourceDigests: {} },
      },
    },
  });
  older = {
    archive: join(dir, "older", oldList.plugins[0]!.file),
    version: oldList.plugins[0]!.version,
    integrity: oldList.plugins[0]!.integrity,
  };
  owner = await operator("Plugin install checks, owner");
  device = await operator("Plugin install checks");
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  try {
    await device?.close().catch(() => {});
    await owner?.close().catch(() => {});
  } finally {
    const problems = cleanUp(RECORDS, record, resetInstance);
    expect(problems, "the install check's run record").toEqual([]);
    expect(existsSync(recordPath(RECORDS, record.run))).toBe(false);
    for (const dir of record.dirs) rmSync(dir, { recursive: true, force: true });
    expect(listInstances().some((row) => row.name === INSTANCE)).toBe(false);
  }
});

test("row 1: installs the app's tarball, off until the enable, with the source digest the record names", async () => {
  test.setTimeout(240_000);
  expect(device.serverVersion, "a version the pin has a digest for").toBeTruthy();
  expect(pin.sourceDigests[device.serverVersion!], "carried-plugins.json's digest").toMatch(
    /^[0-9a-f]{64}$/,
  );
  const seen: string[] = [];
  const outcome = await engine(async (method, params) => {
    if (
      method === "config.patch" ||
      method.startsWith("plugins.install") ||
      method === "plugins.setEnabled"
    )
      seen.push(
        `${method} ${JSON.stringify((await state()).entry ?? null)} ${params.enabled ?? ""}`,
      );
  }).install(pin, archive, CONFIRM);
  expect(outcome).toEqual({ kind: "enabled" });
  // Before each write the entry was off, or absent before the first. A write the gateway answered
  // "already running" is sent again, so it is seen twice: repeats are folded.
  const writes = seen.filter((line, i) => line !== seen[i - 1]);
  expect(writes.map((line) => line.split(" ")[1])).toEqual([
    "null",
    '{"enabled":false}',
    '{"enabled":false}',
    '{"enabled":false,"hooks":{"allowConversationAccess":true}}',
  ]);
  expect(await state()).toMatchObject({
    entry: { enabled: true, hooks: { allowConversationAccess: true } },
    listed: { version: pin.version, state: "active" },
  });
  const voice = (await ownerCall("clawtrate-voice.get", {})) as { hook: { state: string } };
  expect(voice.hook.state).toBe("allowed");
});

test("row 3: taken off it stays installed and off; nothing installs it again; Turn on does", async () => {
  test.setTimeout(240_000);
  expect(await engine().takeOff(pin)).toEqual({ kind: "taken-off" });
  expect(await state()).toMatchObject({
    entry: { enabled: false },
    listed: { version: pin.version, state: "unloaded" },
  });
  expect((await state()).entry).toEqual({ enabled: false });
  expect(await engine().install(pin, archive, CONFIRM)).toMatchObject({ stop: "listed-off" });
  expect(await engine().turnOn(pin, archive, CONFIRM)).toEqual({ kind: "enabled" });
  expect((await state()).listed).toMatchObject({ state: "active" });
});

test("row 2: after an uninstall elsewhere, Add again installs it", async () => {
  test.setTimeout(240_000);
  // Another tool uninstalls it: the gateway leaves the entry OFF.
  await ownerCall("plugins.uninstall", { pluginId: ID });
  expect(await state()).toMatchObject({ entry: { enabled: false }, listed: null });
  expect(await engine().install(pin, archive, CONFIRM)).toMatchObject({ stop: "not-listed-off" });
  expect(await engine().addAgain(pin, archive, CONFIRM)).toEqual({ kind: "enabled" });
});

test("row 4: an update the person asks for, from an older shipped release", async () => {
  test.setTimeout(300_000);
  // The older release, enabled with its grant, as an earlier Clawtrate left it.
  await ownerCall("plugins.setEnabled", {
    pluginId: ID,
    enabled: false,
    allowlistPolicy: "preserve",
  });
  await ownerCall("plugins.install", {
    source: "npm-pack",
    archivePath: older.archive,
    enable: false,
    mode: "update",
  });
  await ownerCall("plugins.setEnabled", {
    pluginId: ID,
    enabled: true,
    allowlistPolicy: "preserve",
  });
  expect((await state()).listed).toMatchObject({ version: older.version, state: "active" });
  // Nothing updates by itself.
  expect(await engine().install(pin, archive, CONFIRM)).toMatchObject({ stop: "other-copy" });
  expect(await engine().update(pin, archive, CONFIRM)).toEqual({ kind: "enabled" });
  expect((await state()).listed).toMatchObject({ version: pin.version, state: "active" });
});

test("row 7b: the owner's deny between the last check and the enable is kept", async () => {
  test.setTimeout(240_000);
  expect(await engine().takeOff(pin)).toEqual({ kind: "taken-off" });
  let denied = false;
  const outcome = await engine(async (method, params) => {
    if (method === "plugins.setEnabled" && params.enabled === true && !denied) {
      denied = true;
      await ownerPatch({ plugins: { deny: [ID] } });
    }
  }).turnOn(pin, archive, CONFIRM);
  expect(outcome).toMatchObject({ stop: "owner-settings" });
  expect(await state()).toMatchObject({ deny: [ID], listed: { state: "unloaded" } });
  await ownerPatch({ plugins: { deny: [] } }, ["plugins.deny"]);
});

test("row 7e: the owner's revoked grant before the enable: confirmed, then turned off", async () => {
  test.setTimeout(240_000);
  let revoked = false;
  const outcome = await engine(async (method, params) => {
    if (method === "plugins.setEnabled" && params.enabled === true && !revoked) {
      revoked = true;
      await ownerPatch({ plugins: { entries: { [ID]: { enabled: false, hooks: null } } } });
    }
  }).turnOn(pin, archive, CONFIRM);
  expect(outcome).toMatchObject({ stop: "owner-settings" });
  expect(await state()).toMatchObject({ listed: { state: "unloaded" } });
  expect((await state()).entry).toMatchObject({ enabled: false });
});
