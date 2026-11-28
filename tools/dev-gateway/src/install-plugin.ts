// `--install-plugin <name>`: installs one of the plugins the desktop app carries on a named
// instance the way the app will, through the install engine (packages/core/src/plugin-install.ts)
// on a paired admin connection from this computer, from a tarball packed from the checkout by the
// app's own packer (apps/desktop/packaging/carried-plugins.ts). Unlike `--with-plugin`, which
// loads a checked snapshot through the config before the gateway starts, this checks the whole
// install sequence on a running gateway, on either OpenClaw version.
//
// The packer runs as its own program, the way the desktop build runs it, into the instance's run
// folder; nothing of the app's packaging is imported here. A plugin packed with files its record
// hasn't got a source digest for on the running OpenClaw still installs as far as the enable:
// the engine compares the digest the gateway reports, turns the plugin off when it differs, and
// this says the digest it saw and the command that records it.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  PluginInstaller,
  type PluginInstallContext,
  type PluginOutcome,
  type PluginPin,
  type PluginRecord,
  type VerifiedArtifact,
} from "../../../packages/core/src/plugin-install.ts";
import type { OperatorSession } from "./operator.ts";

/** The plugins `--install-plugin` takes: those the desktop app carries. */
export const INSTALLABLE = ["clawtrate-voice"] as const;

/**
 * The grants the engine writes into each one's config entry, its record's
 * (apps/desktop/packaging/carried-plugins.json): the instance's config contract accepts that
 * entry, and nothing else, once the plugin is installed.
 */
export const INSTALLED_GRANTS: Record<
  (typeof INSTALLABLE)[number],
  { hooks: Record<string, true> }
> = { "clawtrate-voice": { hooks: { allowConversationAccess: true } } };

/** A packing: its pin, its tarball, and the folder it was packed into, the tool's "resources". */
export type Packed = { pin: PluginPin; archive: string; dir: string; unrecorded: boolean };

/**
 * Packs the carried plugins from `checkout` into `dir` with the app's packer, and returns the
 * pin and tarball of `name`. Packing that would stop the app's build stops this too, except a
 * missing source digest, which the install measures.
 */
export function packCarried(checkout: string, dir: string, name: string): Packed {
  if (!(INSTALLABLE as readonly string[]).includes(name))
    throw new Error(
      `--install-plugin takes ${INSTALLABLE.join(", ")}, not ${JSON.stringify(name)}`,
    );
  mkdirSync(dir, { recursive: true });
  const packer = join(checkout, "apps/desktop/packaging/carried-plugins.ts");
  const result = spawnSync(process.execPath, [packer, "pack", dir, "--unrecorded-digests"], {
    cwd: checkout,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`packing failed:\n${result.stderr || result.stdout}`);
  const list = JSON.parse(readFileSync(join(dir, "plugins.json"), "utf8")) as {
    plugins: (PluginPin & { file: string })[];
  };
  const entry = list.plugins.find((plugin) => plugin.pluginId === name);
  if (!entry) throw new Error(`${name} isn't in the carried list`);
  const { file, ...pin } = entry;
  return {
    pin,
    archive: join(dir, file),
    dir,
    unrecorded: Object.values(pin.sourceDigests).some((d) => !d),
  };
}

/**
 * The packed tarball checked now, as the app's host checks its own before each stage
 * (docs/design/plugins-install.md, 3.6): no symbolic link on its path or its folder's, inside
 * the folder it was packed into, and its SHA-512 measured from the bytes read for this call.
 */
export function verifyPacked(packed: Pick<Packed, "archive" | "dir">): VerifiedArtifact {
  const root = realpathSync(packed.dir);
  const path = realpathSync(packed.archive);
  if (root !== resolve(packed.dir) || path !== resolve(packed.archive))
    throw new Error(`${packed.archive} is reached through a symbolic link`);
  const integrity = `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
  return { path, root, integrity };
}

/** Where the engine keeps its records: a file in the instance's state folder, or a map. */
export type RecordStore = Pick<PluginInstallContext, "loadRecord" | "saveRecord">;

/** The engine's records in `path`, so the next run on the same instance resumes them. */
export function recordFile(path: string): RecordStore {
  const read = (): Record<string, PluginRecord> =>
    existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, PluginRecord>)
      : {};
  return {
    loadRecord: async (id) => read()[id] ?? null,
    saveRecord: async (id, record) => {
      const all = read();
      if (record) all[id] = record;
      else delete all[id];
      mkdirSync(dirname(path), { recursive: true });
      const next = `${path}.${process.pid}.next`;
      writeFileSync(next, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
      renameSync(next, path);
    },
  };
}

/** The engine's records in a map, for a caller that keeps them itself. */
export function recordMap(records: Map<string, PluginRecord | null>): RecordStore {
  return {
    loadRecord: async (id) => records.get(id) ?? null,
    saveRecord: async (id, record) => {
      records.set(id, record);
    },
  };
}

/**
 * The engine's context on a dev operator session: this computer, admin as the gateway's hello
 * granted it, the packing as the carried list and its tarball checked at each stage, time
 * passing for real.
 */
export function operatorContext(
  session: OperatorSession,
  records: RecordStore,
  packed: Pick<Packed, "pin" | "archive" | "dir">,
  shipped: PluginInstallContext["shipped"] = [],
): PluginInstallContext {
  return {
    // Bound to one connection: sent on the connection that is up, never waited for or sent
    // again on the next (the engine's epoch is the session's hello count).
    request: (method, params) => session.requestOnce(method, params, 120_000),
    admin: () => session.isUp && session.grantedScopes.includes("operator.admin"),
    serverVersion: () => session.serverVersion,
    route: () => "same-computer",
    answered: (error) =>
      typeof (error as { code?: unknown })?.code === "string" &&
      (error as { code: string }).code !== "CLIENT_TIMEOUT",
    epoch: () => session.generation,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => Date.now(),
    changed: (ms) =>
      session
        .waitFor(
          "plugins.changed",
          (event) => event.event === "plugins.changed",
          ms,
          session.events.at(-1)?.seq ?? 0,
        )
        .then(
          () => true,
          () => false,
        ),
    ...records,
    shipped,
    carried: [packed.pin],
    artifact: async () => verifyPacked(packed),
  };
}

/** One line for each outcome, as the tool prints it. */
export function describeOutcome(
  name: string,
  version: string | null,
  outcome: PluginOutcome,
): string {
  if (outcome.kind === "enabled")
    return `Installed ${name} on OpenClaw ${version}: enabled and confirmed.`;
  if (outcome.kind === "taken-off") return `Took ${name} off: installed and off.`;
  if (outcome.kind === "nothing-installed")
    return `Nothing of ${name} was installed, so there was nothing to take off.`;
  if (outcome.stop === "taking-off-later")
    return `${name} will be taken off when this device is next connected with full control: nothing was sent.${outcome.mayBeRunning ? "\nUntil then it may still be running." : ""}`;
  if (outcome.stop === "taken-off-elsewhere")
    return `Didn't install ${name}: it was taken off elsewhere since this device's last step, or that step's change never applied; nothing was written.${outcome.mayBeRunning ? "\nIt may still be running: no read has shown it off since." : ""}`;
  const said = outcome.gateway ? ` (${outcome.gateway})` : "";
  const digest =
    outcome.reported && version
      ? `\nThe gateway reported the source digest ${outcome.reported}. If this packing is the one to ship, record it: node apps/desktop/packaging/carried-plugins.ts source-digest ${name} ${version} ${outcome.reported}`
      : "";
  const running = outcome.mayBeRunning
    ? "\nIt may still be running: no read has shown it off since."
    : "";
  return `Didn't install ${name}: ${outcome.stop}${said}.${running}${digest}`;
}

/**
 * Installs `name` on the instance `session` is connected to: Install, or the mode the gateway's
 * state calls for (Add again, Turn on). Never updates by itself and never uninstalls.
 */
export async function installPlugin(
  session: OperatorSession,
  packed: Packed,
  records: RecordStore = recordMap(new Map()),
): Promise<PluginOutcome> {
  const pin = {
    ...packed.pin,
    // Unrecorded on this version: measured at the enable, then turned off and said.
    sourceDigests: Object.fromEntries(
      Object.entries(packed.pin.sourceDigests).map(([version, digest]) => [
        version,
        digest || "unrecorded",
      ]),
    ),
  };
  const engine = new PluginInstaller(operatorContext(session, records, { ...packed, pin }));
  // An attempt this tool left, on an earlier run too, resumes, and its outcome is final: a
  // recovery's stop never turns into a fresh Add again or Turn on.
  if (await records.loadRecord(packed.pin.pluginId)) return engine.resume(pin);
  const first = await engine.install(pin);
  if (first.kind === "stopped" && first.stop === "not-listed-off") return engine.addAgain(pin);
  if (first.kind === "stopped" && first.stop === "listed-off") return engine.turnOn(pin);
  return first;
}
