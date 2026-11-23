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
import { localConnectFor, provedSockets } from "../src/setup/local-connect.ts";

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

it("no shipped host turns local connect on", () => {
  const shipped = ["apps/desktop/src", "packages/core/src", "packages/ui/src"].flatMap((dir) =>
    (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
      .filter((path) => /\.tsx?$/.test(path) && !path.split(sep).includes("node_modules"))
      .map((path) => join(ROOT, dir, path)),
  );
  const found: string[] = [];
  for (const file of shipped) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("localConnect")) continue;
    const path = relative(ROOT, file).split(sep).join("/");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
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
        /^localConnect/.test(name.getText(source).replace(/^["']|["']$/g, ""))
      )
        say(ts.SyntaxKind[node.kind]!);
      else if (ts.isStringLiteralLike(node) && node.text.includes("localConnect")) say("string");
      else if (ts.isPropertyAccessExpression(node) && node.name.text === "localConnect")
        say("read");
      else if (
        (ts.isElementAccessExpression(node) || ts.isComputedPropertyName(node)) &&
        node.getText(source).includes("localConnect")
      )
        say("computed");
      else if (ts.isCallExpression(node) && node.expression.getText(source) === "localConnectFor")
        say("call");
      // The builder taken under another name, or through a namespace, is reported where it is taken.
      else if (
        (ts.isImportSpecifier(node) &&
          (node.propertyName ?? node.name).getText(source) === "localConnectFor") ||
        (ts.isPropertyAccessExpression(node) && node.name.text === "localConnectFor")
      )
        say("builder");
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  // The option's declaration and its one read; nothing sets it, or calls the builder.
  expect(found.sort()).toEqual([
    "apps/desktop/src/setup/controller.ts PropertySignature localConnect?: LocalConnect;",
    "apps/desktop/src/setup/controller.ts read this.options.localConnect",
  ]);
});
