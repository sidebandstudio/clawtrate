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
  chosenReadBack,
  COMMAND_CHOICES,
  configEntry,
  entryProblem,
  FINAL_DENY,
  implicitMain,
  likelyBotId,
  MAIN_SESSIONS_PARAMS,
  readCreateReply,
  readFirstBot,
  readReportedPolicy,
  restrictiveDeny,
  restrictiveReadBack,
  savedMode,
  type CommandChoice,
  type CreatedIdentity,
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
};

/** What a confirmed Create made, and what Clawtrate writes for it. */
type CreatePlan = {
  made: CreatedIdentity;
  ref: ModelRef;
  effort: string | null;
  chosen: CommandChoice;
  intent: BindingIntent;
  /** Its first task was made; until step 2 reads back it waits. */
  taskMade: boolean;
};

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
   * What the last confirmed Create made and writes for it, so Finish and
   * "Write it again" write to that id alone.
   */
  private planned: CreatePlan | null = null;
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
      const bots = ctx.bots();
      const [config, views, prefs] = await Promise.all([
        ctx.request("config.get", {}).then(asRecord),
        this.readViews(bots.map((bot) => bot.id)),
        ctx.request("users.prefs.get", {}).then(asRecord, () => null),
      ]);
      this.readPrefs(prefs);
      const defaultBot = bots.find((bot) => bot.isDefault)?.id ?? bots[0]?.id ?? "main";
      const catalog = await ctx
        .request("models.list", { agentId: defaultBot })
        .then(readCatalog, () => ctx.get().models);
      const at = ctx.now();
      ctx.update((a) => this.compose(a, config, views, catalog, at));
    } catch (error) {
      // While a sign-in lasts, its typed values are taken out of whatever comes back.
      const message = this.scrub(errorText(error));
      ctx.update((a) => ({ ...a, status: "error", error: message }));
    }
  }

  private async readViews(botIds: string[]): Promise<Map<string, BotView>> {
    const views = new Map<string, BotView>();
    // A few bots at a time. Sharing is decided only from refreshed answers (row 33).
    for (let i = 0; i < botIds.length; i += ACCOUNT_READ_CONCURRENCY) {
      const chunk = botIds.slice(i, i + ACCOUNT_READ_CONCURRENCY);
      const answers = await Promise.all(
        chunk.map((agentId) => this.ctx.request("models.authStatus", { agentId, refresh: true })),
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

  /**
   * Create a bot on an account, or with no fixed account, with the command
   * policy the person chose (bots.md section 3, "What Create does";
   * controls.md section 10): `agents.create` once, and only on its confirmed
   * reply, for the `agentId` it returned, the restrictive write, the chosen
   * policy, Clawtrate's record of its account, the bot list and its first
   * task. A reply that settles nothing is never followed by a write: the bot
   * list is for the person to review.
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
    if (previous?.status === "creating") throw new Error("A bot is already being created.");
    if (previous?.status === "unconfirmed")
      throw new Error("Review the gateway's bot list before creating another bot.");
    if (previous?.status === "partial" && previous.botId)
      throw new Error(`${previous.name} exists already: finish it rather than create it again.`);
    const ref: ModelRef = { provider: input.provider, model: input.model, account: input.account };
    if (input.account && accountProvider(input.account) !== input.provider)
      throw new Error("That account belongs to another provider.");
    const avatar =
      input.avatar &&
      input.avatar.startsWith("data:image/png;base64,") &&
      input.avatar.length <= MAX_CREATE_AVATAR_CHARS
        ? input.avatar
        : null;
    this.planned = null;
    ctx.update((a) => ({
      ...a,
      creation: { name, status: "creating", slow: false, botId: null, error: null, missing: [] },
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
        await ctx.request("agents.create", {
          name,
          model: formatModelRef(ref),
          ...(avatar ? { avatar } : {}),
        }),
      );
    } catch (error) {
      // Only a refusal that establishes nothing was written can be tried again. Anything else (no
      // answer, a dropped connection, "saved but not applied") may have made a bot, and a bot of
      // that name found later may be another client's: nothing more is sent for this attempt.
      if (isCertainRefusal(error)) return this.creationFailed(error);
      return this.creationUnconfirmed(error);
    }
    if (!made) return this.creationUnconfirmed(new Error("The gateway's reply named no bot."));
    this.planned = {
      made,
      ref,
      effort: input.effort,
      chosen,
      intent: input.account ? { mode: "account", account: input.account } : { mode: "gateway" },
      taskMade: false,
    };
    return this.complete(made.name, made.botId, ["policy", "preference", "listed", "task"]);
  }

  /**
   * What a Create still lacks for the bot it made, in order: its command
   * policy (step 2, then step 3), Clawtrate's record of its account, the bot
   * list read back showing it, its first task. The first task waits for step
   * 2's read-back; what else does not land is reported, and finished by the
   * bot's id.
   */
  private async complete(name: string, botId: string, steps: MissingStep[]): Promise<CreatedBot> {
    const { ctx } = this;
    const plan = this.planned?.made.botId === botId ? this.planned : null;
    const missing: MissingStep[] = [];
    const errors: string[] = [];
    const failed = (step: MissingStep, words: string, error?: unknown) => {
      missing.push(step);
      const why = error === undefined ? "" : `: ${errorText(error)}`;
      errors.push(`${words}${why}`);
      this.log(`${botId}: ${words}${why}`);
    };
    if (steps.includes("policy") && plan) await this.writePolicy(plan, false);
    if (steps.includes("preference") && plan) {
      const error = await this.recordIntent(botId, plan.intent);
      if (error !== null)
        failed("preference", "Clawtrate's record of its account was not saved", error);
    }
    if (steps.includes("listed")) {
      // "Created" only once the gateway's bot list shows it.
      let shown = false;
      let readError: unknown;
      try {
        const list = await ctx.refreshBots();
        shown = ctx.bots().some((bot) => bot.id === botId);
        this.readReported(botId, list);
      } catch (error) {
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
    // Nothing goes to the bot, its first task included, until step 2 reads back.
    if (steps.includes("task") && this.policyOf(botId)?.restrictive !== false) {
      try {
        await ctx.createMainTask(botId);
        if (plan) plan.taskMade = true;
      } catch (error) {
        failed("task", "its first task was not made", error);
      }
    }
    return this.settleCreation(name, botId, missing, errors);
  }

  /** The created bot's command setting as read, when it is the bot named. */
  private policyOf(botId: string): NewBotPolicy | null {
    const policy = this.ctx.get().policy;
    return policy?.botId === botId ? policy : null;
  }

  private setPolicy(botId: string, change: Partial<NewBotPolicy>): void {
    this.ctx.update((a) =>
      a.policy?.botId === botId ? { ...a, policy: { ...a.policy, ...change } } : a,
    );
  }

  /** The reported default command policy for the bot, from a read of `agents.list`. */
  private readReported(botId: string, list: unknown): void {
    if (!this.policyOf(botId)) return;
    const agents = asRecord(list)?.agents;
    const agent = Array.isArray(agents)
      ? agents.map(asRecord).find((each) => each?.id === botId)
      : undefined;
    if (!agent) return;
    this.setPolicy(botId, {
      reported: readReportedPolicy(agent.defaultPermissionMode),
      reportedRead: true,
    });
  }

  /**
   * Steps 2 and 3 for the bot Create made, each one hash-guarded write read
   * back before the next. `again`: "Write it again", which repeats only what
   * did not read back, for the same id, and never Create.
   */
  private async writePolicy(plan: CreatePlan, again: boolean): Promise<void> {
    const { made } = plan;
    const was = this.policyOf(made.botId);
    if (!again || !was) {
      this.ctx.update((a) => ({
        ...a,
        policy: {
          botId: made.botId,
          name: made.name,
          chosen: plan.chosen,
          status: "checking",
          restrictive: false,
          saved: null,
          reported: null,
          reportedRead: false,
          retryable: false,
        },
      }));
    } else this.setPolicy(made.botId, { status: "checking", retryable: false });
    const primary = formatModelRef(plan.ref);
    if (!this.policyOf(made.botId)?.restrictive) {
      let deny: string[] | null = null;
      const step2 = await this.guardedWrite(
        made,
        (config) => {
          deny = restrictiveDeny(config);
          if (!deny) return null;
          const entry: RawRecord = {
            tools: { exec: { mode: "deny" }, deny },
            model: { primary, fallbacks: [] },
          };
          if (plan.effort) entry.thinkingDefault = plan.effort;
          return {
            patch: { agents: { entries: { [made.botId]: entry } } },
            replacePaths: [
              `agents.entries.${made.botId}.tools.deny`,
              `agents.entries.${made.botId}.model.fallbacks`,
            ],
          };
        },
        (entry) => deny !== null && restrictiveReadBack(entry, deny, primary),
      );
      if (step2.outcome !== "confirmed") {
        this.unwritten.add(made.botId);
        if (this.unwritten.size > MAX_ACCOUNTS)
          this.unwritten.delete(this.unwritten.values().next().value!);
        this.setPolicy(made.botId, {
          status: "restrictive",
          saved: step2.saved,
          retryable: step2.retryable,
        });
        return;
      }
      this.unwritten.delete(made.botId);
      this.setPolicy(made.botId, { restrictive: true, saved: "deny" });
    }
    const step3 = await this.guardedWrite(
      made,
      () => ({
        patch: {
          agents: {
            entries: {
              [made.botId]: { tools: { exec: { mode: plan.chosen }, deny: [...FINAL_DENY] } },
            },
          },
        },
        replacePaths: [`agents.entries.${made.botId}.tools.deny`],
      }),
      (entry) => chosenReadBack(entry, plan.chosen),
    );
    this.setPolicy(made.botId, {
      status: step3.outcome === "confirmed" ? "confirmed" : "unconfirmed",
      saved: step3.saved,
      retryable: step3.outcome === "confirmed" ? false : step3.retryable,
    });
  }

  /**
   * One `config.patch` to the bot Create returned, guarded by the hash of the
   * `config.get` just before it, then read back. It writes nothing when that
   * read has no hash, no entry for the id, or an entry that no longer carries
   * the name and workspace Create answered with: it stops, and the bot list is
   * read again. After anything but a confirmed read-back, a fresh read says
   * what the bot's mode now is and whether a further write may be offered.
   */
  private async guardedWrite(
    made: CreatedIdentity,
    build: (config: RawRecord | null) => { patch: RawRecord; replacePaths: string[] } | null,
    readBack: (entry: RawRecord | null) => boolean,
  ): Promise<{
    outcome: "confirmed" | "unconfirmed" | "stopped";
    saved: string | null;
    retryable: boolean;
  }> {
    const { ctx } = this;
    const fresh = async (outcome: "unconfirmed" | "stopped") => {
      if (outcome === "stopped") await ctx.refreshBots().catch(() => undefined);
      try {
        const now = asRecord(await ctx.request("config.get", {}));
        const config = asRecord(now?.config);
        const identified = entryProblem(config, made) === null;
        return {
          outcome,
          saved: identified ? savedMode(configEntry(config, made.botId)) : null,
          retryable: identified && typeof now?.hash === "string" && now.hash.length > 0,
        };
      } catch {
        return { outcome, saved: null, retryable: false };
      }
    };
    let before: RawRecord | null;
    try {
      before = asRecord(await ctx.request("config.get", {}));
    } catch (error) {
      this.log(`${made.botId}: the config could not be read before writing: ${errorText(error)}`);
      return fresh("unconfirmed");
    }
    const config = asRecord(before?.config);
    const hash = typeof before?.hash === "string" && before.hash ? before.hash : null;
    const problem = entryProblem(config, made);
    if (!hash || problem) {
      this.log(`${made.botId}: not written: ${problem ?? "the config has no hash"}`);
      return fresh("stopped");
    }
    const write = build(config);
    if (!write) {
      this.log(`${made.botId}: not written: the config's tool servers could not all be named`);
      return fresh("stopped");
    }
    try {
      await ctx.request("config.patch", {
        raw: JSON.stringify(write.patch),
        baseHash: hash,
        replacePaths: write.replacePaths,
      });
    } catch (error) {
      // A changed hash is a conflict: nothing was written, and the bot list is read again.
      this.log(`${made.botId}: the write was refused: ${errorText(error)}`);
      return fresh(isCertainRefusal(error) ? "stopped" : "unconfirmed");
    }
    let after: RawRecord | null;
    try {
      after = await this.appliedAfter(before);
    } catch (error) {
      this.log(`${made.botId}: the write could not be read back: ${errorText(error)}`);
      return fresh("unconfirmed");
    }
    const now = asRecord(after?.config);
    if (entryProblem(now, made) === null && readBack(configEntry(now, made.botId)))
      return {
        outcome: "confirmed",
        saved: savedMode(configEntry(now, made.botId)),
        retryable: false,
      };
    return fresh("unconfirmed");
  }

  /**
   * The config once the gateway applied the write that followed `before`: the
   * first `config.get` whose revision moved and is applied, or the read after
   * three seconds with no new revision (a write that changed nothing).
   */
  private async appliedAfter(before: RawRecord | null): Promise<RawRecord | null> {
    const started = this.ctx.now();
    let now = asRecord(await this.ctx.request("config.get", {}));
    if (before?.configRevisionHash === undefined) return now;
    for (let reads = 1; reads < 100 && this.ctx.now() - started < 20_000; reads += 1) {
      const revised = now?.configRevisionHash !== before.configRevisionHash;
      if (revised && now?.appliedConfigHash === now?.configRevisionHash) return now;
      if (!revised && (this.ctx.now() - started > 3_000 || reads >= 15)) return now;
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 200));
      now = asRecord(await this.ctx.request("config.get", {}));
    }
    return now;
  }

  /**
   * "Write it again" for the bot Create last made: offered only while a fresh
   * read still identifies it and gives the config's hash. It repeats what did
   * not read back (step 2 and step 3, or step 3 alone) for that id, never
   * Create, then reads the bot list and makes the first task if it waited.
   */
  async retryPolicy(botId: string): Promise<void> {
    this.requireAdmin("Changing a bot's settings");
    const policy = this.policyOf(botId);
    const plan = this.planned?.made.botId === botId ? this.planned : null;
    if (!policy || !plan || policy.status === "confirmed" || policy.status === "checking")
      throw new Error("There is nothing to write again for that bot.");
    if (!policy.retryable)
      throw new Error("Clawtrate can't identify that bot in the gateway's settings any more.");
    await this.writePolicy(plan, true);
    try {
      this.readReported(botId, await this.ctx.refreshBots());
    } catch (error) {
      this.log(`${botId}: the bot list could not be read: ${errorText(error)}`);
    }
    if (!plan.taskMade && this.policyOf(botId)?.restrictive) {
      try {
        await this.ctx.createMainTask(botId);
        plan.taskMade = true;
      } catch (error) {
        this.log(`${botId}: its first task was not made: ${errorText(error)}`);
      }
    }
  }

  /** The created bot's first message went out: its note has said what it had to. */
  dismissPolicy(botId: string): void {
    this.ctx.update((a) =>
      a.policy?.botId === botId && a.policy.status === "confirmed" ? { ...a, policy: null } : a,
    );
  }

  /**
   * Why nothing may be sent to a bot yet, or null: the bot Create last made,
   * until its saved command setting reads back as chosen.
   */
  heldBack(botId: string): string | null {
    const policy = this.policyOf(botId);
    if (!policy || policy.status === "confirmed") return null;
    return `Clawtrate couldn't confirm ${policy.name}'s command setting yet. Nothing was sent.`;
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

  /** The creation's end: created, or partial with what it lacks. */
  private async settleCreation(
    name: string,
    botId: string,
    missing: MissingStep[],
    errors: string[],
  ): Promise<CreatedBot> {
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.slowTimer = null;
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
      },
    }));
    await this.load();
    return { botId, missing };
  }

  /**
   * Finish a bot whose creation is partial, by its id: write what is missing
   * (the record of its account, the bot list showing it, the first task),
   * never create it again.
   */
  async finishBot(botId: string): Promise<CreatedBot> {
    this.requireAdmin("Creating a bot");
    const creation = this.ctx.get().creation;
    if (!creation || creation.status !== "partial" || creation.botId !== botId)
      throw new Error("That bot has nothing left to finish.");
    this.ctx.update((a) =>
      a.creation ? { ...a, creation: { ...a.creation, status: "creating", error: null } } : a,
    );
    return this.complete(creation.name, botId, creation.missing);
  }

  /** A refusal that establishes nothing was made: Create may be tried again. */
  private creationFailed(error: unknown): never {
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.slowTimer = null;
    this.ctx.update((a) => ({
      ...a,
      creation: a.creation
        ? { ...a.creation, status: "failed", slow: false, error: this.scrub(errorText(error)) }
        : null,
    }));
    throw error instanceof Error ? error : new Error(String(error));
  }

  /** A reply that settles nothing: the bot may exist, and nothing more is sent for it. */
  private creationUnconfirmed(error: unknown): never {
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.slowTimer = null;
    this.log(`agents.create did not confirm what it made: ${errorText(error)}`);
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

  /** Forget a creation that has settled; "Review bots" reads the bot list again. */
  dismissCreation(): void {
    const unconfirmed = this.ctx.get().creation?.status === "unconfirmed";
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

  /**
   * Whether the app opens on "Make your first bot" (bots.md section 3): from
   * a read of `agents.list` that shows only an unnamed `main`, the config and
   * that bot's complete session list are read too, and only reads that all
   * succeed and agree make it so. Anything else is the normal roster.
   */
  async checkFirstBot(list: unknown): Promise<void> {
    const issued = ++this.firstBotChecks;
    const settle = (firstBot: ReturnType<typeof readFirstBot>) => {
      if (issued === this.firstBotChecks) this.ctx.update((a) => ({ ...a, firstBot }));
    };
    if (!implicitMain(list)) return settle({ status: "roster", mainPolicy: null });
    // Until the reads agree, the normal roster.
    settle({ status: "unknown", mainPolicy: null });
    try {
      const [config, sessions] = await Promise.all([
        this.ctx.request("config.get", {}),
        this.ctx.request("sessions.list", MAIN_SESSIONS_PARAMS),
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
