// #932: a Claude plan's setup token, through the gateway's setup sign-in. OpenClaw 2026.10.6 and
// 2026.11.10 both answer `openclaw.setup.auth.start {sessionId, authChoice: "setup-token"}` with a
// session whose first step asks for the token ("Paste Anthropic setup-token"), refuse a token of
// the wrong form on that step, and, once it is accepted, save it, check it with one request and
// set the bot's model to an Anthropic one. The answers below are what a development gateway of
// each version sent, up to the paste step; past it, they follow the source
// (`setup-inference-credentials-*.mjs`, `setup-model-selection-*.mjs`).
import { describe, expect, it } from "vitest";
import { createBridgeSession, parseBridgeCommand } from "../src/bridge.ts";
import { AccountsEngine } from "../src/accounts-engine.ts";
import {
  initialAccountsState,
  setupTokenMethods,
  SETUP_AUTH_START,
  SETUP_TOKEN_METHOD,
  type AccountsState,
  type SignInState,
} from "../src/accounts.ts";
import { accountsClient, AccountsGateway } from "./accounts-fake.ts";
import { until } from "./fake-gateway.ts";

type Json = Record<string, unknown>;

/** A token of the accepted form, made here from pieces: nothing in the repository looks like one. */
const TOKEN = `${["sk", "ant", "oat01"].join("-")}-${"made-up".repeat(12)}`;
const SAVED = "anthropic:setup-made-up";
const MODEL = `anthropic/claude-sonnet-5-5@${SAVED}`;

/** Anthropic as both versions list it in `models.authStatus`: a key, and no sign-in. */
const ANTHROPIC = { provider: "anthropic", apiKeySupported: true, quickApiKeySetup: true };

function setupGateway(
  options: {
    offered?: boolean;
    outcome?: "connect" | "fail" | "saved";
    /** The bot already has an Anthropic connection: after its check the gateway asks to switch. */
    replacement?: boolean;
  } = {},
) {
  const fake = new AccountsGateway();
  const g = fake.gateway;
  const started: Json[] = [];
  const answers: unknown[] = [];
  const anthropic: Array<{ id: string; status: string }> = [];
  // The hello lists the setup method, as both versions' do.
  const connect = g.connectReply!;
  g.connectReply = (params, url) => {
    const reply = connect(params, url);
    const hello = (reply as { payload?: { features?: { methods: string[] } } }).payload;
    if ((options.offered ?? true) && hello?.features) hello.features.methods = [SETUP_AUTH_START];
    return reply;
  };
  const status = g.handlers["models.authStatus"]!;
  g.handlers["models.authStatus"] = (params) => {
    const answer = status(params) as { providers: Json[]; providerCapabilities?: Json[] };
    if (!answer.providerCapabilities) return answer;
    return {
      ...answer,
      providers: [
        ...answer.providers,
        {
          provider: "anthropic",
          displayName: "Anthropic",
          status: "static",
          profiles: anthropic.map((p) => ({
            profileId: p.id,
            type: "token",
            status: p.status,
            source: "inherited",
            logoutSupported: true,
          })),
        },
      ],
      providerCapabilities: [...answer.providerCapabilities, ANTHROPIC],
    };
  };
  let session: string | null = null;
  g.handlers[SETUP_AUTH_START] = (params) => {
    started.push(params as Json);
    session = (params as { sessionId: string }).sessionId;
    return { sessionId: session, done: false, status: "running" };
  };
  const step = {
    type: "text",
    message: "Paste Anthropic setup-token",
    executor: "client",
    id: "s1",
  };
  const confirm = {
    type: "confirm",
    message: "Connection verified. Activate this saved sign-in?",
    executor: "client",
    id: "s2",
  };
  let asked = false;
  const next = g.handlers["wizard.next"]!;
  g.handlers["wizard.next"] = (params) => {
    const { sessionId, answer } = params as {
      sessionId: string;
      answer?: { stepId: string; value: unknown };
    };
    if (sessionId !== session) return next(params);
    if (!answer) return { done: false, step, status: "running" };
    if (answer.stepId === confirm.id) {
      answers.push(answer.value);
      if (answer.value !== true)
        return { done: true, status: "error", error: "Activation declined." };
      const agents = fake.config.agents as { entries: Record<string, Json> };
      agents.entries.main = { ...agents.entries.main, model: { primary: MODEL } };
      session = null;
      return { done: true, status: "done" };
    }
    answers.push(answer.value);
    if (typeof answer.value !== "string" || !answer.value.startsWith(TOKEN.slice(0, 13)))
      return { done: false, step, status: "running", error: "Expected token starting with …" };
    // Saved before its check, inactive; then checked, and on success activated with the model.
    anthropic.push({ id: SAVED, status: "static" });
    if (options.outcome === "fail")
      return { done: true, status: "error", error: "The connection test did not pass." };
    // The gateway's own words when its check fails after the token was saved.
    if (options.outcome === "saved")
      return {
        done: true,
        status: "error",
        error:
          "Credentials saved; default unchanged. Could not verify the connection. Choose the saved sign-in in Model Setup to retry without signing in again.",
      };
    if (options.replacement && !asked) {
      asked = true;
      return { done: false, step: confirm, status: "running" };
    }
    // Done: the gateway purges the session itself (`wizard.next`, both versions).
    session = null;
    const agents = fake.config.agents as { entries: Record<string, Json> };
    agents.entries.main = { ...agents.entries.main, model: { primary: MODEL } };
    return { done: true, status: "done" };
  };
  const cancel = g.handlers["wizard.cancel"]!;
  g.handlers["wizard.cancel"] = (params) => {
    if ((params as { sessionId: string }).sessionId !== session) return cancel(params);
    session = null;
    return { status: "cancelled", error: "cancelled" };
  };
  const logout = g.handlers["models.authLogout"]!;
  g.handlers["models.authLogout"] = (params) => {
    const { profileIds } = params as { profileIds: string[] };
    for (const id of profileIds) {
      const at = anthropic.findIndex((p) => p.id === id);
      if (at >= 0) anthropic.splice(at, 1);
    }
    return logout(params);
  };
  return { fake, started, answers, anthropic };
}

const DORMANT_INPUT = "made-up-plan-input-for-the-disabled-path";
const STALE_SETUP: SignInState = {
  id: "stale-setup",
  method: SETUP_TOKEN_METHOD,
  provider: "anthropic",
  label: "Claude plan",
  flow: "token",
  forBot: "main",
  keptOnly: false,
  stage: "entering",
  step: null,
  error: null,
  cancelling: false,
  saving: false,
  startedAt: 0,
  result: null,
  byKey: false,
  known: [],
  cancelUnknown: false,
};

function expectNoSetup(
  client: Awaited<ReturnType<typeof accountsClient>>["client"],
  fake: AccountsGateway,
) {
  expect(client.state.accounts.signIn).toBeNull();
  const engine = Reflect.get(client, "accounts") as object;
  expect(Reflect.get(engine, "secrets")).toEqual([]);
  expect(Reflect.get(engine, "modelBefore")).toBeNull();
  expect(Reflect.get(engine, "setupStarting")).toBeNull();
  expect(JSON.stringify(client.state).includes(DORMANT_INPUT)).toBe(false);
  for (const method of [SETUP_AUTH_START, "wizard.next", "wizard.cancel"])
    expect(fake.gateway.calls(method)).toEqual([]);
}

describe("F-474 #932: the shipped setup switch", () => {
  it("the disabled core refuses even a listed setup method and holds no token or session", async () => {
    const { fake } = setupGateway();
    const { client, accounts } = await accountsClient({ gateway: fake });
    try {
      expect(accounts().methods.some((method) => method.id === SETUP_TOKEN_METHOD)).toBe(false);
      // A stale offer also cannot start a wizard when the host's switch is off.
      accounts().methods.push(...setupTokenMethods([ANTHROPIC], true));
      await expect(client.startSignIn(SETUP_TOKEN_METHOD, null)).rejects.toThrow("isn't available");
      await expect(client.answerSignIn(DORMANT_INPUT, true)).resolves.toBeUndefined();
      await expect(client.cancelSignIn("made-up-session", true)).resolves.toEqual({
        cancelled: false,
      });
      expectNoSetup(client, fake);
    } finally {
      client.stop();
    }
  });

  it("the disabled bridge refuses setup and discards its answer and cancel", async () => {
    const { fake } = setupGateway();
    const { client, accounts } = await accountsClient({ gateway: fake });
    const bridge = createBridgeSession(client);
    try {
      accounts().methods.push(...setupTokenMethods([ANTHROPIC], true));
      const send = (command: Json) => bridge.apply(parseBridgeCommand(command));
      await expect(
        send({ type: "startSignIn", methodId: SETUP_TOKEN_METHOD, botId: null }),
      ).rejects.toThrow("isn't available");
      await expect(
        send({ type: "answerSignIn", value: DORMANT_INPUT, setupToken: true }),
      ).resolves.toBeUndefined();
      await expect(
        send({ type: "cancelSignIn", signInId: "made-up-session", setupToken: true }),
      ).resolves.toEqual({ cancelled: false });
      expectNoSetup(client, fake);
    } finally {
      bridge.dispose();
      client.stop();
    }
  });

  it("the disabled cleanup leaves an existing setup profile through connect, reconnect and a failed key save", async () => {
    const { fake, anthropic } = setupGateway();
    anthropic.push({ id: SAVED, status: "static" });
    const { client, accounts } = await accountsClient({ gateway: fake });
    const engine = Reflect.get(client, "accounts") as AccountsEngine;
    const stale = { id: STALE_SETUP.id, model: null, gateway: fake.identity };
    try {
      // A reconnect also cannot clean up a setup record left by an older version.
      accounts().signIn = { ...STALE_SETUP };
      Reflect.set(engine, "modelBefore", stale);
      const first = client.state.connection.connectedAt;
      fake.gateway.dropAll();
      await until(
        () =>
          client.state.connection.status === "connected" &&
          client.state.connection.connectedAt !== first &&
          client.state.connection.gatewayId === fake.identity &&
          accounts().signIn === null,
      );
      expectNoSetup(client, fake);
      fake.echoTyped = true;
      const key = "made-up-refused-key";
      const refusal = await client.saveApiKey("anthropic", key, null).catch((error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        return String(error);
      });
      expect(refusal).toMatch(/refused/);
      expect(refusal).not.toContain(key);
      expect(fake.gateway.calls("models.authSetApiKey")).toHaveLength(1);
      // Even a direct cleanup caller with a matching stale setup id cannot log out that profile.
      accounts().signIn = { ...STALE_SETUP };
      Reflect.set(engine, "modelBefore", stale);
      const cleanup = Reflect.get(engine, "dropSetupLeftovers").bind(engine) as (
        id: string,
        botId: string,
        added: string[],
      ) => Promise<string[]>;
      await expect(cleanup(STALE_SETUP.id, "main", [SAVED])).resolves.toEqual([]);
      expect(fake.gateway.calls("models.authLogout")).toEqual([]);
      expect(anthropic.map((profile) => profile.id)).toEqual([SAVED]);
    } finally {
      client.stop();
    }
  });
});

describe("a Claude plan's setup token (#932)", () => {
  it("is offered when the gateway lists Anthropic and its setup sign-in, and not without that method", async () => {
    const offered = await accountsClient({ setupTokenSignIn: true, gateway: setupGateway().fake });
    expect(offered.accounts().methods.find((m) => m.id === SETUP_TOKEN_METHOD)).toMatchObject({
      provider: "anthropic",
      flow: "token",
      group: "subscription",
    });
    offered.client.stop();
    const not = await accountsClient({
      setupTokenSignIn: true,
      gateway: setupGateway({ offered: false }).fake,
    });
    expect(not.accounts().methods.map((m) => m.id)).not.toContain(SETUP_TOKEN_METHOD);
    not.client.stop();
  });

  it("starts the gateway's setup sign-in for the bot, never models.authLogin, and waits for the token", async () => {
    const { fake, started } = setupGateway();
    const { client, accounts } = await accountsClient({ setupTokenSignIn: true, gateway: fake });
    await client.startSignIn(SETUP_TOKEN_METHOD, null);
    expect(started).toEqual([
      { sessionId: accounts().signIn!.id, authChoice: "setup-token", agentId: "main" },
    ]);
    expect(fake.gateway.calls("models.authLogin")).toEqual([]);
    expect(accounts().signIn).toMatchObject({ stage: "entering", flow: "token" });
    client.stop();
  });

  it("a token of the wrong form is refused on the same step, and nothing is saved", async () => {
    const { fake, anthropic } = setupGateway();
    const { client, accounts } = await accountsClient({ setupTokenSignIn: true, gateway: fake });
    await client.startSignIn(SETUP_TOKEN_METHOD, null);
    await client.answerSignIn("not a setup token");
    await until(() => accounts().signIn?.stage === "entering");
    // Asked again, with the refusal noted for Clawtrate's own words.
    expect(accounts().signIn?.error).toMatch(/\S/);
    expect(anthropic).toEqual([]);
    client.stop();
  });

  it("connects: the token is sent once and kept nowhere, and the bot's model change is noted", async () => {
    const { fake, answers } = setupGateway();
    const { client, accounts } = await accountsClient({ setupTokenSignIn: true, gateway: fake });
    await client.startSignIn(SETUP_TOKEN_METHOD, null);
    await client.answerSignIn(TOKEN);
    await until(() => accounts().signIn?.stage === "connected");
    expect(answers).toEqual([TOKEN]);
    expect(accounts().signIn?.result).toMatchObject({
      added: [SAVED],
      modelChange: { before: null, after: MODEL },
    });
    expect(JSON.stringify(client.state)).not.toContain(TOKEN);
    client.stop();
  });

  it("records the model the gateway has now, even when the last accounts read is stale", async () => {
    const { fake } = setupGateway();
    const { client, accounts } = await accountsClient({ setupTokenSignIn: true, gateway: fake });
    try {
      expect(accounts().bindings.find((b) => b.botId === "main")?.primary).toBeNull();
      const before = "acme/dev-1@acme:work";
      const entries = (fake.config.agents as { entries: Record<string, Json> }).entries;
      entries.main = { ...entries.main, model: { primary: before } };
      await client.startSignIn(SETUP_TOKEN_METHOD, null);
      await client.answerSignIn(TOKEN);
      await until(() => accounts().signIn?.result?.modelChange != null);
      expect(accounts().signIn?.result?.modelChange).toEqual({ before, after: MODEL });
    } finally {
      client.stop();
    }
  });

  it("retains the previous model through a failed verification and Check again", async () => {
    const { fake } = setupGateway();
    const { client, accounts } = await accountsClient({ setupTokenSignIn: true, gateway: fake });
    try {
      const before = "acme/dev-1";
      const entries = (fake.config.agents as { entries: Record<string, Json> }).entries;
      entries.main = { ...entries.main, model: { primary: before } };
      await client.startSignIn(SETUP_TOKEN_METHOD, null);
      fake.unavailable = true;
      await client.answerSignIn(TOKEN);
      await until(() => accounts().signIn?.stage === "unverified");
      fake.unavailable = false;
      await client.recheckSignIn();
      await until(() => accounts().signIn?.stage === "connected");
      expect(accounts().signIn?.result?.modelChange).toEqual({ before, after: MODEL });
    } finally {
      client.stop();
    }
  });

  it("cancels by id while setup is still reading the model, before opening a gateway session", async () => {
    const { fake } = setupGateway();
    const { client, accounts } = await accountsClient({ setupTokenSignIn: true, gateway: fake });
    try {
      const get = fake.gateway.handlers["config.get"]!;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      fake.gateway.handlers["config.get"] = async (params) => {
        await held;
        return get(params);
      };
      const id = "clawtrate-close-during-read";
      const started = client.startSignIn(SETUP_TOKEN_METHOD, null, id);
      try {
        await until(() => accounts().signIn?.stage === "starting");
        expect(accounts().signIn?.id).not.toBe(id);
        await expect(client.cancelSignIn("a-previous-sign-in")).resolves.toEqual({
          cancelled: false,
        });
        await expect(client.cancelSignIn(id)).resolves.toEqual({ cancelled: true });
      } finally {
        release();
        await started;
      }
      await until(() => accounts().signIn?.result != null);
      expect(fake.gateway.calls(SETUP_AUTH_START)).toEqual([]);
      expect(fake.gateway.calls("wizard.cancel")).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("waits for an admitted setup before cancelling the same session", async () => {
    const { fake } = setupGateway();
    const { client } = await accountsClient({ setupTokenSignIn: true, gateway: fake });
    try {
      const setup = fake.gateway.handlers[SETUP_AUTH_START]!;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      fake.gateway.handlers[SETUP_AUTH_START] = async (params) => {
        await held;
        return setup(params);
      };
      const id = "clawtrate-close-during-start";
      const started = client.startSignIn(SETUP_TOKEN_METHOD, null, id);
      try {
        await until(() => fake.gateway.calls(SETUP_AUTH_START).length === 1);
        const cancel = client.cancelSignIn(id);
        expect(fake.gateway.calls("wizard.cancel")).toEqual([]);
        release();
        await expect(cancel).resolves.toEqual({ cancelled: true });
      } finally {
        release();
        await started;
      }
      expect(fake.gateway.calls("wizard.cancel")).toEqual([
        { sessionId: (fake.gateway.calls(SETUP_AUTH_START)[0] as Json).sessionId },
      ]);
      expect((fake.gateway.calls(SETUP_AUTH_START)[0] as Json).sessionId).not.toBe(id);
      expect(fake.gateway.calls("wizard.next")).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("Put back gives the bot its earlier model, only while it still has the one the sign-in gave it", async () => {
    const { fake } = setupGateway();
    const { client, accounts } = await accountsClient({ setupTokenSignIn: true, gateway: fake });
    await client.startSignIn(SETUP_TOKEN_METHOD, null);
    await client.answerSignIn(TOKEN);
    await until(() => accounts().signIn?.result?.modelChange != null);
    const entries = (fake.config.agents as { entries: Record<string, Json> }).entries;
    // Changed since by someone else: left as it is.
    entries.main = { ...entries.main, model: { primary: "acme/dev-1@acme:work" } };
    const stamp = { gatewayId: "gateway-a", target: client.state.connection.target };
    await expect(client.putBackModel("main", null, MODEL, stamp)).rejects.toThrow(
      /has changed since/,
    );
    expect((fake.config.agents as { entries: Record<string, Json> }).entries.main!.model).toEqual({
      primary: "acme/dev-1@acme:work",
    });
    // Still the sign-in's: the bot's own model goes again, as before the sign-in.
    entries.main = { ...entries.main, model: { primary: MODEL } };
    await client.putBackModel("main", null, MODEL, stamp);
    const after = (fake.config.agents as { entries: Record<string, Json> }).entries;
    expect(after.main!.model).toBeUndefined();
    client.stop();
  });

  it("Put back rejects an edit that lands after the model was checked", async () => {
    const { fake } = setupGateway();
    const { client, accounts } = await accountsClient({ setupTokenSignIn: true, gateway: fake });
    await client.startSignIn(SETUP_TOKEN_METHOD, null);
    await client.answerSignIn(TOKEN);
    await until(() => accounts().signIn?.result?.modelChange != null);

    const alternate = { primary: "acme/dev-1@acme:work" };
    const get = fake.gateway.handlers["config.get"]!;
    fake.gateway.handlers["config.get"] = (params) => {
      const snapshot = get(params);
      const entries = (fake.config.agents as { entries: Record<string, Json> }).entries;
      entries.main = { ...entries.main, model: alternate };
      fake.revision += 1;
      fake.gateway.handlers["config.get"] = get;
      return snapshot;
    };

    try {
      const stamp = { gatewayId: "gateway-a", target: client.state.connection.target };
      await expect(client.putBackModel("main", null, MODEL, stamp)).rejects.toThrow(
        "config changed",
      );
      const entries = (fake.config.agents as { entries: Record<string, Json> }).entries;
      expect(entries.main!.model).toEqual(alternate);
    } finally {
      client.stop();
    }
  });

  it("a sign-in that doesn't connect leaves no saved token: the one OpenClaw kept is removed", async () => {
    const { fake, anthropic } = setupGateway({ outcome: "fail" });
    const { client, accounts } = await accountsClient({ setupTokenSignIn: true, gateway: fake });
    await client.startSignIn(SETUP_TOKEN_METHOD, null);
    await client.answerSignIn(TOKEN);
    await until(() => accounts().signIn?.stage === "failed" && accounts().signIn?.result != null);
    expect(fake.gateway.calls("models.authLogout")).toEqual([
      { provider: "anthropic", profileIds: [SAVED], agentId: "main" },
    ]);
    expect(anthropic).toEqual([]);
    client.stop();
  });

  it("a connection lost on the way: the setup session is ended after the reconnect, and its saved token removed", async () => {
    const { fake, anthropic } = setupGateway();
    const { client, accounts } = await accountsClient({ setupTokenSignIn: true, gateway: fake });
    await client.startSignIn(SETUP_TOKEN_METHOD, null);
    const id = accounts().signIn!.id;
    // As if the token was taken and saved just before the connection went.
    anthropic.push({ id: SAVED, status: "static" });
    fake.gateway.dropAll();
    await until(() => client.state.connection.status === "connected");
    await until(() => fake.gateway.calls("models.authLogout").length > 0);
    expect(fake.gateway.calls("wizard.cancel")).toContainEqual({ sessionId: id });
    expect(anthropic).toEqual([]);
    client.stop();
  });

  it("a lost answer after activation leaves the bot's connected account alone", async () => {
    const { fake, anthropic } = setupGateway();
    const { client, accounts } = await accountsClient({ setupTokenSignIn: true, gateway: fake });
    await client.startSignIn(SETUP_TOKEN_METHOD, null);
    const id = accounts().signIn!.id;
    const reads = fake.gateway.calls("users.prefs.get").length;
    // The gateway committed the activation before the client got its final answer.
    anthropic.push({ id: SAVED, status: "static" });
    fake.config.auth = { profiles: { [SAVED]: { provider: "anthropic", mode: "token" } } };
    const entries = (fake.config.agents as { entries: Record<string, Json> }).entries;
    entries.main = { ...entries.main, model: { primary: MODEL } };

    try {
      fake.gateway.dropAll();
      await until(() => accounts().signIn?.result != null);
      await until(() => fake.gateway.calls("users.prefs.get").length > reads);
      expect(fake.gateway.calls("wizard.cancel")).toContainEqual({ sessionId: id });
      expect(fake.gateway.calls("models.authLogout")).toEqual([]);
      expect(anthropic.map((profile) => profile.id)).toEqual([SAVED]);
    } finally {
      client.stop();
    }
  });

  it("Cancel ends the gateway's setup session", async () => {
    const { fake } = setupGateway();
    const { client, accounts } = await accountsClient({ setupTokenSignIn: true, gateway: fake });
    await client.startSignIn(SETUP_TOKEN_METHOD, null);
    const id = accounts().signIn!.id;
    expect(await client.cancelSignIn()).toEqual({ cancelled: true });
    expect(fake.gateway.calls("wizard.cancel")).toContainEqual({ sessionId: id });
    client.stop();
  });

  it("a bot that had an Anthropic connection: the gateway's question to switch is answered yes, once, and the change is noted", async () => {
    const { fake, answers } = setupGateway({ replacement: true });
    const { client, accounts } = await accountsClient({ setupTokenSignIn: true, gateway: fake });
    await client.startSignIn(SETUP_TOKEN_METHOD, null);
    await client.answerSignIn(TOKEN);
    await until(() => accounts().signIn?.stage === "connected");
    expect(answers).toEqual([TOKEN, true]);
    expect(accounts().signIn?.result?.modelChange).toEqual({ before: null, after: MODEL });
    client.stop();
  });

  it("a sign-in that connects is ended by the gateway itself: nothing more is sent for it", async () => {
    const { fake } = setupGateway();
    const { client, accounts } = await accountsClient({ setupTokenSignIn: true, gateway: fake });
    await client.startSignIn(SETUP_TOKEN_METHOD, null);
    const id = accounts().signIn!.id;
    await client.answerSignIn(TOKEN);
    await until(() => accounts().signIn?.result?.modelChange != null);
    const mine = (method: string) =>
      fake.gateway
        .calls(method)
        .filter((each) => (each as { sessionId?: string }).sessionId === id);
    // The token's answer was the last step: the gateway answered done and let the session go.
    expect(mine("wizard.next")).toHaveLength(2);
    expect(mine("wizard.cancel")).toEqual([]);
    client.stop();
  });

  it("Put back keeps the bot's own fallbacks: only its primary model goes back", async () => {
    const { fake } = setupGateway();
    const { client, accounts } = await accountsClient({ setupTokenSignIn: true, gateway: fake });
    await client.startSignIn(SETUP_TOKEN_METHOD, null);
    await client.answerSignIn(TOKEN);
    await until(() => accounts().signIn?.result?.modelChange != null);
    const entries = (fake.config.agents as { entries: Record<string, Json> }).entries;
    entries.main = { ...entries.main, model: { primary: MODEL, fallbacks: ["acme/dev-1"] } };
    const stamp = { gatewayId: "gateway-a", target: client.state.connection.target };
    await client.putBackModel("main", null, MODEL, stamp);
    expect((fake.config.agents as { entries: Record<string, Json> }).entries.main!.model).toEqual({
      fallbacks: ["acme/dev-1"],
    });
    client.stop();
  });

  it("another gateway answering at the same address: its sessions and sign-ins are left alone", async () => {
    const { fake } = setupGateway();
    const g = fake.gateway;
    let gateway = "gateway-a";
    let state: AccountsState = initialAccountsState;
    const sent: string[] = [];
    const engine = new AccountsEngine({
      request: (method, params) => {
        sent.push(method);
        return Promise.resolve().then(() => g.handlers[method]!(params));
      },
      readAgain: (read) => read(),
      get: () => state,
      update: (change) => {
        state = change(state);
      },
      bots: () => [{ id: "main", name: "main", isDefault: true, avatarUrl: null }],
      connected: () => true,
      admin: () => true,
      offers: (method) => method === SETUP_AUTH_START,
      setupTokenSignIn: () => true,
      refreshBots: () => Promise.resolve(),
      gateway: () => Promise.resolve(gateway),
      gatewayNow: () => gateway,
      readStamp: () => ({ gatewayId: gateway, target: 1, connectedAt: 1 }),
      target: () => 0,
      createMainTask: () => Promise.resolve(),
      now: () => 0,
      randomId: () => "id",
      log: () => {},
    });
    await engine.load();
    await engine.startSignIn(SETUP_TOKEN_METHOD, null);
    await until(() => state.signIn?.stage === "entering");
    // The connection goes, and the next hello at that address is another gateway's.
    engine.onClose();
    gateway = "gateway-b";
    sent.length = 0;
    engine.onHello();
    await until(() => state.signIn?.result != null);
    expect(sent).not.toContain("wizard.cancel");
    expect(sent).not.toContain("models.authLogout");
  });

  it('a check that fails after the token was saved is a failure, never "saved, not confirmed": the token is removed', async () => {
    const { fake, anthropic } = setupGateway({ outcome: "saved" });
    const { client, accounts } = await accountsClient({ setupTokenSignIn: true, gateway: fake });
    await client.startSignIn(SETUP_TOKEN_METHOD, null);
    await client.answerSignIn(TOKEN);
    await until(() => accounts().signIn?.result != null);
    expect(accounts().signIn?.stage).toBe("failed");
    expect(anthropic).toEqual([]);
    client.stop();
  });
});
