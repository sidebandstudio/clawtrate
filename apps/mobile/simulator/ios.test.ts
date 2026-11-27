// The iOS app in the Simulator, driven by Maestro against a development gateway
// instance of the run's own (`pnpm mobile:check`). One session with the app,
// in order: the first launch and its failures, pairing (expired, rejected,
// approved), Home, a bot's tasks, reading, a live run, a dropped connection,
// the largest text size, and Settings with the app switcher and a reinstall.
// Each title starts with the parity rows it proves on iOS.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import {
  AVATAR_BALL,
  AVATAR_COLORS,
  SHELLFOLK_CREAM,
  avatarScene,
  avatarVariation,
  defaultAvatar,
  firstChoice,
  INBOUND_MEDIA_ROUTE,
  pictureWithChoice,
  plainPreview,
  READ_AGAIN_TRIES,
  type AvatarChoice,
} from "@clawtrate/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import {
  CLEARTEXT_WORDS,
  CONNECT_WORDS,
  pairingLede,
  PRODUCT_NAME,
  SLOGAN,
} from "../src/presentation/connect-words.ts";
import { ENSEMBLE } from "../src/presentation/ensemble.ts";
import { noTasksBody, TASK_WORDS } from "../src/presentation/summary.ts";
import { CONVERSATION_WORDS } from "../src/presentation/conversation-words.ts";
import { SENT_PICTURE_LINES, sentPictureAlt } from "../src/presentation/sent-files.ts";
import { rowTime, stampTime } from "../../../packages/ui/src/format.ts";
import { addressWords, SETTINGS_WORDS } from "../src/presentation/gateway-state.ts";
import { WebSocket, WebSocketServer } from "ws";
import { decodePng, encodePng } from "../../../tools/brand/src/png.ts";
import { REDACTED } from "../src/host/secrets.ts";
import { TASKS_FAILED } from "../src/lists.ts";
import { LINK_WORDS } from "../src/markdown.ts";
import { DARK, LIGHT, TOUCH } from "../src/theme/tokens.ts";
import {
  activate,
  appLog,
  closeWithin,
  containerHits,
  deadPort,
  devGateway,
  devices,
  displays,
  echoingGateway,
  env,
  gatewayCall,
  holdStreamCompletion,
  infoPlist,
  inject,
  launch,
  layout,
  lit,
  measuredWindows,
  moves,
  near,
  notSee,
  openSystemSettings,
  openclaw,
  operator,
  relay,
  pasteboard,
  protectedFront,
  protocolFiveGateway,
  Proxy,
  quit,
  reduceMotion,
  reinstall,
  running,
  rgb,
  screen,
  screenText,
  scrollTo,
  see,
  shoot,
  steps,
  switcherSnapshot,
  tap,
  textSize,
  transcriptLinkTap,
  typeInto,
  until,
  waitFor,
  waitGone,
  workspaceFor,
  type FrontRequest,
  type Step,
} from "./harness.ts";
import { PAIRING, startsOnItsOwn } from "./jobs.ts";

type SessionRow = {
  key: string;
  sessionId?: string;
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

/** When the gateway stored the message of a task that holds a text. */
async function storedAt(sessionKey: string, text: string): Promise<number> {
  const history = await gatewayCall<{ messages?: Array<{ timestamp?: number }> }>("chat.history", {
    sessionKey,
    limit: 40,
  });
  const message = (history.messages ?? []).find((m) => JSON.stringify(m).includes(text));
  if (typeof message?.timestamp !== "number") throw new Error(`No stored message holds ${text}`);
  return message.timestamp;
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
    "--timeout",
    "960",
    "--json",
  ]);
}

/**
 * Whether the row of creatures stands at the foot of a connection screen:
 * their colours fill the bottom band of the screen. They are decoration,
 * hidden from VoiceOver, so they are found by their pixels.
 */
async function creaturesAtFoot(screenId: string): Promise<boolean> {
  const view = (await layout()).get(screenId)![0]!;
  const pixel = screen(view.x2);
  const colours = ENSEMBLE.map(({ choice }) => rgb(AVATAR_COLORS[choice.color]));
  let hits = 0;
  for (let y = view.y2 - 56; y < view.y2 - 4; y += 4)
    for (let x = 4; x < view.x2 - 4; x += 4)
      if (colours.some((colour) => near(pixel(x, y), colour, 10))) hits += 1;
  return hits > 100;
}

const hostOf = (url: string) => url.replace(/^ws:\/\//, "");
/** A stamp's words as a pattern: the clock's space may be any space. */
const stampPattern = (at: number) => lit(stampTime(at)).replace(/\s/g, ".");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function expectSwitcherCover({
  data,
  width,
  height,
}: Awaited<ReturnType<typeof switcherSnapshot>>) {
  // SplashBoard can save either appearance's snapshot.
  const corner = [data[0]!, data[1]!, data[2]!];
  const bg = [rgb(LIGHT.bg), rgb(DARK.bg)].find((color) => near(corner, color, 4));
  if (!bg) throw new Error("The snapshot corner does not match either cover background.");
  const mark = decodePng(readFileSync(join(import.meta.dirname, "../assets/logo-mark.png")));
  const left = Math.floor((width - mark.width) / 2);
  const top = Math.floor((height - mark.height) / 2);
  // UIKit rounds the 56-point mark with a 16-point corner radius.
  const radius = (16 / 56) * mark.width;
  let backgroundMismatch = 0;
  let edgeMismatch = 0;
  let markMismatch = 0;
  for (let i = 0; i < data.length; i += 4) {
    const color = [data[i]!, data[i + 1]!, data[i + 2]!];
    const x = ((i / 4) % width) - left;
    const y = Math.floor(i / 4 / width) - top;
    if (data[i + 3] !== 255) {
      backgroundMismatch += 1;
      continue;
    }
    if (x < 0 || y < 0 || x >= mark.width || y >= mark.height) {
      if (!near(color, bg, 4)) backgroundMismatch += 1;
      continue;
    }
    const offset = (y * mark.width + x) * 4;
    const cornerX = Math.max(radius - x - 0.5, x + 0.5 - (mark.width - radius), 0);
    const cornerY = Math.max(radius - y - 0.5, y + 0.5 - (mark.height - radius), 0);
    const distance = Math.hypot(cornerX, cornerY) - radius;
    if (distance >= 2) {
      if (!near(color, bg, 4)) backgroundMismatch += 1;
      continue;
    }
    const delta = bg.map((background, channel) => mark.data[offset + channel]! - background);
    const alpha = mark.data[offset + 3]! / 255;
    if (distance > -2) {
      // UIKit varies the coverage of antialiased edges. Fit one alpha for all
      // three channels and allow only a blend of the mark and its background.
      const contrast = delta.reduce((sum, channel) => sum + channel * channel, 0);
      const projection = delta.reduce(
        (sum, channel, index) => sum + (color[index]! - bg[index]!) * channel,
        0,
      );
      const coverage = contrast === 0 ? 0 : Math.max(0, Math.min(alpha, projection / contrast));
      const blended = bg.map((background, channel) => background + delta[channel]! * coverage);
      if (!near(color, blended, 16)) edgeMismatch += 1;
      continue;
    }
    const blended = bg.map((background, channel) => background + delta[channel]! * alpha);
    if (!near(color, blended, 16)) markMismatch += 1;
  }
  expect(backgroundMismatch).toBe(0);
  expect(edgeMismatch).toBe(0);
  // The snapshot's colour conversion can change a few pixels inside the mark.
  expect(markMismatch).toBeLessThan(mark.width * mark.height * 0.002);
}

let proxy: Proxy;
/** The gateway as the app reaches it: through the check's proxy, which can drop it. */
let gateway = "";
let five: Awaited<ReturnType<typeof protocolFiveGateway>>;
let echo: Awaited<ReturnType<typeof echoingGateway>>;
let deviceId = "";
let started = 0;
/** The check's own reading task, and when its first message was stored. */
let reading: { key: string; title: string };
let firstNoteAt = 0;

const FIRST_NOTE = "First note from the check.";
const LATER_NOTE = "A later note from the check.";
const FAR_CELL = "Far corner";
const WIDE_TABLE = [
  `| ${Array.from({ length: 9 }, (_, i) => `Column ${i + 1} heading`).join(" | ")} |`,
  `| ${Array.from({ length: 9 }, () => "---").join(" | ")} |`,
  `| ${Array.from({ length: 9 }, (_, i) => (i === 8 ? "Last near" : `A long value in column ${i + 1}`)).join(" | ")} |`,
  `| ${Array.from({ length: 9 }, (_, i) => (i === 8 ? FAR_CELL : `Another long value ${i + 1}`)).join(" | ")} |`,
].join("\n");
const LONG_MESSAGE = "This line repeats to make a message longer than a block may be. ".repeat(60);
const HIDDEN_LINK_TEXT = "the quarterly report on heating costs";
const HIDDEN_LINK = `[${HIDDEN_LINK_TEXT}](https://example.com/report)`;
/** An address on the person's own network, built from its parts (test/addresses.test.ts). */
const ROUTER = [192, 168, 1, 1].join(".");
const LOCAL_LINE = `Check [the router's settings](http://${ROUTER}/) first.`;
/** A host with a Cyrillic letter in place of a Latin "a", and its ASCII form. */
const LOOKALIKE_HOST = { written: "b\u0430nk.example", ascii: "xn--bnk-6cd.example" };
const LOOKALIKE_HOST_LINE = `Then sign in at https://${LOOKALIKE_HOST.written}/login.`;
const MAIL_LINE = "Write [to the team](mailto:someone@example.com) for a copy.";
/**
 * What follows a link's text, as a pattern: a space and its words in parentheses, which the app
 * isolates left to right (U+2066 to U+2069). The driver may or may not report the marks.
 */
const beside = (words: string) => ` \\u2066?\\(${words}\\)\\u2069?`;
let browserUrl = "";
/** The listener's GETs by path, and whether each carried a credential. */
const browserGets = new Map<string, { hasAuthorization: boolean; hasCookie: boolean }>();
let browserRequests = 0;
/** A link on the listener whose text differs from its address only in the path's case. */
const lookalike = () => ({
  text: browserUrl.replace("/clawtrate-link-check", "/Notes"),
  url: browserUrl.replace("/clawtrate-link-check", "/notes"),
});
const browser = createServer((req, res) => {
  browserRequests += 1;
  if (req.method === "GET" && (req.url === "/clawtrate-link-check" || req.url === "/notes")) {
    browserGets.set(req.url, {
      hasAuthorization: req.headers.authorization !== undefined,
      hasCookie: req.headers.cookie !== undefined,
    });
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Clawtrate link check");
});
const switcherProbe = new WebSocketServer({ server: browser });
const SAFARI = "com.apple.mobilesafari";

beforeAll(async () => {
  started = Date.now();
  proxy = new Proxy(Number(new URL(env.gateway).port));
  gateway = await proxy.start();
  five = await protocolFiveGateway();
  echo = await echoingGateway();
  await new Promise<void>((resolve, reject) => {
    browser.once("error", reject);
    browser.listen(0, "127.0.0.1", resolve);
  });
  const address = browser.address();
  if (!address || typeof address === "string") throw new Error("No browser fixture address");
  browserUrl = `http://127.0.0.1:${address.port}/clawtrate-link-check`;
  // The reading check needs a stamp ten minutes after its first message: the
  // first is stored now, and the rest after the pairing checks.
  reading = await gatewayTask("main", "Reading check");
  await inject(reading.key, FIRST_NOTE);
  firstNoteAt = await storedAt(reading.key, FIRST_NOTE);
});

afterAll(async () => {
  for (const socket of switcherProbe.clients) socket.terminate();
  await new Promise<void>((resolve) => switcherProbe.close(() => resolve()));
  textSize("large");
  await proxy?.stop();
  await five?.close();
  await echo?.close();
  browser.closeAllConnections();
  await new Promise<void>((resolve) => browser.close(() => resolve()));
});

// A run without the pairing check (one of CI's jobs, jobs.ts) pairs first, as that check does.
beforeEach(async ({ task }) => {
  if (!deviceId && !startsOnItsOwn(task.name)) await pairedSession();
}, 15 * 60_000);
// A check that set the app up itself leaves it on another gateway, with a new identity: the next
// check pairs again. The pairing check alone ends in the paired session.
afterEach(({ task }) => {
  if (startsOnItsOwn(task.name) && !task.name.startsWith(PAIRING)) deviceId = "";
});

describe("the iOS app", () => {
  it("F-001 F-009 F-263: on iPhone, the first screen is the welcome with the mark, the tagline and Connect a gateway; an empty address, a gateway nobody answers and one on another protocol each get the desktop's words and a way on, and Retry repeats only the handshake", async () => {
    launch({
      fresh: true,
      devGateway: gateway,
      switcherProbePort: Number(new URL(browserUrl).port),
    });
    await steps("welcome", [
      waitFor({ id: "welcome" }),
      see({ id: "mark" }),
      see(lit(PRODUCT_NAME)),
      see(lit(SLOGAN)),
      see(lit(CONNECT_WORDS.hint)),
      see({ id: "connect-a-gateway", text: lit(CONNECT_WORDS.connect) }),
      // One action: nothing saved to reconnect to, nothing else to press.
      notSee({ id: "reconnect-saved" }),
      notSee({ id: "connect-button" }),
    ]);
    // The creatures stand at the foot, on a screen tall enough for them.
    expect(await creaturesAtFoot("welcome")).toBe(true);
    await shoot("welcome");
    await steps("address", [
      tap({ id: "connect-a-gateway" }),
      waitFor({ id: "address-field" }, 20_000),
      see({ id: "token-field" }),
      see({ id: "connect-button", text: lit(CONNECT_WORDS.connect) }),
      notSee({ id: "cleartext" }),
    ]);
    await shoot("address");
    // An unencrypted address off this device is named before connecting, and not refused.
    await steps("cleartext", [
      typeInto("address-field", "ws://192.0.2.10:18789"),
      waitFor(
        { id: "cleartext", text: lit(`${CLEARTEXT_WORDS.title}. ${CLEARTEXT_WORDS.body}`) },
        10_000,
      ),
      see({ id: "connect-button", enabled: true }),
    ]);
    await shoot("address-cleartext");
    await steps("empty-address", [
      tap({ id: "address-field" }),
      { eraseText: 80 },
      waitGone({ id: "cleartext" }, 10_000),
      // The keyboard's Go key submits the form, as Connect does.
      { pressKey: "Enter" },
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

    // A gateway that answers with everything the app sent: the token is never shown.
    await steps("echoing", [
      ...anotherGateway(),
      ...typeAddress(echo.url, env.token),
      waitFor(
        { id: "connect-error-message", text: `.*${lit('"token":"[credential]"')}.*` },
        90_000,
      ),
      notSee(`.*${lit(env.token)}.*`),
    ]);
    await shoot("credential-scrubbed");

    await steps("another-protocol", [
      ...anotherGateway(),
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
    // Retry repeats the handshake, and only the handshake.
    const before = five.methods.length;
    await steps("protocol-retry", [tap({ id: "protocol-retry" })]);
    await until("a second handshake", async () => five.methods.length > before);
    await steps("still-protocol", [waitFor({ id: "protocol-notice" }, 60_000)]);
    expect(five.methods.length).toBeGreaterThanOrEqual(2);
    expect(new Set(five.methods)).toEqual(new Set(["connect"]));
    await steps("choose-another", [
      tap({ id: "choose-another" }),
      waitFor({ id: "address-field" }, 20_000),
    ]);
    // Nothing the app logged holds the token the echoing gateway sent back.
    expect(appLog(Math.ceil((Date.now() - started) / 1000) + 30)).not.toContain(env.token);
  });

  it("F-002 F-003 F-009: on iPhone, a read-only pairing lists the read scope this device signed with the dev tool's approve command to copy, an expired request and a rejected one are no longer pending, and approval opens Home by itself", async () => {
    await steps("connect", typeAddress(gateway, env.token));
    const first = await until("the app's pairing request", async () =>
      (await devices()).pending.find((request) => request.displayName === "Clawtrate iPhone"),
    );
    // The gateway was asked for read access and nothing more.
    expect(first.scopes).toEqual(["operator.read"]);
    deviceId = first.deviceId!;
    const command = `pnpm dev-gateway approve --instance ${env.instance}`;
    // From the top down; on a screen shorter than the list (iPhone Duo folded) the
    // steps scroll to what they look at, and on an iPhone nothing needs to scroll.
    await steps("pairing", [
      waitFor({ id: "pairing" }, 90_000),
      see(lit(CONNECT_WORDS.approveTitle)),
      see({ id: "mark", text: PRODUCT_NAME }),
      see({ id: "approve-command", text: lit(command) }),
      notSee(".*openclaw devices approve.*"),
      tap({ id: "copy-command" }),
      waitFor({ id: "copy-status", text: lit(CONNECT_WORDS.copied) }, 30_000),
      scrollTo({ id: "setup-step-0", text: lit(`Connected to ${hostOf(gateway)}`) }, "DOWN"),
      scrollTo({ id: "setup-step-1", text: `${lit(CONNECT_WORDS.waiting)}.*` }, "DOWN"),
      scrollTo({ id: "setup-step-2", text: "Load bots" }, "DOWN"),
      scrollTo(
        { id: "scope-operator.read", text: lit("Read bots, tasks and conversations") },
        "DOWN",
      ),
      notSee({ id: "scope-operator.write" }),
      notSee({ id: "scope-operator.approvals" }),
      notSee({ id: "scope-operator.questions" }),
      notSee({ id: "scope-operator.admin" }),
      // The gateway's echo is what this device signed: nothing to point out.
      notSee({ id: "scopes-differ" }),
      scrollTo(
        {
          id: "connect-foot",
          text: `Request ${first.requestId!.slice(0, 8)} · this device ${deviceId.slice(0, 8)} · .*`,
        },
        "DOWN",
      ),
    ]);
    expect(pasteboard()).toBe(command);
    await shoot("pairing");
    await steps("pairing-foot", ["scroll", "scroll"]);
    expect(await creaturesAtFoot("pairing")).toBe(true);
    await steps("pairing-top", [
      scrollTo({ id: "mark" }, "UP"),
      see({ id: "copy-status", text: lit(CONNECT_WORDS.copied) }),
    ]);

    // Expiry: nothing reaches the gateway, so nothing refreshes the request, and
    // the gateway lets it go. Back in reach, the app is told of another request.
    await proxy.cut();
    await until(
      "the pending request to expire",
      async () => !(await devices()).pending.some((r) => r.requestId === first.requestId),
      9 * 60_000,
    );
    await proxy.restore();
    await steps("expired", [
      waitFor(
        { id: "connect-error-title", text: "The pairing request is no longer pending" },
        180_000,
      ),
      see({
        id: "connect-error-message",
        text: `${lit("It was rejected, or it expired before anyone approved it; the gateway does not say which.")}.*`,
      }),
    ]);
    await shoot("pairing-ended");
    // A new request says only that approval is needed, not that the device is new.
    const lede = see(lit(pairingLede(gateway)));
    await steps("after-expiry", [
      tap({ id: "try-again" }),
      waitFor({ id: "pairing" }, 90_000),
      lede,
    ]);
    const second = await until("a new pairing request", async () =>
      (await devices()).pending.find(
        (r) => r.displayName === "Clawtrate iPhone" && r.requestId !== first.requestId,
      ),
    );

    // The gateway's owner rejects it: the app can say only that it is no longer pending.
    await openclaw(["devices", "reject", second.requestId!]);
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
      lede,
      waitGone({ id: "connect-foot", text: `Request ${second.requestId!.slice(0, 8)} .*` }, 30_000),
    ]);
    const third = await until("a third pairing request", async () =>
      (await devices()).pending.find(
        (r) =>
          r.displayName === "Clawtrate iPhone" &&
          r.requestId !== first.requestId &&
          r.requestId !== second.requestId,
      ),
    );
    expect(third.scopes).toEqual(["operator.read"]);
    expect(third.deviceId).toBe(deviceId);

    devGateway("approve");
    await steps("opens-home", [
      waitFor({ id: "home" }, 120_000),
      waitFor({ id: "bot-pip" }, 60_000),
    ]);
    const paired = (await devices()).paired.find((d) => d.deviceId === deviceId);
    expect(paired?.scopes).toEqual(["operator.read"]);
  });

  // Registered only when `pnpm mobile:check` runs on an iPhone Duo (CLAWTRATE_IOS_DEVICE_TYPE),
  // never on the run's usual iPhone; see docs/development/ios.md.
  if (process.env.CLAWTRATE_IOS_FORM === "duo") {
    it("on iPhone Duo folded, the outer display keeps the phone's layout: Home, a bot's tasks and a task's chat each fill the screen inside its safe area, one at a time, clear of the clock and camera at its side, and Back goes from the chat to the bot's tasks and on to Home", async () => {
      // Folded: the outer display is the one in use, and the inner one is off.
      const [outer, inner] = displays().sort((a, b) => a.width * a.height - b.width * b.height);
      expect(outer?.active).toBe(true);
      expect(inner?.active).toBe(false);
      expect(inner?.on).toBe(false);
      // The app found the hinge, and only ever measured the outer display's compact window.
      const seen = measuredWindows(Math.ceil((Date.now() - started) / 1000) + 30);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.at(-1)).toMatchObject({ hinge: true, sizeClass: "compact" });
      expect(seen.every((w) => w.sizeClass === "compact")).toBe(true);
      const { width, safe } = seen.at(-1)!;
      expect(Math.abs(width - outer!.width)).toBeLessThanOrEqual(1);
      // The outer display keeps its clock and camera at a side, not along the top.
      expect(safe.left + safe.right).toBeGreaterThan(0);
      /** The element spans the window between its side safe areas, as a screen spans an iPhone. */
      const fills = async (id: string) => {
        const box = (await layout()).get(id)?.[0];
        expect(box, id).toBeDefined();
        expect(Math.abs(box!.x1 - safe.left), id).toBeLessThanOrEqual(1);
        expect(Math.abs(box!.x2 - (width - safe.right)), id).toBeLessThanOrEqual(1);
      };
      await steps("duo-folded-home", [waitFor({ id: "home" }, 30_000), notSee({ id: "no-chat" })]);
      await fills("home");
      await shoot("duo-folded-home");
      await steps("duo-folded-bot", [
        tap({ id: "bot-otto" }),
        waitFor({ id: "bot-tasks-otto" }, 20_000),
        notSee({ id: "no-chat" }),
      ]);
      await fills("bot-tasks-otto");
      await shoot("duo-folded-bot-tasks");
      await steps("duo-folded-chat", [
        tap({ id: `task-${lit("agent:otto:disk-space")}` }),
        waitFor({ id: "turn-bot" }, 60_000),
        notSee({ id: "bot-tasks-otto" }),
        see({ id: "back", text: "Back to Otto's tasks" }),
      ]);
      await fills("transcript");
      await shoot("duo-folded-chat");
      await steps("duo-folded-back", [
        tap({ id: "back", text: "Back to Otto's tasks" }),
        waitFor({ id: "bot-tasks-otto" }, 20_000),
        tap({ id: "back", text: "Back to bots" }),
        waitFor({ id: "home" }, 20_000),
      ]);
    });
  }

  it("on iPhone, the app switcher shows the privacy cover after leaving Home", async () => {
    // The app switcher's picture of the app is the cover: the background and the mark.
    const left = Date.now();
    await steps("to-home-screen", [{ pressKey: "home" }]);
    expectSwitcherCover(await switcherSnapshot(left));
    activate();
    await steps("back-in-front", [waitFor({ id: "home" }, 30_000)]);
  });

  it("on iPhone, the app switcher covers Settings while JavaScript is blocked", async () => {
    await steps("settings-before-block", [
      waitFor({ id: "home" }, 30_000),
      tap({ id: "settings-button" }),
      waitFor({ id: "settings" }, 20_000),
      see({ id: "gateway-address", text: lit(addressWords(gateway)) }),
    ]);

    // The newest socket: the app opens another when one closes while it is away.
    const js = await until("the Simulator JS probe", async () => [...switcherProbe.clients].at(-1));
    let blocked: { startedAt: number; unblockAt: number } | undefined;
    let resumed = false;
    js.on("message", (message) => {
      const text = String(message);
      if (text === "resumed") resumed = true;
      else blocked = JSON.parse(text) as typeof blocked;
    });
    js.send("block");
    const { startedAt, unblockAt } = await until("the JS callback to block", async () => blocked);
    const backgroundedAt = Date.now();
    expect(backgroundedAt).toBeGreaterThanOrEqual(startedAt);
    openSystemSettings();
    const snapshot = await switcherSnapshot(backgroundedAt);
    expect(snapshot.savedAt).toBeLessThan(unblockAt);
    expectSwitcherCover(snapshot);

    activate();
    const resumeTimeout = Math.max(0, unblockAt - Date.now()) + 30_000;
    await until("the blocked JS callback to return", async () => resumed || null, resumeTimeout);
    await steps("settings-after-block", [
      waitFor({ id: "settings" }, 20_000),
      see({ id: "gateway-address", text: lit(addressWords(gateway)) }),
      tap({ id: "settings-close" }),
      waitFor({ id: "home" }, 20_000),
    ]);
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
          see({ id: `bot-time-${agent.id}`, text: ".+" }),
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
    // The app refreshes its display clock every 30 seconds. If the capture
    // straddles midnight, the hierarchy can show either day's wording.
    const earliestClock = Date.now() - 30_000;
    const positions = await layout();
    const latestClock = Date.now();
    // Each row's latest line and time are its newest task's.
    for (const agent of agents) {
      const newest = rows
        .filter((r) => r.agentId === agent.id)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]!;
      expect(newest.updatedAt).toBeTypeOf("number");
      const expectedTimes = [earliestClock, latestClock].map((now) =>
        rowTime(newest.updatedAt ?? null, now).replace(/\s+/g, " "),
      );
      const time = positions.get(`bot-time-${agent.id}`)?.[0]?.text.replace(/\s+/g, " ");
      expect(expectedTimes, `latest activity for ${agent.id}`).toContain(time);
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
    // The star as the design draws it (decisions.md): a 16-point disc in the
    // inverse fill at the avatar's lower right, the star in the inverse text.
    const row = positions.get(`bot-${defaultId}`)![0]!;
    const star = positions
      .get("primary-star")!
      .find((b) => b.x1 >= row.x1 && b.x2 <= row.x2 + 4 && b.y1 >= row.y1 && b.y2 <= row.y2 + 4)!;
    expect(star.x2 - star.x1).toBeGreaterThanOrEqual(15);
    expect(star.x2 - star.x1).toBeLessThanOrEqual(17);
    const avatarRight = row.x1 + 10 + 44;
    const rowMiddle = (row.y1 + row.y2) / 2;
    expect(Math.abs(star.x2 - (avatarRight + 2))).toBeLessThanOrEqual(2);
    expect(star.y1).toBeGreaterThan(rowMiddle);
    const pixel = screen(positions.get("home")![0]!.x2);
    expect(near(pixel(star.x1 + 8, star.y1 + 7.7), rgb(LIGHT["text-inverse"]), 12)).toBe(true);
    expect(near(pixel(star.x1 + 8, star.y1 + 13.8), rgb(LIGHT["bg-inverse"]), 12)).toBe(true);
    await shoot("home");
  });

  it("F-427: on iPhone, tapping a bot opens its task list, tapping a task opens its chat, Back returns to the task list, and Back again returns to Home, for a bot with one task as for one with many", async () => {
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
      see({ id: "task-line", text: "Disk almost full on the media box" }),
      tap({ id: "back", text: "Back to Otto's tasks" }),
      waitFor({ id: "bot-tasks-otto" }, 20_000),
      tap({ id: "back", text: "Back to bots" }),
      waitFor({ id: "home" }, 20_000),
    ]);

    // A bot left with one task: its other tasks archived on the gateway.
    const { agents, defaultId } = await gatewayCall<{
      agents: Array<{ id: string; name?: string; identity?: { name?: string } }>;
      defaultId: string;
    }>("agents.list", {});
    const rows = await sessions();
    const count = (id: string) => rows.filter((r) => r.agentId === id).length;
    const single = agents
      .filter((a) => !["otto", "marlow", defaultId].includes(a.id) && count(a.id) > 0)
      .sort((a, b) => count(a.id) - count(b.id))[0]!;
    const tasks = rows
      .filter((r) => r.agentId === single.id)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    for (const row of tasks.slice(1))
      await gatewayCall("sessions.patch", {
        key: row.key,
        archived: true,
        expectedSessionId: row.sessionId,
      });
    const only = tasks[0]!;
    const name = single.identity?.name ?? single.name ?? single.id;
    await steps("single-task", [
      waitFor({ id: `bot-${single.id}`, text: `${lit(name)}, (.+, )?1 task(, .+)?` }, 60_000),
      tap({ id: `bot-${single.id}` }),
      waitFor({ id: `bot-tasks-${single.id}` }, 20_000),
      see({ id: `task-${lit(only.key)}` }),
      tap({ id: `task-${lit(only.key)}` }),
      waitFor({ id: "transcript" }, 20_000),
      see({ id: "title-pill", text: lit(name) }),
      tap({ id: "back", text: lit(`Back to ${name}'s tasks`) }),
      waitFor({ id: `bot-tasks-${single.id}` }, 20_000),
      see({ id: `task-${lit(only.key)}` }),
      tap({ id: "back", text: "Back to bots" }),
      waitFor({ id: "home" }, 20_000),
    ]);
  });

  it("F-063 F-065: on iPhone, a task's chat opens on its title under the header band, puts a stamp before the first message and after a pause, shows your messages and the bot's as bubbles with the bot's markdown and tables that scroll sideways, and each action as one line in the engine's words", async () => {
    await steps("read-disk", [
      tap({ id: "bot-otto" }),
      waitFor({ id: "bot-tasks-otto" }, 20_000),
      tap({ id: `task-${lit("agent:otto:disk-space")}` }),
      waitFor({ id: "turn-bot" }, 60_000),
      // Opened at its start: the title is in view without scrolling.
      see({ id: "task-line", text: "Disk almost full on the media box" }),
      see({ id: "stamp", text: "Today \\d{1,2}:\\d{2}.(AM|PM)", below: { id: "task-line" } }),
      see(`${lit("The media box says the disk is 94% full. What is eating the space?")}`),
      // The markdown is drawn, not shown as marks.
      notSee(".*\\*\\*.*"),
      // One read-only explanation, where the composer will be.
      see({ id: "read-only", text: lit(`Read-only. You can follow Otto's work here.`) + ".*" }),
      see({ id: "jump-to-latest" }),
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
    // One read-only line, under the transcript.
    expect(at.get("read-only")).toHaveLength(1);
    expect(at.get("read-only")![0]!.y1).toBeGreaterThanOrEqual(view.y2 - 1);

    // The status strip comes over the transcript under the header band, and moves nothing.
    const line = at.get("task-line")![0]!;
    await proxy.cut();
    await steps("strip-over", [waitFor({ id: "status-strip" }, 60_000)]);
    const cut = await layout();
    const strip = cut.get("status-strip")![0]!;
    expect(cut.get("task-line")![0]!.y1).toBe(line.y1);
    expect(strip.y1).toBeGreaterThanOrEqual(view.y1);
    expect(strip.y2).toBeLessThanOrEqual(line.y1 + 2);
    await shoot("transcript-strip");
    await proxy.restore();
    // The app reconnects on its own; nothing is tapped that reconnecting takes away.
    await steps("strip-gone", [
      waitGone({ id: "status-strip" }, 120_000),
      tap({ id: "jump-to-latest" }),
      waitGone({ id: "jump-to-latest" }, 20_000),
      scrollTo({ text: "Read AGENTS\\.md.*", id: "action-line" }, "UP"),
      tap({ id: "back" }),
      waitFor({ id: "bot-tasks-otto" }, 20_000),
      tap({ id: "back" }),
      waitFor({ id: "home" }, 20_000),
    ]);

    // The check's own task: a pause of ten minutes since its first message, then
    // a wide table, a long message, links, and the token in the bot's words.
    const wait = firstNoteAt + 10 * 60_000 + 30_000 - Date.now();
    if (wait > 0) await pause(wait);
    for (const message of [
      LATER_NOTE,
      WIDE_TABLE,
      LONG_MESSAGE,
      HIDDEN_LINK,
      LOCAL_LINE,
      LOOKALIKE_HOST_LINE,
      MAIL_LINE,
      `The setup token was ${env.token}.`,
      // Its text names its path in another case, so its host shows beside it. The driver
      // matches text in any case, so the text is not the bare address below.
      `[${lookalike().text}](${lookalike().url})`,
      browserUrl,
    ])
      await inject(reading.key, message);
    // What a link shows beside its text is part of the link's own text. The listener is on
    // loopback, so each link to it says "this iPhone" there.
    const hiddenText = `${lit(HIDDEN_LINK_TEXT)}${beside("example\\.com")}`;
    const browserText = `${lit(browserUrl)}${beside("this iPhone")}`;
    const laterAt = await storedAt(reading.key, LATER_NOTE);
    expect(laterAt - firstNoteAt).toBeGreaterThan(10 * 60_000);
    await steps("read-own", [
      tap({ id: "bot-main" }),
      waitFor({ id: "bot-tasks-main" }, 20_000),
      tap({ id: `task-${lit(reading.key)}` }),
      waitFor({ id: "task-line", text: lit(reading.title) }, 60_000),
      see({ id: "stamp", text: stampPattern(firstNoteAt) }),
      see(lit(FIRST_NOTE)),
      // Jump to latest goes to the end, and goes.
      tap({ id: "jump-to-latest", text: `${lit(CONVERSATION_WORDS.jumpToLatest)}.*` }),
      waitFor(browserText, 20_000),
      waitGone({ id: "jump-to-latest" }, 20_000),
      scrollTo({ text: lit(LATER_NOTE) }, "UP"),
      see({ id: "stamp", text: stampPattern(laterAt) }),
      // The wide table: its far cell is beyond the bubble until the table is swiped.
      {
        scrollUntilVisible: {
          element: { id: "md-table" },
          direction: "DOWN",
          timeout: 30_000,
          visibilityPercentage: 90,
        },
      },
      notSee(lit(FAR_CELL)),
      {
        repeat: {
          while: { notVisible: lit(FAR_CELL) },
          // A swipe moves the table about a column; the far cell is in the ninth.
          times: 20,
          commands: [{ swipe: { from: { id: "md-table" }, direction: "LEFT", duration: 600 } }],
        },
      },
      see(lit(FAR_CELL)),
    ]);
    await shoot("transcript-table");
    await steps("read-own-rest", [
      // The long message was cut, by the engine to its bound or by the gateway, and says so.
      scrollTo(
        {
          id: "shortened-note",
          text: `(${lit(CONVERSATION_WORDS.shortened)}|${lit(CONVERSATION_WORDS.truncated)})`,
        },
        "DOWN",
      ),
      // A link whose text is not its address names the host beside it, as part of the link.
      scrollTo({ text: hiddenText }, "DOWN"),
    ]);
    // Touch and hold shows the full address, with Copy, and opens nothing. The link's own
    // words start the paragraph, which may wrap.
    await steps("hidden-link", [
      await transcriptLinkTap(new RegExp(`^${hiddenText}$`), "hold"),
      waitFor(lit(LINK_WORDS.outside), 10_000),
      see(lit("https://example.com/report")),
    ]);
    await shoot("transcript-link-address");
    await steps("hidden-link-copy", [
      tap(lit(LINK_WORDS.copy)),
      waitGone(lit(LINK_WORDS.outside), 10_000),
      see({ id: "transcript" }),
    ]);
    expect(pasteboard()).toBe("https://example.com/report");
    await steps("local-links", [
      // A link to the person's own network says so beside its host, and a look-alike host
      // shows in ASCII, even where the address is the text.
      scrollTo({ text: `Then sign in at .*${beside(lit(LOOKALIKE_HOST.ascii))}\\.` }, "DOWN"),
      see({ text: `Check the router's settings${beside(`${lit(ROUTER)}, your network`)} first\\.` }),
    ]);
    await shoot("transcript-links");
    const lookalikeText = `${lit(lookalike().text)}${beside(`${lit(new URL(browserUrl).host)}, this iPhone`)}`;
    await steps("not-links", [
      // A mailto address is its text: a tap does nothing, and touch and hold shows no address.
      scrollTo({ text: lit("Write to the team for a copy.") }, "DOWN"),
      tap({ text: lit("Write to the team for a copy.") }),
      { longPressOn: { text: lit("Write to the team for a copy.") } },
      notSee(lit(LINK_WORDS.outside)),
      see({ id: "transcript" }),
      // The token the bot repeated is not shown.
      scrollTo({ text: lit("The setup token was •••.") }, "DOWN"),
      notSee(`.*${lit(env.token)}.*`),
      // Swipe the last two messages above the read-only footer.
      "scroll",
      waitGone({ id: "jump-to-latest" }, 20_000),
      see({ text: lookalikeText }),
      see(browserText),
    ]);
    // Nothing so far, touch and hold included, has opened a link or reached the listener.
    expect(browserRequests).toBe(0);
    expect(running(SAFARI)).toBe(false);
    // A link whose text is another address opens at once in the system browser: the system
    // starts Safari, which was not running before, and the listener gets its GET. The system
    // says so; the driver is not asked about a screen while Safari starts.
    await steps("open-hidden-link", [await transcriptLinkTap(new RegExp(`^${lookalikeText}$`))]);
    await until("Safari to launch", async () => running(SAFARI), 90_000);
    const hidden = await until(
      "Safari's loopback GET for the link whose text is another address",
      async () => browserGets.get("/notes"),
      90_000,
    );
    expect(hidden).toEqual({ hasAuthorization: false, hasCookie: false });
    activate();
    await steps("back-for-plain", [waitFor({ id: "transcript" }, 30_000), see(browserText)]);
    // An address written as itself opens at once the same way.
    await steps("open-link", [await transcriptLinkTap(new RegExp(`^${browserText}$`))]);
    const request = await until(
      "Safari's loopback GET",
      async () => browserGets.get("/clawtrate-link-check"),
      90_000,
    );
    expect(request).toEqual({ hasAuthorization: false, hasCookie: false });
    // Back from the browser, the app is where it was.
    activate();
    await steps("back-from-browser", [
      waitFor({ id: "transcript" }, 30_000),
      // Where it was: at the end of the task, the link it opened in view.
      see(browserText),
      tap({ id: "back" }),
      waitFor({ id: "bot-tasks-main" }, 20_000),
      tap({ id: "back" }),
      waitFor({ id: "home" }, 20_000),
    ]);
    expect(appLog(Math.ceil((Date.now() - started) / 1000) + 30)).not.toContain(env.token);
  });

  it("F-020 F-323: on iPhone, a run started on the gateway shows its bot working on Home, its avatar moving, and in its open chat what it writes; disconnected, the chat says so; quit while a run goes on, the app opened again shows it running, then how it ended", async () => {
    const { key, title } = await gatewayTask("marlow", "Anything new");
    const startRun = () => {
      const release = holdStreamCompletion(key);
      onTestFinished(release);
      const finished = runOnGateway("marlow", key, "#stream 20");
      void finished.catch(() => {}); // Await the result after the UI checks, even if it fails early.
      return { finished, release };
    };
    const first = startRun();
    // The gateway runs this task (another of Marlow's may run too, on its own).
    await until("the check's run on the gateway", async () =>
      (await sessions()).find((r) => r.key === key && (r.hasActiveRun || r.status === "running")),
    );
    await steps("working", [
      waitFor({ id: "bot-marlow", text: "Marlow, working, .*" }, 90_000),
      see({ id: "state-working", childOf: { id: "bot-marlow" } }),
      see({ id: "avatar-working", childOf: { id: "bot-marlow" } }),
      see({ id: "bot-time-marlow", text: "now" }),
    ]);
    // The working avatar moves: frames of its place on screen differ.
    const home = await layout();
    const row = home.get("bot-marlow")![0]!;
    const avatar = home
      .get("avatar-working")!
      .find((b) => b.y1 >= row.y1 - 4 && b.y2 <= row.y2 + 4 && b.x1 >= row.x1)!;
    expect(await moves(avatar, home.get("home")![0]!.x2)).toBe(true);
    await steps("open-run", [
      tap({ id: "bot-marlow" }),
      waitFor({ id: `task-${lit(key)}`, text: `${lit(title)}, working` }, 30_000),
      see({ id: "state-working", childOf: { id: `task-${lit(key)}` } }),
      tap({ id: `task-${lit(key)}` }),
      // The task opens at its start, the streaming reply already longer than the
      // screen: its text is there, and Jump to latest carries the run's phrase.
      waitFor("Here is a long answer, streamed slowly\\..*", 60_000),
      // Text streams with no tool call: the bot is writing, not thinking.
      waitFor({ id: "jump-to-latest", text: "Writing\\. Jump to latest" }, 60_000),
      tap({ id: "jump-to-latest" }),
      waitFor({ id: "running-text", text: "Writing" }, 30_000),
      see({ id: "running-dot-live" }),
    ]);
    await shoot("running");

    // Disconnected by the person while the run goes on: the chat says so, in the off colour.
    await steps("disconnect-during-run", [
      tap({ id: "back" }),
      waitFor({ id: `task-${lit(key)}` }, 20_000),
      tap({ id: "back" }),
      waitFor({ id: "home" }, 20_000),
      tap({ id: "settings-button" }),
      waitFor({ id: "settings" }, 20_000),
      tap({ id: "disconnect" }),
      waitFor({ id: "gateway-state-text", text: "Disconnected" }, 30_000),
      tap({ id: "settings-close" }),
      waitFor({ id: "home" }, 20_000),
      notSee({ id: "connection-dot-connected" }),
      see({ id: "connection-dot-disconnected" }),
      tap({ id: "bot-marlow" }),
      waitFor({ id: `task-${lit(key)}` }, 30_000),
      tap({ id: `task-${lit(key)}` }),
      // Reopened offline, nothing is loaded; the line still says what was last seen.
      waitFor({ id: "running-text", text: "Disconnected\\. Last seen .*" }, 30_000),
      see({ id: "running-dot-off" }),
      notSee({ id: "running-dot-live" }),
      see({ id: "status-strip-text", text: "Disconnected.*" }),
    ]);
    await shoot("running-disconnected");
    await steps("reconnect-during-run", [
      tap({ id: "status-strip-action", text: "Reconnect" }),
      waitGone({ id: "status-strip" }, 120_000),
      // The restored transcript puts the live indicator after the reply, below the fold.
      scrollTo({ id: "running-dot-live" }, "DOWN"),
    ]);
    first.release();
    await steps("run-finished", [
      waitGone({ id: "running" }, 240_000),
      // The reply's history has landed.
      {
        scrollUntilVisible: {
          element: { text: "Here is a long answer, streamed slowly\\..*" },
          direction: "UP",
          timeout: 60_000,
        },
      },
    ]);
    await first.finished;

    // Quit while the next run goes on.
    const second = startRun();
    await until("the check's second run on the gateway", async () =>
      (await sessions()).find((r) => r.key === key && (r.hasActiveRun || r.status === "running")),
    );
    quit();
    // Closing the app stopped nothing: the gateway still runs it.
    const after = (await sessions()).find((r) => r.key === key);
    expect(after?.hasActiveRun || after?.status === "running").toBe(true);
    launch({ devGateway: gateway });
    await steps("reopened", [
      waitFor({ id: "bot-marlow", text: "Marlow, working, .*" }, 90_000),
      tap({ id: "bot-marlow" }),
      waitFor({ id: `task-${lit(key)}`, text: `${lit(title)}, working` }, 30_000),
      tap({ id: `task-${lit(key)}` }),
      { scrollUntilVisible: { element: { id: "running" }, direction: "DOWN", timeout: 60_000 } },
    ]);
    second.release();
    await steps("reopened-run-finished", [
      waitGone({ id: "running" }, 300_000),
      tap({ id: "back" }),
      waitFor({ id: `task-${lit(key)}` }),
      notSee({ id: `task-${lit(key)}`, text: `${lit(title)}, working` }),
      tap({ id: "back" }),
      waitFor({ id: "home" }),
    ]);
    await second.finished;
  });

  it("on iPhone, a dropped connection keeps Home on screen and says it is reconnecting, with Retry now; once the gateway is back the app reconnects by itself and the strip goes", async () => {
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
    // A long backoff cannot reach a new attempt within this wait on its own.
    // Retry now resets the backoff even though the gateway stays out of reach.
    await steps("retry-while-cut", [
      waitFor({ id: "status-strip-text", text: "Reconnecting in (?:1[2-9]|[2-9][0-9])s.*" }),
      tap({ id: "status-strip-action", text: "Retry now" }),
      waitFor({ id: "status-strip-text", text: "Reconnecting(?:…| in [12]s).*" }, 4_000),
      see({ id: "bot-otto" }),
    ]);
    await proxy.restore();
    // The app reconnects on its own schedule; nothing is tapped that reconnecting takes away.
    await steps("returns", [
      waitFor({ id: "connection-dot-connected" }, 120_000),
      waitGone({ id: "status-strip" }, 60_000),
      see({ id: "bot-otto" }),
    ]);
  });

  it("on iPhone at the largest text size, a bot's name and a task's title stay whole, and the time moves to a line of its own", async () => {
    textSize("accessibility-extra-extra-extra-large");
    try {
      await steps("largest-home", [
        waitFor({ id: "home" }),
        // At this size Otto's row may be below the fold.
        scrollTo({ id: "bot-name-otto" }, "DOWN"),
      ]);
      // Wait for the rows to take the new size: Otto's time under its name.
      await until("the rows at the largest size", async () => {
        const at = await layout();
        const name = at.get("bot-name-otto")?.[0];
        const time = at.get("bot-time-otto")?.[0];
        return name && time && time.y1 >= name.y2 - 1 ? true : null;
      });
      const home = await layout();
      const ids = [...home.keys()].filter((id) => id.startsWith("bot-name-"));
      let checked = 0;
      for (const id of ids) {
        const bot = id.slice("bot-name-".length);
        const name = home.get(id)![0]!;
        const time = home.get(`bot-time-${bot}`)?.[0];
        if (!time) continue;
        expect(time.y1).toBeGreaterThanOrEqual(name.y2 - 1);
        checked += 1;
      }
      expect(checked).toBeGreaterThanOrEqual(2);
      await shoot("home-largest");
      await steps("largest-tasks", [
        tap({ id: "bot-otto" }),
        waitFor({ id: "bot-tasks-otto" }, 20_000),
        // At this size a task may be below the fold too.
        scrollTo({ id: `task-title-${lit("agent:otto:disk-space")}` }, "DOWN"),
      ]);
      const tasks = await layout();
      const titles = [...tasks.keys()].filter((id) => id.startsWith("task-title-"));
      checked = 0;
      for (const id of titles) {
        const title = tasks.get(id)![0]!;
        const time = tasks.get(`task-time-${id.slice("task-title-".length)}`)?.[0];
        if (!time) continue;
        expect(time.y1).toBeGreaterThanOrEqual(title.y2 - 1);
        checked += 1;
      }
      expect(checked).toBeGreaterThanOrEqual(2);
      await shoot("bot-tasks-largest");
      await steps("normal-size", [tap({ id: "back" }), waitFor({ id: "home" }, 20_000)]);
    } finally {
      // Whatever happened, the checks after this one see the usual size.
      textSize("large");
    }
  });

  it("F-519: on iPhone, on a read-only connection, chats from Discord and Slack stay out of Home and the bot's task list until Settings, Conversation shows them, at once and without reconnecting; the main conversation stays, and the choice is kept when the app opens again", async () => {
    // A bot of the check's own, given chats as Discord and Slack would, as the desktop's
    // check does: an admin `chat.send` may name the channel a turn came from, and with
    // `deliver: false` nothing is sent anywhere. The main task gets a Telegram turn too,
    // so its channel sticks, as with the gateway's default `dmScope: "main"`.
    const admin = await operator("Clawtrate channel chats check", [
      "operator.read",
      "operator.write",
      "operator.admin",
    ]);
    const stamp = Date.now().toString(36);
    const name = `Courier${stamp}`;
    let created: string | null = null;
    onTestFinished(async () => {
      if (created)
        await admin
          .request("agents.delete", { agentId: created, deleteFiles: true })
          .catch(() => {});
      await admin.close();
    });
    const bot = (
      await admin.request<{ agentId: string }>("agents.create", {
        name,
        workspace: workspaceFor(name.toLowerCase()),
        model: "scripted/dev-1",
      })
    ).agentId;
    created = bot;
    const key = {
      main: `agent:${bot}:main`,
      native: `agent:${bot}:ios-native`,
      discord: `agent:${bot}:discord:channel:1234567890`,
      slack: `agent:${bot}:slack:direct:u0123`,
    };
    type Row = {
      key: string;
      updatedAt?: number;
      lastMessagePreview?: string;
      channel?: string;
      isMain?: boolean;
      hasActiveRun?: boolean;
    };
    const rows = async () =>
      (
        await admin.request<{ sessions?: Row[] }>("sessions.list", {
          agentId: bot,
          limit: 50,
          includeLastMessage: true,
        })
      ).sessions ?? [];
    /** A turn in a task, from a channel when one is named, and the end of its run. */
    const turn = async (sessionKey: string, text: string, channel?: { id: string; to: string }) => {
      await admin.send(sessionKey, text, {
        deliver: false,
        ...(channel ? { originatingChannel: channel.id, originatingTo: channel.to } : {}),
      });
      await until(
        `the turn in ${sessionKey} to end`,
        async () => {
          const row = (await rows()).find((each) => each.key === sessionKey);
          return Boolean(row?.lastMessagePreview) && row?.hasActiveRun !== true;
        },
        180_000,
      );
    };
    // Oldest first: the main task, the bot's own task, then the two channel chats.
    await turn(key.main, `Hello from Telegram ${stamp}`, { id: "telegram", to: "telegram:555000" });
    await turn(key.native, `A note of its own ${stamp}`);
    await turn(key.discord, `Status in the server ${stamp}`, {
      id: "discord",
      to: "channel:1234567890",
    });
    await turn(key.slack, `Quick question ${stamp}`, { id: "slack", to: "user:U0123" });
    // Only the Discord chat is unread, so an unread mark can only come from it.
    for (const each of [key.main, key.native, key.slack])
      await admin.request("sessions.patch", { key: each, unread: false });
    await admin.request("sessions.patch", { key: key.discord, unread: true });
    const listed = await rows();
    expect(listed.find((row) => row.key === key.discord)?.channel).toBe("discord");
    expect(listed.find((row) => row.key === key.slack)?.channel).toBe("slack");
    expect(listed.find((row) => row.key === key.main)).toMatchObject({
      isMain: true,
      channel: "telegram",
    });
    /** Home's line for the bot: the preview of the newest of these tasks. */
    const previewOf = (keys: string[]) => {
      const newest = listed
        .filter((row) => keys.includes(row.key))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
      return plainPreview(newest?.lastMessagePreview ?? null)!;
    };
    const own = previewOf([key.main, key.native]);
    const all = previewOf(Object.values(key));
    expect(all).not.toBe(own);
    const { agents } = await admin.request<{
      agents: Array<{ id: string; identity?: { theme?: string } }>;
    }>("agents.list", {});
    const theme = agents.find((agent) => agent.id === bot)?.identity?.theme;
    /** The bot's row on Home, as it is spoken. */
    const spoken = (count: number, unread: boolean) =>
      `${lit(name)}, ${count} tasks${unread ? ", unread" : ""}${theme ? `, ${lit(theme)}` : ""}`;
    const task = (sessionKey: string) => ({ id: `task-${lit(sessionKey)}` });

    const hidden: Step[] = [
      waitFor({ id: `bot-${bot}`, text: spoken(2, false) }, 60_000),
      see({ id: `bot-preview-${bot}`, text: lit(own) }),
      tap({ id: `bot-${bot}` }),
      waitFor({ id: `bot-tasks-${bot}` }, 20_000),
      waitFor({ ...task(key.main), text: "Main.*" }),
      see(task(key.native)),
      notSee(task(key.discord)),
      notSee(task(key.slack)),
      tap({ id: "back", text: "Back to bots" }),
      waitFor({ id: "home" }, 20_000),
    ];
    const shown: Step[] = [
      waitFor({ id: `bot-${bot}`, text: spoken(4, true) }, 60_000),
      see({ id: `bot-preview-${bot}`, text: lit(all) }),
      tap({ id: `bot-${bot}` }),
      waitFor({ id: `bot-tasks-${bot}` }, 20_000),
      waitFor({ ...task(key.discord), text: "Discord chat.*" }),
      see(task(key.slack)),
      see({ ...task(key.main), text: "Main.*" }),
      see(task(key.native)),
      tap({ id: "back", text: "Back to bots" }),
      waitFor({ id: "home" }, 20_000),
    ];
    /** Open Settings, see the switch as it is, and change it when `to` is given. */
    const settings = (on: boolean, to?: boolean): Step[] => [
      tap({ id: "settings-button" }),
      waitFor({ id: "settings" }, 20_000),
      scrollTo({ id: "licenses-open" }, "DOWN"),
      see({ id: "settings-conversation", text: lit(SETTINGS_WORDS.conversation) }),
      see({ id: "channel-chats", text: lit(SETTINGS_WORDS.channelChats), checked: on }),
      see({ id: "channel-chats-note", text: `${lit("Off by default.")} .*` }),
      see({
        id: "channel-chats-note",
        text: `.*${lit("A bot's main conversation always shows.")}.*`,
      }),
      ...(to === undefined || to === on
        ? []
        : [
            tap({ id: "channel-chats" }),
            waitFor({ id: "channel-chats", checked: to }, 20_000),
            notSee({ id: "channel-chats-error" }),
          ]),
      tap({ id: "settings-close" }),
      waitFor({ id: "home" }, 20_000),
    ];

    // Opened again, the app reads the bots, this one among them. Off by default: the chats
    // have arrived and nothing shows them, and the main task stays.
    launch({ devGateway: gateway });
    await steps("channel-chats-hidden", [waitFor({ id: "home" }, 60_000), ...hidden]);
    await steps("channel-chats-settings", [
      tap({ id: "settings-button" }),
      waitFor({ id: "settings" }, 20_000),
      scrollTo({ id: "licenses-open" }, "DOWN"),
      see({ id: "channel-chats", checked: false }),
    ]);
    await shoot("settings-channel-chats");
    await steps("channel-chats-settings-close", [
      tap({ id: "settings-close" }),
      waitFor({ id: "home" }, 20_000),
    ]);

    // Shown, then hidden again: from the rows the app already holds, with no new connection.
    const connections = proxy.connections;
    await steps("channel-chats-show", [...settings(false, true), ...shown]);
    await steps("channel-chats-hide", [...settings(true, false), ...hidden]);
    expect(proxy.connections).toBe(connections);

    // The choice is this device's, kept for the next launch.
    await steps("channel-chats-show-again", [...settings(false, true), ...shown]);
    launch({ devGateway: gateway });
    await steps("channel-chats-kept", [
      waitFor({ id: "home" }, 60_000),
      ...shown,
      ...settings(true, false),
      ...hidden,
    ]);
  });

  it("on iPhone, Settings shows the gateway, this device and the read scope it holds, and the fonts' licenses; a reinstall offers the old gateway as a choice; Disconnect keeps the pairing until Reconnect, and Use another gateway forgets the gateway but keeps the device", async () => {
    await steps("settings", [
      tap({ id: "settings-button" }),
      waitFor({ id: "settings" }, 20_000),
      see({ id: "gateway-address", text: lit(addressWords(gateway)) }),
      // A loopback address is not named as unencrypted.
      notSee({ id: "cleartext" }),
      see({ id: "gateway-state-text", text: "Connected" }),
      see({ id: "granted-scopes", text: "operator\\.read" }),
      see({ id: "gateway-device", text: lit(`Clawtrate iPhone · ${deviceId.slice(0, 8)}`) }),
      scrollTo({ id: "forget-keeps" }, "DOWN"),
      see({
        id: "forget-keeps",
        text: lit(
          "This device keeps its identity and any saved device token. Pairings are managed on the gateway.",
        ),
      }),
      scrollTo({ id: "gateway-address" }, "UP"),
    ]);
    await shoot("settings");
    await steps("licenses", [
      scrollTo({ id: "licenses-open" }, "DOWN"),
      tap({ id: "licenses-open" }),
      waitFor({ id: "licenses" }, 20_000),
      see("Figtree"),
      see("(?s).*SIL OPEN FONT LICENSE Version 1\\.1.*"),
      // Figtree's whole license comes first: five swipes, each taking seconds
      // more on a slow runner.
      scrollTo({ text: "JetBrains Mono" }, "DOWN", 180_000),
    ]);
    await shoot("licenses");
    await steps("licenses-back", [
      tap({ id: "licenses-back" }),
      waitFor({ id: "settings" }, 20_000),
      tap({ id: "settings-close" }),
      waitFor({ id: "home" }, 20_000),
    ]);

    // The words iOS shows when it asks for the local network are the app's own.
    const config = JSON.parse(readFileSync(join(import.meta.dirname, "../app.json"), "utf8")) as {
      expo: { ios: { infoPlist: Record<string, string> } };
    };
    expect(infoPlist("NSLocalNetworkUsageDescription")).toBe(
      config.expo.ios.infoPlist.NSLocalNetworkUsageDescription,
    );

    await steps("disconnect", [
      tap({ id: "settings-button" }),
      waitFor({ id: "settings" }, 20_000),
      tap({ id: "disconnect" }),
      waitFor({ id: "gateway-state-text", text: "Disconnected" }, 30_000),
      see({ id: "reconnect" }),
      tap({ id: "settings-close" }),
      waitFor({ id: "status-strip-text", text: "Disconnected.*" }, 30_000),
      see({ id: "status-strip-action", text: "Reconnect" }),
      see({ id: "connection-dot-disconnected" }),
      see({ id: "bot-otto" }),
    ]);
    // Disconnected keeps the pairing: the gateway still has the device, and Reconnect connects it.
    expect((await devices()).paired.some((d) => d.deviceId === deviceId)).toBe(true);
    await steps("reconnect", [
      tap({ id: "status-strip-action", text: "Reconnect" }),
      waitFor({ id: "connection-dot-connected" }, 60_000),
      waitGone({ id: "status-strip" }, 60_000),
    ]);

    // Deleted and installed again, the app does not walk back into the gateway:
    // it offers it, and the same device reconnects when asked.
    reinstall();
    launch({ devGateway: gateway });
    await steps("reinstalled", [
      waitFor({ id: "welcome" }, 60_000),
      notSee({ id: "home" }),
      see({
        id: "reconnect-saved",
        text: lit(CONNECT_WORDS.reconnectTo(hostOf(gateway))),
      }),
    ]);
    await shoot("reinstalled");
    // Opened a second time before any choice, it still offers and does not reconnect.
    const before = proxy.connections;
    launch({ devGateway: gateway });
    await steps("reinstalled-again", [
      waitFor({ id: "welcome" }, 60_000),
      notSee({ id: "home" }),
      see({
        id: "reconnect-saved",
        text: lit(CONNECT_WORDS.reconnectTo(hostOf(gateway))),
      }),
    ]);
    expect(proxy.connections - before).toBe(0);
    await steps("reconnect-saved", [
      tap({ id: "reconnect-saved" }),
      waitFor({ id: "home" }, 90_000),
      waitFor({ id: "connection-dot-connected" }, 60_000),
    ]);

    await steps("forget", [
      tap({ id: "settings-button" }),
      waitFor({ id: "settings" }, 20_000),
      scrollTo({ id: "forget" }, "DOWN"),
      tap({ id: "forget" }),
      waitFor({ id: "address-field" }, 30_000),
    ]);
    // Opened again, the app remembers no gateway, and is still the same device.
    launch({ devGateway: gateway });
    await steps("forgotten", [
      waitFor({ id: "welcome" }, 60_000),
      notSee({ id: "reconnect-saved" }),
      see({ id: "connect-foot", text: lit(`This device ${deviceId.slice(0, 8)} · iPhone 0.1.0`) }),
    ]);
    // Through the whole session the device asked for nothing but read.
    const listed = await devices();
    expect(listed.paired.find((d) => d.deviceId === deviceId)?.scopes).toEqual(["operator.read"]);
    expect(listed.pending.filter((r) => r.deviceId === deviceId)).toEqual([]);
  });
  it("on iPhone, a paired gateway that repeats both of this device's tokens in its bots, tasks and version shows neither on any screen, in any accessible name, in the app's log or in its files", async () => {
    const since = Date.now();
    const tokens = [env.token, ""];
    const version = "2026.10.6-simulator-echo";
    let echoing = false;
    let echoedVersion = false;
    const upstream = new Set<WebSocket>();
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
    // A loopback relay to the checks' gateway that, once asked, writes both tokens into
    // the server's version, Otto's name and label, and the title of Otto's disk task.
    server.on("connection", (phone) => {
      const gateway = new WebSocket(env.gateway);
      upstream.add(gateway);
      gateway.on("close", () => {
        upstream.delete(gateway);
        phone.close();
      });
      gateway.on("error", () => phone.close());
      phone.on("close", () => gateway.terminate());
      phone.on("error", () => gateway.terminate());
      phone.on("message", (data) => {
        if (gateway.readyState === WebSocket.OPEN) gateway.send(String(data));
        else gateway.once("open", () => gateway.send(String(data)));
      });
      gateway.on("message", (data) => {
        const reply = JSON.parse(String(data)) as EchoFrame;
        const issued = reply.payload?.auth?.deviceToken;
        if (issued) tokens[1] = issued;
        if (echoing && reply.ok) {
          const both = `${tokens[0]} ${tokens[1]}`;
          if (reply.payload?.server) {
            reply.payload.server.version = `${version} ${both}`;
            echoedVersion = true;
          }
          const otto = reply.payload?.agents?.find((agent) => agent.id === "otto");
          if (otto?.identity) {
            otto.identity.name = `Otto ${tokens[0]}`;
            otto.identity.theme = `Echo ${tokens[1]}`;
          }
          const rows = reply.payload?.list?.sessions ?? reply.payload?.sessions;
          const row = rows?.find((item) => item.key === "agent:otto:disk-space");
          if (row) row.label = `Disk ${both}`;
        }
        if (phone.readyState === WebSocket.OPEN) phone.send(JSON.stringify(reply));
      });
    });
    const scan = async () => {
      const text = await screenText();
      return tokens.map((token) => text.includes(token));
    };
    try {
      launch({ fresh: true, devGateway: url });
      await steps("echo-connect", [
        waitFor({ id: "welcome" }),
        tap({ id: "connect-a-gateway" }),
        ...typeAddress(url, env.token),
        waitFor({ id: "pairing" }, 90_000),
      ]);
      devGateway("approve");
      await steps("echo-paired", [waitFor({ id: "bot-otto" }, 120_000)]);
      expect(tokens.every((token) => token !== "")).toBe(true);
      // The gateway starts repeating them; the app reconnects in the same process and reads them.
      echoing = true;
      for (const phone of server.clients) phone.terminate();
      await steps("echo-home", [
        waitFor({ id: "bot-otto", text: `Otto ${lit(REDACTED)}.*` }, 120_000),
      ]);
      expect(await scan()).toEqual([false, false]);
      expect(echoedVersion).toBe(true);
      await steps("echo-settings", [
        tap({ id: "settings-button" }),
        waitFor(
          {
            id: "gateway-version",
            text: `${lit(`OpenClaw ${version} ${REDACTED} ${REDACTED} · protocol `)}\\d+`,
          },
          60_000,
        ),
      ]);
      expect(await scan()).toEqual([false, false]);
      await steps("echo-tasks", [
        tap({ id: "settings-close" }),
        waitFor({ id: "bot-otto" }),
        tap({ id: "bot-otto" }),
        waitFor({ id: "bot-tasks-otto" }),
        waitFor({ id: `task-${lit("agent:otto:disk-space")}` }),
      ]);
      expect(await scan()).toEqual([false, false]);
      await steps("echo-chat", [
        tap({ id: `task-${lit("agent:otto:disk-space")}` }),
        waitFor({ id: "task-line", text: `Disk ${lit(REDACTED)}.*` }, 60_000),
      ]);
      expect(await scan()).toEqual([false, false]);
      const log = appLog(Math.ceil((Date.now() - since) / 1000) + 30);
      expect(tokens.map((token) => log.includes(token))).toEqual([false, false]);
      expect(containerHits(tokens)).toEqual([0, 0]);
    } finally {
      for (const phone of server.clients) phone.terminate();
      for (const socket of upstream) socket.terminate();
      await closeWithin(new Promise<void>((resolve) => server.close(() => resolve())));
    }
  });
  it("on iPhone, a bot whose tasks the gateway failed to send claims no count on Home and says so in its list; sent an empty list, the list says it has none", async () => {
    let mode: "fail" | "empty" = "fail";
    let failed = 0;
    // The app reads a task list the gateway may answer if asked again (an `UNAVAILABLE` with no
    // reason) READ_AGAIN_TRIES more times, then once more on the gateway's next event, which
    // arms no other read: with every task list failing, the count ends there.
    const FAILED_READS = 1 + READ_AGAIN_TRIES + 1;
    const proxy = await relay(env.gateway, {
      // Every task list fails until the switch below, as a gateway that stays unavailable would.
      fromPhone: (frame) => {
        if (mode !== "fail" || frame.method !== "sessions.subscribe" || !frame.id) return null;
        failed += 1;
        return {
          type: "res",
          id: frame.id,
          ok: false,
          error: { code: "UNAVAILABLE", message: "The task list is not available" },
        };
      },
      // Afterwards, every task list the gateway sends is empty.
      fromGateway: (frame, method) => {
        if (mode !== "empty" || !frame.ok || !frame.payload) return;
        if (method === "sessions.subscribe")
          frame.payload.list = { ...(frame.payload.list as object), sessions: [], hasMore: false };
        if (method === "sessions.list")
          Object.assign(frame.payload, { sessions: [], hasMore: false });
      },
    });
    try {
      launch({ fresh: true, devGateway: proxy.url });
      await steps("tasks-fail-connect", [
        waitFor({ id: "welcome" }),
        tap({ id: "connect-a-gateway" }),
        ...typeAddress(proxy.url, env.token),
        waitFor({ id: "pairing" }, 90_000),
      ]);
      devGateway("approve");
      // The tries take about 15 seconds before the failure shows; the wait covers them.
      await steps("tasks-failed-home", [
        waitFor({ id: "bot-otto", text: "Otto" }, 120_000),
        waitFor({ id: "bot-preview-otto", text: lit(TASKS_FAILED) }, 120_000),
        notSee(".*, 0 tasks.*"),
      ]);
      // The gateway's next event (a tick comes at least every 30 seconds) makes the last read.
      await until("the next event's read", async () => failed >= FAILED_READS, 90_000);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(failed).toBe(FAILED_READS);
      await steps("tasks-failed-home-after", [
        see({ id: "bot-preview-otto", text: lit(TASKS_FAILED) }),
        notSee(".*, 0 tasks.*"),
      ]);
      await steps("tasks-failed-list", [
        tap({ id: "bot-otto" }),
        waitFor({ id: "bot-tasks-otto" }),
        see(lit(TASKS_FAILED)),
        notSee(lit(TASK_WORDS.loading)),
        notSee(lit(TASK_WORDS.none)),
      ]);
      // Connected again, the gateway sends the list, and it is empty.
      mode = "empty";
      proxy.drop();
      await steps("tasks-empty-list", [
        waitFor({ id: "bot-tasks-otto" }),
        waitFor(lit(TASK_WORDS.none), 120_000),
        see(lit(noTasksBody("Otto"))),
        notSee(lit(TASKS_FAILED)),
      ]);
      // Nothing failed after the switch.
      expect(failed).toBe(FAILED_READS);
    } finally {
      await proxy.close();
    }
  });
  it("on iPhone, a long bot name, a long pinned name and a long task title are whole in each row's and tile's accessible name, and at the largest text size each takes more than one line", async () => {
    const LONG_BOT = "Otto, the caretaker of the media box, the backups and the certificates";
    const LONG_PIN = "Pip, the planner of weekend trips, errands and dinners";
    const LONG_TITLE = "Disk almost full on the media box, and the backup drive is filling up too";
    const DISK = "agent:otto:disk-space";
    const BACKUP = "agent:otto:backup-check";
    // Short names in the same places, each one line at any size: the controls.
    const names: Record<string, string> = {
      otto: LONG_BOT,
      pip: LONG_PIN,
      main: "Jo",
      marlow: "Mo",
    };
    const titles: Record<string, string> = { [DISK]: LONG_TITLE, [BACKUP]: "Log" };
    const proxy = await relay(env.gateway, {
      // Pip and Marlow are pinned, as the gateway would keep it for its user.
      fromPhone: (frame) =>
        frame.method === "users.prefs.get" && frame.id
          ? {
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                status: "ok",
                entries: { "clawtrate.sidebar": { pins: ["pip", "marlow"] } },
              },
            }
          : null,
      fromGateway: (frame, method) => {
        if (!frame.ok || !frame.payload) return;
        if (method === "agents.list")
          for (const agent of (frame.payload.agents ?? []) as Array<{
            id: string;
            identity?: { name?: string };
          }>)
            if (agent.identity && names[agent.id]) agent.identity.name = names[agent.id]!;
        if (method === "sessions.subscribe" || method === "sessions.list") {
          const list = (method === "sessions.list" ? frame.payload : frame.payload.list) as
            { sessions?: Array<{ key: string; label?: string }> } | undefined;
          for (const row of list?.sessions ?? []) if (titles[row.key]) row.label = titles[row.key]!;
        }
      },
    });
    /** Each element's height, and that it holds the whole string. */
    const heightOf = async (id: string, whole: string) => {
      const view = (await layout()).get(id)?.[0];
      expect(view?.text).toBe(whole);
      return view!.y2 - view!.y1;
    };
    try {
      launch({ fresh: true, devGateway: proxy.url });
      await steps("long-connect", [
        waitFor({ id: "welcome" }),
        tap({ id: "connect-a-gateway" }),
        ...typeAddress(proxy.url, env.token),
        waitFor({ id: "pairing" }, 90_000),
      ]);
      devGateway("approve");
      await steps("long-home", [
        waitFor({ id: "pin-pip" }, 120_000),
        scrollTo({ id: "bot-otto" }, "DOWN"),
      ]);
      // At the usual size the accessible names are whole, whatever the rows show.
      const home = await layout();
      expect(home.get("bot-otto")?.[0]?.text.startsWith(`${LONG_BOT}, `)).toBe(true);
      expect(home.get("pin-pip")?.[0]?.text.startsWith(`${LONG_PIN}, `)).toBe(true);
      await steps("long-tasks", [
        tap({ id: "bot-otto" }),
        waitFor({ id: "bot-tasks-otto" }, 20_000),
        waitFor({ id: `task-${lit(DISK)}` }),
      ]);
      const tasks = await layout();
      expect(tasks.get(`task-${DISK}`)?.[0]?.text.startsWith(LONG_TITLE)).toBe(true);
      await shoot("long-tasks");

      textSize("accessibility-extra-extra-extra-large");
      // At the largest size each long text wraps: taller than two lines of its control.
      await steps("long-tasks-largest", [scrollTo({ id: `task-title-${lit(DISK)}` }, "DOWN")]);
      await until("the task rows at the largest size", async () => {
        const at = await layout();
        const title = at.get(`task-title-${DISK}`)?.[0];
        const time = at.get(`task-time-${DISK}`)?.[0];
        return title && time && time.y1 >= title.y2 - 1 ? true : null;
      });
      const title = await heightOf(`task-title-${DISK}`, LONG_TITLE);
      await steps("long-control-title", [scrollTo({ id: `task-title-${lit(BACKUP)}` }, "DOWN")]);
      expect(title).toBeGreaterThan(1.8 * (await heightOf(`task-title-${BACKUP}`, "Log")));
      await shoot("long-tasks-largest");
      await steps("long-home-largest", [
        tap({ id: "back" }),
        waitFor({ id: "home" }, 20_000),
        // The long pinned name can be taller than the screen: its short neighbour brings the
        // row of tiles into view, and the layout reads both.
        scrollTo({ id: "pin-name-marlow" }, "UP"),
      ]);
      const pin = await heightOf("pin-name-pip", LONG_PIN);
      expect(pin).toBeGreaterThan(1.8 * (await heightOf("pin-name-marlow", "Mo")));
      // The long name may be taller than the screen: in view in part is enough to read it.
      await steps("long-row-largest", [
        {
          scrollUntilVisible: {
            element: { id: "bot-name-otto" },
            direction: "DOWN",
            timeout: 30_000,
            visibilityPercentage: 10,
          },
        },
      ]);
      const name = await heightOf("bot-name-otto", LONG_BOT);
      await steps("long-control-row", [scrollTo({ id: "bot-name-main" }, "DOWN")]);
      expect(name).toBeGreaterThan(1.8 * (await heightOf("bot-name-main", "Jo")));
      await shoot("home-long-largest");
    } finally {
      textSize("large");
      await proxy.close();
    }
  });

  it("F-017: on iPhone, Home draws each bot as its creature from the shared spec, or its own picture in a circle, and a working creature moves unless Reduce Motion is on", async () => {
    const photoColor = "#c71fd5";
    const photo = `data:image/png;base64,${encodePng({
      width: 2,
      height: 2,
      data: Uint8Array.from(Array.from({ length: 4 }, () => [...rgb(photoColor), 255]).flat()),
    }).toString("base64")}`;
    const shellfolk = firstChoice("shellfolk", "orchid");
    const lantern = firstChoice("lantern", "sky");
    const pictures = new Map([
      ["otto", pictureWithChoice(photo, shellfolk)!],
      ["pip", pictureWithChoice(photo, lantern)!],
      ["marlow", photo],
    ]);
    let chosen = false;
    const avatarGateway = await relay(env.gateway, {
      fromGateway: (frame, method) => {
        if (!chosen || method !== "agents.list" || !frame.ok) return;
        for (const agent of (frame.payload?.agents ?? []) as Array<{
          id: string;
          identity?: { name?: string; avatarUrl?: string };
        }>) {
          const avatarUrl = pictures.get(agent.id);
          if (avatarUrl && agent.identity) {
            agent.identity.avatarUrl = avatarUrl;
            agent.identity.name += " (avatar check)";
          }
        }
      },
    });
    try {
      launch({ fresh: true, devGateway: avatarGateway.url });
      await steps("avatars-welcome", [waitFor({ id: "welcome" })]);
      await shoot("avatars-welcome");
      await steps("avatars-connect", [
        tap({ id: "connect-a-gateway" }),
        ...typeAddress(avatarGateway.url, env.token),
        waitFor({ id: "pairing" }, 90_000),
      ]);
      devGateway("approve");
      await steps("avatars-home", [
        waitFor({ id: "bot-main" }, 120_000),
        see({ id: "primary-star", childOf: { id: "bot-main" } }),
        // The bots probed below are at rest, so each is drawn in its idle pose.
        ...["main", "otto", "pip"].map((id) =>
          notSee({ id: "state-.*", childOf: { id: `bot-${id}` } }),
        ),
      ]);
      await shoot("avatars-home");

      // Map points inside the shared scene to the Home row's avatar.
      const side = TOUCH.avatarRow;
      const avatarBounds = (positions: Awaited<ReturnType<typeof layout>>, id: string) => {
        const row = positions.get(`bot-${id}`)![0]!;
        return [row.x1 + 10, (row.y1 + row.y2 - side) / 2] as const;
      };
      const expectPaint = (
        positions: Awaited<ReturnType<typeof layout>>,
        read: ReturnType<typeof screen>,
        id: string,
        choice: AvatarChoice,
        probes: Array<[x: number, y: number, paint: string]>,
      ) => {
        const { fit, shift } = avatarScene(choice, "idle", avatarVariation(id));
        const [x0, y0] = avatarBounds(positions, id);
        for (const [x, y, paint] of probes) {
          const actual = read(
            x0 + ((20 + shift[0] + (x - 20) * fit) * side) / 40,
            y0 + ((20 + shift[1] + (y - 20) * fit) * side) / 40,
          );
          expect(near(actual, rgb(paint)), `${id} at scene point (${x}, ${y}): ${actual}`).toBe(
            true,
          );
        }
      };
      let positions = await layout();
      let read = screen(positions.get("home")![0]!.x2);
      const clawling = defaultAvatar("main");
      // The body, its single raised stalk, and the open space beside it.
      expectPaint(positions, read, "main", clawling, [
        [25, 28, AVATAR_COLORS[clawling.color]],
        [20, 17, AVATAR_COLORS[clawling.color]],
        [9, 15, LIGHT.bg],
      ]);

      chosen = true;
      avatarGateway.drop();
      await steps("avatars-updated", [
        waitFor({ id: "bot-name-otto", text: lit("Otto (avatar check)") }, 120_000),
        see({ id: "bot-name-pip", text: lit("Pip (avatar check)") }),
        see({ id: "bot-name-marlow", text: lit("Marlow (avatar check)") }),
      ]);
      await shoot("avatars-choices");
      positions = await layout();
      read = screen(positions.get("home")![0]!.x2);
      // A cream foot and the shell. The marked PNG itself is a solid square.
      expectPaint(positions, read, "otto", shellfolk, [
        [21, 33, SHELLFOLK_CREAM],
        [32, 21, AVATAR_COLORS.orchid],
      ]);
      expectPaint(positions, read, "pip", lantern, [
        [20, 32, AVATAR_COLORS.sky],
        [30.6, 10.2, AVATAR_BALL],
      ]);
      const [x, y] = avatarBounds(positions, "marlow");
      expect(near(read(x + side / 2, y + side / 2), rgb(photoColor))).toBe(true);
      expect(near(read(x + 1, y + 1), rgb(LIGHT.bg))).toBe(true);

      // While Pip works its Lantern conducts with its lure; with Reduce Motion
      // on it holds the pose still, the lure upright as at rest.
      const { key } = await gatewayTask("pip", "Avatar motion");
      const release = holdStreamCompletion(key);
      onTestFinished(release);
      const finished = runOnGateway("pip", key, "#stream 20");
      void finished.catch(() => {}); // Awaited after the checks, even if it fails early.
      const working = async (name: string) => {
        await steps(name, [
          waitFor({ id: "bot-pip", text: `${lit("Pip (avatar check)")}, working, .*` }, 90_000),
          see({ id: "avatar-working", childOf: { id: "bot-pip" } }),
        ]);
        const shown = await layout();
        const [left, top] = avatarBounds(shown, "pip");
        const wide = shown.get("home")![0]!.x2;
        return { shown, wide, region: { x1: left, y1: top, x2: left + side, y2: top + side } };
      };
      const moving = await working("avatar-moving");
      expect(await moves(moving.region, moving.wide)).toBe(true);
      reduceMotion(true);
      onTestFinished(() => reduceMotion(false));
      launch({ devGateway: avatarGateway.url });
      const still = await working("avatar-still");
      expect(await moves(still.region, still.wide)).toBe(false);
      expectPaint(still.shown, screen(still.wide), "pip", lantern, [[30.6, 10.2, AVATAR_BALL]]);
      release();
      await finished;
    } finally {
      await avatarGateway.close();
    }
  });

  it("F-557: on iPhone, a picture you sent from another device shows in your message when the gateway's address is protected, read back with this device's token in one header and no cookie, and a redirect isn't followed; at a loopback ws:// address the message says this connection can't load it and nothing is asked for", async () => {
    // Pictures of the check's own, sent with a message as another device sends them.
    const solid = (rgb: [number, number, number]) =>
      encodePng({
        width: 360,
        height: 240,
        data: Uint8Array.from({ length: 360 * 240 * 4 }, (_, i) =>
          i % 4 === 3 ? 255 : rgb[i % 4]!,
        ),
      });
    const SHOT_RGB: [number, number, number] = [38, 110, 196];
    const shot = solid(SHOT_RGB);
    const words = "Here is the shelf I mentioned.";
    const own = await gatewayTask("pip", "Picture check");
    // Everything made from here on is released at the end, whatever fails.
    let loopback: Proxy | null = null;
    let front: Awaited<ReturnType<typeof protectedFront>> | null = null;
    try {
      await gatewayCall("chat.send", {
        sessionKey: own.key,
        message: words,
        idempotencyKey: `ios-picture-${Date.now().toString(36)}`,
        queueMode: "followup",
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            fileName: "shot.png",
            content: shot.toString("base64"),
          },
          {
            type: "image",
            mimeType: "image/png",
            fileName: "moved.png",
            content: solid([200, 120, 40]).toString("base64"),
          },
        ],
      });
      await until("the message's files in history", async () => {
        const history = await gatewayCall<{ messages?: unknown[] }>("chat.history", {
          sessionKey: own.key,
          limit: 20,
        });
        const text = JSON.stringify(history.messages ?? []);
        return text.includes("media://inbound/shot") && text.includes("media://inbound/moved");
      });
      const lineFor = (name: string) =>
        `${lit(name)}, \\d+ KB\\. ${lit(SENT_PICTURE_LINES["cannot-load"])}`;
      const openTask = (name: string): Step[] => [
        waitFor({ id: "bot-pip" }, 120_000),
        tap({ id: "bot-pip" }),
        waitFor({ id: `task-${lit(own.key)}` }, 60_000),
        tap({ id: `task-${lit(own.key)}` }),
        waitFor(lit(words), 60_000),
        // The message's files under it, the last one in view.
        scrollTo({ id: "sent-picture", text: name }, "DOWN"),
      ];

      // At a loopback ws:// address: each picture says this connection can't load it.
      loopback = new Proxy(Number(new URL(env.gateway).port));
      const nearUrl = await loopback.start();
      const gatewayPort = Number(new URL(env.gateway).port);
      const media = (url: string) => url.startsWith(INBOUND_MEDIA_ROUTE);
      front = await protectedFront(gatewayPort, (url) =>
        media(url.pathname) && url.searchParams.get("source")?.startsWith("media://inbound/moved")
          ? { status: 302, headers: { location: "/elsewhere" } }
          : null,
      );
      launch({ fresh: true, devGateway: nearUrl });
      await steps("picture-near-connect", [
        waitFor({ id: "welcome" }),
        tap({ id: "connect-a-gateway" }),
        ...typeAddress(nearUrl, env.token),
        waitFor({ id: "pairing" }, 90_000),
      ]);
      devGateway("approve");
      await steps("picture-near", [
        ...openTask(lineFor("moved.png")),
        see({ id: "sent-picture", text: lineFor("shot.png") }),
        see({ id: "sent-picture", text: lineFor("moved.png") }),
        notSee({
          id: "sent-picture",
          text: lit(
            sentPictureAlt({ fileName: "shot.png", mimeType: "image/png", sizeBytes: null }),
          ),
        }),
      ]);
      await shoot("sent-picture-loopback");
      // Every connection the app made there opened its gateway socket: nothing else was asked.
      expect(loopback.requests.length).toBeGreaterThan(0);
      expect(loopback.requests.filter((request) => !request.upgrade)).toEqual([]);

      // At a protected address, a new device of this gateway: the picture is read back and drawn.
      const alt = sentPictureAlt({ fileName: "shot.png", mimeType: "image/png", sizeBytes: null });
      launch({ fresh: true, devGateway: front.url });
      await steps("picture-far-connect", [
        waitFor({ id: "welcome" }),
        tap({ id: "connect-a-gateway" }),
        ...typeAddress(front.url, env.token),
        waitFor({ id: "pairing" }, 90_000),
      ]);
      devGateway("approve");
      await steps("picture-far", [
        ...openTask(lineFor("moved.png")),
        waitFor({ id: "sent-picture", text: lit(alt) }, 60_000),
        see({ id: "sent-picture", text: lineFor("moved.png") }),
      ]);
      await shoot("sent-picture-protected");
      // The exact picture sent, drawn from the bytes the gateway gave.
      const at = await layout();
      const box = at.get("sent-picture")!.find((each) => each.text === alt)!;
      const pixel = screen(at.get("transcript")![0]!.x2);
      expect(near(pixel((box.x1 + box.x2) / 2, (box.y1 + box.y2) / 2), SHOT_RGB, 10)).toBe(true);

      // The gateway was asked only on its media route, by GET, with no cookie, although each
      // answer set one. The ticket requests carry this device's token in their one header, the
      // bytes request none, and no address carries it. The redirect was not followed.
      const asked = front.requests;
      expect(asked.every((request) => request.method === "GET" && media(request.url))).toBe(true);
      expect(asked.map((request) => request.cookie)).toEqual(asked.map(() => undefined));
      const ticketFor = (name: string) =>
        asked.filter((request) => {
          const query = new URL(request.url, "https://front").searchParams;
          return (
            query.get("meta") === "1" && query.get("source")!.startsWith(`media://inbound/${name}`)
          );
        });
      const bytes = asked.filter(
        (request) => new URL(request.url, "https://front").searchParams.get("meta") !== "1",
      );
      expect(ticketFor("shot")).toHaveLength(1);
      expect(ticketFor("moved")).toHaveLength(1);
      expect(bytes).toHaveLength(1);
      expect(bytes[0]!.url).toContain(encodeURIComponent("media://inbound/shot"));
      // Each ticket request, the redirected one too, carries one Authorization field with the
      // token the gateway issued this device; the bytes request carries none. The token is
      // compared here and never printed, and no address holds it, raw or decoded.
      const issued = front.issued();
      expect(issued !== null && issued.length > 8).toBe(true);
      const tickets = [...ticketFor("shot"), ...ticketFor("moved")];
      expect(tickets.map((request) => request.authorizations)).toEqual([1, 1]);
      expect(tickets.every((request) => request.authorization === `Bearer ${issued}`)).toBe(true);
      expect(bytes[0]!.authorizations).toBe(0);
      const holds = (request: FrontRequest) =>
        request.url.includes(issued!) ||
        [...new URL(request.url, "https://front").searchParams].some(
          ([name, value]) => name.includes(issued!) || value.includes(issued!),
        );
      expect(asked.some(holds)).toBe(false);
      expect(asked.some((request) => request.url.startsWith("/elsewhere"))).toBe(false);

      // A tap opens it larger, as on the desktop, and Close brings the chat back.
      await steps("picture-larger", [
        tap({ id: "sent-picture", text: lit(alt) }),
        waitFor({ id: "picture-viewer-close" }, 20_000),
        see({ text: lit(alt) }),
      ]);
      await shoot("sent-picture-larger");
      await steps("picture-larger-closed", [
        tap({ id: "picture-viewer-close" }),
        waitGone({ id: "picture-viewer-close" }, 20_000),
        see({ id: "sent-picture", text: lit(alt) }),
      ]);
    } finally {
      await loopback?.stop();
      await front?.close();
      await gatewayCall("sessions.delete", { key: own.key, deleteTranscript: true }).catch(
        () => {},
      );
    }
  });
});

/** A gateway frame, as far as the echoing relay reads and changes it. */
type EchoFrame = {
  ok?: boolean;
  payload?: {
    auth?: { deviceToken?: string };
    server?: { version: string };
    agents?: Array<{ id: string; identity?: { name?: string; theme?: string } }>;
    sessions?: Array<{ key: string; label?: string }>;
    list?: { sessions?: Array<{ key: string; label?: string }> };
  };
};

/** From a failure on the address screen, or a step list, back to an empty form. */
function anotherGateway(): Step[] {
  return [
    {
      runFlow: {
        // On the step list it is under the error, below the foot of a short screen.
        when: { visible: { id: "setup" } },
        commands: [scrollTo({ id: "use-another" }, "DOWN"), tap({ id: "use-another" })],
      },
    },
  ];
}

/**
 * Pair the app read-only through the check's proxy and open Home, where the pairing check leaves
 * it, for a run that leaves that check out. The gateway's owner approves with the dev tool.
 */
async function pairedSession(): Promise<void> {
  launch({
    fresh: true,
    devGateway: gateway,
    switcherProbePort: Number(new URL(browserUrl).port),
  });
  await steps("session-connect", [
    waitFor({ id: "welcome" }),
    tap({ id: "connect-a-gateway" }),
    ...typeAddress(gateway, env.token),
    waitFor({ id: "pairing" }, 90_000),
  ]);
  const request = await until("the app's pairing request", async () =>
    (await devices()).pending.find((r) => r.displayName === "Clawtrate iPhone"),
  );
  expect(request.scopes).toEqual(["operator.read"]);
  devGateway("approve");
  await steps("session-home", [
    waitFor({ id: "home" }, 120_000),
    waitFor({ id: "bot-pip" }, 60_000),
  ]);
  deviceId = request.deviceId!;
}

/**
 * Type a gateway's address and token, each confirmed in its field, and connect
 * with the keyboard's Go key. iOS offers to save what a secure field held; the
 * app gives it nothing to offer, so no sheet comes, and the check would fail
 * rather than dismiss one.
 */
function typeAddress(url: string, token: string): Step[] {
  return [
    waitFor({ id: "address-field" }, 30_000),
    typeInto("address-field", url),
    typeInto("token-field", token, { secret: true, from: "address-field" }),
    { pressKey: "Enter" },
    { extendedWaitUntil: { visible: "Save Password\\?", timeout: 5_000, optional: true } },
    notSee("Save Password\\?"),
    notSee("(Not Now|Save Password)"),
  ];
}
