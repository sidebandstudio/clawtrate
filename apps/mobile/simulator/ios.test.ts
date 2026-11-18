// The iOS app in the Simulator, driven by Maestro against a development gateway
// instance of the run's own (`pnpm mobile:check`). One session with the app,
// in order: the first launch, pairing, Home, a bot's tasks, reading, a live run,
// a dropped connection, and Settings. Each title starts with the parity rows it
// proves on iOS.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONNECT_WORDS, PRODUCT_NAME, SLOGAN } from "@clawtrate/ui/connect-words";
import { LIGHT } from "../src/theme/tokens.ts";
import {
  deadPort,
  devGateway,
  devices,
  env,
  gatewayCall,
  launch,
  layout,
  lit,
  near,
  notSee,
  openclaw,
  protocolFiveGateway,
  Proxy,
  quit,
  rgb,
  screen,
  scrollTo,
  see,
  shoot,
  steps,
  tap,
  until,
  waitFor,
  waitGone,
} from "./harness.ts";

type SessionRow = {
  key: string;
  agentId?: string;
  label?: string;
  derivedTitle?: string;
  updatedAt?: number | null;
  archived?: boolean;
  hasActiveRun?: boolean;
  status?: string;
};

const SESSION_LIST = {
  limit: 500,
  includeDerivedTitles: true,
  includeLastMessage: true,
  excludeCron: true,
  excludeSubagents: true,
};

async function sessions(): Promise<SessionRow[]> {
  return (
    await gatewayCall<{ sessions: SessionRow[] }>("sessions.list", SESSION_LIST)
  ).sessions.filter((row) => !row.archived);
}

/** A task of the check's own, made on the gateway. */
async function gatewayTask(botId: string, label: string): Promise<{ key: string; title: string }> {
  const suffix = Math.random().toString(16).slice(2, 6);
  const title = `${label} ${suffix}`;
  const key = `agent:${botId}:ios-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${suffix}`;
  await gatewayCall("sessions.create", { key, agentId: botId, label: title });
  return { key, title };
}

/** A run in a task, as the gateway's owner starts one; resolves when it has ended. */
function runOnGateway(botId: string, key: string, message: string): Promise<string> {
  return openclaw([
    "agent",
    "--agent",
    botId,
    "--session-key",
    key,
    "--message",
    message,
    "--thinking",
    "low",
    "--json",
  ]);
}

const hostOf = (url: string) => url.replace(/^ws:\/\//, "");

let proxy: Proxy;
/** The gateway as the app reaches it: through the check's proxy, which can drop it. */
let gateway = "";
let five: { url: string; close: () => Promise<void> };
let deviceId = "";

beforeAll(async () => {
  proxy = new Proxy(Number(new URL(env.gateway).port));
  gateway = await proxy.start();
  five = await protocolFiveGateway();
});

afterAll(async () => {
  await proxy?.stop();
  await five?.close();
});

describe("the iOS app", () => {
  it("F-001 F-009 F-263: on iPhone, the first screen is the welcome with the mark, the tagline and Connect a gateway; an empty address, a gateway nobody answers and one on another protocol each get the desktop's words and a way on", async () => {
    launch({ fresh: true, devGateway: gateway });
    await steps("welcome", [
      waitFor({ id: "welcome" }),
      see({ id: "mark" }),
      see(lit(PRODUCT_NAME)),
      see(lit(SLOGAN)),
      see(lit(CONNECT_WORDS.hint)),
      see({ id: "connect-a-gateway", text: lit(CONNECT_WORDS.connect) }),
      // One action: nothing else to press.
      notSee({ id: "connect-button" }),
    ]);
    await shoot("welcome");
    await steps("address", [
      tap({ id: "connect-a-gateway" }),
      waitFor({ id: "address-field" }, 20_000),
      see({ id: "token-field" }),
      see({ id: "connect-button", text: lit(CONNECT_WORDS.connect) }),
    ]);
    await shoot("address");
    await steps("empty-address", [
      tap({ id: "connect-button" }),
      see({ id: "connect-error-title", text: lit(CONNECT_WORDS.missingAddress.title) }),
      see({ id: "connect-error-message", text: lit(CONNECT_WORDS.missingAddress.message) }),
    ]);

    const dead = `ws://127.0.0.1:${await deadPort()}`;
    await steps("unreachable", [
      ...typeAddress(dead, "unused-token"),
      waitFor({ id: "connect-error-title", text: "Could not connect" }, 90_000),
      see({
        id: "connect-error-message",
        text: lit(
          `Nothing answered at ${hostOf(dead)}. Check that the gateway is running and that the address is right.`,
        ),
      }),
      see({ id: "connect-error-code", text: "UNREACHABLE" }),
      see({ id: "try-again", text: lit(CONNECT_WORDS.tryAgain) }),
    ]);
    await shoot("connection-error");
    await steps("another-protocol", [
      {
        runFlow: {
          when: { visible: { id: "use-another" } },
          commands: [tap({ id: "use-another" })],
        },
      },
      ...typeAddress(five.url, "unused-token"),
      waitFor({ id: "protocol-notice" }, 90_000),
      see(lit(CONNECT_WORDS.protocolTitle)),
      see({
        id: "protocol-lede",
        text: lit(
          `${hostOf(five.url)} speaks protocol 5. This version of Clawtrate speaks protocol 4. Update the one that is older, then retry.`,
        ),
      }),
      see({ id: "protocol-retry" }),
    ]);
    await shoot("protocol");
    await steps("choose-another", [
      tap({ id: "choose-another" }),
      waitFor({ id: "address-field" }, 20_000),
    ]);
  });

  it("F-002 F-003 F-009: on iPhone, a read-only pairing lists exactly the read scope with the dev tool's approve command and the steps, a rejected request is no longer pending, and approval opens Home by itself", async () => {
    await steps("connect", typeAddress(gateway, env.token));
    const first = await until("the app's pairing request", async () =>
      (await devices()).pending.find((request) => request.displayName === "Clawtrate iPhone"),
    );
    // The gateway was asked for read access and nothing more.
    expect(first.scopes).toEqual(["operator.read"]);
    deviceId = first.deviceId!;
    await steps("pairing", [
      waitFor({ id: "pairing" }, 90_000),
      see(lit(CONNECT_WORDS.approveTitle)),
      see({ id: "mark", text: PRODUCT_NAME }),
      see({
        id: "approve-command",
        text: lit(`pnpm dev-gateway approve --instance ${env.instance}`),
      }),
      notSee(".*openclaw devices approve.*"),
      see({ id: "setup-step-0", text: lit(`Connected to ${hostOf(gateway)}`) }),
      see({ id: "setup-step-1", text: `${lit(CONNECT_WORDS.waiting)}.*` }),
      see({ id: "setup-step-2", text: "Load bots" }),
      see({ id: "scope-operator.read", text: lit("Read bots, tasks and conversations") }),
      notSee({ id: "scope-operator.write" }),
      notSee({ id: "scope-operator.approvals" }),
      notSee({ id: "scope-operator.questions" }),
      notSee({ id: "scope-operator.admin" }),
      waitFor(
        {
          id: "connect-foot",
          text: `Request ${first.requestId!.slice(0, 8)} · this device ${deviceId.slice(0, 8)} · .*`,
        },
        30_000,
      ),
    ]);
    await shoot("pairing");

    // The gateway's owner rejects it: the app can say only that it is no longer pending.
    await openclaw(["devices", "reject", first.requestId!]);
    await steps("rejected", [
      waitFor(
        { id: "connect-error-title", text: "The pairing request is no longer pending" },
        90_000,
      ),
      see({
        id: "connect-error-message",
        text: `${lit("It was rejected, or it expired before anyone approved it; the gateway does not say which.")}.*`,
      }),
      tap({ id: "try-again" }),
      waitFor({ id: "pairing" }, 90_000),
      waitGone({ id: "connect-foot", text: `Request ${first.requestId!.slice(0, 8)} .*` }, 30_000),
    ]);
    const second = await until("a new pairing request", async () =>
      (await devices()).pending.find(
        (r) => r.displayName === "Clawtrate iPhone" && r.requestId !== first.requestId,
      ),
    );
    expect(second.scopes).toEqual(["operator.read"]);
    expect(second.deviceId).toBe(deviceId);

    devGateway("approve");
    await steps("opens-home", [
      waitFor({ id: "home" }, 120_000),
      waitFor({ id: "bot-pip" }, 60_000),
    ]);
    const paired = (await devices()).paired.find((d) => d.deviceId === deviceId);
    expect(paired?.scopes).toEqual(["operator.read"]);
  });

  it("F-015 F-017 F-019: on iPhone, Home lists every bot by its latest activity with its avatar, name, label pill, latest line and time, and the primary bot with its star", async () => {
    const { agents, defaultId } = await gatewayCall<{
      agents: Array<{ id: string; name?: string; identity?: { name?: string; theme?: string } }>;
      defaultId: string;
    }>("agents.list", {});
    const rows = await sessions();
    const latest = (id: string) =>
      Math.max(...rows.filter((r) => r.agentId === id).map((r) => r.updatedAt ?? 0));
    const order = [...agents].sort((a, b) => latest(b.id) - latest(a.id));
    const name = (a: (typeof agents)[number]) => a.identity?.name ?? a.name ?? a.id;
    await steps("home-rows", [
      waitFor({ id: "home" }),
      ...order.flatMap((agent) => {
        const count = rows.filter((r) => r.agentId === agent.id).length;
        return [
          see({
            id: `bot-${agent.id}`,
            text: `${lit(name(agent))}, ${count} tasks?.*${agent.id === defaultId ? ", primary bot" : ""}`,
          }),
          see({ id: `bot-label-${agent.id}`, text: lit(agent.identity!.theme!) }),
          see({ id: `bot-preview-${agent.id}`, text: ".+" }),
          // Today's activity, as "7:12 AM".
          see({ id: `bot-time-${agent.id}`, text: "\\d{1,2}:\\d{2}.(AM|PM)" }),
        ];
      }),
      // In order of their latest activity, newest first.
      ...order
        .slice(1)
        .map((agent, i) => see({ id: `bot-${agent.id}`, below: { id: `bot-${order[i]!.id}` } })),
      see({ id: "primary-star", childOf: { id: `bot-${defaultId}` } }),
      ...agents
        .filter((a) => a.id !== defaultId)
        .map((a) => notSee({ id: "primary-star", childOf: { id: `bot-${a.id}` } })),
      see({ id: "settings-button", text: "Settings. Gateway connected." }),
      see({ id: "connection-dot-connected" }),
    ]);
    // Each row's latest line is its newest task's.
    const positions = await layout();
    for (const agent of agents) {
      const newest = rows
        .filter((r) => r.agentId === agent.id)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]!;
      const preview = positions.get(`bot-preview-${agent.id}`)?.[0]?.text ?? "";
      expect(preview.length).toBeGreaterThan(0);
      const lastLine =
        (newest as { lastMessagePreview?: string }).lastMessagePreview ??
        newest.label ??
        newest.derivedTitle ??
        "";
      expect(
        lastLine
          .replace(/\s+/g, " ")
          .startsWith(preview.replace(/\s+/g, " ").replace(/…$/, "").slice(0, 30)),
      ).toBe(true);
    }
    await shoot("home");
  });

  it("F-427: on iPhone, tapping a bot opens its task list, tapping a task opens its chat, Back returns to the task list, and Back again returns to Home", async () => {
    const otto = (await sessions()).filter((r) => r.agentId === "otto");
    await steps("bot-tasks", [
      tap({ id: "bot-otto" }),
      waitFor({ id: "bot-tasks-otto" }, 20_000),
      see({ id: "bot-name", text: "Otto" }),
      ...otto.map((row) =>
        see({ id: `task-${lit(row.key)}`, text: `${lit(row.label ?? row.derivedTitle ?? "")}.*` }),
      ),
      notSee("New task"),
    ]);
    await shoot("bot-tasks");
    await steps("open-and-back", [
      tap({ id: `task-${lit("agent:otto:disk-space")}` }),
      waitFor({ id: "transcript" }, 20_000),
      see({ id: "title-pill", text: "Otto" }),
      scrollTo({ id: "task-line", text: "Disk almost full on the media box" }, "UP"),
      tap({ id: "back", text: "Back to Otto's tasks" }),
      waitFor({ id: "bot-tasks-otto" }, 20_000),
      tap({ id: "back", text: "Back to bots" }),
      waitFor({ id: "home" }, 20_000),
      see({ id: "bot-otto" }),
    ]);
  });

  it("F-063 F-065: on iPhone, a task's chat starts with its title, puts a stamp before the first message, shows your messages and the bot's as bubbles with the bot's markdown, and each action as one line in the engine's words", async () => {
    await steps("read-disk", [
      tap({ id: "bot-otto" }),
      waitFor({ id: "bot-tasks-otto" }, 20_000),
      tap({ id: `task-${lit("agent:otto:disk-space")}` }),
      waitFor({ id: "turn-bot" }, 60_000),
      scrollTo({ id: "task-line", text: "Disk almost full on the media box" }, "UP"),
      see({ id: "stamp", text: "Today \\d{1,2}:\\d{2}.(AM|PM)", below: { id: "task-line" } }),
      see(`${lit("The media box says the disk is 94% full. What is eating the space?")}`),
      // The markdown is drawn, not shown as marks.
      notSee(".*\\*\\*.*"),
      scrollTo({ text: "Read AGENTS\\.md.*", id: "action-line" }, "DOWN"),
      scrollTo({ id: "task-line", text: "Disk almost full on the media box" }, "UP"),
    ]);
    await shoot("transcript");
    // Your bubble on the right in your colour, the bot's on the left in the raised fill.
    const at = await layout();
    const view = at.get("transcript")![0]!;
    const width = view.x2;
    const pixel = screen(width);
    // A bubble on screen, and a point inside the part of it that is.
    const shown = (id: string) => {
      const box = at.get(id)!.find((b) => Math.min(b.y2, view.y2) - Math.max(b.y1, view.y1) > 30)!;
      return { ...box, y1: Math.max(box.y1, view.y1), y2: Math.min(box.y2, view.y2) };
    };
    const user = shown("turn-user");
    const bot = shown("turn-bot");
    expect(user.x2).toBeGreaterThan(width - 24);
    expect(user.x1).toBeGreaterThan(width * 0.2);
    expect(bot.x1).toBeLessThan(24);
    expect(bot.x2).toBeLessThan(width * 0.9);
    expect(near(pixel(user.x1 + 6, (user.y1 + user.y2) / 2), rgb(LIGHT["bubble-user"]))).toBe(true);
    expect(near(pixel(bot.x1 + 6, (bot.y1 + bot.y2) / 2), rgb(LIGHT["bg-bubble"]))).toBe(true);

    // A table inside the bot's bubble, its cells drawn, scrolling inside the bubble.
    await steps("read-table", [
      tap({ id: "back" }),
      tap({ id: "back" }),
      waitFor({ id: "home" }),
      tap({ id: "bot-main" }),
      waitFor({ id: "bot-tasks-main" }, 20_000),
      tap({ id: `task-${lit("agent:main:heat-pump-brief")}` }),
      waitFor({ id: "turn-bot" }, 60_000),
      // The table is in the middle of the first reply.
      {
        scrollUntilVisible: {
          element: { id: "md-table" },
          direction: "DOWN",
          timeout: 30_000,
          visibilityPercentage: 50,
        },
      },
      see({ id: "md-table" }),
      notSee(".*\\| --- \\|.*"),
      tap({ id: "back" }),
      waitFor({ id: "bot-tasks-main" }),
      // A link opens in the system browser: the app leaves the screen.
      tap({ id: `task-${lit("agent:main:coding-handoff")}` }),
      waitFor({ id: "turn-bot" }, 60_000),
      waitFor({ text: ".*https://coding-agent\\.example/threads/thread-1" }),
    ]);
    // The reply ends with its link, which has the bubble's last line to itself: tap its start.
    const replies = (await layout()).get("turn-bot")!;
    const reply = replies[replies.length - 1]!;
    await steps("open-link", [
      { tapOn: { point: `${reply.x1 + 30},${reply.y2 - 22}` } },
      waitGone({ id: "transcript" }, 30_000),
    ]);
    launch({ devGateway: gateway });
    await steps("back-from-browser", [waitFor({ id: "home" }, 60_000)]);
  });

  it("F-020 F-323: on iPhone, a run started on the gateway shows its bot working on Home and in its open chat and then its reply; quit while a run goes on, the app opened again shows it running, then how it ended", async () => {
    const { key, title } = await gatewayTask("marlow", "Anything new");
    let run = runOnGateway("marlow", key, "#stream 60");
    // The gateway runs this task (another of Marlow's may run too, on its own).
    await until("the check's run on the gateway", async () =>
      (await sessions()).find((r) => r.key === key && (r.hasActiveRun || r.status === "running")),
    );
    await steps("working", [
      waitFor({ id: "bot-marlow", text: "Marlow, working, .*" }, 90_000),
      see({ id: "state-working", childOf: { id: "bot-marlow" } }),
      see({ id: "bot-time-marlow", text: "now" }),
      tap({ id: "bot-marlow" }),
      waitFor({ id: `task-${lit(key)}`, text: `${lit(title)}, working` }, 30_000),
      see({ id: "state-working", childOf: { id: `task-${lit(key)}` } }),
      tap({ id: `task-${lit(key)}` }),
      waitFor({ id: "running" }, 60_000),
    ]);
    await shoot("running");
    await steps("run-ends", [
      waitGone({ id: "running" }, 180_000),
      // The reply's history has landed: its first line is above, where the chat followed it from.
      {
        scrollUntilVisible: {
          element: { text: "Here is a long answer, streamed slowly\\." },
          direction: "UP",
          timeout: 60_000,
        },
      },
    ]);
    await run;

    // Quit while the next run goes on.
    run = runOnGateway("marlow", key, "#stream 150");
    await until("the check's second run on the gateway", async () =>
      (await sessions()).find((r) => r.key === key && (r.hasActiveRun || r.status === "running")),
    );
    quit();
    // Closing the app stopped nothing: the gateway still runs it.
    const row = (await sessions()).find((r) => r.key === key);
    expect(row?.hasActiveRun || row?.status === "running").toBe(true);
    launch({ devGateway: gateway });
    await steps("reopened", [
      waitFor({ id: "bot-marlow", text: "Marlow, working, .*" }, 90_000),
      tap({ id: "bot-marlow" }),
      waitFor({ id: `task-${lit(key)}`, text: `${lit(title)}, working` }, 30_000),
      tap({ id: `task-${lit(key)}` }),
      { scrollUntilVisible: { element: { id: "running" }, direction: "DOWN", timeout: 60_000 } },
      waitGone({ id: "running" }, 300_000),
      tap({ id: "back" }),
      waitFor({ id: `task-${lit(key)}` }),
      notSee({ id: `task-${lit(key)}`, text: `${lit(title)}, working` }),
      tap({ id: "back" }),
      waitFor({ id: "home" }),
    ]);
    await run;
  });

  it("on iPhone, a dropped connection keeps Home on screen and says it is reconnecting, with Retry now; once the gateway is back the app reconnects and the strip goes", async () => {
    await steps("before-drop", [waitFor({ id: "home" }), see({ id: "connection-dot-connected" })]);
    await proxy.cut();
    await steps("dropped", [
      waitFor(
        { id: "status-strip-text", text: "(Reconnecting.*|Can't reach the gateway.*)" },
        60_000,
      ),
      see({ id: "status-strip-action", text: "Retry now" }),
      see({ id: "bot-otto" }),
      see({ id: "bot-main" }),
      see({ id: "settings-button", text: "Settings. Gateway (connecting|offline)\\." }),
    ]);
    await shoot("reconnecting");
    await proxy.restore();
    await steps("returns", [
      // The app may have reconnected on its own schedule already; else Retry now does it at once.
      {
        runFlow: {
          when: { visible: { id: "status-strip-action", text: "Retry now" } },
          commands: [tap({ id: "status-strip-action" })],
        },
      },
      waitFor({ id: "connection-dot-connected" }, 90_000),
      waitGone({ id: "status-strip" }, 60_000),
      see({ id: "bot-otto" }),
    ]);
  });

  it("on iPhone, Settings shows the gateway, this device and the read scope it holds; Disconnect keeps the pairing until Reconnect, and Use another gateway forgets the gateway but keeps the device", async () => {
    await steps("settings", [
      tap({ id: "settings-button" }),
      waitFor({ id: "settings" }, 20_000),
      see({ id: "gateway-address", text: lit(gateway) }),
      see({ id: "gateway-state-text", text: "Connected" }),
      see({ id: "granted-scopes", text: "operator\\.read" }),
      see({ id: "gateway-device", text: lit(`Clawtrate iPhone · ${deviceId.slice(0, 8)}`) }),
    ]);
    await shoot("settings");
    await steps("disconnect", [
      tap({ id: "disconnect" }),
      waitFor({ id: "gateway-state-text", text: "Disconnected" }, 30_000),
      see({ id: "reconnect" }),
      tap({ id: "settings-close" }),
      waitFor({ id: "status-strip-text", text: "Disconnected.*" }, 30_000),
      see({ id: "status-strip-action", text: "Reconnect" }),
      see({ id: "bot-otto" }),
    ]);
    // Disconnected keeps the pairing: the gateway still has the device, and Reconnect connects it.
    expect((await devices()).paired.some((d) => d.deviceId === deviceId)).toBe(true);
    await steps("reconnect", [
      tap({ id: "status-strip-action" }),
      waitFor({ id: "connection-dot-connected" }, 60_000),
      waitGone({ id: "status-strip" }, 60_000),
    ]);
    await steps("forget", [
      tap({ id: "settings-button" }),
      waitFor({ id: "settings" }, 20_000),
      tap({ id: "forget" }),
      waitFor({ id: "address-field" }, 30_000),
    ]);
    // Opened again, the app remembers no gateway, and is still the same device.
    launch({ devGateway: gateway });
    await steps("forgotten", [
      waitFor({ id: "welcome" }, 60_000),
      see({ id: "connect-foot", text: lit(`This device ${deviceId.slice(0, 8)} · iPhone 0.1.0`) }),
    ]);
    // Through the whole session the device asked for nothing but read.
    const listed = await devices();
    expect(listed.paired.find((d) => d.deviceId === deviceId)?.scopes).toEqual(["operator.read"]);
    expect(listed.pending.filter((r) => r.deviceId === deviceId)).toEqual([]);
  });
});

/** Type a gateway's address and token, and connect with the keyboard's Go key. */
function typeAddress(url: string, token: string) {
  return [
    waitFor({ id: "address-field" }, 30_000),
    tap({ id: "address-field" }),
    { eraseText: 80 },
    { inputText: url },
    tap({ id: "token-field" }),
    { eraseText: 80 },
    { inputText: token },
    { pressKey: "Enter" },
    // iOS offers to save what a secure field held once it leaves the screen. The token is
    // used once, so the person says Not Now; the sheet is the system's, not the app's.
    { extendedWaitUntil: { visible: "Save Password\\?", timeout: 8_000, optional: true } },
    { runFlow: { when: { visible: "Save Password\\?" }, commands: [tap("Not Now")] } },
  ];
}
