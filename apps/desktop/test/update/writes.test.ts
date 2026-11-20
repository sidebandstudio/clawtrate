// What the engine does with its download file: when it opens one, and how a
// write that fails is reported. `createWriteStream` is the real one, watched,
// and on request given file operations whose writes fail with ENOSPC, so no
// disk is filled.

import { existsSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytes, engineFor, feedFor, feedServer, json, payload, tempDir } from "./harness.ts";
import type { FeedServer } from "./harness.ts";

const sink = vi.hoisted(() => ({ opened: [] as string[], failWrites: false }));

vi.mock(import("node:fs"), async (importOriginal) => {
  const fs = await importOriginal();
  const noSpace = () =>
    Object.assign(new Error("ENOSPC: no space left on device, write"), {
      code: "ENOSPC",
      syscall: "write",
    });
  return {
    ...fs,
    createWriteStream: (...[path, options]: Parameters<typeof fs.createWriteStream>) => {
      sink.opened.push(String(path));
      if (!sink.failWrites) return fs.createWriteStream(path, options);
      return fs.createWriteStream(path, {
        ...(typeof options === "object" ? options : {}),
        fs: {
          open: fs.open,
          close: fs.close,
          write: (...args: unknown[]) => {
            const callback = args.at(-1) as (error: Error) => void;
            process.nextTick(callback, noSpace());
          },
        },
      } as Parameters<typeof fs.createWriteStream>[1]);
    },
  };
});

let server: FeedServer;
let dir: { path: string; remove(): void };

beforeEach(async () => {
  server = await feedServer();
  dir = tempDir();
  sink.opened.length = 0;
  sink.failWrites = false;
});
afterEach(async () => {
  await server.close();
  dir.remove();
});

const downloads = () => (existsSync(dir.path) ? readdirSync(dir.path) : []);

describe("the download file", () => {
  it("is never opened when the declared length is not the feed's", async () => {
    const file = payload();
    server.route(
      "/feed.json",
      json(feedFor(server.origin, "0.2.0", { size: file.body.length + 1, sha512: file.sha512 })),
    );
    server.route("/files/app.zip", bytes(file.body));
    const { engine } = engineFor(server, dir.path);
    await engine.check();
    expect(await engine.download()).toEqual({
      kind: "failed",
      stage: "download",
      cause: "size-mismatch",
    });
    expect(sink.opened).toEqual([]);
    expect(downloads()).toEqual([]);
  });

  it("reports a write that fails as write-failed while the server is still sending, and deletes it", async () => {
    const file = payload(300_000);
    server.route(
      "/feed.json",
      json(feedFor(server.origin, "0.2.0", { size: file.body.length, sha512: file.sha512 })),
    );
    // The first part, then nothing more: the response is still open when the write fails.
    server.route("/files/app.zip", (_request, response) => {
      response.writeHead(200, { "content-length": String(file.body.length) });
      response.write(file.body.subarray(0, 64 * 1024));
    });
    const { engine } = engineFor(server, dir.path);
    await engine.check();
    sink.failWrites = true;
    expect(await engine.download()).toEqual({
      kind: "failed",
      stage: "download",
      cause: "write-failed",
    });
    expect(sink.opened).toHaveLength(1);
    expect(downloads()).toEqual([]);
  });

  it("reports a connection the server drops as unreachable, not as a write failure", async () => {
    const file = payload(300_000);
    server.route(
      "/feed.json",
      json(feedFor(server.origin, "0.2.0", { size: file.body.length, sha512: file.sha512 })),
    );
    server.route("/files/app.zip", (_request, response) => {
      response.writeHead(200, { "content-length": String(file.body.length) });
      response.write(file.body.subarray(0, 64 * 1024), () => {
        setTimeout(() => response.socket?.destroy(), 50);
      });
    });
    const { engine } = engineFor(server, dir.path);
    await engine.check();
    expect(await engine.download()).toEqual({
      kind: "failed",
      stage: "download",
      cause: "unreachable",
    });
    expect(sink.opened).toHaveLength(1);
    expect(downloads()).toEqual([]);
  });
});
