// The "Turn time limit" (F-100): chosen by the person, kept by the host, and the limit
// a run this client started fails at.

import { describe, expect, it } from "vitest";
import { ClawtrateClient } from "../src/client.ts";
import { INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { FAST, grantingGateway, KEY, URL_A } from "./client-harness.ts";
import { memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";

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

  it("F-100: a run that reaches the chosen limit ends as failed, naming the limit, and is aborted", async () => {
    const { client, gateway, advance } = started("1");
    await client.start();
    await until(() => client.state.discovery.status === "ready");
    client.openSession(KEY);
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    client.sendMessage(KEY, "Take your time");
    const run = () => client.state.transcripts[KEY]!.runs[0];
    await until(() => run()?.bound === true && run()?.state === "running");
    advance(30_000);
    await client.setTurnLimit(1);
    expect(run()!.state).toBe("running");
    advance(31_000);
    // Timed again against the limit from when the run started: past it now.
    await client.setTurnLimit(1);
    await until(() => run()?.state === "failed");
    expect(run()!.error).toMatchObject({
      kind: "turn-limit",
      message: "Stopped at the 1-minute turn limit.",
    });
    await until(() => gateway.calls("chat.abort").length === 1);
    client.stop();
  });
});
