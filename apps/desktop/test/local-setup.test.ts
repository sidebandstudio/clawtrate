// "This computer" with local connect (docs/design/setup-effortless.md §3): the look reads
// OpenClaw's settings and proves its port, and Connect is the one step. Each rule here has a test
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
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClawtrateClient, FULL_SCOPES, PROOF_REFUSAL_LINES, type SetupLook } from "@clawtrate/core";
import { createNodeHost, STATE_FILE, type SecretBox } from "@clawtrate/core/node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { FakeGateway, helloOk, sleep, until } from "../../../packages/core/test/fake-gateway.ts";
import { localGatewayBuild } from "../packaging/config.ts";
import { SetupController } from "../src/setup/controller.ts";
import { localPortAllowed, provedRouteFor, type LocalConnect } from "../src/setup/local-connect.ts";
import { OPENCLAW_PINS } from "../src/setup/openclaw-pins.ts";
import { HeldToken } from "../src/setup/settings-reader.ts";
import { SetupRefusedError } from "../src/setup/world.ts";
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
    execFileSync("/usr/bin/xcrun", localGatewayBuild(helper));
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
 * laid out otherwise, or a runtime that maps no module, is written).
 */
function provedAnswer(
  home: string,
  folder: string,
  port: number,
  version = "2026.10.6",
  module: "pinned" | "wrong" | "none" = "pinned",
): Buffer {
  const lock = Buffer.from(
    JSON.stringify({
      pid: 4242,
      role: "gateway",
      port,
      stateDir: join(home, folder),
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
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((done) => server.on("listening", done));
  const port = (server.address() as AddressInfo).port;
  server.on("connection", (ws) => {
    const fake = gateway.createWebSocket(`ws://127.0.0.1:${port}`);
    fake.onmessage = (event) => ws.send(String(event.data));
    fake.onclose = () => ws.close();
    ws.on("message", (data) => fake.send(String(data)));
    ws.on("close", () => fake.close());
  });
  return {
    port,
    close: () => {
      for (const client of server.clients) client.terminate();
      return new Promise<void>((done) => server.close(() => done()));
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
function localApp(local: LocalConnect, options: { secure?: boolean; dataDir?: string } = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(scratch, "app-"));
  const host = createNodeHost({
    dataDir,
    client: { displayName: "Clawtrate Test", version: "0.0.0", platform: "test" },
    ...(options.secure === false ? {} : { secretBox: box }),
  });
  const client = new ClawtrateClient(
    {
      ...host,
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
    open: async () => new SetupRefusedError("missing"),
    stopPrograms: () => {},
    confirm: dialog,
    log: (line) => lines.push(line),
    localConnect: { ...local, worker: WORKER },
  });
  return { client, setup, dialog, lines, dataDir };
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
      const { client, setup, dialog, dataDir } = localApp(local);
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
        for (const file of [STATE_FILE, "credentials.bin"])
          expect(readFileSync(join(dataDir, file), "latin1")).not.toContain("token-at-connect");
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
            await setup.lookAtStart();
            const label = JSON.stringify(entry.look);
            expect(setup.current.phase, label).toBe("found");
            expect(setup.current.look, label).toMatchObject(entry.look);
            expect(JSON.stringify(setup.current), label).not.toContain("a-gateway-token");
            if (entry.look.reason === "tls")
              expect(readFileSync(join(home, "commands"), "utf8"), label).not.toContain("prove");
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
