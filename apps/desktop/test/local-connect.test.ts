// Local connect's connector (docs/design/setup-effortless.md §3, "The send
// gate"): the host dials the socket itself, proves its far end before undici
// writes a byte, and hands that same socket to the WebSocket. A stand-in proof
// and a listener of the test's own on loopback; no OpenClaw and no gateway.

import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { deferred, until } from "../../../packages/core/test/fake-gateway.ts";
import { PROOF_REFUSAL_LINES } from "@clawtrate/core";
import { provedWhile } from "../src/setup/controller.ts";
import {
  localConnectFor,
  provedRouteFor,
  provedSockets,
  sendableCloseCode,
} from "../src/setup/local-connect.ts";
import { refusalKind } from "../src/setup/local-prove.ts";

const servers: { close(): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/**
 * A plain listener that counts every byte it is sent, and the peers' ports. `first` is what
 * happened first on its connections: a byte arrived, or one closed. `close` stops it accepting,
 * ends every connection it accepted, and settles once the listener and all of them are closed;
 * the `afterEach` above calls it too.
 */
async function counting(): Promise<{
  port: number;
  bytes: () => number;
  peers: number[];
  first: Promise<"data" | "closed">;
  close: () => Promise<void>;
}> {
  let bytes = 0;
  let closed: Promise<void> | null = null;
  const peers: number[] = [];
  const accepted = new Set<Socket>();
  const first = deferred<"data" | "closed">();
  const server: Server = createServer((socket: Socket) => {
    accepted.add(socket);
    peers.push(socket.remotePort!);
    socket.on("data", (data) => {
      bytes += data.length;
      first.resolve("data");
    });
    socket.once("close", () => {
      accepted.delete(socket);
      first.resolve("closed");
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  // The server's own close waits for every connection it accepted to end.
  const close = () =>
    (closed ??= new Promise<void>((done) => {
      server.close(() => done());
      for (const socket of accepted) socket.destroy();
    }));
  servers.push({ close: () => void close() });
  return {
    port: (server.address() as { port: number }).port,
    bytes: () => bytes,
    peers,
    first: first.promise,
    close,
  };
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
      expect(() => sockets.createWebSocket(url), url).toThrow(
        /may only go to ws:\/\/127\.0\.0\.1 at the port OpenClaw.s settings name/,
      );
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

  it.skipIf(process.platform !== "darwin")(
    "a replaced socket's refusal, after its wait for a holder, is no refusal of the route",
    { timeout: 20_000 },
    async () => {
      const listener = await counting();
      const home = realpathSync(mkdtempSync(join(tmpdir(), "clawtrate-replaced-")));
      chmodSync(home, 0o700);
      // A stand-in helper: the first socket it is asked about waits a second and finds no
      // holder; any other socket is refused at once as not the profile's gateway.
      const helper = join(home, "helper");
      writeFileSync(
        helper,
        [
          "#!/bin/sh",
          `first=$(/bin/cat "${home}/first" 2>/dev/null)`,
          `[ -n "$first" ] || { echo "$4" > "${home}/first"; first=$4; }`,
          `echo "$4" >> "${home}/asked"`,
          "if [ \"$4\" = \"$first\" ]; then /bin/sleep 1; printf 'refused holder\\n'; else printf 'refused lock\\n'; fi",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      const asked = () => {
        try {
          return readFileSync(join(home, "asked"), "utf8").trim().split("\n").length;
        } catch {
          return 0;
        }
      };
      const told: string[] = [];
      const port = listener.port;
      const sockets = provedRouteFor({ home, helper, platform: "darwin", sandboxed: true }, (why) =>
        told.push(why),
      )(`ws://127.0.0.1:${port}`, ".openclaw@1:1")!;
      try {
        const url = `ws://127.0.0.1:${port}`;
        const first = sockets.createSocket(url);
        first.onerror = () => {};
        await until(() => asked() === 1, 5_000);
        // The protocol's retry, while the first socket's proof still runs.
        const second = sockets.createSocket(url);
        second.onerror = () => {};
        await until(() => told.length > 0, 5_000);
        // Past the first socket's answer, its wait for a holder and a second ask.
        await new Promise((done) => setTimeout(done, 3_000));
        // Only the replacement's refusal is told, and it is the route's words.
        expect(told).toEqual(["lock"]);
        expect(sockets.refusal?.()).toBe(PROOF_REFUSAL_LINES[refusalKind("lock")](port));
        expect(listener.bytes()).toBe(0);
        first.close();
        second.close();
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("gives the client proved sockets for one loopback endpoint's exact address alone", () => {
    const routes = provedRouteFor({
      home: "/nowhere",
      helper: null,
      platform: "darwin",
      sandboxed: true,
    });
    expect(routes("ws://127.0.0.1:19417", ".openclaw@1:1")).not.toBeNull();
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
      expect(routes(url, ".openclaw@1:1"), url).toBeNull();
  });

  it("on Windows the proof refuses before it looks at a home or a helper, and the socket carries no byte", async () => {
    const listener = await counting();
    // A folder of the test's own with no home and no helper in it: looking at either would
    // refuse with another word.
    const owned = mkdtempSync(join(tmpdir(), "clawtrate-connect-"));
    let opened: Promise<"open" | "error"> | undefined;
    try {
      const refusals: string[] = [];
      const local = { home: join(owned, "home"), helper: join(owned, "helper") };
      const url = `ws://127.0.0.1:${listener.port}`;
      const route = provedRouteFor({ ...local, platform: "win32", sandboxed: true }, (why) =>
        refusals.push(why),
      )(url, ".openclaw@1:1")!;
      opened = attempt(route.createSocket, url);
      // The one connection closes before a byte arrives: every byte it carried is counted.
      expect(await listener.first).toBe("closed");
      expect(listener.bytes()).toBe(0);
      expect(listener.peers).toHaveLength(1);
      expect(refusals).toEqual(["platform"]);
      expect(await opened).toBe("error");
      // The check just before the frame that carries a credential refuses as well.
      expect(await route.verify(new AbortController().signal)).toBe(false);
      expect(route.refusal?.()).toBe(PROOF_REFUSAL_LINES[refusalKind("platform")](listener.port));
    } finally {
      // Also when a check above fails while a connection is still open: ending the listener's
      // connections lets the attempt settle, and the test ends after both have.
      await Promise.all([listener.close(), opened]);
      rmSync(owned, { recursive: true, force: true });
    }
  });

  it("proves a setup socket last for its attempt alone: a Back during the proof sends nothing", async () => {
    let attempt = 1;
    let asked = 0;
    const prove = provedWhile(
      () => attempt === 1,
      async () => {
        asked += 1;
        // Back, while the proof runs: the attempt is no longer the current one when it passes.
        attempt += 1;
        return true;
      },
    );
    expect(await prove(new AbortController().signal)).toBe(false);
    expect(asked).toBe(1);
    // An attempt that is over isn't proved at all.
    expect(await prove(new AbortController().signal)).toBe(false);
    expect(asked).toBe(1);
    attempt = 1;
    const fine = provedWhile(
      () => attempt === 1,
      async () => true,
    );
    expect(await fine(new AbortController().signal)).toBe(true);
  });

  it("takes its home rule from mustSandbox, and has no default home outside a person's app", () => {
    const where = { helper: null, platform: "darwin" as const };
    const none = () => false;
    const account = () => "/clawtrate-account-home";
    const person = { packaged: true, env: {}, switches: none };
    // A person's packaged app: the account's own home, and no other.
    expect(localConnectFor(person, where, account)).toEqual({
      ...where,
      home: "/clawtrate-account-home",
      sandboxed: false,
    });
    expect(
      localConnectFor(person, { ...where, home: "/clawtrate-account-home" }, account)?.home,
    ).toBe("/clawtrate-account-home");
    expect(localConnectFor(person, { ...where, home: "/tmp/elsewhere" }, account)).toBe(null);
    expect(localConnectFor(person, where, () => null)).toBe(null);
    // A development build, an automated run, a driven app: off unless the run names a home of
    // its own, which is then a sandbox's; the account's home is never the default.
    for (const run of [
      { packaged: false, env: {}, switches: none },
      { packaged: true, env: { CLAWTRATE_SETUP_SANDBOX: "1" }, switches: none },
      { packaged: true, env: { VITEST: "" }, switches: none },
      { packaged: true, env: {}, switches: (name: string) => name === "remote-debugging-port" },
    ]) {
      expect(localConnectFor(run, where, account), JSON.stringify(run.env)).toBe(null);
      expect(localConnectFor(run, { ...where, home: "/tmp/sandbox-home" }, account)).toEqual({
        ...where,
        home: "/tmp/sandbox-home",
        sandboxed: true,
      });
    }
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

it("only a person's packaged Mac app turns local connect on", () => {
  const shipped = [
    "apps/desktop/src",
    "apps/mobile/src",
    "packages/core/src",
    "packages/ui/src",
  ].flatMap((dir) =>
    (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
      .filter((path) => /\.tsx?$/.test(path) && !path.split(sep).includes("node_modules"))
      .map((path) => join(ROOT, dir, path)),
  );
  const found = shipped.flatMap((file) =>
    localConnectUses(relative(ROOT, file).split(sep).join("/"), readFileSync(file, "utf8")),
  );
  // Each option's declaration and its reads, and the main process's one builder call, which
  // is a person's packaged Mac app's only (index.ts `LOCAL_CONNECT`).
  expect(found.sort()).toMatchInlineSnapshot(`
    [
      "apps/desktop/src/host/runtime.ts PropertyAssignment localConnect: options.localConnect",
      "apps/desktop/src/host/runtime.ts PropertySignature localConnect?: ClientOptions["localConnect"];",
      "apps/desktop/src/host/runtime.ts read options.localConnect",
      "apps/desktop/src/host/runtime.ts read options.localConnect",
      "apps/desktop/src/host/runtime.ts string "localConnect"",
      "apps/desktop/src/main/index.ts PropertyAssignment localConnect: provedRouteFor(LOCAL_CONNECT, (why) => console.log(\`[setup] couldn't verify what is listening (\${why})\`), )",
      "apps/desktop/src/main/index.ts PropertyAssignment localConnect: { ...LOCAL_CONNECT, worker: new URL("./settings-parse.js", import.meta.url), }",
      "apps/desktop/src/main/index.ts builder localConnectFor",
      "apps/desktop/src/main/index.ts call localConnectFor( { packaged: app.isPackaged, env: process.env, switches: hasSwitch }, { // packaging/config.ts \`LOCAL_GATEWAY_HELPER\`, built and signed with the app. helper: join(process.resourcesPath, "..", "Helpers", "ClawtrateLocalGateway"), platform: process.platform, }, )",
      "apps/desktop/src/setup/controller.ts PropertySignature localConnect?: LocalConnect & { worker: URL };",
      "apps/desktop/src/setup/controller.ts read this.options.localConnect",
      "apps/desktop/src/setup/controller.ts read this.options.localConnect",
      "apps/desktop/src/setup/controller.ts read this.options.localConnect",
      "packages/core/src/client.ts PropertySignature localConnect?: (url: string, route: string) => ProvedRoute | null;",
      "packages/core/src/client.ts read this.options.localConnect",
    ]
  `);
  // That one call is made only for a launch resolved as a person's own, on macOS, with the
  // Keychain; every other launch's LOCAL_CONNECT is null.
  const main = readFileSync(join(ROOT, "apps/desktop/src/main/index.ts"), "utf8");
  expect(main).toMatch(
    /const LOCAL_CONNECT =\s+SETUP\.kind === "production" &&\s+process\.platform === "darwin" &&\s+usesSecureStorage\(.*\)\)\s+\? localConnectFor\(/,
  );
});
