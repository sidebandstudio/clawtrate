// The OpenClaw versions the development gateway runs (#609): the pin, which `pnpm dev-gateway
// setup` installs and every pull request tests, and npm's newest, which the OpenClaw latest
// workflow runs through OPENCLAW_BIN. Where the two differ only in form, the generated config,
// the seed, the scripted model and the checks ask `shape()` for the running version's form.
// The running version is the one the gateway itself reports in its hello (`server.version`), or,
// before a gateway runs, the version of the program that will start it. Never a guess.

/** The pin first. A version that is not listed is refused, not run. */
export const OPENCLAW_VERSIONS = ["2026.10.6", "2026.11.10"] as const;
export type OpenclawVersion = (typeof OPENCLAW_VERSIONS)[number];
export const PINNED_OPENCLAW: OpenclawVersion = OPENCLAW_VERSIONS[0];

export function isOpenclawVersion(value: unknown): value is OpenclawVersion {
  return (OPENCLAW_VERSIONS as readonly unknown[]).includes(value);
}

/** The forms that differ between the listed versions, each as the version shows it. */
export type Shape = {
  version: OpenclawVersion;
  /** `agents.defaults.heartbeat` is a key the config accepts. */
  heartbeat: boolean;
  /** The migrations the CLI stamps in `meta.migrations` when it writes the config. */
  migrations: readonly string[];
  /** Tools offered unless denied, on top of the ones every listed version has. */
  extraDeniedTools: readonly string[];
  /** Offered as well: a tool only this version has that a scenario uses (`sessions_create`, `#create-task`). */
  extraAllowedTools: readonly string[];
  /**
   * The background skill review runs after a turn the CLI sent (`gateway call chat.send`).
   * 2026.11.10 reviews a turn only when it was offered `skill_workshop`. A paired client, which
   * has a user profile, is offered it only with `operator.admin` on a gateway with one profile;
   * otherwise `skill_library`, the person's own library, takes its place. The CLI's shared token
   * has no profile, and its turns weren't reviewed either.
   */
  reviewsCliTurns: boolean;
  /** The tools a start with the background skill review allows. */
  skillReviewTools: readonly string[];
  /** Tool results carry their JSON on one line, not indented by two spaces. */
  compactToolJson: boolean;
  /** An item's title names its arguments (`Read from AGENTS.md`), not the tool alone (`Read`). */
  titlesWithArguments: boolean;
  /** A reasoning item ends with a `thinking` event of its own, `phase: "persisted"`, with no text. */
  thinkingPersisted: boolean;
  /** Keys a chat `error` event's `errorDetail` carries that the pinned protocol schema lacks. */
  extraErrorDetail: readonly string[];
  /** `automations` is offered in a paired client's run, not only in the owner's. */
  pairedAutomations: boolean;
  /** The error a run ends with when the model answered with reasoning alone, every time. */
  emptyReplyError: string;
  /** An exec result repeats the command's output in `details.aggregated`. */
  execOutputInDetails: boolean;
  /** An exec result that ran out of time says why in `details.message`. */
  execTimeoutMessage: boolean;
  /** What an exec result says after a command that ran out of time. */
  execTimeoutAdvice: string;
  /** The line an exec result adds after a command a person declined; empty when none. */
  execDeclinedNote: string;
  /**
   * sessions_list's `nextOffset` counts the rows it read, the bot's and others', not only the
   * rows it returned.
   */
  sessionsOffsetCountsRead: boolean;
  /** sessions_list's details shorten each key for display (`agent:…<end>`), not keep it whole. */
  shortSessionKeys: boolean;
  /**
   * Who `createdActor` names for a task a bot started on a person's turn: the bot, or the
   * person (`gateway-owner`) whose turn it was.
   */
  spawnedTaskCreator: "bot" | "owner";
  /**
   * Text in the same model message as a tool call is an `item` of kind `preamble`, and the run's
   * final message is the answer alone. Without them, that text joins the final message.
   */
  preambleItems: boolean;
  /** The final chat event of a turn the gateway ran from its queue carries the reply's message. */
  queuedFinalMessage: boolean;
  /** The gateway runs a queued turn under an id of its own, which it names beside the send's. */
  queuedTurnOwnId: boolean;
  /** A task's row reports a context figure (`totalTokens`) while its first run is still going. */
  contextWhileRunning: boolean;
  /** A picture image_generate made arrives in a turn of the gateway's own, with its text. */
  pictureTurn: boolean;
  /** A turn ends with a visible send of the message tool, without asking the model again. */
  messageSendEndsTurn: boolean;
  /** The pattern of the ticket in a download path `artifacts.download` issues. */
  mediaTicket: string;
  /** The gateway's own tools (`tools.catalog`) beyond 2026.10.6's, and those it no longer has. */
  addedGatewayTools: readonly string[];
  removedGatewayTools: readonly string[];
  /**
   * Which later runs of a task a bot started report back to the task it came from in a turn, as
   * the first run always does: a run a person's message started there, and one a bot's follow-up
   * started. 2026.11.10 notes the follow-up's run in a row of its own instead.
   */
  reportsPersonsRun: boolean;
  reportsFollowUpRun: boolean;
  /** A started task's brief row has the `inter_session` provenance of the task it came from. */
  briefFromTask: boolean;
  /** A hidden helper's sessions_spawn result names its `label`, as a visible task's does. */
  hiddenSpawnLabel: boolean;
  /** A routine as the automations tool returns it names its `ownerProfileId`. */
  routineOwnerProfile: boolean;
};

const SHAPES: Record<OpenclawVersion, Shape> = {
  "2026.10.6": {
    version: "2026.10.6",
    heartbeat: true,
    migrations: ["modelPolicyAllowlist", "utilityModelSeparation"],
    extraDeniedTools: [],
    extraAllowedTools: [],
    skillReviewTools: ["skill_workshop"],
    reviewsCliTurns: true,
    compactToolJson: false,
    titlesWithArguments: true,
    thinkingPersisted: false,
    extraErrorDetail: [],
    pairedAutomations: false,
    emptyReplyError: "⚠️ Agent couldn't generate a response. Please try again.",
    execOutputInDetails: true,
    execTimeoutMessage: false,
    execTimeoutAdvice:
      "Do not automatically rerun non-idempotent commands. Use a higher timeout only when the command is known to be safe to retry.",
    execDeclinedNote: "",
    pictureTurn: true,
    messageSendEndsTurn: false,
    mediaTicket: String.raw`v1\.[A-Za-z0-9._~-]+`,
    addedGatewayTools: [],
    removedGatewayTools: [],
    sessionsOffsetCountsRead: false,
    shortSessionKeys: true,
    spawnedTaskCreator: "bot",
    preambleItems: true,
    queuedFinalMessage: true,
    queuedTurnOwnId: true,
    contextWhileRunning: false,
    reportsPersonsRun: false,
    reportsFollowUpRun: true,
    briefFromTask: false,
    hiddenSpawnLabel: false,
    routineOwnerProfile: false,
  },
  "2026.11.10": {
    version: "2026.11.10",
    heartbeat: false,
    migrations: [
      "modelPolicyAllowlist",
      "utilityModelSeparation",
      "skillWorkshopPlugin",
      "skillLibraryToolSplit",
    ],
    // Offered unless denied, or reaching the network, as DENIED_TOOLS' own are.
    extraDeniedTools: ["skill_library", "deep_research", "github_read", "github_search"],
    extraAllowedTools: ["sessions_create"],
    skillReviewTools: ["skill_workshop", "skill_library"],
    reviewsCliTurns: false,
    compactToolJson: true,
    titlesWithArguments: false,
    thinkingPersisted: true,
    extraErrorDetail: ["providerErrorCode"],
    pairedAutomations: true,
    emptyReplyError: "No answer was returned. Ask again if you still need one.",
    execOutputInDetails: false,
    execTimeoutMessage: true,
    execTimeoutAdvice:
      "Do not automatically rerun commands unless repeating them is safe. Use a higher timeout only when the command is known to be safe to retry.",
    execDeclinedNote: "\nCommand did not run: an operator declined this execution approval.",
    pictureTurn: false,
    messageSendEndsTurn: true,
    mediaTicket: String.raw`[0-9a-f-]{36}%2F[A-Za-z0-9_-]+`,
    addedGatewayTools: [
      "deep_research",
      "github_read",
      "github_search",
      "sessions_create",
      "skill_library",
    ],
    removedGatewayTools: ["heartbeat_respond"],
    sessionsOffsetCountsRead: true,
    shortSessionKeys: false,
    spawnedTaskCreator: "owner",
    preambleItems: false,
    queuedFinalMessage: false,
    queuedTurnOwnId: false,
    contextWhileRunning: true,
    reportsPersonsRun: true,
    reportsFollowUpRun: false,
    briefFromTask: true,
    hiddenSpawnLabel: true,
    routineOwnerProfile: true,
  },
};

/** The form of a listed version; throws for any other. */
export function shapeOf(version: string): Shape {
  if (!isOpenclawVersion(version))
    throw new Error(
      `OpenClaw ${version} is not a version the development gateway runs (${OPENCLAW_VERSIONS.join(", ")}).`,
    );
  return SHAPES[version];
}

let reported: OpenclawVersion | null = null;

/**
 * Record the version that runs, as the gateway or the program that starts it reports it. A
 * process talks to one gateway version at a time; a second, different report is refused.
 * Until a report, the pin's form applies, which is what the unit tests use.
 */
export function useOpenclawVersion(version: string): OpenclawVersion {
  shapeOf(version);
  if (reported !== null && reported !== version)
    throw new Error(`the gateway reported OpenClaw ${version}, after ${reported}`);
  reported = version as OpenclawVersion;
  return reported;
}

/** The running version's form. */
export function shape(): Shape {
  return SHAPES[reported ?? PINNED_OPENCLAW];
}

/** A tool result's JSON as the running version writes it. */
export function toolJson(value: unknown): string {
  return shape().compactToolJson ? JSON.stringify(value) : JSON.stringify(value, null, 2);
}
