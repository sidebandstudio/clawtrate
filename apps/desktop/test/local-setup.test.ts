// "This computer" with local connect (docs/design/setup-effortless.md §3): the look reads
// OpenClaw's settings and checks that what listens at their port is held by this account and
// matches this account's OpenClaw profile, and Connect is the one step. Each rule here has a test
// that fails with the rule undone. Every home is a private folder of the test's own under the
// system's temporary root, every port one of the test's own and never OpenClaw's default; no
// test names, reads or dials the account's own OpenClaw.
//
// - With a stand-in helper (a shell script answering the reader's read and the proof from files
//   the test writes) and a WebSocket server of the test's own in front of core's fake gateway.
// - With the real helper and a listener of the test's own that isn't OpenClaw.
// - With `OPENCLAW_BIN` and `CLAWTRATE_LOCAL_GATEWAY=1`, on development gateways of the test's own
//   (fixtures/local-gateway.ts), each in a temporary home: OpenClaw's default local policy, its
//   approval on, and a program of the test's own in front of it.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import {
  ClawtrateClient,
  createBridgeSession,
  FULL_SCOPES,
  PROOF_REFUSAL_LINES,
  type SetupLook,
} from "@clawtrate/core";
import { createNodeHost, STATE_FILE, type SecretBox } from "@clawtrate/core/node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  deferred,
  FakeGateway,
  helloOk,
  sleep,
  until,
} from "../../../packages/core/test/fake-gateway.ts";
import { leaveLook, thisComputer } from "../../../packages/ui/src/this-computer.ts";
import { localGatewayBuild } from "../packaging/config.ts";
import type { Installer } from "../src/setup/install.ts";
import { SetupController } from "../src/setup/controller.ts";
import { localPortAllowed, provedRouteFor, type LocalConnect } from "../src/setup/local-connect.ts";
import { OPENCLAW_PINS } from "../src/setup/openclaw-pins.ts";
import { HeldToken } from "../src/setup/settings-reader.ts";
import { productionWorld, SetupRefusedError } from "../src/setup/world.ts";
import {
  FOLDER,
  freePort,
  openclawBin,
  standIn,
  startGateway,
  type DevGateway,
} from "./fixtures/local-gateway.ts";

const platform = process.platform;
const mac = platform === "darwin";
const WORKER = new URL("../src/setup/settings-parse.ts", import.meta.url);
/** A stand-in helper is a process of its own: on a busy machine it gets all the time a test has. */
const SLOW = 50_000;
const BIN = openclawBin();

let scratch: string;
/** The real helper, built with packaging's flags. */
let helper: string | null = null;
beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "clawtrate-local-setup-")));
  chmodSync(scratch, 0o700);
  if (mac) {
    helper = join(scratch, "helper");
    // clang's two-architecture build leaves empty folders in TMPDIR: the scratch folder takes them.
    execFileSync("/usr/bin/xcrun", localGatewayBuild(helper), {
      env: { ...process.env, TMPDIR: scratch },
    });
  }
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A private home of the test's own. */
function newHome(): string {
  const home = realpathSync(mkdtempSync(join(scratch, "home-")));
  chmodSync(home, 0o700);
  return home;
}

/** The test's own secure-storage box: never the system's. */
const flip = (bytes: Uint8Array) => Uint8Array.from(bytes, (byte) => byte ^ 0x5a);
const box: SecretBox = {
  available: async () => true,
  encrypt: async (text) => flip(new TextEncoder().encode(text)),
  decrypt: async (data) => new TextDecoder().decode(flip(data)),
};

/**
 * A stand-in for the native helper: answers each command and profile folder from the files the
 * test writes in `dir` (`answer-<command>-<folder>`, and `.once` for one answer only), else
 * "absent", and notes that it ran. As the helper does, a read reports the profile folder's
 * identity, here the one in `identity-<folder>` ("1 1" until `replaceFolder`), and a proof
 * given another identity than the folder's is refused as "replaced" before anything else. With
 * `after-<command>-<folder>`, the folder is replaced just after that command's next answer.
 */
function standInHelper(dir: string): string {
  const path = join(dir, "stand-in-helper");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `: > "${dir}/ran"`,
      `echo "$1" >> "${dir}/commands"`,
      `f="${dir}/answer-$1-$2"`,
      `id="1 1"; [ -f "${dir}/identity-$2" ] && id=$(/bin/cat "${dir}/identity-$2")`,
      'case "$1" in prove*) [ "$5 $6" = "$id" ] || { printf \'refused replaced\\n\'; exit 0; };; esac',
      "answer() {",
      '  first=$(/usr/bin/head -n 1 "$1")',
      '  case "$first" in ok) printf \'ok %s\\n\' "$id"; /usr/bin/tail -n +2 "$1";; *) /bin/cat "$1";; esac',
      "}",
      'if [ -f "$f.once" ]; then answer "$f.once"; /bin/rm -f "$f.once"',
      'elif [ -f "$f" ]; then answer "$f"',
      "else printf 'refused absent\\n'; fi",
      `a="${dir}/after-$1-$2"; [ -f "$a" ] && /bin/mv "$a" "${dir}/identity-$2"`,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return path;
}

let replacements = 0;
/**
 * Another private profile folder at the same path, as the stand-in reports it from now on, or
 * just after its next answer to `after`. Its identity, as a route names it.
 */
function replaceFolder(dir: string, folder: string, after?: string): string {
  const ino = (replacements += 1) + 1;
  writeFileSync(join(dir, after ? `after-${after}-${folder}` : `identity-${folder}`), `1 ${ino}`);
  return `1:${ino}`;
}

/** The settings file the stand-in reads for a profile, or a refusal of the helper's. */
function settingsFile(dir: string, folder: string, settings: object | string) {
  const text =
    typeof settings === "string" && settings.startsWith("refused ")
      ? settings
      : `ok\n${typeof settings === "string" ? settings : JSON.stringify(settings)}`;
  writeFileSync(join(dir, `answer-read-private-${folder}`), text);
}

const tokenSettings = (port: number, token: string) => ({
  gateway: { mode: "local", port, auth: { mode: "token", token } },
});

/**
 * What the helper prints for a holder that is this profile's gateway, of `version`: mapping
 * that version's own module (`pinned`), another module (`wrong`), or none (`none`, as an install
 * laid out otherwise, or a runtime that maps no module, is written). Its lock names the settings
 * file it loaded: the profile's own unless `configPath` says another.
 */
function provedAnswer(
  home: string,
  folder: string,
  port: number,
  version = "2026.10.6",
  module: "pinned" | "wrong" | "none" = "pinned",
  configPath = join(home, folder, "openclaw.json"),
): Buffer {
  const lock = Buffer.from(
    JSON.stringify({
      pid: 4242,
      role: "gateway",
      port,
      stateDir: join(home, folder),
      configPath,
      startTime: 1795410457,
    }),
  );
  const pkg =
    module === "none"
      ? Buffer.alloc(0)
      : Buffer.from(JSON.stringify({ name: "openclaw", version }));
  const sha =
    module === "none"
      ? "-"
      : module === "wrong"
        ? "0".repeat(64)
        : (OPENCLAW_PINS[version]?.["darwin-arm64"] ?? "1".repeat(64));
  const header = `proved 4242 1795410457 ${module === "none" ? "none" : "arm64"} ${sha} ${lock.length} ${pkg.length}\n`;
  return Buffer.concat([Buffer.from(header), lock, pkg]);
}

function proofFile(dir: string, folder: string, answer: Buffer | string, once = false) {
  writeFileSync(join(dir, `answer-prove-private-${folder}${once ? ".once" : ""}`), answer);
}

/**
 * A WebSocket server of the test's own in front of core's fake gateway: each connection it
 * accepts after the upgrade is one of the fake gateway's sockets.
 */
async function bridged(gateway: FakeGateway) {
  // Every TCP connection the port accepts is counted, upgraded to a socket or not.
  const http = createHttpServer();
  let accepted = 0;
  http.on("connection", () => (accepted += 1));
  const server = new WebSocketServer({ server: http });
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  const port = (http.address() as AddressInfo).port;
  server.on("connection", (ws) => {
    const fake = gateway.createWebSocket(`ws://127.0.0.1:${port}`);
    fake.onmessage = (event) => ws.send(String(event.data));
    fake.onclose = () => ws.close();
    ws.on("message", (data) => fake.send(String(data)));
    ws.on("close", () => fake.close());
  });
  return {
    port,
    accepted: () => accepted,
    close: () => {
      for (const client of server.clients) client.terminate();
      return new Promise<void>((done) =>
        server.close(() => {
          http.closeAllConnections();
          http.close(() => done());
        }),
      );
    },
  };
}

/** A gateway that approves a first pairing with what it asked for, as OpenClaw's default does. */
function silentGateway(): FakeGateway {
  const gateway = new FakeGateway();
  gateway.connectReply = (params) => ({
    ok: true,
    payload: helloOk((params as { scopes: string[] }).scopes, "device-token-from-pairing"),
  });
  gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gateway-identity-1" });
  return gateway;
}

/**
 * The app as a person's Mac runs it: a client on a host with secure storage (the test's own
 * box) or without, whose saved route reopens only through local connect, and setup with local
 * connect on. Its own socket factory refuses: every socket is local connect's.
 */
function localApp(
  local: LocalConnect,
  options: { secure?: boolean; dataDir?: string; installer?: () => Installer } = {},
) {
  const dataDir = options.dataDir ?? mkdtempSync(join(scratch, "app-"));
  const host = createNodeHost({
    dataDir,
    client: { displayName: "Clawtrate Test", version: "0.0.0", platform: "test" },
    ...(options.secure === false ? {} : { secretBox: box }),
  });
  // Every write the client asks the host to make, in order (a delete as `null`), as it hands it
  // over: before the host seals its credentials record, where a search of the file on disk can't
  // see into it. A value later overwritten or deleted is still here.
  const writes: { key: string; value: string | null }[] = [];
  // A write the test says the store refuses, before anything is kept.
  let refuse: ((key: string, value: string) => boolean) | null = null;
  // How long each read waits before the store answers, as a store on a busy computer can.
  let readDelayMs = 0;
  const storage = {
    get: async (key: string) => {
      if (readDelayMs > 0) await sleep(readDelayMs);
      return host.storage.get(key);
    },
    delete: async (key: string) => {
      writes.push({ key, value: null });
      await host.storage.delete(key);
    },
    set: async (key: string, value: string) => {
      if (refuse?.(key, value)) throw new Error("the store refused this write");
      writes.push({ key, value });
      await host.storage.set(key, value);
    },
  };
  const client = new ClawtrateClient(
    {
      ...host,
      storage,
      createWebSocket: () => {
        throw new Error("a socket that isn't proved");
      },
    },
    { reconnect: { initialMs: 50, maxMs: 200 }, localConnect: provedRouteFor(local) },
  );
  const lines: string[] = [];
  const dialog = vi.fn(async () => true);
  const setup = new SetupController({
    client,
    open: async () =>
      options.installer
        ? {
            world: {
              ...productionWorld({ home: local.home, appData: dataDir, platform }),
              candidates: [],
            },
            run: async () => {
              throw new Error("Setup cannot run a discovered program.");
            },
            identify: () => ({ state: "exited", how: "absent" }),
          }
        : new SetupRefusedError("missing"),
    ...(options.installer ? { installer: options.installer } : {}),
    stopPrograms: () => {},
    confirm: dialog,
    log: (line) => lines.push(line),
    localConnect: { ...local, worker: WORKER },
  });
  return {
    client,
    setup,
    dialog,
    lines,
    dataDir,
    writes,
    local,
    refuseWrites: (rule: (key: string, value: string) => boolean) => (refuse = rule),
    slowReads: (ms: number) => (readDelayMs = ms),
  };
}

describe.skipIf(!mac)(
  "This computer, with a stand-in helper and a gateway of the test's own",
  {
    timeout: 120_000,
  },
  () => {
    it("F-602: is one click: no dialog, the six on a proved socket, the token read afresh, and nothing of it kept", async () => {
      const home = newHome();
      const gateway = silentGateway();
      const server = await bridged(gateway);
      const local: LocalConnect = {
        home,
        helper: standInHelper(home),
        platform,
        sandboxed: true,
        deadlineMs: SLOW,
      };
      settingsFile(home, ".openclaw", tokenSettings(server.port, "token-as-the-look-read-it"));
      proofFile(home, ".openclaw", provedAnswer(home, ".openclaw", server.port));
      const { client, setup, dialog, dataDir, writes } = localApp(local);
      const drops = vi.spyOn(HeldToken.prototype, "drop");
      try {
        await client.start({ resume: false });
        await setup.lookAtStart();
        expect(setup.current).toMatchObject({ phase: "found", unasked: true });
        expect(setup.current.look).toMatchObject({ outcome: "running", port: server.port });
        // The look kept nothing of the token: not in what the interface sees, not in a holder.
        expect(JSON.stringify(setup.current)).not.toContain("token-as-the-look-read-it");
        expect(drops).toHaveBeenCalledTimes(1);
        // Connect reads it afresh: a token changed since is the one that goes.
        settingsFile(home, ".openclaw", tokenSettings(server.port, "token-at-connect"));
        await setup.connect();
        await until(() => setup.current.phase === "done", 60_000);
        expect(dialog).not.toHaveBeenCalled();
        expect(gateway.connects).toHaveLength(1);
        const hello = gateway.connects[0] as { scopes: string[]; auth?: { token?: string } };
        expect(hello.auth?.token).toBe("token-at-connect");
        expect([...hello.scopes].sort()).toEqual([...FULL_SCOPES].sort());
        expect(client.state.connection).toMatchObject({ status: "connected", fullPairing: true });
        // Connect's holder was dropped once the client had the token.
        expect(drops).toHaveBeenCalledTimes(2);
        // Saved as this computer's profile and port, with no token, here or in the files.
        let saved = await client.savedSettings();
        for (let waited = 0; saved?.gatewayId === undefined && waited < 15_000; waited += 50) {
          await sleep(50);
          saved = await client.savedSettings();
        }
        expect(saved).toMatchObject({
          url: `ws://127.0.0.1:${server.port}`,
          token: null,
          route: ".openclaw@1:1",
          gatewayId: "gateway-identity-1",
        });
        expect(readFileSync(join(dataDir, STATE_FILE), "latin1")).not.toContain("token-at-connect");
        // The credentials record is sealed on disk: what went into it is checked as it was given,
        // every write in order. Nothing is saved before the first paired hello; then the device
        // token, the gateway with its route and no token, and the same with its identity.
        const credentials = writes
          .filter(({ key }) => key === "connection" || key.startsWith("deviceToken:"))
          .map(({ key, value }) => ({
            key: key.startsWith("deviceToken:") ? "deviceToken" : key,
            value: value === null ? null : (JSON.parse(value) as unknown),
          }));
        const route = { url: `ws://127.0.0.1:${server.port}`, token: null, route: ".openclaw@1:1" };
        expect(credentials).toEqual([
          {
            key: "deviceToken",
            value: expect.objectContaining({ token: "device-token-from-pairing" }),
          },
          { key: "connection", value: route },
          { key: "connection", value: { ...route, gatewayId: "gateway-identity-1" } },
        ]);
        // No write of any key, overwritten since or not, carried either token the settings held.
        for (const { value } of writes) {
          expect(value ?? "").not.toContain("token-at-connect");
          expect(value ?? "").not.toContain("token-as-the-look-read-it");
        }
        // And the client holds no copy once the device token is saved.
        const inside = client as unknown as {
          typedAttempt: unknown;
          settings: { token: string | null };
          writes: { retiredShared: Map<string, string> };
        };
        expect(inside.typedAttempt).toBe(null);
        expect(inside.settings.token).toBe(null);
        expect([...inside.writes.retiredShared.values()]).not.toContain("token-at-connect");
      } finally {
        drops.mockRestore();
        client.stop();
        await server.close();
      }
    });

    it("F-505: install pairs with all six scopes and no second confirmation", async () => {
      const home = newHome();
      const gateway = silentGateway();
      const server = await bridged(gateway);
      const local: LocalConnect = {
        home,
        helper: standInHelper(home),
        platform,
        sandboxed: true,
        deadlineMs: SLOW,
      };
      const folder = ".openclaw-clawtrate";
      const installer = () =>
        ({
          leftoverProgram: async () => null,
          run: async () => {
            settingsFile(home, folder, tokenSettings(server.port, "new-gateway-token"));
            proofFile(home, folder, provedAnswer(home, folder, server.port, "2026.11.10"));
            return { ok: true, port: server.port, env: {}, program: join(home, "stand-in") };
          },
        }) as unknown as Installer;
      const { client, setup, dialog } = localApp(local, { installer });
      try {
        await client.start({ resume: false });
        await setup.lookAtStart();
        expect(setup.current.look?.outcome).toBe("not-found");
        await setup.install();
        await until(() => setup.current.phase === "done", 60_000);
        expect(dialog).toHaveBeenCalledTimes(1);
        expect(gateway.connects).toHaveLength(1);
        expect(gateway.connects[0]).toMatchObject({ auth: { token: "new-gateway-token" } });
        const { scopes } = gateway.connects[0] as { scopes: string[] };
        expect([...scopes].sort()).toEqual([...FULL_SCOPES].sort());
        expect(client.state.connection).toMatchObject({ status: "connected", fullPairing: true });
      } finally {
        client.stop();
        await server.close();
      }
    });

    it("F-602: without secure storage, the same Connect asks for read only", async () => {
      const home = newHome();
      const gateway = silentGateway();
      const server = await bridged(gateway);
      const local: LocalConnect = {
        home,
        helper: standInHelper(home),
        platform,
        sandboxed: true,
        deadlineMs: SLOW,
      };
      settingsFile(home, ".openclaw", tokenSettings(server.port, "a-gateway-token"));
      proofFile(home, ".openclaw", provedAnswer(home, ".openclaw", server.port));
      const { client, setup } = localApp(local, { secure: false });
      try {
        await client.start({ resume: false });
        await setup.lookAtStart();
        await setup.connect();
        await until(() => setup.current.phase === "done", 60_000);
        expect((gateway.connects[0] as { scopes: string[] }).scopes).toEqual(["operator.read"]);
        expect(client.state.connection.fullPairing).toBe(false);
      } finally {
        client.stop();
        await server.close();
      }
    });

    it("F-602: sends nothing when the settings name another port than the look found", async () => {
      const home = newHome();
      const gateway = silentGateway();
      const server = await bridged(gateway);
      const local: LocalConnect = {
        home,
        helper: standInHelper(home),
        platform,
        sandboxed: true,
        deadlineMs: SLOW,
      };
      settingsFile(home, ".openclaw", tokenSettings(server.port, "a-gateway-token"));
      proofFile(home, ".openclaw", provedAnswer(home, ".openclaw", server.port));
      const { client, setup } = localApp(local);
      try {
        await client.start({ resume: false });
        await setup.lookAtStart();
        settingsFile(home, ".openclaw", tokenSettings(server.port + 1, "a-gateway-token"));
        await setup.connect();
        expect(setup.current).toMatchObject({ phase: "failed", failure: { kind: "changed" } });
        await sleep(300);
        expect(gateway.sockets).toHaveLength(0);
      } finally {
        client.stop();
        await server.close();
      }
    });

    it("F-602: ends the attempt with nothing sent when a socket isn't proved at its dial", async () => {
      const home = newHome();
      const gateway = silentGateway();
      const server = await bridged(gateway);
      const local: LocalConnect = {
        home,
        helper: standInHelper(home),
        platform,
        sandboxed: true,
        deadlineMs: SLOW,
      };
      settingsFile(home, ".openclaw", tokenSettings(server.port, "a-gateway-token"));
      proofFile(home, ".openclaw", provedAnswer(home, ".openclaw", server.port));
      const { client, setup, lines } = localApp(local);
      try {
        await client.start({ resume: false });
        await setup.lookAtStart();
        // Something else holds the port by Connect: the proof refuses it.
        proofFile(home, ".openclaw", "refused lock\n");
        await setup.connect();
        await until(() => setup.current.phase === "failed", 60_000);
        expect(setup.current.failure).toMatchObject({ kind: "unverified", port: server.port });
        expect(lines).toContain(
          `[setup] couldn't verify what is listening at port ${server.port} (lock)`,
        );
        await sleep(500);
        // No upgrade reached the server, so no frame and no credential.
        expect(gateway.sockets).toHaveLength(0);
        expect(gateway.connects).toHaveLength(0);
      } finally {
        client.stop();
        await server.close();
      }
    });

    it("F-602: sends no credential when a socket proved at its dial isn't proved again before it", async () => {
      const home = newHome();
      const gateway = silentGateway();
      const server = await bridged(gateway);
      const local: LocalConnect = {
        home,
        helper: standInHelper(home),
        platform,
        sandboxed: true,
        deadlineMs: SLOW,
      };
      settingsFile(home, ".openclaw", tokenSettings(server.port, "a-gateway-token"));
      proofFile(home, ".openclaw", provedAnswer(home, ".openclaw", server.port));
      const { client, setup } = localApp(local);
      try {
        await client.start({ resume: false });
        await setup.lookAtStart();
        // The dial's proof passes once; the one just before the credential refuses.
        proofFile(home, ".openclaw", "refused named\n");
        proofFile(home, ".openclaw", provedAnswer(home, ".openclaw", server.port), true);
        await setup.connect();
        await until(() => setup.current.phase === "failed", 60_000);
        expect(setup.current.failure?.kind).toBe("unverified");
        await sleep(500);
        // The socket was upgraded, and its credential never went.
        expect(gateway.sockets.length).toBeGreaterThanOrEqual(1);
        expect(gateway.connects).toHaveLength(0);
      } finally {
        client.stop();
        await server.close();
      }
    });

    it("F-602: says what the look found, and offers only a gateway it proved", async () => {
      const listening = await bridged(silentGateway());
      const stopped = await freePort();
      const cases: Array<{
        settings: Record<string, object | string>;
        proof?: (home: string) => Buffer | string;
        folder?: string;
        look: Partial<SetupLook>;
      }> = [
        { settings: {}, look: { outcome: "not-found" } },
        {
          settings: {
            ".openclaw": { gateway: { port: listening.port, auth: { mode: "password" } } },
          },
          look: { outcome: "not-token" },
        },
        {
          settings: {
            ".openclaw": {
              gateway: { port: listening.port, auth: { token: { source: "env", id: "X" } } },
            },
          },
          look: { outcome: "cant-tell", reason: "settings" },
        },
        // TLS on: local connect dials `ws://` only, so there is nothing to offer, and its port is
        // never dialled or proved, though a gateway that would pass listens there.
        {
          settings: {
            ".openclaw": {
              gateway: {
                mode: "local",
                port: listening.port,
                tls: { enabled: true },
                auth: { mode: "token", token: "a-gateway-token" },
              },
            },
          },
          proof: (home) => provedAnswer(home, ".openclaw", listening.port),
          look: { outcome: "cant-tell", reason: "tls", port: null },
        },
        // A settings file another account could change, or a link: the helper refuses it.
        {
          settings: { ".openclaw": "refused mode\n" },
          look: { outcome: "cant-tell", reason: "settings" },
        },
        {
          settings: { ".openclaw": tokenSettings(stopped, "a-gateway-token") },
          look: { outcome: "stopped", port: stopped },
        },
        {
          settings: { ".openclaw": tokenSettings(listening.port, "a-gateway-token") },
          proof: () => "refused lock\n",
          look: { outcome: "unverified", reason: "not-gateway", port: listening.port },
        },
        {
          settings: { ".openclaw": tokenSettings(listening.port, "a-gateway-token") },
          proof: () => "refused account\n",
          look: { outcome: "unverified", reason: "holder" },
        },
        {
          settings: { ".openclaw": tokenSettings(listening.port, "a-gateway-token") },
          proof: () => "refused helper\n",
          look: { outcome: "unverified", reason: "unchecked" },
        },
        // A gateway started on another settings file (`OPENCLAW_CONFIG_PATH`): what the file
        // read says of its port, token and TLS isn't known to hold for it, so no Connect.
        {
          settings: { ".openclaw": tokenSettings(listening.port, "a-gateway-token") },
          proof: (home) =>
            provedAnswer(
              home,
              ".openclaw",
              listening.port,
              "2026.11.10",
              "pinned",
              join(home, "elsewhere.json"),
            ),
          look: { outcome: "unverified", reason: "other-settings", port: listening.port },
        },
        // A pinned version whose module isn't its own is still refused.
        {
          settings: { ".openclaw": tokenSettings(listening.port, "a-gateway-token") },
          proof: (home) => provedAnswer(home, ".openclaw", listening.port, "2026.11.10", "wrong"),
          look: { outcome: "unverified", reason: "not-published" },
        },
        // A version without pins, and a holder mapping no module, stand on the lock and the rest.
        {
          settings: { ".openclaw": tokenSettings(listening.port, "a-gateway-token") },
          proof: (home) => provedAnswer(home, ".openclaw", listening.port, "2026.12.1"),
          look: { outcome: "running", port: listening.port },
        },
        {
          settings: { ".openclaw": tokenSettings(listening.port, "a-gateway-token") },
          proof: (home) => provedAnswer(home, ".openclaw", listening.port, "2026.12.1", "none"),
          look: { outcome: "running", port: listening.port },
        },
        {
          settings: { ".openclaw": tokenSettings(listening.port, "a-gateway-token") },
          proof: (home) => provedAnswer(home, ".openclaw", listening.port, "2026.11.10"),
          look: { outcome: "running", port: listening.port },
        },
        {
          settings: { ".openclaw-clawtrate": tokenSettings(listening.port, "a-gateway-token") },
          folder: ".openclaw-clawtrate",
          proof: (home) => provedAnswer(home, ".openclaw-clawtrate", listening.port),
          look: { outcome: "running", profile: "clawtrate" },
        },
      ];
      try {
        for (const entry of cases) {
          const home = newHome();
          const local: LocalConnect = {
            home,
            helper: standInHelper(home),
            platform,
            sandboxed: true,
            deadlineMs: SLOW,
          };
          for (const [folder, settings] of Object.entries(entry.settings))
            settingsFile(home, folder, settings);
          if (entry.proof) proofFile(home, entry.folder ?? ".openclaw", entry.proof(home));
          const { client, setup } = localApp(local);
          try {
            const dialled = listening.accepted();
            await setup.lookAtStart();
            const label = JSON.stringify(entry.look);
            expect(setup.current.phase, label).toBe("found");
            expect(setup.current.look, label).toMatchObject(entry.look);
            expect(JSON.stringify(setup.current), label).not.toContain("a-gateway-token");
            if (entry.look.reason === "tls") {
              expect(readFileSync(join(home, "commands"), "utf8"), label).not.toContain("prove");
              // Not dialled either: the port accepted no connection during the look.
              await sleep(200);
              expect(listening.accepted(), label).toBe(dialled);
            }
            if (entry.look.outcome !== "running")
              await expect(setup.connect(), label).rejects.toThrow("nothing to connect to");
          } finally {
            client.stop();
          }
        }
      } finally {
        await listening.close();
      }
    });

    for (const slow of [false, true])
      it(`F-602: settings changed in place to TLS off while the gateway still serves TLS: Connect fails with its ways on, and isn't retried${slow ? ", also when setup's disconnect is slower than the client's own retry" : ""}`, async () => {
        // What the reader knows is the settings file; the gateway runs on what it loaded when it
        // started. A file edited to TLS off since then names a listener that still speaks TLS.
        const home = newHome();
        execFileSync(
          "/usr/bin/openssl",
          [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=127.0.0.1",
            "-keyout",
            join(home, "tls-key.pem"),
            "-out",
            join(home, "tls-cert.pem"),
          ],
          { stdio: "ignore" },
        );
        let plaintext = 0;
        let dials = 0;
        const listener = createTlsServer(
          {
            key: readFileSync(join(home, "tls-key.pem")),
            cert: readFileSync(join(home, "tls-cert.pem")),
          },
          (socket) => socket.destroy(),
        );
        listener.on("tlsClientError", () => (plaintext += 1));
        // Every TCP connection, counted apart from the TLS errors it may end in.
        // And how many of them the listener still has open: none once each has closed its side.
        let open = 0;
        listener.on("connection", (socket) => {
          dials += 1;
          open += 1;
          socket.once("close", () => (open -= 1));
        });
        await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
        const port = (listener.address() as AddressInfo).port;
        const local: LocalConnect = {
          home,
          helper: standInHelper(home),
          platform,
          sandboxed: true,
          deadlineMs: SLOW,
        };
        settingsFile(home, ".openclaw", tokenSettings(port, "a-gateway-token"));
        proofFile(home, ".openclaw", provedAnswer(home, ".openclaw", port));
        const { client, setup, slowReads } = localApp(local);
        try {
          await client.start({ resume: false });
          await setup.look();
          expect(setup.current.look).toMatchObject({ outcome: "running", port });
          // From after the look: what Connect itself dials. The look's socket is counted once the
          // listener has closed it, with any TLS error it ended in, before the counts are taken.
          await until(() => open === 0, 15_000);
          const dialsBefore = dials;
          const plaintextBefore = plaintext;
          // The failed attempt's disconnect reads the store before it closes anything: held well
          // past the client's own first retry (50 to 60 ms here), that retry comes due first.
          if (slow) slowReads(500);
          await setup.connect();
          // Not left on Connecting, and not retried for ever: failed, with Look again and Advanced
          // (the card's ways on after a failed Connect).
          await until(() => setup.current.phase === "failed", 60_000);
          expect(setup.current.failure).toMatchObject({ kind: "unanswered", port });
          await until(() => client.state.connection.status === "idle", 15_000);
          // One dial, its plaintext refused by the TLS listener, and no retry before idle or after.
          expect(dials - dialsBefore).toBe(1);
          expect(plaintext - plaintextBefore).toBe(1);
          await sleep(1_000);
          expect(dials - dialsBefore).toBe(1);
          expect(plaintext - plaintextBefore).toBe(1);
          // A look again finds it as before, and Connect may be pressed again.
          await setup.look();
          expect(setup.current.look).toMatchObject({ outcome: "running", port });
        } finally {
          client.stop();
          await new Promise((done) => listener.close(done));
        }
      });

    it("F-602: paired, then a drop while the bots load and a reconnect nothing answers: setup goes on watching, and is done once the bots are read", async () => {
      const home = newHome();
      const gateway = silentGateway();
      // The first read of the bots is held: the drop comes while they load. Later reads answer.
      const held = deferred<unknown>();
      const answer = gateway.handlers["agents.list"]!;
      let lists = 0;
      gateway.handlers["agents.list"] = (params) =>
        (lists += 1) === 1 ? held.promise : answer(params);
      const server = await bridged(gateway);
      const local: LocalConnect = {
        home,
        helper: standInHelper(home),
        platform,
        sandboxed: true,
        deadlineMs: SLOW,
      };
      settingsFile(home, ".openclaw", tokenSettings(server.port, "a-gateway-token"));
      proofFile(home, ".openclaw", provedAnswer(home, ".openclaw", server.port));
      const { client, setup } = localApp(local);
      const phases: string[] = [];
      const stop = client.store.subscribe((state) => {
        const phase = state.setup?.phase;
        if (phase && phases.at(-1) !== phase) phases.push(phase);
      });
      try {
        await client.start({ resume: false });
        await setup.look();
        await setup.connect();
        // The first paired hello: the connection is the person's now, its bots still loading.
        await until(() => client.state.connection.status === "connected", 60_000);
        expect(client.state.discovery.status).toBe("loading");
        expect(setup.current.phase).toBe("connecting");
        // It drops, and the next socket ends before anything answers.
        gateway.refuseConnections = true;
        gateway.dropAll();
        await until(
          () =>
            client.state.connection.status === "reconnecting" &&
            client.state.connection.error?.code === "UNREACHABLE",
          60_000,
        );
        // The gateway answers again: the client's own retry connects and reads the bots.
        gateway.refuseConnections = false;
        await until(() => setup.current.phase === "done", 60_000);
        expect(client.state.connection.status).toBe("connected");
        expect(client.state.bots.length).toBeGreaterThan(0);
        expect(phases).not.toContain("failed");
      } finally {
        stop();
        client.stop();
        await server.close();
      }
    });

    it("F-602: outside a person's app, never dials OpenClaw's default ports, before any socket", async () => {
      // Pure: both profiles' default ports, sandboxed; never refused in a person's app.
      const sandbox: LocalConnect = { home: "/x", helper: null, platform, sandboxed: true };
      expect(localPortAllowed(sandbox, 18789)).toBe(false);
      expect(localPortAllowed(sandbox, 22768)).toBe(false);
      expect(localPortAllowed(sandbox, 19940)).toBe(true);
      // A caller that says it isn't sandboxed, in a launch that isn't a person's (this test runner,
      // a development build): refused all the same, from the same classification as the home rule.
      const unsandboxed = { ...sandbox, sandboxed: false };
      expect(localPortAllowed(unsandboxed, 18789)).toBe(false);
      expect(localPortAllowed(unsandboxed, 22768)).toBe(false);
      expect(provedRouteFor(unsandboxed)("ws://127.0.0.1:18789", ".openclaw@1:1")).toBe(null);
      // Only a person's own launch dials them.
      expect(localPortAllowed(unsandboxed, 18789, () => true)).toBe(true);
      expect(localPortAllowed(sandbox, 18789, () => true)).toBe(false);
      expect(provedRouteFor(sandbox)("ws://127.0.0.1:18789", ".openclaw@1:1")).toBe(null);
      // And a route that doesn't name a profile folder with its identity is never proved.
      for (const route of [
        ".openclaw",
        ".openclaw@",
        ".openclaw@1",
        "openclaw@1:1",
        ".openclaw@1:1@2:2",
      ])
        expect(provedRouteFor(sandbox)("ws://127.0.0.1:19940", route), route).toBe(null);
      expect(provedRouteFor(sandbox)("ws://127.0.0.1:19940", ".openclaw-clawtrate@1:1")).not.toBe(
        null,
      );
      // A `clawtrate` profile whose settings name no port falls back to its default, 22768: the
      // look refuses before it dials, and never asks the helper for a proof.
      const home = newHome();
      settingsFile(home, ".openclaw-clawtrate", {
        gateway: { mode: "local", auth: { mode: "token", token: "a-gateway-token" } },
      });
      const local: LocalConnect = {
        home,
        helper: standInHelper(home),
        platform,
        sandboxed: true,
        deadlineMs: SLOW,
      };
      const { client, setup } = localApp(local);
      try {
        await setup.look();
        expect(setup.current).toMatchObject({
          phase: "failed",
          failure: { kind: "refused", reason: "state" },
        });
        const commands = readFileSync(join(home, "commands"), "utf8").trim().split("\n");
        expect(commands).toContain("read-private");
        expect(commands).not.toContain("prove-private");
      } finally {
        client.stop();
      }
    });

    it("F-602: a default profile on OpenClaw's default port is passed over, undialled, and Clawtrate's own profile is still looked at", async () => {
      const home = newHome();
      const gateway = silentGateway();
      const server = await bridged(gateway);
      // The default profile names OpenClaw's default port, which a sandboxed run never dials.
      settingsFile(home, ".openclaw", tokenSettings(18789, "a-gateway-token"));
      settingsFile(home, ".openclaw-clawtrate", tokenSettings(server.port, "a-gateway-token"));
      proofFile(
        home,
        ".openclaw-clawtrate",
        provedAnswer(home, ".openclaw-clawtrate", server.port),
      );
      const local: LocalConnect = {
        home,
        helper: standInHelper(home),
        platform,
        sandboxed: true,
        deadlineMs: SLOW,
      };
      const { client, setup } = localApp(local);
      try {
        await setup.look();
        expect(setup.current.phase).toBe("found");
        expect(setup.current.look).toMatchObject({
          outcome: "running",
          profile: "clawtrate",
          port: server.port,
        });
        // One proof, of Clawtrate's own profile's port: the default profile's was never asked.
        const commands = readFileSync(join(home, "commands"), "utf8").trim().split("\n");
        expect(commands.filter((command) => command === "prove-private")).toHaveLength(1);
      } finally {
        client.stop();
        await server.close();
      }
    });

    it("F-602: asks once more when the first proof found no holder, as a busy gateway can't yet show one", async () => {
      const home = newHome();
      const gateway = silentGateway();
      const server = await bridged(gateway);
      const local: LocalConnect = {
        home,
        helper: standInHelper(home),
        platform,
        sandboxed: true,
        deadlineMs: SLOW,
      };
      settingsFile(home, ".openclaw", tokenSettings(server.port, "a-gateway-token"));
      proofFile(home, ".openclaw", provedAnswer(home, ".openclaw", server.port));
      const { client, setup } = localApp(local);
      try {
        await client.start({ resume: false });
        await setup.look();
        proofFile(home, ".openclaw", "refused holder\n", true);
        await setup.connect();
        await until(() => setup.current.phase === "done", 60_000);
        expect(gateway.connects).toHaveLength(1);
      } finally {
        client.stop();
        await server.close();
      }
    });

    it("F-602: a reconnect the proof refuses stops with that refusal's words and the way on, and isn't retried", async () => {
      const home = newHome();
      const gateway = silentGateway();
      const server = await bridged(gateway);
      const local: LocalConnect = {
        home,
        helper: standInHelper(home),
        platform,
        sandboxed: true,
        deadlineMs: SLOW,
      };
      settingsFile(home, ".openclaw", tokenSettings(server.port, "a-gateway-token"));
      proofFile(home, ".openclaw", provedAnswer(home, ".openclaw", server.port));
      const { client, setup } = localApp(local);
      try {
        await client.start({ resume: false });
        await setup.look();
        await setup.connect();
        await until(() => setup.current.phase === "done", 60_000);
        // Something that isn't this profile's gateway holds the port now.
        proofFile(home, ".openclaw", "refused lock\n");
        gateway.dropAll();
        await until(() => client.state.connection.error?.code === "LOCAL_UNVERIFIED", 60_000);
        expect(client.state.connection.status).toBe("error");
        expect(client.state.connection.error).toMatchObject({
          message: PROOF_REFUSAL_LINES["not-gateway"](server.port),
          hint: "Choose This computer to connect to it again, or use Advanced.",
        });
        const tries = readFileSync(join(home, "commands"), "utf8").split("prove-private").length;
        await sleep(1_500);
        expect(readFileSync(join(home, "commands"), "utf8").split("prove-private").length).toBe(
          tries,
        );
        // The connection stays the person's: setup is over, and the gateway stays saved.
        expect(setup.current.phase).toBe("done");
        expect(client.state.connection.status).toBe("error");
        expect(await client.savedSettings()).toMatchObject({ route: ".openclaw@1:1" });
      } finally {
        client.stop();
        await server.close();
      }
    });

    /** A home whose `.openclaw` profile names `port` and whose gateway the proof passes. */
    function provedHome(port: number) {
      const home = newHome();
      const local: LocalConnect = {
        home,
        helper: standInHelper(home),
        platform,
        sandboxed: true,
        deadlineMs: SLOW,
      };
      settingsFile(home, ".openclaw", tokenSettings(port, "a-gateway-token"));
      proofFile(home, ".openclaw", provedAnswer(home, ".openclaw", port));
      return { home, local };
    }
    const proofs = (home: string) =>
      readFileSync(join(home, "commands"), "utf8").split("prove-private").length - 1;

    it("F-492: a profile folder replaced between the look's read and its proof isn't offered, and its listener gets nothing", async () => {
      const gateway = silentGateway();
      const server = await bridged(gateway);
      const { home, local } = provedHome(server.port);
      const { client, setup } = localApp(local);
      try {
        await client.start({ resume: false });
        // Another valid private profile at the same path, with the same port, once the look
        // has read the settings: its own lock and database would pass every other check.
        replaceFolder(home, ".openclaw", "read-private");
        await setup.look();
        expect(setup.current.look).toMatchObject({
          outcome: "unverified",
          reason: "replaced",
          port: server.port,
        });
        expect(gateway.sockets).toHaveLength(0);
        expect(gateway.connects).toHaveLength(0);
      } finally {
        client.stop();
        await server.close();
      }
    });

    it("F-492: Connect reads no token from a profile folder replaced since the look, and proves nothing", async () => {
      const gateway = silentGateway();
      const server = await bridged(gateway);
      const { home, local } = provedHome(server.port);
      const { client, setup } = localApp(local);
      try {
        await client.start({ resume: false });
        await setup.look();
        expect(setup.current.look?.outcome).toBe("running");
        const proved = proofs(home);
        replaceFolder(home, ".openclaw");
        await setup.connect();
        expect(setup.current).toMatchObject({ phase: "failed", failure: { kind: "changed" } });
        await sleep(300);
        expect(proofs(home)).toBe(proved);
        expect(gateway.sockets).toHaveLength(0);
      } finally {
        client.stop();
        await server.close();
      }
    });

    it("F-492: a profile folder replaced between Connect's read of the token and a socket's proof gets nothing", async () => {
      const gateway = silentGateway();
      const server = await bridged(gateway);
      const { home, local } = provedHome(server.port);
      const { client, setup } = localApp(local);
      try {
        await client.start({ resume: false });
        await setup.look();
        replaceFolder(home, ".openclaw", "read-private");
        await setup.connect();
        await until(() => setup.current.phase === "failed", 60_000);
        expect(setup.current.failure).toMatchObject({ kind: "unverified", reason: "replaced" });
        await sleep(500);
        // No upgrade reached the server, so no frame and no credential.
        expect(gateway.sockets).toHaveLength(0);
        expect(gateway.connects).toHaveLength(0);
      } finally {
        client.stop();
        await server.close();
      }
    });

    it("F-492: a profile folder replaced between a socket's first proof and its last sends no credential", async () => {
      const gateway = silentGateway();
      const server = await bridged(gateway);
      const { home, local } = provedHome(server.port);
      const { client, setup } = localApp(local);
      try {
        await client.start({ resume: false });
        await setup.look();
        // The look's proof is behind it: the folder is replaced after Connect's dial is proved.
        replaceFolder(home, ".openclaw", "prove-private");
        await setup.connect();
        await until(() => setup.current.phase === "failed", 60_000);
        expect(setup.current.failure).toMatchObject({ kind: "unverified", reason: "replaced" });
        await sleep(500);
        expect(gateway.sockets.length).toBeGreaterThanOrEqual(1);
        expect(gateway.connects).toHaveLength(0);
      } finally {
        client.stop();
        await server.close();
      }
    });

    it("F-492: a reconnect to a profile folder replaced since sends nothing, also after a restart; a fresh look and Connect pair with the new one", async () => {
      const gateway = silentGateway();
      const server = await bridged(gateway);
      const { home, local } = provedHome(server.port);
      const first = localApp(local);
      let app = first;
      const refusedAt = async (client: ClawtrateClient, sockets: number) => {
        await until(() => client.state.connection.error?.code === "LOCAL_UNVERIFIED", 60_000);
        expect(client.state.connection.error).toMatchObject({
          message: PROOF_REFUSAL_LINES.replaced(server.port),
          hint: "Choose This computer to connect to it again, or use Advanced.",
        });
        await sleep(1_000);
        // Not a byte on a socket of the replacement's: refused at the dial, and not retried.
        expect(gateway.sockets).toHaveLength(sockets);
        expect(gateway.connects).toHaveLength(1);
        expect(await client.savedSettings()).toMatchObject({ route: ".openclaw@1:1" });
      };
      try {
        await app.client.start({ resume: false });
        await app.setup.look();
        await app.setup.connect();
        await until(() => app.setup.current.phase === "done", 60_000);
        expect(gateway.connects).toHaveLength(1);
        const sockets = gateway.sockets.length;
        const replaced = replaceFolder(home, ".openclaw");
        gateway.dropAll();
        await refusedAt(app.client, sockets);
        // After a restart, the saved route's own proof: the folder it names isn't there.
        app.client.stop();
        app = localApp(local, { dataDir: first.dataDir });
        await app.client.start();
        await refusedAt(app.client, sockets);
        // Only the person's look and Connect reach it, as a new pairing with its own token.
        await app.setup.look();
        expect(app.setup.current.look?.outcome).toBe("running");
        await app.setup.connect();
        await until(() => app.client.state.connection.status === "connected", 60_000);
        expect(gateway.connects).toHaveLength(2);
        const hello = gateway.connects[1] as { auth?: { token?: string } };
        expect(hello.auth?.token).toBe("a-gateway-token");
        let saved = await app.client.savedSettings();
        for (
          let waited = 0;
          saved?.route !== `.openclaw@${replaced}` && waited < 15_000;
          waited += 50
        ) {
          await sleep(50);
          saved = await app.client.savedSettings();
        }
        expect(saved?.route).toBe(`.openclaw@${replaced}`);
      } finally {
        app.client.stop();
        await server.close();
      }
    });

    /**
     * "Use This computer" after a reconnect the check refused, as both of its buttons run it (the
     * connection screen's form and Settings, Gateway: `this-computer.ts`), through the host's
     * bridge, as the app sends it: setup done, then its gateway's reconnect refused.
     */
    async function refusedThenStaged(why: "lock" | "replaced") {
      const gateway = silentGateway();
      const server = await bridged(gateway);
      const { home, local } = provedHome(server.port);
      const app = localApp(local);
      const session = createBridgeSession(app.client, { setup: app.setup });
      await app.client.start({ resume: false });
      await app.setup.look();
      await app.setup.connect();
      await until(() => app.setup.current.phase === "done", 60_000);
      const url = `ws://127.0.0.1:${server.port}`;
      const replaced = why === "replaced" ? replaceFolder(home, ".openclaw") : null;
      if (why === "lock") proofFile(home, ".openclaw", "refused lock\n");
      gateway.dropAll();
      await until(() => app.client.state.connection.error?.code === "LOCAL_UNVERIFIED", 60_000);
      const record = await app.client.savedSettings();
      expect(record).toMatchObject({ url, route: ".openclaw@1:1" });
      expect(await app.client.hasDeviceToken(url)).toBe(true);
      let staged = false;
      const press = () =>
        thisComputer(
          (command) => session.apply(command),
          (on) => (staged = on),
        );
      return {
        gateway,
        server,
        home,
        app,
        session,
        url,
        record,
        replaced,
        press,
        staged: () => staged,
      };
    }

    it("F-602: Use This computer, a look that finds nothing to offer, then Back: the saved gateway stays, and Reconnect works", async () => {
      const run = await refusedThenStaged("lock");
      try {
        await run.press();
        expect(run.staged()).toBe(true);
        expect(run.app.setup.current.look).toMatchObject({ outcome: "unverified" });
        // Nothing was forgotten by the look: the record and this device's pairing, in the store.
        expect(await run.app.client.savedSettings()).toEqual(run.record);
        // Back, as the look's Back sends it.
        await run.session.apply(leaveLook(run.app.setup.current));
        expect(await run.app.client.savedSettings()).toEqual(run.record);
        expect(await run.app.client.hasDeviceToken(run.url)).toBe(true);
        expect(run.app.client.state.connection.gatewayUrl).toBe(run.url);
        // Reconnect, once the check passes again: the same gateway, by its saved route.
        proofFile(run.home, ".openclaw", provedAnswer(run.home, ".openclaw", run.server.port));
        await run.session.apply({ type: "retry" });
        await until(() => run.app.client.state.connection.status === "connected", 60_000);
        expect(await run.app.client.savedSettings()).toMatchObject({ route: ".openclaw@1:1" });
      } finally {
        run.app.client.stop();
        await run.server.close();
      }
    });

    it("F-602: Use This computer, then Connect on the new offer: the saved gateway is replaced only once it connected", async () => {
      const run = await refusedThenStaged("replaced");
      try {
        await run.press();
        expect(run.app.setup.current.look).toMatchObject({ outcome: "running" });
        expect(await run.app.client.savedSettings()).toEqual(run.record);
        // What the store holds as the new gateway's first frame arrives: still the earlier one.
        let atFrame: Promise<unknown> | null = null;
        const reply = run.gateway.connectReply;
        run.gateway.connectReply = (params, url) => {
          atFrame ??= run.app.client.savedSettings();
          return reply(params, url);
        };
        await run.session.apply({ type: "setupConnect" });
        await until(() => run.app.client.state.connection.status === "connected", 60_000);
        expect(await atFrame).toEqual(run.record);
        let saved = await run.app.client.savedSettings();
        for (let waited = 0; saved?.route === run.record?.route && waited < 15_000; waited += 50) {
          await sleep(50);
          saved = await run.app.client.savedSettings();
        }
        expect(saved).toMatchObject({
          url: run.url,
          route: `.openclaw@${run.replaced}`,
          token: null,
        });
      } finally {
        run.app.client.stop();
        await run.server.close();
      }
    });

    it("F-602: Use This computer, then a Connect that fails: the saved gateway stays, selected, with its ways on", async () => {
      const run = await refusedThenStaged("replaced");
      try {
        // The new folder's gateway is matched by the look, and refused at Connect's dial.
        proofFile(run.home, ".openclaw", "refused lock\n");
        proofFile(
          run.home,
          ".openclaw",
          provedAnswer(run.home, ".openclaw", run.server.port),
          true,
        );
        await run.press();
        expect(run.app.setup.current.look).toMatchObject({ outcome: "running" });
        const frames = run.gateway.connects.length;
        await run.session.apply({ type: "setupConnect" });
        await until(() => run.app.setup.current.phase === "failed", 60_000);
        await sleep(500);
        expect(run.gateway.connects).toHaveLength(frames);
        // The store kept the earlier gateway through the attempt.
        expect(await run.app.client.savedSettings()).toEqual(run.record);
        // Back from the failed Connect, as its Back sends it: the earlier gateway is selected
        // again, with this device's pairing there, so Try again reconnects it (here refused
        // again: its folder was replaced).
        await run.session.apply({ type: "setupCancel" });
        await until(() => run.app.client.state.connection.status === "disconnected", 15_000);
        expect(run.app.client.state.connection).toMatchObject({ gatewayUrl: run.url });
        expect(await run.app.client.savedSettings()).toEqual(run.record);
        expect(await run.app.client.hasDeviceToken(run.url)).toBe(true);
        const asked = readFileSync(join(run.home, "commands"), "utf8").split("prove").length;
        await run.session.apply({ type: "retry" });
        await until(
          () => run.app.client.state.connection.error?.code === "LOCAL_UNVERIFIED",
          60_000,
        );
        expect(
          readFileSync(join(run.home, "commands"), "utf8").split("prove").length,
        ).toBeGreaterThan(asked);
        expect(await run.app.client.savedSettings()).toEqual(run.record);
      } finally {
        run.app.client.stop();
        await run.server.close();
      }
    });

    it("F-602: Use This computer, then Connect at the same address: the new connection is setup's, and setup reaches done", async () => {
      const run = await refusedThenStaged("replaced");
      const phases: string[] = [];
      const stop = run.app.client.store.subscribe((state) => {
        const phase = state.setup?.phase;
        if (phase && phases.at(-1) !== phase) phases.push(phase);
      });
      try {
        await run.press();
        expect(run.app.setup.current.look).toMatchObject({ outcome: "running" });
        // The connection still says how the refused reconnect ended, at this same address.
        expect(run.app.client.state.connection).toMatchObject({
          gatewayUrl: run.url,
          status: "error",
          error: { code: "LOCAL_UNVERIFIED" },
        });
        phases.length = 0;
        await run.session.apply({ type: "setupConnect" });
        // The earlier connection's refusal isn't this attempt's: setup follows the new one to
        // done, and the app opens (`App.tsx` unstages the look once setup is done and connected).
        await until(() => run.app.setup.current.phase === "done", 60_000);
        expect(run.app.client.state.connection.status).toBe("connected");
        expect(run.app.client.state.discovery.status).toBe("ready");
        expect(phases).not.toContain("failed");
        expect(run.app.setup.current.failure).toBe(null);
      } finally {
        stop();
        run.app.client.stop();
        await run.server.close();
      }
    });

    for (const slow of [false, true])
      it(`F-602: Use This computer, then Connect at the same address with the bots kept, and nothing answers: Connect fails with its ways on, and isn't retried${slow ? ", also when setup's disconnect is slower than the client's own retry" : ""}`, async () => {
        const run = await refusedThenStaged("replaced");
        const statuses: string[] = [];
        const stop = run.app.client.store.subscribe((state) => {
          const { status } = state.connection;
          if (statuses.at(-1) !== status) statuses.push(status);
        });
        // Something of the test's own on the same port now: it accepts and ends every connection
        // before anything answers.
        let accepted = 0;
        const ender = createServer((socket) => {
          accepted += 1;
          socket.destroy();
        });
        try {
          await run.press();
          expect(run.app.setup.current.look).toMatchObject({ outcome: "running" });
          // The bots the earlier connection read are still shown: a new connection at the same
          // address with them is `reconnecting`, not `connecting`.
          expect(run.app.client.state.bots.length).toBeGreaterThan(0);
          await run.server.close();
          await new Promise<void>((done) => ender.listen(run.server.port, "127.0.0.1", done));
          statuses.length = 0;
          // Held past the client's own first retry, as in the TLS case above.
          if (slow) run.app.slowReads(500);
          await run.session.apply({ type: "setupConnect" });
          await until(() => run.app.setup.current.phase === "failed", 60_000);
          expect(run.app.setup.current.failure).toMatchObject({
            kind: "unanswered",
            port: run.server.port,
          });
          expect(statuses).toContain("reconnecting");
          // Not retried: one connection, until setup's disconnect selected the earlier gateway
          // again, and none after.
          await until(() => run.app.client.state.connection.status === "disconnected", 15_000);
          expect(accepted).toBe(1);
          await sleep(1_000);
          expect(accepted).toBe(1);
        } finally {
          stop();
          run.app.client.stop();
          await new Promise((done) => ender.close(done));
        }
      });

    /**
     * After a refused reconnect, Use This computer finds a second gateway of this account's
     * (the settings name another port now), and Connect pairs with it: its first paired hello
     * saves it in place of the earlier one.
     */
    async function secondGateway(why: "lock" | "replaced", gateway = silentGateway()) {
      const run = await refusedThenStaged(why);
      const server = await bridged(gateway);
      settingsFile(run.home, ".openclaw", tokenSettings(server.port, "a-gateway-token"));
      proofFile(run.home, ".openclaw", provedAnswer(run.home, ".openclaw", server.port));
      const url = `ws://127.0.0.1:${server.port}`;
      return { ...run, second: { gateway, server, url } };
    }

    for (const roster of ["slow", "error"] as const)
      it(`F-602: Use This computer, Connect to another gateway, and Back while its bots ${roster === "slow" ? "load" : "couldn't be read"}: the gateway it saved stays saved`, async () => {
        const gateway = silentGateway();
        const listing = deferred<unknown>();
        gateway.handlers["agents.list"] =
          roster === "slow"
            ? () => listing.promise
            : () => {
                throw new Error("the bots couldn't be listed");
              };
        const run = await secondGateway("lock", gateway);
        try {
          await run.press();
          expect(run.app.setup.current.look).toMatchObject({
            outcome: "running",
            port: run.second.server.port,
          });
          await run.session.apply({ type: "setupConnect" });
          await until(() => run.app.client.state.connection.status === "connected", 60_000);
          // The paired hello saved the new gateway in place of the earlier one.
          let saved = await run.app.client.savedSettings();
          for (let waited = 0; saved?.url !== run.second.url && waited < 15_000; waited += 50) {
            await sleep(50);
            saved = await run.app.client.savedSettings();
          }
          expect(saved).toMatchObject({ url: run.second.url, route: ".openclaw@1:1", token: null });
          if (roster === "slow") {
            expect(run.app.setup.current.phase).toBe("connecting");
            expect(run.app.client.state.discovery.status).toBe("loading");
          } else {
            await until(() => run.app.setup.current.failure?.kind === "bots", 60_000);
          }
          // Back, as the Connecting screen's Back sends it: the choice already saved stays, with
          // this device's pairing there, and the connection stays open.
          await run.session.apply({ type: "setupCancel" });
          await until(() => run.app.setup.current.phase === "found", 15_000);
          await sleep(500);
          // (Its gateway's identity may have been saved with it since, as after every first hello.)
          expect(await run.app.client.savedSettings()).toMatchObject({
            url: run.second.url,
            route: ".openclaw@1:1",
            token: null,
          });
          expect(await run.app.client.hasDeviceToken(run.second.url)).toBe(true);
          expect(run.app.client.state.connection).toMatchObject({
            status: "connected",
            gatewayUrl: run.second.url,
          });
          listing.resolve({
            defaultId: "main",
            agents: [{ id: "main", identity: { name: "Juniper" } }],
          });
        } finally {
          run.app.client.stop();
          await run.server.close();
          await run.second.server.close();
        }
      });

    it("F-602: Use This computer, Connect to another gateway, Back while its bots load, then its socket drops: the saved gateway comes back", async () => {
      const gateway = silentGateway();
      const listing = deferred<unknown>();
      gateway.handlers["agents.list"] = () => listing.promise;
      const run = await secondGateway("lock", gateway);
      try {
        await run.press();
        await run.session.apply({ type: "setupConnect" });
        await until(() => run.app.client.state.connection.status === "connected", 60_000);
        let saved = await run.app.client.savedSettings();
        for (let waited = 0; saved?.url !== run.second.url && waited < 15_000; waited += 50) {
          await sleep(50);
          saved = await run.app.client.savedSettings();
        }
        expect(run.app.client.state.discovery.status).toBe("loading");
        // Back, as the Connecting screen's Back sends it: the connection is the person's now.
        await run.session.apply({ type: "setupCancel" });
        await until(() => run.app.setup.current.phase === "found", 15_000);
        // Its socket drops before the bots were read; the retry's socket is checked and its
        // credential, this device's token, goes, and the bots are read on it.
        const connects = gateway.connects.length;
        gateway.dropAll();
        listing.resolve({
          defaultId: "main",
          agents: [{ id: "main", identity: { name: "Juniper" } }],
        });
        await until(() => gateway.connects.length > connects, 60_000);
        await until(
          () =>
            run.app.client.state.connection.status === "connected" &&
            run.app.client.state.discovery.status === "ready",
          60_000,
        );
        expect(run.app.client.state.connection.gatewayUrl).toBe(run.second.url);
        const hello = gateway.connects.at(-1) as { auth?: { deviceToken?: string } };
        expect(hello.auth?.deviceToken).toBe("device-token-from-pairing");
        expect(await run.app.client.savedSettings()).toMatchObject({ url: run.second.url });
      } finally {
        run.app.client.stop();
        await run.server.close();
        await run.second.server.close();
      }
    });

    it("F-602: Use This computer, Connect to a gateway that asks its owner, then Use another gateway: the earlier gateway is selected again, with its ways on", async () => {
      const gateway = new FakeGateway();
      gateway.connectReply = () => ({
        ok: false,
        error: {
          code: "NOT_PAIRED",
          message: "device pairing required",
          details: { code: "PAIRING_REQUIRED", requestId: "req-1" },
        },
      });
      const run = await secondGateway("lock", gateway);
      try {
        await run.press();
        await run.session.apply({ type: "setupConnect" });
        await until(() => run.app.client.state.connection.status === "pairing", 60_000);
        expect(run.app.client.state.connection.gatewayUrl).toBe(run.second.url);
        expect(run.app.setup.current.phase).toBe("connecting");
        // Use another gateway, as the pairing screen sends it.
        await run.session.apply({ type: "disconnect", gatewayUrl: run.second.url });
        // The earlier gateway is selected again, still saved, and setup no longer holds the
        // screen on Connecting (`setupHolds`): its card is shown, whose Back is the way back.
        await until(() => run.app.client.state.connection.status === "disconnected", 15_000);
        expect(run.app.client.state.connection.gatewayUrl).toBe(run.url);
        await until(() => run.app.setup.current.phase === "found", 15_000);
        expect(await run.app.client.savedSettings()).toEqual(run.record);
        expect(await run.app.client.hasDeviceToken(run.url)).toBe(true);
        // Back from the look, and the earlier gateway's Try again reconnects it by its route.
        await run.session.apply(leaveLook(run.app.setup.current));
        expect(run.app.client.state.connection).toMatchObject({
          status: "disconnected",
          gatewayUrl: run.url,
        });
        settingsFile(run.home, ".openclaw", tokenSettings(run.server.port, "a-gateway-token"));
        proofFile(run.home, ".openclaw", provedAnswer(run.home, ".openclaw", run.server.port));
        await run.session.apply({ type: "retry" });
        await until(() => run.app.client.state.connection.status === "connected", 60_000);
        expect(run.app.client.state.connection.gatewayUrl).toBe(run.url);
        expect(await run.app.client.savedSettings()).toEqual(run.record);
      } finally {
        run.app.client.stop();
        await run.server.close();
        await run.second.server.close();
      }
    });

    for (const after of ["restart", "reconnect"] as const)
      it(`F-602: Use This computer, Connect to another gateway, and Disconnect in Settings before it pairs: the earlier gateway stays saved, suspended, and nothing of the new one is (${after})`, async () => {
        const gateway = silentGateway();
        // The new gateway's hello is held: the frame reaches it and nothing answers.
        let hellos = 0;
        const make = gateway.createWebSocket.bind(gateway);
        Object.defineProperty(gateway, "createWebSocket", {
          value: (url: string) => {
            const socket = make(url);
            const send = socket.send.bind(socket);
            socket.send = (data: string) => {
              if ((JSON.parse(data) as { method?: string }).method === "connect") hellos += 1;
              else send(data);
            };
            return socket;
          },
        });
        const run = await secondGateway("lock", gateway);
        const records = () =>
          run.app.writes.filter(({ key }) => key === "connection").map(({ value }) => value);
        const earlier = records().at(-1)!;
        try {
          await run.press();
          await run.session.apply({ type: "setupConnect" });
          await until(() => hellos > 0, 60_000);
          expect(run.app.setup.current.phase).toBe("connecting");
          const before = records().length;
          // Disconnect, as Settings, Gateway sends it.
          await run.session.apply({ type: "suspend" });
          // The earlier gateway's own record, with the suspension recorded on it.
          expect(records().slice(before)).toEqual([
            JSON.stringify({ ...JSON.parse(earlier), suspended: true }),
          ]);
          expect(run.app.client.state.connection).toMatchObject({
            status: "disconnected",
            gatewayUrl: run.url,
          });
          await until(() => run.app.setup.current.phase !== "connecting", 15_000);
          if (after === "reconnect") {
            // Reconnect: the earlier gateway, its suspension lifted, and still nothing of the new one.
            await run.session.apply({ type: "retry" });
            await until(() => records().length > before + 1, 15_000);
            expect(JSON.parse(records().at(-1)!)).toEqual({
              ...JSON.parse(earlier),
              suspended: false,
            });
            expect(run.app.client.state.connection.gatewayUrl).toBe(run.url);
          }
          // Nothing of the new gateway was written at any point: no record, no pairing.
          for (const { key, value } of run.app.writes) {
            expect(key).not.toContain(encodeURIComponent(run.second.url));
            expect(value ?? "").not.toContain(run.second.url);
          }
        } finally {
          run.app.client.stop();
        }
        try {
          if (after === "restart") {
            // A restart comes back to the earlier gateway, suspended.
            const again = localApp(run.app.local, { dataDir: run.app.dataDir });
            try {
              await again.client.start();
              await sleep(300);
              expect(await again.client.savedSettings()).toEqual({
                ...JSON.parse(earlier),
                suspended: true,
              });
              expect(again.client.state.connection).toMatchObject({ gatewayUrl: run.url });
              expect(again.client.state.connection.status).not.toBe("connected");
              expect(hellos).toBe(1);
            } finally {
              again.client.stop();
            }
          }
        } finally {
          await run.server.close();
          await run.second.server.close();
        }
      });

    for (const leave of ["disconnect", "suspend"] as const)
      it(`F-602: Use This computer, Connect to another gateway, then a typed Connect the store can't save, then ${leave === "disconnect" ? "Use another gateway" : "Disconnect in Settings"} before anything pairs: the earlier gateway's record stays, and nothing of either other is written`, async () => {
        const gateway = silentGateway();
        // The new gateway's hello is held: the frame reaches it and nothing answers.
        let hellos = 0;
        const make = gateway.createWebSocket.bind(gateway);
        Object.defineProperty(gateway, "createWebSocket", {
          value: (url: string) => {
            const socket = make(url);
            const send = socket.send.bind(socket);
            socket.send = (data: string) => {
              if ((JSON.parse(data) as { method?: string }).method === "connect") hellos += 1;
              else send(data);
            };
            return socket;
          },
        });
        const run = await secondGateway("lock", gateway);
        const typed = "ws://gateway.example:19951";
        const records = () =>
          run.app.writes.filter(({ key }) => key === "connection").map(({ value }) => value);
        const earlier = records().at(-1)!;
        try {
          await run.press();
          await run.session.apply({ type: "setupConnect" });
          await until(() => hellos > 0, 60_000);
          const before = run.app.writes.length;
          // An ordinary Connect, as the address form sends it, whose saved choice the store refuses.
          run.app.refuseWrites((key) => key === "connection");
          await expect(
            run.session.apply({ type: "connect", url: typed, token: "a-typed-token" }),
          ).rejects.toThrow();
          run.app.refuseWrites(() => false);
          // Use another gateway (forget), or Disconnect in Settings (suspend).
          await run.session.apply(
            leave === "disconnect"
              ? { type: "disconnect", gatewayUrl: run.second.url }
              : { type: "suspend" },
          );
          expect(run.app.client.state.connection).toMatchObject({ gatewayUrl: run.url });
          // The earlier gateway's record: untouched, or with the suspension alone recorded on it.
          expect(
            run.app.writes
              .slice(before)
              .filter(({ key }) => key === "connection")
              .map(({ value }) => value),
          ).toEqual(
            leave === "disconnect"
              ? []
              : [JSON.stringify({ ...JSON.parse(earlier), suspended: true })],
          );
          expect(await run.app.client.savedSettings()).toEqual(
            leave === "disconnect"
              ? JSON.parse(earlier)
              : { ...JSON.parse(earlier), suspended: true },
          );
          for (const { key, value } of run.app.writes) {
            for (const other of [run.second.url, typed]) {
              expect(key).not.toContain(encodeURIComponent(other));
              expect(value ?? "").not.toContain(other);
            }
          }
        } finally {
          run.app.client.stop();
          await run.server.close();
          await run.second.server.close();
        }
      });

    it("F-602: reads nothing in a home that isn't a private folder of the run's own", async () => {
      const dir = newHome();
      // A development run that names a home outside the system's temporary root: refused before
      // anything is opened, and the helper never runs.
      const local: LocalConnect = {
        home: "/clawtrate-synthetic-home",
        helper: standInHelper(dir),
        platform,
        sandboxed: true,
      };
      const { client, setup } = localApp(local);
      try {
        await setup.lookAtStart();
        expect(setup.current).toMatchObject({
          phase: "failed",
          failure: { kind: "refused", reason: "home" },
        });
        expect(() => readFileSync(join(dir, "ran"))).toThrow();
      } finally {
        client.stop();
      }
    });
  },
);

describe.skipIf(!mac)(
  "This computer, with the real helper and a listener that isn't OpenClaw",
  {
    timeout: 120_000,
  },
  () => {
    it("F-492, F-602: a same-account listener at the settings' port gets no byte, and Connect isn't offered", async () => {
      let bytes = 0;
      let accepted = 0;
      const listener = createServer((socket) => {
        accepted += 1;
        socket.on("data", (data) => (bytes += data.length));
        socket.on("error", () => {});
      });
      await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
      const port = (listener.address() as AddressInfo).port;
      const home = newHome();
      const folder = join(home, ".openclaw");
      execFileSync("/bin/mkdir", ["-m", "700", folder]);
      writeFileSync(join(folder, "openclaw.json"), JSON.stringify(tokenSettings(port, "a-token")), {
        mode: 0o600,
      });
      const { client, setup, lines } = localApp({ home, helper, platform, sandboxed: true });
      try {
        await setup.lookAtStart();
        expect(setup.current.look).toMatchObject({ outcome: "unverified", port });
        expect(accepted).toBe(1);
        expect(bytes).toBe(0);
        expect(lines).toEqual([]);
      } finally {
        client.stop();
        listener.close();
      }
    });
  },
);

describe.skipIf(!BIN || !mac)(
  "This computer on a development gateway, OpenClaw's default local policy",
  { timeout: 300_000 },
  () => {
    let gateway: DevGateway;
    beforeAll(async () => {
      gateway = await startGateway(BIN!, { approval: false });
    }, 300_000);
    afterAll(async () => {
      await gateway?.remove();
    });

    const pending = (deviceId: string) => {
      const listed = gateway.run(["devices", "list", "--json"]);
      expect(listed.status).toBe(0);
      const rows = (JSON.parse(listed.stdout) as { pending?: { deviceId: string }[] }).pending;
      return (rows ?? []).filter((row) => row.deviceId === deviceId);
    };

    it("F-602: one click: paired with all six and no approval; sending, a new bot and the devices ask nothing more", async () => {
      const { client, setup, dialog } = localApp({
        home: gateway.home,
        helper,
        platform,
        sandboxed: true,
      });
      try {
        await client.start({ resume: false });
        await setup.lookAtStart();
        expect(setup.current.look).toMatchObject({ outcome: "running", port: gateway.port });
        await setup.connect();
        await until(() => setup.current.phase === "done", 120_000);
        expect(dialog).not.toHaveBeenCalled();
        const { connection } = client.state;
        expect([...connection.scopes].sort()).toEqual([...FULL_SCOPES].sort());
        expect(connection).toMatchObject({ fullPairing: true, canAdmin: true });
        const deviceId = connection.deviceId!;
        expect(pending(deviceId)).toEqual([]);
        // Sending: accepted with no request for access (the instance has no model, so the run
        // itself may fail).
        const key = `agent:main:clawtrate-local-${Date.now()}`;
        client.openSession(key);
        await until(() => client.state.transcripts[key]?.status === "ready", 60_000);
        client.sendMessage(key, "Hello from this computer.");
        await until(() => (client.state.transcripts[key]?.runs.length ?? 0) > 0, 60_000);
        // A new bot, an admin write: whatever the gateway says of it, never a missing scope.
        const made = await client
          .createBot({
            name: "Pip",
            avatar: null,
            account: null,
            provider: "openai",
            model: "gpt-test",
            effort: null,
          })
          .then(
            () => "made",
            (error: unknown) => String(error),
          );
        expect(made).not.toMatch(/scope|access|pairing required/i);
        // Machines' devices: read with the pairing scope already held.
        const machines = await client.readMachines();
        expect(Array.isArray(machines.devices)).toBe(true);
        expect(client.state.connection.upgrade.status).toBe("idle");
        expect(pending(deviceId)).toEqual([]);
      } finally {
        client.stop();
      }
    });

    it("F-492, F-602: a program of the test's own in front of the gateway gets no byte, and Connect isn't offered", async () => {
      // A home whose settings name the program's port, with the gateway's own token.
      const port = await freePort();
      const proxy = await standIn(port, gateway.port);
      const home = newHome();
      const folder = join(home, FOLDER);
      execFileSync("/bin/mkdir", ["-m", "700", folder]);
      writeFileSync(
        join(folder, "openclaw.json"),
        JSON.stringify(tokenSettings(port, gateway.token)),
        {
          mode: 0o600,
        },
      );
      const { client, setup } = localApp({ home, helper, platform, sandboxed: true });
      try {
        await setup.lookAtStart();
        expect(setup.current.look).toMatchObject({ outcome: "unverified", port });
        // The stand-in reports its accepts on its output, which may arrive after the look ends.
        await until(() => proxy.accepted() > 0, 15_000);
        expect(proxy.accepted()).toBe(1);
        expect(proxy.bytes()).toBe(0);
      } finally {
        client.stop();
        await proxy.stop();
      }
    });
  },
);

describe.skipIf(!BIN || !mac)(
  "This computer on a development gateway started on another settings file",
  { timeout: 300_000 },
  () => {
    let gateway: DevGateway;
    beforeAll(async () => {
      gateway = await startGateway(BIN!, { approval: false, elsewhere: true });
    }, 300_000);
    afterAll(async () => {
      await gateway?.remove();
    });

    it("isn't offered: its lock names the file it loaded, not the profile's, and it gets nothing", async () => {
      const { client, setup } = localApp({ home: gateway.home, helper, platform, sandboxed: true });
      try {
        await setup.look();
        // The profile's own file names this port and token, and its gateway holds the lock and the
        // database: only the settings file the lock names differs.
        expect(setup.current.look).toMatchObject({
          outcome: "unverified",
          reason: "other-settings",
          port: gateway.port,
        });
        await expect(setup.connect()).rejects.toThrow("nothing to connect to");
        expect(client.state.connection.status).toBe("idle");
      } finally {
        client.stop();
      }
    });
  },
);

describe.skipIf(!BIN || !mac)(
  "This computer on a development gateway with its local approval on",
  { timeout: 300_000 },
  () => {
    let gateway: DevGateway;
    beforeAll(async () => {
      gateway = await startGateway(BIN!, { approval: true });
    }, 300_000);
    afterAll(async () => {
      await gateway?.remove();
    });

    it("F-602: waits on the pairing screen for one approval, for all six, then is connected", async () => {
      const { client, setup } = localApp({ home: gateway.home, helper, platform, sandboxed: true });
      try {
        await client.start({ resume: false });
        await setup.lookAtStart();
        await setup.connect();
        await until(() => client.state.connection.pairing !== null, 120_000);
        const { requestId, requestedScopes } = client.state.connection.pairing!;
        expect([...requestedScopes].sort()).toEqual([...FULL_SCOPES].sort());
        expect(gateway.run(["devices", "approve", requestId]).status).toBe(0);
        await until(() => setup.current.phase === "done", 120_000);
        expect([...client.state.connection.scopes].sort()).toEqual([...FULL_SCOPES].sort());
      } finally {
        client.stop();
      }
    });
  },
);
