// The configuration the host writes for one route (docs/design/setup.md,
// section 19): one directive per line, one validated value per directive, and
// no forwards. `ssh` is only ever started with `-F` on a file made here.

import { endpointText, isHost, isRouteId, isUser, routeAlias } from "./destination.ts";
import type { Target } from "./person-config.ts";
import type { SshWorld } from "./world.ts";

/**
 * "normal": every look and the forward. "lookup": prior trust, by host and
 * port, in the person's file. "capture": first contact, writing the presented
 * key into the empty file given as `knownHosts`.
 */
export type ConfigPurpose = "normal" | "lookup" | "capture";

export class UnsafeConfigValue extends Error {
  override name = "UnsafeConfigValue";
}

/**
 * Characters a path in the host's configuration may hold: letters, digits,
 * space and the punctuation profile and folder names use. Not `"` or `\`
 * (quoting), `%` or `$` (expansion), nor control characters.
 */
export const CONFIG_PATH = /^(?:[A-Za-z]:)?\/[\p{L}\p{N}\p{M} ._+@/(),'&!~#=[\]{};^-]*$/u;

/**
 * A path as a configuration value: forward slashes, always in double quotes,
 * so that a space or a `#` in a profile or folder name is part of it.
 */
export function pathValue(path: string, platform: NodeJS.Platform): string {
  const value = platform === "win32" ? path.replaceAll("\\", "/") : path;
  if (!CONFIG_PATH.test(value) || value.endsWith(" ")) {
    throw new UnsafeConfigValue("A path holds characters the host's configuration does not allow.");
  }
  return `"${value}"`;
}

/**
 * The agent, always chosen here: the person's `IdentityAgent` when they set
 * one, else the world's. On Windows the bundled client's own pipe is its
 * default and is left unnamed.
 */
function agentLines(target: Target, world: SshWorld, p: (path: string) => string): string[] {
  const agent = target.identityAgent === "world" ? world.agent : target.identityAgent;
  if (agent === "none") return ["  IdentityAgent none"];
  if (agent === "windows-pipe") return [];
  return [`  IdentityAgent ${p(agent.socket)}`];
}

/** The text of a route's configuration for one purpose. */
export function routeConfigText(
  routeId: string,
  target: Target,
  world: SshWorld,
  knownHosts: string,
  purpose: ConfigPurpose = "normal",
): string {
  if (!isRouteId(routeId)) throw new UnsafeConfigValue("The route id is not valid.");
  if (!isHost(target.hostName) || !isUser(target.user)) {
    throw new UnsafeConfigValue("The destination is not valid.");
  }
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
    throw new UnsafeConfigValue("The port is not valid.");
  }
  const p = (path: string) => pathValue(path, world.platform);
  const alias = routeAlias(routeId, endpointText(target.user, target.hostName, target.port));
  const lines = [
    `Host ${alias}`,
    `  HostName ${target.hostName}`,
    `  User ${target.user}`,
    `  Port ${target.port}`,
    // Always named: OpenSSH adds the account's default keys to a list left empty.
    ...(target.identityFiles.length
      ? target.identityFiles.map((file) => `  IdentityFile ${p(file)}`)
      : ["  IdentityFile none"]),
    ...(target.identitiesOnly === null
      ? []
      : [`  IdentitiesOnly ${target.identitiesOnly ? "yes" : "no"}`]),
    ...target.certificateFiles.map((file) => `  CertificateFile ${p(file)}`),
    ...(purpose === "lookup"
      ? // Prior trust is looked up for the resolved host and port, without the alias.
        [`  UserKnownHostsFile ${p(world.personKnownHosts)}`]
      : [`  HostKeyAlias ${alias}`, `  UserKnownHostsFile ${p(knownHosts)}`]),
    "  GlobalKnownHostsFile none",
    purpose === "capture" ? "  StrictHostKeyChecking accept-new" : "  StrictHostKeyChecking yes",
    "  UpdateHostKeys no",
    "  BatchMode yes",
    "  ConnectTimeout 10",
    "  ServerAliveInterval 15",
    "  ServerAliveCountMax 3",
    "  ExitOnForwardFailure yes",
    "  ClearAllForwardings yes",
    "  ForwardAgent no",
    "  ForwardX11 no",
    "  PermitLocalCommand no",
    "  ControlMaster no",
    "  ControlPath none",
    "  RequestTTY no",
    ...agentLines(target, world, p),
    ...(target.pubkeyAuthentication === null
      ? []
      : [`  PubkeyAuthentication ${target.pubkeyAuthentication}`]),
  ];
  for (const line of lines) {
    if (/\p{Cc}/u.test(line)) throw new UnsafeConfigValue("A value holds a control character.");
  }
  return lines.join("\n") + "\n";
}
