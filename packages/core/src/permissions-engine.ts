// What a bot may do, read and written on the client's connection
// (docs/design/controls.md sections 2 to 5; `permissions.ts` reads the
// answers). A read is answered and kept nowhere; the one thing kept is this
// client's last read of the rules plugin's rules, by scope, for the page to
// say which rules aren't held while the plugin does not answer (section 2).
//
// Writes need admin and are refused below it before anything is sent. Each
// write is read back, and its answer is what the read-back shows: a save is
// "saved" only when the line read back shows the choice; a failure in the
// middle answers with what the gateway has now.

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { AdminNeededError } from "./accounts-engine.ts";
import { asRecord, type RawRecord } from "./mapping.ts";
import {
  choiceRefusal,
  choiceShown,
  denyWrite,
  EVERY_BOT,
  execWrite,
  hasOwnAsk,
  keptScope,
  type KeptScope,
  permissionsView,
  pluginHolds,
  readToolCatalog,
  readOffered,
  readScope,
  readStatus,
  readToolSettings,
  RULES_GET_METHOD,
  RULES_SET_METHOD,
  RULES_STATUS_METHOD,
  rulesForSet,
  type BotPermissions,
  type CatalogTool,
  type ConfigWrite,
  type Offered,
  type PermissionChoice,
  type PermissionFacts,
  type PermissionLine,
  type RulesPluginStatus,
  type RulesScope,
  type RulesSource,
  type ToolSettings,
} from "./permissions.ts";

/** Reads of a bot's permissions at once; one more is refused. */
export const MAX_PERMISSION_READS = 4;
/** Scopes of the rules plugin whose last read this client keeps: every bot's, and the 8 bots read last. */
export const MAX_KEPT_RULE_SCOPES = 9;

/** A request to the gateway. */
export type GatewayRequest = (
  method: string,
  params: unknown,
  options?: { timeoutMs?: number },
) => Promise<unknown>;

export type PermissionsContext = {
  /**
   * Requests to the gateway connected now. One read or one write uses one: when
   * the connection changes, it sends nothing more and drops the answers still
   * to come, so no part of a write reaches another gateway.
   */
  session(): GatewayRequest;
  connected(): boolean;
  admin(): boolean;
  /** Whether the gateway's method list (`hello-ok.features.methods`) names the plugin's methods. */
  rulesMethods(): boolean | null;
  /** The bot's most recently updated task, for `tools.effective`; null before its first. */
  latestTask(botId: string): string | null;
  now(): number;
};

/** A write's answer: what the read-back shows, never what was meant. */
export type PermissionWrite = {
  /**
   * `saved` only when a read after the write shows it; `unconfirmed` when the
   * gateway's answer to the write, or the read after it, was lost; `failed`
   * when the gateway refused it or it was never sent. `partial`: of a choice
   * made in two writes, the rules plugin's was saved and the settings' was not
   * (`error` says why).
   */
  outcome: "saved" | "not-shown" | "unconfirmed" | "conflict" | "failed" | "partial";
  error: string | null;
  /** What the gateway has now, or null when that read failed too. */
  view: BotPermissions | null;
};

export type PermissionBase = { configHash: string | null; rulesVersion: number | null };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Read = {
  facts: PermissionFacts;
  view: BotPermissions;
};

export class PermissionsEngine {
  private readonly ctx: PermissionsContext;
  /** This client's last read of each scope of the rules plugin, newest last. */
  private readonly kept = new Map<string, KeptScope>();
  private reads = 0;
  private writing = false;

  constructor(ctx: PermissionsContext) {
    this.ctx = ctx;
  }

  /** A gateway switch: nothing of another gateway's rules is kept. */
  reset(): void {
    this.kept.clear();
  }

  private keep(id: string, scope: RulesScope | null, readAt: number): void {
    this.kept.delete(id);
    this.kept.set(id, keptScope(scope, readAt));
    // The scope for every bot is read with every bot's and stays; the bots' give way oldest first.
    while (this.kept.size > MAX_KEPT_RULE_SCOPES) {
      const oldest = [...this.kept.keys()].find((key) => key !== EVERY_BOT);
      if (oldest === undefined) break;
      this.kept.delete(oldest);
    }
  }

  /** Whether the write being made has sent a request that changes something. */
  private writeSent = false;
  /** Whether the write being made has had the rules plugin's part saved. */
  private rulesSaved = false;

  /** One bot's permissions, read now. */
  async read(botId: string): Promise<BotPermissions> {
    return (await this.readAll(botId, this.ctx.session())).view;
  }

  private async readAll(botId: string, request: GatewayRequest): Promise<Read> {
    if (!this.ctx.connected()) throw new Error("Not connected to the gateway.");
    if (this.reads >= MAX_PERMISSION_READS)
      throw new Error(
        "Clawtrate is already reading four bots' permissions. Try again in a moment.",
      );
    this.reads += 1;
    try {
      const { ctx } = this;
      const key = ctx.latestTask(botId);
      const [config, catalog, offered, plugin] = await Promise.all([
        request("config.get", {}),
        request("tools.catalog", { agentId: botId }),
        key
          ? request("tools.effective", { sessionKey: key }).then(
              (answer): Offered => readOffered(answer, key),
              (error: unknown): Offered => ({ status: "failed", reason: message(error) }),
            )
          : Promise.resolve<Offered>({ status: "no-task" }),
        this.status(request),
      ]);
      const settings = readToolSettings(config, botId);
      const tools = readToolCatalog(catalog);
      const { rules, bot, every } = await this.rules(request, botId, plugin);
      const facts: PermissionFacts = {
        botId,
        settings,
        catalog: tools,
        offered,
        plugin,
        rules,
        botScope: bot,
        everyScope: every,
        now: ctx.now(),
      };
      return { facts, view: permissionsView(facts) };
    } finally {
      this.reads -= 1;
    }
  }

  private async status(request: GatewayRequest): Promise<RulesPluginStatus> {
    const listed = this.ctx.rulesMethods();
    if (listed === false) return { kind: "unavailable" };
    if (listed === null) return { kind: "unchecked" };
    try {
      return readStatus(await request(RULES_STATUS_METHOD, {}), this.ctx.now());
    } catch (error) {
      return { kind: "stopped", reason: message(error), answered: false };
    }
  }

  /** The bot's and every bot's rules: read now while the plugin reads them, else this client's last read. */
  private async rules(
    request: GatewayRequest,
    botId: string,
    plugin: RulesPluginStatus,
  ): Promise<{ rules: RulesSource; bot: RulesScope | null; every: RulesScope | null }> {
    if (plugin.kind === "running" && plugin.rules !== "lost") {
      try {
        const [bot, every] = await Promise.all([
          request(RULES_GET_METHOD, { scope: botId }),
          request(RULES_GET_METHOD, { scope: EVERY_BOT }),
        ]);
        const readAt = this.ctx.now();
        const botScope = readScope(bot, botId);
        const everyScope = readScope(every, EVERY_BOT);
        this.keep(botId, botScope, readAt);
        this.keep(EVERY_BOT, everyScope, readAt);
        return { rules: { from: "now", readAt }, bot: botScope, every: everyScope };
      } catch {
        // Not read now: what this client read last stands in, said as such.
      }
    }
    const bot = this.kept.get(botId);
    const every = this.kept.get(EVERY_BOT);
    if (bot && every && !bot.incomplete && !every.incomplete)
      return {
        rules: { from: "kept", readAt: Math.min(bot.readAt, every.readAt) },
        bot: bot.scope,
        every: every.scope,
      };
    return { rules: { from: null, readAt: null }, bot: null, every: null };
  }

  /** A line's choice, written, then read back. */
  async choose(
    botId: string,
    lineId: string,
    choice: PermissionChoice,
    base: PermissionBase,
  ): Promise<PermissionWrite> {
    if (!this.ctx.admin()) throw new AdminNeededError("Changing what a bot may do");
    if (this.writing) throw new Error("Another change to a bot's permissions is being saved.");
    this.writing = true;
    // The whole choice, its reads and its writes, goes to the gateway connected now.
    const request = this.ctx.session();
    const readBack = () => this.readAll(botId, request).then((read) => read.view);
    try {
      const before = await this.readAll(botId, request);
      const { facts, view } = before;
      if (base.configHash !== null && facts.settings.hash !== base.configHash)
        return { outcome: "conflict", error: null, view };
      const line = view.lines.find((each) => each.id === lineId);
      if (!line) throw new Error("That line isn't one of this bot's any more.");
      const refusal = choiceRefusal(view, line, choice, true);
      if (refusal) throw new Error(refusal);
      this.writeSent = false;
      this.rulesSaved = false;
      try {
        await this.apply(request, botId, facts, line, choice, base);
      } catch (error) {
        const after = await readBack().catch(() => null);
        // The rules plugin's part landed and the settings' did not: both are said.
        if (this.rulesSaved) {
          const shown = after && choiceShown(after, line, choice);
          return shown
            ? { outcome: "saved", error: null, view: after }
            : { outcome: "partial", error: message(error), view: after };
        }
        if (error instanceof ConflictError)
          return { outcome: "conflict", error: null, view: after };
        // No write left, or the gateway refused it: what it has now is read, and nothing is assumed.
        if (
          !this.writeSent ||
          error instanceof GatewayProtocolRequestError ||
          (error instanceof Error && error.name === "NotSentError")
        )
          return { outcome: "failed", error: message(error), view: after };
        // No answer came: only a read after it can say it was saved.
        const shown = after && choiceShown(after, line, choice);
        return shown
          ? { outcome: "saved", error: null, view: after }
          : { outcome: "unconfirmed", error: message(error), view: after };
      }
      const after = await readBack().catch(() => null);
      if (!after)
        return {
          outcome: "unconfirmed",
          error: "The change was sent, and reading it back failed.",
          view: null,
        };
      const shown = choiceShown(after, line, choice);
      return { outcome: shown ? "saved" : "not-shown", error: null, view: after };
    } finally {
      this.writing = false;
    }
  }

  private async apply(
    request: GatewayRequest,
    botId: string,
    facts: PermissionFacts,
    line: PermissionLine,
    choice: PermissionChoice,
    base: PermissionBase,
  ): Promise<void> {
    const { settings, catalog } = facts;
    const { tools } = line;
    if (choice === "full" || choice === "auto" || choice === "exec-ask" || choice === "deny") {
      await this.patch(request, execWrite(botId, settings, choice, catalog), settings.hash);
      return;
    }
    if (choice === "never" || choice === "allow") {
      const write = denyWrite(botId, settings, line, choice === "never", catalog);
      if (write) await this.patch(request, write, settings.hash);
      return;
    }
    // Ask: the plugin's rule first, so the tool is never offered unasked; then the deny comes off.
    if (!pluginHolds(facts.plugin))
      throw new Error("Asking needs Clawtrate's rules plugin running.");
    const answer = await request(RULES_GET_METHOD, { scope: botId });
    const scope = readScope(answer, botId);
    const version = scope?.version ?? 0;
    if (base.rulesVersion !== null && version !== base.rulesVersion) throw new ConflictError();
    if (!hasOwnAsk(scope, tools)) {
      const rules = rulesForSet(answer, botId);
      if (!rules) throw new Error("The rules plugin's rules for this bot couldn't be read whole.");
      this.writeSent = true;
      await request(RULES_SET_METHOD, {
        scope: botId,
        rules: [...rules, { action: "ask", tools }],
        fallback: scope?.fallback ?? false,
        expectedVersion: version,
      });
      this.rulesSaved = true;
    }
    // The deny list replaced is the one this choice read: against its hash, never a newer one.
    const deny = denyWrite(botId, settings, { tools }, false, catalog);
    if (deny) await this.patch(request, deny, settings.hash);
  }

  /**
   * One merge patch of the config (`config.patch`, admin) against the hash the
   * page read, then the gateway applying it: `config.get` reports the new
   * revision as applied. A hash that changed meanwhile is a conflict.
   */
  private async patch(
    request: GatewayRequest,
    write: ConfigWrite,
    baseHash: string | null,
  ): Promise<void> {
    const before = asRecord(await request("config.get", {})) as RawRecord | null;
    const hash = typeof before?.hash === "string" ? before.hash : null;
    if (baseHash !== null && hash !== baseHash) throw new ConflictError();
    try {
      this.writeSent = true;
      await request("config.patch", {
        raw: JSON.stringify(write.patch),
        ...(hash ? { baseHash: hash } : {}),
        ...(write.replacePaths.length > 0 ? { replacePaths: write.replacePaths } : {}),
      });
    } catch (error) {
      if (/config changed since last load/i.test(message(error))) throw new ConflictError();
      throw error;
    }
    if (before?.configRevisionHash === undefined) return;
    const started = this.ctx.now();
    for (let reads = 0; reads < 100 && this.ctx.now() - started < 20_000; reads += 1) {
      const now = asRecord(await request("config.get", {}));
      const revised = now?.configRevisionHash !== before.configRevisionHash;
      if (revised && now?.appliedConfigHash === now?.configRevisionHash) return;
      if (!revised && (this.ctx.now() - started > 3_000 || reads >= 15)) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
  }
}

/** Someone else changed the settings or the rules since the page read them. */
class ConflictError extends Error {
  constructor() {
    super("Someone else changed these settings.");
  }
}

export type { CatalogTool, ToolSettings };
