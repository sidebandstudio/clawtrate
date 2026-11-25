// #592: a read made right after a hello that the gateway answers as passing (it is still
// starting) is asked again by the client, a few times further apart and then once more on the
// gateway's next event; a refusal is not, and a try never outlives its connection.

import { describe, expect, it } from "vitest";
import { DISCOVERY_NOT_READY } from "../src/client.ts";
import { passingAnswer, READ_AGAIN_TRIES, readAgain } from "../src/read-again.ts";
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { grantingGateway, KEY, openTask, URL_B } from "./client-harness.ts";
import { GatewayError, sleep, until } from "./fake-gateway.ts";

/** The gateway's exact answer to `sessions.subscribe` while it starts (OpenClaw 2026.10.6). */
const REGISTRY_CHANGING = {
  code: "UNAVAILABLE",
  message:
    "AgentDatabaseRegistryChangedError: Agent database registry ownership is changing during discovery",
};
const TASKS = { sessions: [{ key: KEY, agentId: "otto", label: "Disk space" }], hasMore: false };

/** A connected client with the task open; `sessions.subscribe` answers by `fails(call)`. */
async function restarting(fails: (call: number) => boolean, readAgainMs = 5) {
  const gateway = grantingGateway();
  let calls = 0;
  gateway.handlers["sessions.subscribe"] = () => {
    calls += 1;
    if (fails(calls)) throw new GatewayError(REGISTRY_CHANGING);
    return { subscribed: true, list: TASKS };
  };
  gateway.handlers["agents.list"] = () => ({
    defaultId: "otto",
    agents: [{ id: "otto", identity: { name: "Otto" } }],
  });
  // The first connect loads; from the restart on, `fails` decides.
  let restarted = false;
  const answer = gateway.handlers["sessions.subscribe"];
  gateway.handlers["sessions.subscribe"] = (params) =>
    restarted ? answer(params) : { subscribed: true, list: TASKS };
  const { client } = await openTask({ gateway, client: { readAgainMs } });
  const seen: string[] = [];
  client.store.subscribe(({ discovery }) => {
    if (seen.at(-1) !== discovery.status) seen.push(discovery.status);
  });
  const restart = async () => {
    restarted = true;
    const connects = gateway.connects.length;
    gateway.dropAll();
    await until(() => gateway.connects.length > connects);
    await until(() => client.state.connection.status === "connected");
  };
  return { gateway, client, seen, restart, calls: () => calls };
}

describe("#592: a load the gateway wasn't ready for is read again", () => {
  it("UNAVAILABLE once, then fine: bots and tasks load with no error and nothing pressed", async () => {
    const { client, seen, restart, calls } = await restarting((call) => call === 1);
    await restart();
    await until(() => client.state.discovery.status === "ready");
    expect(calls()).toBe(2);
    expect(seen).not.toContain("error");
    expect(client.state.discovery).toMatchObject({ error: null, detail: null });
    expect(client.state.tasksByBot.otto?.map((task) => task.title)).toEqual(["Disk space"]);
    client.stop();
  });

  it("UNAVAILABLE every time: the tries stop at the bound, and the error says it plainly", async () => {
    const { client, restart, calls } = await restarting(() => true);
    await restart();
    await until(() => client.state.discovery.status === "error");
    expect(calls()).toBe(1 + READ_AGAIN_TRIES);
    expect(client.state.discovery.error).toBe(DISCOVERY_NOT_READY);
    // The gateway's own words are kept beside the plain ones.
    expect(client.state.discovery.detail).toContain("AgentDatabaseRegistryChangedError");
    // Nothing more is asked on its own: 5 + 10 + 20 + 40 ms of waits are long gone.
    await sleep(200);
    expect(calls()).toBe(1 + READ_AGAIN_TRIES);
    expect(client.state.discovery.status).toBe("error");
    client.stop();
  });

  it("a message sends while the failed load stands on the live connection", async () => {
    const { client, gateway, restart } = await restarting(() => true);
    await restart();
    await until(() => client.state.discovery.status === "error");
    const sends = gateway.calls("chat.send").length;
    client.sendMessage(KEY, "hello");
    await until(() => gateway.calls("chat.send").length === sends + 1);
    client.stop();
  });

  it("a refusal is not read again", async () => {
    for (const shape of [
      { code: "FORBIDDEN", message: "missing scope: operator.read" },
      { code: "INVALID_REQUEST", message: "invalid sessions.subscribe params" },
      { code: "NOT_FOUND", message: "unknown agent" },
      // UNAVAILABLE that names a lasting reason.
      { code: "UNAVAILABLE", message: "ended", details: { code: "INCOGNITO_SESSION_ENDED" } },
    ]) {
      const { client, gateway, restart, calls } = await restarting(() => true);
      gateway.handlers["sessions.subscribe"] = () => {
        throw new GatewayError(shape);
      };
      const before = gateway.calls("sessions.subscribe").length;
      await restart();
      await until(() => client.state.discovery.status === "error");
      await sleep(60);
      expect(gateway.calls("sessions.subscribe").length - before).toBe(1);
      expect(calls()).toBe(0);
      // Not the gateway being unready: its own words, as before.
      expect(client.state.discovery.error).toContain(shape.message);
      client.stop();
    }
  });

  it("a try after a reconnect does nothing", async () => {
    // The first answer fails, and its try again waits 150 ms; the connection drops meanwhile.
    const { client, gateway, restart, calls } = await restarting((call) => call === 1, 150);
    await restart();
    await until(() => calls() === 1);
    await restart();
    await until(() => client.state.discovery.status === "ready");
    expect(calls()).toBe(2);
    // The first connection's try, due now, is not made on the second.
    await sleep(250);
    expect(calls()).toBe(2);
    expect(gateway.calls("sessions.subscribe").length).toBe(3);
    client.stop();
  });

  it("a try after a switch to another gateway does nothing", async () => {
    const { client, restart, calls } = await restarting((call) => call === 1, 150);
    await restart();
    await until(() => calls() === 1);
    await client.connect({ url: URL_B, token: "t" });
    await until(() => client.state.discovery.status === "ready");
    expect(calls()).toBe(2);
    await sleep(250);
    expect(calls()).toBe(2);
    client.stop();
  });

  it("the next event from the gateway reads them once more, and only once", async () => {
    const { client, gateway, restart, calls, seen } = await restarting(() => true);
    await restart();
    await until(() => client.state.discovery.status === "error");
    expect(calls()).toBe(1 + READ_AGAIN_TRIES);
    const before = seen.length;
    gateway.emit("health", {});
    await until(() => calls() === 2 + READ_AGAIN_TRIES);
    await sleep(30);
    // The failure stays on screen while that read is out: nothing new to announce.
    expect(seen.slice(before)).toEqual([]);
    expect(client.state.discovery.status).toBe("error");
    // That read failed too: another event asks nothing; Retry is the person's.
    gateway.emit("health", {});
    await sleep(60);
    expect(calls()).toBe(2 + READ_AGAIN_TRIES);
    client.stop();
  });

  it("the next event's read can succeed, and clears the error", async () => {
    let ready = false;
    const { client, gateway, restart } = await restarting(() => !ready);
    await restart();
    await until(() => client.state.discovery.status === "error");
    ready = true;
    gateway.emit("health", {});
    await until(() => client.state.discovery.status === "ready");
    expect(client.state.discovery).toMatchObject({ error: null, detail: null });
    client.stop();
  });

  it("bots and the open task's history are read again too", async () => {
    const gateway = grantingGateway();
    const { client } = await openTask({ gateway });
    const fail = (method: string) => {
      const answer = gateway.handlers[method]!;
      let failed = false;
      gateway.handlers[method] = (params) => {
        if (!failed) {
          failed = true;
          throw new GatewayError(REGISTRY_CHANGING);
        }
        return answer(params);
      };
    };
    fail("agents.list");
    fail("chat.history");
    const histories = gateway.calls("chat.history").length;
    const connects = gateway.connects.length;
    gateway.dropAll();
    await until(() => gateway.connects.length > connects);
    await until(() => client.state.discovery.status === "ready");
    await until(() => gateway.calls("chat.history").length === histories + 2);
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    client.stop();
  });
});

describe("readAgain", () => {
  const unavailable = new GatewayProtocolRequestError({ code: "UNAVAILABLE", message: "busy" });

  it("takes a passing answer as passing, and a refusal or a lasting reason as lasting", () => {
    expect(passingAnswer(unavailable)).toBe(true);
    expect(
      passingAnswer(new GatewayProtocolRequestError({ code: "FORBIDDEN", message: "no" })),
    ).toBe(false);
    expect(
      passingAnswer(
        new GatewayProtocolRequestError({ code: "INVALID_REQUEST", message: "x", retryable: true }),
      ),
    ).toBe(true);
    expect(
      passingAnswer(
        new GatewayProtocolRequestError({
          code: "UNAVAILABLE",
          message: "ended",
          retryable: false,
          details: { code: "INCOGNITO_SESSION_ENDED" },
        }),
      ),
    ).toBe(false);
    expect(passingAnswer(new Error("socket closed"))).toBe(false);
  });

  it("waits longer each time, and never past the bound", async () => {
    const at: number[] = [];
    const start = Date.now();
    await expect(
      readAgain(
        () => {
          at.push(Date.now() - start);
          return Promise.reject(unavailable);
        },
        () => true,
        { firstMs: 20 },
      ),
    ).rejects.toBe(unavailable);
    expect(at).toHaveLength(1 + READ_AGAIN_TRIES);
    const waits = at.slice(1).map((each, index) => each - at[index]!);
    // 20, 40, 80, 160 ms, give or take the timer.
    waits.forEach((wait, index) => expect(wait).toBeGreaterThanOrEqual(20 * 2 ** index - 2));
  });

  it("makes no try once its connection is gone", async () => {
    let tries = 0;
    let current = true;
    const read = readAgain(
      () => {
        tries += 1;
        return Promise.reject(unavailable);
      },
      () => current,
      { firstMs: 30 },
    );
    current = false;
    await expect(read).rejects.toBe(unavailable);
    expect(tries).toBe(1);
  });
});
