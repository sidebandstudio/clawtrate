// The account checks: the gateway facts docs/design/bots.md rests on (its
// section 20), exercised on an instance started with `--with-accounts
// --with-plugin clawtrate-dev-signin`. Each check asserts from the gateway's
// own answers and from the scripted model's record of which account's
// credential reached it (scripted-accounts.ts). Where the gateway does
// something other than section 20 says, the check asserts what it does and
// says so in a finding; it is not bent to the design.
//
// Two clients:
//   admin    operator.admin, operator.read, operator.write   bots, config, sign-ins
//   reader   operator.read                                   logs.tail and account reads, as the design reads them
//
// Accounts that a check makes fail are its own: each failing check signs in
// fresh API keys for its own bot through the scripted sign-in, so no failure
// or cooldown of one check reaches another.

import { randomUUID } from "node:crypto";
import {
  ACCOUNT_MODELS,
  credentialFor,
  grownModels,
  LATER_MODELS,
  profileHash,
  SCRIPTED_ACCOUNTS,
} from "./accounts.ts";
import type { OperatorSession } from "./operator.ts";
import type { FailureStatus, RequestRecord } from "./scripted-accounts.ts";

type JsonRecord = Record<string, unknown>;
const rec = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" ? (value as JsonRecord) : {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class AccountCheckFailure extends Error {}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AccountCheckFailure(message);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as JsonRecord).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

function same(actual: unknown, expected: unknown, what: string): void {
  expect(
    canonical(actual) === canonical(expected),
    `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

export const ACCOUNT_CLIENTS = {
  admin: { scopes: ["operator.admin", "operator.read", "operator.write"], caps: ["tool-events"] },
  reader: { scopes: ["operator.read"], caps: [] as string[] },
} as const;
export type AccountClientName = keyof typeof ACCOUNT_CLIENTS;

/** The sign-in methods the development sign-in plugin offers, as `models.authLogin` names them. */
export const SIGNIN_CHOICES = {
  deviceCode: "clawtrate-dev-signin/acme-device-code",
  browser: "clawtrate-dev-signin/acme-browser",
  apiKey: "clawtrate-dev-signin/acme-api-key",
} as const;

export type AccountHarness = {
  admin: OperatorSession;
  reader: OperatorSession;
  /** The instance's scripted model, `http://127.0.0.1:<port>`. */
  providerUrl: string;
  /** The instance's state folder, where new bots' workspaces go. */
  stateDir: string;
  /** Set (a profile id) or clear (null) a bot's stored one-account order, with the tool's lock. */
  lock(bot: string, provider: string, profileId: string | null): Promise<string[] | null>;
  /** A line for the report. */
  observe(line: string): void;
  /** Something the gateway did that docs/design/bots.md section 20 says otherwise. */
  differ(row: number, line: string): void;
};

export type AccountCheck = {
  name: string;
  /** The rows of docs/design/bots.md section 20 the check exercises. */
  rows: number[];
  run(h: AccountHarness): Promise<void>;
};

// ---------------------------------------------------------------------------
// The scripted model's side

async function scripted<T>(h: AccountHarness, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${h.providerUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const answer = (await response.json()) as T;
  expect(response.ok, `${path} answered ${response.status}: ${JSON.stringify(answer)}`);
  return answer;
}

/** Every request the scripted model recorded for one session. */
async function requestsFor(h: AccountHarness, session: string): Promise<RequestRecord[]> {
  const { requests } = await scripted<{ requests: RequestRecord[] }>(h, "/scripted/requests");
  return requests.filter((r) => r.session === session);
}

const accountsOf = (requests: RequestRecord[]) => requests.map((r) => `${r.account}:${r.status}`);

async function fail(
  h: AccountHarness,
  account: string,
  status: FailureStatus,
  times?: number,
  message?: string,
) {
  await scripted(h, "/scripted/accounts/fail", {
    account,
    status,
    ...(times ? { times } : {}),
    ...(message === undefined ? {} : { message }),
  });
}

async function heal(h: AccountHarness, account: string) {
  await scripted(h, "/scripted/accounts/clear", { account });
}

// ---------------------------------------------------------------------------
// Bots and config, as the admin client writes them

type ConfigSnapshot = { hash: string; config: JsonRecord };

async function readConfig(h: AccountHarness): Promise<ConfigSnapshot> {
  const got = await h.admin.request<{ hash: string; config: JsonRecord }>("config.get", {});
  return { hash: got.hash, config: got.config };
}

function botEntry(config: JsonRecord, bot: string): JsonRecord {
  return rec(rec(rec(config.agents).entries)[bot]);
}

type Revision = { hash: string; configRevisionHash?: string; appliedConfigHash?: string };

/**
 * A merge patch, after which the gateway runs with it: `config.get` then
 * reports a new `configRevisionHash` and the same `appliedConfigHash`.
 */
async function patchConfig(
  h: AccountHarness,
  patch: JsonRecord,
  replacePaths?: string[],
): Promise<void> {
  const before = await h.admin.request<Revision>("config.get", {});
  const patched = await h.admin.request<{ ok?: boolean }>("config.patch", {
    raw: JSON.stringify(patch),
    baseHash: before.hash,
    ...(replacePaths ? { replacePaths } : {}),
  });
  expect(patched.ok === true, `config.patch was refused: ${JSON.stringify(patched).slice(0, 300)}`);
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const now = await h.admin.request<Revision>("config.get", {});
    const revised = now.configRevisionHash !== before.configRevisionHash;
    if (revised && now.appliedConfigHash === now.configRevisionHash) return;
    // A patch that changed nothing leaves the revision as it was.
    if (!revised && Date.now() - started > 3_000) return;
    await sleep(200);
  }
  throw new AccountCheckFailure("the gateway did not apply the patched config within 20 seconds");
}

/** Write a bot's model the way the design does: the reference and an empty fallback list. */
async function setModel(h: AccountHarness, bot: string, primary: string): Promise<void> {
  await patchConfig(h, { agents: { entries: { [bot]: { model: { primary, fallbacks: [] } } } } });
}

/**
 * Create a bot as New bot does (section 3): `agents.create {model}`, then its
 * model with an empty fallback list. Returns the bot's id.
 */
async function createBot(h: AccountHarness, name: string, model: string): Promise<string> {
  const created = await h.admin.request<{ ok: boolean; agentId: string; model?: string }>(
    "agents.create",
    { name, workspace: `${h.stateDir}/workspaces/${name}`, model },
  );
  expect(created.ok && created.agentId === name, `agents.create: ${JSON.stringify(created)}`);
  same(created.model, model, `${name}'s model as agents.create returned it`);
  await setModel(h, name, model);
  return name;
}

type RunEnd = { runId: string; state: string; errorMessage?: string; errorDetail?: JsonRecord };

/** Send a message as the admin client and wait for the run's end. */
async function runOnce(h: AccountHarness, session: string, message: string): Promise<RunEnd> {
  const sent = await h.admin.send(session, message);
  expect(typeof sent.runId === "string", `chat.send returned no run id: ${JSON.stringify(sent)}`);
  // A run on a rate-limited account retries ten times with growing pauses,
  // about two minutes and a half in all.
  const end = await h.admin.terminal(sent.runId as string, 300_000);
  await sleep(300);
  return {
    runId: sent.runId as string,
    state: String(end.state),
    ...(typeof end.errorMessage === "string" ? { errorMessage: end.errorMessage } : {}),
    ...(end.errorDetail ? { errorDetail: rec(end.errorDetail) } : {}),
  };
}

const session = (bot: string, tag: string) =>
  `agent:${bot}:accounts-${tag}-${randomUUID().slice(0, 8)}`;

// ---------------------------------------------------------------------------
// Accounts as the gateway reports them

export type ProfileView = JsonRecord & { profileId: string; source?: string; type?: string };
export type ProviderView = JsonRecord & {
  provider: string;
  profiles: ProfileView[];
  profileOrder?: string[];
  profileOrderStored?: boolean;
  profileOrderLocked?: string;
};

/**
 * One bot's view of a provider's accounts, read with `refresh: true`. Without
 * it the gateway answers from a cached snapshot in which a bot that keeps no
 * account of its own lists the shared accounts as `saved` (see the check
 * "where a sign-in lands").
 */
async function providerView(
  op: OperatorSession,
  bot: string,
  provider: string,
  refresh = true,
): Promise<ProviderView | undefined> {
  const status = await op.request<{ providers?: ProviderView[] }>("models.authStatus", {
    agentId: bot,
    ...(refresh ? { refresh: true } : {}),
  });
  return (status.providers ?? []).find((p) => p.provider === provider);
}

const profileIds = (view: ProviderView | undefined) =>
  (view?.profiles ?? []).map((p) => p.profileId).sort();

// ---------------------------------------------------------------------------
// Sign-ins, through models.authLogin and wizard.*

type WizardStep = JsonRecord & { id: string; type: string };
type WizardAnswer = { done: boolean; status?: string; error?: string; step?: WizardStep };

async function wizardNext(
  h: AccountHarness,
  sessionId: string,
  answer?: { stepId: string; value: unknown },
): Promise<WizardAnswer> {
  return h.admin.request<WizardAnswer>("wizard.next", {
    sessionId,
    ...(answer ? { answer } : {}),
  });
}

/** A note the client must acknowledge before the sign-in goes on, as a client does. */
const clientNote = (step: WizardStep) => step.type === "note" && step.executor === "client";

/**
 * Step until a step matches, or the sign-in ends, acknowledging client notes
 * on the way. Returns every step seen.
 */
async function stepUntil(
  h: AccountHarness,
  sessionId: string,
  want: (step: WizardStep) => boolean,
): Promise<{ steps: WizardStep[]; last: WizardAnswer }> {
  const steps: WizardStep[] = [];
  let answer: { stepId: string; value: unknown } | undefined;
  for (let i = 0; i < 60; i += 1) {
    const next = await wizardNext(h, sessionId, answer);
    answer = undefined;
    if (next.done || !next.step) return { steps, last: next };
    if (steps.at(-1)?.id !== next.step.id) steps.push(next.step);
    if (want(next.step)) return { steps, last: next };
    if (clientNote(next.step)) answer = { stepId: next.step.id, value: true };
  }
  throw new AccountCheckFailure(`sign-in ${sessionId} never reached the step it waited for`);
}

/** Step to the end, acknowledging client notes; anything else that asks for input fails. */
async function stepToEnd(h: AccountHarness, sessionId: string): Promise<WizardAnswer> {
  const { last, steps } = await stepUntil(
    h,
    sessionId,
    (step) => !clientNote(step) && ["select", "text", "confirm", "multiselect"].includes(step.type),
  );
  if (last.done) return last;
  await h.admin.request("wizard.cancel", { sessionId }).catch(() => {});
  throw new AccountCheckFailure(
    `sign-in ${sessionId} asked for more than the check answers: ${JSON.stringify(steps.at(-1))}`,
  );
}

async function startSignIn(h: AccountHarness, choice: string, bot: string): Promise<string> {
  const sessionId = `accounts-${randomUUID()}`;
  const started = await h.admin.request<JsonRecord>("models.authLogin", {
    sessionId,
    authChoice: choice,
    agentId: bot,
  });
  same([started.sessionId, started.done], [sessionId, false], "models.authLogin's answer");
  return sessionId;
}

/** Sign an API key in for a bot through the scripted API-key method. Returns the profile id. */
async function signInKey(h: AccountHarness, bot: string, name: string): Promise<string> {
  const sessionId = await startSignIn(h, SIGNIN_CHOICES.apiKey, bot);
  const { last } = await stepUntil(h, sessionId, (s) => s.type === "text");
  expect(last.step?.type === "text", `the API key sign-in asked no key: ${JSON.stringify(last)}`);
  const answered = await wizardNext(h, sessionId, {
    stepId: last.step.id,
    value: credentialFor("api_key", "acme", name),
  });
  const end = answered.done ? answered : await stepToEnd(h, sessionId);
  same([end.status, end.error], ["done", undefined], `the API key sign-in of acme:${name}`);
  return `acme:${name}`;
}

/** The gateway's failover decisions for a run, from its log, as a read-only client reads them. */
async function failoverRecords(h: AccountHarness, runId: string): Promise<JsonRecord[]> {
  const records: JsonRecord[] = [];
  let cursor: number | undefined;
  for (let page = 0; page < 50; page += 1) {
    const tail = await h.reader.request<{ lines?: string[]; cursor?: number; size?: number }>(
      "logs.tail",
      { ...(cursor === undefined ? {} : { cursor }), limit: 5000, maxBytes: 1_000_000 },
    );
    for (const line of tail.lines ?? []) {
      if (!line.includes("embedded_run_failover_decision")) continue;
      const found = findDecision(line);
      if (found && found.runId === runId) records.push(found);
    }
    if (tail.cursor === undefined || tail.cursor === cursor || tail.cursor >= (tail.size ?? 0))
      break;
    cursor = tail.cursor;
  }
  return records;
}

/** The decision object inside a log line, wherever the logger nested it. */
export function findDecision(line: string): JsonRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const seen = new Set<unknown>();
  const walk = (value: unknown): JsonRecord | null => {
    if (value === null || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    const r = value as JsonRecord;
    if (r.event === "embedded_run_failover_decision") return r;
    for (const child of Object.values(r)) {
      if (typeof child === "string" && child.includes("embedded_run_failover_decision")) {
        try {
          const inner = walk(JSON.parse(child));
          if (inner) return inner;
        } catch {
          // a message that only mentions it
        }
      }
      const inner = walk(child);
      if (inner) return inner;
    }
    return null;
  };
  return walk(parsed);
}

// ---------------------------------------------------------------------------
// The checks

/** The acme accounts the config lists, in its order: what a sign-in seeds a new order with. */
const CONFIGURED_ACME = SCRIPTED_ACCOUNTS.filter((a) => a.provider === "acme").map((a) => a.id);

const SHARED_ACME = SCRIPTED_ACCOUNTS.filter(
  (a) => a.provider === "acme" && "shared" in a.store,
).map((a) => a.id);

export const ACCOUNT_CHECKS: AccountCheck[] = [
  {
    name: "the accounts an instance starts with, as each bot sees them",
    rows: [5, 9, 33],
    run: async (h) => {
      const main = await providerView(h.admin, "main", "acme");
      const otto = await providerView(h.admin, "otto", "acme");
      const pip = await providerView(h.admin, "pip", "acme");
      same(profileIds(main), ["acme:home", "acme:work"], "main's acme accounts");
      same(profileIds(pip), ["acme:home", "acme:work"], "pip's acme accounts");
      same(profileIds(otto), ["acme:home", "acme:studio", "acme:work"], "otto's acme accounts");
      const source = (view: ProviderView | undefined, id: string) =>
        view?.profiles.find((p) => p.profileId === id)?.source;
      same(
        [source(main, "acme:work"), source(pip, "acme:work"), source(otto, "acme:studio")],
        ["inherited", "inherited", "saved"],
        "where each account is kept, as each bot's view says",
      );
      // Labels go to admin connections only.
      const labels = (view: ProviderView | undefined) =>
        Object.fromEntries((view?.profiles ?? []).map((p) => [p.profileId, p.displayName]));
      same(
        labels(otto),
        { "acme:home": "Home", "acme:studio": "Studio", "acme:work": "Work" },
        "labels (admin)",
      );
      const read = await providerView(h.reader, "otto", "acme");
      same(
        (read?.profiles ?? []).map((p) => p.displayName ?? null),
        [null, null, null],
        "labels a read-only connection receives",
      );
      const globex = await providerView(h.admin, "main", "globex");
      same(
        (globex?.profiles ?? []).map((p) => [p.profileId, p.type, p.displayName]),
        [["globex:team", "token", "Team"]],
        "globex's account",
      );
      h.observe(
        `authStatus profile, shared, as otto sees it: ${canonical(otto?.profiles.find((p) => p.profileId === "acme:work"))}`,
      );
      h.observe(
        `authStatus profile, kept by otto: ${canonical(otto?.profiles.find((p) => p.profileId === "acme:studio"))}`,
      );
      h.observe(
        `authStatus profile, as a read-only connection sees it: ${canonical(read?.profiles.find((p) => p.profileId === "acme:studio"))}`,
      );
      h.observe(
        `authStatus provider fields: ${Object.keys(otto ?? {})
          .sort()
          .join(", ")}`,
      );
    },
  },
  {
    name: "a bot created on the second of two accounts runs on it",
    rows: [2, 3],
    run: async (h) => {
      const bot = await createBot(h, "acct-second", "acme/dev-1@acme:home");
      same(
        botEntry((await readConfig(h)).config, bot).model,
        { primary: "acme/dev-1@acme:home", fallbacks: [] },
        "the bot's stored model",
      );
      const key = session(bot, "second");
      const end = await runOnce(h, key, "#text");
      same(end.state, "final", "the first run's end");
      same(
        accountsOf(await requestsFor(h, key)),
        ["acme:home:200"],
        "the accounts its run reached",
      );
    },
  },
  {
    name: "a bot created with no account and no fallbacks lets the gateway choose",
    rows: [4, 36],
    run: async (h) => {
      const bot = await createBot(h, "acct-chooses", "acme/dev-1");
      same(
        botEntry((await readConfig(h)).config, bot).model,
        { primary: "acme/dev-1", fallbacks: [] },
        "the bot's stored model",
      );
      const view = await providerView(h.reader, bot, "acme");
      same(view?.profileOrder ?? null, null, "the bot's stored order");
      const served: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const key = session(bot, `chooses-${i}`);
        same((await runOnce(h, key, "#text")).state, "final", `run ${i + 1}'s end`);
        const requests = await requestsFor(h, key);
        same(requests.length, 1, `run ${i + 1}'s requests`);
        served.push(String(requests[0]!.account));
      }
      expect(
        served.every((a) => SHARED_ACME.includes(a)),
        `served only by shared acme accounts: ${served.join(", ")}`,
      );
      h.observe(`"Gateway chooses": three runs in a row were served by ${served.join(", ")}`);
    },
  },
  {
    name: "a run that asks for another model does not carry the bot's account",
    rows: [2, 13],
    run: async (h) => {
      const bot = await createBot(h, "acct-other-model", "acme/dev-1");
      const own = await signInKey(h, bot, "omown");
      const ordered = await signInKey(h, bot, "omorder");
      await setModel(h, bot, `acme/dev-1@${own}`);
      // A one-account order for the other account, so the automatic choice is known.
      same(await h.lock(bot, "acme", ordered), [ordered], "the stored order");
      const ownKey = session(bot, "own-model");
      same((await runOnce(h, ownKey, "#text")).state, "final", "the run on the bot's model");
      same(
        accountsOf(await requestsFor(h, ownKey)),
        [`${own}:200`],
        "its model's run: the pin first",
      );
      const otherKey = session(bot, "other-model");
      await h.admin.request("sessions.patch", { key: otherKey, model: "acme/dev-2" });
      same((await runOnce(h, otherKey, "#text")).state, "final", "the run on another model");
      const other = await requestsFor(h, otherKey);
      same(
        accountsOf(other),
        [`${ordered}:200`],
        "another model's run: the order, without the pin",
      );
      same(other[0]!.model, "dev-2", "the model the other run asked for");
      same(
        await h.lock(bot, "acme", null),
        null,
        "unlock, as the gateway's command line reads it back",
      );
      const unlocked = await providerView(h.reader, bot, "acme");
      same(
        [unlocked?.profileOrder ?? null, unlocked?.profileOrderStored ?? null],
        [null, null],
        "the bot's order as models.authStatus reports it after unlock",
      );
    },
  },
  {
    name: "where a sign-in lands: main's is shared, another bot's is its own",
    rows: [5, 6, 12, 33],
    run: async (h) => {
      const config = (await readConfig(h)).config;
      same(
        botEntry(config, "main").agentDir,
        undefined,
        "main has no folder of its own configured",
      );
      const shared = await deviceSignIn(h, "main", "approve", "landshared");
      same(shared.end.status, "done", "the sign-in for main");
      const forOtto = await deviceSignIn(h, "otto", "approve", "landotto");
      same(forOtto.end.status, "done", "the sign-in for otto");
      const views = {
        main: await providerView(h.admin, "main", "acme"),
        otto: await providerView(h.admin, "otto", "acme"),
        pip: await providerView(h.admin, "pip", "acme"),
      };
      const where = (id: string) =>
        Object.fromEntries(
          Object.entries(views).map(([bot, view]) => [
            bot,
            view?.profiles.find((p) => p.profileId === id)?.source ?? null,
          ]),
        );
      same(
        where("acme:landshared"),
        { main: "inherited", otto: "inherited", pip: "inherited" },
        "main's sign-in, per bot",
      );
      same(
        where("acme:landotto"),
        { main: null, otto: "saved", pip: null },
        "otto's sign-in, per bot",
      );
      // Neither bot had an order and the config lists acme's accounts, so each
      // sign-in created one: the new account, then the configured list.
      same(
        views.main?.profileOrder,
        ["acme:landshared", ...CONFIGURED_ACME],
        "main's order after its sign-in",
      );
      same(
        views.otto?.profileOrder,
        ["acme:landotto", ...CONFIGURED_ACME],
        "otto's order after its sign-in",
      );
      same(
        [
          views.main?.profileOrderStored,
          views.otto?.profileOrderStored,
          views.pip?.profileOrder ?? null,
        ],
        [true, true, null],
        "the order is stored for the bot signed in for, and for no other",
      );
      // Without refresh, the cached view of a bot that keeps no account of its
      // own (marlow) lists the shared accounts as saved once the gateway has
      // prepared it again after the sign-in.
      let cached: string | undefined;
      for (let i = 0; i < 20 && cached !== "saved"; i += 1) {
        await sleep(500);
        const view = await providerView(h.reader, "marlow", "acme", false);
        cached = view?.profiles.find((p) => p.profileId === "acme:landshared")?.source;
      }
      same(cached, "saved", "marlow's cached view of main's sign-in, without refresh");
      h.differ(
        33,
        `models.authStatus {agentId} without refresh answers from a cached snapshot: after a sign-in, a bot that keeps no account of its own (main, marlow, any bot made with agents.create) lists every shared account with source "saved"; with refresh: true it lists them "inherited". Only refreshed reads tell shared from kept.`,
      );
      const landed = views.otto?.profiles.find((p) => p.profileId === "acme:landotto");
      same(
        [landed?.type, landed?.status],
        ["oauth", "ok"],
        "the signed-in account's type and state",
      );
      const order = (view: ProviderView | undefined) => ({
        profileOrder: view?.profileOrder ?? null,
        profileOrderStored: view?.profileOrderStored ?? null,
        profileOrderLocked: view?.profileOrderLocked ?? null,
      });
      h.observe(
        `authStatus, main's sign-in as main sees it: ${canonical(views.main?.profiles.find((p) => p.profileId === "acme:landshared"))}`,
      );
      h.observe(
        `authStatus, main's sign-in as pip sees it: ${canonical(views.pip?.profiles.find((p) => p.profileId === "acme:landshared"))}`,
      );
      h.observe(`authStatus, otto's sign-in as otto sees it: ${canonical(landed)}`);
      h.observe(
        `order fields after the sign-ins: main ${canonical(order(views.main))}; otto ${canonical(order(views.otto))}; pip ${canonical(order(views.pip))}`,
      );
    },
  },
  {
    name: "sign-in with a link and a code: approved, refused, expired, cancelled",
    rows: [6],
    run: async (h) => {
      const before = profileIds(await providerView(h.admin, "pip", "acme"));
      const approved = await deviceSignIn(h, "pip", "approve", "devok");
      same(approved.end.status, "done", "approved");
      const step = approved.codeStep;
      expect(step?.deviceCode, `the step with the code: ${JSON.stringify(step)}`);
      const code = rec(step.deviceCode);
      same([typeof code.code, code.expiresInMinutes], ["string", 15], "the code and its minutes");
      expect(
        String(step.externalUrl).startsWith(`${h.providerUrl}/`),
        `a loopback link: ${String(step.externalUrl)}`,
      );
      h.observe(
        `device code step: ${canonical({ ...step, id: "…", message: "…", deviceCode: { ...code, code: "…" }, externalUrl: "…" })}`,
      );
      const refused = await deviceSignIn(h, "pip", "refuse", "devno");
      same(refused.end.status, "error", "refused");
      expect(String(refused.end.error).includes("refused"), `refused: ${refused.end.error}`);
      const expired = await deviceSignIn(h, "pip", "expire", "devlate");
      same(expired.end.status, "error", "expired");
      expect(String(expired.end.error).includes("expired"), `expired: ${expired.end.error}`);
      h.observe(
        `device code ended: refused "${refused.end.error}"; expired "${expired.end.error}"`,
      );
      const cancelled = await cancelledSignIn(h, SIGNIN_CHOICES.deviceCode, (s) =>
        Boolean(s.deviceCode),
      );
      h.observe(`device code cancelled: ${canonical(cancelled)}`);
      await expectPipAccounts(h, before, ["acme:devok"]);
    },
  },
  {
    name: "sign-in in the browser with the code pasted back: approved, refused, expired, cancelled",
    rows: [6],
    run: async (h) => {
      const before = profileIds(await providerView(h.admin, "pip", "acme"));
      const byCode = await browserSignIn(h, "approve", "browok", "code");
      same(byCode.end.status, "done", "approved, the code pasted");
      const byAddress = await browserSignIn(h, "approve", "browaddr", "address");
      same(byAddress.end.status, "done", "approved, the whole address pasted");
      expect(
        byCode.pasteStep?.sensitive === true,
        `the paste step is sensitive: ${JSON.stringify(byCode.pasteStep)}`,
      );
      h.observe(
        `browser steps: ${byCode.steps.map((s) => canonical({ type: s.type, sensitive: s.sensitive, externalUrl: s.externalUrl ? "…" : undefined, placeholder: s.placeholder })).join(" then ")}`,
      );
      const refused = await browserSignIn(h, "refuse", "browno", "address");
      same(refused.end.status, "error", "refused");
      const expired = await browserSignIn(h, "expire", "browlate", "code");
      same(expired.end.status, "error", "expired");
      h.observe(`browser ended: refused "${refused.end.error}"; expired "${expired.end.error}"`);
      await cancelledSignIn(h, SIGNIN_CHOICES.browser, (s) => s.type === "text");
      await expectPipAccounts(h, before, ["acme:browok", "acme:browaddr"]);
    },
  },
  {
    name: "sign-in with an API key: saved, refused, expired, cancelled; one sign-in at a time",
    rows: [6],
    run: async (h) => {
      const before = profileIds(await providerView(h.admin, "pip", "acme"));
      same(await signInKey(h, "pip", "keyok"), "acme:keyok", "the saved key's account");
      for (const outcome of ["refuse", "expire"] as const) {
        const key = credentialFor("api_key", "acme", `key${outcome}`);
        await scripted(h, "/scripted/signin/key-outcome", { key, outcome });
        const sessionId = await startSignIn(h, SIGNIN_CHOICES.apiKey, "pip");
        const { last } = await stepUntil(h, sessionId, (s) => s.type === "text");
        expect(last.step, "the key step");
        const answered = await wizardNext(h, sessionId, { stepId: last.step.id, value: key });
        const end = answered.done ? answered : await stepToEnd(h, sessionId);
        same(end.status, "error", `a key the provider answers ${outcome}`);
        h.observe(`API key ${outcome}: "${end.error}"`);
      }
      // One sign-in at a time: a second start while one waits is refused.
      const first = await startSignIn(h, SIGNIN_CHOICES.apiKey, "pip");
      await stepUntil(h, first, (s) => s.type === "text");
      const second = await h.admin
        .request("models.authLogin", {
          sessionId: `accounts-${randomUUID()}`,
          authChoice: SIGNIN_CHOICES.apiKey,
          agentId: "pip",
        })
        .then(
          () => "started",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
      expect(second !== "started", "a second sign-in started while one was running");
      h.observe(`a second sign-in while one runs: "${second}"`);
      await cancelAndCheck(h, first);
      await expectPipAccounts(h, before, ["acme:keyok"]);
    },
  },
  {
    name: "a bound bot whose account fails is moved to another account, and the log says so",
    rows: [11, 16],
    run: async (h) => {
      const bot = await createBot(h, "acct-rotate", "acme/dev-1");
      const bound = await signInKey(h, bot, "rotbound");
      await signInKey(h, bot, "rotspare");
      await setModel(h, bot, `acme/dev-1@${bound}`);
      await fail(h, bound, 401, 1);
      const key = session(bot, "rotate");
      const end = await runOnce(h, key, "#text");
      same(end.state, "final", "the run's end");
      const requests = await requestsFor(h, key);
      same(
        requests[0] && `${requests[0].account}:${requests[0].status}`,
        `${bound}:401`,
        "the first request",
      );
      same(requests.length, 2, `requests in the run (${accountsOf(requests).join(", ")})`);
      expect(
        requests[1]!.status === 200 &&
          requests[1]!.account !== bound &&
          String(requests[1]!.account).startsWith("acme:"),
        `the second request went to another acme account: ${accountsOf(requests).join(", ")}`,
      );
      h.observe(`rotation: ${accountsOf(requests).join(" then ")}`);
      const records = await failoverRecords(h, end.runId);
      const rotation = records.find((r) => r.decision === "rotate_profile");
      expect(rotation, `a rotate_profile record for run ${end.runId}: ${JSON.stringify(records)}`);
      same(rotation.profileId, profileHash(bound), "the failed account, as the log names it");
      same(
        [rotation.provider, rotation.model, rotation.failoverReason],
        ["acme", "dev-1", "auth"],
        "the record's provider, model and reason",
      );
      expect(
        records.every((r) => r.profileId !== profileHash(String(requests[1]!.account))),
        "no record names the account that served",
      );
      h.observe(`rotate_profile record: ${canonical(rotation)}`);
      h.observe(
        `all failover records of the run: ${records.map((r) => `${String(r.decision)}@${String(r.stage)}`).join(", ")}`,
      );
    },
  },
  ...([401, 402, 429] as const).map((status): AccountCheck => ({
    name: `a locked bot whose account answers ${status} fails, and no request reaches another account`,
    rows: [12, 18],
    run: async (h) => {
      const bot = await createBot(h, `acct-lock-${status}`, "acme/dev-1");
      const locked = await signInKey(h, bot, `lock${status}a`);
      const other = await signInKey(h, bot, `lock${status}b`);
      await setModel(h, bot, `acme/dev-1@${locked}`);
      same(
        await h.lock(bot, "acme", locked),
        [locked],
        "the lock, as the gateway's command line reads it back",
      );
      const view = await providerView(h.reader, bot, "acme");
      same(
        [view?.profileOrder, view?.profileOrderStored, view?.profileOrderLocked ?? null],
        [[locked], true, null],
        "the order as models.authStatus reports it",
      );
      await fail(h, locked, status);
      try {
        const key = session(bot, `lock-${status}`);
        const end = await runOnce(h, key, "#text");
        same(end.state, "error", "the run's end");
        const requests = await requestsFor(h, key);
        expect(
          requests[0]?.account === locked,
          `the locked account was tried first: ${accountsOf(requests).join(", ")}`,
        );
        same(
          [...new Set(requests.flatMap((r) => (r.account ? [r.account] : [])))],
          [locked],
          `the accounts the run reached (${accountsOf(requests).join(", ")})`,
        );
        expect(!requests.some((r) => r.account === other), "the other account was never asked");
        const bare = requests.filter((r) => r.credential === "none").length;
        if (bare > 0) {
          h.differ(
            12,
            `a locked bot whose one account answered ${status} also sent ${bare} request(s) to the provider with no credential at all, in the same run (the scripted model refuses those with 401, as a real provider would); it never used another account`,
          );
        }
        const reason = { 401: "auth", 402: "billing", 429: "rate_limit" }[status];
        same(end.errorDetail?.failoverReason, reason, "the error's failover reason");
        const records = await failoverRecords(h, end.runId);
        same(
          records.map((r) => [r.decision, r.profileId]),
          [["surface_error", profileHash(locked)]],
          "the run's failover decisions in the log: the failure surfaced, no rotation",
        );
        h.observe(
          `locked, ${status}: ${requests.length} request(s) to ${locked}; error "${end.errorMessage}"; detail ${canonical(end.errorDetail)}; log ${records.map((r) => `${String(r.decision)} ${String(r.profileId)}`).join(", ")}`,
        );
      } finally {
        await heal(h, locked);
      }
    },
  })),
  {
    name: "a locked bot moved to another account of its provider runs on the new one first, then the old",
    rows: [15],
    run: async (h) => {
      const bot = await createBot(h, "acct-relock", "acme/dev-1");
      const old = await signInKey(h, bot, "relockold");
      const next = await signInKey(h, bot, "relocknew");
      await setModel(h, bot, `acme/dev-1@${old}`);
      same(await h.lock(bot, "acme", old), [old], "the lock on the old account");
      await setModel(h, bot, `acme/dev-1@${next}`);
      same(
        (await providerView(h.reader, bot, "acme"))?.profileOrder,
        [old],
        "the order stays stored",
      );
      const healthy = session(bot, "relock-healthy");
      same((await runOnce(h, healthy, "#text")).state, "final", "a run after the change");
      same(
        accountsOf(await requestsFor(h, healthy)),
        [`${next}:200`],
        "the new account goes first",
      );
      await fail(h, next, 401, 1);
      const failing = session(bot, "relock-failing");
      same(
        (await runOnce(h, failing, "#text")).state,
        "final",
        "a run whose new account fails once",
      );
      same(
        accountsOf(await requestsFor(h, failing)),
        [`${next}:401`, `${old}:200`],
        "the old account is tried after the new one",
      );
    },
  },
  {
    name: "a bot whose account suffix is removed keeps using the one account its order names",
    rows: [36],
    run: async (h) => {
      const bot = await createBot(h, "acct-unbind", "acme/dev-1");
      const kept = await signInKey(h, bot, "unbindkept");
      const spare = await signInKey(h, bot, "unbindspare");
      await setModel(h, bot, `acme/dev-1@${kept}`);
      same(await h.lock(bot, "acme", kept), [kept], "the lock");
      await setModel(h, bot, "acme/dev-1");
      same(
        botEntry((await readConfig(h)).config, bot).model,
        { primary: "acme/dev-1", fallbacks: [] },
        "the model without its account",
      );
      const healthy = session(bot, "unbind-healthy");
      same((await runOnce(h, healthy, "#text")).state, "final", "a run without the suffix");
      same(
        accountsOf(await requestsFor(h, healthy)),
        [`${kept}:200`],
        "it ran on the ordered account",
      );
      await fail(h, kept, 401);
      try {
        const failing = session(bot, "unbind-failing");
        same(
          (await runOnce(h, failing, "#text")).state,
          "error",
          "a run whose ordered account fails",
        );
        const requests = await requestsFor(h, failing);
        same(
          [...new Set(requests.flatMap((r) => (r.account ? [r.account] : [])))],
          [kept],
          `only the ordered account was asked (${accountsOf(requests).join(", ")})`,
        );
        expect(!requests.some((r) => r.account === spare), "the other account was never asked");
      } finally {
        await heal(h, kept);
      }
    },
  },
  {
    name: "a sign-in leaves an order only when the bot has one or the config lists the provider's accounts",
    rows: [12],
    run: async (h) => {
      const listed = await createBot(h, "acct-order-listed", "acme/dev-1");
      const first = await signInKey(h, listed, "orderlisted");
      same(
        (await providerView(h.reader, listed, "acme"))?.profileOrder,
        [first, ...CONFIGURED_ACME],
        "a first sign-in, with the config listing acme's accounts",
      );
      const again = await signInKey(h, listed, "orderagain");
      same(
        (await providerView(h.reader, listed, "acme"))?.profileOrder,
        [again, first, ...CONFIGURED_ACME],
        "a later sign-in moves its account to the front of the order the bot has",
      );
      const configured = rec(rec((await readConfig(h)).config.auth).profiles);
      const removed = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, null]));
      try {
        await patchConfig(h, { auth: { profiles: removed(["acme:home", "acme:studio"]) } });
        const single = await createBot(h, "acct-order-single", "acme/dev-1");
        same(await signInKey(h, single, "work"), "acme:work", "the account signed in");
        const view = await providerView(h.reader, single, "acme");
        same(
          [view?.profileOrder, view?.profileOrderStored],
          [["acme:work"], true],
          "a first sign-in of the only configured account leaves a one-account order",
        );
        expect(
          profileIds(view).includes("acme:home"),
          "another acme account is still available to the bot",
        );
        await patchConfig(h, { auth: { profiles: removed(["acme:work"]) } });
        const none = await createBot(h, "acct-order-none", "acme/dev-1");
        const saved = await signInKey(h, none, "ordernone");
        const bare = await providerView(h.reader, none, "acme");
        same(
          [
            profileIds(bare).includes(saved),
            bare?.profileOrder ?? null,
            bare?.profileOrderStored ?? null,
          ],
          [true, null, null],
          "with no order and nothing configured, the sign-in saves its account and leaves no order",
        );
      } finally {
        const restore = Object.fromEntries(
          Object.entries(configured).filter(([id]) => id.startsWith("acme:")),
        );
        await patchConfig(h, { auth: { profiles: restore } });
      }
      same(
        rec(rec((await readConfig(h)).config.auth).profiles),
        configured,
        "the configured accounts are back as they were",
      );
    },
  },
  {
    // #565: Refresh in the Model menu. The scripted providers are declared in the config, so a
    // refresh asks none of them; a model added to a provider's entry is listed by the next one.
    name: "a refresh lists a model the provider's entry gained, read-only, and asks no scripted provider",
    rows: [20],
    run: async (h) => {
      const refresh = () =>
        h.reader.request<JsonRecord>("models.list", {
          agentId: "main",
          provider: "acme",
          refresh: true,
        });
      const ids = (answer: JsonRecord) =>
        (Array.isArray(answer.models) ? answer.models : []).map((m) => rec(m).id);
      const started = await refresh();
      same(ids(started), [...ACCOUNT_MODELS.acme], "acme's models before");
      same(
        [started.providerOutcomes ?? null, started.refreshFailed ?? null],
        [null, null],
        "no provider asked again, and no failed refresh",
      );
      const path = "models.providers.acme.models";
      try {
        // Inside the try: a growth that half landed is put back too.
        await patchConfig(h, { models: { providers: { acme: { models: grownModels("acme") } } } }, [
          path,
        ]);
        const grown = await refresh();
        same(ids(grown), [...ACCOUNT_MODELS.acme, LATER_MODELS.acme], "acme's models after");
        same(grown.providerOutcomes ?? null, null, "still no provider asked again");
      } finally {
        await patchConfig(
          h,
          { models: { providers: { acme: { models: grownModels("acme").slice(0, -1) } } } },
          [path],
        );
      }
      same(ids(await refresh()), [...ACCOUNT_MODELS.acme], "acme's models once put back");
      h.observe(
        `refresh on a read-only connection: acme ${ids(started).join(", ")}; with ${String(LATER_MODELS.acme)} added to its entry, the next refresh lists it; no providerOutcomes`,
      );
    },
  },
  // The gateway decides a failure's reason from its status and its message
  // together: a client reads the reason from the gateway, never from the status.
  ...(
    [
      ["a plain 402", "plain", "The request was not accepted (scripted)", "billing"],
      [
        "a 402 worded as a quota",
        "quota",
        "You exceeded your current quota (scripted)",
        "rate_limit",
      ],
    ] as const
  ).map(([what, tag, message, reason]): AccountCheck => ({
    name: `the gateway's reason for ${what} is ${reason}`,
    rows: [18],
    run: async (h) => {
      const bot = await createBot(h, `acct-402-${tag}`, "acme/dev-1");
      const account = await signInKey(h, bot, `pay${tag}`);
      await setModel(h, bot, `acme/dev-1@${account}`);
      same(await h.lock(bot, "acme", account), [account], "the lock, so the failure surfaces");
      await fail(h, account, 402, undefined, message);
      try {
        const key = session(bot, `402-${tag}`);
        const end = await runOnce(h, key, "#text");
        same(end.state, "error", "the run's end");
        const requests = await requestsFor(h, key);
        expect(
          requests.length >= 1 && requests.every((r) => r.account === account && r.status === 402),
          `every request was the account's, answered 402: ${accountsOf(requests).join(", ")}`,
        );
        same(end.errorDetail?.failoverReason, reason, `the reason the gateway reports for ${what}`);
        h.observe(
          `402 "${message}": failoverReason ${String(end.errorDetail?.failoverReason)}, ${requests.length} request(s), error "${end.errorMessage}"`,
        );
      } finally {
        await heal(h, account);
      }
    },
  })),
];

/** A device-code sign-in for a bot, answered on the scripted side. */
async function deviceSignIn(
  h: AccountHarness,
  bot: string,
  outcome: "approve" | "refuse" | "expire",
  account: string,
): Promise<{ end: WizardAnswer; codeStep: WizardStep | undefined }> {
  const sessionId = await startSignIn(h, SIGNIN_CHOICES.deviceCode, bot);
  const { last } = await stepUntil(h, sessionId, (s) => Boolean(s.deviceCode));
  const codeStep = last.step;
  expect(codeStep?.deviceCode, `no step with a code: ${JSON.stringify(last)}`);
  await scripted(h, "/scripted/signin/answer", {
    userCode: rec(codeStep.deviceCode).code,
    outcome,
    account,
  });
  return { end: await stepToEnd(h, sessionId), codeStep };
}

/** A browser sign-in for pip: open the page, answer it, paste the code or the address back. */
async function browserSignIn(
  h: AccountHarness,
  outcome: "approve" | "refuse" | "expire",
  account: string,
  paste: "code" | "address",
): Promise<{ end: WizardAnswer; steps: WizardStep[]; pasteStep: WizardStep | undefined }> {
  const sessionId = await startSignIn(h, SIGNIN_CHOICES.browser, "pip");
  const { steps, last } = await stepUntil(h, sessionId, (s) => s.type === "text");
  const pasteStep = last.step;
  expect(pasteStep?.type === "text", `no paste step: ${JSON.stringify(last)}`);
  const opened = steps.find((s) => typeof s.externalUrl === "string");
  expect(opened, `no page to open among ${JSON.stringify(steps)}`);
  const state = new URL(String(opened.externalUrl)).searchParams.get("state");
  const answered = await scripted<{ code?: string; redirectUrl?: string }>(
    h,
    "/scripted/signin/answer",
    { state, outcome, account },
  );
  const value = paste === "code" && answered.code ? answered.code : answered.redirectUrl;
  const next = await wizardNext(h, sessionId, { stepId: pasteStep.id, value });
  return { end: next.done ? next : await stepToEnd(h, sessionId), steps: [...steps], pasteStep };
}

/**
 * Cancel a sign-in that waits, and assert both what `wizard.cancel` answers
 * and the terminal answer the next `wizard.next` gives.
 */
async function cancelAndCheck(h: AccountHarness, sessionId: string): Promise<JsonRecord> {
  const cancel = await h.admin.request<JsonRecord>("wizard.cancel", { sessionId });
  same(cancel, { status: "cancelled", error: "cancelled" }, "what wizard.cancel answers");
  const next = await wizardNext(h, sessionId);
  const after = { done: next.done, status: next.status, error: next.error, step: next.step };
  same(
    after,
    { done: true, status: "cancelled", error: "cancelled", step: undefined },
    "the sign-in's terminal answer after the cancel",
  );
  return { cancel, after };
}

/** Start a sign-in for pip, wait for the step, cancel it, and check its end. */
async function cancelledSignIn(
  h: AccountHarness,
  choice: string,
  at: (step: WizardStep) => boolean,
): Promise<JsonRecord> {
  const sessionId = await startSignIn(h, choice, "pip");
  await stepUntil(h, sessionId, at);
  return cancelAndCheck(h, sessionId);
}

/** Pip's acme accounts after some sign-ins: exactly those before, and the approved ones. */
async function expectPipAccounts(h: AccountHarness, before: string[], approved: string[]) {
  same(
    profileIds(await providerView(h.admin, "pip", "acme")),
    [...before, ...approved].sort(),
    "pip's complete acme accounts: those before, and the approved sign-ins only",
  );
}

/** Run the account checks. One line per check; notes and differences for the report. */
export async function runAccountChecks(
  h: Omit<AccountHarness, "observe" | "differ">,
  options: { log?: (line: string) => void; only?: (check: AccountCheck) => boolean } = {},
): Promise<{ passed: number; failed: number; notes: string[]; differences: string[] }> {
  const log = options.log ?? console.log;
  const notes: string[] = [];
  const differences: string[] = [];
  const harness: AccountHarness = {
    ...h,
    observe: (line) => notes.push(line),
    differ: (row, line) => differences.push(`row ${row}: ${line}`),
  };
  let passed = 0;
  let failed = 0;
  for (const check of ACCOUNT_CHECKS.filter(options.only ?? (() => true))) {
    try {
      await check.run(harness);
      passed += 1;
      log(`ok    ${check.name}`);
    } catch (error) {
      failed += 1;
      log(`FAIL  ${check.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { passed, failed, notes, differences };
}
