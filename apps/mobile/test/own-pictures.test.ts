// A person's own picture on iPhone (F-557): the iOS host's fetch, with a stand-in for its
// native module (modules/clawtrate-fetch), under core's own read of the gateway's media
// route; then the whole read for a message in the chat, through a client and its bridge
// session as the app runs them; and the chat's words, which are the desktop's. The native
// request itself (no cache, no cookies, no stored credentials, a redirect refused) runs
// only on a device: the Simulator check covers it (simulator/ios.test.ts).

import {
  ClawtrateClient,
  createBridgeSession,
  fetchInboundPicture,
  INBOUND_MEDIA_ROUTE,
  MAX_PICTURE_BYTES,
  toBase64,
  type ClientOptions,
  type HttpFetch,
  type SentAttachment,
  type Task,
} from "@clawtrate/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FAST, grantingGateway, KEY } from "../../../packages/core/test/client-harness.ts";
import {
  memoryStorage,
  testHost,
  tokenKey,
  until,
} from "../../../packages/core/test/fake-gateway.ts";
import { SHOT, sentRow, solidPng } from "../../../packages/core/test/sent-attachments-rows.ts";
import { shownStamp } from "../../../packages/ui/src/stamp.ts";
import { createHostFetch, type NativeFetch } from "../src/host/fetch.ts";
import {
  drawsAsPicture,
  fileSize,
  pictureRatio,
  rowsOnScreen,
  SENT_PICTURE_LINES,
  sentPictureAlt,
} from "../src/presentation/sent-files.ts";
import { loadSentPicture } from "../src/sent-pictures.ts";
import { chatRows } from "../src/transcript.ts";

const PROTECTED = "wss://gateway.example";
const TOKEN = "device-token";
const RED = solidPng(48, 32, [220, 40, 40]);
/** A ticket in the gateway's form: `v1`, a payload and a signature, each base64url. Made up. */
const TICKET = ["v1", "c2NvcGU", "c2lnbmF0dXJl"].join(".");
const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));

type Answer =
  | { status: number; headers: Record<string, string>; parts: Uint8Array[] }
  | { refused: string }
  | "never";

const ticketAnswer = (): Answer => ({
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
  parts: [
    ascii(
      JSON.stringify({
        available: true,
        mimeType: "image/png",
        sizeBytes: RED.length,
        mediaTicket: TICKET,
        mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
    ),
  ],
});
const pictureAnswer = (parts = [RED.slice(0, 10), RED.slice(10)]): Answer => ({
  status: 200,
  headers: { "content-type": "image/png" },
  parts,
});
const isTicket = (url: string) => new URL(url).searchParams.get("meta") === "1";
const refusal = (code: string) => Object.assign(new Error(code), { code });

/**
 * A stand-in for the native module: it records each request it is asked for, answers from
 * `answer`, gives the body one part per read, and stops a request when it is cancelled.
 */
function fakeNative(
  answer: (url: string) => Answer = (url) => (isTicket(url) ? ticketAnswer() : pictureAnswer()),
) {
  const started: Array<{ id: string; url: string; authorization: string | null }> = [];
  const cancelled: string[] = [];
  let reads = 0;
  const bodies = new Map<string, Uint8Array[]>();
  const waiting = new Map<string, (error: Error) => void>();
  const hold = (id: string) => new Promise<never>((_, reject) => waiting.set(id, reject));
  const native: NativeFetch = {
    async start(id, url, authorization) {
      started.push({ id, url, authorization });
      const answered = answer(url);
      if (answered === "never") return hold(id);
      if ("refused" in answered) throw refusal(answered.refused);
      bodies.set(id, [...answered.parts]);
      return { status: answered.status, headers: answered.headers };
    },
    async read(id) {
      reads += 1;
      const body = bodies.get(id);
      if (!body) throw refusal("ERR_CANCELLED");
      if (body.length === 0) return null;
      const part = body.shift()!;
      // An empty part stands for a body that stops sending without ending.
      return part.length === 0 ? hold(id) : part;
    },
    async cancel(id) {
      cancelled.push(id);
      bodies.delete(id);
      waiting.get(id)?.(refusal("ERR_CANCELLED"));
    },
  };
  return { native, started, cancelled, reads: () => reads };
}

const ctx = (fetch: HttpFetch) => ({
  fetch,
  gatewayUrl: PROTECTED,
  token: TOKEN,
  now: () => Date.now(),
});

afterEach(() => {
  vi.useRealTimers();
});

describe("F-557: your picture read back through the iPhone host's fetch", () => {
  it("F-557: the token is the one header, on the ticket request only, and the bytes are the gateway's", async () => {
    const fake = fakeNative();
    expect(await fetchInboundPicture(ctx(createHostFetch(fake.native)), KEY, SHOT.url)).toEqual({
      status: "bytes",
      mimeType: "image/png",
      bytes: RED,
    });
    expect(fake.started.map((each) => each.authorization)).toEqual([`Bearer ${TOKEN}`, null]);
    expect(fake.started.every((each) => !each.url.includes(TOKEN))).toBe(true);
    expect(fake.started.map((each) => new URL(each.url).pathname)).toEqual([
      INBOUND_MEDIA_ROUTE,
      INBOUND_MEDIA_ROUTE,
    ]);
    expect(fake.started.map((each) => new URL(each.url).searchParams.get("sessionKey"))).toEqual([
      KEY,
      KEY,
    ]);
    // Both bodies ended on their own: nothing was left to stop.
    expect(fake.cancelled).toEqual([]);
  });

  it("F-557: a redirect isn't followed, and the picture is one this connection can't load", async () => {
    for (const on of ["ticket", "bytes"]) {
      const fake = fakeNative((url) =>
        isTicket(url) === (on === "ticket") ? { refused: "ERR_REDIRECT" } : ticketAnswer(),
      );
      expect(await fetchInboundPicture(ctx(createHostFetch(fake.native)), KEY, SHOT.url)).toEqual({
        status: "cannot-load",
      });
      expect(fake.started).toHaveLength(on === "ticket" ? 1 : 2);
    }
  });

  it("F-557: only a GET that follows no redirect and sends no cookies, to an https address, with core's one header, reaches the native request", async () => {
    const fake = fakeNative();
    const fetch = createHostFetch(fake.native);
    const signal = new AbortController().signal;
    const init = { method: "GET", redirect: "error", credentials: "omit", signal } as const;
    for (const [url, changed] of [
      ["https://gateway.example/a", { method: "POST" }],
      ["https://gateway.example/a", { redirect: "follow" }],
      ["https://gateway.example/a", { credentials: "include" }],
      ["http://gateway.example/a", {}],
      ["file:///etc/hosts", {}],
      ["data:image/png;base64,AAAA", {}],
    ] as const)
      await expect(
        fetch(url, { ...init, ...changed } as unknown as Parameters<HttpFetch>[1]),
      ).rejects.toThrow(TypeError);
    expect(fake.started).toEqual([]);
    // Anything beside core's one header stays here.
    await fetch("https://gateway.example/a", {
      ...init,
      headers: { authorization: "Bearer x", cookie: "session=1" } as { authorization: string },
    });
    await fetch("https://gateway.example/b", init);
    expect(fake.started.map(({ url, authorization }) => [url, authorization])).toEqual([
      ["https://gateway.example/a", "Bearer x"],
      ["https://gateway.example/b", null],
    ]);
  });

  it("F-557: core's time limit stops the request, waiting for an answer or in the middle of the body", async () => {
    vi.useFakeTimers();
    for (const answer of [
      (): Answer => "never",
      (url: string): Answer =>
        isTicket(url) ? ticketAnswer() : pictureAnswer([RED.slice(0, 10), new Uint8Array()]),
    ]) {
      const fake = fakeNative(answer);
      const read = fetchInboundPicture(ctx(createHostFetch(fake.native)), KEY, SHOT.url);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await read).toEqual({
        status: "failed",
        message: "The picture took too long to arrive.",
      });
      expect(fake.cancelled).toEqual([fake.started.at(-1)!.id]);
    }
  });

  it("F-557: a read after the abort rejects, even for a part already on its way, and never gives it", async () => {
    // The native side resolved the part before its cancel came, so the cancel rejects nothing.
    const controller = new AbortController();
    const cancelled: string[] = [];
    const native: NativeFetch = {
      start: async () => ({ status: 200, headers: { "content-type": "image/png" } }),
      read: () =>
        new Promise((resolve) =>
          controller.signal.addEventListener("abort", () => resolve(RED.slice(0, 10))),
        ),
      cancel: async (id) => void cancelled.push(id),
    };
    const response = await createHostFetch(native)("https://gateway.example/a", {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const first = reader.read();
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toEqual(["1"]);
  });

  it("F-557: a picture cut off by the time limit is a read to try again, never drawn", async () => {
    vi.useFakeTimers();
    // The bytes' first part, a picture's start, is still on its way when the 30 s run out.
    let late: (() => void) | null = null;
    const fake = fakeNative();
    const native: NativeFetch = {
      ...fake.native,
      read: (id) =>
        id === "2"
          ? new Promise((resolve) => (late = () => resolve(RED.slice(0, 10))))
          : fake.native.read(id),
    };
    const read = fetchInboundPicture(ctx(createHostFetch(native)), KEY, SHOT.url);
    await vi.advanceTimersByTimeAsync(30_000);
    late!();
    expect(await read).toEqual({
      status: "failed",
      message: "The picture took too long to arrive.",
    });
  });

  it("F-557: a body that passes 5 MB is stopped as it passes, and nothing more is read", async () => {
    const MIB = new Uint8Array(1024 * 1024);
    MIB.set(RED.slice(0, 8));
    const fake = fakeNative((url) =>
      isTicket(url) ? ticketAnswer() : pictureAnswer(Array.from({ length: 8 }, () => MIB)),
    );
    expect(await fetchInboundPicture(ctx(createHostFetch(fake.native)), KEY, SHOT.url)).toEqual({
      status: "not-a-picture",
    });
    expect(fake.cancelled).toEqual([fake.started[1]!.id]);
    // The ticket's one part and its end, then six parts of the picture: 6 MB is past 5.
    expect(fake.reads()).toBe(2 + Math.ceil(MAX_PICTURE_BYTES / MIB.length) + 1);
  });

  it("F-557: a request that fails, before or during the body, is a read to try again", async () => {
    const fake = fakeNative((url) => (isTicket(url) ? { refused: "ERR_FETCH" } : pictureAnswer()));
    expect(await fetchInboundPicture(ctx(createHostFetch(fake.native)), KEY, SHOT.url)).toEqual({
      status: "failed",
      message: "The gateway couldn't be reached for this picture.",
    });
  });
});

/** The iPhone's client on another device of this person, at `url`, with the host's fetch. */
async function iphone(native: NativeFetch, url = PROTECTED) {
  const gateway = grantingGateway();
  gateway.handlers["chat.history"] = () => ({ messages: [sentRow("m1", "look", [SHOT])] });
  gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gateway-1" });
  const storage = memoryStorage({
    connection: JSON.stringify({ url, token: null }),
    [tokenKey(url)]: JSON.stringify({
      token: TOKEN,
      grantedScopes: ["operator.read"],
      heldScopes: ["operator.read"],
    }),
  });
  const options: ClientOptions = { ...FAST, readOnly: true };
  const client = new ClawtrateClient(
    { ...testHost(gateway, storage), fetch: createHostFetch(native) },
    options,
  );
  const session = createBridgeSession(client);
  await client.start();
  await until(() => client.state.discovery.status === "ready");
  await session.apply({ type: "openSession", key: KEY });
  await until(() => client.state.transcripts[KEY]?.status === "ready");
  const task: Task = {
    key: KEY,
    botId: "otto",
    sessionId: null,
    title: "Disk space",
    preview: null,
    updatedAt: null,
    status: "idle",
    unread: false,
  };
  const [row] = chatRows(task, client.state.transcripts[KEY]!, "Otto", Date.now(), {
    connected: true,
    closed: false,
  }).filter((each) => each.kind === "user");
  const source = { getState: client.store.get, subscribe: client.store.subscribe };
  const load = (drawnOn = shownStamp(client.store.get().connection)) =>
    loadSentPicture((command) => session.apply(command), source, drawnOn, {
      key: KEY,
      messageKey: row?.kind === "user" ? row.messageKey! : "",
      index: 0,
    });
  return { client, row, load };
}

describe("F-557: your picture in the iPhone chat", () => {
  it("F-557: at a protected address, your message carries the picture, read back from the gateway for the screen's gateway", async () => {
    const fake = fakeNative();
    const { client, row, load } = await iphone(fake.native);
    await until(() => client.state.connection.gatewayId === "gateway-1");
    expect(row).toEqual({
      kind: "user",
      id: expect.any(String),
      text: "look",
      messageKey: "m1:user",
      files: [{ fileName: "shot.png", mimeType: "image/png", sizeBytes: 111 }],
    });
    expect(await load()).toEqual({
      status: "shown",
      uri: `data:image/png;base64,${toBase64(RED)}`,
    });
    expect(fake.started).toHaveLength(2);
    client.stop();
  });

  it("F-557: at a loopback or ws:// address, it says this connection can't load it, and asks for nothing", async () => {
    for (const url of ["ws://127.0.0.1:19001", "ws://gateway.example"]) {
      const fake = fakeNative();
      const { client, load } = await iphone(fake.native, url);
      expect(await load()).toEqual({ status: "cannot-load" });
      expect(fake.started).toEqual([]);
      client.stop();
    }
  });

  it("F-557: a read for a screen drawn on another gateway asks for nothing, and the picture didn't load", async () => {
    const fake = fakeNative();
    const { client, load } = await iphone(fake.native);
    await until(() => client.state.connection.gatewayId === "gateway-1");
    const drawn = shownStamp(client.store.get().connection);
    expect(await load({ ...drawn, gatewayId: "gateway-2" })).toEqual({ status: "failed" });
    expect(fake.started).toEqual([]);
    client.stop();
  });
});

describe("F-557: what the iPhone chat shows for the files you sent", () => {
  const shot: SentAttachment = { fileName: "shot.png", mimeType: "image/png", sizeBytes: 2_048 };

  it("F-557: says what the desktop says, in its words, and writes a size as it does", () => {
    const UI = join(import.meta.dirname, "../../../packages/ui/src");
    const desktop = readFileSync(join(UI, "SentFiles.tsx"), "utf8");
    for (const [why, line] of Object.entries(SENT_PICTURE_LINES))
      expect(desktop, why).toContain(
        `${why.includes("-") ? `"${why}"` : why}: ${JSON.stringify(line)},`,
      );
    expect(desktop).toContain("`Your picture: ${file.fileName}`");
    expect(sentPictureAlt(shot)).toBe("Your picture: shot.png");
    // The desktop's `size`, line for line, with the same mebibyte.
    const body = (source: string, head: string) =>
      source
        .slice(source.indexOf(head), source.indexOf("\n}\n", source.indexOf(head)))
        .split("\n")
        .slice(1);
    const composer = readFileSync(join(UI, "Composer.tsx"), "utf8");
    const mobile = readFileSync(
      join(import.meta.dirname, "../src/presentation/sent-files.ts"),
      "utf8",
    );
    expect(body(mobile, "export function fileSize(")).toEqual(
      body(composer, "export function size("),
    );
    expect(composer).toContain("const MIB = 1024 * 1024;");
    expect([1, 2_048, 1_048_576, 5_242_880].map(fileSize)).toEqual([
      "1 KB",
      "2 KB",
      "1.0 MB",
      "5.0 MB",
    ]);
  });

  it("F-557: draws PNG, JPEG, GIF and WebP up to 5 MB as pictures, and anything else as its name and size", () => {
    expect(drawsAsPicture(shot)).toBe(true);
    expect(drawsAsPicture({ ...shot, mimeType: "image/webp", sizeBytes: null })).toBe(true);
    expect(drawsAsPicture({ ...shot, sizeBytes: MAX_PICTURE_BYTES + 1 })).toBe(false);
    expect(drawsAsPicture({ ...shot, mimeType: "image/svg+xml" })).toBe(false);
    expect(drawsAsPicture({ ...shot, mimeType: "text/plain" })).toBe(false);
  });

  it("reads a message's pictures once any part of it is on screen", () => {
    const boxes = [
      { key: "a", y: 0, height: 100 },
      { key: "b", y: 600, height: 100 },
      { key: "c", y: 900, height: 100 },
      { key: "d", y: 1_500, height: 100 },
    ];
    expect(rowsOnScreen(boxes, 650, 800)).toEqual(["b", "c"]);
    expect(rowsOnScreen(boxes, 100, 500)).toEqual([]);
  });

  it("keeps a picture in its own proportions, a very tall one at 3:4", () => {
    expect(pictureRatio(480, 320)).toBe(1.5);
    expect(pictureRatio(100, 1_000)).toBe(0.75);
    expect(pictureRatio(0, 0)).toBe(4 / 3);
  });
});
