// What the Simulator checks use: the device, the gateway instance and the tools
// `pnpm mobile:check` gives them (scripts/check.ts), Maestro to drive the app,
// the dev tool's own guarded runner for OpenClaw commands, a loopback proxy the
// checks can cut and restore, a gateway that speaks another protocol, and a
// protected address for the gateway.

import { execFile, execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer, Socket, type Server } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import { callGateway, openInstance, openOperator } from "../../../tools/dev-gateway/src/cli.ts";
import { IOS_STREAM_HOLD_FILE, parseJsonOutput } from "../../../tools/dev-gateway/src/env.ts";
import type { OperatorSession } from "../../../tools/dev-gateway/src/operator.ts";
import { decodePng } from "../../../tools/brand/src/png.ts";
import { clockTime } from "../../../packages/ui/src/format.ts";

const run = promisify(execFile);
const REPO = join(import.meta.dirname, "../../..");
const OUTPUT = join(import.meta.dirname, "../build/maestro");

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: run these checks with pnpm mobile:check.`);
  return value;
}

export const env = {
  get device() {
    return need("CLAWTRATE_IOS_DEVICE");
  },
  get bundle() {
    return need("CLAWTRATE_IOS_BUNDLE");
  },
  get instance() {
    return need("CLAWTRATE_IOS_INSTANCE");
  },
  get gateway() {
    return need("CLAWTRATE_IOS_GATEWAY");
  },
  get token() {
    return need("CLAWTRATE_IOS_TOKEN");
  },
};

/** One Maestro command, as its YAML takes it. */
export type Step = Record<string, unknown> | string;

/**
 * Run Maestro commands on the checks' device as one flow. A flow is YAML, and
 * JSON is YAML, so each command is written as JSON. Every wait is for a
 * condition (`extendedWaitUntil`, Maestro's own retrying assertions), never a
 * fixed sleep.
 */
export async function steps(
  name: string,
  commands: Step[],
  options: {
    /** The app the steps look at: Clawtrate unless another one has come forward (Safari). */
    appId?: string;
    /** The whole run's bound, past which the driver is stopped and the steps fail. */
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const dir = join(OUTPUT, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "flow.yaml");
  writeFileSync(
    file,
    `appId: ${options.appId ?? env.bundle}\n---\n${commands.map((c) => `- ${JSON.stringify(c)}`).join("\n")}\n`,
    { mode: 0o600 },
  );
  // The driver's runner is installed once and kept between flows. When it
  // does not start (a loaded machine), that is no result of the app's: the
  // flow is run once more, with the runner installed afresh.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await run(
        need("CLAWTRATE_IOS_MAESTRO"),
        [
          "--device",
          env.device,
          "test",
          attempt === 1 ? "--no-reinstall-driver" : "--reinstall-driver",
          "--debug-output",
          dir,
          file,
        ],
        {
          maxBuffer: 16 * 1024 * 1024,
          // Ten minutes for the driver to start on a loaded machine, and the steps themselves.
          timeout: options.timeoutMs ?? 25 * 60_000,
          killSignal: "SIGKILL",
        },
      );
      return;
    } catch (error) {
      const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
      const output = `${stdout}${stderr}`;
      if (attempt === 1 && DRIVER_DID_NOT_START.test(output)) continue;
      throw new Error(`Steps "${name}" failed:\n${output}${await mistyped(commands, output)}`, {
        cause: error,
      });
    }
  }
}

/** What Maestro says when its runner on the device did not start, before any step ran. */
const DRIVER_DID_NOT_START =
  /iOS driver not ready in time|operation never finished bootstrapping|IOSDriverTimeoutException/;

/** A server's close, bounded: a socket that lingers does not hold the checks. */
export function closeWithin(close: Promise<void>, ms = 5_000): Promise<void> {
  return Promise.race([close, new Promise<void>((resolve) => setTimeout(resolve, ms))]);
}

export type Selector = { id?: string; text?: string; [key: string]: unknown };

/** Regular expression for a literal text: Maestro matches text as a pattern. */
export const lit = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * The stamp of a message stored at `at` within the last day, as a pattern: "Today" or
 * "Yesterday", then its exact time, with any space where the clock has one. Either day word is
 * accepted, because a check can straddle the device's midnight (#640). The message is stored
 * before midnight and looked at after it, and the app redraws its stamps only every 30 s, so near
 * midnight it can show either word. `stampTime`'s own tests pin which word is right.
 */
export const stampPattern = (at: number) =>
  `(?:Today|Yesterday) ${lit(clockTime(at))}`.replace(/\s/g, ".");

export const see = (selector: Selector | string): Step => ({ assertVisible: selector });
export const notSee = (selector: Selector | string): Step => ({ assertNotVisible: selector });
export const tap = (selector: Selector | string): Step => ({ tapOn: selector });
export const waitFor = (selector: Selector | string, ms = 60_000): Step => ({
  extendedWaitUntil: { visible: selector, timeout: ms },
});
export const waitGone = (selector: Selector | string, ms = 60_000): Step => ({
  extendedWaitUntil: { notVisible: selector, timeout: ms },
});
/**
 * Swipe until the element is wholly on screen. Maestro looks before each swipe
 * and stops once `ms` has passed, so a long scroll needs time for every swipe
 * and the settling Maestro waits for before and after it.
 */
export const scrollTo = (selector: Selector, direction: "UP" | "DOWN", ms = 30_000): Step => ({
  scrollUntilVisible: { element: selector, direction, timeout: ms },
});

/** What a `typeInto` step meant to type, for the failure's message. */
type Typing = { field: string; text: string; secret: boolean; label: string };
const typings = new WeakMap<object, Typing>();
/** What a secure field shows of each character, in Maestro's view of the screen. */
const SECURE_DOT = "•";

/**
 * Type a text into a field and confirm the field holds it. On a slow Simulator
 * Maestro can lose characters as it types and still report the text typed
 * (#580), so the field is read back and, while it holds anything else, erased
 * and typed again: four tries at most. If the field never holds it, `steps`
 * fails with what the field holds.
 *
 * A secure field shows one dot for each character, so there the count is
 * confirmed, and the text never appears in Maestro's output. Erasing does
 * nothing in a secure field that has the focus; it clears itself on the first
 * key after it gains the focus, so each try first taps `from`, another field.
 */
export function typeInto(
  field: string,
  text: string,
  secure?: { secret: true; from: string },
): Step {
  const label = secure
    ? `Type ${text.length} secret characters into ${field}`
    : `Type "${text}" into ${field}`;
  const step = {
    retry: {
      maxRetries: 3,
      label,
      commands: [
        ...(secure ? [tap({ id: secure.from })] : []),
        tap({ id: field }),
        { eraseText: 80 },
        { inputText: secure ? { text, label: `Input ${text.length} secret characters` } : text },
        see({ id: field, text: secure ? `${SECURE_DOT}{${text.length}}` : lit(text) }),
      ],
    },
  };
  typings.set(step, { field, text, secret: secure !== undefined, label });
  return step;
}

/** For each `typeInto` step of a flow that failed, what it meant to type and what the field holds. */
async function mistyped(commands: Step[], output: string): Promise<string> {
  const failed = commands.flatMap((command) => {
    const typing = typeof command === "object" ? typings.get(command) : undefined;
    return typing && output.includes(`${typing.label}... FAILED`) ? [typing] : [];
  });
  if (failed.length === 0) return "";
  // A driver that has stopped cannot read the screen; the failure above still stands.
  const held = await fieldTexts().catch(() => null);
  return failed
    .map(({ field, text, secret }) => {
      const meant = secret ? `${text.length} characters` : `"${text}"`;
      const now = held?.get(field);
      if (now === undefined)
        return `\n${field} should hold ${meant}; ${held ? "it is not on screen" : "the screen could not be read"}.`;
      return `\n${field} should hold ${meant} and holds ${secret ? `${now.length} characters` : `"${now}"`}.`;
    })
    .join("");
}

type Node = { attributes?: Record<string, string>; children?: Node[] };
const BOUNDS = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/;

/**
 * Maestro's view of the screen, as JSON text. Like `steps`, a driver that did
 * not start is no result of the app's: it is asked once more, with the runner
 * installed afresh. With `timeoutMs`, a try that takes longer is stopped and fails.
 */
async function hierarchy(timeoutMs?: number): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { stdout } = await run(
        need("CLAWTRATE_IOS_MAESTRO"),
        [
          "--device",
          env.device,
          "hierarchy",
          attempt === 1 ? "--no-reinstall-driver" : "--reinstall-driver",
        ],
        {
          maxBuffer: 64 * 1024 * 1024,
          ...(timeoutMs ? { timeout: timeoutMs, killSignal: "SIGKILL" as const } : {}),
        },
      );
      return stdout;
    } catch (error) {
      const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
      if (attempt === 1 && DRIVER_DID_NOT_START.test(`${stdout}${stderr}`)) continue;
      throw error;
    }
  }
}

/** Where each element with an id is on screen now, in points, from Maestro's view of the app. */
export async function layout(): Promise<
  Map<string, Array<{ x1: number; y1: number; x2: number; y2: number; text: string }>>
> {
  const stdout = await hierarchy();
  const tree = JSON.parse(stdout.slice(stdout.indexOf("{"))) as Node;
  const found = new Map<
    string,
    Array<{ x1: number; y1: number; x2: number; y2: number; text: string }>
  >();
  const walk = (node: Node) => {
    const a = node.attributes ?? {};
    const m = BOUNDS.exec(a.bounds ?? "");
    if (a["resource-id"] && m) {
      const list = found.get(a["resource-id"]) ?? [];
      list.push({
        x1: +m[1]!,
        y1: +m[2]!,
        x2: +m[3]!,
        y2: +m[4]!,
        text: a.accessibilityText ?? "",
      });
      found.set(a["resource-id"], list);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return found;
}

/**
 * The text each element with an id holds now: a field's value, as Maestro reads it.
 * Read only to explain a failure, so a read that stalls is stopped after two
 * minutes rather than hold back the failure it explains.
 */
async function fieldTexts(): Promise<Map<string, string>> {
  const stdout = await hierarchy(2 * 60_000);
  const tree = JSON.parse(stdout.slice(stdout.indexOf("{"))) as Node;
  const found = new Map<string, string>();
  const walk = (node: Node) => {
    const a = node.attributes ?? {};
    if (a["resource-id"] && !found.has(a["resource-id"])) found.set(a["resource-id"], a.text ?? "");
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return found;
}

/**
 * Tap, or touch and hold, a link in the transcript: at its middle, a little into its glyphs from
 * where its lines start. A scroll to it counts the screen under the composer as showing it, so a
 * link that isn't wholly in the scroll view is first dragged into it, slowly so the view doesn't
 * coast past. A link still not wholly in the view fails the step.
 */
export async function transcriptLinkTap(
  pattern: RegExp,
  press: "tap" | "hold" = "tap",
): Promise<Step> {
  type Bounds = { x1: number; y1: number; x2: number; y2: number };
  const locate = async () => {
    const stdout = await hierarchy();
    const tree = JSON.parse(stdout.slice(stdout.indexOf("{"))) as Node;
    const found: { viewport?: Bounds; link?: Bounds } = {};
    const walk = (node: Node) => {
      if (found.viewport && found.link) return;
      const a = node.attributes ?? {};
      const m = BOUNDS.exec(a.bounds ?? "");
      if (m) {
        const bounds = { x1: +m[1]!, y1: +m[2]!, x2: +m[3]!, y2: +m[4]! };
        if (a["resource-id"] === "transcript") found.viewport = bounds;
        if (!found.link && (pattern.test(a.accessibilityText ?? "") || pattern.test(a.text ?? "")))
          found.link = bounds;
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
    const { viewport, link } = found;
    if (!viewport || !link) throw new Error(`Could not locate ${pattern} in the transcript`);
    return { viewport, link };
  };
  let { viewport, link } = await locate();
  for (let drag = 1; drag <= 3; drag += 1) {
    const below = link.y2 - viewport.y2;
    const above = viewport.y1 - link.y1;
    if (below <= 0 && above <= 0) break;
    // How far the content moves up (or down, when negative), with room for the touch to
    // travel before the view starts to scroll, and never more than half the view.
    const half = Math.floor((viewport.y2 - viewport.y1) / 2);
    const by = Math.max(-half, Math.min(half, below > 0 ? below + 32 : -(above + 32)));
    // The drag runs near the view's right edge, beside the bot's bubbles and their links.
    const x = viewport.x2 - 8;
    const middle = Math.floor((viewport.y1 + viewport.y2) / 2);
    await steps(`link-into-view-${drag}`, [
      {
        swipe: {
          start: `${x},${middle + Math.ceil(by / 2)}`,
          end: `${x},${middle - Math.floor(by / 2)}`,
          duration: 1500,
        },
      },
    ]);
    ({ viewport, link } = await locate());
  }
  const x = link.x1 + Math.min(24, Math.floor((link.x2 - link.x1) / 2));
  const y = Math.floor((link.y1 + link.y2) / 2);
  if (
    link.y1 < viewport.y1 ||
    link.y2 > viewport.y2 ||
    link.x1 < viewport.x1 ||
    link.x2 > viewport.x2
  ) {
    throw new Error(
      `Link ${pattern} isn't wholly in the transcript: the link is at ${JSON.stringify(link)}, the transcript's view at ${JSON.stringify(viewport)}`,
    );
  }
  const point = { point: `${x},${y}` };
  return press === "hold" ? { longPressOn: point } : { tapOn: point };
}

/**
 * The screen as pixels: the colour at a point. `pointsWide` is the screen's
 * width in points (the widest element `layout` found), which gives the scale.
 */
export function screen(pointsWide: number): (x: number, y: number) => [number, number, number] {
  const file = join(OUTPUT, "screen.png");
  const shown = screenshot(file);
  const image = decodePng(readFileSync(file));
  // On iPhone Duo the picture is of the display in use, whose width in points is known:
  // there a side safe area can keep every element narrower than the screen.
  const scale = image.width / (shown?.width ?? pointsWide);
  return (x, y) => {
    const i = (Math.round(y * scale) * image.width + Math.round(x * scale)) * 4;
    return [image.data[i]!, image.data[i + 1]!, image.data[i + 2]!];
  };
}

/** A token's colour as RGB, for a hex token. */
export function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Two colours within a few levels of each other per channel. */
export function near(a: number[], b: number[], tolerance = 6): boolean {
  return a.every((value, i) => Math.abs(value - b[i]!) <= tolerance);
}

function simctl(...args: string[]) {
  const result = spawnSync("xcrun", ["simctl", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`simctl ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/**
 * The screen as a PNG. iPhone Duo has two displays, and simctl takes the inner
 * one unless told otherwise, so there the picture is of the display in use.
 */
function screenshot(file: string): Display | null {
  const active =
    process.env.CLAWTRATE_IOS_FORM === "duo" ? (displays().find((d) => d.active) ?? null) : null;
  simctl("io", env.device, "screenshot", ...(active ? [`--display=${active.id}`] : []), file);
  return active;
}

/** What `launch` last started the app with. */
let launchArgs: string[] = [];

/**
 * Start the app, naming the gateway the check runs as the development gateway
 * (so the pairing screen shows the dev tool's approve command). `fresh` first
 * resets the device's Keychain: the app starts with no gateway and a new key.
 */
export function launch(options: {
  fresh?: boolean;
  devGateway: string;
  switcherProbePort?: number;
}) {
  quit();
  if (options.fresh) simctl("keychain", env.device, "reset");
  launchArgs = [
    "-ClawtrateDevGatewayURL",
    options.devGateway,
    "-ClawtrateDevGatewayInstance",
    env.instance,
    ...(options.switcherProbePort === undefined
      ? []
      : ["-ClawtrateSwitcherProbePort", String(options.switcherProbePort)]),
  ];
  simctl("launch", env.device, env.bundle, ...launchArgs);
}

/**
 * Bring the app back to the front, as tapping it again would. A running app
 * only comes forward. One that is no longer running starts with what `launch`
 * gave it, so it can still reach the Simulator probe.
 */
export function activate() {
  simctl("launch", env.device, env.bundle, ...launchArgs);
}

/** Put the app in the background without starting a Maestro flow. */
export function openSystemSettings() {
  simctl("launch", env.device, "com.apple.Preferences");
}

/** Whether an app runs on the device now, from the system's own list of the apps it launched. */
export function running(bundleId: string): boolean {
  return simctl("spawn", env.device, "launchctl", "list").includes(`UIKitApplication:${bundleId}`);
}

/** Delete the app and install it again: iOS removes its data with it, not its Keychain items. */
export function reinstall() {
  quit();
  simctl("uninstall", env.device, env.bundle);
  simctl("install", env.device, need("CLAWTRATE_IOS_APP"));
}

/** What the device's pasteboard holds. */
export function pasteboard(): string {
  return simctl("pbpaste", env.device);
}

/** The system's text size, as Settings, Accessibility, Larger Text sets it. */
export function textSize(size: "large" | "accessibility-extra-extra-extra-large") {
  simctl("ui", env.device, "content_size", size);
}

/**
 * The system's Reduce Motion, as Settings, Accessibility, Motion sets it.
 * Launch the app again afterwards, so it reads the new setting as it starts.
 */
export function reduceMotion(on: boolean) {
  simctl(
    "spawn",
    env.device,
    "defaults",
    "write",
    "com.apple.Accessibility",
    "ReduceMotionEnabled",
    "-bool",
    String(on),
  );
}

/** The built app's Info.plist value for a key. */
export function infoPlist(key: string): string {
  const result = spawnSync(
    "plutil",
    ["-extract", key, "raw", "-o", "-", join(need("CLAWTRATE_IOS_APP"), "Info.plist")],
    {
      encoding: "utf8",
    },
  );
  if (result.status !== 0) throw new Error(`Info.plist has no ${key}`);
  return result.stdout.trim();
}

/**
 * The newest app-switcher snapshot iOS saved in the app's container, as pixels,
 * once one newer than `after` exists. iOS writes it as the app leaves the front.
 */
export async function switcherSnapshot(after: number) {
  const container = simctl("get_app_container", env.device, env.bundle, "data").trim();
  const root = join(container, "Library/SplashBoard/Snapshots");
  const newest = () => {
    const found: Array<{ path: string; time: number }> = [];
    const walk = (dir: string) => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ktx")) found.push({ path, time: statSync(path).mtimeMs });
      }
    };
    walk(root);
    return found.sort((a, b) => b.time - a.time)[0];
  };
  const snapshot = await until("the switcher's snapshot", async () => {
    const latest = newest();
    return latest && latest.time > after ? latest : null;
  });
  const png = join(OUTPUT, "switcher.png");
  const converted = spawnSync("sips", ["-s", "format", "png", snapshot.path, "--out", png], {
    encoding: "utf8",
  });
  if (converted.status !== 0) throw new Error(`Could not read the snapshot: ${converted.stderr}`);
  return { ...decodePng(readFileSync(png)), savedAt: snapshot.time };
}

/**
 * The screen now, whole, as pixels. On iPhone Duo it is the display in use, and
 * `pointsWide` is that display's width in points.
 */
export function frame(): { width: number; data: Uint8Array; pointsWide: number | null } {
  const file = join(OUTPUT, "frame.png");
  const shown = screenshot(file);
  const image = decodePng(readFileSync(file));
  return { width: image.width, data: image.data, pointsWide: shown?.width ?? null };
}

/**
 * Whether a region of the screen changes from frame to frame: frames are taken
 * until one differs from the first within the region, or eight seconds pass.
 * `region` is in points, and `pointsWide` is the screen's width in points.
 */
export async function moves(
  region: { x1: number; y1: number; x2: number; y2: number },
  pointsWide: number,
): Promise<boolean> {
  const crop = ({ width, data, pointsWide: shown }: ReturnType<typeof frame>) => {
    // As in `screen`: a side safe area can keep every element narrower than the display.
    const scale = width / (shown ?? pointsWide);
    const out: number[] = [];
    for (let y = Math.round(region.y1 * scale); y < Math.round(region.y2 * scale); y += 1)
      for (let x = Math.round(region.x1 * scale); x < Math.round(region.x2 * scale); x += 1) {
        const i = (y * width + x) * 4;
        out.push(data[i]!, data[i + 1]!, data[i + 2]!);
      }
    return out;
  };
  const first = crop(frame());
  const end = Date.now() + 8_000;
  while (Date.now() < end) {
    const next = crop(frame());
    if (next.some((value, i) => Math.abs(value - first[i]!) > 24)) return true;
  }
  return false;
}

/** A message the gateway adds to a task as the bot's, with no run (`chat.inject`). */
export async function inject(sessionKey: string, message: string): Promise<void> {
  await gatewayCall("chat.inject", { sessionKey, message });
}

/** Close the app, as the person would. */
export function quit() {
  const result = spawnSync("xcrun", ["simctl", "terminate", env.device, env.bundle], {
    encoding: "utf8",
  });
  // An app that is not running has nothing to close.
  if (result.status !== 0 && !/found nothing to terminate/.test(result.stderr))
    throw new Error(`simctl terminate: ${result.stderr}`);
}

/** An OpenClaw command on the checks' instance, through the dev tool's guarded runner. */
export async function openclaw(args: string[]): Promise<string> {
  const result = await openInstance(env.instance).runner.run(args);
  if (result.status !== 0)
    throw new Error(`openclaw ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

export function gatewayCall<T>(method: string, params: unknown): Promise<T> {
  return callGateway<T>(openInstance(env.instance), method, params);
}

/**
 * A client of the check's own on the instance, paired with the scopes it names. The
 * OpenClaw command asks for the fewest scopes a method needs, and some requests need admin.
 */
export function operator(displayName: string, scopes: string[]): Promise<OperatorSession> {
  return openOperator(openInstance(env.instance), displayName, scopes, []);
}

/** A folder in the instance's own state for a bot's workspace. */
export function workspaceFor(name: string): string {
  return join(openInstance(env.instance).stateDir, "workspaces", name);
}

/** Keep this task's scripted reply open until the check has observed the live run. */
export function holdStreamCompletion(key: string): () => void {
  const path = join(openInstance(env.instance).runDir, IOS_STREAM_HOLD_FILE);
  writeFileSync(path, key, { flag: "wx", mode: 0o600 });
  return () => rmSync(path, { force: true });
}

export type Device = {
  requestId?: string;
  deviceId?: string;
  displayName?: string;
  scopes?: string[];
};

export async function devices(): Promise<{ pending: Device[]; paired: Device[] }> {
  const listed = parseJsonOutput<{ pending?: Device[]; paired?: Device[] }>(
    await openclaw(["devices", "list", "--json"]),
  );
  return { pending: listed.pending ?? [], paired: listed.paired ?? [] };
}

/** `pnpm dev-gateway <command> --instance <the checks' instance>`. */
export function devGateway(command: string) {
  const result = spawnSync(
    process.execPath,
    [join(REPO, "tools/dev-gateway/src/cli.ts"), command, "--instance", env.instance],
    {
      cwd: REPO,
      encoding: "utf8",
    },
  );
  if (result.status !== 0)
    throw new Error(`dev-gateway ${command}: ${result.stdout}${result.stderr}`);
  return result.stdout;
}

/** Wait for a condition on the gateway's side, checked every half second. */
export async function until<T>(
  what: string,
  check: () => Promise<T | null | undefined>,
  ms = 60_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** A loopback TCP proxy to the gateway, which a check cuts (every socket closed, nothing listening) and restores. */
export class Proxy {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  port = 0;
  /** Every connection the app opened through the proxy, since it started. */
  connections = 0;
  /** What each of those connections asked first: its request line, and whether it opened a WebSocket. */
  readonly requests: Array<{ line: string; upgrade: boolean }> = [];
  private readonly target: number;
  constructor(target: number) {
    this.target = target;
  }

  async start(): Promise<string> {
    await this.listen(0);
    return `ws://127.0.0.1:${this.port}`;
  }

  private listen(port: number) {
    const server = createServer((client) => {
      this.connections += 1;
      // Classified once its whole header is in, which may take more than one chunk.
      let head = "";
      const classify = (chunk: Buffer) => {
        head += chunk.toString("latin1");
        const end = head.indexOf("\r\n\r\n");
        if (end < 0 && head.length < 16_384) return;
        client.off("data", classify);
        const header = end < 0 ? head : head.slice(0, end + 2);
        this.requests.push({
          line: header.split("\r\n", 1)[0]!,
          upgrade: /\r\nupgrade:[ \t]*websocket\r\n/i.test(header),
        });
      };
      client.on("data", classify);
      const upstream = new Socket();
      upstream.connect(this.target, "127.0.0.1");
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
        socket.on("error", () => {
          client.destroy();
          upstream.destroy();
        });
      }
      client.pipe(upstream).pipe(client);
    });
    this.server = server;
    return new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        this.port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  }

  /** The connection drops, and the gateway cannot be reached until `restore`. */
  async cut() {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    if (server) await closeWithin(new Promise<void>((resolve) => server.close(() => resolve())));
  }

  async restore() {
    await this.listen(this.port);
  }

  async stop() {
    await this.cut();
  }
}

/** One HTTP request the protected address served, as it arrived. */
export type FrontRequest = {
  method: string;
  url: string;
  authorization: string | undefined;
  /** How many Authorization fields it carried, before Node keeps only the first. */
  authorizations: number;
  cookie: string | undefined;
};

/** This Mac's own address on its network, never loopback: en0's, or the first there is. */
function ownAddress(): string {
  const found = Object.entries(networkInterfaces()).flatMap(([name, list]) =>
    (list ?? [])
      .filter(
        (each) => each.family === "IPv4" && !each.internal && !each.address.startsWith("169.254."),
      )
      .map((each) => ({ name, address: each.address })),
  );
  const chosen = found.find((each) => each.name === "en0") ?? found[0];
  if (!chosen)
    throw new Error("This Mac has no network address but loopback for a protected address.");
  return chosen.address;
}

/**
 * A protected address for the checks' gateway (F-557): `wss://<this Mac's network address>:<port>`,
 * which is `wss://` and not loopback, as the product's rule reads an address. It is a TLS front of
 * the check's own, listening on that address alone and taking connections from this Mac alone.
 * Its certificate comes from a throwaway authority that `openssl` makes in a temporary folder, and
 * only the check's own device trusts it (`simctl keychain add-root-cert`); the device goes with the
 * run. A WebSocket is relayed to the gateway. Each other request is recorded and served by the
 * gateway, with a cookie added to the answer, unless `answer` gives one of its own.
 */
export async function protectedFront(
  gatewayPort: number,
  answer: (url: URL) => { status: number; headers: Record<string, string> } | null = () => null,
): Promise<{
  url: string;
  requests: FrontRequest[];
  /** The device token the gateway last issued over this address, or null. */
  issued: () => string | null;
  close: () => Promise<void>;
}> {
  const address = ownAddress();
  const dir = mkdtempSync(join(tmpdir(), "clawtrate-front-"));
  const file = (name: string) => join(dir, name);
  const openssl = (args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
  openssl([
    ...["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-sha256"],
    ...[
      "-keyout",
      file("ca-key.pem"),
      "-out",
      file("ca.pem"),
      "-subj",
      "/CN=Clawtrate check authority",
    ],
    ...["-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign"],
  ]);
  openssl([
    ...["req", "-newkey", "rsa:2048", "-nodes", "-sha256", "-subj", `/CN=${address}`],
    ...["-keyout", file("key.pem"), "-out", file("request.pem")],
  ]);
  writeFileSync(
    file("leaf.cnf"),
    [
      `subjectAltName=IP:${address}`,
      "extendedKeyUsage=serverAuth",
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
    ].join("\n"),
  );
  openssl([
    ...[
      "x509",
      "-req",
      "-in",
      file("request.pem"),
      "-CA",
      file("ca.pem"),
      "-CAkey",
      file("ca-key.pem"),
    ],
    ...["-set_serial", String(Date.now()), "-days", "1", "-sha256", "-extfile", file("leaf.cnf")],
    ...["-out", file("cert.pem")],
  ]);
  simctl("keychain", env.device, "add-root-cert", file("ca.pem"));

  const requests: FrontRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createHttpsServer(
    { key: readFileSync(file("key.pem")), cert: readFileSync(file("cert.pem")) },
    (req, res) => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        authorizations: req.rawHeaders.filter(
          (field, i) => i % 2 === 0 && field.toLowerCase() === "authorization",
        ).length,
        cookie: req.headers.cookie,
      });
      const own = answer(new URL(req.url ?? "/", `https://${address}`));
      if (own) return void res.writeHead(own.status, own.headers).end();
      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port: gatewayPort,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (reply) => {
          res.writeHead(reply.statusCode ?? 502, {
            ...reply.headers,
            "set-cookie": "clawtrate-front=1; Path=/; Secure; HttpOnly",
          });
          reply.pipe(res);
        },
      );
      upstream.on("error", () => res.destroy());
      req.pipe(upstream);
    },
  );
  // The gateway socket is relayed frame by frame, as `relay` does, to keep the device token the
  // gateway issues in its `hello-ok`: the token a ticket request must carry.
  const issued: string[] = [];
  const relays = new Set<WebSocket>();
  const phones = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket: Socket, head: Buffer) => {
    phones.handleUpgrade(req, socket, head, (phone) => {
      const gateway = new WebSocket(`ws://127.0.0.1:${gatewayPort}${req.url ?? "/"}`);
      const waiting: string[] = [];
      for (const each of [phone, gateway]) {
        relays.add(each);
        each.on("close", () => relays.delete(each));
      }
      gateway.on("open", () => {
        for (const data of waiting.splice(0)) gateway.send(data);
      });
      phone.on("message", (data) => {
        if (gateway.readyState === WebSocket.OPEN) gateway.send(String(data));
        else waiting.push(String(data));
      });
      gateway.on("message", (data) => {
        const text = String(data);
        try {
          const frame = JSON.parse(text) as { payload?: { auth?: { deviceToken?: unknown } } };
          const token = frame.payload?.auth?.deviceToken;
          if (typeof token === "string") issued.push(token);
        } catch {
          // Not a frame of the gateway's protocol: passed on as it is.
        }
        if (phone.readyState === WebSocket.OPEN) phone.send(text);
      });
      gateway.on("close", () => phone.close());
      gateway.on("error", () => phone.terminate());
      phone.on("close", () => gateway.terminate());
      phone.on("error", () => gateway.terminate());
    });
  });
  server.on("connection", (socket: Socket) => {
    if (socket.remoteAddress?.replace(/^::ffff:/, "") !== address) return void socket.destroy();
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, address, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `wss://${address}:${port}`,
    requests,
    issued: () => issued.at(-1) ?? null,
    close: async () => {
      for (const each of relays) each.terminate();
      for (const socket of sockets) socket.destroy();
      await closeWithin(new Promise<void>((resolve) => server.close(() => resolve())));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * What a gateway answers a client offering protocols it does not speak, read
 * from the checks' real gateway: offered protocol 99, it names its own (4).
 */
export async function realMismatchReply(): Promise<{
  challenge: unknown;
  reply: { error?: { details?: Record<string, unknown> } };
}> {
  const socket = new WebSocket(env.gateway);
  return new Promise((resolve, reject) => {
    let challenge: unknown = null;
    socket.onerror = () => reject(new Error("socket error"));
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as { type: string; event?: string; id?: string };
      if (frame.type === "event" && frame.event === "connect.challenge") {
        challenge = frame;
        socket.send(
          JSON.stringify({
            type: "req",
            id: "probe",
            method: "connect",
            params: {
              minProtocol: 99,
              maxProtocol: 99,
              client: { id: "gateway-client", version: "0.0.0", platform: "test", mode: "ui" },
              role: "operator",
              scopes: ["operator.read"],
              caps: [],
            },
          }),
        );
      } else if (frame.type === "res" && frame.id === "probe") {
        socket.close();
        resolve({ challenge, reply: frame as never });
      }
    };
  });
}

/**
 * A gateway on protocol 5: it challenges like the real one and answers every
 * connect with the real gateway's mismatch reply, naming protocol 5, then
 * closes the socket as the real one does (1002).
 */
export async function protocolFiveGateway(): Promise<{
  url: string;
  /** Every request method the app sent, in order: only connects may come. */
  methods: string[];
  close: () => Promise<void>;
}> {
  const methods: string[] = [];
  const { challenge, reply } = await realMismatchReply();
  const details = {
    ...reply.error?.details,
    expectedProtocol: 5,
    clientMinProtocol: 4,
    clientMaxProtocol: 4,
  };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => {
    socket.send(JSON.stringify(challenge));
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as { id?: string; method?: string; type?: string };
      if (frame.type === "req" && frame.method) methods.push(frame.method);
      if (frame.method !== "connect") return;
      socket.send(JSON.stringify({ ...reply, id: frame.id, error: { ...reply.error, details } }));
      socket.close(1002);
    });
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    methods,
    close: () => {
      for (const client of server.clients) client.terminate();
      return closeWithin(new Promise<void>((resolve) => server.close(() => resolve())));
    },
  };
}

/**
 * A gateway that refuses every connect with an error whose message repeats
 * everything the app sent, its credential included, as a hostile or broken
 * gateway could.
 */
export async function echoingGateway(): Promise<{ url: string; close: () => Promise<void> }> {
  const { challenge } = await realMismatchReply();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => {
    socket.send(JSON.stringify(challenge));
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as { id?: string; method?: string; params?: unknown };
      if (frame.method !== "connect") return;
      socket.send(
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: `Refused connect ${JSON.stringify(frame.params)}`,
          },
        }),
      );
      socket.close(1008);
    });
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    close: () => {
      for (const client of server.clients) client.terminate();
      return closeWithin(new Promise<void>((resolve) => server.close(() => resolve())));
    },
  };
}

/** A gateway frame, as far as a relay reads and changes it. */
export type RelayFrame = {
  type?: string;
  id?: string;
  method?: string;
  ok?: boolean;
  payload?: Record<string, unknown>;
  error?: unknown;
};

/**
 * A loopback relay to a gateway. `fromPhone` sees each request the app sends and
 * may answer it itself instead of passing it on; `fromGateway` may change a reply
 * on its way back, knowing the method it answers. `drop` closes the app's
 * sockets, so it connects again.
 */
export async function relay(
  upstream: string,
  hooks: {
    fromPhone?: (frame: RelayFrame) => RelayFrame | null;
    fromGateway?: (frame: RelayFrame, method: string | undefined) => void;
  },
): Promise<{ url: string; drop: () => void; close: () => Promise<void> }> {
  const sockets = new Set<WebSocket>();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  server.on("connection", (phone) => {
    const gateway = new WebSocket(upstream);
    sockets.add(gateway);
    const methods = new Map<string, string>();
    gateway.on("close", () => {
      sockets.delete(gateway);
      phone.close();
    });
    gateway.on("error", () => phone.close());
    phone.on("close", () => gateway.terminate());
    phone.on("error", () => gateway.terminate());
    phone.on("message", (data) => {
      const frame = JSON.parse(String(data)) as RelayFrame;
      const answer = hooks.fromPhone?.(frame) ?? null;
      if (answer) return phone.send(JSON.stringify(answer));
      if (frame.type === "req" && frame.id && frame.method) methods.set(frame.id, frame.method);
      if (gateway.readyState === WebSocket.OPEN) gateway.send(String(data));
      else gateway.once("open", () => gateway.send(String(data)));
    });
    gateway.on("message", (data) => {
      const frame = JSON.parse(String(data)) as RelayFrame;
      hooks.fromGateway?.(frame, frame.id === undefined ? undefined : methods.get(frame.id));
      if (phone.readyState === WebSocket.OPEN) phone.send(JSON.stringify(frame));
    });
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    drop: () => {
      for (const phone of server.clients) phone.terminate();
    },
    close: () => {
      for (const phone of server.clients) phone.terminate();
      for (const socket of sockets) socket.terminate();
      return closeWithin(new Promise<void>((resolve) => server.close(() => resolve())));
    },
  };
}

/** Maestro's whole view of the screen as text: every label and value the app exposes. */
export async function screenText(): Promise<string> {
  return hierarchy();
}

/** How many of the app's own data files hold each needle, as UTF-8 or UTF-16. */
export function containerHits(needles: string[]): number[] {
  const root = simctl("get_app_container", env.device, env.bundle, "data").trim();
  const hits = needles.map(() => 0);
  const visit = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const bytes = readFileSync(path);
        needles.forEach((needle, i) => {
          if (bytes.includes(Buffer.from(needle)) || bytes.includes(Buffer.from(needle, "utf16le")))
            hits[i]! += 1;
        });
      }
    }
  };
  visit(root);
  return hits;
}

/** The folders the app's share step holds in its cache now (`src/host/share.ts`), by name. */
export function sharedFolders(): string[] {
  const data = simctl("get_app_container", env.device, env.bundle, "data").trim();
  try {
    return readdirSync(join(data, "Library", "Caches", "clawtrate-share"));
  } catch {
    return [];
  }
}

/** The app's own log lines since a time, from the device's unified log. */
export function appLog(sinceSeconds: number): string {
  const result = spawnSync(
    "xcrun",
    [
      "simctl",
      "spawn",
      env.device,
      "log",
      "show",
      "--last",
      `${sinceSeconds}s`,
      "--style",
      "compact",
      "--predicate",
      'process == "Clawtrate"',
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`log show: ${result.stderr}`);
  return result.stdout;
}

/** One of the device's built-in displays, as CoreDevice reports it, in points. */
export type Display = {
  id: number;
  name: string;
  active: boolean;
  on: boolean;
  width: number;
  height: number;
};

/**
 * The device's built-in displays and which one is in use. iPhone Duo has two:
 * folded, the outer one is active and the inner one is off.
 */
export function displays(): Display[] {
  mkdirSync(OUTPUT, { recursive: true });
  const file = join(OUTPUT, "displays.json");
  // The JSON output is devicectl's stable one; its text output is not.
  const result = spawnSync(
    "xcrun",
    [
      "devicectl",
      "device",
      "info",
      "displays",
      "--device",
      env.device,
      "--quiet",
      "--json-output",
      file,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`devicectl device info displays: ${result.stderr}`);
  const report = JSON.parse(readFileSync(file, "utf8")) as {
    result: {
      displays: Array<{
        displayId: number;
        name: string;
        active: boolean;
        backlightState: string;
        nativeSize: [number, number];
        pointScale: number;
        type: Record<string, unknown>;
      }>;
    };
  };
  return report.result.displays
    .filter((d) => "integrated" in d.type)
    .map((d) => ({
      id: d.displayId,
      name: d.name,
      active: d.active,
      on: d.backlightState !== "off",
      width: d.nativeSize[0] / d.pointScale,
      height: d.nativeSize[1] / d.pointScale,
    }));
}

/** What the app measured of its window (modules/clawtrate-layout logs each change), oldest first. */
export type MeasuredWindow = {
  width: number;
  height: number;
  hinge: boolean;
  sizeClass: "compact" | "regular";
  bar: "none" | "left" | "right";
  regions: number;
  safe: { top: number; bottom: number; left: number; right: number };
};

export function measuredWindows(sinceSeconds: number): MeasuredWindow[] {
  const pattern =
    /window (\d+)x(\d+) hinge=(true|false) sizeClass=(compact|regular) bar=(none|left|right) regions=(\d+) safe=(\d+),(\d+),(\d+),(\d+)/g;
  return [...appLog(sinceSeconds).matchAll(pattern)].map((m) => ({
    width: Number(m[1]),
    height: Number(m[2]),
    hinge: m[3] === "true",
    sizeClass: m[4] as MeasuredWindow["sizeClass"],
    bar: m[5] as MeasuredWindow["bar"],
    regions: Number(m[6]),
    safe: { top: Number(m[7]), bottom: Number(m[8]), left: Number(m[9]), right: Number(m[10]) },
  }));
}

/** A loopback port nothing listens on. */
export async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * With CLAWTRATE_IOS_SHOTS set, the screen as it is now, in light and in dark.
 * A screenshot is evidence for the report, never an assertion; the wait after
 * changing the appearance only lets the screen redraw.
 */
export async function shoot(name: string) {
  const dir = process.env.CLAWTRATE_IOS_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  for (const appearance of ["light", "dark"]) {
    simctl("ui", env.device, "appearance", appearance);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    screenshot(join(dir, `${name}-${appearance}.png`));
  }
  simctl("ui", env.device, "appearance", "light");
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
