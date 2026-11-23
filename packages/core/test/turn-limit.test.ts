// The "Turn time limit" (F-100): chosen by the person, kept by the host, and the limit at which
// this client stops a run it started, as any Stop: "Stopping…" until the gateway confirms.

import { describe, expect, it } from "vitest";
import { ClawtrateClient } from "../src/client.ts";
import { INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { FAST, grantingGateway, KEY, URL_A, asShown } from "./client-harness.ts";
import { GatewayError, memoryStorage, sleep, testHost, tokenKey, until } from "./fake-gateway.ts";

function started(turnLimit: string | null) {
  const gateway = grantingGateway();
  const storage = memoryStorage({
    connection: JSON.stringify({ url: URL_A, token: null }),
    [tokenKey(URL_A)]: JSON.stringify({
      token: "device-token",
      grantedScopes: INTERACTIVE_SCOPES,
      heldScopes: INTERACTIVE_SCOPES,
    }),
    ...(turnLimit ? { "turn-limit-minutes": turnLimit } : {}),
  });
  let offset = 0;
  const host = { ...testHost(gateway, storage), now: () => Date.now() + offset };
  const client = new ClawtrateClient(host, FAST);
  return { client, gateway, storage, advance: (ms: number) => (offset += ms) };
}

describe("the turn time limit (F-100)", () => {
  it("F-100: is 50 minutes until the person chooses another, and the choice is kept for the next start", async () => {
    const first = started(null);
    await first.client.start();
    expect(first.client.state.turnLimitMinutes).toBe(50);
    await first.client.setTurnLimit(20);
    expect(first.client.state.turnLimitMinutes).toBe(20);
    expect(first.storage.data.get("turn-limit-minutes")).toBe("20");
    await expect(first.client.setTurnLimit(0)).rejects.toThrow(/whole number of minutes/);
    await expect(first.client.setTurnLimit(2.5)).rejects.toThrow(/whole number of minutes/);
    first.client.stop();
    const again = started("20");
    await again.client.start();
    expect(again.client.state.turnLimitMinutes).toBe(20);
    again.client.stop();
  });

  it("F-100: a limit the host could not keep is not taken, and the one before stays", async () => {
    const { client, storage } = started(null);
    await client.start();
    const set = storage.set.bind(storage);
    storage.set = (key: string, value: string) =>
      key === "turn-limit-minutes"
        ? Promise.reject(new Error("The disk is full."))
        : set(key, value);
    await expect(client.setTurnLimit(1)).rejects.toThrow("The disk is full.");
    expect(client.state.turnLimitMinutes).toBe(50);
    client.stop();
  });

  const aborted = (runId: string) => ({
    runId,
    seq: 9,
    stream: "lifecycle",
    ts: Date.now(),
    sessionKey: KEY,
    data: { phase: "end", status: "cancelled", aborted: true },
  });

  /** A client whose task runs one message past a 1-minute limit, with one queued behind it. */
  async function pastTheLimit(abort: (params: unknown) => unknown) {
    const parts = started("1");
    const { client, gateway, advance } = parts;
    gateway.handlers["chat.abort"] = abort;
    await client.start();
    await until(() => client.state.discovery.status === "ready");
    client.openSession(KEY);
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    client.sendMessage(KEY, "Take your time", asShown(client));
    const run = () => client.state.transcripts[KEY]!.runs[0];
    await until(() => run()?.bound === true && run()?.state === "running");
    client.sendMessage(KEY, "Then this", { ...asShown(client), mode: "queue" });
    await until(() => client.state.transcripts[KEY]!.outbox[1]?.status === "queued");
    advance(30_000);
    await client.setTurnLimit(1);
    expect(run()!.state).toBe("running");
    advance(31_000);
    // Timed again against the limit from when the run started: past it now.
    await client.setTurnLimit(1);
    return { ...parts, run };
  }

  it("F-100: a run that reaches the chosen limit is Stopping until the gateway confirms, then ends as stopped at the limit", async () => {
    const { client, gateway, run } = await pastTheLimit(() => ({
      ok: true,
      aborted: true,
      runIds: ["run-1"],
    }));
    await until(() => gateway.calls("chat.abort").length === 1);
    expect(run()).toMatchObject({ state: "stopping", turnLimit: 1 });
    expect(run()!.error).toBeNull();
    gateway.emit("agent", {
      runId: run()!.id,
      seq: 9,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: KEY,
      data: { phase: "end", status: "cancelled", aborted: true },
    });
    await until(() => run()?.state === "stopped");
    expect(run()).toMatchObject({ state: "stopped", turnLimit: 1, error: null });
    // As after any Stop: nothing queued starts by itself.
    expect(client.state.transcripts[KEY]!.outbox[1]!.status).toBe("not-sent");
    expect(gateway.calls("chat.send")).toHaveLength(1);
    client.stop();
  });

  it("F-100: an abort the gateway refuses at the limit fails nothing and releases nothing queued; it is not asked again", async () => {
    const { client, gateway, run, advance } = await pastTheLimit(() => {
      throw new GatewayError({ code: "INVALID_REQUEST", message: "abort refused" });
    });
    await until(() => run()?.stopError === "abort refused");
    expect(run()!.state).toBe("running");
    expect(run()!.error).toBeNull();
    expect(client.state.transcripts[KEY]!.outbox[1]!.status).toBe("queued");
    advance(60_000);
    await client.setTurnLimit(1);
    await sleep(30);
    expect(gateway.calls("chat.abort")).toHaveLength(1);
    expect(gateway.calls("chat.send")).toHaveLength(1);
    client.stop();
  });

  it("F-100: an abort the gateway does not answer at the limit leaves the run Stopping, fails nothing and releases nothing queued", async () => {
    const { client, gateway, run } = await pastTheLimit(() => new Promise(() => {}));
    await until(() => gateway.calls("chat.abort").length === 1);
    await sleep(50);
    expect(run()!.state).toBe("stopping");
    expect(run()!.error).toBeNull();
    expect(client.state.transcripts[KEY]!.outbox[1]!.status).toBe("queued");
    expect(gateway.calls("chat.send")).toHaveLength(1);
    client.stop();
  });

  it("F-100: a refused deadline and a deadline during manual Stop do not label a later manual stop", async () => {
    // A deadline the gateway refuses, then the person's own Stop, which the gateway confirms.
    let refuse = true;
    const first = await pastTheLimit(() => {
      if (refuse) throw new GatewayError({ code: "INVALID_REQUEST", message: "abort refused" });
      setTimeout(() => first.gateway.emit("agent", aborted(first.run()!.id)), 0);
      return { ok: true, aborted: true, runIds: [first.run()!.id] };
    });
    await until(() => first.run()?.stopError === "abort refused");
    refuse = false;
    await first.client.stopRun(KEY, first.run()!.id);
    await until(() => first.run()?.state === "stopped");
    expect(first.run()!.turnLimit ?? 0).toBe(0);
    first.client.stop();

    // The person's Stop on its way, unanswered, when the deadline passes; then the gateway's end.
    const second = started("1");
    const { client, gateway, advance } = second;
    gateway.handlers["chat.abort"] = () => new Promise(() => {});
    await client.start();
    await until(() => client.state.discovery.status === "ready");
    client.openSession(KEY);
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    client.sendMessage(KEY, "Take your time", asShown(client));
    const run = () => client.state.transcripts[KEY]!.runs[0];
    await until(() => run()?.bound === true && run()?.state === "running");
    void client.stopRun(KEY, run()!.id);
    await until(() => run()?.state === "stopping");
    advance(61_000);
    await client.setTurnLimit(1);
    await sleep(30);
    gateway.emit("agent", aborted(run()!.id));
    await until(() => run()?.state === "stopped");
    expect(run()!.turnLimit ?? 0).toBe(0);
    client.stop();
  });
});
