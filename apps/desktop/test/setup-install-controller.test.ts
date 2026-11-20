// F-501 F-502 F-505: how the host offers setting OpenClaw up (docs/design/
// setup.md §2, §10): only after a look found nothing, only after its own
// dialog, within the prepared operation's two minutes, and the look again
// once every step is done. The installer here is a stand-in object; the
// installer itself is tested in setup-install.test.ts.

import { ClawtrateClient, type SetupInstall, type SetupState } from "@clawtrate/core";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import { productionWorld } from "../src/setup/world.ts";

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
  made: number;
  phases: SetupState["phase"][];
};

/**
 * A controller whose look finds nothing (no program in a temporary home) and
 * whose installer plays `steps`, then ends as `outcome`.
 */
function harness(
  options: {
    answer?: boolean;
    outcome?: InstallOutcome;
    installer?: boolean;
    now?: () => number;
  } = {},
): Fake {
  const client = new ClawtrateClient(testHost(new FakeGateway(), memoryStorage()));
  const dialogs: Confirmation[] = [];
  const phases: SetupState["phase"][] = [];
  const fake: Fake = { setup: null!, client, dialogs, made: 0, phases };
  const home = join(dir, "home");
  const world = {
    ...productionWorld({ home, appData: dir, platform: "darwin" }),
    candidates: [],
    deep: false,
  };
  fake.setup = new SetupController({
    client,
    open: async () => ({
      world,
      run: async () => {
        throw new Error("the look runs no program here");
      },
      identify: () => ({ state: "exited", how: "absent" }),
    }),
    stopPrograms: () => {},
    confirm: async (confirmation) => {
      dialogs.push(confirmation);
      return options.answer ?? true;
    },
    ...(options.now ? { now: options.now } : {}),
    installer:
      options.installer === false
        ? null
        : () => {
            fake.made += 1;
            return {
              run: async (progress: (install: SetupInstall) => void) => {
                for (const step of [0, 1, 2, 3, 4])
                  progress({ step, nodeChecked: step > 1, failure: null });
                return options.outcome ?? { ok: true, port: 40123 };
              },
            } as unknown as Installer;
          },
  });
  client.store.subscribe((state) => {
    const phase = state.setup?.phase;
    if (phase && phases.at(-1) !== phase) phases.push(phase);
  });
  return fake;
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
        "Clawtrate checks the OpenClaw and Node.js downloads against fingerprints built into this version. Setup also installs code from npm that Clawtrate hasn't pinned or verified. That code can run with your account's permissions.",
      confirm: "Set up OpenClaw",
    });
    expect(fake.made).toBe(0);
    expect(fake.setup.current).toMatchObject({ phase: "found", look: { outcome: "not-found" } });
  });

  it("F-501: a dialog answered after the prepared operation expired runs nothing and says it changed", async () => {
    let now = 1_000;
    const fake = harness({ now: () => now });
    await notFound(fake);
    const original = fake.setup.install.bind(fake.setup);
    // The answer comes after the two minutes.
    const answering = original();
    now += OPERATION_LIFETIME_MS + 1;
    await answering;
    expect(fake.made).toBe(0);
    expect(fake.setup.current).toMatchObject({
      phase: "install-failed",
      install: { failure: { kind: "changed", retry: false } },
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
});

describe("F-502 F-505: the steps, then the look again", () => {
  it("F-502 F-505: after yes the steps are published in order, and when they are done the look runs again", async () => {
    const fake = harness();
    await notFound(fake);
    const steps: number[] = [];
    fake.client.store.subscribe((state) => {
      const step = state.setup?.install?.step;
      if (state.setup?.phase === "installing" && step !== undefined && steps.at(-1) !== step)
        steps.push(step);
    });
    await fake.setup.install();
    expect(fake.made).toBe(1);
    expect(steps).toEqual([0, 1, 2, 3, 4]);
    expect(fake.phases).toEqual([
      "looking",
      "found",
      "confirming",
      "installing",
      "looking",
      "found",
    ]);
  });

  it("F-502: a failure is published with its step and record; Back returns to the not-found card", async () => {
    const failure = {
      kind: "installer" as const,
      step: 1,
      exitCode: 1,
      classification: null,
      retry: true,
    };
    const fake = harness({ outcome: { ok: false, failure } });
    await notFound(fake);
    await fake.setup.install();
    expect(fake.setup.current).toMatchObject({ phase: "install-failed", install: { failure } });
    // Cancelling an install isn't offered: Back and the first screen do nothing while it runs.
    fake.setup.cancel();
    expect(fake.setup.current).toMatchObject({ phase: "found", look: { outcome: "not-found" } });
  });

  it("F-502: Try again is a new dialog and a new installer, only for an attempt that was removed", async () => {
    const removed = {
      kind: "download" as const,
      step: 0,
      exitCode: null,
      classification: null,
      retry: true,
    };
    const fake = harness({ outcome: { ok: false, failure: removed } });
    await notFound(fake);
    await fake.setup.install();
    await fake.setup.install();
    expect(fake.dialogs).toHaveLength(2);
    expect(fake.made).toBe(2);

    const kept = {
      kind: "onboard" as const,
      step: 2,
      exitCode: 1,
      classification: null,
      retry: false,
    };
    const stuck = harness({ outcome: { ok: false, failure: kept } });
    await notFound(stuck);
    await stuck.setup.install();
    await expect(stuck.setup.install()).rejects.toThrow(/nothing to set up/);
    expect(stuck.dialogs).toHaveLength(1);
    expect(stuck.made).toBe(1);
  });
});
