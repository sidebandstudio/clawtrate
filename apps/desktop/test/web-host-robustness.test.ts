// A2: hostile upgrades against a real child host process.
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

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
