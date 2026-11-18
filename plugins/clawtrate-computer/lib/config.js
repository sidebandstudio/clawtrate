// The plugin's own configuration and the parts of the gateway's browser
// configuration it depends on. Everything here is pure: no I/O.

export const PLUGIN_ID = "clawtrate-computer";

/**
 * The only browser tool actions a configured bot may use: tab actions.
 * Everything else (importprofile, profiles, stop, downloads, uploads, doctor,
 * requests, errors, emulate, any action the gateway adds later) is refused,
 * rather than reasoned about one by one. Extend this list only after review.
 */
export const BOT_ACTIONS = new Set([
  "status",
  "start",
  "tabs",
  "open",
  "focus",
  "close",
  "snapshot",
  "screenshot",
  "navigate",
  "text",
  "act",
]);

/** Bounds of the two timing settings, in milliseconds. */
export const LIMITS = {
  drainTimeoutMs: { min: 1000, max: 60000, default: 15000 },
  renewTimeoutMs: { min: 5000, max: 60000, default: 20000 },
};

/** The destination the browser tool imports into when `into` is omitted. */
export const DEFAULT_IMPORT_PROFILE = "imported";
/** The profile the browser tool uses when `profile` and `browser.defaultProfile` are omitted. */
export const DEFAULT_PROFILE = "openclaw";

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// The gateway's own rule for browser profile names, with a length bound.
const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A selector read the way the browser tool reads it (readToolStringParam):
 * a string, trimmed, with empty meaning absent.
 */
export const toolString = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** A profile selector, compared without regard to case so no spelling can slip past. */
export const profileSelector = (value) => toolString(value)?.toLowerCase();

/**
 * Accept only a literal loopback HTTP origin, `http://127.0.0.1:<port>` or
 * `http://[::1]:<port>`, with an optional trailing slash: no hostname, no
 * credentials, no path, no query, no other scheme.
 */
export function parseCdpUrl(raw) {
  const match = /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/?$/.exec(
    typeof raw === "string" ? raw : "",
  );
  if (!match) {
    throw new Error(
      `cdpUrl must be http://127.0.0.1:<port> or http://[::1]:<port>, got ${JSON.stringify(raw)}`,
    );
  }
  const port = Number(match[2]);
  if (port > 65535) throw new Error(`cdpUrl port ${port} is out of range`);
  return { host: match[1], port, base: `http://${match[1]}:${port}` };
}

function boundedInteger(raw, name) {
  const limit = LIMITS[name];
  if (raw === undefined) return limit.default;
  if (!Number.isSafeInteger(raw) || raw < limit.min || raw > limit.max) {
    throw new Error(`${name} must be a whole number from ${limit.min} to ${limit.max}`);
  }
  return raw;
}

/**
 * Parse the plugin's config block (`plugins.entries.clawtrate-computer.config`).
 * Throws on anything unexpected, so a mistake stops the plugin from loading
 * instead of loading it half configured.
 */
export function parseConfig(raw = {}) {
  if (!isPlainObject(raw)) throw new Error("the plugin config must be an object");
  for (const key of Object.keys(raw)) {
    if (!["bots", "drainTimeoutMs", "renewTimeoutMs"].includes(key)) {
      throw new Error(`unknown setting ${JSON.stringify(key)}`);
    }
  }
  const rawBots = raw.bots ?? {};
  if (!isPlainObject(rawBots)) throw new Error("bots must be an object");
  const bots = new Map();
  const profiles = new Map();
  const endpoints = new Set();
  for (const [agentId, entry] of Object.entries(rawBots)) {
    if (!AGENT_ID.test(agentId)) throw new Error(`bot id ${JSON.stringify(agentId)} is not valid`);
    if (!isPlainObject(entry) || Object.keys(entry).sort().join() !== "cdpUrl,profile") {
      throw new Error(`bots.${agentId} must be exactly { profile, cdpUrl }`);
    }
    const { profile } = entry;
    if (typeof profile !== "string" || !PROFILE_NAME.test(profile)) {
      throw new Error(`bots.${agentId}.profile is not a valid browser profile name`);
    }
    if (profile === DEFAULT_IMPORT_PROFILE) {
      throw new Error(`bots.${agentId}.profile may not be "${DEFAULT_IMPORT_PROFILE}"`);
    }
    if (profiles.has(profile)) throw new Error(`profile ${profile} is assigned to two bots`);
    const endpoint = parseCdpUrl(entry.cdpUrl);
    if (endpoints.has(endpoint.port)) {
      throw new Error(`port ${endpoint.port} is assigned to two bots`);
    }
    endpoints.add(endpoint.port);
    const bot = { agentId, profile, ...endpoint };
    bots.set(agentId, bot);
    profiles.set(profile, bot);
  }
  return {
    bots,
    profiles,
    drainTimeoutMs: boundedInteger(raw.drainTimeoutMs, "drainTimeoutMs"),
    renewTimeoutMs: boundedInteger(raw.renewTimeoutMs, "renewTimeoutMs"),
  };
}

/** The profile the browser tool uses when a call omits `profile`. */
export const defaultProfileOf = (config) =>
  profileSelector(config?.browser?.defaultProfile) ?? DEFAULT_PROFILE;

// ---- which browser a profile reaches, as the gateway resolves it ----
//
// What follows reproduces the gateway's own resolution of browser profiles
// (OpenClaw 2026.10.6: resolveBrowserConfig and resolveProfile in its browser
// extension, and resolveGatewayPort), for the parts that decide which browser
// endpoint a profile reaches: the profiles it adds by itself, the host and
// port each one inherits, its driver and engine, and whether the gateway
// starts that browser or attaches to one already running. Ownership is
// decided on those endpoints, never on how a URL is written.

const DEFAULT_GATEWAY_PORT = 18789;
const EXTENSION_RELAY_PORT_OFFSET = 8;
const DEFAULT_CDP_RANGE_START = 18800;
const CDP_RANGE_SPAN = 99;

const trimmed = (value) => (typeof value === "string" ? value.trim() : "");

/** A TCP port from text the way the gateway reads OPENCLAW_GATEWAY_PORT, or null. */
function envPort(raw) {
  const text = trimmed(raw);
  const digits = /^\d+$/.test(text)
    ? text
    : (/^\[[^\]]+\]:(\d+)$/.exec(text)?.[1] ??
      (text.indexOf(":") > 0 && text.indexOf(":") === text.lastIndexOf(":")
        ? /^\d+$/.exec(text.slice(text.indexOf(":") + 1))?.[0]
        : undefined));
  if (digits === undefined) return null;
  const port = Number(digits);
  return Number.isSafeInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/** The gateway's port, as the gateway resolves it. */
export function gatewayPortOf(config, env = {}) {
  const fromEnv = envPort(env.OPENCLAW_GATEWAY_PORT);
  if (fromEnv !== null) return fromEnv;
  const port = config?.gateway?.port;
  if (typeof port === "number" && Number.isFinite(port) && port > 0) return port;
  const profile = trimmed(env.OPENCLAW_PROFILE);
  if (
    !profile ||
    profile.toLowerCase() === "default" ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(profile)
  ) {
    return DEFAULT_GATEWAY_PORT;
  }
  let hash = 2166136261;
  for (const byte of Buffer.from(profile, "utf8")) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return 20000 + (hash % 40000);
}

/** An endpoint from a URL: scheme, host (as URL normalizes it) and port. */
function endpointOf(raw, label) {
  const url = URL.parse(trimmed(raw));
  if (!url || !["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new Error(`${label} is not an http(s) or ws(s) URL`);
  }
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  return {
    scheme: url.protocol.slice(0, -1),
    host: url.hostname,
    port: url.port ? Number(url.port) : secure ? 443 : 80,
    explicitPort: rawHasPort(trimmed(raw)),
  };
}

/** Whether the text of a URL names a port (the gateway's hasRawExplicitPort). */
function rawHasPort(raw) {
  const authority = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/, 1)[0] ?? "";
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  return hostPort.startsWith("[") ? /^\[[^\]]+\]:\d+$/.test(hostPort) : /:\d+$/.test(hostPort);
}

/**
 * Whether a connection to `host` (as URL normalizes it) can arrive at a
 * browser listening on this machine's loopback: a loopback or unspecified
 * address, or any name, since a name can resolve to one. Only a literal
 * address elsewhere cannot.
 */
export function mayReachThisMachine(host) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return host.startsWith("127.") || host === "0.0.0.0";
  }
  if (host.startsWith("[")) {
    const ip = host.slice(1, -1);
    if (ip === "::1" || ip === "::") return true;
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
    if (!mapped) return false;
    const high = parseInt(mapped[1], 16);
    return high >> 8 === 127 || (high === 0 && parseInt(mapped[2], 16) === 0);
  }
  return true;
}

/** Every URL an existing-session profile's Chrome MCP arguments could connect to. */
function mcpEndpoints(profile, label) {
  const args = Array.isArray(profile.mcpArgs) ? profile.mcpArgs : [];
  const urls = [];
  for (const arg of args) {
    if (typeof arg !== "string") continue;
    for (const part of arg.split("=")) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(part.trim())) urls.push(part);
    }
  }
  if (typeof profile.cdpUrl === "string" && profile.cdpUrl.trim()) urls.push(profile.cdpUrl);
  return urls.map((url) => endpointOf(url, label));
}

/**
 * The gateway's view of the browser config: its default profile and, for
 * every profile it knows (the declared ones and the ones it adds by itself),
 * where it connects. Throws where the gateway would refuse the config.
 */
export function resolveBrowserProfiles(config, env = {}) {
  const browser = isPlainObject(config?.browser) ? config.browser : {};
  if (browser.cdpUrl !== undefined && typeof browser.cdpUrl !== "string") {
    throw new Error("browser.cdpUrl is not a string");
  }
  const controlPort = gatewayPortOf(config, env) + 2;
  let rangeStart = controlPort + 9;
  if (rangeStart <= 0 || rangeStart > 65535 || rangeStart + CDP_RANGE_SPAN > 65535) {
    rangeStart = DEFAULT_CDP_RANGE_START;
  }
  const rawCdpUrl = trimmed(browser.cdpUrl);
  const cdp = endpointOf(rawCdpUrl || `http://127.0.0.1:${controlPort + 1}`, "browser.cdpUrl");
  const protocol = cdp.scheme === "https" ? "https" : "http";
  const defaultProfile = trimmed(browser.defaultProfile) || DEFAULT_PROFILE;
  const declared = isPlainObject(browser.profiles) ? browser.profiles : {};
  const profiles = { ...declared };
  const added = new Set();
  const add = (name, profile) => {
    if (!profiles[name]) {
      profiles[name] = profile;
      added.add(name);
    }
  };
  add(DEFAULT_PROFILE, {
    cdpPort: rawCdpUrl ? cdp.port : rangeStart,
    ...(rawCdpUrl && cdp.scheme.startsWith("ws") ? { cdpUrl: rawCdpUrl } : {}),
  });
  add("user", { driver: "existing-session", attachOnly: true });
  add("chrome", { driver: "extension" });
  const selected = profiles[defaultProfile];
  if (rawCdpUrl && selected?.driver === "existing-session" && !trimmed(selected.cdpUrl)) {
    profiles[defaultProfile] = { ...selected, cdpUrl: rawCdpUrl };
  }
  // Extension relays without a port of their own count down from controlPort + 8.
  const reserved = new Set();
  for (const profile of Object.values(profiles)) {
    if (!isPlainObject(profile)) continue;
    if (typeof profile.cdpPort === "number" && profile.cdpPort > 0) reserved.add(profile.cdpPort);
    const port = Number(URL.parse(trimmed(profile.cdpUrl))?.port);
    if (port > 0) reserved.add(port);
  }
  const relayPorts = new Map();
  let next = controlPort + EXTENSION_RELAY_PORT_OFFSET;
  for (const name of Object.keys(profiles)
    .filter(
      (n) =>
        isPlainObject(profiles[n]) &&
        profiles[n].driver === "extension" &&
        profiles[n].cdpPort == null,
    )
    .sort()) {
    while (next > controlPort && reserved.has(next)) next -= 1;
    if (next <= controlPort) throw new Error("no extension relay port is free");
    relayPorts.set(name, next);
    reserved.add(next);
    next -= 1;
  }
  const resolved = new Map();
  for (const [name, profile] of Object.entries(profiles)) {
    if (!isPlainObject(profile)) continue;
    resolved.set(
      name,
      resolveOne(name, profile, {
        cdpHost: cdp.host,
        protocol,
        attachOnly: browser.attachOnly === true,
        relayPort: relayPorts.get(name) ?? controlPort + EXTENSION_RELAY_PORT_OFFSET,
        added: added.has(name),
      }),
    );
  }
  return { defaultProfile, profiles: resolved };
}

function resolveOne(name, profile, base) {
  const label = `browser.profiles.${name}`;
  const engine = profile.engine ?? "chromium";
  if (engine !== "chromium" && engine !== "lightpanda") {
    throw new Error(`${label}.engine is not one the gateway knows`);
  }
  if (engine === "lightpanda") {
    const at = endpointOf(profile.cdpUrl, `${label}.cdpUrl`);
    return { name, engine, driver: "openclaw", attachOnly: true, endpoints: [at], ...at };
  }
  const driver =
    profile.driver === "existing-session" || profile.driver === "extension"
      ? profile.driver
      : "openclaw";
  if (driver === "extension") {
    const at = { scheme: "http", host: "127.0.0.1", port: profile.cdpPort ?? base.relayPort };
    return { name, engine, driver, attachOnly: true, endpoints: [at], ...at };
  }
  if (driver === "existing-session") {
    return { name, engine, driver, attachOnly: true, endpoints: mcpEndpoints(profile, label) };
  }
  const raw = trimmed(profile.cdpUrl);
  let port = typeof profile.cdpPort === "number" ? profile.cdpPort : 0;
  let host = base.cdpHost;
  let scheme = base.protocol;
  if (raw && port > 0 && /^wss?:\/\//i.test(raw) && /\/devtools\/browser\//i.test(raw)) {
    host = endpointOf(raw, `${label}.cdpUrl`).host;
  } else if (raw) {
    const at = endpointOf(raw, `${label}.cdpUrl`);
    host = at.host;
    scheme = at.scheme;
    if (at.explicitPort || !port) port = at.port;
  } else if (!port) {
    throw new Error(`${label} must define cdpPort or cdpUrl`);
  }
  const at = { scheme, host, port };
  const attachOnly = profile.attachOnly ?? base.attachOnly;
  return { name, engine, driver, attachOnly: attachOnly === true, endpoints: [at], ...at };
}

const describe = (at) => `${at.scheme}://${at.host}:${at.port}`;

/** The bot whose browser endpoint `at` reaches, if any. */
function ownerOfEndpoint(at, parsed) {
  if (!mayReachThisMachine(at.host)) return undefined;
  return [...parsed.bots.values()].find((bot) => bot.port === at.port);
}

/**
 * The bot a browser call's profile selector reaches, by name or by the
 * endpoint the gateway resolves it to: an omitted selector is the default
 * profile. `unresolved` when the config cannot be read the gateway's way,
 * so no one can tell which browser the call would reach.
 */
export function profileOwner(config, parsed, selector, env = {}) {
  const named = toolString(selector);
  const lowered = named?.toLowerCase() ?? defaultProfileOf(config);
  const byName = parsed.profiles.get(lowered);
  if (byName) return { bot: byName };
  let view;
  try {
    view = resolveBrowserProfiles(config, env);
  } catch {
    return { unresolved: true };
  }
  const profile = view.profiles.get(named ?? view.defaultProfile);
  if (!profile) return {};
  for (const at of profile.endpoints) {
    const bot = ownerOfEndpoint(at, parsed);
    if (bot) return { bot };
  }
  return {};
}

/**
 * Why the gateway's browser configuration does not match the plugin's, one
 * line per problem. Each bot's profile must be a managed Chromium profile
 * that the gateway resolves to exactly the endpoint the plugin uses (host,
 * port, scheme) and starts itself; no other profile, including the default
 * one and the ones the gateway adds by itself, may resolve to a bot's
 * endpoint; and the default profile must not be a bot's.
 */
export function browserConfigProblems(config, parsed, env = {}) {
  const problems = [];
  const browser = isPlainObject(config?.browser) ? config.browser : {};
  const declared = isPlainObject(browser.profiles) ? browser.profiles : {};
  if (parsed.profiles.has(defaultProfileOf(config))) {
    problems.push("browser.defaultProfile must not be a bot's profile");
  }
  let view;
  try {
    view = resolveBrowserProfiles(config, env);
  } catch (error) {
    problems.push(`the browser config cannot be resolved: ${error.message}`);
    return problems;
  }
  for (const bot of parsed.bots.values()) {
    const entry = Object.hasOwn(declared, bot.profile) ? declared[bot.profile] : undefined;
    if (!isPlainObject(entry)) {
      problems.push(`browser.profiles.${bot.profile} is not declared`);
      continue;
    }
    if (entry.cdpPort !== bot.port) {
      problems.push(`browser.profiles.${bot.profile}.cdpPort must be ${bot.port}`);
    }
    if (entry.cdpUrl !== undefined) {
      problems.push(`browser.profiles.${bot.profile} must not set cdpUrl`);
    }
    const resolved = view.profiles.get(bot.profile);
    if (resolved.engine !== "chromium" || resolved.driver !== "openclaw") {
      problems.push(`browser.profiles.${bot.profile} must be a managed Chromium profile`);
      continue;
    }
    if (resolved.attachOnly) {
      problems.push(
        `browser.profiles.${bot.profile} is attach-only: the gateway would attach to whatever answers on its port instead of starting the bot's browser`,
      );
    }
    const mine = { scheme: "http", host: bot.host, port: bot.port };
    if (describe(resolved) !== describe(mine)) {
      problems.push(
        `the gateway resolves browser.profiles.${bot.profile} to ${describe(resolved)}, not the plugin's ${describe(mine)}`,
      );
    }
  }
  for (const profile of view.profiles.values()) {
    for (const at of profile.endpoints) {
      const owner = ownerOfEndpoint(at, parsed);
      if (owner && owner.profile !== profile.name) {
        problems.push(
          `browser.profiles.${profile.name} reaches ${owner.profile}'s browser (${describe(at)})`,
        );
      }
    }
  }
  if (trimmed(browser.cdpUrl)) {
    const owner = ownerOfEndpoint(endpointOf(browser.cdpUrl, "browser.cdpUrl"), parsed);
    if (owner) problems.push(`browser.cdpUrl reaches ${owner.profile}'s browser`);
  }
  return problems;
}
