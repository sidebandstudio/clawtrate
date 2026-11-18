// A send with files, followed as the socket writes it (F-286).

import { describe, expect, it } from "vitest";
import { KEY, openTask } from "./client-harness.ts";
import { deferred, sleep, until } from "./fake-gateway.ts";

describe("a send with files, as it goes out (F-286)", () => {
  it("F-286: records how much of the frame the socket has written, until all of it has", async () => {
    const { client, gateway, transcript } = await openTask();
    const answer = deferred<unknown>();
    gateway.handlers["chat.send"] = () => answer.promise;
    const socket = (
      gateway as unknown as { sockets: Array<{ bufferedAmount: number }> }
    ).sockets.at(-1)!;
    socket.bufferedAmount = 1e12;
    const content = "A".repeat(400_000);
    client.sendMessage(KEY, "the report", {
      attachments: [{ type: "file", mimeType: "application/pdf", fileName: "report.pdf", content }],
    });
    const upload = () => transcript().outbox[0]?.upload;
    await until(() => upload() !== undefined);
    const total = upload()!.totalBytes;
    expect(total).toBeGreaterThan(400_000);
    expect(upload()!.sentBytes).toBe(0);
    socket.bufferedAmount = Math.floor(total / 2);
    await until(() => upload()!.sentBytes > 0);
    expect(upload()!.sentBytes).toBe(total - Math.floor(total / 2));
    socket.bufferedAmount = 0;
    await until(() => upload()!.sentBytes === total);
    // Done: no more samples once the buffer is empty.
    const count = gateway.calls("chat.send").length;
    await sleep(250);
    expect(gateway.calls("chat.send").length).toBe(count);
    answer.resolve({ runId: "run-1", status: "started" });
    client.stop();
  });

  it("F-286: a message without files is not followed", async () => {
    const { client, transcript } = await openTask();
    client.sendMessage(KEY, "just words");
    await sleep(50);
    expect(transcript().outbox[0]?.upload).toBeUndefined();
    client.stop();
  });
});
