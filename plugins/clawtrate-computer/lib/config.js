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

/**
 * Why the gateway's browser configuration does not match the plugin's, one
 * line per problem. Each bot's profile must be a managed (`openclaw` driver)
 * profile on exactly the plugin's port, no other profile may use that port,
 * and the default profile must not be a bot's: otherwise a call that omits
 * `profile`, or another profile, would act in a bot's browser.
 */
export function browserConfigProblems(config, parsed) {
  const problems = [];
  const browser = isPlainObject(config?.browser) ? config.browser : {};
  const profiles = isPlainObject(browser.profiles) ? browser.profiles : {};
  if (parsed.profiles.has(defaultProfileOf(config))) {
    problems.push("browser.defaultProfile must not be a bot's profile");
  }
  for (const bot of parsed.bots.values()) {
    const entry = profiles[bot.profile];
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
    if (entry.driver !== undefined && entry.driver !== "openclaw") {
      problems.push(`browser.profiles.${bot.profile} must use the managed openclaw driver`);
    }
    if (entry.engine !== undefined && entry.engine !== "chromium") {
      problems.push(`browser.profiles.${bot.profile} must use the chromium engine`);
    }
  }
  const botPorts = new Map([...parsed.bots.values()].map((bot) => [bot.port, bot.profile]));
  for (const [name, entry] of Object.entries(profiles)) {
    const owner = botPorts.get(isPlainObject(entry) ? entry.cdpPort : undefined);
    if (owner !== undefined && owner !== name) {
      problems.push(`browser.profiles.${name} uses ${owner}'s port`);
    }
    const url = isPlainObject(entry) && typeof entry.cdpUrl === "string" ? entry.cdpUrl : "";
    for (const [port, profile] of botPorts) {
      if (profile !== name && new RegExp(`:${port}(?:/|$)`).test(url)) {
        problems.push(`browser.profiles.${name}.cdpUrl points at ${profile}'s port`);
      }
    }
  }
  if (typeof browser.cdpUrl === "string") {
    for (const [port, profile] of botPorts) {
      if (new RegExp(`:${port}(?:/|$)`).test(browser.cdpUrl)) {
        problems.push(`browser.cdpUrl points at ${profile}'s port`);
      }
    }
  }
  return problems;
}
