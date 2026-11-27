// The second guard on what the host keeps works on the source, not on live
// objects: every collection that can outlive the call that made it (a
// `new Map`, `Set`, `WeakMap` or `WeakSet`, an array, or one a factory call
// makes, kept in a class field, at module level, or in a variable a
// later-running function captures, directly or inside a plain object)
// must be either a field the retention registry names (`owners.ts`) or on the
// allowlist below, each entry with its bound or its lifetime in one line.
// `owner-scan.ts` finds them. A false alarm is the intended cost: it adds a line here.

import { ownerClassFields } from "@clawtrate/core";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scan, scanText } from "./owner-scan.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
/** The engine, and the hosts that hold its bridge. */
const SCANNED = ["packages/core/src", "apps/desktop/src/web-host", "apps/desktop/src/main"];

/** Collections kept outside the registry's fields: why each one is bounded. */
const ALLOWED: Record<string, string> = {
  // Static: built once from constants, never grown.
  "packages/core/src/memory.ts:ROOT_MEMORY": "static, two workspace filenames",
  "packages/core/src/bot-names.ts:PLACEHOLDERS": "static, the template's two name placeholders",
  "packages/core/src/bot-names.ts:QUIET_TOOLS":
    "static, the tools whose result is no outside content",
  "packages/core/src/bot-names.ts:FILE_TOOLS": "static, the file tools a source is named for",
  "packages/core/src/bot-names.ts:CONVERSATION_TOOLS":
    "static, the tools that return another conversation's history or results",
  "packages/core/src/bot-names.ts:NAME_WRITES": "static, the tools that write the name line",
  "packages/core/src/bot-names.ts:SOURCES": "static, the five sources a record entry may name",
  "packages/core/src/bot-names.ts:WHOSE":
    "static, the three classifications a record entry may hold",
  "packages/core/src/openclaw-update.ts:UPDATE_PHASES": "static, the gateway's eight update phases",
  "packages/core/src/openclaw-update.ts:RUN_STATUSES": "static, the gateway's five run statuses",
  "packages/core/src/openclaw-update.ts:UPDATE_ASK_WAITS_MS":
    "static, the four waits between asks about a press whose answer was lost",
  "packages/core/src/openclaw-update.ts:SETTLED": "static, the five outcomes that are final",
  "packages/core/src/openclaw-update.ts:CANNOT_UPDATE":
    "static, the reason codes a gateway gives for not updating itself",
  "apps/desktop/src/main/mac-install.ts:RESULTS": "static, the helper's eight result lines",
  "apps/desktop/src/main/mac-install.ts:HELPER_STEPS": "static, the helper's eleven step names",
  "packages/core/src/approvals.ts:APPROVAL_KINDS": "static, three kinds",
  "packages/core/src/origins.ts:OTHER_TOOL_VIA":
    "static, the gateway's five createdVia values for other tools",
  "packages/core/src/origins.ts:OTHER_TOOL_CLASS":
    "static, the gateway's eleven route classes of other surfaces",
  "packages/core/src/computer.ts:BUSY_REASONS": "static, the plugin's five busy codes",
  "packages/core/src/stop-words.ts:STOP_NOW": "static, the three ways of typing Stop now",
  "packages/core/src/file-paths.ts:FILE_TOOLS": "static, four tool names",
  "packages/core/src/file-paths.ts:CHANGE_TOOLS": "static, three tool names",
  "packages/core/src/file-paths.ts:COMMAND_TOOLS": "static, one tool name",
  "packages/core/src/action-words.ts:MEDIA.image_generate": "static, three words for one medium",
  "packages/core/src/action-words.ts:MEDIA.video_generate": "static, three words for one medium",
  "packages/core/src/action-words.ts:MEDIA.music_generate": "static, three words for one medium",
  "packages/core/src/action-words.ts:SCHEDULE.weekdays": "static, the seven weekday names",
  "packages/core/src/actions.ts:ARG_KEYS": "static, the argument keys the reading reads",
  "packages/core/src/file-paths.ts:filePathsOf>paths":
    "one call's paths, at most `MAX_STEP_PATHS`, returned to the caller",
  "packages/core/src/files.ts:TASK_PICTURE_TYPES": "static, five media types",
  "packages/core/src/mapping.ts:NOT_FILES": "static, six block types that are never a file",
  "packages/core/src/mapping.ts:KNOWN_FILES": "static, three block types that hand a file over",
  "packages/core/src/mapping.ts:RUN_STATE_FIELDS":
    "static, the two run-state fields of a session row",
  "packages/core/src/not-run.ts:PREFIXES":
    "static, three patterns the gateway puts before a reason",
  "packages/core/src/pictures.ts:SIGNATURES.image/png": "static, one byte signature",
  "packages/core/src/pictures.ts:SIGNATURES.image/jpeg": "static, one byte signature",
  "packages/core/src/pictures.ts:SIGNATURES.image/gif": "static, two byte signatures",
  "packages/core/src/pictures.ts:SIGNATURES.image/webp": "static, one byte signature",
  "packages/core/src/files.ts:PICTURE_EXTENSIONS": "static, nine extensions",
  "packages/core/src/files.ts:AUDIO_EXTENSIONS": "static, nine extensions",
  "packages/core/src/files.ts:VIDEO_EXTENSIONS": "static, six extensions",
  "packages/core/src/files.ts:SCRIPT_EXTENSIONS": "static, four extensions",
  "packages/core/src/files.ts:DOCUMENT_EXTENSIONS": "static, twenty-three extensions",
  "packages/core/src/approvals.ts:DECISIONS": "static, three decisions",
  "packages/core/src/cards.ts:T3_CODE_TOOLS": "static, T3 Code's seven tool names",
  "packages/core/src/client.ts:REQUESTED_SCOPES": "static, one scope",
  "packages/core/src/client.ts:CLIENT_CAPS": "static, one cap",
  "packages/core/src/client.ts:APPROVAL_CAPS": "static, three caps",
  "packages/core/src/client.ts:APPROVAL_SOURCES": "static, three list readers",
  "packages/core/src/client.ts:NAMED_CONNECT_CODES": "static, the pinned protocol's connect codes",
  "packages/core/src/client.ts:OFFER_ANSWERS": "static, the five answers to the full-control offer",
  "packages/core/src/runs.ts:TERMINAL_RUN_STATES": "static, the terminal run states",
  "packages/core/src/runs.ts:TIMEOUT_PHASES": "static, five phases",
  "packages/core/src/runs.ts:HARD_TIMEOUT_PHASES": "static, three phases",
  "packages/core/src/approval-refusals.ts:REFUSED_DECISION_ANSWERS":
    "static, the six answers that establish a decision was not applied",
  "packages/core/src/approval-refusals.ts:LEGACY": "static, two method names",
  "packages/core/src/runs.ts:UNORDINARY_QUESTION_FIELDS":
    "static, the eight question fields the ordinary card cannot show",
  "packages/core/src/scopes.ts:READ_SCOPES": "static, one scope",
  "packages/core/src/scopes.ts:INTERACTIVE_SCOPES": "static, four scopes",
  "packages/core/src/scopes.ts:ADMIN_SCOPES": "static, five scopes",
  "packages/core/src/scopes.ts:FULL_SCOPES": "static, six scopes",
  "apps/desktop/src/main/secret-box.ts:RECOVERY_BUTTONS": "static, two button labels",
  "packages/core/src/accounts-engine.ts:CERTAIN_REFUSALS": "static, seven error codes",
  "packages/core/src/accounts.ts:KIND_RECORDS": "static, the four kinds Clawtrate records",
  "packages/core/src/machines.ts:NODE_APPROVALS_COMMANDS": "static, two command names",
  "packages/core/src/machines.ts:DEFAULTS_CHOICES":
    "static, the four choices of a machine's defaults",
  "packages/core/src/machines.ts:KNOWN_HOSTS": "static, the four exec hosts",
  "packages/core/src/machines.ts:PLACEMENT_PARTS": "static, the five parts of a bot's placement",
  "packages/core/src/machines.ts:readMachines>places":
    "one read's command place per listed bot, at most `MAX_BOTS`, gone when it returns",
  "packages/core/src/accounts-engine.ts:complete>missing":
    "one creation's steps that did not land, at most four, gone when it returns",
  "packages/core/src/accounts-engine.ts:complete>errors":
    "the words for those steps, one each, gone when it returns",
  "packages/core/src/accounts-engine.ts:readAll>sent":
    "one accounts read's number per listed bot, as its request was sent, at most `MAX_BOTS`, gone when it returns",
  "packages/core/src/scopes.ts:IMPLIED_BY_WRITE": "static, the scopes write implies",
  "packages/core/src/state-bounds.ts:SESSION_ROW_FIELDS": "static, the twenty-one fields read",
  "packages/core/src/state-bounds.ts:SESSION_ROW_IDS": "static, five field names",
  // Static templates: initial or empty values inside plain objects, copied, never grown.
  "packages/core/src/approvals.ts:DEFAULT_DECISIONS.exec": "static, three decisions",
  "packages/core/src/approvals.ts:DEFAULT_DECISIONS.plugin": "static, two decisions",
  "packages/core/src/approvals.ts:DEFAULT_DECISIONS.system-agent": "static, two decisions",
  "packages/core/src/approvals.ts:NO_ATTEMPTS.inFlight": "static, an empty list copied on write",
  "packages/core/src/runs.ts:emptyActivity.runs": "static, an empty list copied on write",
  "packages/core/src/runs.ts:emptyActivity.outbox": "static, an empty list copied on write",
  "packages/core/src/runs.ts:emptyActivity.questions": "static, an empty list copied on write",
  "packages/core/src/runs.ts:emptyActivity.approvals": "static, an empty list copied on write",
  "packages/core/src/types.ts:initialScopeUpgrade.scopes": "static, an empty list copied on write",
  "packages/core/src/types.ts:initialConnectionState.scopes":
    "static, an empty list copied on write",
  "packages/core/src/types.ts:initialConnectionState.requestedScopes":
    "static, an empty list copied on write",
  "packages/core/src/types.ts:initialState.bots": "static, an empty list copied on write",
  "packages/core/src/types.ts:initialState.unroutedApprovals":
    "static, an empty list copied on write",
  "packages/core/src/types.ts:initialState.creations": "static, an empty list copied on write",
  "packages/core/src/types.ts:initialState.computer.control":
    "static, an empty list copied on write",
  "packages/core/src/computer.ts:initialComputerState.control":
    "static, an empty list copied on write",
  "packages/core/src/computer.ts:readTabs>tabs":
    "one answer; the tabs it lists, cut to `MAX_COMPUTER_TABS` before they are kept in the pane",
  "packages/core/src/computer.ts:stopTask>sent.runIds":
    "the empty list while the stop is sent; the answer replaces it, never grows it",
  "packages/core/src/computer.ts:stopTask>stop.runIds":
    "one answer; the runs it names, cut to `MAX_STOPPED_RUNS` before they are kept in the pane",
  "packages/core/src/routines.ts:initialRoutinesState.routines":
    "the empty list before the first read; the state replaces it, never grows it",
  "packages/core/src/accounts.ts:initialAccountsState.accounts":
    "static, an empty list copied on write",
  "packages/core/src/accounts.ts:initialAccountsState.methods":
    "static, an empty list copied on write",
  "packages/core/src/accounts.ts:initialAccountsState.keyProviders":
    "static, an empty list copied on write",
  "packages/core/src/accounts.ts:initialAccountsState.models":
    "static, an empty list copied on write",
  "packages/core/src/accounts.ts:initialAccountsState.modelsCut":
    "static, an empty list copied on write",
  "packages/core/src/accounts.ts:initialAccountsState.bindings":
    "static, an empty list copied on write",
  "packages/core/src/usage.ts:initialUsage.budgets": "static, an empty list copied on write",
  "packages/core/src/usage.ts:initialUsage.counts": "static, an empty list copied on write",
  "packages/core/src/usage.ts:initialUsage.limits.providers":
    "static, an empty list copied on write",
  // One read: what a usage report or a count gathers while it is read, returned and dropped.
  "packages/core/src/usage-engine.ts:inTurn>out":
    "one read: the answers of one batch of usage requests, returned to its caller",
  "packages/core/src/usage-engine.ts:sources>named":
    "one read: the runs the sending tasks' results name, dropped when the report is answered",
  // Values that go into the bounded state, captured only by an update that runs at once.
  "packages/core/src/client.ts:completeCreation>message.attachments":
    "the new outgoing message's files, empty; kept only in the outbox, under its bound",
  "packages/core/src/runs.ts:applyQuestionRequested>card.settledBy":
    "the new question card's settling records, empty; kept only in the card, under its bound",
  // Weak: an entry lives only as long as the object it is keyed by.
  "packages/core/src/client.ts:connectionWrites":
    "weak, keyed by the host storage shared by its clients",
  "packages/core/src/bounds.ts:bounded": "weak, keyed by retained objects",
  "packages/core/src/bounds.ts:draws": "weak, keyed by bounds, which are static",
  "packages/core/src/runs.ts:sizes": "weak, keyed by retained objects",
  "packages/core/src/bounds.ts:drawsOn>out":
    "static, one set of pool names per bound, kept in `draws`",
  // One call: made and dropped within one pure function.
  "packages/core/src/action-feed.ts:groupFeed>owner":
    "one call; the owner of each reasoning entry of the record being grouped",
  "packages/core/src/actions.ts:readableOf>rows": "one call; the rows of one opened card",
  "packages/core/src/actions.ts:readCache":
    "a WeakMap keyed by call objects: each entry goes when its call is no longer held",
  // Capped.
  "packages/core/src/bounds.ts:unknownKeys":
    "capped at `MAX_UNKNOWN_KEYS` (64) keys of 96 characters",
  // One read: kept while one list read is in flight, then dropped.
  "packages/core/src/client.ts:afterActivityOnce>steered":
    "transient, the held messages released as steers in one synchronous update, at most the task's outbox (16)",
  "packages/core/src/client.ts:keepLinkedRuns>linked":
    "one call; the run ids other followed tasks' sends name, at most `MAX_TRACKED_TASKS` × `MAX_LINKED_RUNS`, dropped when it returns",
  "packages/core/src/client.ts:backfillApprovalKind>pendingBefore":
    "one list read; the task's pending approvals, at most `MAX_PENDING_APPROVAL_COUNT`",
  "packages/core/src/client.ts:backfillApprovalKind>mine":
    "one list read; the bounded cards of that list that belong to the task",
  "packages/core/src/client.ts:backfillQuestions>pendingBefore":
    "one list read; the task's pending questions, at most `MAX_PENDING_QUESTIONS_PER_TASK`",
  "packages/core/src/client.ts:readRecipientRuns>historyIds":
    "one history read; the run ids that read established, at most 40 messages' runs, dropped when it returns",
  "packages/core/src/client.ts:readRecipientRuns>activeBefore":
    "one history read; the run ids active before it was asked, at most the named ids', dropped when it returns",
  "packages/core/src/client.ts:botDeleteContext>listedUnder":
    "one delete; the bot each listed task is under as the delete is sent, at most `MAX_LISTED_TASKS`, dropped with the context",
  "packages/core/src/client.ts:readRecipientRuns>inferred":
    "one history read; the run ids whose end that read does not establish, at most 40 messages' runs, dropped when it returns",
  // The renderer's side of the web bridge, in a browser tab, not the host.
  "packages/core/src/remote-bridge.ts:createRemoteBridge>listeners":
    "renderer; one per subscription, removed by its unsubscribe",
  "packages/core/src/remote-bridge.ts:createRemoteBridge>pending":
    "renderer; commands awaiting an answer, each answered by the host or rejected when the socket closes",
  "packages/core/src/remote-bridge.ts:createRemoteBridge>wanted":
    "renderer; the tasks the host accepted as open, at most `MAX_VIEWER_OPEN_TASKS`, plus opens in flight",
  "packages/core/src/remote-bridge.ts:createRemoteBridge>reopenRefusals":
    "renderer; one per listener for refused reopens, removed by its unsubscribe",
  // Hosts.
  "apps/desktop/src/main/index.ts:main>sessions":
    "one bridge session per open window, removed when it closes",
  "apps/desktop/src/web-host/server.ts:<anonymous>>chunks":
    "one upload's body while it arrives, within its declared length, dropped at the deadline",
  // The SSH transport of "Another computer".
  "apps/desktop/src/main/ssh/forward.ts:BACKOFF_MS": "static, five delays",
  "apps/desktop/src/main/update/feed.ts:FILE_KEYS": "static, the three artifacts a feed names",
  "apps/desktop/src/main/update/address.ts:GITHUB_RELEASE_ASSETS.assetOrigins":
    "static, the one host GitHub redirects a release download to",
  "apps/desktop/src/main/update/fetch.ts:REDIRECTS": "static, the five redirect statuses",
  "apps/desktop/src/main/ssh/known-hosts.ts:KEY_TYPES": "static, seven key types",
  "apps/desktop/src/main/ssh/look.ts:PROGRAM_PLACES": "static, five fixed places",
  "apps/desktop/src/main/ssh/person-config.ts:TAKEN": "static, the eight settings taken",
  "apps/desktop/src/main/ssh/person-config.ts:REFUSED": "static, the settings refused by name",
  "apps/desktop/src/main/ssh/person-config.ts:IGNORED": "static, the settings left out",
  "apps/desktop/src/main/ssh/person-config.ts:DEFAULT_IDENTITIES": "static, five key names",
  "apps/desktop/src/main/ssh/world.ts:WINDOWS_ENV": "static, fifteen variable names",
  "apps/desktop/src/main/ssh/run.ts:<anonymous>>out":
    "one ssh run's standard output, at most its `maxStdout` bytes, gone when the run ends",
  "apps/desktop/src/main/ssh/run.ts:<anonymous>>err":
    "one ssh run's error output, at most its `maxStderr` bytes, gone when the run ends",
  "apps/desktop/src/main/ssh/run.ts:closed": "weak, dies with the child processes it names",
  "apps/desktop/src/main/ssh/transport.ts:startForward>listening":
    "one forward process's listener from its supervisor, gone with the process",
  "apps/desktop/src/main/ssh/transport.ts:startForward>exits":
    "one forward process's listener from its supervisor, gone with the process",
  // The avatar spec (avatar.ts): constant part lists, geometry and keyframes, and one bounded cache.
  "packages/core/src/avatar.ts:BEFORE_PALETTE": "static, eight PNG chunk types",
  "packages/core/src/avatar.ts:BEFORE_DATA": "static, six PNG chunk types",
  "packages/core/src/avatar.ts:AFTER_PALETTE": "static, three PNG chunk types",
  "packages/core/src/avatar.ts:AVATAR_FAMILIES": "static, one avatar part or state list",
  "packages/core/src/avatar.ts:CLAWLING_BODIES": "static, one avatar part or state list",
  "packages/core/src/avatar.ts:CLAWLING_EYES": "static, one avatar part or state list",
  "packages/core/src/avatar.ts:CLAWLING_CLAWS": "static, one claw's two factors",
  "packages/core/src/avatar.ts:SHELLFOLK_SHELLS": "static, one avatar part or state list",
  "packages/core/src/avatar.ts:LANTERN_BODIES": "static, one avatar part or state list",
  "packages/core/src/avatar.ts:LANTERN_LURES": "static, one lure's ball",
  "packages/core/src/avatar.ts:LANTERN_EYES": "static, one avatar part or state list",
  "packages/core/src/avatar.ts:AVATAR_STATES": "static, one avatar part or state list",
  "packages/core/src/avatar.ts:PNG_SIGNATURE": "static, the eight bytes that start a PNG",
  "packages/core/src/avatar.ts:read": "the pictures already read, at most 64, oldest dropped first",
  "packages/core/src/avatar.ts:SMOOTH": "static, one easing curve",
  "packages/core/src/avatar.ts:AVATAR_MOTIONS.blink.easing":
    "static, one motion's keyframes or easing",
  "packages/core/src/avatar.ts:AVATAR_MOTIONS.blink-large.easing":
    "static, one motion's keyframes or easing",
  "packages/core/src/avatar.ts:AVATAR_MOTIONS.bob.frames":
    "static, one motion's keyframes or easing",
  "packages/core/src/avatar.ts:AVATAR_MOTIONS.lean.frames":
    "static, one motion's keyframes or easing",
  "packages/core/src/avatar.ts:AVATAR_MOTIONS.hop.easing":
    "static, one motion's keyframes or easing",
  "packages/core/src/avatar.ts:AVATAR_MOTIONS.hop.frames":
    "static, one motion's keyframes or easing",
  "packages/core/src/avatar.ts:AVATAR_MOTIONS.snap.easing":
    "static, one motion's keyframes or easing",
  "packages/core/src/avatar.ts:AVATAR_MOTIONS.snap.frames":
    "static, one motion's keyframes or easing",
  "packages/core/src/avatar.ts:AVATAR_MOTIONS.crawl.frames":
    "static, one motion's keyframes or easing",
  "packages/core/src/avatar.ts:AVATAR_MOTIONS.ping.easing":
    "static, one motion's keyframes or easing",
  "packages/core/src/avatar.ts:AVATAR_MOTIONS.ping.frames":
    "static, one motion's keyframes or easing",
  "packages/core/src/avatar.ts:AVATAR_MOTIONS.glow.easing":
    "static, one motion's keyframes or easing",
  "packages/core/src/avatar.ts:AVATAR_MOTIONS.glow.frames":
    "static, one motion's keyframes or easing",
  "packages/core/src/avatar.ts:CLAWLING_BODY.dome.shoulders":
    "static, one body's three coordinates",
  "packages/core/src/avatar.ts:CLAWLING_BODY.dome.stalks": "static, one body's three coordinates",
  "packages/core/src/avatar.ts:CLAWLING_BODY.tall.shoulders":
    "static, one body's three coordinates",
  "packages/core/src/avatar.ts:CLAWLING_BODY.tall.stalks": "static, one body's three coordinates",
  "packages/core/src/avatar.ts:CLAWLING_BODY.wide.shoulders":
    "static, one body's three coordinates",
  "packages/core/src/avatar.ts:CLAWLING_BODY.wide.stalks": "static, one body's three coordinates",
  "packages/core/src/avatar.ts:CLAWLING_BODY.round.shoulders":
    "static, one body's three coordinates",
  "packages/core/src/avatar.ts:CLAWLING_BODY.round.stalks": "static, one body's three coordinates",
  "packages/core/src/avatar.ts:CLAWLING_CLAW.even.left": "static, one claw's two factors",
  "packages/core/src/avatar.ts:CLAWLING_CLAW.even.right": "static, one claw's two factors",
  "packages/core/src/avatar.ts:CLAWLING_CLAW.fiddler.left": "static, one claw's two factors",
  "packages/core/src/avatar.ts:CLAWLING_CLAW.fiddler.right": "static, one claw's two factors",
  "packages/core/src/avatar.ts:CLAWLING_CLAW.big.left": "static, one claw's two factors",
  "packages/core/src/avatar.ts:CLAWLING_CLAW.big.right": "static, one claw's two factors",
  "packages/core/src/avatar.ts:LANTERN_BODY.round.eyes": "static, one body's eye coordinates",
  "packages/core/src/avatar.ts:LANTERN_BODY.bell.eyes": "static, one body's eye coordinates",
  "packages/core/src/avatar.ts:LANTERN_BODY.oval.eyes": "static, one body's eye coordinates",
  "packages/core/src/avatar.ts:LANTERN_BODY.box.eyes": "static, one body's eye coordinates",
  "packages/core/src/avatar.ts:LANTERN_LURE.hook.ball": "static, one lure's ball",
  "packages/core/src/avatar.ts:LANTERN_LURE.flick.ball": "static, one lure's ball",
  "packages/core/src/avatar.ts:LANTERN_LURE.wave.ball": "static, one lure's ball",
  "packages/core/src/avatar.ts:LANTERN_LURE.reach.ball": "static, one lure's ball",
  // What a Claw wears (#302): the slot lists, the hat's tip, the Lantern's headphone cups, and one pose's worn shapes.
  "packages/core/src/avatar.ts:AVATAR_HEADWEAR": "static, one accessory list",
  "packages/core/src/avatar.ts:AVATAR_FACEWEAR": "static, one accessory list",
  "packages/core/src/avatar.ts:AVATAR_NECKWEAR": "static, one accessory list",
  "packages/core/src/avatar.ts:SLOTS": "static, the three accessory slots",
  "packages/core/src/avatar.ts:WEAR_KEYS": "static, the three slots and the trim",
  "packages/core/src/avatar.ts:AVATAR_MOTIONS.tip.easing":
    "static, one motion's keyframes or easing",
  "packages/core/src/avatar.ts:AVATAR_MOTIONS.tip.frames":
    "static, one motion's keyframes or easing",
  "packages/core/src/avatar.ts:LANTERN_HEADPHONES.round.left": "static, one headphone cup's centre",
  "packages/core/src/avatar.ts:LANTERN_HEADPHONES.round.right":
    "static, one headphone cup's centre",
  "packages/core/src/avatar.ts:LANTERN_HEADPHONES.bell.left": "static, one headphone cup's centre",
  "packages/core/src/avatar.ts:LANTERN_HEADPHONES.bell.right": "static, one headphone cup's centre",
  "packages/core/src/avatar.ts:LANTERN_HEADPHONES.oval.left": "static, one headphone cup's centre",
  "packages/core/src/avatar.ts:LANTERN_HEADPHONES.oval.right": "static, one headphone cup's centre",
  "packages/core/src/avatar.ts:LANTERN_HEADPHONES.box.left": "static, one headphone cup's centre",
  "packages/core/src/avatar.ts:LANTERN_HEADPHONES.box.right": "static, one headphone cup's centre",
  "packages/core/src/avatar.ts:wornAt>placed": "per call, at most three shapes for one pose",
  "packages/core/src/guides.ts:applyGuidesChange>errors":
    "one call; one sentence per instructions file it changed, returned to the caller",
  "packages/core/src/guides.ts:applyGuidesChange>onList":
    "one call; the bot ids of the one agents.list it read, dropped when it returns",
  "packages/core/src/guides.ts:applyGuidesChange>kept":
    "one call; the bot ids of the one agents.list it read and the record's, returned in the record",
  "packages/core/src/guides.ts:applyGuidesChange>refused":
    "one call; a reason per bot of the one agents.list it read, returned in the record",
  "packages/core/src/guides.ts:applyGuidesChange>missing":
    "one call; the folders of the one agents.list it read, returned to the caller",
  "packages/core/src/guides.ts:applyGuidesChange>elsewhere":
    "one call; at most MAX_GUIDES_HISTORY_BOTS (512) bot ids of the one gateway history it read, dropped when it returns",
  "packages/core/src/guides.ts:applyGuidesChange>held":
    "one call; the bot ids of the one agents.list it read, saved to the gateway's history and dropped when it returns",
  "packages/core/src/guides.ts:recordRemoval>holding":
    "one call; the folders of the one agents.list its change read, returned to that change",
  "packages/core/src/guides.ts:readGuidesLimits>shown":
    "one call; the bot ids of the one agents.list its caller read, held by the limit function that call returns",
};

describe("the source keeps no collection outside the registry", () => {
  const found = scan(
    SCANNED.map((dir) => `${root}${dir}`),
    root,
  );
  const fields = ownerClassFields();

  it("every class field holding a collection is one the registry names", () => {
    const unnamed = found
      .filter((each) => each.kind === "field")
      .filter((each) => !(fields[each.owner!] ?? []).includes(each.name))
      .map((each) => each.where);
    expect([...new Set(unnamed)]).toEqual([]);
  });

  it("every collection kept at module level or in a closure is on the allowlist, with its reason", () => {
    const unlisted = found
      .filter((each) => each.kind !== "field" && !(each.where in ALLOWED))
      .map((each) => `${each.where} (line ${each.line})`);
    expect(unlisted).toEqual([]);
  });

  it("names nothing that is no longer there", () => {
    const where = new Set(found.map((each) => each.where));
    expect(Object.keys(ALLOWED).filter((each) => !where.has(each))).toEqual([]);
    for (const [name, list] of Object.entries(fields)) {
      for (const field of list)
        expect(
          where.has(found.find((each) => each.owner === name && each.name === field)?.where ?? ""),
          `${name}.${field}`,
        ).toBe(true);
    }
  });

  it("finds a collection a closure keeps, as the review's hidden store map did", () => {
    const text = `
      export function createStore() {
        let value = 0;
        const hidden = new Map<string, string>();
        return { get: () => { hidden.set("k", "v"); return value; } };
      }
      export function local(items: number[]) {
        const seen = new Set<number>();
        items.forEach((item) => seen.add(item));
        return seen.size;
      }
      class Grown { private readonly added: string[] = []; }
      const moduleLevel = new WeakSet<object>();
    `;
    expect(scanText("probe.ts", text).map((each) => each.where)).toEqual([
      "probe.ts:createStore>hidden",
      "probe.ts:Grown.added",
      "probe.ts:moduleLevel",
    ]);
  });

  it("finds a collection held inside a plain object, and one a factory call makes, as the review's bypasses did", () => {
    const text = `
      const reviewBox = { kept: new Map<string, string>(), deeper: { list: [] as string[] } };
      const made = Array.from({ length: 0 }, () => "");
      const table = Object.fromEntries([["a", 1]]);
      export function createNormalizer() {
        const box = { seen: new Set<string>() };
        return (value: string) => { box.seen.add(value); return value; };
      }
      class Holder { private readonly state = { queue: new Map<string, number>() }; }
    `;
    expect(scanText("probe.ts", text).map((each) => each.where)).toEqual([
      "probe.ts:reviewBox.kept",
      "probe.ts:reviewBox.deeper.list",
      "probe.ts:made",
      "probe.ts:table",
      "probe.ts:createNormalizer>box.seen",
      "probe.ts:Holder.state.queue",
    ]);
  });
});
