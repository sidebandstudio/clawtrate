// The scripted model's side of provider accounts: which account each request
// came from, failures scripted per account, and the scripted sign-ins the
// development sign-in plugin (plugins/clawtrate-dev-signin) talks to. All of
// it lives in the scripted model server, on loopback, in memory.
//
// Requests. Every chat completion is recorded with the account its bearer
// credential belongs to (accounts.ts names accounts in their credentials).
// A request with no credential at all is refused with 401, as a real
// provider refuses one; the `scripted` provider always sends its placeholder
// key, so only the accounts' providers can send none.
//
//   GET  /scripted/requests[?since=<seq>]        {requests: [RequestRecord]}
//
// Failures, per account, while the others stay healthy:
//
//   POST /scripted/accounts/fail   {account, status: 401|402|429, times?, message?}
//        `times` answers that many requests with the status, then heals;
//        without it the account fails until it is cleared. `message` replaces
//        the error's message (one line, at most 200 characters): the gateway
//        decides a failure's reason from its status and its message together
//   POST /scripted/accounts/clear  {account?}   one account, or every one
//   GET  /scripted/accounts/failures
//
// Sign-ins. The plugin calls the provider side; a test, or a person in a
// browser, plays the one signing in.
//
//   provider side (the plugin)
//   POST /scripted/signin/device/start    {provider}        a device code to poll
//   POST /scripted/signin/device/poll     {deviceCode}      pending, or the outcome
//   POST /scripted/signin/browser/start   {provider}        a page to open
//   POST /scripted/signin/browser/exchange {provider, code} the pasted code's outcome
//   POST /scripted/signin/key/check       {provider, key}   the typed key's outcome
//   POST /scripted/signin/refresh         {refresh}         a new access credential
//
//   the person (a test, or the pages)
//   POST /scripted/signin/answer   {userCode | state, outcome, account?}
//        outcome approve, refuse or expire; a browser sign-in answers with
//        the code to paste and the address the browser would land on
//   POST /scripted/signin/key-outcome {key, outcome: refuse|expire|approve}
//   GET  /scripted/signin/device?code=<userCode>     a page to approve or refuse
//   GET  /scripted/signin/browser/authorize?state=<state>   the same
//   GET  /scripted/signin/sessions                   every sign-in and its state

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { accountOfCredential, credentialFor, NAME_PART, type CredentialKind } from "./accounts.ts";

export type FailureStatus = 401 | 402 | 429;
export const FAILURE_STATUSES: readonly FailureStatus[] = [401, 402, 429];

/** How a request is to fail: the status, and the error message when it is not the default one. */
export type ScriptedFailure = { status: FailureStatus; message?: string };

export type RequestRecord = {
  seq: number;
  /** Milliseconds since the epoch. */
  at: number;
  /** The account whose credential arrived, `<provider>:<name>`, or null for any other credential. */
  account: string | null;
  /** The credential's storage kind, "none" without one, "other" for a credential no account has. */
  credential: CredentialKind | "none" | "other";
  model: string | null;
  /** The gateway session the request was made for, from its runtime line. */
  session: string | null;
  /** What the scripted model answered: 200, or the scripted failure. */
  status: number;
};

export type Outcome = "approve" | "refuse" | "expire";
const OUTCOMES: readonly Outcome[] = ["approve", "refuse", "expire"];

type Tokens = {
  access: string;
  refresh: string;
  /** Milliseconds since the epoch. */
  expires: number;
  account: string;
  email: string;
};

type SignIn = {
  kind: "device" | "browser";
  provider: string;
  /** The device code the plugin polls with, or the browser sign-in's state. */
  secret: string;
  /** What the person sees: the device sign-in's code, or the browser sign-in's state. */
  userCode: string;
  outcome: Outcome | null;
  account: string | null;
  /** A browser sign-in's one-time authorization code, once approved. */
  code: string | null;
  createdAt: number;
  expiresAt: number;
  finished: boolean;
};

/** A sign-in's code lasts this long unless the person lets it expire first. */
const SIGNIN_LIFETIME_MS = 15 * 60_000;
/** An access credential lasts an hour; a refresh mints the next serial. */
const ACCESS_LIFETIME_MS = 60 * 60_000;

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const sendHtml = (res: ServerResponse, body: string) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
};

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 64 * 1024) chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** A JSON body, or the fields of a form a page posted. */
async function readFields(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if ((req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

const PROFILE = /^([a-z][a-z0-9]{0,23}):([a-z][a-z0-9]{0,23})$/;

/** Accounts, failures and sign-ins of one scripted model server. */
export class ScriptedAccounts {
  private readonly records: RequestRecord[] = [];
  private seq = 0;
  /** Per account: the status, and how many more requests get it (Infinity: until cleared). */
  private readonly failures = new Map<
    string,
    { status: FailureStatus; remaining: number; message?: string }
  >();
  private readonly signIns = new Map<string, SignIn>();
  private readonly keyOutcomes = new Map<string, Outcome>();
  private serial = 0;
  private autoName = 0;
  private readonly baseUrl: () => string;
  private readonly now: () => number;

  constructor(options: { baseUrl: () => string; now?: () => number }) {
    this.baseUrl = options.baseUrl;
    this.now = options.now ?? Date.now;
  }

  /**
   * Record a chat completion and say whether its account is scripted to
   * fail. Called once per request, before any reply is written.
   */
  observe(request: {
    authorization: string | undefined;
    model: string | null;
    session: string | null;
  }): ScriptedFailure | null {
    const owner = accountOfCredential(request.authorization);
    const failure = owner ? this.failures.get(owner.account) : undefined;
    let answer: ScriptedFailure | null = request.authorization ? null : { status: 401 };
    if (owner && failure) {
      answer = {
        status: failure.status,
        ...(failure.message === undefined ? {} : { message: failure.message }),
      };
      failure.remaining -= 1;
      if (failure.remaining <= 0) this.failures.delete(owner.account);
    }
    const status = answer?.status ?? null;
    this.seq += 1;
    this.records.push({
      seq: this.seq,
      at: this.now(),
      account: owner?.account ?? null,
      credential: owner ? owner.kind : request.authorization ? "other" : "none",
      model: request.model,
      session: request.session,
      status: status ?? 200,
    });
    return answer;
  }

  requests(since = 0): RequestRecord[] {
    return this.records.filter((r) => r.seq > since);
  }

  fail(account: string, status: FailureStatus, times?: number, message?: string): void {
    if (!PROFILE.test(account)) throw new Error(`not an account id: ${JSON.stringify(account)}`);
    if (!FAILURE_STATUSES.includes(status)) throw new Error("status must be 401, 402 or 429");
    if (times !== undefined && (!Number.isSafeInteger(times) || times < 1)) {
      throw new Error("times must be a whole number from 1");
    }
    if (
      message !== undefined &&
      (typeof message !== "string" ||
        !message.trim() ||
        message.length > 200 ||
        /[\r\n]/.test(message))
    ) {
      throw new Error("message must be one line of at most 200 characters");
    }
    this.failures.set(account, {
      status,
      remaining: times ?? Infinity,
      ...(message === undefined ? {} : { message }),
    });
  }

  clear(account?: string): void {
    if (account === undefined) this.failures.clear();
    else this.failures.delete(account);
  }

  failing(): Record<string, { status: FailureStatus; remaining: number | "until cleared" }> {
    return Object.fromEntries(
      [...this.failures].map(([account, f]) => [
        account,
        {
          status: f.status,
          remaining: Number.isFinite(f.remaining) ? f.remaining : "until cleared",
        },
      ]),
    );
  }

  private nextName(): string {
    this.autoName += 1;
    return `signin${this.autoName}`;
  }

  private mint(provider: string, name: string): Tokens {
    this.serial += 1;
    return {
      access: credentialFor("oauth", provider, name, this.serial),
      refresh: `clawtrate-dev-refresh.${provider}.${name}.${this.serial}`,
      expires: this.now() + ACCESS_LIFETIME_MS,
      account: `${provider}:${name}`,
      // A reserved example domain, so an id built from it is plainly made up.
      email: `${name}@${provider}.example`,
    };
  }

  private startSignIn(kind: SignIn["kind"], provider: string): SignIn {
    if (!NAME_PART.test(provider)) throw new Error(`not a scripted provider: ${provider}`);
    const secret = randomBytes(16).toString("hex");
    const letters = randomBytes(4).toString("hex").toUpperCase();
    const signIn: SignIn = {
      kind,
      provider,
      secret,
      userCode: kind === "device" ? `${letters.slice(0, 4)}-${letters.slice(4)}` : secret,
      outcome: null,
      account: null,
      code: null,
      createdAt: this.now(),
      expiresAt: this.now() + SIGNIN_LIFETIME_MS,
      finished: false,
    };
    this.signIns.set(secret, signIn);
    return signIn;
  }

  private findByUserCode(userCode: string): SignIn | undefined {
    return [...this.signIns.values()].find((s) => s.userCode === userCode);
  }

  /** The person's answer to a sign-in: approve as an account, refuse, or let it expire. */
  answer(fields: { userCode?: unknown; state?: unknown; outcome?: unknown; account?: unknown }) {
    const key = typeof fields.userCode === "string" ? fields.userCode : fields.state;
    const signIn =
      typeof key === "string" ? (this.findByUserCode(key) ?? this.signIns.get(key)) : undefined;
    if (!signIn) throw new Error("no such sign-in");
    if (signIn.finished || signIn.outcome) throw new Error("that sign-in was already answered");
    if (!OUTCOMES.includes(fields.outcome as Outcome)) {
      throw new Error("outcome must be approve, refuse or expire");
    }
    const name =
      typeof fields.account === "string" && fields.account !== ""
        ? fields.account
        : this.nextName();
    if (!NAME_PART.test(name)) throw new Error("account must be lowercase letters and digits");
    signIn.outcome = fields.outcome as Outcome;
    signIn.account = name;
    if (signIn.kind === "browser" && signIn.outcome !== "refuse") {
      signIn.code = `clawtrate-dev-code.${randomBytes(8).toString("hex")}`;
    }
    if (signIn.kind === "browser" && signIn.outcome === "refuse") {
      return {
        outcome: signIn.outcome,
        redirectUrl: this.redirect(signIn, { error: "access_denied" }),
      };
    }
    return {
      outcome: signIn.outcome,
      account: `${signIn.provider}:${name}`,
      ...(signIn.code
        ? { code: signIn.code, redirectUrl: this.redirect(signIn, { code: signIn.code }) }
        : {}),
    };
  }

  /** Where the browser would land after the provider's page: an address that does not open. */
  private redirect(signIn: SignIn, params: Record<string, string>): string {
    const query = new URLSearchParams({ ...params, state: signIn.secret });
    return `${this.baseUrl()}/scripted/signin/browser/landed?${query}`;
  }

  private outcomeOf(signIn: SignIn): "pending" | Outcome {
    if (!signIn.outcome && this.now() > signIn.expiresAt) return "expire";
    return signIn.outcome ?? "pending";
  }

  private settle(signIn: SignIn): Record<string, unknown> {
    const outcome = this.outcomeOf(signIn);
    if (outcome === "pending") return { status: "pending" };
    signIn.finished = true;
    if (outcome === "refuse")
      return { status: "refused", error: "The person refused the sign-in." };
    if (outcome === "expire")
      return { status: "expired", error: "The code expired before the sign-in finished." };
    return { status: "approved", tokens: this.mint(signIn.provider, signIn.account!) };
  }

  private signInList() {
    return [...this.signIns.values()].map((s) => ({
      kind: s.kind,
      provider: s.provider,
      userCode: s.userCode,
      state: s.kind === "browser" ? s.secret : undefined,
      outcome: this.outcomeOf(s),
      account: s.account ? `${s.provider}:${s.account}` : null,
      finished: s.finished,
    }));
  }

  private page(signIn: SignIn | undefined, field: "userCode" | "state"): string {
    if (!signIn) return "<!doctype html><title>Scripted sign-in</title><p>No such sign-in.</p>";
    const value = escapeHtml(field === "userCode" ? signIn.userCode : signIn.secret);
    const heading =
      signIn.kind === "device"
        ? `Code <strong>${escapeHtml(signIn.userCode)}</strong>`
        : "A browser sign-in";
    return `<!doctype html><meta charset="utf-8"><title>Scripted sign-in</title>
<h1>Scripted ${escapeHtml(signIn.provider)} sign-in</h1>
<p>${heading}. Nothing here is a real provider.</p>
<form method="post" action="/scripted/signin/answer">
<input type="hidden" name="${field}" value="${value}">
<label>Account name <input name="account" placeholder="signin" pattern="[a-z][a-z0-9]*"></label>
<button name="outcome" value="approve">Approve</button>
<button name="outcome" value="refuse">Refuse</button>
<button name="outcome" value="expire">Let it expire</button>
</form>`;
  }

  /** Answer a request under /scripted/ if it is one of these; false otherwise. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const route = `${req.method ?? "GET"} ${url.pathname}`;
    const fail = (status: number, message: string) => {
      sendJson(res, status, { error: { message } });
      return true;
    };
    try {
      switch (route) {
        case "GET /scripted/requests": {
          const since = Number(url.searchParams.get("since") ?? 0);
          sendJson(res, 200, { requests: this.requests(Number.isFinite(since) ? since : 0) });
          return true;
        }
        case "POST /scripted/accounts/fail": {
          const f = await readFields(req);
          if (typeof f.status !== "number") throw new Error("status must be 401, 402 or 429");
          if (f.times !== undefined && typeof f.times !== "number") {
            throw new Error("times must be a whole number from 1");
          }
          if (f.message !== undefined && typeof f.message !== "string") {
            throw new Error("message must be one line of at most 200 characters");
          }
          this.fail(
            String(f.account),
            f.status as FailureStatus,
            f.times as number | undefined,
            f.message as string | undefined,
          );
          sendJson(res, 200, { failures: this.failing() });
          return true;
        }
        case "POST /scripted/accounts/clear": {
          const f = await readFields(req);
          this.clear(typeof f.account === "string" ? f.account : undefined);
          sendJson(res, 200, { failures: this.failing() });
          return true;
        }
        case "GET /scripted/accounts/failures":
          sendJson(res, 200, { failures: this.failing() });
          return true;
        case "POST /scripted/signin/device/start": {
          const f = await readFields(req);
          const s = this.startSignIn("device", String(f.provider));
          sendJson(res, 200, {
            deviceCode: s.secret,
            userCode: s.userCode,
            verificationUri: `${this.baseUrl()}/scripted/signin/device?code=${s.userCode}`,
            expiresInSeconds: SIGNIN_LIFETIME_MS / 1000,
            intervalSeconds: 1,
          });
          return true;
        }
        case "POST /scripted/signin/device/poll": {
          const f = await readFields(req);
          const s = this.signIns.get(String(f.deviceCode));
          if (!s || s.kind !== "device") return fail(404, "no such device code");
          sendJson(res, 200, this.settle(s));
          return true;
        }
        case "POST /scripted/signin/browser/start": {
          const f = await readFields(req);
          const s = this.startSignIn("browser", String(f.provider));
          sendJson(res, 200, {
            state: s.secret,
            authorizeUrl: `${this.baseUrl()}/scripted/signin/browser/authorize?state=${s.secret}`,
          });
          return true;
        }
        case "POST /scripted/signin/browser/exchange": {
          const f = await readFields(req);
          const code = String(f.code ?? "");
          const s = [...this.signIns.values()].find(
            (x) =>
              x.kind === "browser" &&
              (x.code === code || (x.outcome === "refuse" && x.secret === f.state)),
          );
          if (!s || s.finished) {
            sendJson(res, 200, { status: "refused", error: "The code was not accepted." });
            return true;
          }
          sendJson(res, 200, this.settle(s));
          return true;
        }
        case "POST /scripted/signin/key/check": {
          const f = await readFields(req);
          const key = String(f.key ?? "");
          const owner = accountOfCredential(key);
          const outcome = this.keyOutcomes.get(key) ?? "approve";
          if (
            !owner ||
            owner.kind !== "api_key" ||
            !owner.account.startsWith(`${String(f.provider)}:`)
          ) {
            sendJson(res, 200, { status: "refused", error: "That is not a key of this provider." });
          } else if (outcome === "refuse") {
            sendJson(res, 200, { status: "refused", error: "The provider refused the key." });
          } else if (outcome === "expire") {
            sendJson(res, 200, { status: "expired", error: "The key has expired." });
          } else {
            sendJson(res, 200, { status: "approved", account: owner.account });
          }
          return true;
        }
        case "POST /scripted/signin/refresh": {
          const f = await readFields(req);
          const match =
            /^clawtrate-dev-refresh\.([a-z][a-z0-9]{0,23})\.([a-z][a-z0-9]{0,23})\.\d+$/.exec(
              String(f.refresh ?? ""),
            );
          if (!match) return fail(400, "not a scripted refresh credential");
          sendJson(res, 200, { status: "approved", tokens: this.mint(match[1]!, match[2]!) });
          return true;
        }
        case "POST /scripted/signin/answer": {
          const f = await readFields(req);
          const answered = this.answer(f);
          if ((req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) {
            sendHtml(
              res,
              `<!doctype html><meta charset="utf-8"><title>Scripted sign-in</title><pre>${escapeHtml(JSON.stringify(answered, null, 2))}</pre>`,
            );
          } else {
            sendJson(res, 200, answered);
          }
          return true;
        }
        case "POST /scripted/signin/key-outcome": {
          const f = await readFields(req);
          if (!OUTCOMES.includes(f.outcome as Outcome)) {
            return fail(400, "outcome must be approve, refuse or expire");
          }
          this.keyOutcomes.set(String(f.key), f.outcome as Outcome);
          sendJson(res, 200, { ok: true });
          return true;
        }
        case "GET /scripted/signin/sessions":
          sendJson(res, 200, { signIns: this.signInList() });
          return true;
        case "GET /scripted/signin/device":
          sendHtml(
            res,
            this.page(this.findByUserCode(url.searchParams.get("code") ?? ""), "userCode"),
          );
          return true;
        case "GET /scripted/signin/browser/authorize":
          sendHtml(res, this.page(this.signIns.get(url.searchParams.get("state") ?? ""), "state"));
          return true;
        case "GET /scripted/signin/browser/landed":
          sendHtml(
            res,
            "<!doctype html><title>Scripted sign-in</title><p>Copy this whole address and paste it back.</p>",
          );
          return true;
        default:
          return false;
      }
    } catch (error) {
      return fail(400, error instanceof Error ? error.message : String(error));
    }
  }
}
