// The one setup host the bridge calls (apps/desktop/src/setup/host.ts), with
// stand-ins for both setups: another computer's setup starts only once this
// computer's cleanup has ended, so a late failure of it is never said over
// another computer's screens, which share the one slice.

import { describe, expect, it } from "vitest";

import type { SetupController } from "../src/setup/controller.ts";
import { SetupRouter } from "../src/setup/host.ts";
import type { RemoteSetup } from "../src/setup/remote.ts";

describe("the setup host's two setups", () => {
  it("looks on another computer only once this computer's connection was let go", async () => {
    const order: string[] = [];
    let release = () => {};
    const here = {
      reset: () => {
        order.push("here: reset");
        return new Promise<void>((resolve) => {
          release = () => {
            order.push("here: cleanup ended");
            resolve();
          };
        });
      },
    } as unknown as SetupController;
    const remote = {
      there: async (destination: string) => {
        order.push(`there: ${destination}`);
      },
    } as unknown as RemoteSetup;
    const router = new SetupRouter(here, remote);
    const looking = router.there("devbox");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["here: reset"]);
    release();
    await looking;
    expect(order).toEqual(["here: reset", "here: cleanup ended", "there: devbox"]);
  });

  for (const [name, meanwhile] of [
    ["Back", (router: SetupRouter) => router.cancel()],
    ["a reset", (router: SetupRouter) => router.reset()],
    ["a Look on this computer", (router: SetupRouter) => void router.look()],
    ["a newer Look on another computer", (router: SetupRouter) => void router.there("elsewhere")],
  ] as const) {
    it(`starts nothing over SSH for a Look on another computer when ${name} came while this computer's cleanup finished`, async () => {
      const looked: string[] = [];
      const releases: Array<() => void> = [];
      const here = {
        reset: () => new Promise<void>((resolve) => releases.push(resolve)),
        cancel: () => {},
        look: async () => {},
      } as unknown as SetupController;
      const remote = {
        active: false,
        reset: () => {},
        cancel: () => {},
        there: async (destination: string) => {
          looked.push(destination);
        },
      } as unknown as RemoteSetup;
      const router = new SetupRouter(here, remote);
      const first = router.there("devbox");
      meanwhile(router);
      for (const release of releases) release();
      await first;
      await new Promise((resolve) => setTimeout(resolve, 20));
      for (const release of releases) release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(looked).not.toContain("devbox");
    });
  }
});
