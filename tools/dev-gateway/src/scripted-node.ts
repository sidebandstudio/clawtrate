// A paired machine for a development gateway (`start --with-node`): the
// gateway's own headless node host (`openclaw node run`), on this computer, on
// loopback, under the instance's profile. A development gateway otherwise has
// no node, so Settings, Machines and a bot's "Where it runs" had nothing true
// to show.
//
// It is closed like the config: one invented name, and it declares only the two
// commands that read and write its exec approvals file
// (`system.execApprovals.get`, `system.execApprovals.set`). It does not declare
// `system.run` or `system.which`, so no bot's command can run on it; the
// gateway refuses any command a node did not declare. Its state, its approvals
// file included, is a folder of its own inside the instance's folder, so its
// file is not the gateway machine's.

import { join } from "node:path";

/** The node's name, invented: the machine the design's examples call media-box. */
export const SCRIPTED_NODE_NAME = "media-box";

/** The only commands the node declares. Nothing that runs a command. */
export const SCRIPTED_NODE_COMMANDS = ["system.execApprovals.get", "system.execApprovals.set"];

/** The node's own state folder, inside the instance's. */
export function scriptedNodeDir(stateDir: string): string {
  return join(stateDir, "clawtrate-nodes", SCRIPTED_NODE_NAME);
}

/** `openclaw <profile> node run …`, without the profile options the runner adds. */
export function scriptedNodeArgs(gatewayPort: number): string[] {
  return [
    "node",
    "run",
    "--host",
    "127.0.0.1",
    "--port",
    String(gatewayPort),
    "--display-name",
    SCRIPTED_NODE_NAME,
    "--commands",
    SCRIPTED_NODE_COMMANDS.join(","),
  ];
}

/**
 * The node's environment over the runner's: its own state folder and config
 * path (an explicit state folder outlives `--profile`, which only fills one
 * in), the gateway's token, and no self-update.
 */
export function scriptedNodeEnv(stateDir: string, token: string): NodeJS.ProcessEnv {
  const dir = scriptedNodeDir(stateDir);
  return {
    OPENCLAW_STATE_DIR: dir,
    OPENCLAW_CONFIG_PATH: join(dir, "openclaw.json"),
    OPENCLAW_GATEWAY_TOKEN: token,
    OPENCLAW_NO_AUTO_UPDATE: "1",
  };
}

type Row = Record<string, unknown>;
const rows = (value: unknown, key: string): Row[] => {
  const list = (value as Row | null)?.[key];
  return Array.isArray(list) ? (list.filter((r) => r && typeof r === "object") as Row[]) : [];
};

/**
 * The node's pairing request among `devices list --json`'s pending ones: role
 * `node`, the node host's client, its name, and exactly one. Anything else is
 * not approved.
 */
export function nodeDeviceRequest(list: unknown): { requestId: string; deviceId: string } | null {
  const found = rows(list, "pending").filter(
    (row) =>
      row.role === "node" &&
      row.clientId === "node-host" &&
      row.displayName === SCRIPTED_NODE_NAME &&
      typeof row.requestId === "string" &&
      typeof row.deviceId === "string",
  );
  if (found.length !== 1) return null;
  return { requestId: found[0]!.requestId as string, deviceId: found[0]!.deviceId as string };
}

/**
 * The node's command approval among `nodes pending --json`: the device just
 * approved, declaring exactly the two commands. A request for anything more is
 * not approved.
 */
export function nodeCommandRequest(list: unknown, deviceId: string): string | null {
  const pending = Array.isArray(list) ? (list as Row[]) : rows(list, "pending");
  const found = pending.filter(
    (row) =>
      row.nodeId === deviceId &&
      Array.isArray(row.commands) &&
      row.commands.length === SCRIPTED_NODE_COMMANDS.length &&
      SCRIPTED_NODE_COMMANDS.every((command) => (row.commands as unknown[]).includes(command)) &&
      typeof row.requestId === "string",
  );
  return found.length === 1 ? (found[0]!.requestId as string) : null;
}
