// F-501 F-502 F-505: how the host offers setting OpenClaw up (docs/design/
// setup.md §2, §10): only after a look found nothing, only after its own
// dialog, within the prepared operation's two minutes, with the look's file
// checks again after it, one install at a time through the look that
// follows, and that look for the gateway just set up alone. The installer
// here is a stand-in object; the installer itself is tested in
// setup-install.test.ts.

import { ClawtrateClient, type SetupInstall, type SetupState } from "@clawtrate/core";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeGateway, memoryStorage, testHost } from "../../../packages/core/test/fake-gateway.ts";
import {
  INSTALL_CONFIRMATION,
  OPERATION_LIFETIME_MS,
  SetupController,
  type Confirmation,
} from "../src/setup/controller.ts";
import type { InstallOutcome, Installer } from "../src/setup/install.ts";
import { checkRequest, sessionEnv, type ProgramRequest } from "../src/setup/programs.ts";
import { anythingHere } from "../src/setup/look.ts";
import { quitGate } from "../src/setup/quit.ts";
import type { Opened } from "../src/setup/sandbox.ts";
import { productionWorld } from "../src/setup/world.ts";
import { authJson, qrJson, statusJson, VERSION_LINE } from "./fixtures/openclaw-outputs.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clawtrate-install-controller-"));
  mkdirSync(join(dir, "home"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Fake = {
  setup: SetupController;
  client: ClawtrateClient;
  dialogs: Confirmation[];
  /** How many times an installer's `run` started. */
  runs: number;
  phases: SetupState["phase"][];
  /** Every program the look asked to run. */
  asked: ProgramRequest[];
  /** Lets a held installer finish. */
  release: () => void;
};

const PORT = 40123;
const LISTENER = 4242;
const CODE = "Xq3v8Lw0eXk2Rj9TaNf5Hc1UbYm7Pd4GsZi6Ko2EaVr";

/**
 * A controller whose look finds nothing (no program in a temporary home)
 * until an install, and then the installed program, answering for `port` on
 * the clawtrate profile; its installer plays the steps, then ends as
 * `outcome`.
 */
function harness(
  options: {
    answer?: boolean | (() => Promise<boolean>);
    outcome?: InstallOutcome;
    installer?: boolean;
    now?: () => number;
    /** The installer waits for `release`. */
    hold?: boolean;
    /** The port the installed gateway's status reports. */
    answersOn?: number;
    /** A proven early leftover's program, which the look is also given as its first place. */
    leftover?: string | null;
    /** The host's own check of every program the look starts, as the real runner makes it, with this session snapshot. */
    checked?: boolean;
    session?: Record<string, string>;
    /** The installed gateway answers only programs given exactly this bus. */
    needsBus?: string;
    /** The look's file checks after the dialog can't be made. */
    unreadable?: boolean;
    /** Called as the world is opened after the dialog. */
    afterDialogOpen?: () => void;
    platform?: "darwin" | "linux";
  } = {},
): Fake {
  const client = new ClawtrateClient(testHost(new FakeGateway(), memoryStorage()));
  const dialogs: Confirmation[] = [];
  const phases: SetupState["phase"][] = [];
  const asked: ProgramRequest[] = [];
  let release = () => {};
  const held = new Promise<void>((done) => (release = done));
  const fake: Fake = {
    setup: null!,
    client,
    dialogs,
    runs: 0,
    phases,
    asked,
    release: () => release(),
  };
  const home = join(dir, "home");
  const program = join(dir, "openclaw", "bin", "openclaw");
  const world = {
    ...productionWorld({ home, appData: dir, platform: options.platform ?? "darwin" }),
    candidates: [
      ...(options.leftover ? [options.leftover] : []),
      join(home, ".openclaw/bin/openclaw"),
    ],
    deep: true,
  };
  const opened = (): Opened => ({
    world,
    run: async (request: ProgramRequest) => {
      asked.push(request);
      if (options.checked) checkRequest(request, options.session ?? {});
      const args = request.args.join(" ");
      if (options.needsBus && request.env.DBUS_SESSION_BUS_ADDRESS !== options.needsBus)
        return { exitCode: 1, stdout: "", timedOut: false, tooLarge: false, failed: false };
      const port = options.answersOn ?? PORT;
      const stdout = args.endsWith("--version")
        ? VERSION_LINE
        : args.includes("gateway status")
          ? statusJson({ port, rpcUrl: `ws://127.0.0.1:${port}` })
          : args.includes(" qr ")
            ? qrJson(`ws://127.0.0.1:${port}`, CODE, Date.now() + 600_000)
            : authJson();
      return { exitCode: 0, stdout, timedOut: false, tooLarge: false, failed: false };
    },
    identify: (pid) =>
      pid === LISTENER
        ? { state: "alive", identity: "started" }
        : { state: "exited", how: "absent" },
  });
  fake.setup = new SetupController({
    client,
    open: async () => {
      if (fake.dialogs.length > 0) options.afterDialogOpen?.();
      if (options.unreadable && fake.dialogs.length > 0) throw new Error("EACCES");
      return opened();
    },
    stopPrograms: () => {},
    confirm: async (confirmation) => {
      dialogs.push(confirmation);
      return typeof options.answer === "function" ? options.answer() : (options.answer ?? true);
    },
    ...(options.now ? { now: options.now } : {}),
    installer:
      options.installer === false
        ? null
        : () =>
            ({
              run: async (progress: (install: SetupInstall) => void) => {
                fake.runs += 1;
                if (options.hold) await held;
                for (const step of [0, 1, 2, 3, 4])
                  progress({ step, nodeChecked: step > 1, failure: null });
                const outcome = options.outcome ?? {
                  ok: true,
                  port: PORT,
                  program,
                  env: {},
                };
                if (outcome.ok) {
                  // What the install made: its program, where the look finds it.
                  mkdirSync(join(dir, "openclaw", "bin"), { recursive: true });
                  writeFileSync(program, "#!/bin/sh\n");
                  chmodSync(program, 0o755);
                }
                return outcome;
              },
              leftoverProgram: async () => options.leftover ?? null,
            }) as unknown as Installer,
  });
  client.store.subscribe((state) => {
    const phase = state.setup?.phase;
    if (phase && phases.at(-1) !== phase) phases.push(phase);
  });
  return fake;
}

/** Waits until `ready` holds: an event of the controller's, never a fixed delay. */
async function until(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
    await new Promise((done) => setTimeout(done, 5));
  }
}

async function notFound(fake: Fake): Promise<void> {
  await fake.setup.look();
  expect(fake.setup.current.look?.outcome).toBe("not-found");
}

describe("F-501: nothing is downloaded or run before the host's own dialog", () => {
  it("F-501: the dialog's words are the design's, and No leaves the not-found card with nothing made", async () => {
    const fake = harness({ answer: false });
    await notFound(fake);
    await fake.setup.install();
    expect(fake.dialogs).toEqual([INSTALL_CONFIRMATION]);
    expect(INSTALL_CONFIRMATION).toEqual({
      message: "Set up OpenClaw on this computer?",
      detail:
        "Clawtrate checks the OpenClaw and Node.js downloads against fingerprints built into this version before extracting either archive. Setup also installs code from npm that Clawtrate hasn't pinned or verified. That code can run with your account's permissions.",
      confirm: "Set up OpenClaw",
    });
    expect(fake.runs).toBe(0);
    expect(fake.setup.current).toMatchObject({ phase: "found", look: { outcome: "not-found" } });
  });

  it("F-501: a dialog answered after the prepared operation expired runs nothing and says it expired", async () => {
    let now = 1_000;
    const fake = harness({ now: () => now });
    await notFound(fake);
    const answering = fake.setup.install();
    now += OPERATION_LIFETIME_MS + 1;
    await answering;
    expect(fake.runs).toBe(0);
    expect(fake.setup.current).toMatchObject({
      phase: "install-failed",
      install: { failure: { kind: "expired", retry: false, cleanup: "none" } },
    });
  });

  it("F-501: an OpenClaw that appears while the dialog is open ends it before anything is downloaded, and is left byte for byte", async () => {
    const program = join(dir, "home", ".openclaw/bin/openclaw");
    const fake = harness({
      answer: async () => {
        // A program and a default state, arriving between the look and the answer.
        mkdirSync(join(dir, "home", ".openclaw/bin"), { recursive: true });
        writeFileSync(program, "#!/bin/sh\nthe person's own\n");
        chmodSync(program, 0o755);
        return true;
      },
    });
    await notFound(fake);
    const asked = fake.asked.length;
    await fake.setup.install();
    expect(fake.runs).toBe(0);
    // Found, and never run, written or removed.
    expect(fake.asked.length).toBe(asked);
    expect(readFileSync(program, "utf8")).toBe("#!/bin/sh\nthe person's own\n");
    expect(fake.setup.current).toMatchObject({
      phase: "install-failed",
      install: { failure: { kind: "changed", step: -1, retry: false } },
    });
  });

  it("F-501: it is offered only after a look found nothing, and only where the host sets OpenClaw up", async () => {
    const fake = harness();
    await expect(fake.setup.install()).rejects.toThrow(/nothing to set up/);
    expect(fake.dialogs).toEqual([]);
    const none = harness({ installer: false });
    await notFound(none);
    await expect(none.setup.install()).rejects.toThrow(/doesn't set OpenClaw up/);
    expect(none.dialogs).toEqual([]);
  });

  it("F-502: an earlier attempt of Clawtrate's own, proven by the installer, isn't taken for an OpenClaw: the card says setting up removes it", async () => {
    const leftover = join(dir, "openclaw", "bin", "openclaw");
    mkdirSync(join(dir, "openclaw", "bin"), { recursive: true });
    writeFileSync(leftover, "#!/bin/sh\n");
    chmodSync(leftover, 0o755);
    const fake = harness({ leftover });
    await fake.setup.look();
    expect(fake.setup.current.look).toMatchObject({ outcome: "not-found", leftover: true });
    expect(fake.asked).toEqual([]);
  });
});

describe("F-502 F-505: the steps, then the look of the gateway just set up", () => {
  it("F-502 F-505: after yes the steps are published in order, then the look of the clawtrate profile alone, with its installed program, finds it running on its port, and says nothing of who installed it", async () => {
    const fake = harness();
    await notFound(fake);
    const steps: number[] = [];
    fake.client.store.subscribe((state) => {
      const step = state.setup?.install?.step;
      if (state.setup?.phase === "installing" && step !== undefined && steps.at(-1) !== step)
        steps.push(step);
    });
    await fake.setup.install();
    expect(fake.runs).toBe(1);
    expect(steps).toEqual([0, 1, 2, 3, 4]);
    expect(fake.phases).toEqual([
      "looking",
      "found",
      "confirming",
      "installing",
      "looking",
      "found",
    ]);
    expect(fake.setup.current.look).toMatchObject({
      outcome: "running",
      profile: "clawtrate",
      port: PORT,
    });
    // No ownership label until the service manager's effective command and main process prove it.
    expect(fake.setup.current.look).not.toHaveProperty("managed");
    // No command of the default profile's, and no deep status.
    expect(fake.asked.length).toBeGreaterThan(0);
    for (const request of fake.asked) {
      expect(request.program).toBe(join(dir, "openclaw", "bin", "openclaw"));
      expect(request.args.slice(0, 2)).toEqual(["--profile", "clawtrate"]);
      expect(request.args).not.toContain("--deep");
    }
  });

  it("F-505: on Linux the look of the gateway just set up passes the host's own program check with the session's bus, and finds it running", async () => {
    const session = {
      XDG_RUNTIME_DIR: "/run/user/1001",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1001/bus",
    };
    const fake = harness({
      checked: true,
      session,
      platform: "linux",
      outcome: {
        ok: true,
        port: PORT,
        program: join(dir, "openclaw", "bin", "openclaw"),
        env: session,
      },
    });
    await notFound(fake);
    await fake.setup.install();
    expect(fake.setup.current.look).toMatchObject({
      outcome: "running",
      profile: "clawtrate",
      port: PORT,
    });
    // The session's bus reached every command of that look.
    for (const request of fake.asked) expect(request.env).toMatchObject(session);
  });

  it("F-505: on Linux a gateway whose status needs a non-default session bus is found, rechecked and given a code with that same bus, for exactly the install's address", async () => {
    const session = {
      XDG_RUNTIME_DIR: "/run/user/1002",
      DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/1002/other-bus,guid=${"5c".repeat(16)}`,
    };
    const fake = harness({
      checked: true,
      session,
      needsBus: session.DBUS_SESSION_BUS_ADDRESS,
      platform: "linux",
      outcome: {
        ok: true,
        port: PORT,
        program: join(dir, "openclaw", "bin", "openclaw"),
        env: session,
      },
    });
    const codes: string[] = [];
    fake.client.connectWithSetupCode = async (code) => {
      codes.push(code.url);
    };
    await notFound(fake);
    await fake.setup.install();
    expect(fake.setup.current.look).toMatchObject({ outcome: "running", port: PORT });
    const fromConnect = fake.asked.length;
    await fake.setup.connect();
    const connect = fake.asked.slice(fromConnect);
    // The rechecks (status and sign-in) and the code, each with the same bus.
    expect(connect.map((request) => request.args.slice(2, 4).join(" "))).toEqual(
      expect.arrayContaining(["gateway status", "config get", "qr --json"]),
    );
    for (const request of connect) expect(request.env).toMatchObject(session);
    expect(fake.setup.current.failure).toBeNull();
    expect(codes).toEqual([`ws://127.0.0.1:${PORT}`]);
  });

  it("F-505: the host's program check passes the bus only with exactly its own snapshot's values, and none without one", () => {
    const session = {
      XDG_RUNTIME_DIR: "/run/user/1001",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1001/bus",
    };
    const request: ProgramRequest = {
      program: "/usr/bin/true",
      args: ["--profile", "clawtrate", "--version"],
      env: session,
      cwd: "/tmp",
      timeoutMs: 1000,
      maxBytes: 1024,
    };
    expect(() => checkRequest(request, session)).not.toThrow();
    // A sandbox, another system or a development build: an empty snapshot.
    expect(() => checkRequest(request)).toThrow(/environment variable/);
    expect(() =>
      checkRequest(
        { ...request, env: { ...session, DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1001/x" } },
        session,
      ),
    ).toThrow(/environment variable/);
    expect(sessionEnv("linux", { ...session, DISPLAY: ":0" })).toEqual(session);
    expect(sessionEnv("darwin", session)).toEqual({});
    expect(sessionEnv("linux", { XDG_RUNTIME_DIR: "/run/user/1001;x" })).toEqual({});
  });

  it("F-505: a gateway that answers on another port than the install's is not offered", async () => {
    const elsewhere = harness({ answersOn: PORT + 1 });
    await notFound(elsewhere);
    await elsewhere.setup.install();
    expect(elsewhere.setup.current.look).toMatchObject({
      outcome: "cant-tell",
      reason: "endpoint",
    });
    await expect(elsewhere.setup.connect()).rejects.toThrow(/nothing to connect/);
  });

  it("F-501: after the dialog, look's file checks that can't be made stop it before anything is run, and aren't called a change", async () => {
    const fake = harness({ unreadable: true });
    await notFound(fake);
    await fake.setup.install();
    expect(fake.runs).toBe(0);
    expect(fake.setup.current).toMatchObject({
      phase: "install-failed",
      install: { failure: { kind: "unchecked", step: -1, retry: false, cleanup: "none" } },
    });
  });

  it("F-501: after the dialog, a place the file checks can't look into is not taken for nothing", async () => {
    const home = join(dir, "home");
    // Only places in the test's own home: nothing of this computer's is looked at.
    const world = {
      ...productionWorld({ home, appData: dir, platform: "darwin" }),
      candidates: [join(home, ".npm-global/bin/openclaw"), join(home, ".local/bin/openclaw")],
    };
    // A candidate's folder that can't be searched: its program can't be checked.
    mkdirSync(join(home, ".npm-global"));
    chmodSync(join(home, ".npm-global"), 0o600);
    try {
      expect(await anythingHere(world)).toBe("unreadable");
    } finally {
      chmodSync(join(home, ".npm-global"), 0o700);
    }
    expect(await anythingHere(world)).toBe("nothing");
  });

  it("F-501: a consent that expires while the file checks run after it starts nothing", async () => {
    let now = 1_000;
    let late = false;
    const fake = harness({
      now: () => now,
      afterDialogOpen: () => {
        // The file checks after the dialog take past the two minutes.
        if (!late) now += OPERATION_LIFETIME_MS + 1;
        late = true;
      },
    });
    await notFound(fake);
    await fake.setup.install();
    expect(fake.runs).toBe(0);
    expect(fake.setup.current).toMatchObject({
      phase: "install-failed",
      install: { failure: { kind: "expired", step: -1 } },
    });
  });

  it("F-502: closed for the app's quit, the controller starts nothing more: a dialog answered after it runs nothing", async () => {
    let answer: (yes: boolean) => void = () => {};
    const fake = harness({ answer: () => new Promise<boolean>((done) => (answer = done)) });
    await notFound(fake);
    const installing = fake.setup.install();
    // The dialog is open when the app quits.
    await until(() => fake.dialogs.length === 1, "the dialog opens");
    const closing = fake.setup.close();
    answer(true);
    await installing;
    await closing;
    expect(fake.runs).toBe(0);
    const asked = fake.asked.length;
    await fake.setup.look();
    expect(fake.asked.length).toBe(asked);
  });

  it("F-502: closed while an install runs, the quit waits for it, and no look follows it", async () => {
    const fake = harness({ hold: true });
    await notFound(fake);
    const asked = fake.asked.length;
    const installing = fake.setup.install();
    await until(() => fake.runs === 1, "the installer starts");
    expect(fake.setup.current.phase).toBe("installing");
    let closed = false;
    const closing = fake.setup.close().then(() => (closed = true));
    await new Promise((done) => setImmediate(done));
    // The operation is still under way: the quit waits for it.
    expect(closed).toBe(false);
    fake.release();
    await installing;
    await closing;
    expect(closed).toBe(true);
    expect(fake.asked.length).toBe(asked);
  });

  it("F-502: while an install runs, a look, Connect, a second install, Back and the first screen are refused or do nothing, and the install's own look still follows", async () => {
    const fake = harness({ hold: true });
    await notFound(fake);
    const running = fake.setup.install();
    await until(() => fake.runs === 1, "the installer starts");
    expect(fake.setup.current.phase).toBe("installing");
    await expect(fake.setup.look()).rejects.toThrow(/under way/);
    await expect(fake.setup.connect()).rejects.toThrow(/under way/);
    await expect(fake.setup.install()).rejects.toThrow(/under way/);
    fake.setup.cancel();
    fake.setup.reset();
    expect(fake.setup.current.phase).toBe("installing");
    expect(fake.dialogs).toHaveLength(1);
    fake.release();
    await running;
    expect(fake.runs).toBe(1);
    expect(fake.setup.current.look).toMatchObject({ outcome: "running", profile: "clawtrate" });
    // Released once the look after it is done.
    await fake.setup.look();
  });

  it("F-502: a failure is published with its step and record; Back looks again before anything else is offered", async () => {
    const failure = {
      kind: "onboard" as const,
      step: 2,
      exitCode: 1,
      classification: null,
      retry: false,
      cleanup: "kept" as const,
    };
    const fake = harness({ outcome: { ok: false, failure } });
    await notFound(fake);
    await fake.setup.install();
    expect(fake.setup.current).toMatchObject({ phase: "install-failed", install: { failure } });
    const looks = fake.phases.filter((phase) => phase === "looking").length;
    fake.setup.cancel();
    await until(
      () =>
        fake.phases.filter((phase) => phase === "looking").length === looks + 1 &&
        fake.setup.current.phase === "found",
      "Back's look ends",
    );
  });

  it("F-502: Try again is a new dialog and a new installer, only for an attempt that was removed", async () => {
    const removed = {
      kind: "download" as const,
      step: 0,
      exitCode: null,
      classification: null,
      retry: true,
      cleanup: "removed" as const,
    };
    const fake = harness({ outcome: { ok: false, failure: removed } });
    await notFound(fake);
    await fake.setup.install();
    await fake.setup.install();
    expect(fake.dialogs).toHaveLength(2);
    expect(fake.runs).toBe(2);

    const kept = {
      kind: "onboard" as const,
      step: 2,
      exitCode: 1,
      classification: null,
      retry: false,
      cleanup: "kept" as const,
    };
    const stuck = harness({ outcome: { ok: false, failure: kept } });
    await notFound(stuck);
    await stuck.setup.install();
    await expect(stuck.setup.install()).rejects.toThrow(/nothing to set up/);
    expect(stuck.dialogs).toHaveLength(1);
    expect(stuck.runs).toBe(1);
  });
});

describe("F-502: the app's quit while setting up drains", () => {
  it("F-502: every quit asked while setup drains is held, and the app quits once, after the drain", async () => {
    let drained: () => void = () => {};
    let quits = 0;
    const gate = quitGate(
      () => new Promise<void>((done) => (drained = done)),
      () => (quits += 1),
    );
    const prevented: boolean[] = [];
    const event = () => ({ preventDefault: () => void prevented.push(true) });
    expect(gate(event())).toBe(false);
    // The person quits again while it drains: held, not let through.
    expect(gate(event())).toBe(false);
    expect(gate(event())).toBe(false);
    expect(prevented).toHaveLength(3);
    expect(quits).toBe(0);
    drained();
    await new Promise((done) => setImmediate(done));
    expect(quits).toBe(1);
    // The quit the gate asked for goes ahead.
    expect(gate(event())).toBe(true);
    expect(prevented).toHaveLength(3);
  });
});
