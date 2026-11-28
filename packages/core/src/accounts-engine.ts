// The accounts engine: reads and writes of bots.md sections 3 to 11, run by
// the client on its connection. Its state is `ClawtrateState.accounts`. The
// collections it keeps are its own properties, registered in `owners.ts`.
//
// What the person types into a sign-in or the API key path is an argument of
// one request and is kept nowhere: not in the state, not in a field here, not
// in an error. `withoutSecret` takes it out of anything the gateway answers.

import {
  ACCOUNT_READ_CONCURRENCY,
  accountProvider,
  endingOf,
  evaluateOrder,
  formatModelRef,
  INTENT_PREF_PREFIX,
  isBusy,
  KIND_PREF_PREFIX,
  KIND_RECORDS,
  type KindRecord,
  labelProblem,
  MAX_ACCOUNTS,
  MAX_ALLOWLIST_ENTRIES,
  MAX_LOCK_CHECKS,
  MAX_SECRET_CHARS,
  MAX_SECRET_JSON_CHARS,
  mergeAccounts,
  normalizeLabel,
  parseModelRef,
  prefBotId,
  prefProfileId,
  providerNotListed,
  readBotView,
  unconfirmedOrder,
  readCatalog,
  readPickerCuts,
  readProviderCatalog,
  type ModelList,
  checksHostedList,
  declaredModels,
  MAX_CATALOG_MODELS,
  MAX_KEY_PROVIDERS,
  MAX_REFRESH_ERROR_CHARS,
  effectiveAllowlist,
  limitsProvider,
  readModelAllowlist,
  readModelRefresh,
  REFRESH_MODELS_MS,
  type ModelRefresh,
  readIntent,
  readKeyProviders,
  readMethods,
  readModelConfig,
  readStep,
  SIGNIN_WAIT_MS,
  MAX_SIGNIN_SECRETS,
  serializedLength,
  secretForms,
  wholeForms,
  SLOW_CREATE_MS,
  unreadEvidence,
  withoutSecret,
  initialAccountsState,
  type AccountsState,
  type MissingStep,
  type AccountWrite,
  type BindingIntent,
  type BotBinding,
  type ModelAllowed,
  type RefusedBotModel,
  type BotView,
  type LockCheck,
  type ModelRef,
  ORDER_CLEAR_WAIT_MS,
  type OrderClear,
  type SignInResult,
  type SignInState,
  type StoredOrder,
} from "./accounts.ts";
import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
} from "@openclaw/gateway-client/browser";
import { isKeepablePicture, MAX_PICTURE_CHARS } from "./avatar.ts";
import {
  allowAddition,
  allowRemoval,
  botModelRef,
  ownModelRefusal,
  type AllowAddition,
  type AllowRef,
} from "./model-allow.ts";
import { cleanLine } from "./gateway-names.ts";
import { asRecord, type RawRecord } from "./mapping.ts";
import { sameStamp, type GatewayStamp, type ReadStamp } from "./types.ts";

/** What the engine needs from the client. */
/** Why the accounts read shows no answer: its connection ended before it finished. */
export const ACCOUNTS_READ_CUT_OFF = "The connection ended before the accounts were read.";

export type AccountsContext = {
  request(
    method: string,
    params: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown>;
  /**
   * Read, and ask again while the gateway answers that it isn't ready and `current()` holds
   * (`readAgain`, with the client's waits).
   */
  readAgain<T>(read: () => Promise<T>, current: () => boolean): Promise<T>;
  /** How long a Refresh may take from the press, whole: `REFRESH_MODELS_MS` unless a test sets it. */
  refreshMs?: number;
  /** The monotonic clock a Refresh's deadline is measured on: `performance.now()` unless a test sets it. */
  clock?: () => number;
  get(): AccountsState;
  update(change: (accounts: AccountsState) => AccountsState): void;
  /** The bots the client lists: ids, names, which is the default, and their pictures. */
  bots(): Array<{ id: string; name: string; isDefault: boolean; avatarUrl: string | null }>;
  connected(): boolean;
  /** The connection holds `operator.admin`. */
  admin(): boolean;
  /** The OpenClaw version the gateway reports, which says how it reads a model list (#799). */
  serverVersion?(): string | null;
  /** Read the bot list again (`agents.list`). */
  refreshBots(): Promise<void>;
  /** The connected gateway's identity (`gateway.identity.get`), or null when it names none. */
  gateway(): Promise<string | null>;
  /** The identity the connection has read so far, without asking: null until it is known. */
  gatewayNow(): string | null;
  /** Where a read made now is made: the identity, the target and the connection's hello. */
  readStamp(): ReadStamp;
  /** The host's target now (`ConnectionState.target`). */
  target(): number;
  /** Give a new bot its first, empty task, "Main" (bots.md section 3), and read the task list. */
  createMainTask(botId: string): Promise<void>;
  now(): number;
  randomId(): string;
  log(message: string): void;
};

/** One bot's order a read failed to read: as `readFailed` says it on the binding. */
type BotReadFailure = {
  botId: string;
  /** The number its chunk was sent with. */
  seq: number;
  status: "failed" | "unavailable";
  error: string;
};

/**
 * One bot write, its optional gateway identity and the host's target its screen was read under
 * (`GatewayStamp`), and the reset count it began on.
 */
type WriteMark = {
  gatewayId: string | null;
  target: number | null;
  resets: number;
  retired: boolean;
};

/** The gateway a bot write is bound to: its identity, and the host's target when a screen read it. */
type WriteBinding = { gatewayId: string; target: number | null };

/** A bot write retired because its gateway is no longer the one connected. */
class WriteRetired extends Error {
  /**
   * A bot made before the write was cut off with no gateway saying who it is, and what of it is
   * left: kept for that gateway's Finish, should it come back.
   */
  unfinished: { name: string; botId: string; missing: MissingStep[] } | null = null;
  /**
   * A Create whose answer was lost, cut off while it looked for the bot it may have made with no
   * gateway saying who it is: kept as in doubt, with its list of bots from before, for that gateway.
   */
  doubtful = false;
  /** No gateway said who it is, so the one asked may yet come back. */
  readonly unknown: boolean;
  constructor(unknown = false) {
    super("The gateway changed before the bot was finished, so nothing more was sent.");
    this.name = "WriteRetired";
    this.unknown = unknown;
  }
}

/** A creation's steps after the bot is made, in the order they are written: one string, not a collection kept. */
const STEP_ORDER = "identity preference fallbacks listed task";

/** A write needs admin; the access bar asks for it (bots.md section 2). */
export class AdminNeededError extends Error {
  constructor(what: string) {
    super(`${what} needs admin access.`);
    this.name = "AdminNeededError";
  }
}

export type CreateBotInput = {
  name: string;
  /** A `data:image/png` picture: the chosen creature with its choice inside (`avatar.ts`), or an uploaded one. */
  avatar: string | null;
  /** The account, or null for "Let the gateway choose". */
  account: string | null;
  provider: string;
  model: string;
  effort: string | null;
};

/** Why a Refresh's answer is not given: it would be another gateway's, or another connection's. */
const MODELS_GATEWAY_CHANGED = "The gateway changed while its models were looked for.";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const entryOf = (config: RawRecord | null, botId: string) =>
  asRecord(asRecord(asRecord(asRecord(config?.config)?.agents)?.entries)?.[botId]);
const providerOf = (entry: RawRecord | null) =>
  parseModelRef(readModelConfig(entry?.model).primary)?.provider ?? null;

/** The longest picture New bot sends. */
export const MAX_CREATE_AVATAR_CHARS = MAX_PICTURE_CHARS;

/** The most steps one sign-in is followed through before Clawtrate stops it. */
export const MAX_SIGNIN_STEPS = 64;

export class AccountsEngine {
  /** How each account was made, from Clawtrate's own record of the sign-ins it started. */
  private readonly kinds = new Map<string, KindRecord>();
  /** What Clawtrate set for each bot it created or changed. */
  private readonly intents = new Map<string, BindingIntent>();
  /** Bots created here whose empty fallback list did not land. */
  private readonly unwritten = new Set<string>();
  /**
   * The bots there before the first Create of the bot being made: kept while
   * that Create's answer is in doubt, so a retry adopts only a bot that was not.
   */
  private readonly before: string[] = [];
  /** What the Create under way, or the last one, writes, so Finish can write what is missing. */
  private planned: {
    name: string;
    botId: string | null;
    ref: ModelRef;
    effort: string | null;
    intent: BindingIntent;
    /** A picture was chosen in New bot, and the gateway keeps it with the bot. */
    picture: boolean;
  } | null = null;
  private readonly ctx: AccountsContext;
  /**
   * How many times the engine has been reset. A bot write under way is bound to the gateway it
   * was asked of and checks its own requests, recovery reads and changes to the state against
   * it; a reset since it began retires it.
   */
  private resets = 0;
  /** The default bot's picker read under way, which Create waits for. */
  private pickerRead: Promise<unknown> | null = null;
  /** The bound write whose Create the state's creation and the slow timer belong to. */
  private creating: WriteMark | null = null;
  /** The gateway the state's creation was asked of: it is kept, and finished, only there. */
  private creationGateway: string | null = null;
  /** The host's target that creation's screen was read under. */
  private creationTarget: number | null = null;
  /** The partial creation a Finish has claimed while its gateway may still be identifying itself. */
  private finishing: AccountsState["creation"] = null;
  private loading: Promise<void> | null = null;
  /**
   * The engine's reads of an order and its sends of a clear, numbered as each begins: what orders
   * them (`LockEvidence.readSeq`, `OrderClear.sentSeq`), since the clock can give two the same
   * millisecond. A number, not a collection.
   */
  private seq = 0;
  /** The one Unlock or Clear under way: its bot and provider. */
  private clearing: { botId: string; provider: string } | null = null;
  private loadAgain = false;
  /** The Refresh under way (#565), which a second press of the same provider shares. */
  private refreshing: {
    provider: string;
    stamp: GatewayStamp;
    promise: Promise<ModelRefresh>;
  } | null = null;
  /** Aborts the sign-in's waiting request when it is cancelled or the connection goes. */
  private signInAbort: AbortController | null = null;
  /**
   * What the person typed into the sign-in under way (a key, a pasted code or
   * address), in the forms the gateway may echo it, held only while that
   * sign-in lasts: every string the gateway sends back is scrubbed of them
   * before it enters the state or a log line. Forgotten when the sign-in ends.
   */
  private readonly secrets: string[] = [];
  private slowTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: AccountsContext) {
    this.ctx = ctx;
  }

  // Reading ---------------------------------------------------------------------------

  /** Read everything the account screens show; one read at a time, one more after it if asked. */
  load(): Promise<void> {
    if (this.loading) {
      this.loadAgain = true;
      return this.loading;
    }
    const refreshing = this.refreshing?.promise;
    this.loading = (async () => {
      try {
        // Never alongside a Refresh: the gateway refuses the picker beside the account reads.
        if (refreshing) await refreshing.catch(() => {});
        do {
          this.loadAgain = false;
          await this.readAll();
        } while (this.loadAgain);
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  private async readAll(): Promise<void> {
    const { ctx } = this;
    if (!ctx.connected()) return;
    // A reset since the read began (another gateway) retires it: nothing it read is published.
    const resets = this.resets;
    // Where this read is made: its requests all go now, and a close ends every one of them.
    const readOn = ctx.readStamp();
    // A read is asked again only on the connection it began on, for the same gateway.
    const current = () => {
      const now = ctx.readStamp();
      return (
        resets === this.resets &&
        ctx.connected() &&
        now.target === readOn.target &&
        now.connectedAt === readOn.connectedAt
      );
    };
    ctx.update((a) => ({ ...a, status: a.status === "ready" ? "ready" : "loading", error: null }));
    // Where these reads stand among the engine's reads (`nextSeq`), and when they began.
    const seq = this.nextSeq();
    const startedAt = ctx.now();
    const bots = ctx.bots();
    // Each bot whose order this read failed to read, as a failed Check now would say it.
    const failed: BotReadFailure[] = [];
    // Each bot's request, by the number its chunk took as it was sent (`readViews`).
    const sent = new Map<string, number>();
    let configFailed = false;
    try {
      // Every read asked is answered before the account read ends, a failed one too: a Refresh
      // waiting for it never asks the picker beside a read still out (#565).
      let failure: { error: unknown } | null = null;
      const settle = <T>(read: Promise<T>) =>
        read.catch((error: unknown) => {
          failure ??= { error };
          return null;
        });
      const configRead = settle(
        ctx
          .readAgain(() => ctx.request("config.get", {}), current)
          .then(asRecord, (error) => {
            configFailed = true;
            throw error;
          }),
      );
      const [config, views, prefs] = await Promise.all([
        configRead,
        settle(
          this.readViews(
            bots.map((bot) => bot.id),
            failed,
            sent,
            configRead,
          ),
        ),
        ctx.request("users.prefs.get", {}).then(asRecord, () => null),
      ]);
      if (failure) throw (failure as { error: unknown }).error;
      if (views === null) return;
      // Checked before the preferences are read: another gateway's must never refill the maps
      // the reset cleared.
      if (resets !== this.resets) return;
      this.readPrefs(prefs);
      const at = ctx.now();
      // Read before the gateway named itself on this connection, and named since: the read is its.
      const now = ctx.readStamp();
      const read =
        readOn.gatewayId === null &&
        now.target === readOn.target &&
        now.connectedAt === readOn.connectedAt
          ? { ...readOn, gatewayId: now.gatewayId }
          : readOn;
      // The gateway each bot's order was read from: known only on the connection it began on.
      const gateway = answeredBy(readOn, now);
      ctx.update((a) => {
        // The catalog is kept only for the same gateway, named on both reads: one read on
        // another (an answer at the same address after a reconnect) is never shown beside this
        // read's stamp. The picker below reads this one's.
        const same =
          read.gatewayId !== null && a.readOn !== null && a.readOn.gatewayId === read.gatewayId;
        return settleClear({
          ...this.compose(
            a,
            config,
            views,
            same ? a.models : [],
            at,
            startedAt,
            seq,
            gateway,
            sent,
          ),
          ...(same ? {} : { modelsCut: initialAccountsState.modelsCut }),
          readOn: read,
        });
      });
      // The default bot's picker, the Model menu's rows (section 9), asked once the accounts are
      // published and in the same read, so it never overlaps another account read or what a
      // read is awaited for (a new bot's first task): the gateway refuses it alongside the reads
      // above ("Chat metadata access changed while preparing its metadata"). Not published after
      // a reset; a failed read keeps the rows there are.
      const defaultBot = bots.find((bot) => bot.isDefault)?.id ?? bots[0]?.id ?? "main";
      // Kept while it is out: Create waits for it rather than overlap it (section 4).
      const picker = ctx
        .readAgain(() => ctx.request("models.list", { agentId: defaultBot }), current)
        .catch(() => null);
      this.pickerRead = picker;
      const answer = await picker;
      if (this.pickerRead === picker) this.pickerRead = null;
      if (answer === null || resets !== this.resets) return;
      const models = readCatalog(answer);
      const modelsCut = readPickerCuts(answer);
      ctx.update((a) => ({ ...a, models, modelsCut }));
    } catch (error) {
      // A failure of a read for another gateway is not this one's to show.
      if (resets !== this.resets) return;
      // Each bot whose order went unread says so on its own page, as after a failed Check now, and
      // the failure is the bot's newest attempt: a press begun before it sends nothing after it.
      // A config read that failed, or a connection that ended, left every bot's order unread.
      const cut = !current();
      const shared = cut || configFailed;
      const said = cut ? ACCOUNTS_READ_CUT_OFF : this.scrub(errorText(error));
      for (const bot of bots) {
        const own = failed.find((each) => each.botId === bot.id);
        if (own) this.readFailed(ctx, bot.id, own.seq, own.status, cut ? said : own.error);
        else if (shared) this.readFailed(ctx, bot.id, sent.get(bot.id) ?? seq, "failed", said);
      }
      // Its connection ended: the gateway's words from it are not published (they may echo what
      // was typed, and the sign-in's typed values are already forgotten). The screen says the
      // read didn't finish instead of waiting on it.
      if (cut) {
        ctx.update((a) =>
          a.status === "loading" ? { ...a, status: "error", error: ACCOUNTS_READ_CUT_OFF } : a,
        );
        return;
      }
      // While a sign-in lasts, its typed values are taken out of whatever comes back.
      const message = this.scrub(errorText(error));
      ctx.update((a) => ({ ...a, status: "error", error: message }));
    }
  }

  /**
   * One provider's full list for "View more" (section 9): `models.list {view: "all",
   * provider}` for the default bot, the same scope as the picker, read each time it is asked
   * for and given to the screen that asked. Nothing of it is kept. Its answer is refused, not
   * given, when the gateway was reset (another gateway) while it was read.
   */
  async readModelList(provider: string): Promise<ModelList> {
    const { ctx } = this;
    if (!ctx.connected()) throw new Error("Not connected to a gateway.");
    const resets = this.resets;
    const bots = ctx.bots();
    const defaultBot = bots.find((bot) => bot.isDefault)?.id ?? bots[0]?.id ?? "main";
    let list: ModelList;
    try {
      const answer = await ctx.request("models.list", {
        agentId: defaultBot,
        view: "all",
        provider,
      });
      const known = new Set(
        ctx
          .get()
          .models.filter((m) => m.provider === provider)
          .map((m) => m.id),
      );
      list = { status: "ready", ...readProviderCatalog(answer, provider, known) };
    } catch (error) {
      const refused =
        error instanceof GatewayProtocolRequestError && error.code === "INVALID_REQUEST";
      list = { status: refused ? "unsupported" : "error", error: this.scrub(errorText(error)) };
    }
    if (resets !== this.resets) throw new Error("The gateway changed while its models were read.");
    return list;
  }

  /**
   * Refresh in the Model menu (#565): ask the gateway to look for one provider's models again,
   * `models.list {agentId, provider, refresh: true}` (read access) for the default bot, the
   * picker's scope, and put the answer's rows in place of the provider's picker rows. Only a
   * person's press asks; a second press while one runs shares its answer. The answer is the
   * screen's alone, and is refused, not given, unless the gateway and connection `stamp` names
   * are the ones it was asked on and still are when it comes back.
   */
  refreshModels(provider: string, stamp: GatewayStamp): Promise<ModelRefresh> {
    const running = this.refreshing;
    if (running) {
      // Shared only with a press for the same provider on the same gateway and target.
      if (running.provider === provider && sameStamp(running.stamp, stamp)) return running.promise;
      if (running.provider === provider) return Promise.reject(new Error(MODELS_GATEWAY_CHANGED));
      return Promise.reject(
        new Error("Clawtrate is already looking for another provider's models."),
      );
    }
    const promise: Promise<ModelRefresh> = this.lookAgain(provider, stamp).finally(() => {
      if (this.refreshing?.promise === promise) this.refreshing = null;
      if (this.pickerRead === waited) this.pickerRead = null;
    });
    // Create waits for the whole refresh, its config read included, rather than overlap it.
    const waited = promise.catch(() => null);
    this.pickerRead = waited;
    this.refreshing = { provider, stamp, promise };
    return promise;
  }

  private async lookAgain(provider: string, stamp: GatewayStamp): Promise<ModelRefresh> {
    const { ctx } = this;
    // What is new or gone is against the menu the person pressed in: taken now, before any wait,
    // so an account read the refresh waits for can't bring a model in first and hide it.
    const pressed = ctx.get();
    const before = pressed.models.filter((m) => m.provider === provider).map((m) => m.id);
    const cutBefore = pressed.modelsCut.find((c) => c.provider === provider)?.total ?? null;
    // One deadline for the whole press: the wait for an account read, the config read and the
    // gateway's look share it, and nothing is asked once it has passed.
    // Measured on a monotonic clock, so a corrected wall clock (a time sync or a manual change)
    // can't stretch or cut it. That clock keeps counting while the device sleeps, so a refresh
    // that sleeps past its time is late on wake.
    // Every host has `performance.now()`, though React Native's types don't declare it.
    const clock =
      ctx.clock ?? (() => (globalThis as { performance?: { now(): number } }).performance!.now());
    const deadline = clock() + (ctx.refreshMs ?? REFRESH_MODELS_MS);
    const left = () => deadline - clock();
    const late: ModelRefresh = { status: "error", error: "The gateway didn't answer in time." };
    // An account read under way finishes first: the gateway refuses the picker beside it.
    const loading = this.loading;
    if (loading) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = await Promise.race([
        loading.then(
          () => true,
          () => true,
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, left()));
        }),
      ]);
      clearTimeout(timer);
      if (!done) return late;
    }
    const resets = this.resets;
    const readOn = ctx.readStamp();
    const gone = () => {
      const now = ctx.readStamp();
      return (
        resets !== this.resets ||
        !ctx.connected() ||
        !sameStamp(now, readOn) ||
        now.connectedAt !== readOn.connectedAt
      );
    };
    // The menu's rows were read on this gateway, and the press was made on it.
    const shown = ctx.get().readOn;
    if (!ctx.connected() || !sameStamp(stamp, readOn) || !sameStamp(shown, readOn))
      throw new Error(MODELS_GATEWAY_CHANGED);
    const bots = ctx.bots();
    const defaultBot = bots.find((bot) => bot.isDefault)?.id ?? bots[0]?.id ?? "main";
    let answer: unknown;
    let config: RawRecord | null;
    try {
      // The config says whether the gateway declares the provider's models, and which models
      // its list for bots names; asked first, as the picker is never asked beside it.
      // Each request reads the time left once, both to decide whether to ask and as its timeout,
      // so none is sent once the deadline has passed.
      let ms = left();
      if (ms <= 0) return late;
      // A config read given up on was given the time left, so the deadline has passed, though
      // the clock may read a millisecond or more earlier than the request's timer.
      let timedOut = false;
      config = await ctx.request("config.get", {}, { timeoutMs: ms }).then(asRecord, (error) => {
        timedOut = error instanceof GatewayProtocolRequestTimeoutError;
        return null;
      });
      if (gone()) throw new Error(MODELS_GATEWAY_CHANGED);
      if (timedOut) return late;
      ms = left();
      if (ms <= 0) return late;
      const asked = ctx.request(
        "models.list",
        { agentId: defaultBot, provider, refresh: true },
        { timeoutMs: ms },
      );
      answer = await asked;
    } catch (error) {
      if (gone()) throw new Error(MODELS_GATEWAY_CHANGED, { cause: error });
      if (error instanceof Error && error.message === MODELS_GATEWAY_CHANGED) throw error;
      // A failure handled after the deadline is late too, though its own timer hadn't fired.
      const words =
        error instanceof GatewayProtocolRequestTimeoutError || left() <= 0
          ? "The gateway didn't answer in time."
          : this.scrub(errorText(error));
      return { status: "error", error: cleanLine(words, MAX_REFRESH_ERROR_CHARS) };
    }
    if (gone()) throw new Error(MODELS_GATEWAY_CHANGED);
    // An answer handled after the deadline, before its own timer fired, changes nothing.
    if (left() <= 0) return late;
    const found = readModelRefresh(
      answer,
      provider,
      before,
      declaredModels(config, provider),
      checksHostedList(config),
      // The rows are the default bot's picker, so its own list, or the default, filters them.
      limitsProvider(effectiveAllowlist(config, defaultBot), provider),
    );
    let result: ModelRefresh | null = null;
    ctx.update((a) => {
      // Only into the rows read on this same gateway.
      if (!sameStamp(a.readOn, readOn)) return a;
      const at = a.models.findIndex((m) => m.provider === provider);
      const others = a.models.filter((m) => m.provider !== provider);
      const kept = found.rows.slice(0, Math.max(0, MAX_CATALOG_MODELS - others.length));
      const models =
        at < 0
          ? [...others, ...kept]
          : [
              ...a.models.slice(0, at),
              ...kept,
              ...a.models.slice(at).filter((m) => m.provider !== provider),
            ];
      const cut = a.modelsCut.filter((c) => c.provider !== provider);
      if (kept.length < found.rows.length) cut.push({ provider, total: found.rows.length });
      result = found.compare(
        kept.map((m) => m.id),
        cutBefore,
      );
      return {
        ...a,
        models,
        modelsCut: cut.slice(0, MAX_KEY_PROVIDERS),
        ...(config ? { modelAllowlist: readModelAllowlist(config) } : {}),
      };
    });
    if (result === null) throw new Error(MODELS_GATEWAY_CHANGED);
    return result;
  }

  /**
   * Every bot's view, in chunks; each bot whose read fails or is unavailable goes in `failed`. Each
   * chunk takes its number as it is sent, and stamps its bots with it (`sent`): a later chunk goes
   * out after the earlier ones settle, maybe after a press's read before its send.
   */
  private async readViews(
    botIds: string[],
    failed: BotReadFailure[] = [],
    sent: Map<string, number> = new Map(),
    config: Promise<RawRecord | null>,
  ): Promise<Map<string, BotView>> {
    const views = new Map<string, BotView>();
    // A few bots at a time. Sharing is decided only from refreshed answers (row 33).
    for (let i = 0; i < botIds.length; i += ACCOUNT_READ_CONCURRENCY) {
      const chunk = botIds.slice(i, i + ACCOUNT_READ_CONCURRENCY);
      // Every request of the chunk is answered before a failure ends the read, so nothing of it
      // is still out when a Refresh that waits for the read asks (#565); no later chunk starts.
      const { seq, out } = this.statusRead(this.ctx, chunk, () =>
        Promise.allSettled(
          chunk.map((agentId) => this.ctx.request("models.authStatus", { agentId, refresh: true })),
        ),
      );
      for (const botId of chunk) sent.set(botId, seq);
      const settled = await out;
      const read = await config;
      let first: unknown = null;
      for (let j = 0; j < chunk.length; j += 1) {
        const botId = chunk[j]!;
        const each = settled[j]!;
        let view: BotView;
        try {
          if (each.status === "rejected") throw each.reason;
          view = readBotView(each.value, providerOf(entryOf(read, botId)));
        } catch (error) {
          failed.push({ botId, seq, status: "failed", error: this.scrub(errorText(error)) });
          first ??= error;
          continue;
        }
        // Not a reading: the last good one stands, and the screens say why there is none.
        if (view.unavailable) {
          failed.push({ botId, seq, status: "unavailable", error: view.unavailable });
          first ??= new Error(
            `The gateway says its account status is unavailable (${view.unavailable}).`,
          );
          continue;
        }
        views.set(botId, view);
      }
      if (first !== null) throw first;
    }
    return views;
  }

  private readPrefs(prefs: RawRecord | null): void {
    const entries = asRecord(prefs?.entries);
    if (!entries) return;
    for (const [key, value] of Object.entries(entries)) {
      // Each entry is bounded here, where it enters: an id Clawtrate could have written, a known value.
      if (key.startsWith(KIND_PREF_PREFIX) && KIND_RECORDS.includes(value as KindRecord)) {
        const id = prefProfileId(key.slice(KIND_PREF_PREFIX.length));
        if (id) this.remember(this.kinds, id, value as KindRecord, MAX_ACCOUNTS);
      } else if (key.startsWith(INTENT_PREF_PREFIX)) {
        const bot = prefBotId(key.slice(INTENT_PREF_PREFIX.length));
        const intent = readIntent(value);
        if (bot && intent) this.remember(this.intents, bot, intent, MAX_ACCOUNTS);
      }
    }
  }

  private remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > max) map.delete(map.keys().next().value!);
  }

  /** The state from one read of config, every bot's view and the catalogue. */
  private compose(
    previous: AccountsState,
    config: RawRecord | null,
    views: Map<string, BotView>,
    catalog: AccountsState["models"],
    at: number,
    startedAt: number = at,
    seq: number | null = null,
    gateway: string | null = null,
    sent: ReadonlyMap<string, number> | null = null,
  ): AccountsState {
    const root = asRecord(config?.config) ?? {};
    const agents = asRecord(root.agents) ?? {};
    const entries = asRecord(agents.entries) ?? {};
    const defaults = asRecord(agents.defaults) ?? {};
    const defaultModel = readModelConfig(defaults.model).primary;
    const accounts = mergeAccounts(views, this.kinds);
    const main = asRecord(entries.main);
    const anyView = views.get("main") ?? [...views.values()][0];
    const bindings = [...views.keys()].map((botId) => {
      const before = previous.bindings.find((each) => each.botId === botId);
      // Numbered as its own request was sent.
      const own = sent?.get(botId) ?? seq;
      // A bot's order read since this one began, by Check now or a press, stays as it was read,
      // and so does a failure of one begun since.
      if (own !== null && before?.evidence.attemptSeq != null && before.evidence.attemptSeq > own)
        return before;
      return this.binding(
        botId,
        asRecord(entries[botId]),
        views.get(botId)!,
        before,
        startedAt,
        own,
        gateway,
      );
    });
    return {
      ...previous,
      status: "ready",
      error: null,
      readAt: at,
      labels: this.ctx.admin(),
      defaultModel,
      // A `main` listed on the gateway, with no folder of its own configured (row 33).
      mainShared: views.has("main") && (main === null || typeof main.agentDir !== "string"),
      accounts,
      methods: readMethods(anyView?.capabilities ?? []),
      keyProviders: readKeyProviders(anyView),
      models: catalog,
      modelAllowlist: readModelAllowlist(config),
      bindings,
      modelsRefused: this.refusedIn(config, bindings),
    };
  }

  /** The bots of `bindings` whose own model their model list refuses (#799), from `config`. */
  private refusedIn(config: RawRecord | null, bindings: BotBinding[]): RefusedBotModel[] {
    const version = this.ctx.serverVersion?.() ?? null;
    return bindings.flatMap(({ botId }) => {
      const refused = ownModelRefusal(config, botId, version);
      return refused ? [{ botId, ...refused }] : [];
    });
  }

  private binding(
    botId: string,
    entry: RawRecord | null,
    view: BotView,
    before: BotBinding | undefined,
    at: number,
    seq: number | null = null,
    gateway: string | null = null,
  ): BotBinding {
    // An account counts for a bot only if that bot's own view lists it: one another bot keeps is not its.
    const listed = new Set(view.profiles.map((profile) => profile.id));
    const { primary, fallbacks } = readModelConfig(entry?.model);
    const ref = parseModelRef(primary);
    const intent = this.intents.get(botId) ?? null;
    const mode: BotBinding["mode"] = !ref ? "default-model" : ref.account ? "account" : "gateway";
    const order: StoredOrder | null = ref ? (view.orders[ref.provider] ?? null) : null;
    const base = {
      account: ref?.account ?? null,
      provider: ref?.provider ?? null,
      mode,
    };
    return {
      botId,
      primary,
      provider: base.provider,
      model: ref?.model ?? null,
      account: base.account,
      mode,
      fallbacks,
      suffixLost: mode === "gateway" && intent?.mode === "account",
      accountMissing: mode === "account" && !listed.has(base.account!),
      effort: typeof entry?.thinkingDefault === "string" ? entry.thinkingDefault : null,
      order,
      evidence: evaluateOrder(
        before?.evidence ?? unreadEvidence,
        base,
        order,
        base.account !== null && listed.has(base.account),
        at,
        seq,
        gateway,
        ref !== null && view.providers.includes(ref.provider),
      ),
      // Clawtrate set this bot's account (its own record says so) and the gateway's model has no
      // explicit fallback list: the empty list it writes did not land, then or since a restart.
      fallbacksUnwritten:
        this.unwritten.has(botId) || (intent !== null && ref !== null && fallbacks === null),
    };
  }

  /**
   * Read one bot's order again ("Check now", the page's timer, after a
   * sign-in): `models.authStatus {agentId, refresh: true}` and its model. A
   * read that fails keeps the last confirmation and says when it was.
   */
  async checkLock(botId: string): Promise<void> {
    const { ctx } = this;
    const before = ctx.get().bindings.find((each) => each.botId === botId);
    if (!before) return this.load();
    ctx.update((a) =>
      this.patchBinding(a, botId, (b) => ({
        ...b,
        evidence: {
          ...b.evidence,
          status: b.evidence.checkedAt === null ? "reading" : b.evidence.status,
        },
      })),
    );
    // A failure is said on the binding by the read itself.
    await this.readOrder(botId, before, ctx).catch(() => {});
  }

  /**
   * A read that failed, or that the gateway answered as unavailable: said on the binding, unless a
   * read begun after it has been applied since, shown or failed. The last confirmation stands, with
   * its time, and the failure's number keeps any read begun before it from publishing over it.
   */
  private readFailed(
    ctx: AccountsContext,
    botId: string,
    seq: number,
    status: "failed" | "unavailable",
    error: string,
  ): void {
    ctx.update((a) =>
      this.patchBinding(a, botId, (b) =>
        b.evidence.attemptSeq !== null && b.evidence.attemptSeq > seq
          ? b
          : { ...b, evidence: { ...b.evidence, status, error, attemptSeq: seq } },
      ),
    );
  }

  /**
   * Another reader's read of one bot's account status (the machines page's inventory), sent by
   * `send` through `statusRead`: it is never applied here, so a press begun before it sends nothing
   * after it.
   */
  readStatus(botId: string, send: () => Promise<unknown>): Promise<unknown> {
    return this.statusRead(this.ctx, [botId], send).out;
  }

  /**
   * The one way a read of a bot's status goes out (`models.authStatus`, from every caller): its
   * number is taken, `send` issues its requests, and only then is the stamp published
   * (`startedSeq`). Nothing runs between the number and the send, so a read that a subscriber
   * starts from that publish takes a later number and goes out after this one: the stamps' order
   * is the order the reads were sent.
   */
  private statusRead<T>(
    ctx: AccountsContext,
    botIds: readonly string[],
    send: () => T,
  ): { seq: number; out: T } {
    const seq = this.nextSeq();
    const out = send();
    this.started(ctx, botIds, seq);
    return { seq, out };
  }

  /** Each of `botIds` has a read sent, numbered `seq`: stamped as sent, not as applied. */
  private started(ctx: AccountsContext, botIds: readonly string[], seq: number): void {
    ctx.update((a) => ({
      ...a,
      bindings: a.bindings.map((b) =>
        botIds.includes(b.botId) && (b.evidence.startedSeq ?? 0) < seq
          ? { ...b, evidence: { ...b.evidence, startedSeq: seq } }
          : b,
      ),
    }));
  }

  /**
   * One read of a bot's order and model, published as its binding, stamped with when it began.
   * An older read that answers after a newer one has published or failed publishes nothing: what
   * the page shows is never older than what it showed. Returns the bot's view, whether it was
   * published (`applied`), and the gateway that answered it (`answeredBy`), or null when the
   * gateway says its account status is unavailable (said on the binding). An answer with no
   * account status in it throws (`NO_ACCOUNT_STATUS`): it is a failed read, never an empty order.
   * A read that fails is said on the binding, as Check now says it, and thrown. The result carries
   * the read's number (`statusRead`).
   */
  private async readOrder(
    botId: string,
    before: BotBinding,
    ctx: AccountsContext,
    at: number = ctx.now(),
  ): Promise<{ view: BotView; applied: boolean; gateway: string | null; seq: number } | null> {
    const on = ctx.readStamp();
    const { seq, out } = this.statusRead(ctx, [botId], () =>
      Promise.all([
        ctx.request("models.authStatus", { agentId: botId, refresh: true }),
        ctx.request("config.get", {}).then(asRecord),
      ]),
    );
    let view: BotView;
    let config: RawRecord | null;
    try {
      let answer: unknown;
      [answer, config] = await out;
      view = readBotView(answer, providerOf(entryOf(config, botId)));
    } catch (error) {
      this.readFailed(ctx, botId, seq, "failed", this.scrub(errorText(error)));
      throw error;
    }
    if (view.unavailable) {
      this.readFailed(ctx, botId, seq, "unavailable", view.unavailable);
      return null;
    }
    const entry = entryOf(config, botId);
    const gateway = answeredBy(on, ctx.readStamp());
    let applied = false;
    ctx.update((a) => {
      const current = a.bindings.find((each) => each.botId === botId) ?? before;
      if (current.evidence.attemptSeq !== null && current.evidence.attemptSeq > seq) return a;
      applied = true;
      const next = this.binding(botId, entry, view, current, at, seq, gateway);
      return settleClear({
        ...a,
        bindings: a.bindings.map((each) => (each.botId === botId ? next : each)),
      });
    });
    return { view, applied, gateway, seq };
  }

  /**
   * Unlock, or Clear a kept order (#660): the person's press, after its confirmation, with the id
   * its screen chose. The order is read first, and the press goes on only while the bot's own
   * stored order for `provider` still names `account` alone, the order the confirmation showed.
   * Then `models.authOrderSet {provider, agentId}` with no account ids (`operator.admin`), which
   * clears it on the running gateway on OpenClaw 2026.10.6 and 2026.11.10 alike, and the order
   * read again: the outcome is `cleared` only when that read finds no stored order. One press at a
   * time: another while one is under way sends nothing (for the same bot and provider it leaves
   * the first's line; for another it is refused). `beforeSend` as for `changeAccount`; after
   * another gateway (`reset`) nothing more is sent or published.
   */
  async clearOrder(
    id: string,
    botId: string,
    provider: string,
    account: string,
    kind: OrderClear["kind"],
    beforeSend?: (sent: boolean) => void,
  ): Promise<void> {
    this.requireAdmin(kind === "unlock" ? "Unlocking a bot" : "Clearing a bot's order");
    const under = this.clearing;
    if (under) {
      if (under.botId === botId && under.provider === provider) return;
      throw new Error("Another Unlock or Clear order is under way. Try again when it has ended.");
    }
    const mine = { botId, provider };
    this.clearing = mine;
    try {
      await this.pressClear(id, botId, provider, account, kind, beforeSend);
    } finally {
      if (this.clearing === mine) this.clearing = null;
    }
  }

  private async pressClear(
    id: string,
    botId: string,
    provider: string,
    account: string,
    kind: OrderClear["kind"],
    beforeSend?: (sent: boolean) => void,
  ): Promise<void> {
    const resets = this.resets;
    const base = this.ctx;
    const live = () => this.resets === resets;
    const gatewayId = base.gatewayNow();
    let sentSeq: number | null = null;
    let checkedSeq: number | null = null;
    let checkedAt: number | null = null;
    const publish = (patch: Pick<OrderClear, "status" | "error">) => {
      if (!live()) return;
      const error = patch.error === null ? null : this.scrub(patch.error).slice(0, 400);
      // An unsure ending meets the newest read the page shows in the same update: one begun since
      // the send that finds the order gone settles it, and the bot's evidence with it.
      base.update((a) =>
        settleClear({
          ...a,
          clear: {
            id,
            gatewayId,
            botId,
            provider,
            kind,
            account,
            ...patch,
            error,
            at: base.now(),
            sentSeq,
            checkedSeq,
            checkedAt,
          },
        }),
      );
    };
    const { ctx: checked, check } = this.checked(beforeSend);
    const ctx: AccountsContext = {
      ...checked,
      update: (change) => {
        if (live()) base.update(change);
      },
    };
    const holds = (view: BotView) => {
      const order = view.orders[provider];
      return order?.stored === true && order.ids.length === 1 && order.ids[0] === account;
    };
    publish({ status: "sending", error: null });
    const before = base.get().bindings.find((each) => each.botId === botId);
    if (!before) {
      publish({ status: "unsent", error: "The bot is no longer listed." });
      return;
    }
    let first: Awaited<ReturnType<AccountsEngine["readOrder"]>>;
    try {
      // A failure is said on the bot's page by the read itself, as Check now says it.
      first = await this.readOrder(botId, before, ctx);
    } catch (error) {
      publish({ status: "unsent", error: errorText(error) });
      return;
    }
    if (first === null) {
      publish({ status: "unsent", error: "The gateway says its account status is unavailable." });
      return;
    }
    const firstSeq = first.seq;
    // An answer that doesn't list the provider says nothing of its order: nothing is sent.
    if (!first.view.providers.includes(provider)) {
      publish({ status: "unsent", error: providerNotListed(provider) });
      return;
    }
    // A read begun after this one may have been shown meanwhile (Check now, a load, another
    // device's change): the press acts on the newest the page has, never on one it superseded.
    const latest = base.get().bindings.find((each) => each.botId === botId);
    if (
      latest?.evidence.attemptSeq != null &&
      latest.evidence.attemptSeq > firstSeq &&
      latest.evidence.startedSeq === latest.evidence.attemptSeq &&
      latest.provider === provider &&
      !latest.evidence.providerRead
    ) {
      publish({ status: "unsent", error: providerNotListed(provider) });
      return;
    }
    // Any read of the bot sent after this one (a load, Check now, a sign-in's read): only once the
    // newest of them has been applied here as a reading may the press go on. Still out, failed, or
    // dropped with the rest of its load, it confirmed nothing, so nothing is sent: what this rests
    // on is when each read was sent, never whether a failure was recorded.
    const started = latest?.evidence.startedSeq ?? null;
    if (started !== null && started > firstSeq && latest!.evidence.readSeq !== started) {
      publish({ status: "unsent", error: unconfirmedOrder(kind) });
      return;
    }
    // Any attempt begun after it, shown or failed, for any provider: the press goes on only while
    // what the page took last still shows the bot's own stored order for `provider` naming
    // `account` alone. A failed read may have moved the bot without a reading of that order.
    const newer =
      latest !== undefined &&
      Math.max(latest.evidence.attemptSeq ?? 0, latest.evidence.readSeq ?? 0) > firstSeq;
    const superseded =
      newer &&
      !(
        latest.provider === provider &&
        latest.evidence.providerRead &&
        latest.order?.stored === true &&
        latest.order.ids.length === 1 &&
        latest.order.ids[0] === account
      );
    if (!holds(first.view) || superseded) {
      publish({ status: "moved", error: null });
      return;
    }
    // Another gateway since (`reset`): nothing is sent, whatever the caller checks.
    if (!live()) return;
    try {
      // The host's check, at once before the send: a connection changed since is said as unsent.
      check();
    } catch (error) {
      publish({ status: "unsent", error: errorText(error) });
      return;
    }
    let refused: string | null = null;
    let lost: string | null = null;
    sentSeq = this.nextSeq();
    try {
      await ctx.request(
        "models.authOrderSet",
        { provider, agentId: botId },
        { timeoutMs: ORDER_CLEAR_WAIT_MS },
      );
    } catch (error) {
      if (isRefusal(error)) refused = errorText(error);
      else lost = errorText(error);
    }
    // Null when the read after failed, or the gateway said its status is unavailable.
    let after: Awaited<ReturnType<AccountsEngine["readOrder"]>> = null;
    const afterAt = base.now();
    let onConnection = true;
    try {
      // The connection the press was sent on, still: a read on another says nothing of this one.
      check();
    } catch (error) {
      // Nothing read: as Check now says a failed read.
      onConnection = false;
      this.readFailed(ctx, botId, this.nextSeq(), "failed", this.scrub(errorText(error)));
    }
    // Its number and time are the ones the line and the announcement name, one each. A failure is
    // said on the bot's page by the read itself.
    if (onConnection) after = await this.readOrder(botId, before, ctx, afterAt).catch(() => null);
    const afterSeq = after?.seq ?? null;
    // What the gateway's reads say of the order since the send: the read after it while the page
    // still shows it as its newest, answered by the gateway the press was sent to and listing the
    // provider; when the page took a newer one instead (before the read after, or between its
    // publishing and now), or the read after failed, the newest read the page shows, only when it
    // began after the send, is the newest attempt (none failed since) and is as good. Anything
    // else is no reading: the press can't say the order is gone.
    const now = base.get().bindings.find((each) => each.botId === botId)?.evidence;
    const newest = afterSeq !== null && now?.readSeq === afterSeq && now.attemptSeq === afterSeq;
    const decided = ((): { gone: boolean; seq: number; at: number | null } | null => {
      if (after?.applied && newest) {
        const { view, gateway } = after;
        if (gatewayId === null || gateway !== gatewayId || !view.providers.includes(provider))
          return null;
        return { gone: view.orders[provider]?.stored !== true, seq: after.seq, at: afterAt };
      }
      const b = base.get().bindings.find((each) => each.botId === botId);
      const e = b?.evidence;
      if (
        !b ||
        !e ||
        e.readSeq === null ||
        e.readSeq <= (sentSeq ?? Infinity) ||
        e.attemptSeq !== e.readSeq ||
        gatewayId === null ||
        e.readGateway !== gatewayId ||
        !e.providerRead ||
        b.provider !== provider
      )
        return null;
      return { gone: b.order?.stored !== true, seq: e.readSeq, at: e.checkedAt };
    })();
    // The gateway's read decides before its answer does: a refusal whose order is gone is cleared.
    if (decided?.gone) {
      checkedSeq = decided.seq;
      checkedAt = decided.at;
      // The person's own unlock: not a lock lost, so no "The lock is gone" for it, and no lock to
      // remember either, so a later read that fails doesn't bring "Locked, as of …" back.
      // Only while the page still shows that read: a newer one that confirmed a lock keeps it.
      ctx.update((a) =>
        this.patchBinding(a, botId, (b) =>
          b.evidence.readSeq === decided.seq && b.provider === provider
            ? { ...b, evidence: { ...b.evidence, lostAt: null, lastMatchAt: null } }
            : b,
        ),
      );
      publish({ status: "cleared", error: null });
    } else if (refused !== null) publish({ status: "refused", error: refused });
    else if (lost !== null) publish({ status: "unanswered", error: lost });
    else if (decided === null) publish({ status: "unread", error: null });
    else publish({ status: "kept", error: null });
  }

  /** The next number in the order reads and sends began (`seq`). */
  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private patchBinding(
    a: AccountsState,
    botId: string,
    change: (binding: BotBinding) => BotBinding,
  ): AccountsState {
    return {
      ...a,
      bindings: a.bindings.map((each) => (each.botId === botId ? change(each) : each)),
    };
  }

  // Access -------------------------------------------------------------------------------

  private requireAdmin(what: string): void {
    if (!this.ctx.connected()) throw new Error("Not connected to the gateway.");
    if (!this.ctx.admin()) throw new AdminNeededError(what);
  }

  // Sign-ins ---------------------------------------------------------------------------

  /** The bot a sign-in is started for: `main` when its sign-ins are shared, else the one named. */
  signInTarget(botId: string | null): string {
    const bots = this.ctx.bots();
    if (this.ctx.get().mainShared) return "main";
    return botId ?? bots.find((bot) => bot.isDefault)?.id ?? bots[0]?.id ?? "main";
  }

  /** Start one of the gateway's sign-ins (`models.authLogin`) and follow it (`wizard.next`). */
  async startSignIn(methodId: string, botId: string | null): Promise<void> {
    this.requireAdmin("Connecting an account");
    const method = this.ctx.get().methods.find((each) => each.id === methodId);
    if (!method) throw new Error("The gateway does not offer that sign-in.");
    const active = this.ctx.get().signIn;
    if (active && isActive(active)) throw new Error("A sign-in is already under way here.");
    const forBot = this.signInTarget(botId);
    await this.begin(
      {
        id: `clawtrate-${this.ctx.randomId()}`,
        method: method.id,
        provider: method.provider,
        label: method.label,
        flow: method.flow,
        forBot,
        keptOnly: !this.ctx.get().mainShared,
        stage: "starting",
        step: null,
        error: null,
        cancelling: false,
        saving: false,
        startedAt: this.ctx.now(),
        result: null,
        byKey: method.flow === "key",
        known: [],
        cancelUnknown: false,
      },
      null,
      false,
    );
  }

  /**
   * Run a sign-in to its end or to a step that waits for the person. `key`
   * answers the first sensitive step of an API key sign-in, then is dropped.
   */
  private async begin(signIn: SignInState, key: string | null, untilEnd: boolean): Promise<void> {
    const { ctx } = this;
    const before = this.accountsOf(signIn.provider);
    this.forgetSecrets();
    if (key !== null) this.holdSecret(key);
    ctx.update((a) => ({ ...a, signIn: { ...signIn, known: before } }));
    try {
      await ctx.request("models.authLogin", {
        sessionId: signIn.id,
        authChoice: signIn.method,
        agentId: signIn.forBot,
      });
    } catch (error) {
      const message = this.scrub(errorText(error));
      this.setSignIn(signIn.id, { stage: isBusy(message) ? "busy" : "failed", error: message });
      this.forgetSecrets();
      return;
    }
    await this.paused((pause) => this.follow(signIn.id, null, key, before, pause), untilEnd);
  }

  /**
   * Run `follow` and resolve when it pauses for the person (a code to enter,
   * a field to fill) or ends; with `untilEnd`, only when it ends.
   */
  private paused(run: (pause: () => void) => Promise<void>, untilEnd = false): Promise<void> {
    return new Promise<void>((resolve) => {
      void run(untilEnd ? () => undefined : resolve).finally(resolve);
    });
  }

  /** Accounts of a provider as last read: what a sign-in is compared against. */
  private accountsOf(provider: string): string[] {
    return this.ctx
      .get()
      .accounts.filter((a) => a.provider === provider)
      .map((a) => a.id);
  }

  private setSignIn(id: string, patch: Partial<SignInState>): void {
    const clean = this.scrubbed(patch);
    this.ctx.update((a) => (a.signIn?.id === id ? { ...a, signIn: { ...a.signIn, ...clean } } : a));
  }

  /** Hold what the person typed, for the life of this sign-in, to take it out of what comes back. */
  private holdSecret(value: string): void {
    // Measured as it is kept: what `owners.ts` registers for each.
    const fits = (form: string) => serializedLength(form) <= MAX_SECRET_JSON_CHARS;
    const whole = wholeForms(value).filter(fits);
    const derived = secretForms(value).filter((form) => fits(form) && !whole.includes(form));
    // The whole value first, so nothing derived from it pushes it out; what is derived
    // (an address's query values) only while there is room.
    const kept = [...whole, ...this.secrets.filter((form) => !whole.includes(form))];
    for (const form of derived) if (!kept.includes(form)) kept.push(form);
    this.secrets.splice(0, this.secrets.length, ...kept.slice(0, MAX_SIGNIN_SECRETS));
  }

  /** Take one value's forms out of what is held: its use is over, while a sign-in may go on. */
  private releaseSecret(value: string): void {
    const forms = secretForms(value);
    const left = this.secrets.filter((form) => !forms.includes(form));
    this.secrets.splice(0, this.secrets.length, ...left);
  }

  /** The sign-in is over: nothing it was given is held any more. */
  private forgetSecrets(): void {
    this.secrets.length = 0;
  }

  /** A text from the gateway without anything the person typed into the sign-in. */
  private scrub(text: string): string {
    let out = text;
    // Longest first, so a whole address goes before the code inside it.
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length))
      out = withoutSecret(out, secret);
    return out;
  }

  /** Every string a sign-in's patch carries from the gateway, scrubbed. */
  private scrubbed(patch: Partial<SignInState>): Partial<SignInState> {
    if (this.secrets.length === 0) return patch;
    const out: Partial<SignInState> = { ...patch };
    if (typeof out.error === "string") out.error = this.scrub(out.error);
    if (out.step) {
      const step: Record<string, unknown> = { ...out.step };
      for (const field of ["id", "title", "message", "url", "code", "placeholder"]) {
        const value = step[field];
        if (typeof value === "string") step[field] = this.scrub(value);
      }
      out.step = step as SignInState["step"];
    }
    return out;
  }

  /** A log line, scrubbed of a sign-in's typed values. */
  private log(message: string): void {
    this.ctx.log(this.scrub(message));
  }

  /** The sign-in's next steps: `answer` goes with the first request only. */
  private async follow(
    id: string,
    answer: { stepId: string; value: unknown } | null,
    key: string | null,
    before: string[],
    pause: () => void = () => undefined,
  ): Promise<void> {
    const { ctx } = this;
    let pending = answer;
    let typed = key;
    // What the person typed last, only to take it out of what the gateway answers next.
    const stillMine = () => {
      const now = ctx.get().signIn;
      return now !== null && now.id === id && isActive(now);
    };
    for (let guard = 0; guard < MAX_SIGNIN_STEPS; guard += 1) {
      if (!stillMine()) return;
      const abort = new AbortController();
      this.signInAbort = abort;
      let next: RawRecord | null;
      try {
        next = asRecord(
          await ctx.request(
            "wizard.next",
            { sessionId: id, ...(pending ? { answer: pending } : {}) },
            // It waits while the gateway polls the provider: up to the sign-in's own limit.
            { timeoutMs: SIGNIN_WAIT_MS, signal: abort.signal },
          ),
        );
      } catch (error) {
        if (this.signInAbort === abort) this.signInAbort = null;
        if (!stillMine()) return;
        if (!ctx.connected()) {
          // A sign-in belongs to its connection and ends with it (row 6).
          this.setSignIn(id, { stage: "ended", step: null, error: null });
          this.forgetSecrets();
          return;
        }
        const message = this.scrub(errorText(error));
        this.setSignIn(id, { stage: endingOf("error", message), step: null, error: message });
        return await this.afterSignIn(id, before);
      } finally {
        pending = null;
      }
      if (this.signInAbort === abort) this.signInAbort = null;
      if (!stillMine()) return;
      if (next?.done === true) {
        const status = typeof next.status === "string" ? next.status : null;
        const error = typeof next.error === "string" ? this.scrub(next.error) : null;
        const stage = endingOf(status, error);
        this.setSignIn(id, {
          stage: stage === "connected" ? "checking" : stage,
          step: null,
          error,
        });
        return await this.afterSignIn(id, before);
      }
      const step = readStep(next?.step);
      if (!step) {
        this.setSignIn(id, {
          stage: "failed",
          step: null,
          error: "The gateway sent a step Clawtrate can't read.",
        });
        return await this.afterSignIn(id, before);
      }
      // A note for the client is acknowledged; the gateway goes on.
      if (step.type === "note" || step.type === "action") {
        pending = { stepId: step.id, value: true };
        continue;
      }
      if (step.type === "progress") {
        this.setSignIn(id, { stage: "waiting", step });
        pause();
        continue;
      }
      if (step.type === "text") {
        if (step.sensitive && typed !== null) {
          // The person's own key, sent once and dropped.
          pending = { stepId: step.id, value: typed };
          typed = null;
          this.setSignIn(id, { stage: "checking", step: { ...step } });
          continue;
        }
        this.setSignIn(id, { stage: "entering", step });
        pause();
        return;
      }
      // A choice Clawtrate does not offer: end it rather than guess.
      await ctx.request("wizard.cancel", { sessionId: id }).catch(() => undefined);
      this.setSignIn(id, {
        stage: "failed",
        step: null,
        error:
          "The gateway asked for a choice Clawtrate can't make here. Sign in on the gateway's machine.",
      });
      return await this.afterSignIn(id, before);
    }
    // The safety stop: a sign-in that goes on this long without asking for anything ends here,
    // as failed, and like every end it forgets what it was given.
    if (!stillMine()) return;
    await ctx.request("wizard.cancel", { sessionId: id }).catch(() => undefined);
    this.setSignIn(id, {
      stage: "failed",
      step: null,
      error: `The gateway's sign-in went on for ${MAX_SIGNIN_STEPS} steps without asking for anything, so Clawtrate stopped following it. Check the accounts, or sign in on the gateway's machine.`,
    });
    await this.afterSignIn(id, before);
  }

  /**
   * Answer the step that waits for the person: a code or address pasted back,
   * or a company address. Sent once in the next `wizard.next` and kept nowhere.
   */
  async answerSignIn(value: string): Promise<void> {
    const signIn = this.ctx.get().signIn;
    if (!signIn || signIn.stage !== "entering" || !signIn.step)
      throw new Error("No sign-in is waiting for an answer.");
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_SECRET_CHARS)
      throw new Error("That can't be sent.");
    const stepId = signIn.step.id;
    this.holdSecret(value);
    this.setSignIn(signIn.id, { stage: "checking" });
    const before = this.accountsOf(signIn.provider);
    await this.paused((pause) => this.follow(signIn.id, { stepId, value }, null, before, pause));
  }

  /**
   * Cancel the sign-in under way (`wizard.cancel`). It is reported cancelled
   * only when the gateway says so; a refusal that says it is saving is "too
   * late to cancel"; any other answer leaves it unknown, and the accounts are
   * read again.
   */
  async cancelSignIn(): Promise<{ cancelled: boolean }> {
    const signIn = this.ctx.get().signIn;
    if (!signIn || !isActive(signIn)) return { cancelled: signIn?.stage === "cancelled" };
    this.setSignIn(signIn.id, { cancelling: true, cancelUnknown: false });
    let answer: RawRecord | null = null;
    let failure: unknown = null;
    try {
      answer = asRecord(await this.ctx.request("wizard.cancel", { sessionId: signIn.id }));
    } catch (error) {
      failure = error;
    }
    if (answer?.status === "cancelled") {
      this.signInAbort?.abort();
      this.signInAbort = null;
      this.setSignIn(signIn.id, { stage: "cancelled", step: null, cancelling: false });
      void this.afterSignIn(signIn.id, signIn.known);
      return { cancelled: true };
    }
    const words = failure ? errorText(failure) : String(answer?.error ?? answer?.status ?? "");
    // Saving only when the gateway's own refusal says it is saving (row 6). Anything else, a
    // refusal for another reason or the sign-in still running past the cancel, is not known.
    if (isRefusal(failure) && /\bsav(e|ing)\b/i.test(words)) {
      this.setSignIn(signIn.id, { cancelling: false, saving: true });
    } else {
      this.setSignIn(signIn.id, {
        cancelling: false,
        cancelUnknown: true,
        error: words ? this.scrub(words) : null,
      });
      void this.load();
    }
    return { cancelled: false };
  }

  /**
   * The person's choice of which new account is the sign-in's, when several
   * appeared while it ran: that one is the sign-in's account from here on.
   */
  async chooseSignInAccount(profileId: string): Promise<void> {
    const signIn = this.ctx.get().signIn;
    if (
      !signIn ||
      (signIn.stage !== "several" && signIn.stage !== "unconfirmed") ||
      !signIn.result?.added.includes(profileId)
    )
      throw new Error("That account isn't one this sign-in may have made.");
    const account = this.ctx.get().accounts.find((each) => each.id === profileId);
    this.setSignIn(signIn.id, {
      // "Saved, not confirmed" stays what it is; it now names its account.
      stage: signIn.stage === "several" ? "connected" : "unconfirmed",
      result: {
        ...signIn.result,
        added: [profileId],
        landed: account ? (account.keptBy ? "kept" : "shared") : null,
        keptBy: account?.keptBy ?? null,
      },
    });
    await this.recordKind(profileId, kindOf(signIn));
  }

  /** Read again where a finished sign-in's account landed, after that read failed. */
  async recheckSignIn(): Promise<void> {
    const signIn = this.ctx.get().signIn;
    if (!signIn || signIn.stage !== "unverified") return;
    this.setSignIn(signIn.id, { stage: "checking", result: null });
    await this.afterSignIn(signIn.id, signIn.known);
  }

  /**
   * Forget a sign-in that has ended. One still under way is cancelled first,
   * and kept when the gateway did not confirm the cancel.
   */
  async dismissSignIn(): Promise<{ dismissed: boolean }> {
    const signIn = this.ctx.get().signIn;
    if (signIn && isActive(signIn) && !(await this.cancelSignIn()).cancelled)
      return { dismissed: false };
    this.forgetSecrets();
    this.ctx.update((a) => ({ ...a, signIn: null }));
    return { dismissed: true };
  }

  /**
   * After every sign-in, however it ended: read where the account is visible,
   * from the target bot's refreshed view and one other bot's, and re-check the
   * lock of every bot bound to that provider (bots.md sections 5, 6 and 10).
   */
  private async afterSignIn(id: string, before: string[]): Promise<void> {
    const { ctx } = this;
    const signIn = ctx.get().signIn;
    if (signIn?.id !== id) return;
    const result: SignInResult = {
      added: [],
      landed: null,
      keptBy: null,
      readFailed: false,
      locks: [],
    };
    try {
      const other = ctx.bots().find((bot) => bot.id !== signIn.forBot)?.id ?? null;
      // Neither read is shown as the bot's order, but one that fails is its newest attempt, as
      // a failed Check now: a press begun before it sends nothing after it.
      const ids = other ? [signIn.forBot, other] : [signIn.forBot];
      const { seq, out } = this.statusRead(ctx, ids, () =>
        ids.map((agentId) => ctx.request("models.authStatus", { agentId, refresh: true })),
      );
      const read = (agentId: string, asked: Promise<unknown>) =>
        asked
          .then((answer) => {
            const view = readBotView(answer, signIn.provider);
            if (view.unavailable)
              this.readFailed(ctx, agentId, seq, "unavailable", view.unavailable);
            return view;
          })
          .catch((error: unknown) => {
            this.readFailed(ctx, agentId, seq, "failed", this.scrub(errorText(error)));
            throw error;
          });
      const [target, second] = await Promise.all([
        read(signIn.forBot, out[0]!),
        other ? read(other, out[1]!) : Promise.resolve(null),
      ]);
      if (target.unavailable || second?.unavailable)
        throw new Error("The gateway says its account status is unavailable.");
      const known = new Set(before);
      result.added = target.profiles
        .filter((p) => p.provider === signIn.provider && !known.has(p.id))
        .map((p) => p.id);
      const first = result.added.length === 1 ? result.added[0] : undefined;
      if (first) {
        const shared =
          second?.profiles.some((p) => p.id === first && p.source !== "saved") ?? false;
        result.landed = shared ? "shared" : "kept";
        result.keptBy = shared ? null : signIn.forBot;
        if (signIn.stage === "checking" || signIn.stage === "unconfirmed")
          await this.recordKind(first, kindOf(signIn));
      }
      result.locks = await this.checkLocksOf(signIn.provider);
    } catch {
      result.readFailed = true;
    }
    if (ctx.get().signIn?.id !== id) return;
    const ended = ctx.get().signIn!;
    // "Connected" only when the read after it shows the account; otherwise what is known.
    const stage =
      ended.stage !== "checking"
        ? ended.stage
        : result.readFailed
          ? "unverified"
          : result.added.length > 1
            ? "several"
            : result.added.length === 1
              ? "connected"
              : "refreshed";
    this.setSignIn(id, { result, stage, saving: false, cancelling: false });
    // The accounts read again while what it was given is still held: its errors are scrubbed too.
    try {
      await this.load();
    } finally {
      if (ctx.get().signIn?.id === id) this.forgetSecrets();
    }
  }

  /** Every bot bound to an account of `provider`: was it locked, and is it still? */
  private async checkLocksOf(provider: string): Promise<LockCheck[]> {
    const bound = this.ctx
      .get()
      .bindings.filter((b) => b.mode === "account" && b.provider === provider)
      .slice(0, MAX_LOCK_CHECKS);
    const checks: LockCheck[] = [];
    for (const binding of bound) {
      const wasLocked = binding.evidence.status === "matched";
      await this.checkLock(binding.botId);
      if (!wasLocked) continue;
      const status = this.ctx.get().bindings.find((b) => b.botId === binding.botId)
        ?.evidence.status;
      // "Widened" only when the read afterwards shows the order naming more than the account.
      checks.push({
        botId: binding.botId,
        account: binding.account!,
        outcome:
          status === "matched"
            ? "kept"
            : status === "multi"
              ? "widened"
              : status === "failed" || status === "unavailable" || status === undefined
                ? "unchecked"
                : "changed",
      });
    }
    return checks;
  }

  private async recordKind(profileId: string, kind: KindRecord): Promise<void> {
    if (!prefProfileId(profileId)) return;
    this.remember(this.kinds, profileId, kind, MAX_ACCOUNTS);
    await this.ctx
      .request("users.prefs.set", { entries: { [`${KIND_PREF_PREFIX}${profileId}`]: kind } })
      .catch((error: unknown) =>
        this.log(`could not record an account's kind: ${errorText(error)}`),
      );
  }

  /** Record what Clawtrate set for a bot; the write's error, or null when it landed or isn't kept. */
  private async recordIntent(
    botId: string,
    intent: BindingIntent,
    ctx: AccountsContext = this.ctx,
  ): Promise<unknown> {
    // An id too long to be one Clawtrate keeps is not recorded.
    if (!prefBotId(botId) || (intent.mode === "account" && !prefProfileId(intent.account)))
      return null;
    this.remember(this.intents, botId, intent, MAX_ACCOUNTS);
    try {
      await ctx.request("users.prefs.set", {
        entries: { [`${INTENT_PREF_PREFIX}${botId}`]: intent },
      });
      return null;
    } catch (error) {
      this.log(`could not record a bot's account: ${errorText(error)}`);
      return error;
    }
  }

  /**
   * Save an API key the person typed. It goes to the gateway once, through the
   * provider's key sign-in when the gateway offers one, otherwise through
   * `models.authSetApiKey`, and is kept nowhere.
   */
  async saveKey(
    provider: string,
    key: string,
    botId: string | null,
  ): Promise<{ profileId: string | null }> {
    this.requireAdmin("Connecting an account");
    if (typeof key !== "string" || key.trim().length === 0 || key.length > MAX_SECRET_CHARS)
      throw new Error("Enter a key.");
    const target = this.ctx.get().keyProviders.find((each) => each.provider === provider);
    if (!target) throw new Error("The gateway doesn't take a key for that provider.");
    const method = target.method
      ? this.ctx.get().methods.find((m) => m.id === target.method)
      : null;
    if (method) {
      const id = `clawtrate-${this.ctx.randomId()}`;
      await this.begin(
        {
          id,
          method: method.id,
          provider,
          label: method.label,
          flow: "key",
          forBot: this.signInTarget(botId),
          keptOnly: !this.ctx.get().mainShared,
          stage: "starting",
          step: null,
          error: null,
          cancelling: false,
          saving: false,
          startedAt: this.ctx.now(),
          result: null,
          byKey: true,
          known: [],
          cancelUnknown: false,
        },
        key,
        true,
      );
      const after = this.ctx.get().signIn;
      return { profileId: after?.id === id ? (after.result?.added[0] ?? null) : null };
    }
    const forBot = this.signInTarget(botId);
    const before = this.accountsOf(provider);
    this.setWrite({
      what: "key",
      target: provider,
      status: "saving",
      error: null,
      at: this.ctx.now(),
    });
    // Held while this save lasts, like a sign-in's: every answer and log line is scrubbed of it.
    this.holdSecret(key);
    try {
      const answer = asRecord(
        await this.ctx.request("models.authSetApiKey", { provider, apiKey: key, agentId: forBot }),
      );
      const named = typeof answer?.profileId === "string" ? answer.profileId : null;
      // Saved only when the read after it shows the account, as for every sign-in.
      await this.load();
      const read = this.ctx.get();
      const added = read.accounts
        .filter((a) => a.provider === provider && !before.includes(a.id))
        .map((a) => a.id);
      const shown =
        read.status !== "ready"
          ? null
          : named
            ? read.accounts.some((a) => a.id === named)
              ? named
              : null
            : added.length === 1
              ? added[0]!
              : null;
      if (shown) await this.recordKind(shown, "typed-key");
      this.setWrite({
        what: "key",
        target: provider,
        status: shown ? "saved" : "unverified",
        error: shown
          ? null
          : read.status !== "ready"
            ? `The gateway took the key, but reading its accounts afterwards failed${read.error ? `: ${read.error}` : ""}.`
            : "The gateway took the key, but its accounts don't show it yet.",
        at: this.ctx.now(),
      });
      return { profileId: shown };
    } catch (error) {
      const message = withoutSecret(errorText(error), key);
      this.setWrite({
        what: "key",
        target: provider,
        status: "failed",
        error: message,
        at: this.ctx.now(),
      });
      // No `cause`: the gateway's own error may carry the key; only its cleaned words leave.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(message);
    } finally {
      this.releaseSecret(key);
    }
  }

  private setWrite(write: AccountWrite | null): void {
    const clean = write?.error ? { ...write, error: this.scrub(write.error) } : write;
    this.ctx.update((a) => ({ ...a, write: clean }));
  }

  // Writes to config ---------------------------------------------------------------------

  /**
   * One merge patch of the gateway's config (`config.patch`, admin), then the
   * gateway applying it: `config.get` reports the new revision as applied.
   */
  private async patch(
    patch: RawRecord,
    replacePaths: string[] = [],
    ctx: AccountsContext = this.ctx,
  ): Promise<void> {
    await this.patchFrom(() => ({ patch, replacePaths }), ctx);
  }

  /**
   * A merge patch made from the config it is held to: `build` reads the same `config.get` answer
   * whose hash the patch carries, so what it adds was read in the config it changes; null sends
   * nothing. Returns what `build` made and the last config read: after the write, the applied one.
   * `onSent` runs as soon as the gateway has taken the patch, before the reads that confirm it, so
   * what the gateway took is kept even when a read after it fails.
   */
  private async patchFrom<T extends { patch: RawRecord; replacePaths: string[] }>(
    build: (config: RawRecord | null) => T | null,
    ctx: AccountsContext = this.ctx,
    onSent?: (sent: T) => void,
  ): Promise<{ sent: T | null; config: RawRecord | null; applied: boolean }> {
    const before = asRecord(await ctx.request("config.get", {}));
    const runs = (read: RawRecord | null) =>
      read?.configRevisionHash === undefined || read.appliedConfigHash === read.configRevisionHash;
    const sent = build(before);
    if (!sent) return { sent, config: before, applied: runs(before) };
    const baseHash = typeof before?.hash === "string" ? before.hash : undefined;
    await ctx.request("config.patch", {
      raw: JSON.stringify(sent.patch),
      ...(baseHash ? { baseHash } : {}),
      ...(sent.replacePaths.length > 0 ? { replacePaths: sent.replacePaths } : {}),
    });
    onSent?.(sent);
    // A gateway that reports no revisions has nothing to wait for, and no read to trust.
    if (before?.configRevisionHash === undefined) return { sent, config: null, applied: false };
    const started = ctx.now();
    let now: RawRecord | null = null;
    // At most 20 seconds, and at most 100 reads whatever the clock says.
    for (let reads = 0; reads < 100 && ctx.now() - started < 20_000; reads += 1) {
      now = asRecord(await ctx.request("config.get", {}));
      const revised = now?.configRevisionHash !== before.configRevisionHash;
      if (revised && now?.appliedConfigHash === now?.configRevisionHash) break;
      // A patch that changed nothing leaves the revision as it was.
      if (!revised && (ctx.now() - started > 3_000 || reads >= 15)) break;
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 200));
    }
    // Only a read of a config the running gateway has applied says what it now does.
    const revised = now?.configRevisionHash !== before.configRevisionHash;
    return { sent, config: now, applied: revised && runs(now) };
  }

  /**
   * The refused models read again from a config read after a write (#799): only a read of a config
   * the running gateway has applied, never the write's answer alone.
   */
  private refusedAfter(config: RawRecord | null, applied: boolean): void {
    if (!config || !applied) return;
    this.ctx.update((a) => ({ ...a, modelsRefused: this.refusedIn(config, a.bindings) }));
  }

  /** A label, `auth.profiles.<id>.displayName` (row 9). */
  async setLabel(profileId: string, label: string): Promise<void> {
    this.requireAdmin("Changing a label");
    const value = normalizeLabel(label);
    const problem = labelProblem(this.ctx.get().accounts, profileId, value);
    if (problem) throw new Error(problem);
    if (value.length === 0) return;
    const account = this.ctx.get().accounts.find((a) => a.id === profileId);
    const config = asRecord(await this.ctx.request("config.get", {}));
    const existing = asRecord(
      asRecord(asRecord(asRecord(config?.config)?.auth)?.profiles)?.[profileId],
    );
    const entry: RawRecord = { displayName: value };
    // A profile the config does not list yet needs its provider and mode beside the label.
    if (!existing) {
      entry.provider = account?.provider ?? accountProvider(profileId);
      entry.mode =
        account?.type === "api_key" ? "api_key" : account?.type === "token" ? "token" : "oauth";
    }
    this.setWrite({
      what: "label",
      target: profileId,
      status: "saving",
      error: null,
      at: this.ctx.now(),
    });
    try {
      await this.patch({ auth: { profiles: { [profileId]: entry } } });
      this.setWrite({
        what: "label",
        target: profileId,
        status: "saved",
        error: null,
        at: this.ctx.now(),
      });
    } catch (error) {
      this.setWrite({
        what: "label",
        target: profileId,
        status: "failed",
        error: errorText(error),
        at: this.ctx.now(),
      });
      throw error;
    }
    await this.load();
  }

  /** Remove an account (`models.authLogout`), from the store that keeps it. */
  async disconnect(profileId: string): Promise<void> {
    this.requireAdmin("Disconnecting an account");
    const account = this.ctx.get().accounts.find((a) => a.id === profileId);
    if (!account) throw new Error("That account is no longer on the gateway.");
    this.setWrite({
      what: "disconnect",
      target: profileId,
      status: "saving",
      error: null,
      at: this.ctx.now(),
    });
    try {
      await this.ctx.request("models.authLogout", {
        provider: account.provider,
        profileIds: [profileId],
        agentId: account.keptBy ?? this.signInTarget(null),
      });
      this.setWrite({
        what: "disconnect",
        target: profileId,
        status: "saved",
        error: null,
        at: this.ctx.now(),
      });
    } catch (error) {
      this.setWrite({
        what: "disconnect",
        target: profileId,
        status: "failed",
        error: errorText(error),
        at: this.ctx.now(),
      });
      throw error;
    }
    await this.load();
  }

  // Bots ---------------------------------------------------------------------------------

  /**
   * Create a bot on an account, or with no fixed account (bots.md section 3):
   * `agents.create`, the record of what Clawtrate set for it, its model with
   * an empty fallback list and its effort through `config.patch`, the bot
   * list read back, then its first task. A create that got no answer is never
   * sent again: the bot list is read first for the one it may have made, and
   * only a bot that was not there before the first Create can be that one.
   */
  /**
   * Run a bot write bound to one gateway: what it sends, reads back and publishes goes only to a
   * connection whose identity is that gateway's, read and matched positively each time, as
   * across a reconnect to the same gateway. Another gateway, an unknown identity, or a reset,
   * retires it: nothing more is sent or published.
   */
  private async boundTo<T>(
    binding: WriteBinding | undefined,
    run: (ctx: AccountsContext, mark: WriteMark) => Promise<T>,
  ): Promise<T> {
    const base = this.ctx;
    // This write's own mark and context: another write, refused or not, never touches them.
    const mark: WriteMark = {
      gatewayId: binding?.gatewayId ?? null,
      target: binding?.target ?? null,
      resets: this.resets,
      retired: false,
    };
    // The host pointed at a gateway anew since the screen was read: another gateway, whatever
    // its identity says.
    const sameTarget = () => mark.target === null || base.target() === mark.target;
    const live = () => !mark.retired && this.resets === mark.resets;
    const check = async () => {
      if (!live()) throw new WriteRetired();
      if (!sameTarget()) {
        mark.retired = true;
        throw new WriteRetired();
      }
      // In-host callers can omit the identity. Their writes still end on reset.
      if (mark.gatewayId === null) return;
      const here = await base.gateway();
      if (!live() || here === null || here !== mark.gatewayId) {
        const unknown = live() && here === null;
        mark.retired = true;
        throw new WriteRetired(unknown);
      }
    };
    const ctx: AccountsContext = {
      ...base,
      request: async (method, params, options) => {
        await check();
        return base.request(method, params, options);
      },
      refreshBots: async () => {
        await check();
        return base.refreshBots();
      },
      createMainTask: async (botId) => {
        await check();
        return base.createMainTask(botId);
      },
      update: (change) => {
        if (
          live() &&
          sameTarget() &&
          (mark.gatewayId === null || base.gatewayNow() === mark.gatewayId)
        )
          base.update(change);
      },
    };
    try {
      const result = await run(ctx, mark);
      if (!live()) throw new WriteRetired();
      return result;
    } catch (error) {
      if (error instanceof WriteRetired || !live()) {
        // Its Create, if still the one under way, ends with it: the gateway now connected can
        // be asked for a bot. A Create begun since is another write's, and is left alone.
        if (this.creating === mark) {
          this.creating = null;
          if (this.slowTimer) clearTimeout(this.slowTimer);
          this.slowTimer = null;
          // A bot made on a gateway that has only gone quiet is kept, with what is left, for its
          // Finish once it says who it is again (`onGateway`); another gateway, or a reset, drops it.
          const left = error instanceof WriteRetired ? error.unfinished : null;
          const doubtful = error instanceof WriteRetired && error.doubtful;
          base.update((a) =>
            a.creation?.status === "creating" || a.creation?.status === "checking"
              ? {
                  ...a,
                  // In doubt, it is kept as a Create to try again: that looks for the bot first,
                  // against the bots there before the first Create, and never makes a second.
                  creation: doubtful
                    ? {
                        ...a.creation,
                        status: "failed",
                        slow: false,
                        uncertain: true,
                        error: this.scrub(
                          `The connection to the gateway was lost before Clawtrate could tell whether ${a.creation.name} was made. Create again looks for it first.`,
                        ),
                      }
                    : left
                      ? {
                          name: left.name,
                          status: "partial",
                          slow: false,
                          botId: left.botId,
                          error: this.scrub(
                            `${left.name} was created, but the connection to its gateway was lost before it was finished.`,
                          ),
                          missing: left.missing,
                          uncertain: false,
                        }
                      : null,
                }
              : a,
          );
        }
        throw new Error(
          "The gateway changed before the bot was finished, so nothing more was sent.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async createBot(input: CreateBotInput, binding?: WriteBinding): Promise<CreatedBot> {
    // The picker read already under way is answered before anything is written: a new bot's
    // writes and first task never overlap it (the gateway refuses them alongside each other).
    await this.pickerRead;
    // And a Refresh under way, whole: an account read can take the picker's place in the wait
    // while the refresh it held back is still to ask (#565).
    await this.refreshing?.promise.catch(() => {});
    return this.boundTo(binding, (ctx, mark) => this.create(ctx, input, mark));
  }

  private async create(
    ctx: AccountsContext,
    input: CreateBotInput,
    mark: WriteMark,
  ): Promise<CreatedBot> {
    this.requireAdmin("Creating a bot");
    const name = input.name.trim() || "New bot";
    const previous = ctx.get().creation;
    if (previous?.status === "creating" || previous?.status === "checking")
      throw new Error("A bot is already being created.");
    if (previous?.status === "partial" && previous.botId)
      throw new Error(`${previous.name} exists already: finish it rather than create it again.`);
    const ref: ModelRef = { provider: input.provider, model: input.model, account: input.account };
    if (input.account && accountProvider(input.account) !== input.provider)
      throw new Error("That account belongs to another provider.");
    // An explicit picture must be one the gateway can keep and Clawtrate can read back;
    // null leaves the bot to the Clawling its id gives.
    if (input.avatar !== null && !isKeepablePicture(input.avatar))
      throw new Error("That picture can't be kept.");
    const avatar = input.avatar;
    // The bots there before: kept from the first Create of this name while its answer is in doubt.
    const retrying =
      previous?.status === "failed" && previous.uncertain && previous.name === name && this.planned
        ? this.planned.name === name
        : false;
    // The state's bot list, which holds at most MAX_BOTS.
    if (!retrying) this.before.splice(0, this.before.length, ...ctx.bots().map((bot) => bot.id));
    this.planned = {
      name,
      botId: null,
      ref,
      effort: input.effort,
      intent: input.account ? { mode: "account", account: input.account } : { mode: "gateway" },
      picture: avatar !== null,
    };
    this.creating = mark;
    this.creationGateway = mark.gatewayId;
    this.creationTarget = mark.target;
    ctx.update((a) => ({
      ...a,
      creation: {
        name,
        status: "creating",
        slow: false,
        botId: null,
        error: null,
        missing: [],
        uncertain: false,
      },
    }));
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.slowTimer = setTimeout(() => {
      ctx.update((a) =>
        a.creation && (a.creation.status === "creating" || a.creation.status === "checking")
          ? { ...a, creation: { ...a.creation, slow: true } }
          : a,
      );
    }, SLOW_CREATE_MS);
    const assertCreating = () => {
      if (this.creating !== mark) throw new WriteRetired();
    };
    const failed = (error: unknown, uncertain: boolean): never => {
      assertCreating();
      return this.creationFailed(ctx, error, uncertain);
    };
    let botId: string | null = null;
    // After an answer that settled nothing, the bot may exist: look before asking again.
    if (retrying) botId = await this.findMade(ctx, name, mark);
    if (!botId) {
      try {
        const answer = asRecord(
          await ctx.request("agents.create", {
            name,
            model: formatModelRef(ref),
            ...(avatar ? { avatar } : {}),
          }),
        );
        botId = typeof answer?.agentId === "string" ? answer.agentId : null;
      } catch (error) {
        // Only a refusal that establishes nothing was written ends here. Anything else (no
        // answer, a dropped connection, "saved but not applied") may have made the bot.
        if (isCertainRefusal(error)) return failed(error, false);
        botId = await this.findMade(ctx, name, mark);
        if (!botId) return failed(error, true);
      }
    }
    if (!botId) return failed(new Error("The gateway did not say which bot it made."), true);
    assertCreating();
    this.planned = { ...this.planned, botId };
    return this.complete(
      ctx,
      name,
      botId,
      ["identity", "preference", "fallbacks", "listed", "task"],
      mark,
    );
  }

  /**
   * Change a bot's picture (bots.md section 8), in this order: check access
   * and the picture, `agents.update` with it, the bot list read again, and a
   * comparison. `confirmed` is whether that list shows the picture sent.
   */
  async setBotPicture(
    botId: string,
    avatar: string,
    binding?: WriteBinding,
  ): Promise<{ confirmed: boolean }> {
    return this.boundTo(binding, (ctx) => this.writePicture(ctx, botId, avatar));
  }

  private async writePicture(
    ctx: AccountsContext,
    botId: string,
    avatar: string,
  ): Promise<{ confirmed: boolean }> {
    this.requireAdmin("Changing a bot's picture");
    if (!isKeepablePicture(avatar)) throw new Error("That picture can't be kept.");
    await ctx.request("agents.update", { agentId: botId, avatar });
    // The gateway took the picture. A list that can't be read now leaves it unconfirmed, not unsaved.
    try {
      await ctx.refreshBots();
    } catch {
      return { confirmed: false };
    }
    return { confirmed: ctx.bots().find((bot) => bot.id === botId)?.avatarUrl === avatar };
  }

  /**
   * Write what the plan of a Create still lacks for `botId`, in order: its name
   * in its identity file, ending OpenClaw's first-run questions, the record of
   * what Clawtrate set, the model with its empty fallback list and effort, the
   * bot list read back showing it, the first task. What does not land is
   * reported, and finished by the bot's id.
   */
  private async complete(
    ctx: AccountsContext,
    name: string,
    botId: string,
    steps: MissingStep[],
    mark: WriteMark,
  ): Promise<CreatedBot> {
    const plan = this.planned?.botId === botId ? this.planned : null;
    // What this write records of the bot's fallback list counts only while it owns the creation:
    // after a reset, or once a newer Create owns it, a late answer leaves the record alone.
    const owns = () => this.creating === mark;
    const missing: MissingStep[] = [];
    const errors: string[] = [];
    const failed = (step: MissingStep, words: string, error?: unknown) => {
      missing.push(step);
      const why = error === undefined ? "" : `: ${errorText(error)}`;
      errors.push(`${words}${why}`);
      this.log(`${botId}: ${words}${why}`);
    };
    // Cut off with no gateway saying who it is: the bot is made, and this step, those after it
    // and those that failed before are what its Finish will write.
    const cut = (error: WriteRetired, step: MissingStep) => {
      if (error.unknown)
        error.unfinished = {
          name,
          botId,
          missing: [
            ...missing,
            ...steps.filter((s) => STEP_ORDER.indexOf(s) >= STEP_ORDER.indexOf(step)),
          ],
        };
      return error;
    };
    if (steps.includes("identity")) {
      try {
        await this.endFirstRun(ctx, botId, name, plan?.picture ?? false);
      } catch (error) {
        if (error instanceof WriteRetired) throw cut(error, "identity");
        failed("identity", "OpenClaw's first-run questions were not turned off", error);
      }
    }
    if (steps.includes("preference") && plan) {
      const error = await this.recordIntent(botId, plan.intent, ctx);
      if (error instanceof WriteRetired) throw cut(error, "preference");
      if (error !== null)
        failed("preference", "Clawtrate's record of its account was not saved", error);
    }
    if (steps.includes("fallbacks")) {
      try {
        if (plan) await this.writeModel(botId, plan.ref, plan.effort, false, ctx, owns);
        else
          await this.patch(
            { agents: { entries: { [botId]: { model: { fallbacks: [] } } } } },
            [`agents.entries.${botId}.model.fallbacks`],
            ctx,
          );
        if (owns()) this.unwritten.delete(botId);
      } catch (error) {
        if (error instanceof WriteRetired) throw cut(error, "fallbacks");
        if (owns()) {
          this.unwritten.add(botId);
          if (this.unwritten.size > MAX_ACCOUNTS)
            this.unwritten.delete(this.unwritten.values().next().value!);
        }
        failed(
          "fallbacks",
          plan?.effort
            ? "its model with an empty fallback list and its effort were not written"
            : "its model with an empty fallback list was not written",
          error,
        );
      }
    }
    if (steps.includes("listed")) {
      // "Created" only once the gateway's bot list shows it.
      let shown = false;
      let readError: unknown;
      try {
        await ctx.refreshBots();
        shown = ctx.bots().some((bot) => bot.id === botId);
      } catch (error) {
        if (error instanceof WriteRetired) throw cut(error, "listed");
        readError = error;
      }
      if (!shown)
        failed(
          "listed",
          readError === undefined
            ? "the gateway's bot list doesn't show it yet"
            : "reading the gateway's bot list afterwards failed",
          readError,
        );
    }
    if (steps.includes("task")) {
      try {
        await ctx.createMainTask(botId);
      } catch (error) {
        if (error instanceof WriteRetired) throw cut(error, "task");
        failed("task", "its first task was not made", error);
      }
    }
    return this.settleCreation(ctx, name, botId, missing, errors, mark);
  }

  /**
   * End OpenClaw's first run for a bot Clawtrate named. A new workspace gets `BOOTSTRAP.md`, which
   * has the bot ask what to call it, make itself a picture and save both over what was chosen
   * here. The gateway has no method that removes it, and none that creates a bot without it and
   * still seeds `AGENTS.md` and the other starting files. It ends it itself once `IDENTITY.md`
   * differs from its template: before the next turn is put together, it records the first run
   * as done and removes `BOOTSTRAP.md` (`docs/research/bot-self-management.md`, R35 to R37). So
   * Clawtrate writes the name there, with `agents.files.set` held to the file it read. With no
   * `BOOTSTRAP.md` there is no first run to end, and nothing is written.
   *
   * The picture stays in the bot's settings, where the gateway keeps it and where it takes
   * precedence over the file; the file says it was chosen and is not a copy of it, which would
   * be up to 32 KB in every turn.
   */
  private async endFirstRun(
    ctx: AccountsContext,
    botId: string,
    name: string,
    picture: boolean,
  ): Promise<void> {
    const read = async (file: string) => {
      const answer = asRecord(
        asRecord(await ctx.request("agents.files.get", { agentId: botId, name: file }))?.file,
      );
      if (!answer) throw new Error(`The gateway did not return ${file}.`);
      return answer;
    };
    if ((await read("BOOTSTRAP.md")).missing === true) return;
    const identity = await read("IDENTITY.md");
    const held =
      identity.missing === true
        ? { expectedMissing: true }
        : typeof identity.hash === "string" && /^[a-f0-9]{64}$/i.test(identity.hash)
          ? { expectedHash: identity.hash }
          : null;
    if (!held) throw new Error("The gateway did not return IDENTITY.md's revision.");
    const result = asRecord(
      await ctx.request("agents.files.set", {
        agentId: botId,
        name: "IDENTITY.md",
        content: identityFile(name, picture),
        ...held,
      }),
    );
    if (result?.ok !== true) throw new Error("The gateway did not confirm IDENTITY.md was saved.");
  }

  /** The creation's end: created, or partial with what it lacks. */
  private async settleCreation(
    ctx: AccountsContext,
    name: string,
    botId: string,
    missing: MissingStep[],
    errors: string[],
    mark: WriteMark,
  ): Promise<CreatedBot> {
    // The timer is the Create's that owns the creation: one retired by a reset, settling late,
    // leaves the timer of a Create begun since.
    if (this.creating === mark) {
      if (this.slowTimer) clearTimeout(this.slowTimer);
      this.slowTimer = null;
    }
    // Settled while the connection hasn't said which gateway it is: the result is kept, for the
    // gateway it was asked of (another saying who it is drops it), so the Create is never left
    // "creating" and its Finish is there once that gateway says who it is.
    const unidentified =
      this.creating === mark &&
      !mark.retired &&
      mark.resets === this.resets &&
      mark.gatewayId !== null &&
      this.ctx.gatewayNow() === null;
    (unidentified ? this.ctx : ctx).update((a) => ({
      ...a,
      creation: {
        name,
        status: missing.length > 0 ? "partial" : "created",
        slow: false,
        botId,
        error:
          errors.length > 0
            ? this.scrub(`${name} was created, but ${errors.join(", and ")}.`)
            : null,
        missing,
        uncertain: false,
      },
    }));
    await this.load();
    return { botId, missing };
  }

  /**
   * The bot a create may have made: once connected, read the list and find a
   * bot of that name that was not there before the first Create of it. Never
   * one that was. Only a successful read without a match returns null.
   */
  private async findMade(
    ctx: AccountsContext,
    name: string,
    mark: WriteMark,
  ): Promise<string | null> {
    ctx.update((a) => (a.creation ? { ...a, creation: { ...a.creation, status: "checking" } } : a));
    const before = new Set(this.before);
    // Until a read of the list succeeds, within the deadline: an answer lost to a dropped
    // connection is often followed by a reconnect, and a read made during it is not an answer.
    for (let tries = 0; tries < 150; tries += 1) {
      if (ctx.connected()) {
        try {
          await ctx.refreshBots();
          return ctx.bots().find((bot) => bot.name === name && !before.has(bot.id))?.id ?? null;
        } catch (error) {
          // Retired: bound to a gateway no longer connected, so nothing more is read for it.
          if (error instanceof WriteRetired) {
            error.doubtful = error.unknown;
            throw error;
          }
          // Not read: try again once the connection is back.
        }
      }
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 200));
    }
    // No list was read. Keep the original Create in doubt, including while its gateway is
    // unidentified. A reset, a different gateway, or a newer Create has replaced the owner.
    if (this.creating !== mark) throw new WriteRetired();
    const target = ctx.gatewayNow() === null ? this.ctx : ctx;
    return this.creationFailed(
      target,
      new Error("The gateway's bot list could not be read."),
      true,
    );
  }

  /**
   * Finish a bot whose creation is partial, by its id: write what is missing
   * (the record of its account, its model with the empty fallback list and
   * effort, the bot list showing it, the first task), never create it again.
   */
  async finishBot(botId: string, binding?: WriteBinding): Promise<CreatedBot> {
    // Bound to the gateway it was asked of, or else the creation's: never finished on another.
    const creation =
      this.creationGateway === null
        ? undefined
        : { gatewayId: this.creationGateway, target: this.creationTarget };
    return this.boundTo(binding ?? creation, (ctx, mark) => this.finish(ctx, botId, mark));
  }

  private async finish(ctx: AccountsContext, botId: string, mark: WriteMark): Promise<CreatedBot> {
    this.requireAdmin("Creating a bot");
    const creation = ctx.get().creation;
    if (!creation || creation.status !== "partial" || creation.botId !== botId)
      throw new Error("That bot has nothing left to finish.");
    if (this.finishing === creation) throw new Error("That bot is already being finished.");
    this.finishing = creation;
    this.creating = mark;
    try {
      ctx.update((a) =>
        a.creation ? { ...a, creation: { ...a.creation, status: "creating", error: null } } : a,
      );
      return await this.complete(ctx, creation.name, botId, creation.missing, mark);
    } finally {
      if (this.finishing === creation) this.finishing = null;
    }
  }

  /**
   * A connection said which gateway it is. A creation asked of another gateway is that
   * gateway's alone: it is not shown, kept or finished here. The same gateway back keeps it.
   */
  onGateway(gatewayId: string): void {
    // An Unlock's line is about the gateway it was pressed for, even one at the same address.
    const clear = this.ctx.get().clear;
    if (clear && clear.gatewayId !== gatewayId) this.ctx.update((a) => ({ ...a, clear: null }));
    if (this.creationGateway === null || this.creationGateway === gatewayId) return;
    this.creationGateway = null;
    this.creationTarget = null;
    this.creating = null;
    this.finishing = null;
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.slowTimer = null;
    this.ctx.update((a) => (a.creation ? { ...a, creation: null } : a));
  }

  private creationFailed(ctx: AccountsContext, error: unknown, uncertain: boolean): never {
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.slowTimer = null;
    const name = ctx.get().creation?.name ?? "the bot";
    ctx.update((a) => ({
      ...a,
      creation: a.creation
        ? {
            ...a.creation,
            status: "failed",
            slow: false,
            uncertain,
            error: uncertain
              ? `The gateway's answer did not say whether ${name} was made (${errorText(error)}). Create again looks for it first.`
              : errorText(error),
          }
        : null,
    }));
    throw error instanceof Error ? error : new Error(String(error));
  }

  /** Forget a creation that has settled. */
  dismissCreation(): void {
    this.ctx.update((a) =>
      a.creation &&
      (a.creation.status === "failed" ||
        a.creation.status === "created" ||
        // The person chose to open the bot as it is; its Account page still says what is missing.
        a.creation.status === "partial")
        ? { ...a, creation: null }
        : a,
    );
  }

  /**
   * The bot's model with its account and `fallbacks: []`, and its effort, in one patch. `allow`:
   * the person chose this model (#799), so the same patch puts it on the list that refuses it; an
   * effort alone changes no list.
   */
  private async writeModel(
    botId: string,
    ref: ModelRef,
    effort: string | null,
    creating: boolean,
    ctx: AccountsContext = this.ctx,
    owns: () => boolean = () => true,
    allow = true,
  ): Promise<void> {
    const entry: RawRecord = { model: { primary: formatModelRef(ref), fallbacks: [] } };
    if (effort) entry.thinkingDefault = effort;
    const model = { agents: { entries: { [botId]: entry } } };
    const paths = [`agents.entries.${botId}.model.fallbacks`];
    const version = ctx.serverVersion?.() ?? null;
    // What this write publishes is its gateway's only while no reset has come since it began.
    const resets = this.resets;
    try {
      // The model goes on the list that limits the bot in the same write (#799), so a task the
      // bot starts on it isn't refused; and with it nothing is written if the model is refused.
      // A list at the most Clawtrate writes back gets nothing: the bot's settings then say why.
      const chosen = { provider: ref.provider.toLowerCase(), model: ref.model };
      const { config, applied } = await this.patchFrom(
        (read) => {
          const added = allow ? allowAddition(read, botId, chosen, version) : null;
          return added && added !== "full"
            ? {
                patch: mergePatch(model, added.patch),
                replacePaths: [...paths, ...added.replacePaths],
                added,
              }
            : { patch: model, replacePaths: paths, added: null };
        },
        ctx,
        // Kept once the gateway took it, before the reads that confirm it. An effort alone
        // leaves the line as it was.
        (sent) => {
          if (allow && this.resets === resets) this.allowedBy(botId, chosen, sent.added);
        },
      );
      if (owns()) this.unwritten.delete(botId);
      if (this.resets === resets) this.refusedAfter(config, applied);
    } catch (error) {
      if (!creating) throw error;
      // The bot exists; its Account page offers the write again (bots.md section 3).
      this.unwritten.add(botId);
      if (this.unwritten.size > MAX_ACCOUNTS)
        this.unwritten.delete(this.unwritten.values().next().value!);
      this.log(`the empty fallback list for ${botId} did not land: ${errorText(error)}`);
    }
  }

  /** "Try again" for a created bot whose empty fallback list did not land. */
  async retryFallbacks(botId: string): Promise<void> {
    await this.removeFallbacks(botId);
  }

  /**
   * The context a bot setting writes through: `beforeSend` runs before each request, told
   * whether this setting has sent a write yet, and `check` runs it between steps.
   */
  private checked(beforeSend?: (sent: boolean) => void): {
    ctx: AccountsContext;
    check: () => void;
  } {
    if (!beforeSend) return { ctx: this.ctx, check: () => {} };
    const base = this.ctx;
    let wrote = false;
    const check = () => beforeSend(wrote);
    return {
      check,
      ctx: {
        ...base,
        request: async (method, params, options) => {
          check();
          if (method !== "config.get" && method !== "models.authStatus") wrote = true;
          return base.request(method, params, options);
        },
      },
    };
  }

  /**
   * Change a bot's account, or to no fixed account, with its model and effort (section 11).
   * `beforeSend` runs before each request: the host's check that the screen's gateway is here.
   */
  async changeAccount(
    botId: string,
    account: string | null,
    provider: string,
    model: string,
    effort: string | null,
    beforeSend?: (sent: boolean) => void,
  ): Promise<void> {
    this.requireAdmin("Changing a bot's settings");
    if (account && accountProvider(account) !== provider)
      throw new Error("That account belongs to another provider.");
    this.setWrite({
      what: "account",
      target: botId,
      status: "saving",
      error: null,
      at: this.ctx.now(),
    });
    try {
      const { ctx, check } = this.checked(beforeSend);
      await this.writeModel(botId, { provider, model, account }, effort, false, ctx);
      // Before the record is kept here as well as sent: the gateway it is for is still the one.
      check();
      await this.recordIntent(
        botId,
        account ? { mode: "account", account } : { mode: "gateway" },
        ctx,
      );
      // After the last answer: a change whose gateway has gone meanwhile is not shown as saved.
      check();
      this.setWrite({
        what: "account",
        target: botId,
        status: "saved",
        error: null,
        at: this.ctx.now(),
      });
    } catch (error) {
      this.setWrite({
        what: "account",
        target: botId,
        status: "failed",
        error: errorText(error),
        at: this.ctx.now(),
      });
      throw error;
    }
    await this.checkLock(botId);
  }

  /** The bot's model and effort, keeping its account. `beforeSend` as for `changeAccount`. */
  async setModel(
    botId: string,
    model: string,
    effort: string | null,
    beforeSend?: (sent: boolean) => void,
  ): Promise<void> {
    this.requireAdmin("Changing a bot's settings");
    const binding = this.ctx.get().bindings.find((b) => b.botId === botId);
    if (!binding?.provider) throw new Error("Choose an account first.");
    this.setWrite({
      what: "model",
      target: botId,
      status: "saving",
      error: null,
      at: this.ctx.now(),
    });
    try {
      const { ctx, check } = this.checked(beforeSend);
      // Only a model the person chose goes on a list: the same model with another effort doesn't.
      await this.writeModel(
        botId,
        { provider: binding.provider, model, account: binding.account },
        effort,
        false,
        ctx,
        undefined,
        model !== binding.model,
      );
      // After the last answer: a change whose gateway has gone meanwhile is not shown as saved.
      check();
      this.setWrite({
        what: "model",
        target: botId,
        status: "saved",
        error: null,
        at: this.ctx.now(),
      });
    } catch (error) {
      this.setWrite({
        what: "model",
        target: botId,
        status: "failed",
        error: errorText(error),
        at: this.ctx.now(),
      });
      throw error;
    }
    await this.checkLock(botId);
  }

  // A model on a bot's model list (#799) -------------------------------------------------

  /** The line for what one write put on a bot's list; a write for the bot that added none clears it. */
  private allowedBy(botId: string, ref: AllowRef, added: AllowAddition | null): void {
    // The gateway this was written on, by its identity: Undo acts only there.
    const gatewayId = this.ctx.gatewayNow();
    const id = this.ctx.randomId();
    this.ctx.update((a) => {
      if (!added) return a.allowed?.botId === botId ? { ...a, allowed: null } : a;
      const allowed: ModelAllowed = {
        id,
        gatewayId,
        botId,
        provider: ref.provider,
        model: ref.model,
        entry: added.entry,
        scope: added.place === "bot" ? "bot" : "gateway",
        list: added.place,
        digest: added.digest,
        status: "added",
        error: null,
        at: this.ctx.now(),
      };
      return { ...a, allowed };
    });
  }

  /**
   * "Allow <model>": the model the button names (`shown`) onto the list that refuses it, only while
   * the bot still runs on that model and its list, read now, still refuses it; otherwise nothing
   * is written and the refusals are read again, so the line shows what is true now. Admin only;
   * nothing asks for wider access.
   */
  async allowModel(
    botId: string,
    shown: AllowRef,
    beforeSend?: (sent: boolean) => void,
  ): Promise<void> {
    this.requireAdmin("Changing a bot's settings");
    const { ctx, check } = this.checked(beforeSend);
    const version = ctx.serverVersion?.() ?? null;
    const resets = this.resets;
    const read: { ref: AllowRef | null; full: boolean } = { ref: null, full: false };
    const { config, applied } = await this.patchFrom(
      (config) => {
        read.ref = botModelRef(config, botId);
        if (read.ref?.provider !== shown.provider || read.ref.model !== shown.model) return null;
        const added = allowAddition(config, botId, read.ref, version);
        if (added !== "full") return added;
        read.full = true;
        return null;
      },
      ctx,
      // Kept once the gateway took it, before the reads that confirm it, for this gateway only.
      (sent) => {
        if (this.resets === resets && read.ref) this.allowedBy(botId, read.ref, sent);
      },
    );
    check();
    if (this.resets === resets) this.refusedAfter(config, applied);
    if (read.ref?.provider !== shown.provider || read.ref?.model !== shown.model)
      throw new Error("The bot's model has changed since this was shown, so nothing was changed.");
    if (read.full)
      throw new Error(
        `This gateway's model list has ${MAX_ALLOWLIST_ENTRIES} entries or more, more than Clawtrate writes back, so it wasn't changed.`,
      );
  }

  /**
   * Undo of the line: the one entry its addition put on a list, taken out of that very list
   * (`ModelAllowed.list`), only while that list still governs the bot and is as the addition left
   * it (`digest`), held to the config's hash. Only for the addition the screen shows (`shown.id`),
   * and only on the gateway it was written on (`gatewayId`): another addition, even of the same
   * entry, or another gateway at the same address writes nothing. Nothing else is written: not the
   * bot's earlier model, and not an entry left as the list's last, which would lift the limit.
   */
  async undoAllowed(
    shown: { botId: string; id: string },
    beforeSend?: (sent: boolean) => void,
  ): Promise<void> {
    this.requireAdmin("Changing a bot's settings");
    const allowed = this.ctx.get().allowed;
    if (!allowed || allowed.botId !== shown.botId || allowed.id !== shown.id)
      throw new Error("That change is no longer the latest one here, so nothing was undone.");
    if (allowed.gatewayId === null || allowed.gatewayId !== this.ctx.gatewayNow())
      throw new Error("That change was made on another gateway, so nothing was undone.");
    if (allowed.status === "undoing" || allowed.status === "undone") return;
    const resets = this.resets;
    const settle = (status: ModelAllowed["status"], error: string | null = null) => {
      if (this.resets !== resets) return;
      this.ctx.update((a) =>
        a.allowed?.id === allowed.id
          ? { ...a, allowed: { ...a.allowed, status, error, at: this.ctx.now() } }
          : a,
      );
    };
    settle("undoing");
    const outcome: { taken: boolean; kept: string | null } = { taken: false, kept: null };
    try {
      const { ctx, check } = this.checked(beforeSend);
      const { config, applied } = await this.patchFrom(
        (read) => {
          const removal = allowRemoval(read, allowed.botId, {
            entry: allowed.entry,
            place: allowed.list,
            digest: allowed.digest,
          });
          if (typeof removal !== "string") return removal;
          outcome.kept = removal;
          return null;
        },
        ctx,
        () => {
          outcome.taken = true;
          settle("undone");
        },
      );
      check();
      if (!outcome.taken) settle("kept", outcome.kept);
      if (this.resets === resets) {
        this.refusedAfter(config, applied);
        // Taken, and no read of the running gateway yet: the accounts are read again for it.
        if (outcome.taken && !applied) void this.load().catch(() => {});
      }
    } catch (error) {
      // The gateway took it and a read after it failed: it is out, as the gateway answered, and
      // what it refuses now comes from a read of the running gateway, made again.
      if (outcome.taken) {
        this.log(`undo of ${allowed.entry} for ${allowed.botId}: the read after it failed`);
        if (this.resets === resets) void this.load().catch(() => {});
        return;
      }
      settle("failed", this.scrub(errorText(error)));
      throw error;
    }
  }

  /** "Remove fallbacks": the bot's model keeps its account; its fallback list becomes empty. */
  async removeFallbacks(botId: string, beforeSend?: (sent: boolean) => void): Promise<void> {
    this.requireAdmin("Changing a bot's settings");
    this.setWrite({
      what: "fallbacks",
      target: botId,
      status: "saving",
      error: null,
      at: this.ctx.now(),
    });
    try {
      const { ctx, check } = this.checked(beforeSend);
      await this.patch(
        { agents: { entries: { [botId]: { model: { fallbacks: [] } } } } },
        [`agents.entries.${botId}.model.fallbacks`],
        ctx,
      );
      check();
      this.unwritten.delete(botId);
      this.setWrite({
        what: "fallbacks",
        target: botId,
        status: "saved",
        error: null,
        at: this.ctx.now(),
      });
    } catch (error) {
      this.setWrite({
        what: "fallbacks",
        target: botId,
        status: "failed",
        error: errorText(error),
        at: this.ctx.now(),
      });
      throw error;
    }
    await this.checkLock(botId);
  }

  // The connection -------------------------------------------------------------------------

  /** After a hello: a sign-in from the last connection has ended with it; read again. */
  onHello(): void {
    const signIn = this.ctx.get().signIn;
    if (signIn && isActive(signIn)) {
      this.setSignIn(signIn.id, { stage: "ended", step: null, cancelling: false, saving: false });
    }
    const ended = this.ctx.get().signIn;
    if (ended?.stage === "ended" && ended.result === null) {
      void this.afterSignIn(ended.id, ended.known);
    } else if (this.ctx.get().status !== "idle") {
      // Only once a screen has asked: the accounts are read for the screens that show them.
      void this.load();
    }
  }

  /** The connection went: what waits on it is let go. */
  onClose(): void {
    this.signInAbort?.abort();
    this.signInAbort = null;
    const signIn = this.ctx.get().signIn;
    if (signIn && isActive(signIn))
      this.setSignIn(signIn.id, { stage: "ended", step: null, cancelling: false, saving: false });
    // A sign-in ends with its connection: what it was given goes with it.
    this.forgetSecrets();
  }

  /** Another gateway: nothing read from this one is kept. */
  reset(): void {
    // A write under way belongs to the gateway it was asked of: retired, it sends nothing more.
    this.resets += 1;
    // An Unlock's line is about the gateway it was pressed for.
    if (this.ctx.get().clear) this.ctx.update((a) => ({ ...a, clear: null }));
    // A model list's line and its refusals are the gateway's they were read from (#799).
    if (this.ctx.get().allowed || this.ctx.get().modelsRefused.length > 0)
      this.ctx.update((a) => ({ ...a, allowed: null, modelsRefused: [] }));
    this.clearing = null;
    this.creating = null;
    this.creationGateway = null;
    this.creationTarget = null;
    this.finishing = null;
    this.onClose();
    this.kinds.clear();
    this.intents.clear();
    this.pickerRead = null;
    this.unwritten.clear();
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.slowTimer = null;
  }
}

/** One JSON merge patch made of two: objects merged key by key, anything else from `b`. */
function mergePatch(a: RawRecord, b: RawRecord): RawRecord {
  const out: RawRecord = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const left = asRecord(out[key]);
    const right = asRecord(value);
    out[key] =
      left && right && !Array.isArray(left) && !Array.isArray(right)
        ? mergePatch(left, right)
        : value;
  }
  return out;
}

/**
 * The gateway a read was answered by: the identity its connection named, when the read ended on
 * the connection it began on; null when that identity wasn't known, or the connection changed.
 */
function answeredBy(began: ReadStamp, ended: ReadStamp): string | null {
  if (ended.target !== began.target || ended.connectedAt !== began.connectedAt) return null;
  if (began.gatewayId !== null && ended.gatewayId !== began.gatewayId) return null;
  return ended.gatewayId;
}

/**
 * An Unlock or Clear that ended unsure (`unanswered`, `unread`, `kept`), settled by the read the
 * page shows when that read began after its send, was answered by the gateway the press was sent
 * to, and finds no stored order for its provider: the press becomes `cleared` with that read's
 * number and time, and the bot's evidence forgets the lock at once, so the page never shows
 * "Unlocked" beside "The lock is gone". A change with no press behind it keeps its warning, and a
 * read of a gateway not yet named, or of another, settles nothing, nor does one a newer attempt
 * has failed after.
 */
function settleClear(a: AccountsState): AccountsState {
  const clear = a.clear;
  if (
    !clear ||
    clear.sentSeq === null ||
    (clear.status !== "unanswered" && clear.status !== "unread" && clear.status !== "kept")
  )
    return a;
  const binding = a.bindings.find((each) => each.botId === clear.botId);
  const seq = binding?.evidence.readSeq ?? null;
  if (
    !binding ||
    seq === null ||
    seq <= clear.sentSeq ||
    // The newest attempt for the bot: one that failed since leaves the press as it was.
    binding.evidence.attemptSeq !== seq ||
    clear.gatewayId === null ||
    binding.evidence.readGateway !== clear.gatewayId ||
    !binding.evidence.providerRead ||
    binding.provider !== clear.provider ||
    binding.order?.stored === true
  )
    return a;
  return {
    ...a,
    clear: {
      ...clear,
      status: "cleared",
      error: null,
      checkedSeq: seq,
      checkedAt: binding.evidence.checkedAt,
    },
    bindings: a.bindings.map((each) =>
      each === binding
        ? { ...each, evidence: { ...each.evidence, lostAt: null, lastMatchAt: null } }
        : each,
    ),
  };
}

/** A sign-in still under way on the gateway. */
export function isActive(signIn: SignInState): boolean {
  return (
    ["starting", "waiting", "entering", "checking"].includes(signIn.stage) && signIn.result === null
  );
}

/** What Clawtrate records for an account a sign-in made, from how the sign-in went. */
function kindOf(signIn: SignInState): KindRecord {
  // A key typed here; a browser sign-in that saves a key (OpenRouter's); a subscription.
  return signIn.byKey || signIn.flow === "key"
    ? "typed-key"
    : signIn.provider === "openrouter"
      ? "sign-in-key"
      : "subscription";
}

/** The gateway answered and refused: the request was not applied. */
function isRefusal(error: unknown): boolean {
  return error instanceof GatewayProtocolRequestError;
}

/** Refusals that establish the request was not applied; anything else may have been. */
const CERTAIN_REFUSALS = new Set([
  "INVALID_REQUEST",
  "INVALID_PARAMS",
  "BAD_REQUEST",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "CONFLICT",
]);

export function isCertainRefusal(error: unknown): boolean {
  return error instanceof GatewayProtocolRequestError && CERTAIN_REFUSALS.has(error.code);
}

/** A bot the gateway made, and what of its creation did not land. */
export type CreatedBot = { botId: string; missing: MissingStep[] };

/**
 * The `IDENTITY.md` of a bot Clawtrate named: its name as a `- Name:` line, which the gateway
 * reads, and words for the bot. A picture is named, never copied, in a line the gateway doesn't
 * read as one.
 */
export function identityFile(name: string, picture: boolean): string {
  const line = name.replace(/\s+/g, " ").trim();
  return [
    "# IDENTITY.md - Who Am I?",
    "",
    `- **Name:** ${line}`,
    ...(picture
      ? [
          "- **Picture:** chosen in Clawtrate when you were made; the gateway keeps it with your settings.",
        ]
      : []),
    "",
    // No name here: the gateway's identity writers replace only the `- Name:` line, so a name
    // repeated in prose would contradict a rename in every turn.
    picture
      ? "Your name and picture were chosen in Clawtrate when you were made. Keep both. Don't make or save another picture unless the person asks for one."
      : "Your name was chosen in Clawtrate when you were made. Keep it unless the person asks for another.",
    "",
    "When the person gives you a new name, write it on the `- Name:` line above and tell them it shows once they confirm it in Clawtrate.",
    "",
  ].join("\n");
}
