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
  MAX_LOCK_CHECKS,
  MAX_SECRET_CHARS,
  MAX_SECRET_JSON_CHARS,
  mergeAccounts,
  normalizeLabel,
  parseModelRef,
  prefBotId,
  prefProfileId,
  readBotView,
  readCatalog,
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
  type AccountsState,
  type MissingStep,
  type AccountWrite,
  type BindingIntent,
  type BotBinding,
  type BotView,
  type CatalogModel,
  type LockCheck,
  type ModelRef,
  type SignInResult,
  type SignInState,
  type StoredOrder,
} from "./accounts.ts";
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { asRecord, type RawRecord } from "./mapping.ts";
import {
  approvalsFileBlocks,
  CHOICE_REFUSALS,
  chosenHolds,
  chosenReadBack,
  COMMAND_CHOICES,
  configEntry,
  entryProblem,
  FINAL_DENY,
  implicitMain,
  likelyBotId,
  MAIN_SESSIONS_PARAMS,
  MAX_HELD_BOTS,
  MAX_POLICY_NOTES,
  missingDeny,
  readCreateReply,
  readFirstBot,
  readHeldBot,
  readReportedLabel,
  restrictiveDeny,
  restrictiveReadBack,
  sameGateway,
  savedMode,
  unapplied,
  type CommandChoice,
  type CreatedIdentity,
  type HeldBot,
  type NewBotPolicy,
} from "./new-bot.ts";

/** What the engine needs from the client. */
export type AccountsContext = {
  request(
    method: string,
    params: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown>;
  get(): AccountsState;
  update(change: (accounts: AccountsState) => AccountsState): void;
  /** The bots the client lists: ids, names, which is the default. */
  bots(): Array<{ id: string; name: string; isDefault: boolean }>;
  connected(): boolean;
  /**
   * The connection now: `epoch` changes with every hello and every close,
   * `generation` with every change of gateway; `gateway` is the gateway
   * connected or being connected, its id once read.
   */
  connection(): {
    epoch: number;
    generation: number;
    gateway: { id: string | null; url: string } | null;
  };
  /** The host's own storage: the unfinished new bots are kept there across restarts. */
  storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
  };
  /** The connection holds `operator.admin`. */
  admin(): boolean;
  /** Read the bot list again (`agents.list`); its answer as the gateway sent it. */
  refreshBots(): Promise<unknown>;
  /** Give a new bot its first, empty task, "Main" (bots.md section 3), and read the task list. */
  createMainTask(botId: string): Promise<void>;
  now(): number;
  randomId(): string;
  log(message: string): void;
};

/** A write needs admin; the access bar asks for it (bots.md section 2). */
export class AdminNeededError extends Error {
  constructor(what: string) {
    super(`${what} needs admin access.`);
    this.name = "AdminNeededError";
  }
}

export type CreateBotInput = {
  name: string;
  /** A `data:image/png` picture of the chosen body and colour, or null. */
  avatar: string | null;
  /** The account, or null for "Let the gateway choose". */
  account: string | null;
  provider: string;
  model: string;
  effort: string | null;
  /** The command policy chosen in the Approvals step; without it the host sends nothing. */
  approvals: CommandChoice | null;
  /** The New bot attempt this Create is: its outcome and its dismissal are that attempt's. */
  attempt: string | null;
  /**
   * The gateway the person entered this for, as their screen showed it: on
   * any other, the host sends nothing.
   */
  gateway?: { id: string | null; url: string } | null;
};

/** One read of what the account screens show; `catalog` is null when `models.list` failed. */
type AccountsRead = {
  config: RawRecord | null;
  views: Map<string, BotView>;
  prefs: RawRecord | null;
  catalog: CatalogModel[] | null;
};

/** A Create's place among the held records, kept before `agents.create` is sent. */
type Reservation = Omit<HeldBot, "made">;

/**
 * What a confirmed Create made and what Clawtrate writes for it, on the
 * gateway that confirmed it (its held record names it): Finish uses it; it
 * goes with a change of gateway, and once nothing is left to finish.
 */
type CreatePlan = {
  /** The bot's held record: its identity, choice, model and how far its writes got. */
  held: HeldBot;
  intent: BindingIntent;
};

/** The connection a sequence began on. */
type Binding = { epoch: number; generation: number };

/** The connection a sequence began on is gone: nothing more is sent or shown for it. */
class ConnectionChangedError extends Error {
  constructor() {
    super("The connection changed.");
    this.name = "ConnectionChangedError";
  }
}

const rethrowChanged = (error: unknown): void => {
  if (error instanceof ConnectionChangedError) throw error;
};

/** Where the host keeps the unfinished new bots. */
export const HELD_KEY = "clawtrate.new-bots-held";

const heldKey = (held: HeldBot) =>
  `${held.gatewayId ?? ""}\u0000${held.gatewayUrl}\u0000${held.made.botId}`;

/**
 * A short print of a bot's config entry, its keys in order: two reads that
 * give the same print read the same entry. A bot made again at the same id
 * has another entry once Clawtrate has written to the first.
 */
export function entryPrint(entry: RawRecord | null): string {
  const canonical = (value: unknown): string =>
    Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : value && typeof value === "object"
        ? `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonical((value as RawRecord)[key])}`)
            .join(",")}}`
        : JSON.stringify(value ?? null);
  const text = canonical(entry);
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
  }
  return `${text.length.toString(36)}.${a.toString(36)}.${b.toString(36)}`;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The longest picture New bot sends. */
export const MAX_CREATE_AVATAR_CHARS = 32_768;

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
   * What the last confirmed Create made and writes for it, so Finish writes to
   * that id alone, on that gateway: at most one, gone with a change of gateway
   * and once nothing is left to finish.
   */
  private readonly planned = new Map<string, CreatePlan>();
  /**
   * New bots whose saved command setting hasn't read back as chosen, on any
   * gateway (`MAX_HELD_BOTS`), as the host's storage keeps them: nothing is
   * sent to one until it does, and "Write it again" writes from it.
   */
  private readonly held = new Map<string, HeldBot>();
  /**
   * The Create under way, from before `agents.create` until its reply settles
   * what it made: kept in storage with the held records, so it counts toward
   * their bound, and a second Create is refused while it lasts.
   */
  private reserved: Reservation | null = null;
  /** The held records' writes to storage, one after another. */
  private saving: Promise<void> = Promise.resolve();
  /** Moves with each change a write makes to the notes: a read of them begun before it applies nothing. */
  private noteWrites = 0;
  /** The new bots' settings read for their notes; one read at a time, one more after it if asked. */
  private policyRead: Promise<void> | null = null;
  private policyReadAgain = false;
  /** The latest first-bot check; an earlier one's answer is not shown. */
  private firstBotChecks = 0;
  private readonly ctx: AccountsContext;
  private loading: Promise<void> | null = null;
  private loadAgain = false;
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
    this.loading = (async () => {
      try {
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
    ctx.update((a) => ({ ...a, status: a.status === "ready" ? "ready" : "loading", error: null }));
    try {
      const read = await this.readParts((method, params) => ctx.request(method, params));
      this.readPrefs(read.prefs);
      const at = ctx.now();
      // A catalogue that couldn't be read leaves the last one shown.
      ctx.update((a) => this.compose(a, read.config, read.views, read.catalog ?? a.models, at));
    } catch (error) {
      // While a sign-in lasts, its typed values are taken out of whatever comes back.
      const message = this.scrub(errorText(error));
      ctx.update((a) => ({ ...a, status: "error", error: message }));
    }
  }

  /** One read of the config, every bot's view, the preferences and the catalogue, each through `request`. */
  private async readParts(
    request: (method: string, params: unknown) => Promise<unknown>,
  ): Promise<AccountsRead> {
    const bots = this.ctx.bots();
    const [config, views, prefs] = await Promise.all([
      request("config.get", {}).then(asRecord),
      this.readViews(
        bots.map((bot) => bot.id),
        request,
      ),
      request("users.prefs.get", {}).then(asRecord, () => null),
    ]);
    const defaultBot = bots.find((bot) => bot.isDefault)?.id ?? bots[0]?.id ?? "main";
    const catalog = await request("models.list", { agentId: defaultBot }).then(
      readCatalog,
      () => null,
    );
    return { config, views, prefs, catalog };
  }

  /**
   * Create's own read of the accounts and the catalogue, on the connection
   * Create began on: each request goes only while it lasts, and what was read
   * is shown only if it still does.
   */
  private async preflight(binding: Binding): Promise<AccountsRead> {
    const read = await this.readParts((method, params) => this.call(binding, method, params));
    if (!this.live(binding)) throw new ConnectionChangedError();
    this.readPrefs(read.prefs);
    const at = this.ctx.now();
    this.ctx.update((a) => this.compose(a, read.config, read.views, read.catalog ?? a.models, at));
    return read;
  }

  private async readViews(
    botIds: string[],
    request: (method: string, params: unknown) => Promise<unknown>,
  ): Promise<Map<string, BotView>> {
    const views = new Map<string, BotView>();
    // A few bots at a time. Sharing is decided only from refreshed answers (row 33).
    for (let i = 0; i < botIds.length; i += ACCOUNT_READ_CONCURRENCY) {
      const chunk = botIds.slice(i, i + ACCOUNT_READ_CONCURRENCY);
      const answers = await Promise.all(
        chunk.map((agentId) => request("models.authStatus", { agentId, refresh: true })),
      );
      for (let j = 0; j < chunk.length; j += 1) {
        const view = readBotView(answers[j]);
        // Not a reading: the last good one stands, and the screens say why there is none.
        if (view.unavailable)
          throw new Error(
            `The gateway says its account status is unavailable (${view.unavailable}).`,
          );
        views.set(chunk[j]!, view);
      }
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
      return this.binding(botId, asRecord(entries[botId]), views.get(botId)!, before, at);
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
      bindings,
    };
  }

  private binding(
    botId: string,
    entry: RawRecord | null,
    view: BotView,
    before: BotBinding | undefined,
    at: number,
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
    try {
      const [answer, config] = await Promise.all([
        ctx.request("models.authStatus", { agentId: botId, refresh: true }),
        ctx.request("config.get", {}).then(asRecord),
      ]);
      const view = readBotView(answer);
      if (view.unavailable) {
        const reason = view.unavailable;
        ctx.update((a) =>
          this.patchBinding(a, botId, (b) => ({
            ...b,
            evidence: { ...b.evidence, status: "unavailable", error: reason },
          })),
        );
        return;
      }
      const entry = asRecord(
        asRecord(asRecord(asRecord(config?.config)?.agents)?.entries)?.[botId],
      );
      const at = ctx.now();
      ctx.update((a) => {
        const current = a.bindings.find((each) => each.botId === botId) ?? before;
        const next = this.binding(botId, entry, view, current, at);
        return { ...a, bindings: a.bindings.map((each) => (each.botId === botId ? next : each)) };
      });
    } catch (error) {
      ctx.update((a) =>
        this.patchBinding(a, botId, (b) => ({
          ...b,
          evidence: { ...b.evidence, status: "failed", error: this.scrub(errorText(error)) },
        })),
      );
    }
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
      const [target, second] = await Promise.all([
        ctx
          .request("models.authStatus", { agentId: signIn.forBot, refresh: true })
          .then(readBotView),
        other
          ? ctx.request("models.authStatus", { agentId: other, refresh: true }).then(readBotView)
          : Promise.resolve(null),
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
  private async recordIntent(botId: string, intent: BindingIntent): Promise<unknown> {
    // An id too long to be one Clawtrate keeps is not recorded.
    if (!prefBotId(botId) || (intent.mode === "account" && !prefProfileId(intent.account)))
      return null;
    this.remember(this.intents, botId, intent, MAX_ACCOUNTS);
    try {
      await this.ctx.request("users.prefs.set", {
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
  private async patch(patch: RawRecord, replacePaths: string[] = []): Promise<void> {
    const before = asRecord(await this.ctx.request("config.get", {}));
    const baseHash = typeof before?.hash === "string" ? before.hash : undefined;
    await this.ctx.request("config.patch", {
      raw: JSON.stringify(patch),
      ...(baseHash ? { baseHash } : {}),
      ...(replacePaths.length > 0 ? { replacePaths } : {}),
    });
    // A gateway that reports no revisions has nothing to wait for.
    if (before?.configRevisionHash === undefined) return;
    const started = this.ctx.now();
    // At most 20 seconds, and at most 100 reads whatever the clock says.
    for (let reads = 0; reads < 100 && this.ctx.now() - started < 20_000; reads += 1) {
      const now = asRecord(await this.ctx.request("config.get", {}));
      const revised = now?.configRevisionHash !== before.configRevisionHash;
      if (revised && now?.appliedConfigHash === now?.configRevisionHash) return;
      // A patch that changed nothing leaves the revision as it was.
      if (!revised && (this.ctx.now() - started > 3_000 || reads >= 15)) return;
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 200));
    }
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

  /** The connection a sequence runs on: it stops, and publishes nothing, once this changes. */
  private bind(): Binding {
    const { epoch, generation } = this.ctx.connection();
    return { epoch, generation };
  }

  /** The connection the sequence began on is the one still open. */
  private live(binding: Binding): boolean {
    const now = this.ctx.connection();
    return now.epoch === binding.epoch && now.generation === binding.generation;
  }

  /** The screen still shows the gateway the sequence began on. */
  private shown(binding: Binding): boolean {
    return this.ctx.connection().generation === binding.generation;
  }

  /** One request of a sequence, sent only on the connection it began on. */
  private call(binding: Binding, method: string, params: unknown): Promise<unknown> {
    if (!this.live(binding)) return Promise.reject(new ConnectionChangedError());
    return this.ctx.request(method, params);
  }

  /** The bot list read again on the sequence's connection; its answer as the gateway sent it. */
  private refreshBotsOn(binding: Binding): Promise<unknown> {
    if (!this.live(binding)) return Promise.reject(new ConnectionChangedError());
    return this.ctx.refreshBots();
  }

  /** The held record of a bot on the gateway now connected (any, before one is known). */
  private heldFor(botId: string): HeldBot | null {
    const gateway = this.ctx.connection().gateway;
    for (const held of this.held.values()) {
      if (held.made.botId !== botId) continue;
      if (!gateway || sameGateway(held, gateway)) return held;
    }
    return null;
  }

  private isHeld(held: HeldBot): boolean {
    return this.held.get(heldKey(held)) === held;
  }

  /**
   * Create's reply named the bot: its record takes the reservation's place,
   * in memory at once (nothing is sent to it from here), in storage as soon
   * as the write behind it is done.
   */
  private adopt(reservation: Reservation, held: HeldBot): Promise<boolean> {
    if (this.reserved === reservation) this.reserved = null;
    this.held.set(heldKey(held), held);
    return this.persist();
  }

  /** A Create that made nothing known gives back its place; only its own reservation goes. */
  private async unreserve(reservation: Reservation): Promise<void> {
    if (this.reserved !== reservation) return;
    this.reserved = null;
    await this.persist();
  }

  /** Its setting read back as chosen, or the bot can't be identified: its record goes. */
  private async release(held: HeldBot): Promise<void> {
    if (!this.isHeld(held)) return;
    this.held.delete(heldKey(held));
    await this.persist();
  }

  /**
   * Write the held records, and a Create's reservation, to the host's storage,
   * one write after another: true once this one is saved.
   */
  private persist(): Promise<boolean> {
    const records: unknown[] = [...this.held.values()];
    // A reservation names no bot yet: an earlier run's is read as nothing to hold.
    if (this.reserved) records.push({ ...this.reserved, made: null });
    const value = JSON.stringify(records);
    const write = this.saving
      .then(() => this.ctx.storage.set(HELD_KEY, value))
      .then(
        () => true,
        (error: unknown) => {
          this.log(`the unfinished bots could not be saved on this device: ${errorText(error)}`);
          return false;
        },
      );
    this.saving = write.then(() => undefined);
    return write;
  }

  /** At start: the unfinished bots an earlier run kept, each within its bounds. */
  async restore(): Promise<void> {
    let kept: unknown;
    try {
      kept = JSON.parse((await this.ctx.storage.get(HELD_KEY)) ?? "[]");
    } catch (error) {
      this.log(`the unfinished bots could not be read on this device: ${errorText(error)}`);
      return;
    }
    if (!Array.isArray(kept)) return;
    for (const each of kept.slice(0, MAX_HELD_BOTS)) {
      const held = readHeldBot(each);
      if (held && this.held.size < MAX_HELD_BOTS) this.held.set(heldKey(held), held);
      else if (asRecord(each)?.made === null)
        this.log("a Create an earlier run sent ended before its reply named the bot it made");
    }
  }

  private notes(): NewBotPolicy[] {
    return this.ctx.get().policies;
  }

  /** A new bot's note, as shown. */
  private noteOf(botId: string): NewBotPolicy | null {
    return this.notes().find((note) => note.botId === botId) ?? null;
  }

  private setNote(botId: string, change: Partial<NewBotPolicy>): void {
    this.ctx.update((a) => ({
      ...a,
      policies: a.policies.map((note) => (note.botId === botId ? { ...note, ...change } : note)),
    }));
  }

  /**
   * Show a note, in place of the bot's earlier one. Past the bound a confirmed
   * note gives way first, then another bot no longer held: a held bot's note
   * stays, as its composer waits on it.
   */
  private putNote(note: NewBotPolicy): void {
    this.noteWrites += 1;
    this.ctx.update((a) => {
      const policies = [...a.policies.filter((each) => each.botId !== note.botId), note];
      while (policies.length > MAX_POLICY_NOTES) {
        const loose = (each: NewBotPolicy) => !this.heldFor(each.botId);
        let index = policies.findIndex((each) => each.status === "confirmed" && loose(each));
        if (index < 0) index = policies.findIndex(loose);
        policies.splice(Math.max(index, 0), 1);
      }
      return { ...a, policies };
    });
  }

  private dropNote(botId: string): void {
    this.ctx.update((a) => ({
      ...a,
      policies: a.policies.filter((note) => note.botId !== botId),
    }));
  }

  /** A held bot's note while nothing about it has been read on this connection. */
  private unreadNote(held: HeldBot): NewBotPolicy {
    return {
      botId: held.made.botId,
      name: held.made.name,
      workspace: held.made.workspace,
      chosen: held.chosen,
      status: "checking",
      restrictive: held.restrictive,
      saved: null,
      missingDeny: [],
      reported: null,
      retryable: false,
    };
  }

  /**
   * Why Create can't go with this account and model, from Create's own read
   * of the gateway, or null: the account is still one of its shared accounts,
   * of the provider named, or the gateway's valid config still chooses that
   * provider; and a catalogue that was read lists the model as available, or
   * it is the gateway's own default and isn't listed as unavailable.
   */
  private choiceProblem(input: CreateBotInput, read: AccountsRead): string | null {
    const valid = read.config?.valid === true;
    const defaults = asRecord(asRecord(asRecord(read.config?.config)?.agents)?.defaults);
    const gateway = valid ? parseModelRef(readModelConfig(defaults?.model).primary) : null;
    if (input.account) {
      const account = mergeAccounts(read.views, this.kinds).find(
        (each) => each.id === input.account && each.keptBy === null,
      );
      if (!account || account.provider !== input.provider) return CHOICE_REFUSALS.gone;
    } else if (!gateway || gateway.provider !== input.provider) {
      return CHOICE_REFUSALS.defaultChanged;
    }
    if (!read.catalog) return CHOICE_REFUSALS.noCatalog;
    const listed = read.catalog.find(
      (model) => model.provider === input.provider && model.id === input.model,
    );
    if (listed) return listed.available ? null : CHOICE_REFUSALS.unavailable;
    if (!input.account && gateway?.model === input.model) return null;
    return CHOICE_REFUSALS.unlisted;
  }

  /**
   * Create a bot on an account, or with no fixed account, with the command
   * policy the person chose (bots.md section 3, "What Create does";
   * controls.md section 10): `agents.create` once, and only on its confirmed
   * reply, for the `agentId` and workspace it returned, the restrictive write,
   * the chosen policy, Clawtrate's record of its account, the bot list and its
   * first task. Everything after `agents.create` goes on the connection it was
   * sent on, and stops when that changes. A reply that settles nothing is
   * never followed by a write: the bot list is for the person to review.
   */
  async createBot(input: CreateBotInput): Promise<CreatedBot> {
    this.requireAdmin("Creating a bot");
    const { ctx } = this;
    // The host's own guards: without both choices nothing is sent (bots.md section 3).
    if (!COMMAND_CHOICES.includes(input.approvals as CommandChoice))
      throw new Error("Choose how the new bot runs commands. Nothing was sent.");
    if (!input.provider || !input.model)
      throw new Error("Choose an account, or let the gateway choose. Nothing was sent.");
    const chosen = input.approvals as CommandChoice;
    const name = input.name.trim() || "New bot";
    const previous = ctx.get().creation;
    if (previous?.status === "creating" || this.reserved)
      throw new Error("A bot is already being created.");
    if (previous?.status === "unconfirmed")
      throw new Error("Review the gateway's bot list before creating another bot.");
    if (previous?.status === "partial" && previous.botId)
      throw new Error(`${previous.name} exists already: finish it rather than create it again.`);
    if (input.account && accountProvider(input.account) !== input.provider)
      throw new Error("That account belongs to another provider.");
    if (this.held.size >= MAX_HELD_BOTS)
      throw new Error(
        "Several new bots' command settings aren't confirmed yet. Write them again or delete those bots first. Nothing was sent.",
      );
    const binding = this.bind();
    const gateway = ctx.connection().gateway;
    if (!gateway || !ctx.connected()) throw new Error("Not connected. Nothing was sent.");
    // Entered for another gateway than this one: its choices were that gateway's.
    if (
      input.gateway &&
      !sameGateway({ gatewayId: input.gateway.id, gatewayUrl: input.gateway.url }, gateway)
    )
      throw new Error("The gateway changed since this was entered. Nothing was sent.");
    const ref: ModelRef = { provider: input.provider, model: input.model, account: input.account };
    const reservation: Reservation = {
      gatewayId: gateway.id,
      gatewayUrl: gateway.url,
      chosen,
      primary: formatModelRef(ref),
      effort: input.effort || null,
      restrictive: false,
      taskMade: false,
      seen: null,
    };
    // What is kept must come back after a restart: a record restore would refuse holds nothing.
    const sample = { ...reservation, made: { botId: "x", name: "x", workspace: "x" } };
    if (!readHeldBot(JSON.parse(JSON.stringify(sample))))
      throw new Error(
        "The model, effort or gateway address is too long for Clawtrate to keep with the new bot. Nothing was sent.",
      );
    // Its place among the held records, taken before anything waits: a second Create finds it.
    this.reserved = reservation;
    try {
      if (!(await this.persist()))
        throw new Error("This device couldn't save the new bot's record. Nothing was sent.");
      // The account and model are checked against the gateway as it is now, not as a viewer saw it.
      let read: AccountsRead;
      try {
        read = await this.preflight(binding);
      } catch (error) {
        // A request the old connection took down with it is a change of connection too.
        if (error instanceof ConnectionChangedError || !this.live(binding))
          throw new ConnectionChangedError();
        this.log(`the accounts could not be read before Create: ${errorText(error)}`);
        throw new Error(CHOICE_REFUSALS.unread, { cause: error });
      }
      const problem = this.choiceProblem(input, read);
      if (problem) throw new Error(problem);
    } catch (error) {
      await this.unreserve(reservation);
      if (error instanceof ConnectionChangedError)
        throw new Error("The connection changed. Nothing was sent.", { cause: error });
      throw error;
    }
    if (!this.live(binding)) {
      await this.unreserve(reservation);
      throw new Error("The connection changed. Nothing was sent.");
    }
    const avatar =
      input.avatar &&
      input.avatar.startsWith("data:image/png;base64,") &&
      input.avatar.length <= MAX_CREATE_AVATAR_CHARS
        ? input.avatar
        : null;
    this.planned.clear();
    ctx.update((a) => ({
      ...a,
      creation: {
        name,
        status: "creating",
        slow: false,
        botId: null,
        error: null,
        missing: [],
        attempt: input.attempt,
      },
    }));
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.slowTimer = setTimeout(() => {
      ctx.update((a) =>
        a.creation?.status === "creating" ? { ...a, creation: { ...a.creation, slow: true } } : a,
      );
    }, SLOW_CREATE_MS);
    let made: CreatedIdentity | null;
    try {
      made = readCreateReply(
        await this.call(binding, "agents.create", {
          name,
          model: formatModelRef(ref),
          ...(avatar ? { avatar } : {}),
        }),
      );
    } catch (error) {
      await this.unreserve(reservation);
      // Only a refusal that establishes nothing was written can be tried again. Anything else (no
      // answer, a dropped connection, "saved but not applied") may have made a bot, and a bot of
      // that name found later may be another client's: nothing more is sent for this attempt.
      if (isCertainRefusal(error)) return this.creationFailed(binding, error);
      return this.creationUnconfirmed(binding, error);
    }
    if (!made) {
      await this.unreserve(reservation);
      return this.creationUnconfirmed(
        binding,
        new Error("The gateway's reply didn't name the bot it made and its workspace."),
      );
    }
    const held: HeldBot = { ...reservation, made };
    const plan: CreatePlan = {
      held,
      intent: input.account ? { mode: "account", account: input.account } : { mode: "gateway" },
    };
    this.planned.set(made.botId, plan);
    // Held from here: until its setting reads back as chosen, nothing is sent to it, after a
    // restart too. Its first read of the config goes now, not after the save: a bot deleted and
    // made again with the same id, name and workspace before that read can't be told apart from
    // it on this gateway (docs/decisions.md), and the read comes as early as it can.
    void this.adopt(reservation, held);
    return this.complete(binding, plan, ["policy", "preference", "listed", "task"]);
  }

  /**
   * What a Create still lacks for the bot it made, in order: its command
   * policy (step 2, then step 3), Clawtrate's record of its account, the bot
   * list read back showing it, its first task. The first task waits for step
   * 2's read-back of this plan's bot. The bot is identified again by a fresh
   * read just before its account's record and before its first task. A bot
   * that can no longer be identified stops it all: the bot list is read again,
   * nothing more is sent for it, and the person is offered "Review bots".
   */
  private async complete(
    binding: Binding,
    plan: CreatePlan,
    steps: MissingStep[],
  ): Promise<CreatedBot> {
    const { made } = plan.held;
    const botId = made.botId;
    const missing: MissingStep[] = [];
    const errors: string[] = [];
    const failed = (step: MissingStep, words: string, error?: unknown) => {
      missing.push(step);
      const why = error === undefined ? "" : `: ${errorText(error)}`;
      errors.push(`${words}${why}`);
      this.log(`${botId}: ${words}${why}`);
    };
    const left = [...steps];
    const done = (step: MissingStep) => left.splice(left.indexOf(step), 1);
    try {
      if (left.includes("policy")) {
        if ((await this.writePolicy(binding, plan.held, false)) === "lost")
          return await this.lostAfterCreate(binding, plan, "done");
        done("policy");
      }
      if (left.includes("preference")) {
        const identified = await this.identified(binding, plan.held);
        if (identified === "lost" || identified === "changed")
          return await this.lostAfterCreate(binding, plan, identified);
        if (identified === "unread") {
          failed("preference", "the bot couldn't be read again before its account was recorded");
        } else {
          if (!this.live(binding)) throw new ConnectionChangedError();
          const error = await this.recordIntent(botId, plan.intent);
          if (error !== null)
            failed("preference", "Clawtrate's record of its account was not saved", error);
        }
        done("preference");
      }
      if (left.includes("listed")) {
        // "Created" only once the gateway's bot list shows it.
        let shown = false;
        let readError: unknown;
        try {
          const list = await this.refreshBotsOn(binding);
          shown = this.ctx.bots().some((bot) => bot.id === botId);
          this.readReported(botId, list);
        } catch (error) {
          rethrowChanged(error);
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
        done("listed");
      }
      // Nothing goes to the bot, its first task included, until step 2 reads back for this bot.
      if (left.includes("task")) {
        if (plan.held.restrictive && !plan.held.taskMade) {
          const identified = await this.identified(binding, plan.held);
          if (identified === "lost" || identified === "changed")
            return await this.lostAfterCreate(binding, plan, identified);
          if (identified === "unread") {
            failed("task", "the bot couldn't be read again before its first task");
          } else {
            try {
              await this.firstTask(binding, plan.held);
            } catch (error) {
              rethrowChanged(error);
              failed("task", "its first task was not made", error);
            }
          }
        }
        done("task");
      }
    } catch (error) {
      if (!(error instanceof ConnectionChangedError)) throw error;
      // The connection changed: what is left is finished by the bot's id, on a later connection
      // to the same gateway, or not at all.
      for (const step of left)
        failed(step, "the connection changed before Clawtrate finished", undefined);
    }
    return this.settleCreation(binding, plan, missing, errors);
  }

  /** The new bot's first, empty task, "Main", once step 2 has read back for it. */
  private async firstTask(binding: Binding, held: HeldBot): Promise<void> {
    if (!held.restrictive) return;
    if (!this.live(binding)) throw new ConnectionChangedError();
    await this.ctx.createMainTask(held.made.botId);
    held.taskMade = true;
    if (this.isHeld(held)) await this.persist();
  }

  /**
   * A fresh read just before the record of a bot's account or its first task:
   * "ok" while its entry is there, carries the name and workspace Create
   * answered with, and is the entry Clawtrate last identified; "lost" when it
   * is gone or carries another name or workspace; "changed" when it carries
   * them but isn't the entry Clawtrate last read; "unread" when no valid
   * config was read.
   */
  private async identified(
    binding: Binding,
    held: HeldBot,
  ): Promise<"ok" | "lost" | "changed" | "unread"> {
    let read: RawRecord | null;
    try {
      read = asRecord(await this.call(binding, "config.get", {}));
    } catch (error) {
      rethrowChanged(error);
      this.log(`${held.made.botId}: the config could not be read again: ${errorText(error)}`);
      return "unread";
    }
    if (read?.valid !== true) return "unread";
    const config = asRecord(read.config);
    if (entryProblem(config, held.made) !== null) return "lost";
    if (held.seen !== null && entryPrint(configEntry(config, held.made.botId)) !== held.seen)
      return "changed";
    return "ok";
  }

  /**
   * After Create: the bot can't be identified, and nothing more is sent for
   * it. Gone or another bot: its record and note go. Changed: it stays held.
   * The bot list is read again, and the person reviews it.
   */
  private async lostAfterCreate(
    binding: Binding,
    plan: CreatePlan,
    why: "lost" | "changed" | "done",
  ): Promise<never> {
    if (why === "lost") await this.lose(binding, plan.held);
    if (why === "changed") await this.suspect(binding, plan.held);
    await this.refreshBotsOn(binding).catch(rethrowChanged);
    return this.identityLost(binding, plan);
  }

  /** The bot Create made is gone or another is at its id: nothing more is sent for it. */
  private identityLost(binding: Binding, plan: CreatePlan): never {
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.slowTimer = null;
    this.planned.delete(plan.held.made.botId);
    const error = new Error(
      `${plan.held.made.name} changed on the gateway before Clawtrate finished setting it up. Nothing more was sent to it.`,
    );
    if (this.shown(binding))
      this.ctx.update((a) => ({
        ...a,
        creation: a.creation
          ? { ...a.creation, status: "unconfirmed", slow: false, error: error.message }
          : null,
      }));
    throw error;
  }

  /** The reported default command policy for a bot with a note, from a read of `agents.list`. */
  private readReported(botId: string, list: unknown): void {
    if (!this.noteOf(botId)) return;
    const agents = asRecord(list)?.agents;
    const agent = Array.isArray(agents)
      ? agents.map(asRecord).find((each) => each?.id === botId)
      : undefined;
    if (!agent) return;
    this.setNote(botId, { reported: readReportedLabel(agent) });
  }

  /**
   * Steps 2 and 3 for a held bot, each one hash-guarded write read back
   * before the next. `again`: "Write it again", which repeats only what did
   * not read back, for the same id, and never Create. "lost": the bot can no
   * longer be identified and nothing more is sent for it: gone or another
   * bot, its record and note are gone; changed since Clawtrate last read it,
   * it stays held without "Write it again".
   */
  private async writePolicy(
    binding: Binding,
    held: HeldBot,
    again: boolean,
  ): Promise<"done" | "lost"> {
    if (!this.isHeld(held)) return "done";
    const { made } = held;
    // What was read is shown only while its connection is the open one: after a close the note
    // waits for the next connection's read (`onClose`, `refreshPolicies`).
    const show = (change: Partial<NewBotPolicy>) => {
      this.noteWrites += 1;
      if (this.live(binding)) this.setNote(made.botId, change);
    };
    // A new write: both facts are cleared until they are read again.
    if (this.shown(binding)) this.putNote(this.unreadNote(held));
    if (!held.restrictive) {
      let deny: string[] | null = null;
      const step2 = await this.guardedWrite(
        binding,
        held,
        (config) => {
          deny = restrictiveDeny(config);
          if (!deny) return null;
          const entry: RawRecord = {
            tools: { exec: { mode: "deny" }, deny },
            model: { primary: held.primary, fallbacks: [] },
          };
          if (held.effort) entry.thinkingDefault = held.effort;
          return {
            patch: { agents: { entries: { [made.botId]: entry } } },
            replacePaths: [
              `agents.entries.${made.botId}.tools.deny`,
              `agents.entries.${made.botId}.model.fallbacks`,
            ],
          };
        },
        (entry) => deny !== null && restrictiveReadBack(entry, deny, held.primary),
      );
      if (step2.outcome === "lost") return this.lose(binding, held);
      if (step2.outcome === "changed") return this.suspect(binding, held);
      if (step2.outcome !== "confirmed") {
        if (!again) {
          this.unwritten.add(made.botId);
          if (this.unwritten.size > MAX_ACCOUNTS)
            this.unwritten.delete(this.unwritten.values().next().value!);
        }
        await this.persist();
        show({
          status: "restrictive",
          saved: step2.saved,
          missingDeny: step2.missingDeny,
          retryable: step2.retryable,
        });
        return "done";
      }
      this.unwritten.delete(made.botId);
      held.restrictive = true;
      await this.persist();
      show({ restrictive: true, saved: "deny", missingDeny: [] });
    }
    const step3 = await this.guardedWrite(
      binding,
      held,
      () => ({
        patch: {
          agents: {
            entries: {
              [made.botId]: { tools: { exec: { mode: held.chosen }, deny: [...FINAL_DENY] } },
            },
          },
        },
        replacePaths: [`agents.entries.${made.botId}.tools.deny`],
      }),
      (entry) => chosenReadBack(entry, held.chosen),
    );
    if (step3.outcome === "lost") return this.lose(binding, held);
    if (step3.outcome === "changed") return this.suspect(binding, held);
    if (step3.outcome === "confirmed") {
      await this.release(held);
      show({ status: "confirmed", saved: step3.saved, missingDeny: [], retryable: false });
    } else {
      await this.persist();
      show({
        status: "unconfirmed",
        saved: step3.saved,
        missingDeny: step3.missingDeny,
        retryable: step3.retryable,
      });
    }
    return "done";
  }

  /** A held bot that can no longer be identified: its record and its note go. */
  /**
   * A held bot whose entry, at its id and with its name and workspace, isn't
   * the one Clawtrate last read: another write changed it, perhaps another
   * bot made in its place. Nothing more is written to it, and it stays held,
   * held again if its setting had read back, until a read shows what was chosen.
   */
  private async suspect(binding: Binding, held: HeldBot): Promise<"lost"> {
    this.noteWrites += 1;
    this.log(
      `${held.made.botId}: its entry changed since Clawtrate last read it; held, not written`,
    );
    if (!this.isHeld(held)) this.held.set(heldKey(held), held);
    await this.persist();
    if (this.shown(binding))
      this.putNote({
        ...this.unreadNote(held),
        status: held.restrictive ? "unconfirmed" : "restrictive",
      });
    return "lost";
  }

  private async lose(binding: Binding, held: HeldBot): Promise<"lost"> {
    this.noteWrites += 1;
    this.log(`${held.made.botId}: no longer the bot Create made; nothing more is sent for it`);
    await this.release(held);
    if (this.shown(binding)) this.dropNote(held.made.botId);
    return "lost";
  }

  /**
   * One `config.patch` to a held bot, guarded by the hash of the `config.get`
   * just before it, then read back. It writes nothing when that read has no
   * hash or the gateway says its config is invalid. When the bot's entry is
   * gone, no longer carries the name and workspace Create answered with, or is
   * not the entry Clawtrate last read (`seen`), the bot is lost: another write
   * changed it, and matching names are no proof it is the same one. A
   * revision the gateway hasn't applied reads back as nothing. After anything
   * but a confirmed read-back, a fresh read says what the bot's mode now is
   * and whether a further write may be offered.
   */
  private async guardedWrite(
    binding: Binding,
    held: HeldBot,
    build: (config: RawRecord | null) => { patch: RawRecord; replacePaths: string[] } | null,
    readBack: (entry: RawRecord | null) => boolean,
  ): Promise<{
    outcome: "confirmed" | "unconfirmed" | "stopped" | "lost" | "changed";
    saved: string | null;
    missingDeny: string[];
    retryable: boolean;
  }> {
    const { made } = held;
    const fresh = async (outcome: "unconfirmed" | "stopped") => {
      const unread = { outcome, saved: null, missingDeny: [], retryable: false };
      if (outcome === "stopped") await this.refreshBotsOn(binding).catch(rethrowChanged);
      let now: RawRecord | null;
      try {
        now = asRecord(await this.call(binding, "config.get", {}));
      } catch (error) {
        rethrowChanged(error);
        return unread;
      }
      // An invalid config is answered empty: it says nothing of the bot.
      if (now?.valid !== true) return unread;
      const config = asRecord(now.config);
      if (entryProblem(config, made) !== null)
        return { outcome: "lost" as const, saved: null, missingDeny: [], retryable: false };
      const entry = configEntry(config, made.botId);
      // No read identified the bot before this one, so nothing was written to it: this read is its
      // first, as Create's own first read would have been.
      if (held.seen === null) {
        held.seen = entryPrint(entry);
        if (this.isHeld(held)) await this.persist();
      }
      return {
        outcome,
        saved: savedMode(entry),
        missingDeny: missingDeny(entry),
        // Offered again only while the bot's entry is the one Clawtrate last read.
        retryable:
          typeof now.hash === "string" && now.hash.length > 0 && entryPrint(entry) === held.seen,
      };
    };
    let before: RawRecord | null;
    try {
      before = asRecord(await this.call(binding, "config.get", {}));
    } catch (error) {
      rethrowChanged(error);
      this.log(`${made.botId}: the config could not be read before writing: ${errorText(error)}`);
      return fresh("unconfirmed");
    }
    if (before?.valid !== true) {
      this.log(`${made.botId}: not written: the gateway says its config is invalid`);
      return fresh("stopped");
    }
    const config = asRecord(before.config);
    const hash = typeof before?.hash === "string" && before.hash ? before.hash : null;
    const entry = configEntry(config, made.botId);
    const problem = entryProblem(config, made);
    const changed = !problem && held.seen !== null && entryPrint(entry) !== held.seen;
    if (problem || changed) {
      this.log(`${made.botId}: not written: ${problem ?? "its entry changed since it was read"}`);
      await this.refreshBotsOn(binding).catch(rethrowChanged);
      return {
        outcome: problem ? "lost" : "changed",
        saved: null,
        missingDeny: [],
        retryable: false,
      };
    }
    held.seen = entryPrint(entry);
    if (!hash) {
      this.log(`${made.botId}: not written: the config has no hash`);
      return fresh("stopped");
    }
    const write = build(config);
    if (!write) {
      this.log(`${made.botId}: not written: the config's tool servers could not all be named`);
      return fresh("stopped");
    }
    try {
      await this.call(binding, "config.patch", {
        raw: JSON.stringify(write.patch),
        baseHash: hash,
        replacePaths: write.replacePaths,
      });
    } catch (error) {
      rethrowChanged(error);
      // A changed hash is a conflict: nothing was written, and the bot list is read again.
      this.log(`${made.botId}: the write was refused: ${errorText(error)}`);
      return fresh(isCertainRefusal(error) ? "stopped" : "unconfirmed");
    }
    let after: RawRecord | null;
    try {
      after = await this.appliedAfter(binding, before);
    } catch (error) {
      rethrowChanged(error);
      this.log(`${made.botId}: the write could not be read back: ${errorText(error)}`);
      return fresh("unconfirmed");
    }
    const now = asRecord(after?.config);
    const written = configEntry(now, made.botId);
    if (
      after?.valid === true &&
      !unapplied(after) &&
      entryProblem(now, made) === null &&
      readBack(written)
    ) {
      held.seen = entryPrint(written);
      return { outcome: "confirmed", saved: savedMode(written), missingDeny: [], retryable: false };
    }
    return fresh("unconfirmed");
  }

  /**
   * The config once the gateway applied the write that followed `before`: the
   * first `config.get` whose revision moved and is applied, or the read after
   * three seconds with no new revision (a write that changed nothing).
   */
  private async appliedAfter(
    binding: Binding,
    before: RawRecord | null,
  ): Promise<RawRecord | null> {
    const started = this.ctx.now();
    let now = asRecord(await this.call(binding, "config.get", {}));
    if (before?.configRevisionHash === undefined) return now;
    for (let reads = 1; reads < 100 && this.ctx.now() - started < 20_000; reads += 1) {
      const revised = now?.configRevisionHash !== before.configRevisionHash;
      if (revised && now?.appliedConfigHash === now?.configRevisionHash) return now;
      if (!revised && (this.ctx.now() - started > 3_000 || reads >= 15)) return now;
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 200));
      now = asRecord(await this.call(binding, "config.get", {}));
    }
    return now;
  }

  /**
   * "Write it again" for a held bot: offered only while a fresh read still
   * identifies it, its entry is the one Clawtrate last read, and the config
   * has a hash. It repeats what did not read back (step 2 and step 3, or step
   * 3 alone) for that id, never Create, then reads the bot list and makes the
   * first task if it waited. It runs on the connection it was asked on.
   */
  async retryPolicy(botId: string): Promise<void> {
    this.requireAdmin("Changing a bot's settings");
    const note = this.noteOf(botId);
    const held = this.heldFor(botId);
    if (!note || !held || note.status === "confirmed" || note.status === "checking")
      throw new Error("There is nothing to write again for that bot.");
    if (!note.retryable)
      throw new Error("Clawtrate can't identify that bot in the gateway's settings any more.");
    const binding = this.bind();
    try {
      if ((await this.writePolicy(binding, held, true)) === "lost") {
        await this.refreshBotsOn(binding).catch(rethrowChanged);
        throw new Error("Clawtrate can't identify that bot in the gateway's settings any more.");
      }
      try {
        this.readReported(botId, await this.refreshBotsOn(binding));
      } catch (error) {
        rethrowChanged(error);
        this.log(`${botId}: the bot list could not be read: ${errorText(error)}`);
      }
      if (held.restrictive && !held.taskMade) {
        // Identified again just before: a bot replaced since the writes gets no task.
        const identified = await this.identified(binding, held);
        if (identified === "lost" || identified === "changed") {
          if (identified === "lost") await this.lose(binding, held);
          else await this.suspect(binding, held);
          await this.refreshBotsOn(binding).catch(rethrowChanged);
          throw new Error("Clawtrate can't identify that bot in the gateway's settings any more.");
        }
        if (identified === "unread") this.log(`${botId}: not read again; its first task waits`);
        else
          try {
            await this.firstTask(binding, held);
          } catch (error) {
            rethrowChanged(error);
            this.log(`${botId}: its first task was not made: ${errorText(error)}`);
          }
      }
    } catch (error) {
      if (error instanceof ConnectionChangedError)
        throw new Error(
          "The connection changed before Clawtrate finished. Nothing more was sent.",
          {
            cause: error,
          },
        );
      throw error;
    }
  }

  /**
   * Read the new bots' settings again, for their notes and for the bots held
   * on this gateway: what is saved for each, then the reported label from a
   * bot list read after it. A held bot whose valid read shows what was chosen
   * is settled; one a valid read shows gone or replaced is dropped. A failed
   * or invalid read settles nothing and clears what the notes said.
   */
  refreshPolicies(): Promise<void> {
    if (this.policyRead) {
      this.policyReadAgain = true;
      return this.policyRead;
    }
    this.policyRead = (async () => {
      try {
        do {
          this.policyReadAgain = false;
          await this.readPolicies();
        } while (this.policyReadAgain);
      } finally {
        this.policyRead = null;
      }
    })();
    return this.policyRead;
  }

  private async readPolicies(): Promise<void> {
    const gateway = this.ctx.connection().gateway;
    if (!gateway || !this.ctx.connected()) return;
    // What this read judges, as it stands before it is sent: a note or a held bot that comes
    // after it is not taken for gone, and a write in between leaves its answer unused.
    const checked = this.notes().map((note) => {
      const held = this.heldFor(note.botId);
      const made = held?.made ?? { botId: note.botId, name: note.name, workspace: note.workspace };
      return { note: note as NewBotPolicy | null, held, made, chosen: held?.chosen ?? note.chosen };
    });
    for (const held of this.held.values())
      if (sameGateway(held, gateway) && !checked.some((each) => each.held === held))
        checked.push({ note: null, held, made: held.made, chosen: held.chosen });
    if (checked.length === 0) return;
    const binding = this.bind();
    const writes = this.noteWrites;
    const current = () => this.live(binding) && this.noteWrites === writes;
    let now: RawRecord | null;
    try {
      now = asRecord(await this.call(binding, "config.get", {}));
    } catch (error) {
      if (error instanceof ConnectionChangedError) return;
      this.log(`the new bots' settings could not be read: ${errorText(error)}`);
      if (current()) this.unverified(checked.map((each) => each.made.botId));
      return;
    }
    if (!current()) return;
    // OpenClaw answers an invalid config as empty: no bot is gone by it.
    const config = now?.valid === true ? asRecord(now.config) : null;
    if (!config) {
      this.log("the new bots' settings were not read: the gateway says its config is invalid");
      this.unverified(checked.map((each) => each.made.botId));
      return;
    }
    // Saved but not applied yet: what it shows isn't in force, and settles nothing.
    const inForce = !unapplied(now);
    const hashed = typeof now?.hash === "string" && now.hash.length > 0;
    let save = false;
    for (const { note, held, made, chosen } of checked) {
      const botId = made.botId;
      if (held && !this.isHeld(held)) continue;
      if (entryProblem(config, made) !== null) {
        if (held) save = this.held.delete(heldKey(held)) || save;
        if (note) this.dropNote(botId);
        continue;
      }
      const entry = configEntry(config, botId);
      // A held bot no read had identified yet, with nothing written: this read is its first.
      if (held && held.seen === null && !held.restrictive) {
        held.seen = entryPrint(entry);
        save = true;
      }
      const confirmed = inForce && chosenHolds(entry, chosen);
      // Step 2 as Clawtrate writes it, whose answer was lost: it landed, and step 3 may follow.
      const deny =
        held && !held.restrictive && !confirmed && inForce ? restrictiveDeny(config) : null;
      if (held && deny && restrictiveReadBack(entry, deny, held.primary)) {
        held.restrictive = true;
        held.seen = entryPrint(entry);
        save = true;
      }
      // Settled only by a read that shows what was chosen, for that bot.
      if (confirmed && held) save = this.held.delete(heldKey(held)) || save;
      if (!note) continue;
      const restrictive = held ? held.restrictive : note.restrictive;
      this.setNote(botId, {
        status: confirmed ? "confirmed" : restrictive ? "unconfirmed" : "restrictive",
        restrictive,
        saved: savedMode(entry),
        missingDeny: missingDeny(entry),
        // The label is read again after this read, and belongs to it alone.
        reported: null,
        retryable: !confirmed && !!held && hashed && entryPrint(entry) === held.seen,
      });
    }
    if (save) await this.persist();
    if (!current()) return;
    let list: unknown;
    try {
      list = await this.refreshBotsOn(binding);
    } catch (error) {
      if (!(error instanceof ConnectionChangedError))
        this.log(`the new bots' reported policies could not be read: ${errorText(error)}`);
      return;
    }
    if (!current()) return;
    for (const { note, made } of checked) if (note) this.readReported(made.botId, list);
  }

  /** A read that settles nothing: what these notes said is cleared, and none is confirmed by it. */
  private unverified(botIds: string[]): void {
    this.ctx.update((a) => ({
      ...a,
      policies: a.policies.map((note) =>
        botIds.includes(note.botId)
          ? {
              ...note,
              status: note.status === "confirmed" ? "checking" : note.status,
              saved: null,
              missingDeny: [],
              reported: null,
              retryable: false,
            }
          : note,
      ),
    }));
  }

  /** The created bot's first message went out: its note has said what it had to. */
  dismissPolicy(botId: string): void {
    this.ctx.update((a) => ({
      ...a,
      policies: a.policies.filter((note) => note.botId !== botId || note.status !== "confirmed"),
    }));
  }

  /**
   * Why nothing may be sent to a bot yet, or null: a new bot whose saved
   * command setting hasn't read back as chosen, on this connection's reads or
   * by the record kept for it.
   */
  heldBack(botId: string): string | null {
    const note = this.noteOf(botId);
    if (note && note.status !== "confirmed")
      return `Clawtrate couldn't confirm ${note.name}'s command setting yet. Nothing was sent.`;
    const held = this.heldFor(botId);
    if (held)
      return `Clawtrate couldn't confirm ${held.made.name}'s command setting yet. Nothing was sent.`;
    return null;
  }

  /**
   * Why no task may be made for a bot yet, or null: a new bot whose step 2
   * hasn't read back. Its first task comes from Create, after step 2.
   */
  taskHeldBack(botId: string): string | null {
    const held = this.heldFor(botId);
    if (held && !held.restrictive)
      return `Clawtrate couldn't confirm ${held.made.name}'s settings yet. Nothing was sent.`;
    return null;
  }

  /**
   * What New bot's Approvals step says of the gateway's approvals file
   * (`exec.approvals.get`, admin): whether it blocks commands for a bot of this
   * name. Only that is kept; the file is not.
   */
  async approvalsFile(name: string): Promise<{ blocks: boolean }> {
    this.requireAdmin("Reading the gateway's approvals file");
    try {
      const snapshot = await this.ctx.request("exec.approvals.get", {});
      return { blocks: approvalsFileBlocks(snapshot, likelyBotId(name.trim() || "New bot")) };
    } catch (error) {
      this.log(`the gateway's approvals file could not be read: ${errorText(error)}`);
      return { blocks: false };
    }
  }

  /**
   * The creation's end: created, or partial with what it lacks; published only
   * while the screen shows the gateway it was made on. With nothing left to
   * finish, its plan goes.
   */
  private async settleCreation(
    binding: Binding,
    plan: CreatePlan,
    missing: MissingStep[],
    errors: string[],
  ): Promise<CreatedBot> {
    const { name, botId } = plan.held.made;
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.slowTimer = null;
    if (missing.length === 0) this.planned.delete(botId);
    if (this.shown(binding)) {
      this.ctx.update((a) => ({
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
          attempt: a.creation?.attempt ?? null,
        },
      }));
    }
    if (this.live(binding)) await this.load();
    return { botId, missing };
  }

  /**
   * Finish a bot whose creation is partial, by its id, on the gateway that
   * made it: write what is missing (its policy, the record of its account, the
   * bot list showing it, the first task), never create it again.
   */
  async finishBot(botId: string): Promise<CreatedBot> {
    this.requireAdmin("Creating a bot");
    const creation = this.ctx.get().creation;
    const binding = this.bind();
    const plan = this.planned.get(botId);
    if (!creation || creation.status !== "partial" || creation.botId !== botId)
      throw new Error("That bot has nothing left to finish.");
    // The gateway that made it, by its identity, on whichever connection to it is open now.
    const gateway = this.ctx.connection().gateway;
    if (
      !plan ||
      !gateway ||
      !sameGateway(plan.held, gateway) ||
      (plan.held.gatewayId !== null && gateway.id === null)
    )
      throw new Error("Clawtrate can't finish that bot from here. Review the gateway's bot list.");
    this.ctx.update((a) =>
      a.creation ? { ...a, creation: { ...a.creation, status: "creating", error: null } } : a,
    );
    return this.complete(binding, plan, creation.missing);
  }

  /** A refusal that establishes nothing was made: Create may be tried again. */
  private creationFailed(binding: Binding, error: unknown): never {
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.slowTimer = null;
    if (this.shown(binding))
      this.ctx.update((a) => ({
        ...a,
        creation: a.creation
          ? { ...a.creation, status: "failed", slow: false, error: this.scrub(errorText(error)) }
          : null,
      }));
    throw error instanceof Error ? error : new Error(String(error));
  }

  /** A reply that settles nothing: the bot may exist, and nothing more is sent for it. */
  private creationUnconfirmed(binding: Binding, error: unknown): never {
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.slowTimer = null;
    this.log(`agents.create did not confirm what it made: ${errorText(error)}`);
    if (this.shown(binding))
      this.ctx.update((a) => ({
        ...a,
        creation: a.creation
          ? {
              ...a.creation,
              status: "unconfirmed",
              slow: false,
              error: this.scrub(errorText(error)),
            }
          : null,
      }));
    throw error instanceof Error ? error : new Error(String(error));
  }

  /**
   * Forget a creation that has settled; "Review bots" reads the bot list
   * again. With `attempt`, only that attempt's outcome goes.
   */
  dismissCreation(attempt: string | null = null): void {
    const creation = this.ctx.get().creation;
    if (attempt !== null && creation?.attempt !== attempt) return;
    const unconfirmed = creation?.status === "unconfirmed";
    this.ctx.update((a) =>
      a.creation &&
      (a.creation.status === "failed" ||
        a.creation.status === "unconfirmed" ||
        a.creation.status === "created" ||
        // The person chose to open the bot as it is; its Account page still says what is missing.
        a.creation.status === "partial")
        ? { ...a, creation: null }
        : a,
    );
    if (creation && creation.status !== "creating") this.planned.clear();
    if (unconfirmed && this.ctx.connected())
      void this.ctx.refreshBots().catch((error: unknown) => {
        this.log(`the bot list could not be read: ${errorText(error)}`);
      });
  }

  /** The bot's model with its account and `fallbacks: []`, and its effort, in one patch. */
  private async writeModel(
    botId: string,
    ref: ModelRef,
    effort: string | null,
    creating: boolean,
  ): Promise<void> {
    const entry: RawRecord = { model: { primary: formatModelRef(ref), fallbacks: [] } };
    if (effort) entry.thinkingDefault = effort;
    try {
      await this.patch({ agents: { entries: { [botId]: entry } } }, [
        `agents.entries.${botId}.model.fallbacks`,
      ]);
      this.unwritten.delete(botId);
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

  /** Change a bot's account, or to no fixed account, with its model and effort (section 11). */
  async changeAccount(
    botId: string,
    account: string | null,
    provider: string,
    model: string,
    effort: string | null,
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
      await this.writeModel(botId, { provider, model, account }, effort, false);
      await this.recordIntent(botId, account ? { mode: "account", account } : { mode: "gateway" });
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

  /** The bot's model and effort, keeping its account. */
  async setModel(botId: string, model: string, effort: string | null): Promise<void> {
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
      await this.writeModel(
        botId,
        { provider: binding.provider, model, account: binding.account },
        effort,
        false,
      );
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

  /** "Remove fallbacks": the bot's model keeps its account; its fallback list becomes empty. */
  async removeFallbacks(botId: string): Promise<void> {
    this.requireAdmin("Changing a bot's settings");
    this.setWrite({
      what: "fallbacks",
      target: botId,
      status: "saving",
      error: null,
      at: this.ctx.now(),
    });
    try {
      await this.patch({ agents: { entries: { [botId]: { model: { fallbacks: [] } } } } }, [
        `agents.entries.${botId}.model.fallbacks`,
      ]);
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
    // The held bots of this gateway, kept across restarts, get their notes; every note is read.
    const gateway = this.ctx.connection().gateway;
    if (gateway)
      for (const held of this.held.values())
        if (sameGateway(held, gateway) && !this.noteOf(held.made.botId))
          this.putNote(this.unreadNote(held));
    void this.refreshPolicies();
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
    // What the new bots' notes said was read on that connection: cleared until read again, and
    // their composers wait meanwhile.
    if (this.notes().length > 0)
      this.ctx.update((a) => ({
        ...a,
        policies: a.policies.map((note) => ({
          ...note,
          status: "checking",
          saved: null,
          missingDeny: [],
          reported: null,
          retryable: false,
        })),
      }));
    // Nor does the first-bot prompt outlive the reads that showed it.
    this.firstBotFailed();
  }

  /** A read of the bot list failed, or the connection went: no first-bot prompt from older reads. */
  firstBotFailed(): void {
    this.firstBotChecks += 1;
    if (this.ctx.get().firstBot.status !== "roster")
      this.ctx.update((a) => ({ ...a, firstBot: { status: "unknown", mainPolicy: null } }));
  }

  /**
   * Whether the app opens on "Make your first bot" (bots.md section 3): from
   * a read of `agents.list` that shows only an unnamed `main`, the config and
   * that bot's complete session list are read too, and only reads that all
   * succeed and agree make it so. Anything else is the normal roster.
   */
  async checkFirstBot(list: unknown): Promise<void> {
    const issued = ++this.firstBotChecks;
    const binding = this.bind();
    // Only the latest check's answer, and only on the connection it read.
    const settle = (firstBot: ReturnType<typeof readFirstBot>) => {
      if (issued === this.firstBotChecks && this.live(binding))
        this.ctx.update((a) => ({ ...a, firstBot }));
    };
    if (!implicitMain(list)) return settle({ status: "roster", mainPolicy: null });
    // Until the reads agree, the normal roster.
    settle({ status: "unknown", mainPolicy: null });
    try {
      const [config, sessions] = await Promise.all([
        this.call(binding, "config.get", {}),
        this.call(binding, "sessions.list", MAIN_SESSIONS_PARAMS),
      ]);
      settle(readFirstBot(list, config, sessions));
    } catch (error) {
      this.log(`the first-bot reads failed: ${errorText(error)}`);
      settle({ status: "roster", mainPolicy: null });
    }
  }

  /** Another gateway: nothing read from this one is kept. */
  reset(): void {
    this.onClose();
    this.kinds.clear();
    this.intents.clear();
    this.unwritten.clear();
    // A Create's plan belongs to its gateway; the held bots stay, each kept for its own gateway.
    this.planned.clear();
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.slowTimer = null;
  }
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

function isCertainRefusal(error: unknown): boolean {
  return error instanceof GatewayProtocolRequestError && CERTAIN_REFUSALS.has(error.code);
}

/** A bot the gateway made, and what of its creation did not land. */
export type CreatedBot = { botId: string; missing: MissingStep[] };
