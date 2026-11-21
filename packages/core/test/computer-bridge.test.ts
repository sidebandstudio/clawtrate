// A viewer's bridge session and its Computer pane: closing the pane's task leaves the pane
// (control given back, the view ended), and closing another task leaves it alone.

import { describe, expect, it, vi } from "vitest";
import { createBridgeSession } from "../src/bridge.ts";
import { KEY, openTask } from "./client-harness.ts";

describe("closing a task with the Computer tab shown", () => {
  it("F-145: leaves this viewer's pane on that task first; closing another task does not", async () => {
    const { client } = await openTask();
    const leave = vi.spyOn(client, "computerLeave");
    const viewer = createBridgeSession(client);
    await viewer.apply({ type: "openSession", key: KEY });
    await viewer.apply({ type: "openSession", key: "agent:otto:other" });
    await viewer.apply({ type: "computerShow", key: KEY });
    const id = viewer.computerViewer()!;
    await viewer.apply({ type: "closeSession", key: "agent:otto:other" });
    expect(leave).not.toHaveBeenCalled();
    await viewer.apply({ type: "closeSession", key: KEY });
    expect(leave).toHaveBeenCalledWith(id);
    viewer.dispose();
    client.stop();
  });
});
