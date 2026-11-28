// Whether the gateway's own bot is untouched: the one fact that lets F-562 leave it out of view
// (`gateway-bot.ts`). OpenClaw seeds a bot's folder with `BOOTSTRAP.md` at its first turn and
// deletes it once the bot's own files differ from their templates or a `memory/` folder exists
// (`docs/start/bootstrapping.md`, lines 39-42 on 2026.10.6 and 39-43 on 2026.11.10). So a bot
// whose folder still lists `BOOTSTRAP.md`, or lists every starting file as missing (no turn
// yet), and has no `MEMORY.md`, has never been used. `agents.files.list` reads that at
// `operator.read` on both versions (`core-method-policy`), so every connection may ask.
//
// Every doubt shows the bot: only an answer of the known shape that says untouched hides it. The
// method not offered, an older or unreadable version, a refusal, a lost answer, an answer past
// `FILES_READ_TIMEOUT_MS` and an unknown shape all leave `untouched` null, which `gateway-bot.ts`
// reads as shown. A read still out is not a doubt: while the first read about a bot is out, the
// bot stays out of view, as before this rule, for at most that timeout; so on a gateway whose own
// bot is untouched it never appears, and on one the person used it appears a moment after the
// others. A verdict already held for that bot is kept until a new read answers.

import { openClawAtLeast } from "./gateway-version.ts";
import { asRecord } from "./mapping.ts";

export const FILES_LIST = "agents.files.list";
/** The longest a files read is waited for; past it, the answer counts as lost and the bot shows. */
export const FILES_READ_TIMEOUT_MS = 5_000;
/**
 * Whether an `agents.files.list` answer for `botId` says the bot is untouched: true only for an
 * answer of the known shape naming that bot, whose `BOOTSTRAP.md` is there (or whose every file is
 * missing) and whose `MEMORY.md` is not. Anything else is false, so the bot is shown.
 */
export function filesSayUntouched(answer: unknown, botId: string): boolean {
  const record = asRecord(answer);
  if (!record || !Array.isArray(record.files)) return false;
  if (record.agentId !== undefined && record.agentId !== botId) return false;
  let bootstrap = false;
  let memory = false;
  let anyPresent = false;
  // The starting files both versions list for a bot before its first turn, all missing
  // (`agents.files.list`, a development gateway of 2026.10.6 and of 2026.11.10): an all-missing
  // answer counts as untouched only when it names each of them, however often one appears.
  let agents = false;
  let soul = false;
  let user = false;
  for (const entry of record.files) {
    const file = asRecord(entry);
    if (!file || typeof file.name !== "string") return false;
    if (file.missing !== undefined && typeof file.missing !== "boolean") return false;
    if (file.name === "AGENTS.md") agents = true;
    if (file.name === "SOUL.md") soul = true;
    if (file.name === "USER.md") user = true;
    if (file.missing === true) continue;
    anyPresent = true;
    if (file.name === "BOOTSTRAP.md") bootstrap = true;
    if (file.name === "MEMORY.md") memory = true;
  }
  if (record.files.length === 0 || memory) return false;
  // Every file missing is a bot before its first turn only when the answer names its starting
  // files; a partial or changed answer is a doubt.
  return bootstrap || (!anyPresent && agents && soul && user);
}

type Deps = {
  request: (method: string, params: unknown) => Promise<unknown>;
  /** The connection's generation now; an answer from an older one is dropped. */
  generation: () => number;
  /** The gateway's own version as `hello-ok` reported it. */
  serverVersion: () => string | null | undefined;
  /** The identity of the gateway this connection reached (`gateway.identity.get`), or null. */
  gatewayId: () => string | null;
  /** Publish the verdict: the id of the gateway's own bot when untouched, otherwise null. */
  publish: (untouched: string | null) => void;
  /** How long a read is waited for (`FILES_READ_TIMEOUT_MS`; shorter in tests). */
  timeoutMs?: () => number | undefined;
};

/**
 * Reads the gateway's own bot's files after every bot list, one read at a time, and publishes
 * whether it is untouched. Each answer is bound to the bot it asked about and to the latest bot
 * list: an answer for a bot that is no longer the gateway's own, or overtaken by a newer list, is
 * dropped, and the newest list's bot is read instead.
 */
export class GatewayBotFiles {
  /** Whether the latest hello listed `agents.files.list`; null when it listed no methods. */
  private advertised: boolean | null = null;
  /** Counts every bot list checked: an answer to an older one is dropped. */
  private asked = 0;
  /** The bot the newest bot list wants read, or null when none is to be left out. */
  private wanted: string | null = null;
  /** The generation of the read under way, or null when none is. */
  private reading: number | null = null;
  /** The bot a read last answered about, and the gateway it answered on: its verdict is kept
   * until the next read, and only for that gateway. */
  private answeredFor: string | null = null;
  private answeredOn: string | null = null;

  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  /** The hello's `features.methods`, or null when it gave none. */
  hello(methods: readonly string[] | null): void {
    this.advertised = methods === null ? null : methods.includes(FILES_LIST);
  }

  /** A connection ended or changed: nothing read before counts. */
  reset(): void {
    this.asked += 1;
    this.wanted = null;
    this.answeredFor = null;
    this.answeredOn = null;
    this.deps.publish(null);
  }

  /**
   * After a bot list: `botId` is the gateway's own bot when one could be left out (it isn't
   * `selectionRequired`'s first bot, another bot exists and it has no name of its own), otherwise
   * null.
   */
  check(botId: string | null): void {
    this.asked += 1;
    // Not offered, or a gateway older than the first version this rule was checked on: shown.
    const readable =
      this.advertised !== false && openClawAtLeast(this.deps.serverVersion(), 2026, 10, 6);
    this.wanted = readable ? botId : null;
    if (this.wanted === null) {
      this.deps.publish(null);
      return;
    }
    // No answer about this bot yet: it stays out of view, as before this rule, while it is read.
    // Kept only for the same bot on a gateway confirmed to be the same one: an identity unknown
    // now or when it was read is no match.
    const gatewayId = this.deps.gatewayId();
    const same =
      this.answeredFor === this.wanted && this.answeredOn !== null && this.answeredOn === gatewayId;
    if (!same) this.deps.publish(this.wanted);
    const generation = this.deps.generation();
    // A read under way on this connection reads the newest list's bot when it answers.
    if (this.reading === generation) return;
    void this.read(generation);
  }

  private async read(generation: number): Promise<void> {
    this.reading = generation;
    try {
      while (generation === this.deps.generation()) {
        const asked = this.asked;
        const botId = this.wanted;
        if (botId === null) return;
        let untouched = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const late = new Promise<"late">((resolve) => {
            timer = setTimeout(
              () => resolve("late"),
              this.deps.timeoutMs?.() ?? FILES_READ_TIMEOUT_MS,
            );
          });
          const answer = await Promise.race([
            this.deps.request(FILES_LIST, { agentId: botId }),
            late,
          ]);
          // The timeout's "late" is no answer of the known shape: a doubt, so shown.
          untouched = filesSayUntouched(answer, botId);
        } catch {
          untouched = false;
        } finally {
          clearTimeout(timer);
        }
        if (generation !== this.deps.generation()) return;
        if (asked === this.asked) {
          this.answeredFor = botId;
          this.answeredOn = this.deps.gatewayId();
          this.deps.publish(untouched ? botId : null);
          return;
        }
        // A newer bot list came while this read was out: its bot is read instead.
      }
    } finally {
      if (this.reading === generation) this.reading = null;
    }
  }
}
