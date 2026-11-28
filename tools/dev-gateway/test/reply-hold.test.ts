import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { HOLD_PATH, startFakeProvider } from "../src/fake-provider.ts";

const SESSION = "agent:otto:hold-check";
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function provider(replyHoldLimitMs?: number): Promise<string> {
  const server = startFakeProvider({
    port: 0,
    chunkDelayMs: 0,
    ...(replyHoldLimitMs === undefined ? {} : { replyHoldLimitMs }),
  });
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

const hold = async (url: string, action: string, session = SESSION) =>
  fetch(`${url}${HOLD_PATH}`, { method: "POST", body: JSON.stringify({ session, action }) });
const state = async (url: string) =>
  (await (await fetch(`${url}${HOLD_PATH}?session=${SESSION}`)).json()) as {
    held: boolean;
    reached: number;
    waiting: number;
  };

/** A streamed reply in the session: what it sent so far, and whether it ended. */
async function reply(url: string, prompt: string) {
  const response = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    // The key the development gateway gives the scripted provider.
    headers: { authorization: "Bearer scripted-dev-provider" },
    body: JSON.stringify({
      model: "dev-1",
      stream: true,
      messages: [
        { role: "system", content: `Runtime: agent=otto | session=${SESSION}` },
        { role: "user", content: prompt },
      ],
    }),
  });
  const seen = { text: "", ended: false, cut: false };
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of response.body!) seen.text += decoder.decode(chunk as Uint8Array);
    seen.ended = true;
  })().catch(() => {
    // cut off: by the hold's limit, or with its server when its test ends
    seen.cut = true;
  });
  return seen;
}

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200 && !(await check()); i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  expect(await check()).toBe(true);
};

describe("a check holds a task's replies before their end", () => {
  it("streams every step, waits before the end, and lets the oldest reply end on next", async () => {
    const url = await provider();
    expect((await hold(url, "hold")).status).toBe(200);
    const first = await reply(url, "#text");
    await until(async () => (await state(url)).waiting === 1);
    // The reply's text is all there; its end is not.
    expect(first.text).toContain('"content":"reasoning first."');
    expect(first.text).not.toContain("[DONE]");
    expect(first.ended).toBe(false);
    const second = await reply(url, "#text");
    await until(async () => (await state(url)).waiting === 2);
    expect(await state(url)).toMatchObject({ held: true, reached: 2, waiting: 2 });
    expect((await hold(url, "next")).status).toBe(200);
    await until(() => first.ended);
    expect(first.text).toContain('"finish_reason":"stop"');
    expect(first.text).toContain("[DONE]");
    expect(second.ended).toBe(false);
    expect(await state(url)).toMatchObject({ held: true, reached: 2, waiting: 1 });
    // Lifting the hold lets every waiting reply end, and later replies don't wait.
    expect((await hold(url, "release")).status).toBe(200);
    await until(() => second.ended);
    expect(await state(url)).toEqual({ session: SESSION, held: false, reached: 0, waiting: 0 });
    const third = await reply(url, "#text");
    await until(() => third.ended);
  });

  it("refuses next with nothing waiting, an unknown action and a request without a task", async () => {
    const url = await provider();
    expect((await hold(url, "next")).status).toBe(409);
    expect((await hold(url, "hold")).status).toBe(200);
    expect((await hold(url, "next")).status).toBe(409);
    expect((await hold(url, "pause")).status).toBe(409);
    expect((await hold(url, "hold", "")).status).toBe(400);
  });

  it("answers a body that is not an object as a request without a task", async () => {
    const url = await provider();
    for (const body of ["null", "[]", "7", '"hold"', "{"]) {
      const response = await fetch(`${url}${HOLD_PATH}`, { method: "POST", body });
      expect([body, response.status]).toEqual([body, 400]);
    }
  });

  it("ends the task's hold with a reply no check let go in time", async () => {
    const url = await provider(150);
    await hold(url, "hold");
    const first = await reply(url, "#text");
    await until(() => first.cut);
    expect(first.text).not.toContain("[DONE]");
    // The check that held the task is gone: its later replies aren't held again.
    expect(await state(url)).toEqual({ session: SESSION, held: false, reached: 0, waiting: 0 });
    const second = await reply(url, "#text");
    await until(() => second.ended);
    expect(second.text).toContain("[DONE]");
  });

  it("holds only the task it was asked to", async () => {
    const url = await provider();
    await hold(url, "hold", "agent:otto:another-task");
    const other = await reply(url, "#text");
    await until(() => other.ended);
  });
});
