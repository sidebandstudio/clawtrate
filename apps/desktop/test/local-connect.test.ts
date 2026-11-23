// Local connect's connector (docs/design/setup-effortless.md §3, "The send
// gate"): the host dials the socket itself, proves its far end before undici
// writes a byte, and hands that same socket to the WebSocket. A stand-in proof
// and a listener of the test's own on loopback; no OpenClaw and no gateway.

import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { deferred, until } from "../../../packages/core/test/fake-gateway.ts";
import {
  localConnectFor,
  provedRouteFor,
  provedSockets,
  sendableCloseCode,
} from "../src/setup/local-connect.ts";

const servers: { close(): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A plain listener that counts every byte it is sent, and the peers' ports. */
async function counting(): Promise<{ port: number; bytes: () => number; peers: number[] }> {
  let bytes = 0;
  const peers: number[] = [];
  const server: Server = createServer((socket: Socket) => {
    peers.push(socket.remotePort!);
    socket.on("data", (data) => (bytes += data.length));
    socket.on("error", () => {});
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  return { port: (server.address() as { port: number }).port, bytes: () => bytes, peers };
}

/** A WebSocket server that records each connection's peer port. */
async function websocketServer(): Promise<{ port: number; peers: number[] }> {
  const peers: number[] = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (_socket, request) => peers.push(request.socket.remotePort!));
  await new Promise<void>((done) => server.on("listening", done));
  servers.push(server);
  return { port: (server.address() as { port: number }).port, peers };
}

/** Opens one WebSocket through the connector and waits for it to open or fail. */
async function attempt(create: (url: string) => unknown, url: string): Promise<"open" | "error"> {
  const socket = create(url) as WebSocket;
  return await new Promise((done) => {
    socket.onopen = () => {
      socket.close();
      done("open");
    };
    socket.onerror = () => done("error");
  });
}

describe("local connect's connector", () => {
  it("F-492: a socket whose far end isn't proved carries no byte, not even the upgrade", async () => {
    const listener = await counting();
    const proved: number[] = [];
    const sockets = provedSockets(listener.port, async (localPort) => {
      proved.push(localPort);
      return false;
    });
    expect(await attempt(sockets.createWebSocket, `ws://127.0.0.1:${listener.port}`)).toBe("error");
    // The proof was asked about the very socket the listener accepted.
    await until(() => listener.peers.length === 1);
    expect(proved).toEqual(listener.peers);
    await new Promise((done) => setTimeout(done, 100));
    expect(listener.bytes()).toBe(0);
  });

  it("hands the proved socket itself to the WebSocket, and dials and proves every one afresh", async () => {
    const server = await websocketServer();
    const proved: number[] = [];
    const sockets = provedSockets(server.port, async (localPort) => {
      proved.push(localPort);
      return true;
    });
    const url = `ws://127.0.0.1:${server.port}`;
    expect(await attempt(sockets.createWebSocket, url)).toBe("open");
    // A retry: a socket of its own, proved before it is used.
    expect(await attempt(sockets.createWebSocket, url)).toBe("open");
    expect(proved).toHaveLength(2);
    expect(server.peers).toEqual(proved);
  });

  it("closes with a code its WebSocket would refuse, and still says it closed", async () => {
    // The protocol client closes with 1008 when no challenge comes; undici's WebSocket throws on
    // it, before any close. It goes as a code the socket accepts; 1000 goes as it is.
    const codes: number[] = [];
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (socket) => socket.on("close", (code) => codes.push(code)));
    await new Promise((done) => server.on("listening", done));
    servers.push(server);
    const port = (server.address() as { port: number }).port;
    const sockets = provedSockets(port, async () => true);
    for (const [code, sent] of [
      [1008, 4008],
      [1000, 1000],
      [4000, 4000],
    ] as const) {
      const socket = sockets.createWebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((done) => (socket.onopen = () => done()));
      const closed = new Promise<void>((done) => (socket.onclose = () => done()));
      expect(() => socket.close(code, "connect challenge timeout"), String(code)).not.toThrow();
      await closed;
      await until(() => codes.length > 0);
      expect(codes.splice(0), String(code)).toEqual([sent]);
    }
    expect([999, 1001, 1015, 2999, 5000].map(sendableCloseCode)).toEqual([
      4999, 4001, 4015, 4999, 4000,
    ]);
    expect(sendableCloseCode(undefined)).toBe(undefined);
  });

  it("proves the latest socket again before its credential, and nothing once it is closed", async () => {
    const server = await websocketServer();
    const proved: number[] = [];
    let answer = true;
    const sockets = provedSockets(server.port, async (localPort) => {
      proved.push(localPort);
      return answer;
    });
    const socket = sockets.createWebSocket(`ws://127.0.0.1:${server.port}`);
    await new Promise<void>((done) => (socket.onopen = () => done()));
    const signal = new AbortController().signal;
    expect(await sockets.verify(signal)).toBe(true);
    expect(proved).toEqual([server.peers[0], server.peers[0]]);
    answer = false;
    expect(await sockets.verify(signal)).toBe(false);
    answer = true;
    const aborted = new AbortController();
    aborted.abort();
    expect(await sockets.verify(aborted.signal)).toBe(false);
    socket.close();
    await until(() => socket.readyState === 3);
    expect(await sockets.verify(signal)).toBe(false);
  });

  it("goes nowhere but the one loopback endpoint it was made for", async () => {
    const listener = await counting();
    let asked = 0;
    const sockets = provedSockets(listener.port, async () => {
      asked += 1;
      return true;
    });
    for (const url of [
      `ws://localhost:${listener.port}`,
      `ws://127.0.0.1:${listener.port + 1}`,
      `wss://127.0.0.1:${listener.port}`,
      `ws://127.0.0.1:${listener.port}/elsewhere`,
    ])
      expect(() => sockets.createWebSocket(url), url).toThrow(/only go to OpenClaw/);
    expect(asked).toBe(0);
    expect(listener.peers).toEqual([]);
  });

  it("verifies nothing for a socket replaced while it was proved again", async () => {
    const server = await websocketServer();
    const held = deferred<boolean>();
    let calls = 0;
    const sockets = provedSockets(server.port, async () => {
      calls += 1;
      // The dial's proof passes at once; the second one waits until the socket is replaced.
      return calls === 1 || (await held.promise);
    });
    const url = `ws://127.0.0.1:${server.port}`;
    const first = sockets.createWebSocket(url);
    await new Promise<void>((done) => (first.onopen = () => done()));
    const verified = sockets.verify(new AbortController().signal);
    const second = sockets.createWebSocket(url);
    held.resolve(true);
    expect(await verified).toBe(false);
    first.close();
    second.close();
  });

  it("proves again the socket its own WebSocket carries, never an earlier one's that passed late", async () => {
    const server = await websocketServer();
    const late = deferred<boolean>();
    const proved: number[] = [];
    const sockets = provedSockets(server.port, async (localPort) => {
      proved.push(localPort);
      // The first WebSocket's dial proof waits; every other proof passes.
      return proved.length === 1 ? await late.promise : true;
    });
    const url = `ws://127.0.0.1:${server.port}`;
    const first = sockets.createWebSocket(url);
    await until(() => proved.length === 1);
    const second = sockets.createWebSocket(url);
    await new Promise<void>((done) => (second.onopen = () => done()));
    // The earlier WebSocket's proof passes only now.
    late.resolve(true);
    await new Promise((done) => setTimeout(done, 50));
    expect(await sockets.verify(new AbortController().signal)).toBe(true);
    // The second proof was of the second WebSocket's socket; the first was never upgraded.
    expect(proved[2]).toBe(proved[1]);
    expect(server.peers).toEqual([proved[1]]);
    first.close();
    second.close();
  });

  it("gives the client proved sockets for one loopback endpoint's exact address alone", () => {
    const routes = provedRouteFor({
      home: "/nowhere",
      helper: null,
      platform: "darwin",
      sandboxed: true,
    });
    expect(routes("ws://127.0.0.1:19417", ".openclaw")).not.toBeNull();
    for (const url of [
      "ws://localhost:19417",
      "wss://127.0.0.1:19417",
      "ws://[::1]:19417",
      "ws://127.0.0.1:19417/",
      "ws://127.0.0.1:0",
      "ws://127.0.0.1:019417",
      "ws://127.0.0.1:65536",
      "ws://127.0.0.1",
    ])
      expect(routes(url, ".openclaw"), url).toBeNull();
  });

  it("takes its home rule from mustSandbox", () => {
    const where = { home: "/nowhere", helper: null, platform: "darwin" as const };
    const none = () => false;
    expect(localConnectFor({ packaged: true, env: {}, switches: none }, where).sandboxed).toBe(
      false,
    );
    expect(localConnectFor({ packaged: false, env: {}, switches: none }, where).sandboxed).toBe(
      true,
    );
    expect(
      localConnectFor(
        { packaged: true, env: { CLAWTRATE_SETUP_SANDBOX: "1" }, switches: none },
        where,
      ).sandboxed,
    ).toBe(true);
  });
});

const ROOT = join(import.meta.dirname, "../../..");

/** Every place a file names local connect's option or its builder, as `<path> <kind> <text>`. */
function localConnectUses(path: string, text: string): string[] {
  const found: string[] = [];
  if (!text.includes("localConnect")) return found;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const unquoted = (node: ts.Node) => node.getText(source).replace(/^["']|["']$/g, "");
  const visit = (node: ts.Node) => {
    const say = (kind: string) =>
      found.push(`${path} ${kind} ${node.getText(source).replace(/\s+/g, " ")}`);
    const name = (node as { name?: ts.Node }).name;
    if (
      (ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node) ||
        ts.isBindingElement(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isParameter(node)) &&
      name !== undefined &&
      /^localConnect/.test(unquoted(name))
    )
      say(ts.SyntaxKind[node.kind]!);
    else if (ts.isStringLiteralLike(node) && node.text.includes("localConnect")) say("string");
    else if (ts.isPropertyAccessExpression(node) && node.name.text === "localConnect") say("read");
    else if (
      (ts.isElementAccessExpression(node) || ts.isComputedPropertyName(node)) &&
      node.getText(source).includes("localConnect")
    )
      say("computed");
    else if (ts.isCallExpression(node) && node.expression.getText(source) === "localConnectFor")
      say("call");
    // The builder taken under another name, through a namespace or by a destructured rename,
    // is reported where it is taken.
    else if (
      (ts.isImportSpecifier(node) &&
        (node.propertyName ?? node.name).getText(source) === "localConnectFor") ||
      (ts.isPropertyAccessExpression(node) && node.name.text === "localConnectFor") ||
      (ts.isBindingElement(node) &&
        node.propertyName !== undefined &&
        /^localConnect/.test(unquoted(node.propertyName)))
    )
      say("builder");
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

it("the check finds the builder however a host takes it", () => {
  for (const [text, kind] of [
    ['import { localConnectFor as build } from "./local-connect.ts";', "builder"],
    ['import * as lc from "./local-connect.ts"; lc.localConnectFor;', "builder"],
    ['import * as lc from "./local-connect.ts"; const { localConnectFor: build } = lc;', "builder"],
    ['const { "localConnectFor": build } = lc;', "builder"],
    ["const { localConnect: on } = options;", "builder"],
    ["new SetupController({ ...{ localConnect: undefined } });", "PropertyAssignment"],
  ] as const)
    expect(localConnectUses("host.ts", text).join("\n"), text).toContain(`host.ts ${kind} `);
});

it("no shipped host turns local connect on", () => {
  const shipped = ["apps/desktop/src", "packages/core/src", "packages/ui/src"].flatMap((dir) =>
    (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
      .filter((path) => /\.tsx?$/.test(path) && !path.split(sep).includes("node_modules"))
      .map((path) => join(ROOT, dir, path)),
  );
  const found = shipped.flatMap((file) =>
    localConnectUses(relative(ROOT, file).split(sep).join("/"), readFileSync(file, "utf8")),
  );
  // Each option's declaration and its one read; nothing sets either, or calls the builder.
  expect(found.sort()).toEqual([
    "apps/desktop/src/setup/controller.ts PropertySignature localConnect?: LocalConnect;",
    "apps/desktop/src/setup/controller.ts read this.options.localConnect",
    "packages/core/src/client.ts PropertySignature localConnect?: (url: string, route: string) => ProvedRoute | null;",
    "packages/core/src/client.ts read this.options.localConnect",
  ]);
});
