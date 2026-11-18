// What the Simulator checks use: the device, the gateway instance and the tools
// `pnpm mobile:check` gives them (scripts/check.ts), Maestro to drive the app,
// the dev tool's own guarded runner for OpenClaw commands, a loopback proxy the
// checks can cut and restore, and a gateway that speaks another protocol.

import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, Socket, type Server } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { openInstance } from "../../../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../../../tools/dev-gateway/src/env.ts";
import { decodePng } from "../../../tools/brand/src/png.ts";

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
export async function steps(name: string, commands: Step[]): Promise<void> {
  const dir = join(OUTPUT, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "flow.yaml");
  writeFileSync(
    file,
    `appId: ${env.bundle}\n---\n${commands.map((c) => `- ${JSON.stringify(c)}`).join("\n")}\n`,
  );
  try {
    await run(
      need("CLAWTRATE_IOS_MAESTRO"),
      ["--device", env.device, "test", "--debug-output", dir, file],
      {
        maxBuffer: 16 * 1024 * 1024,
        timeout: 10 * 60_000,
      },
    );
  } catch (error) {
    const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
    throw new Error(`Steps "${name}" failed:\n${stdout}${stderr}`, { cause: error });
  }
}

export type Selector = { id?: string; text?: string; [key: string]: unknown };

/** Regular expression for a literal text: Maestro matches text as a pattern. */
export const lit = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const see = (selector: Selector | string): Step => ({ assertVisible: selector });
export const notSee = (selector: Selector | string): Step => ({ assertNotVisible: selector });
export const tap = (selector: Selector | string): Step => ({ tapOn: selector });
export const waitFor = (selector: Selector | string, ms = 60_000): Step => ({
  extendedWaitUntil: { visible: selector, timeout: ms },
});
export const waitGone = (selector: Selector | string, ms = 60_000): Step => ({
  extendedWaitUntil: { notVisible: selector, timeout: ms },
});
export const scrollTo = (selector: Selector, direction: "UP" | "DOWN"): Step => ({
  scrollUntilVisible: { element: selector, direction, timeout: 30_000 },
});

type Node = { attributes?: Record<string, string>; children?: Node[] };

/** Where each element with an id is on screen now, in points, from Maestro's view of the app. */
export async function layout(): Promise<
  Map<string, Array<{ x1: number; y1: number; x2: number; y2: number; text: string }>>
> {
  const { stdout } = await run(
    need("CLAWTRATE_IOS_MAESTRO"),
    ["--device", env.device, "hierarchy"],
    {
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const tree = JSON.parse(stdout.slice(stdout.indexOf("{"))) as Node;
  const found = new Map<
    string,
    Array<{ x1: number; y1: number; x2: number; y2: number; text: string }>
  >();
  const walk = (node: Node) => {
    const a = node.attributes ?? {};
    const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a.bounds ?? "");
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
 * The screen as pixels: the colour at a point. `pointsWide` is the screen's
 * width in points (the widest element `layout` found), which gives the scale.
 */
export function screen(pointsWide: number): (x: number, y: number) => [number, number, number] {
  const file = join(OUTPUT, "screen.png");
  simctl("io", env.device, "screenshot", file);
  const image = decodePng(readFileSync(file));
  const scale = image.width / pointsWide;
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
 * Start the app, naming the gateway the check runs as the development gateway
 * (so the pairing screen shows the dev tool's approve command). `fresh` first
 * resets the device's Keychain: the app starts with no gateway and a new key.
 */
export function launch(options: { fresh?: boolean; devGateway: string }) {
  quit();
  if (options.fresh) simctl("keychain", env.device, "reset");
  simctl(
    "launch",
    env.device,
    env.bundle,
    "-ClawtrateDevGatewayURL",
    options.devGateway,
    "-ClawtrateDevGatewayInstance",
    env.instance,
  );
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

export async function gatewayCall<T>(method: string, params: unknown): Promise<T> {
  return parseJsonOutput<T>(
    await openclaw(["gateway", "call", method, "--params", JSON.stringify(params), "--json"]),
  );
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
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async restore() {
    await this.listen(this.port);
  }

  async stop() {
    await this.cut();
  }
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
export async function protocolFiveGateway(): Promise<{ url: string; close: () => Promise<void> }> {
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
      const frame = JSON.parse(String(data)) as { id?: string; method?: string };
      if (frame.method !== "connect") return;
      socket.send(JSON.stringify({ ...reply, id: frame.id, error: { ...reply.error, details } }));
      socket.close(1002);
    });
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
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
    simctl("io", env.device, "screenshot", join(dir, `${name}-${appearance}.png`));
  }
  simctl("ui", env.device, "appearance", "light");
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
