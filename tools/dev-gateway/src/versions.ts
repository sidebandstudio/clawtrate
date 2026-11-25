// The OpenClaw versions the development gateway runs (#609), and what differs between them that
// the tool and its checks depend on. The pinned version (docs/decisions.md) is the one the tool
// installs; the other is npm's newest, which Update OpenClaw installs, run through OPENCLAW_BIN.
// Each difference here was observed on that version, so a check keyed on it still asserts one
// exact shape per version.

export const PINNED_VERSION = "2026.10.6";
export const OPENCLAW_VERSIONS = [PINNED_VERSION, "2026.11.10"] as const;
export type OpenclawVersion = (typeof OPENCLAW_VERSIONS)[number];

export function isOpenclawVersion(value: unknown): value is OpenclawVersion {
  return (OPENCLAW_VERSIONS as readonly unknown[]).includes(value);
}

export type VersionFacts = {
  version: OpenclawVersion;
  /** The config takes `agents.defaults.heartbeat`; 2026.11.10 retired heartbeats for automation jobs. */
  heartbeatConfig: boolean;
  /** The `meta.migrations` the gateway records when it writes the config. */
  migrations: readonly string[];
  /** Tools only this version has, denied like DENIED_TOOLS (cli.ts). */
  deniedTools: readonly string[];
  /** Tool results whose text is their details as JSON: indented by two spaces, or compact. */
  toolJson: "indented" | "compact";
};

const FACTS: Record<OpenclawVersion, VersionFacts> = {
  "2026.10.6": {
    version: "2026.10.6",
    heartbeatConfig: true,
    migrations: ["modelPolicyAllowlist", "utilityModelSeparation"],
    deniedTools: [],
    toolJson: "indented",
  },
  "2026.11.10": {
    version: "2026.11.10",
    heartbeatConfig: false,
    migrations: [
      "modelPolicyAllowlist",
      "utilityModelSeparation",
      "skillWorkshopPlugin",
      "skillLibraryToolSplit",
    ],
    // Split from skill_workshop. Left out, the gateway adds it to the list itself when it writes
    // the config, beside skill_workshop.
    deniedTools: ["skill_library"],
    toolJson: "compact",
  },
};

export function factsFor(version: OpenclawVersion): VersionFacts {
  return FACTS[version];
}

/** A value as this version writes it into a tool result's text. */
export function toolJson(facts: VersionFacts, value: unknown): string {
  return facts.toolJson === "indented" ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}
