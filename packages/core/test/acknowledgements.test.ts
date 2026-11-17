// What the client assumed on its own never lasts for ever (C4, A20, ruling
// 5). A `/stop` the gateway handled as a command (`{ok, aborted, runIds}`,
// with no run id) leaves no running run and is dismissable; any other
// acknowledgement without a run assumes none and becomes unconfirmed, with
// retry and delete, unless history confirms it; and a send nobody answers
// fails at the request deadline, to be retried with the same key.

import { describe, expect, it } from "vitest";
import { REQUEST_TIMEOUT_MS } from "../src/client.ts";
import { grantingGateway, KEY, openTask } from "./client-harness.ts";
import { until } from "./fake-gateway.ts";

describe("an acknowledgement without a run id", () => {
  it("a /stop handled as a command leaves no running run, is not unconfirmed, and can be dismissed", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.send"] = () => ({ ok: true, aborted: false, runIds: [] });
    const { client, transcript } = await openTask({ gateway });
    const id = client.sendMessage(KEY, "/stop");
    await until(() => transcript().outbox[0]?.status === "handled");
    expect(transcript().runs).toEqual([]);
    // History never holds a command: a read does not make it unconfirmed.
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => gateway.calls("chat.history").length >= 2);
    await until(() => transcript().status === "ready");
    expect(transcript().outbox[0]).toMatchObject({ id, status: "handled", error: null });
    // It can be dismissed.
    client.deleteMessage(KEY, id);
    expect(transcript().outbox).toEqual([]);
    client.stop();
  });

  it("any other acknowledgement without a run assumes none, and is unconfirmed after history lacks it", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.send"] = () => ({ status: "accepted" });
    const { client, transcript } = await openTask({ gateway });
    const id = client.sendMessage(KEY, "hello");
    await until(() => transcript().outbox[0]?.status === "unconfirmed");
    expect(transcript().runs).toEqual([]);
    expect(transcript().outbox[0]!.runId).toBeNull();
    // Retry reuses the key; delete removes it.
    client.retryMessage(KEY, id);
    await until(() => gateway.calls("chat.send").length === 2);
    expect(
      gateway
        .calls("chat.send")
        .map((params) => (params as { idempotencyKey: string }).idempotencyKey),
    ).toEqual([id, id]);
    await until(() => transcript().outbox[0]?.status === "unconfirmed");
    client.deleteMessage(KEY, id);
    expect(transcript().outbox).toEqual([]);
    client.stop();
  });

  it("a late history row with its key confirms it", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.send"] = () => ({ status: "accepted" });
    const { client, transcript } = await openTask({ gateway });
    const id = client.sendMessage(KEY, "hello");
    await until(() => transcript().outbox[0]?.status === "unconfirmed");
    gateway.handlers["chat.history"] = () => ({
      messages: [
        { role: "user", content: "hello", __openclaw: { id: "u1", seq: 1, idempotencyKey: id } },
      ],
    });
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => transcript().outbox.length === 0);
    client.stop();
  });
});

describe(`a send nobody answers fails at the request deadline (REQUEST_TIMEOUT_MS = ${REQUEST_TIMEOUT_MS})`, () => {
  it("is unknown, then unconfirmed once history lacks it, and goes out once more with the same key only on retry", async () => {
    const gateway = grantingGateway();
    let answer = false;
    gateway.handlers["chat.send"] = () => (answer ? { runId: "run-9" } : new Promise(() => {}));
    const { client, transcript } = await openTask({ gateway, client: { requestTimeoutMs: 150 } });
    const id = client.sendMessage(KEY, "anyone there?");
    await until(() => transcript().outbox[0]?.status === "checking");
    // Not refused by the gateway, so no "couldn't start" run: the optimistic run is gone.
    expect(transcript().runs).toEqual([]);
    await until(() => transcript().outbox[0]?.status === "unconfirmed");
    expect(gateway.calls("chat.send")).toHaveLength(1);
    answer = true;
    client.retryMessage(KEY, id);
    await until(() => transcript().outbox[0]?.status === "sent");
    expect(
      gateway
        .calls("chat.send")
        .map((params) => (params as { idempotencyKey: string }).idempotencyKey),
    ).toEqual([id, id]);
    client.stop();
  });
});
