// A2: hostile upgrades against a real child host process.
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { MAX_COMMAND_ID_CHARS, MAX_WEB_VIEWERS } from "../src/web-host/server.ts";

let child: ChildProcess;
let port = 0;
const TOKEN = "stub-token";

beforeAll(async () => {
  child = spawn(process.execPath, [join(import.meta.dirname, "fixtures/stub-host.ts")], {
    env: { PATH: process.env.PATH, STUB_ACCESS_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  port = await new Promise<number>((resolve, reject) => {
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /PORT (\d+)/.exec(output);
      if (match) resolve(Number(match[1]));
    });
    child.once("exit", (code) => reject(new Error(`stub host exited with ${code}`)));
  });
});

afterAll(() => {
  child.kill("SIGTERM");
});

/** Send a raw upgrade request and return the status line the host answers with. */
function rawUpgrade(headers: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        "GET /bridge HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
          "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          headers +
          "\r\n",
      );
    });
    let data = "";
    socket.on("data", (chunk) => (data += chunk.toString()));
    socket.on("close", () => resolve(data.split("\r\n")[0] ?? ""));
    socket.on("error", reject);
  });
}

describe("web host upgrade handling", () => {
  it("answers a malformed cookie with 401 and keeps running", async () => {
    expect(await rawUpgrade("Cookie: clawtrate_access=%\r\n")).toBe("HTTP/1.1 401 Unauthorized");
    expect(await rawUpgrade("Cookie: clawtrate_access=%E0%A4%A\r\n")).toBe(
      "HTTP/1.1 401 Unauthorized",
    );
    expect(await rawUpgrade("Cookie: =%; clawtrate_access=%zz\r\n")).toBe(
      "HTTP/1.1 401 Unauthorized",
    );
    expect(child.exitCode).toBeNull();
  });

  it("still accepts a valid connection afterwards", async () => {
    const hello = await new Promise<unknown>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
        headers: { cookie: `clawtrate_access=${TOKEN}`, origin: `http://127.0.0.1:${port}` },
      });
      socket.once("message", (data) => {
        resolve(JSON.parse(String(data)));
        socket.close();
      });
      socket.once("error", reject);
    });
    expect(hello).toMatchObject({ type: "hello" });
    expect(child.exitCode).toBeNull();
  });
});

function authedSocket(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
      headers: { cookie: `clawtrate_access=${TOKEN}`, origin: `http://127.0.0.1:${port}` },
    });
    socket.once("message", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function healthy(): Promise<boolean> {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  return response.status === 200 && child.exitCode === null;
}

describe("web host bridge frames", () => {
  it("survives a frame one byte over the bridge limit", async () => {
    const socket = await authedSocket();
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    socket.on("error", () => {});
    socket.send("x".repeat(64 * 1024 + 1));
    expect(await closed).toBe(1009);
    expect(await healthy()).toBe(true);
  });

  it("answers malformed and flooding frames with bounded errors and keeps running", async () => {
    const socket = await authedSocket();
    const results: unknown[] = [];
    socket.on("message", (data) => results.push(JSON.parse(String(data))));
    socket.send("{not json");
    socket.send(
      JSON.stringify({ type: "command", id: "x".repeat(65), command: { type: "retry" } }),
    );
    for (let i = 0; i < 200; i += 1) {
      socket.send(
        JSON.stringify({
          type: "command",
          id: String(i),
          command: { type: "openSession", key: `agent:a:t${i}` },
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const errors = results.filter((r) => (r as { ok?: boolean }).ok === false);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.some((r) => String((r as { error: string }).error).match(/at once/))).toBe(true);
    socket.close();
    expect(await healthy()).toBe(true);
  });
});

describe("web host bounds", () => {
  it(`echoes a command id of MAX_COMMAND_ID_CHARS (${MAX_COMMAND_ID_CHARS}) and refuses one longer`, async () => {
    const socket = await authedSocket();
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    socket.on("message", (data) => results.push(JSON.parse(String(data))));
    const atBound = "a".repeat(MAX_COMMAND_ID_CHARS);
    socket.send(
      JSON.stringify({
        type: "command",
        id: atBound,
        command: { type: "closeSession", key: "agent:a:x" },
      }),
    );
    socket.send(
      JSON.stringify({
        type: "command",
        id: "b".repeat(MAX_COMMAND_ID_CHARS + 1),
        command: { type: "closeSession", key: "agent:a:x" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(results.find((each) => each.id === atBound)).toMatchObject({ ok: true });
    expect(results.find((each) => each.id === "")).toMatchObject({
      ok: false,
      error: "invalid message",
    });
    socket.close();
    expect(await healthy()).toBe(true);
  });

  it(`serves MAX_WEB_VIEWERS (${MAX_WEB_VIEWERS}) viewers and closes one more`, async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const viewers: WebSocket[] = [];
    for (let i = 0; i < MAX_WEB_VIEWERS; i += 1) viewers.push(await authedSocket());
    const extra = new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
      headers: { cookie: `clawtrate_access=${TOKEN}`, origin: `http://127.0.0.1:${port}` },
    });
    const code = await new Promise<number>((resolve) =>
      extra.once("close", (each) => resolve(each)),
    );
    expect(code).toBe(1013);
    for (const viewer of viewers) viewer.close();
    expect(await healthy()).toBe(true);
  });
});
