// F-501 F-502 F-505: how the host offers setting OpenClaw up (docs/design/
// setup.md §2, §10): only after a look found nothing, only after its own
// dialog, within the prepared operation's two minutes, with the look's file
// checks again after it, one install at a time through the look that
// follows, and that look for the gateway just set up alone. The installer
// here is a stand-in object; the installer itself is tested in
// setup-install.test.ts.

import {
  ClawtrateClient,
  parseBridgeCommand,
  type SetupInstall,
  type SetupState,
} from "@clawtrate/core";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeGateway, memoryStorage, testHost } from "../../../packages/core/test/fake-gateway.ts";
import {
  INSTALL_CONFIRMATION,
  OPERATION_LIFETIME_MS,
  SetupController,
  type Confirmation,
} from "../src/setup/controller.ts";
import type { InstallOutcome, Installer } from "../src/setup/install.ts";
import { type ProgramRequest } from "../src/setup/programs.ts";
import { anythingHere } from "../src/setup/look.ts";
import { quitGate } from "../src/setup/quit.ts";
import type { Opened } from "../src/setup/sandbox.ts";
import { productionWorld } from "../src/setup/world.ts";
import { lookLocally, readToken } from "../src/setup/local-look.ts";

vi.mock("../src/setup/local-look.ts", () => ({
  lookLocally: vi.fn(),
  readToken: vi.fn(),
}));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clawtrate-install-controller-"));
  mkdirSync(join(dir, "home"));
  vi.resetAllMocks();
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
    /** The look's file checks after the dialog can't be made. */
    unreadable?: boolean;
    /** Called as the world is opened after the dialog. */
    afterDialogOpen?: () => void;
    withoutLocal?: boolean;
    recovery?: { id: string; action: "continue" | "replace" };
    recoveryCalls?: unknown[];
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
    ...productionWorld({ home, appData: dir, platform: "darwin" }),
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
      throw new Error("The local look must never run a program.");
    },
    identify: () => ({ state: "exited", how: "absent" }),
  });
  let installed = false;
  vi.mocked(lookLocally).mockImplementation(async () => {
    const port = options.answersOn ?? PORT;
    return {
      look: {
        outcome: installed ? "running" : "not-found",
        others: [],
        profile: installed ? "clawtrate" : null,
        port: installed ? port : null,
        access: installed ? "new" : null,
        version: null,
        listens: null,
        service: null,
        authMode: null,
        reason: null,
      },
      found: installed
        ? {
            profile: "clawtrate",
            folder: ".openclaw-clawtrate",
            identity: "1:1",
            port,
            url: `ws://127.0.0.1:${port}`,
          }
        : null,
    };
  });
  vi.mocked(readToken).mockResolvedValue(null);
  fake.setup = new SetupController({
    client,
    open: async () => {
      if (fake.dialogs.length > 0) options.afterDialogOpen?.();
      if (options.unreadable && fake.dialogs.length > 0) throw new Error("EACCES");
      return opened();
    },
    stopPrograms: () => {},
    ...(options.withoutLocal
      ? {}
      : {
          localConnect: {
            home,
            helper: null,
            platform: "darwin",
            sandboxed: true,
            worker: new URL("file:///unused"),
          },
        }),
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
              run: async (
                progress: (install: SetupInstall) => void,
                action?: string,
                id?: string,
              ) => {
                options.recoveryCalls?.push({ action, id });
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
                  installed = true;
                  // What the install made: its program, where the look finds it.
                  mkdirSync(join(dir, "openclaw", "bin"), { recursive: true });
                  writeFileSync(program, "#!/bin/sh\n");
                  chmodSync(program, 0o755);
                }
                return outcome;
              },
              leftoverProgram: async () => options.leftover ?? null,
              recovery: async () => (installed ? null : (options.recovery ?? null)),
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
        "Clawtrate downloads and sets up OpenClaw for your account only. It connects this Mac with full control.",
      confirm: "Set Up OpenClaw",
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
  it("F-502 F-505: the four steps lead straight to local Connect for the profile and port just installed", async () => {
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
    expect(fake.dialogs).toEqual([INSTALL_CONFIRMATION]);
    expect(steps).toEqual([0, 1, 2, 3, 4]);
    expect(fake.phases).toEqual([
      "looking",
      "found",
      "confirming",
      "installing",
      "looking",
      "found",
      "connecting",
      "failed",
    ]);
    expect(readToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ profile: "clawtrate", port: PORT }),
    );
    expect(fake.asked).toEqual([]);
  });

  it("F-505: an install never automatically pairs with a different port", async () => {
    const fake = harness({ answersOn: PORT + 1 });
    await notFound(fake);
    await fake.setup.install();
    expect(fake.setup.current.phase).toBe("found");
    expect(readToken).not.toHaveBeenCalled();
  });

  it("F-505: the bridge accepts only the two recovery actions and takes no path or profile", () => {
    expect(
      parseBridgeCommand({ type: "setupInstall", action: "replace", path: "ignored" }),
    ).toEqual({
      type: "setupInstall",
      action: "replace",
    });
    expect(() => parseBridgeCommand({ type: "setupInstall", action: "uninstall" })).toThrow(
      "Invalid setup install action.",
    );
  });

  it("F-505: a recorded install is shown on relaunch and Continue gets fresh consent", async () => {
    const calls: unknown[] = [];
    const fake = harness({ recovery: { id: "pending", action: "replace" }, recoveryCalls: calls });
    await fake.setup.lookAtStart();
    expect(fake.setup.current).toMatchObject({
      phase: "install-failed",
      install: { recovery: "replace" },
    });
    await expect(fake.setup.install()).rejects.toThrow(/nothing to set up/);
    await fake.setup.install("continue");
    expect(fake.dialogs).toHaveLength(1);
    expect(fake.dialogs[0]?.message).toBe("Continue setting up OpenClaw?");
    expect(calls).toEqual([{ action: "continue", id: "pending" }]);
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
    const scans = vi.mocked(lookLocally).mock.calls.length;
    answer(true);
    await installing;
    await closing;
    expect(fake.runs).toBe(0);
    const asked = fake.asked.length;
    await fake.setup.look();
    expect(fake.asked.length).toBe(asked);
    // The local path asks through lookLocally, not a program: that count is the one that matters.
    expect(vi.mocked(lookLocally).mock.calls.length).toBe(scans);
  });

  it("F-502: closed while an install runs, the quit waits for it, and no look follows it", async () => {
    const fake = harness({ hold: true });
    await notFound(fake);
    const asked = fake.asked.length;
    const installing = fake.setup.install();
    await until(() => fake.runs === 1, "the installer starts");
    expect(fake.setup.current.phase).toBe("installing");
    const scans = vi.mocked(lookLocally).mock.calls.length;
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
    expect(vi.mocked(lookLocally).mock.calls.length).toBe(scans);
    await fake.setup.look();
    expect(vi.mocked(lookLocally).mock.calls.length).toBe(scans);
  });

  it("F-502: closed for the app's quit, Back from a failed install and Start look at nothing", async () => {
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
    expect(fake.setup.current.phase).toBe("install-failed");
    await fake.setup.close();
    const scans = vi.mocked(lookLocally).mock.calls.length;
    fake.setup.cancel();
    await expect(fake.setup.start()).resolves.toBeUndefined();
    await new Promise((done) => setTimeout(done, 50));
    expect(vi.mocked(lookLocally).mock.calls.length).toBe(scans);
    expect(fake.setup.current.phase).toBe("install-failed");
  });

  it("F-502: while an install runs, a look, Connect, a second install, Back and the first screen are refused or do nothing, and the install's own look still follows", async () => {
    const fake = harness({ hold: true });
    await notFound(fake);
    const running = fake.setup.install();
    await until(() => fake.runs === 1, "the installer starts");
    expect(fake.setup.current.phase).toBe("installing");
    await expect(fake.setup.look()).rejects.toThrow(
      "OpenClaw is being set up. Wait until it finishes.",
    );
    await expect(fake.setup.connect()).rejects.toThrow(
      "OpenClaw is being set up. Wait until it finishes.",
    );
    await expect(fake.setup.install()).rejects.toThrow(
      "OpenClaw is being set up. Wait until it finishes.",
    );
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
