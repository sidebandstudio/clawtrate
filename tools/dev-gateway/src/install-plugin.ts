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
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PluginInstaller,
  type PluginInstallContext,
  type PluginOutcome,
  type PluginPin,
  type PluginRecord,
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

/** The plugin's own read that confirms it loaded (the engine's step 8). */
const CONFIRM: Record<string, { method: string; params: unknown }> = {
  "clawtrate-voice": { method: "clawtrate-voice.get", params: {} },
};

export type Packed = { pin: PluginPin; archive: string; unrecorded: boolean };

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
    unrecorded: Object.values(pin.sourceDigests).some((d) => !d),
  };
}

/** The engine's context on a dev operator session: this computer, admin, time passing for real. */
export function operatorContext(
  session: OperatorSession,
  records: Map<string, PluginRecord | null>,
  shipped: PluginInstallContext["shipped"] = [],
): PluginInstallContext {
  return {
    // Bound to one connection: sent on the connection that is up, never waited for or sent
    // again on the next (the engine's epoch is the session's hello count).
    request: (method, params) => session.requestOnce(method, params, 120_000),
    admin: () => true,
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
    loadRecord: async (id) => records.get(id) ?? null,
    saveRecord: async (id, record) => {
      records.set(id, record);
    },
    shipped,
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
  records = new Map<string, PluginRecord | null>(),
): Promise<PluginOutcome> {
  const engine = new PluginInstaller(operatorContext(session, records));
  const confirm = CONFIRM[packed.pin.pluginId]!;
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
  // An attempt this tool left resumes, and its outcome is final: a recovery's stop never turns
  // into a fresh Add again or Turn on.
  if (records.get(packed.pin.pluginId)) return engine.resume(pin, packed.archive, confirm);
  const first = await engine.install(pin, packed.archive, confirm);
  if (first.kind === "stopped" && first.stop === "not-listed-off")
    return engine.addAgain(pin, packed.archive, confirm);
  if (first.kind === "stopped" && first.stop === "listed-off")
    return engine.turnOn(pin, packed.archive, confirm);
  return first;
}
