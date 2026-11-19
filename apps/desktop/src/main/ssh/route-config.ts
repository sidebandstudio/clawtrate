// The configuration the host writes for one route (docs/design/setup.md,
// section 19): one directive per line, one validated value per directive, and
// no forwards. `ssh` is only ever started with `-F` on a file made here.

import { isHost, isRouteId, isUser, routeAlias } from "./destination.ts";
import type { Target } from "./person-config.ts";
import type { SshWorld } from "./world.ts";

/** "normal": every look and the forward. "lookup": prior trust, by host and port, in the person's file. */
export type ConfigPurpose = "normal" | "lookup";

export class UnsafeConfigValue extends Error {
  override name = "UnsafeConfigValue";
}

/**
 * A path as a configuration value: forward slashes, double quotes around a
 * space, and nothing `ssh` would expand or split (`%`, `$`, `~`, quotes,
 * backslashes, `#`, `=` or control characters).
 */
export function pathValue(path: string, platform: NodeJS.Platform): string {
  const value = platform === "win32" ? path.replaceAll("\\", "/") : path;
  if (!/^(?:[A-Za-z]:)?\/[\p{L}\p{N} ._+@/-]*$/u.test(value)) {
    throw new UnsafeConfigValue("A path holds characters the host's configuration does not allow.");
  }
  if (value.endsWith(" ") || value.includes("  ")) {
    throw new UnsafeConfigValue("A path holds spaces the host's configuration does not allow.");
  }
  return value.includes(" ") ? `"${value}"` : value;
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
  const lines = [
    `Host ${routeAlias(routeId)}`,
    `  HostName ${target.hostName}`,
    `  User ${target.user}`,
    `  Port ${target.port}`,
    ...target.identityFiles.map((file) => `  IdentityFile ${p(file)}`),
    ...(target.identitiesOnly === null
      ? []
      : [`  IdentitiesOnly ${target.identitiesOnly ? "yes" : "no"}`]),
    ...target.certificateFiles.map((file) => `  CertificateFile ${p(file)}`),
    ...(purpose === "lookup"
      ? // Prior trust is looked up for the resolved host and port, without the alias.
        [`  UserKnownHostsFile ${p(world.personKnownHosts)}`]
      : [`  HostKeyAlias ${routeAlias(routeId)}`, `  UserKnownHostsFile ${p(knownHosts)}`]),
    "  GlobalKnownHostsFile none",
    "  StrictHostKeyChecking yes",
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
    ...(world.agent === "none" ? ["  IdentityAgent none"] : []),
  ];
  for (const line of lines) {
    if (/\p{Cc}/u.test(line)) throw new UnsafeConfigValue("A value holds a control character.");
  }
  return lines.join("\n") + "\n";
}
