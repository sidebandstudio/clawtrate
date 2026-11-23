// Connect on this computer at the edges of its consent and its connection
// (docs/design/setup.md §7, docs/decisions.md): the endpoint's listener read
// again once the setup socket opens and again just before its credential
// goes; a refusal whose code the protocol doesn't name; a Back whose cleanup
// failed; and a saved pairing that went or came after the person agreed.
// Production's setup world with in-memory sockets, fixture outputs and a
// fake process lookup: no gateway, no OpenClaw command and no network.
//
// Local connect's send gate (docs/design/setup-effortless.md §3): each socket's
// far end proved before its first byte. Here with a listener of the test's
// own, and, with `OPENCLAW_BIN` and `CLAWTRATE_LOCAL_GATEWAY=1`, on a
// development gateway of the test's own (fixtures/local-gateway.ts).
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ClawtrateClient, FULL_SCOPES, type ClawtrateHost } from "@clawtrate/core";
import { createNodeHost } from "@clawtrate/core/node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  FakeGateway,
  deferred,
  helloOk,
  memoryStorage,
  sleep,
  testHost,
  tokenKey,
  until,
} from "../../../packages/core/test/fake-gateway.ts";
import { localGatewayBuild } from "../packaging/config.ts";
import { SetupController } from "../src/setup/controller.ts";
import { proveFor, provedSockets, type LocalConnect } from "../src/setup/local-connect.ts";
import { proveLocalGateway } from "../src/setup/local-prove.ts";
import type { Opened } from "../src/setup/sandbox.ts";
import { readLocalSettings } from "../src/setup/settings-reader.ts";
import { productionWorld } from "../src/setup/world.ts";
import {
  FOLDER,
  freePort,
  openclawBin,
  standIn,
  startGateway,
  type DevGateway,
} from "./fixtures/local-gateway.ts";
import { authJson, qrJson, statusJson, VERSION_LINE } from "./fixtures/openclaw-outputs.ts";

const URL = "ws://127.0.0.1:19940";
const PORT = 19940;
const CODE = "fictional".repeat(4) + "1234567";
const TOKEN = "fixture-device-token-for-unit-test";
const SCOPES = ["operator.read"];
const READ_TOKEN = JSON.stringify({ token: TOKEN, grantedScopes: SCOPES, heldScopes: SCOPES });

function makeClient(gateway: FakeGateway, storage = memoryStorage(), host?: ClawtrateHost) {
  return new ClawtrateClient(host ?? testHost(gateway, storage), {
    reconnect: { initialMs: 10, maxMs: 20 },
  });
}

/** The process the status reports on the port, which a test can swap for another. */
type Listener = { pid: number };

/** A look and Connect against production's world, with a fixture CLI and process lookup. */
async function withLocalSetup(
  client: ClawtrateClient,
  exercise: (setup: SetupController) => Promise<void>,
  listener: Listener = { pid: 4242 },
  /** Another port for the look to find, and local connect with its home in this run's folder. */
  more: {
    port?: number;
    localConnect?: (home: string) => LocalConnect;
    log?: (line: string) => void;
    /** The one profile the look finds, by its state folder (a development gateway's). */
    stateDir?: string;
  } = {},
) {
  const port = more.port ?? PORT;
  const url = `ws://127.0.0.1:${port}`;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "clawtrate-setup-edges-")));
  const world = {
    ...productionWorld({ home: dir, appData: dir, platform: "darwin" }),
    candidates: [process.execPath],
    // A fixture CLI of the test's own, run as a read-only version would be.
    readOnly: async () => ({ verified: true, version: null }),
    deep: false,
    ...(more.stateDir
      ? {
          profiles: [
            { name: "default", args: [], stateDir: more.stateDir, required: true, env: {} },
          ],
        }
      : {}),
  };
  const opened: Opened = {
    world,
    // The look's listener and a stranger, each alive with its own start time.
    identify: (pid) =>
      pid === 4242
        ? { state: "alive", identity: "start-4242" }
        : pid === 5555
          ? { state: "alive", identity: "start-5555" }
          : { state: "exited", how: "absent" },
    run: async ({ args }) => {
      const text = args.join(" ");
      const stdout =
        text === "--version"
          ? VERSION_LINE
          : text === "gateway status --json"
            ? statusJson({ port, listenerPid: listener.pid })
            : text === "config get gateway.auth.mode --json"
              ? authJson()
              : text.startsWith("qr ")
                ? qrJson(url, CODE, Date.now() + 60_000)
                : "";
      return { stdout, exitCode: stdout ? 0 : 1, timedOut: false, tooLarge: false, failed: false };
    },
  };
  try {
    const setup = new SetupController({
      client,
      open: async () => opened,
      confirm: async () => true,
      stopPrograms: () => {},
      ...(more.localConnect ? { localConnect: more.localConnect(dir) } : {}),
      ...(more.log ? { log: more.log } : {}),
    });
    await client.start({ resume: false });
    await setup.look();
    expect(setup.current.look?.outcome).toBe("running");
    await exercise(setup);
  } finally {
    client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Whether any Connect frame the gateway received carried this mode's credential. */
function sentCredential(gateway: FakeGateway, mode: "bootstrap" | "saved-token"): boolean {
  return gateway.connects.some((params) => {
    const { auth } = params as { auth?: { bootstrapToken?: string; deviceToken?: string } };
    return mode === "bootstrap" ? auth?.bootstrapToken === CODE : auth?.deviceToken === TOKEN;
  });
}

describe("the setup socket's listener, read again before its credential", () => {
  for (const mode of ["bootstrap", "saved-token"] as const) {
    it(`F-492: another process listening as the setup socket opens sends no credential (${mode})`, async () => {
      const gateway = new FakeGateway();
      const storage = memoryStorage(mode === "saved-token" ? { [tokenKey(URL)]: READ_TOKEN } : {});
      const host = testHost(gateway, storage);
      const listener = { pid: 4242 };
      // Between the look's last check and the open: the port is another process's now, while
      // the process the look found is still alive with its own start time.
      host.createWebSocket = (url) => {
        listener.pid = 5555;
        return gateway.createWebSocket(url);
      };
      const client = makeClient(gateway, storage, host);
      await withLocalSetup(
        client,
        async (setup) => {
          await setup.connect();
          await until(() => gateway.connects.length > 0 || setup.current.phase === "failed");
          expect(gateway.sockets.length).toBeGreaterThan(0);
          expect(sentCredential(gateway, mode)).toBe(false);
          expect(gateway.connects).toHaveLength(0);
          expect(setup.current.failure?.kind).toBe("changed");
        },
        listener,
      );
    });

    it(`F-492: another process listening once the socket is open sends no credential (${mode})`, async () => {
      const gateway = new FakeGateway();
      const storage = memoryStorage(mode === "saved-token" ? { [tokenKey(URL)]: READ_TOKEN } : {});
      const host = testHost(gateway, storage);
      const listener = { pid: 4242 };
      // Between the open and the first frame with a credential: the request is being signed.
      const sign = host.signer.sign;
      host.signer = {
        ...host.signer,
        sign: async (payload) => {
          listener.pid = 5555;
          return sign(payload);
        },
      };
      const client = makeClient(gateway, storage, host);
      await withLocalSetup(
        client,
        async (setup) => {
          await setup.connect();
          await until(() => gateway.connects.length > 0 || setup.current.phase === "failed");
          expect(sentCredential(gateway, mode)).toBe(false);
          expect(gateway.connects).toHaveLength(0);
          expect(setup.current.failure?.kind).toBe("changed");
        },
        listener,
      );
    });
  }

  it("F-492: with the same listener throughout, the setup credential goes and the app opens", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({ ok: true, payload: helloOk(SCOPES, TOKEN) });
    const client = makeClient(gateway);
    await withLocalSetup(client, async (setup) => {
      await setup.connect();
      await until(() => setup.current.phase === "done");
      expect(sentCredential(gateway, "bootstrap")).toBe(true);
    });
  });
});

describe("a refusal on reopening a gateway set up here", () => {
  it("F-492: a code the protocol doesn't name is published as the client's own", async () => {
    const gateway = new FakeGateway();
    const storage = memoryStorage();
    gateway.connectReply = () => ({ ok: true, payload: helloOk(SCOPES, TOKEN) });
    const first = makeClient(gateway, storage);
    await withLocalSetup(first, async (setup) => {
      await setup.connect();
      await until(() => setup.current.phase === "done");
      expect(storage.data.has("connection")).toBe(true);
    });
    // The ordinary connection to the saved gateway; the refusal carries the token as its code.
    gateway.connectReply = () => ({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "Fixture refusal", details: { code: TOKEN } },
    });
    const restarted = makeClient(gateway, storage);
    const snapshots: string[] = [];
    const unsubscribe = restarted.store.subscribe((state) => {
      snapshots.push(JSON.stringify(state.connection));
    });
    try {
      await restarted.start();
      await until(() => Boolean(restarted.state.connection.error));
      expect(snapshots.some((snapshot) => snapshot.includes(TOKEN))).toBe(false);
      expect(restarted.state.connection.error?.code).toBe("CONNECT_REFUSED");
    } finally {
      unsubscribe();
      restarted.stop();
    }
  });
});

describe("Back, when closing setup's connection fails", () => {
  it("F-492: the failure is said, the connection stays setup's, and Back tries again", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({ ok: true, payload: helloOk(SCOPES, TOKEN) });
    const bots = deferred<object>();
    gateway.handlers["agents.list"] = () => bots.promise;
    const firstDelete = deferred<void>();
    const storage = memoryStorage();
    const remove = storage.delete;
    const deleteSetting = vi.fn(async (key: string) => {
      if (key === "connection" && deleteSetting.mock.calls.length === 1) await firstDelete.promise;
      return remove(key);
    });
    const confirm = vi.fn(async () => true);
    const client = makeClient(gateway, { ...storage, delete: deleteSetting });
    await withLocalSetup(client, async (setup) => {
      (setup as unknown as { options: { confirm: typeof confirm } }).options.confirm = confirm;
      await setup.connect();
      await until(() => gateway.calls("agents.list").length > 0);
      expect(storage.data.has("connection")).toBe(true);
      setup.cancel();
      await until(() => deleteSetting.mock.calls.length === 1);
      // While that cleanup is under way the screen stays as it was: no card to Connect from yet.
      expect(setup.current.phase).toBe("connecting");
      await expect(setup.connect()).rejects.toThrow(/nothing to connect to/);
      firstDelete.reject(new Error("fixture settings write failed"));
      await until(() => setup.current.phase === "failed");
      expect(setup.current.failure?.kind).toBe("cleanup");
      expect(deleteSetting).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(client.state.connection.status).not.toBe("idle");
      setup.cancel();
      await until(() => client.state.connection.status === "idle");
      expect(gateway.sockets.every((socket) => socket.readyState === 3)).toBe(true);
      expect(storage.data.has("connection")).toBe(false);
      expect(setup.current.phase).toBe("found");
    });
  });

  it("F-492: Connect after a failed cleanup closes setup's connection first, or starts nothing", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({ ok: true, payload: helloOk(SCOPES, TOKEN) });
    const bots = deferred<object>();
    gateway.handlers["agents.list"] = () => bots.promise;
    const storage = memoryStorage();
    const remove = storage.delete;
    let failing = true;
    const deleteSetting = vi.fn(async (key: string) => {
      if (key === "connection" && failing) throw new Error("fixture settings write failed");
      return remove(key);
    });
    const confirm = vi.fn(async () => true);
    const client = makeClient(gateway, { ...storage, delete: deleteSetting });
    await withLocalSetup(client, async (setup) => {
      (setup as unknown as { options: { confirm: typeof confirm } }).options.confirm = confirm;
      await setup.connect();
      await until(() => gateway.calls("agents.list").length > 0);
      setup.cancel();
      await until(() => setup.current.phase === "failed");
      const sockets = gateway.sockets.length;
      // Still failing: Connect asks nothing and opens nothing.
      await setup.connect();
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(gateway.sockets).toHaveLength(sockets);
      expect(setup.current.failure?.kind).toBe("cleanup");
      // Closed this time: Connect goes on to its dialog. The first connection's hello saved a
      // device token, a pairing the person hasn't agreed to reuse, so the card asks for that.
      failing = false;
      await setup.connect();
      expect(confirm).toHaveBeenCalledTimes(2);
      expect(client.state.connection.status).toBe("idle");
      expect(storage.data.has("connection")).toBe(false);
      expect(gateway.sockets.every((socket) => socket.readyState === 3)).toBe(true);
      expect(setup.current.phase).toBe("found");
      expect(setup.current.look?.access).toBe("paired");
    });
  });
});

describe("two Connects that wait for the same cleanup", () => {
  it("F-492: only one reaches the dialog once the shared cleanup closes setup's connection", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({ ok: true, payload: helloOk(SCOPES, TOKEN) });
    const bots = deferred<object>();
    gateway.handlers["agents.list"] = () => bots.promise;
    const storage = memoryStorage();
    const remove = storage.delete;
    let failing = true;
    const closing = deferred<void>();
    const deleteSetting = vi.fn(async (key: string) => {
      if (key === "connection" && failing) throw new Error("fixture settings write failed");
      if (key === "connection") await closing.promise;
      return remove(key);
    });
    const confirm = vi.fn(async () => true);
    const client = makeClient(gateway, { ...storage, delete: deleteSetting });
    await withLocalSetup(client, async (setup) => {
      (setup as unknown as { options: { confirm: typeof confirm } }).options.confirm = confirm;
      await setup.connect();
      await until(() => gateway.calls("agents.list").length > 0);
      setup.cancel();
      await until(() => setup.current.failure?.kind === "cleanup");
      // Connect pressed twice: both wait for the one cleanup, which then succeeds.
      failing = false;
      const first = setup.connect();
      const second = setup.connect();
      await until(() => deleteSetting.mock.calls.length === 2);
      closing.resolve();
      await Promise.all([first, second]);
      expect(deleteSetting).toHaveBeenCalledTimes(2);
      expect(confirm).toHaveBeenCalledTimes(2);
    });
  });
});

describe("which selection setup's cleanup and readiness belong to", () => {
  it("F-492: Back's cleanup leaves a later selection of the same address connected", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({ ok: true, payload: helloOk(SCOPES, TOKEN) });
    const bots = deferred<object>();
    gateway.handlers["agents.list"] = () => bots.promise;
    const client = makeClient(gateway);
    await withLocalSetup(client, async (setup) => {
      await setup.connect();
      await until(() => gateway.calls("agents.list").length > 0);
      // Another window chooses the same address with its token, then this one presses Back:
      // the cleanup runs after that choice, and it is setup's selection it closes, or nothing.
      const chosen = client.connect({ url: URL, token: "typed-shared-token-0123456789" });
      setup.cancel();
      await chosen;
      await sleep(100);
      expect(client.state.connection.gatewayUrl).toBe(URL);
      expect(client.state.connection.status).not.toBe("idle");
      bots.resolve({ defaultId: "main", agents: [{ id: "main" }] });
    });
  });

  it("F-492: a replacement that was refused leaves setup's connection its own, and Back closes it", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({ ok: true, payload: helloOk(SCOPES, TOKEN) });
    const bots = deferred<object>();
    gateway.handlers["agents.list"] = () => bots.promise;
    const client = makeClient(gateway);
    await withLocalSetup(client, async (setup) => {
      await setup.connect();
      await until(() => gateway.calls("agents.list").length > 0);
      // Another choice of gateway that is refused before it is saved.
      await expect(client.connect({ url: "not a gateway address" })).rejects.toThrow();
      expect(setup.current.phase).toBe("connecting");
      setup.cancel();
      await until(() => client.state.connection.status === "idle");
      expect(gateway.sockets.every((socket) => socket.readyState === 3)).toBe(true);
      await until(() => setup.current.phase === "found");
    });
  });

  it("F-492: a read of bots left from an earlier selection of the same address doesn't complete setup", async () => {
    const gateway = new FakeGateway();
    // The earlier selection is Advanced's, with no device token; setup's own pairs.
    gateway.connectReply = (params) =>
      (params as { auth?: { bootstrapToken?: string } }).auth?.bootstrapToken === CODE
        ? { ok: true, payload: helloOk(SCOPES, TOKEN) }
        : { ok: true, payload: helloOk(SCOPES) };
    const list = gateway.handlers["agents.list"]!;
    const client = makeClient(gateway);
    await withLocalSetup(client, async (setup) => {
      await client.connect({ url: URL, token: "typed-shared-token-0123456789" });
      await until(() => client.state.discovery.status === "ready");
      // Setup connects to the same address; its own bots are slow to come.
      const bots = deferred<object>();
      gateway.handlers["agents.list"] = () => bots.promise;
      const phases: string[] = [];
      client.store.subscribe(() => phases.push(setup.current.phase));
      await setup.connect();
      await until(
        () => gateway.connects.length === 2 && client.state.connection.status === "connected",
      );
      await sleep(100);
      expect(phases).not.toContain("done");
      expect(setup.current.phase).toBe("connecting");
      bots.resolve((await list({})) as object);
      await until(() => setup.current.phase === "done");
    });
  });
});

describe("a saved pairing that went or came after the person agreed", () => {
  it("F-492: a pairing gone at the handshake sends nothing and goes back to the card for a new pairing", async () => {
    const gateway = new FakeGateway();
    const storage = memoryStorage({ [tokenKey(URL)]: READ_TOKEN });
    const host = testHost(gateway, storage);
    host.createWebSocket = (url) => {
      storage.data.delete(tokenKey(URL));
      return gateway.createWebSocket(url);
    };
    const client = makeClient(gateway, storage, host);
    await withLocalSetup(client, async (setup) => {
      expect(setup.current.look?.access).toBe("paired");
      await setup.connect();
      await until(() => setup.current.phase === "found" && setup.current.look?.access === "new");
      expect(gateway.connects).toHaveLength(0);
      // What the first screen renders from (packages/ui/test/connect-screen-setup.test.ts).
      expect(client.state.connection.error?.code).toBe("SETUP_PAIRING_GONE");
    });
  });

  it("F-492: a pairing that appeared after the Pair dialog goes back to the card, for consent to reuse it", async () => {
    const gateway = new FakeGateway();
    const storage = memoryStorage();
    const client = makeClient(gateway, storage);
    const hasDeviceToken = client.hasDeviceToken.bind(client);
    let reads = 0;
    client.hasDeviceToken = (url) => {
      // The look reads first; the second read is Connect's, after the dialog.
      if (++reads === 2) storage.data.set(tokenKey(URL), READ_TOKEN);
      return hasDeviceToken(url);
    };
    await withLocalSetup(client, async (setup) => {
      expect(setup.current.look?.access).toBe("new");
      await setup.connect();
      expect(gateway.sockets).toHaveLength(0);
      expect(setup.current.phase).toBe("found");
      expect(setup.current.look?.access).toBe("paired");
    });
  });

  it("F-492: a pairing that appeared at the handshake sends neither credential, and the card asks again", async () => {
    const gateway = new FakeGateway();
    const storage = memoryStorage();
    const host = testHost(gateway, storage);
    host.createWebSocket = (url) => {
      storage.data.set(tokenKey(URL), READ_TOKEN);
      return gateway.createWebSocket(url);
    };
    const client = makeClient(gateway, storage, host);
    await withLocalSetup(client, async (setup) => {
      expect(setup.current.look?.access).toBe("new");
      await setup.connect();
      await until(
        () =>
          gateway.connects.length > 0 ||
          (setup.current.phase === "found" && setup.current.look?.access === "paired"),
      );
      expect(gateway.connects).toHaveLength(0);
      expect(setup.current.phase).toBe("found");
      expect(setup.current.look?.access).toBe("paired");
      expect(client.state.connection.error?.code).toBe("SETUP_PAIRING_APPEARED");
      expect(JSON.stringify(client.state)).not.toContain(CODE);
    });
  });
});

const platform = process.platform;
const posix = platform === "darwin" || platform === "linux";
let scratch: string;
let helper: string | null = null;
beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "clawtrate-local-connect-")));
  if (platform === "darwin") {
    helper = join(scratch, "helper");
    execFileSync("/usr/bin/xcrun", localGatewayBuild(helper));
  }
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A profile whose gateway lock and state database exist, as a running gateway's would. */
function profileFiles(home: string, folder: string, lock: object) {
  const own = join(home, folder, "tmp", `openclaw-${process.geteuid!()}`);
  mkdirSync(own, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, folder, "state"), { mode: 0o700 });
  writeFileSync(join(own, "gateway.state.lock"), JSON.stringify(lock), { mode: 0o600 });
  writeFileSync(join(home, folder, "state", "openclaw.sqlite"), "", { mode: 0o600 });
}

describe.skipIf(!posix)("local connect's send gate, with a listener of the test's own", () => {
  for (const mode of ["bootstrap", "saved-token"] as const) {
    it(`F-492: a same-account listener that isn't OpenClaw gets no byte of any setup socket (${mode})`, async () => {
      // This process holds the accepted end: (e) passes, and (f) refuses it.
      let bytes = 0;
      let accepted = 0;
      const listener = createServer((socket) => {
        accepted += 1;
        socket.on("data", (data) => (bytes += data.length));
        socket.on("error", () => {});
      });
      await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
      const port = (listener.address() as { port: number }).port;
      const url = `ws://127.0.0.1:${port}`;
      const gateway = new FakeGateway();
      const storage = memoryStorage(mode === "saved-token" ? { [tokenKey(url)]: READ_TOKEN } : {});
      const client = makeClient(gateway, storage);
      const lines: string[] = [];
      try {
        await withLocalSetup(
          client,
          async (setup) => {
            await setup.connect();
            // Each socket it opens, retries included, is dialled and refused before its first byte.
            await until(() => lines.length >= 1, 15_000);
            await sleep(500);
            // A retry may be on its way through its proof as this counts.
            expect(accepted).toBeGreaterThanOrEqual(lines.length);
            expect(bytes).toBe(0);
            expect(gateway.sockets).toHaveLength(0);
            expect(lines[0]).toBe(
              `[setup] couldn't verify what is listening at port ${port} (module)`,
            );
          },
          { pid: 4242 },
          {
            port,
            log: (line) => lines.push(line),
            localConnect: (home) => {
              profileFiles(home, ".openclaw", { pid: process.pid, role: "gateway", port });
              return { home, helper, platform, sandboxed: true };
            },
          },
        );
      } finally {
        listener.close();
      }
    }, 30_000);
  }
});

const BIN = openclawBin();

/** A client of the app's own kind, whose every socket goes through local connect's connector. */
function provedClient(gateway: DevGateway, port: number, refused: string[]) {
  const local: LocalConnect = { home: gateway.home, helper, platform, sandboxed: true };
  const sockets = provedSockets(
    port,
    proveFor(local, FOLDER, port, (why) => refused.push(why)),
  );
  const host = createNodeHost({
    dataDir: mkdtempSync(join(scratch, "app-")),
    client: { displayName: "Clawtrate Test", version: "0.0.0", platform: "test" },
  });
  return new ClawtrateClient(
    { ...host, createWebSocket: sockets.createWebSocket, secureCredentials: async () => true },
    { reconnect: { initialMs: 50, maxMs: 200 }, fullAccess: true },
  );
}

/** Connects with the settings file's token, through the connector, until `refused` fills. */
async function refusedThrough(gateway: DevGateway, port: number, token: string) {
  const refused: string[] = [];
  const client = provedClient(gateway, port, refused);
  try {
    await client.start({ resume: false });
    void client.connect({ url: `ws://127.0.0.1:${port}`, token }).catch(() => {});
    await until(() => refused.length >= 2, 30_000);
  } finally {
    client.stop();
  }
  return refused;
}

describe.skipIf(!BIN || !posix)(
  "F-492 on a development gateway: local connect's send gate",
  { timeout: 300_000 },
  () => {
    let gateway: DevGateway;
    let token: string;
    beforeAll(async () => {
      gateway = await startGateway(BIN!, { approval: false });
      // The token as Connect will read it: the reader, on the instance's own settings file.
      const read = await readLocalSettings({
        home: gateway.home,
        platform,
        helper,
        sandboxed: true,
        worker: pathToFileURL(join(import.meta.dirname, "../src/setup/settings-parse.ts")),
      });
      const found = read.find((entry) => entry.profile === "clawtrate")?.outcome;
      if (found?.kind !== "found" || found.port !== gateway.port)
        throw new Error("the reader didn't find the instance's own gateway");
      token = found.token.reveal();
    }, 300_000);
    afterAll(async () => {
      await gateway?.remove();
    });

    it("two direct connections pass (e) and (f), each within the deadline", async () => {
      for (let round = 0; round < 2; round += 1) {
        const socket = connect({ host: "127.0.0.1", port: gateway.port });
        await new Promise<void>((done) => socket.once("connect", () => done()));
        const started = Date.now();
        const proof = await proveLocalGateway({
          home: gateway.home,
          folder: FOLDER,
          port: gateway.port,
          localPort: socket.localPort!,
          platform,
          helper,
          sandboxed: true,
        });
        socket.destroy();
        expect(proof).toEqual({ proved: true });
        expect(Date.now() - started).toBeLessThan(2_000);
      }
    });

    it("F-492: a same-account forwarding proxy gets no upgrade and no credential", async () => {
      const port = await freePort();
      const proxy = await standIn(port, gateway.port);
      try {
        const refused = await refusedThrough(gateway, port, token);
        expect(refused[0]).toBe("module");
        expect(proxy.accepted()).toBeGreaterThanOrEqual(2);
        expect(proxy.bytes()).toBe(0);
      } finally {
        await proxy.stop();
      }
    });

    it.skipIf(platform !== "darwin")(
      "F-492: a same-account proxy that a sandbox denies the profile's folder gets no upgrade and no credential",
      async () => {
        // The profile only denies: everything is allowed as without it, except reading the folder.
        const profile = `(version 1)(allow default)(deny file-read* (subpath "${join(gateway.home, FOLDER)}"))`;
        expect(profile).toMatch(
          /^\(version 1\)\(allow default\)\(deny file-read\* \(subpath "[^"()]+"\)\)$/,
        );
        const port = await freePort();
        const proxy = await standIn(port, gateway.port, ["/usr/bin/sandbox-exec", "-p", profile]);
        try {
          const refused = await refusedThrough(gateway, port, token);
          expect(refused[0]).toBe("module");
          expect(proxy.bytes()).toBe(0);
        } finally {
          await proxy.stop();
        }
      },
    );

    it.skipIf(!process.env.CLAWTRATE_OTHER_ACCOUNT_LISTENER)(
      "F-492: another account's listener gets no upgrade and no credential (hosted runner)",
      async () => {
        // Set up by CI on a discarded hosted runner: a listener run as `nobody`, logging what it got.
        const [port, log] = process.env.CLAWTRATE_OTHER_ACCOUNT_LISTENER!.split(":");
        const refused = await refusedThrough(gateway, Number(port), token);
        // Its descriptors are invisible to this account, so no holder of this account is found.
        expect(refused[0]).toBe("holder");
        const lines = readFileSync(log!, "utf8").split("\n");
        expect(lines).toContain("accepted");
        expect(lines.some((line) => line.startsWith("bytes "))).toBe(false);
      },
    );

    it("pairs through proved sockets with all six scopes and no approval, at OpenClaw's default", async () => {
      const refused: string[] = [];
      const client = provedClient(gateway, gateway.port, refused);
      try {
        await client.start({ resume: false });
        await client.connect({ url: `ws://127.0.0.1:${gateway.port}`, token });
        await until(() => client.state.connection.status === "connected", 60_000);
        expect([...client.state.connection.scopes].sort()).toEqual([...FULL_SCOPES].sort());
        expect(client.state.connection.pairing).toBe(null);
        expect(refused).toEqual([]);
      } finally {
        client.stop();
      }
    });

    it("F-492: Connect proves each setup socket twice, then sends its code", async () => {
      const lines: string[] = [];
      const client = provedClient(gateway, gateway.port, []);
      await withLocalSetup(
        client,
        async (setup) => {
          await setup.connect();
          await until(() => setup.current.phase === "failed", 60_000);
          // Both proofs passed, so the code went: the gateway itself refused the fixture's code.
          expect(setup.current.failure?.kind).toBe("code-refused");
          expect(lines).toEqual([]);
        },
        { pid: 4242 },
        {
          port: gateway.port,
          stateDir: join(gateway.home, FOLDER),
          log: (line) => lines.push(line),
          localConnect: () => ({ home: gateway.home, helper, platform, sandboxed: true }),
        },
      );
    });

    it("F-492: a socket proved when dialled but not before its credential sends no code", async () => {
      const lines: string[] = [];
      const client = provedClient(gateway, gateway.port, []);
      const folder = join(gateway.home, FOLDER);
      // While the request is signed, after the dial's proof: the profile's folder is no longer
      // private, so the proof before the credential refuses it.
      const host = (client as unknown as { host: ClawtrateHost }).host;
      const sign = host.signer.sign;
      host.signer = {
        ...host.signer,
        sign: async (payload) => {
          chmodSync(folder, 0o750);
          return sign(payload);
        },
      };
      try {
        await withLocalSetup(
          client,
          async (setup) => {
            await setup.connect();
            await until(() => setup.current.phase === "failed", 60_000);
            expect(setup.current.failure?.kind).toBe("changed");
            expect(lines).toContain(
              `[setup] couldn't verify what is listening at port ${gateway.port} (mode)`,
            );
          },
          { pid: 4242 },
          {
            port: gateway.port,
            stateDir: folder,
            log: (line) => lines.push(line),
            localConnect: () => ({ home: gateway.home, helper, platform, sandboxed: true }),
          },
        );
      } finally {
        chmodSync(folder, 0o700);
      }
    });

    // Last: it stops the instance.
    it("F-492: a listener holding the port while the instance is stopped gets no upgrade and no credential", async () => {
      await gateway.stop();
      const holder = await standIn(gateway.port, null);
      try {
        const refused = await refusedThrough(gateway, gateway.port, token);
        // The stopped gateway's lock is gone, or names a process that no longer holds it.
        expect(["lock", "module"]).toContain(refused[0]);
        expect(holder.bytes()).toBe(0);
      } finally {
        await holder.stop();
      }
    });
  },
);

describe.skipIf(!BIN || !posix)(
  "local connect on a development gateway with local auto-approval off",
  { timeout: 300_000 },
  () => {
    let gateway: DevGateway;
    beforeAll(async () => {
      gateway = await startGateway(BIN!, { approval: true });
    }, 300_000);
    afterAll(async () => {
      await gateway?.remove();
    });

    it("pairs with all six after one approval by the gateway's owner", async () => {
      const refused: string[] = [];
      const client = provedClient(gateway, gateway.port, refused);
      try {
        await client.start({ resume: false });
        await client.connect({ url: `ws://127.0.0.1:${gateway.port}`, token: gateway.token });
        await until(() => client.state.connection.pairing !== null, 60_000);
        const { requestId, requestedScopes } = client.state.connection.pairing!;
        expect([...requestedScopes].sort()).toEqual([...FULL_SCOPES].sort());
        expect(gateway.run(["devices", "approve", requestId]).status).toBe(0);
        await until(() => client.state.connection.status === "connected", 60_000);
        expect([...client.state.connection.scopes].sort()).toEqual([...FULL_SCOPES].sort());
        expect(refused).toEqual([]);
      } finally {
        client.stop();
      }
    });
  },
);
