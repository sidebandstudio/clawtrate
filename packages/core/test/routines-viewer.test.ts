// A viewer's routine action against the host's own list: what the viewer last
// showed may be older than what the host has read since.

import { describe, expect, it } from "vitest";
import { createBridgeSession } from "../src/bridge.ts";
import { fieldsOf, parseRoutine } from "../src/routines.ts";
import { ADMIN_SCOPES, INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { grantingGateway, openTask, URL_A } from "./client-harness.ts";
import { deferred, memoryStorage, tokenKey, until } from "./fake-gateway.ts";

const adminStorage = () =>
  memoryStorage({
    connection: JSON.stringify({ url: URL_A, token: null }),
    [tokenKey(URL_A)]: JSON.stringify({
      token: "device-token",
      grantedScopes: ADMIN_SCOPES,
      heldScopes: INTERACTIVE_SCOPES,
      adminHeld: true,
    }),
  });

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

async function switched() {
  const gateway = grantingGateway();
  let identity = "gateway-1";
  gateway.handlers["gateway.identity.get"] = () => ({ deviceId: identity });
  gateway.handlers["cron.status"] = () => ({ enabled: true });
  gateway.handlers["cron.list"] = () => ({ jobs: [job()], hasMore: false });
  const { client } = await openTask({ gateway, storage: adminStorage() });
  await until(() => client.state.connection.gatewayId === "gateway-1");
  const viewer = createBridgeSession(client);
  const reconnect = async () => {
    // Another gateway answers at the same address, with a routine by the same id.
    identity = "gateway-2";
    const connects = gateway.connects.length;
    gateway.sockets.at(-1)!.close();
    await until(() => gateway.connects.length > connects);
    await until(() => client.state.connection.gatewayId === "gateway-2");
  };
  return { gateway, client, viewer, reconnect };
}

describe("a zone change's read-back from a viewer behind the host", () => {
  it("F-196: a read-back sent after the host reached another gateway is refused, not confirmed", async () => {
    const { gateway, client, viewer, reconnect } = await switched();
    gateway.handlers["cron.get"] = () => job();
    await reconnect();
    // The viewer has not seen the new gateway yet, and names the one it wrote to.
    await expect(
      viewer.apply({ type: "readRoutine", id: JOB, gateway: "gateway-1" }),
    ).rejects.toThrow("Another gateway is connected now");
    expect(gateway.calls("cron.get")).toHaveLength(0);
    viewer.dispose();
    client.stop();
  });

  it("F-196: a read-back answered after a reconnect to another gateway is not confirmed", async () => {
    const { gateway, client, viewer, reconnect } = await switched();
    const held = deferred<unknown>();
    gateway.handlers["cron.get"] = () => held.promise;
    const read = viewer.apply({ type: "readRoutine", id: JOB, gateway: "gateway-1" });
    void read.catch(() => {});
    await until(() => gateway.calls("cron.get").length === 1);
    await reconnect();
    held.resolve(job());
    // The closed connection fails the read; the engine's epoch check stands behind it.
    await expect(read).rejects.toThrow();
    viewer.dispose();
    client.stop();
  });
});

describe("the editor's check of a save in doubt, from a viewer behind the host", () => {
  it("F-189: a find sent after the host reached another gateway is refused, not found or missing", async () => {
    const { gateway, client, viewer, reconnect } = await switched();
    gateway.handlers["cron.list"] = () => ({
      jobs: [{ ...job(), declarationKey: "clawtrate:draft-1" }],
      hasMore: false,
    });
    await reconnect();
    const lists = gateway.calls("cron.list").length;
    await expect(
      viewer.apply({
        type: "checkRoutineCreate",
        key: "draft-1",
        input: fieldsOf(parseRoutine(job())!),
        gateway: "gateway-1",
      }),
    ).rejects.toThrow("Another gateway is connected now");
    expect(gateway.calls("cron.list")).toHaveLength(lists);
    viewer.dispose();
    client.stop();
  });
});
