// C2: releasing a viewer that throws must not take the host down. A child
// host whose client throws on release keeps serving after a viewer closes and
// after a viewer's socket errors.

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

const TOKEN = "stub-token";
let child: ChildProcess;
let port = 0;
let stderr = "";

beforeAll(async () => {
  child = spawn(process.execPath, [join(import.meta.dirname, "fixtures/throwing-host.ts")], {
    env: { PATH: process.env.PATH, STUB_ACCESS_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  port = await new Promise<number>((resolve, reject) => {
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /PORT (\d+)/.exec(output);
      if (match) resolve(Number(match[1]));
    });
    child.once("exit", (code) => reject(new Error(`host exited with ${code}`)));
  });
});

afterAll(async () => {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
});

async function viewer(): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`, {
    headers: { cookie: `clawtrate_access=${TOKEN}`, origin: `http://127.0.0.1:${port}` },
  });
  await once(socket, "message");
  return socket;
}

describe("a viewer's release that throws (C2)", () => {
  it("is logged, ends the socket and leaves the host serving, on close and on a socket error", async () => {
    const closing = await viewer();
    const closed = once(closing, "close");
    closing.close();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(child.exitCode).toBeNull();
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);

    // An oversized frame makes the host's socket error out: the same release runs from there.
    const erroring = await viewer();
    erroring.on("error", () => {});
    const ended = once(erroring, "close");
    erroring.send("x".repeat(64 * 1024 + 1));
    await ended;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(child.exitCode).toBeNull();
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    expect(stderr).toMatch(/releasing a viewer's session failed: Error: injected release failure/);
    // Still accepting viewers.
    (await viewer()).close();
  });
});
