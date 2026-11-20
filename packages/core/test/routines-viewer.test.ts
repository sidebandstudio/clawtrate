// A viewer's routine action against the host's own list: what the viewer last
// showed may be older than what the host has read since.

import { describe, expect, it } from "vitest";
import { createBridgeSession } from "../src/bridge.ts";
import { ADMIN_SCOPES, INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { grantingGateway, openTask, URL_A } from "./client-harness.ts";
import { memoryStorage, tokenKey, until } from "./fake-gateway.ts";

const JOB = "b848f781-dd42-4069-ba05-d104990bec2c";
const job = (enabled = true) => ({
  id: JOB,
  agentId: "main",
  name: "Morning digest",
  enabled,
  createdAtMs: 1,
  updatedAtMs: 2,
  schedule: { kind: "cron", expr: "0 8 * * *", tz: "America/New_York" },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Summarise yesterday." },
  delivery: { mode: "none" },
  state: {},
});

describe("a routine row's action from a viewer behind the host", () => {
  it("F-350 F-351 F-352: an action from rows of the last connection's list reaches no gateway, though the host has read the new one", async () => {
    const gateway = grantingGateway();
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gateway-1" });
    gateway.handlers["cron.status"] = () => ({ enabled: true });
    gateway.handlers["cron.list"] = () => ({ jobs: [job()], hasMore: false });
    gateway.handlers["cron.update"] = () => job(false);
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "device-token",
        grantedScopes: ADMIN_SCOPES,
        heldScopes: INTERACTIVE_SCOPES,
        adminHeld: true,
      }),
    });
    const { client } = await openTask({ gateway, storage });
    await until(() => client.state.connection.canAdmin);
    const viewer = createBridgeSession(client);
    await viewer.apply({ type: "refreshRoutines" });
    await until(() => client.state.routines.routines.length === 1);
    // The list the viewer's rows came from.
    const shown = client.state.routines.listedOn;
    // The connection drops and comes back; the host reads this connection's list
    // before the viewer has the snapshot that shows it.
    const connects = gateway.connects.length;
    gateway.sockets.at(-1)!.close();
    await until(() => gateway.connects.length > connects);
    await until(() => client.state.connection.status === "connected");
    await viewer.apply({ type: "refreshRoutines" });
    await until(() => client.state.routines.listedOn !== shown);
    expect(
      await viewer.apply({ type: "setRoutineEnabled", id: JOB, enabled: false, listedOn: shown }),
    ).toEqual({ status: "not-sent", reason: "gateway" });
    expect(await viewer.apply({ type: "runRoutineNow", id: JOB, listedOn: shown })).toEqual({
      status: "not-sent",
      reason: "gateway",
    });
    expect(await viewer.apply({ type: "removeRoutine", id: JOB, listedOn: shown })).toEqual({
      status: "not-sent",
      reason: "gateway",
    });
    expect(gateway.calls("cron.update")).toHaveLength(0);
    expect(gateway.calls("cron.run")).toHaveLength(0);
    expect(gateway.calls("cron.remove")).toHaveLength(0);
    // From rows of the list the host has now, the same action goes out.
    expect(
      await viewer.apply({
        type: "setRoutineEnabled",
        id: JOB,
        enabled: false,
        listedOn: client.state.routines.listedOn,
      }),
    ).toMatchObject({ status: "saved" });
    expect(gateway.calls("cron.update")).toHaveLength(1);
    viewer.dispose();
    client.stop();
  });
});
