// What the engine does with its download file: when it opens one, and how a
// write that fails is reported. `createWriteStream` is the real one, watched,
// and the write callback can report ENOSPC, so no
// disk is filled.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { WriteStream } from "node:fs";
import type { ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytes, engineFor, feedFor, feedServer, json, payload, tempDir } from "./harness.ts";
import type { FeedServer } from "./harness.ts";

type DiskError = "EAGAIN" | "ENOSPC";
type FinishWrite = (error?: DiskError) => void;

const sink = vi.hoisted(() => ({
  opened: [] as string[],
  onWrite: undefined as ((finish: FinishWrite) => void) | undefined,
  corked: undefined as ((stream: WriteStream) => void) | undefined,
  vectoredWrites: 0,
  responseClosed: undefined as (() => void) | undefined,
  closeError: undefined as string | undefined,
}));

vi.mock(import("node:fs"), async (importOriginal) => {
  const fs = await importOriginal();
  const writeWithFault = (data: unknown, callback: unknown, write: () => void) => {
    if (!sink.onWrite) return write();
    sink.onWrite((code) => {
      if (!code) return write();
      const fail = callback as (error: Error, written: number, buffer: unknown) => void;
      process.nextTick(fail, Object.assign(new Error(code), { code }), 0, data);
    });
  };
  return {
    ...fs,
    createWriteStream: (...[path, options]: Parameters<typeof fs.createWriteStream>) => {
      sink.opened.push(String(path));
      const stream = fs.createWriteStream(path, options);
      if (sink.corked) {
        stream.cork();
        sink.corked(stream);
      }
      return stream;
    },
    write: ((...args: Parameters<typeof fs.write>) => {
      writeWithFault(args[1], args.at(-1), () => fs.write(...args));
    }) as typeof fs.write,
    close: ((fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => {
      const code = sink.closeError;
      if (!code) return fs.close(fd, callback);
      // The descriptor still closes, so the test leaves none open.
      fs.close(fd, () => callback(Object.assign(new Error(code), { code })));
    }) as typeof fs.close,
    writev: ((...args: Parameters<typeof fs.writev>) => {
      sink.vectoredWrites++;
      writeWithFault(args[1], args.at(-1), () => fs.writev(...args));
    }) as typeof fs.writev,
  };
});

vi.mock(import("node:http"), async (importOriginal) => {
  const http = await importOriginal();
  return {
    ...http,
    get: ((url, options, callback) =>
      http.get(url, options, (response) => {
        if (sink.responseClosed) response.once("close", sink.responseClosed);
        callback?.(response);
      })) as typeof http.get,
  };
});

let server: FeedServer;
let dir: { path: string; remove(): void };

beforeEach(async () => {
  server = await feedServer();
  dir = tempDir();
  sink.opened.length = 0;
  sink.onWrite = undefined;
  sink.corked = undefined;
  sink.vectoredWrites = 0;
  sink.responseClosed = undefined;
  sink.closeError = undefined;
});
afterEach(async () => {
  vi.useRealTimers();
  try {
    dir.remove();
  } finally {
    await server.close();
  }
});

const downloads = () => (existsSync(dir.path) ? readdirSync(dir.path) : []);

describe("the download file", () => {
  it("keeps overlapping downloads of the same offer in separate partial files", async () => {
    const file = payload(4096);
    const firstResponse = Promise.withResolvers<ServerResponse>();
    let requests = 0;
    server.route(
      "/feed.json",
      json(feedFor(server.origin, "0.2.0", { size: file.body.length, sha512: file.sha512 })),
    );
    server.route("/files/app.zip", (_request, response) => {
      response.writeHead(200, { "content-length": file.body.length });
      if (++requests === 1) {
        response.write(file.body.subarray(0, 1024));
        firstResponse.resolve(response);
      } else {
        response.end(file.body);
      }
    });
    const first = engineFor(server, dir.path).engine;
    const second = engineFor(server, dir.path).engine;
    await Promise.all([first.check(), second.check()]);
    const pending = first.download();
    const response = await firstResponse.promise;
    try {
      await vi.waitFor(
        () => {
          expect(statSync(sink.opened[0]!).size).toBe(1024);
        },
        { timeout: 5000 },
      );
      const ready = await second.download();
      expect(ready.kind).toBe("ready");
      expect(new Set(sink.opened).size).toBe(2);
    } finally {
      response.end(file.body.subarray(1024));
      await pending;
    }
    const ready = await pending;
    expect(ready.kind).toBe("ready");
    if (ready.kind === "ready") expect(readFileSync(ready.path)).toEqual(file.body);
    expect(downloads()).toHaveLength(1);
  });

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
      response.write(file.body.subarray(0, 4096));
    });
    const { engine } = engineFor(server, dir.path);
    await engine.check();
    sink.onWrite = (finish) => finish("ENOSPC");
    expect(await engine.download()).toEqual({
      kind: "failed",
      stage: "download",
      cause: "write-failed",
    });
    expect(sink.opened).toHaveLength(1);
    expect(downloads()).toEqual([]);
  });

  it.each([
    ["ENOSPC", "write-failed"],
    [undefined, "unreachable"],
  ] as const)(
    "keeps the socket reset or disk failure when a write finishes after the deadline (%s)",
    async (diskError, cause) => {
      const file = payload();
      const installer = {
        url: `${server.origin}/app.exe`,
        size: file.body.length,
        sha512: file.sha512,
      };
      server.route(
        "/feed.json",
        json(feedFor(server.origin, "0.2.0", installer, { files: { "win-x64": installer } })),
      );
      let socket: Socket;
      server.route("/app.exe", (request, response) => {
        socket = request.socket;
        response.writeHead(200, { "content-length": String(file.body.length) });
        response.write(file.body.subarray(0, 4096));
      });
      const { engine, states } = engineFor(server, dir.path, { platform: "win32", arch: "x64" });
      await engine.check();
      const closed = new Promise<void>((resolve) => {
        sink.responseClosed = resolve;
      });
      const pendingWrite = new Promise<FinishWrite>((resolve) => {
        sink.onWrite = resolve;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const download = engine.download();
      const finishWrite = await pendingWrite;
      socket!.destroy();
      await closed;
      await vi.advanceTimersByTimeAsync(60_001);
      finishWrite(diskError);
      expect(await download).toEqual({ kind: "failed", stage: "download", cause });
      expect(sink.opened).toHaveLength(1);
      expect(states.some((state) => state.kind === "ready")).toBe(false);
      expect(downloads()).toEqual([]);
    },
  );

  it("reports a disconnect after a recovered EAGAIN as unreachable", async () => {
    const file = payload(4096);
    const response = Promise.withResolvers<ServerResponse>();
    server.route(
      "/feed.json",
      json(feedFor(server.origin, "0.2.0", { size: 4096, sha512: file.sha512 })),
    );
    server.route("/files/app.zip", (_request, res) => {
      res.writeHead(200, { "content-length": 4096 });
      res.write(file.body.subarray(0, 1024));
      response.resolve(res);
    });
    const { engine } = engineFor(server, dir.path);
    await engine.check();
    let writes = 0;
    sink.onWrite = (finish) => finish(++writes === 1 ? "EAGAIN" : undefined);
    const pending = engine.download();
    const res = await response.promise;
    await vi.waitFor(() => expect(statSync(sink.opened[0]!).size).toBe(1024), { timeout: 5000 });
    res.destroy();
    expect(await pending).toMatchObject({ kind: "failed", cause: "unreachable" });
    expect(writes).toBeGreaterThan(1);
    expect(downloads()).toEqual([]);
  });

  it("reports write-failed when batched writes exhaust their EAGAIN retries", async () => {
    const file = payload(4096);
    const first = Promise.withResolvers<ServerResponse>();
    const corked = Promise.withResolvers<WriteStream>();
    sink.corked = corked.resolve;
    sink.onWrite = (finish) => finish("EAGAIN");
    server.route(
      "/feed.json",
      json(feedFor(server.origin, "0.2.0", { size: 4096, sha512: file.sha512 })),
    );
    server.route("/files/app.zip", (_request, res) => {
      res.writeHead(200, { "content-length": 4096 });
      res.write(file.body.subarray(0, 1024));
      first.resolve(res);
    });
    const { engine } = engineFor(server, dir.path);
    await engine.check();
    const pending = engine.download();
    const [response, stream] = await Promise.all([first.promise, corked.promise]);
    // End flushes both buffered chunks together through WriteStream's writev path.
    await vi.waitFor(() => expect(stream.writableLength).toBe(1024), { timeout: 5000 });
    response.end(file.body.subarray(1024));
    expect(await pending).toMatchObject({ kind: "failed", cause: "write-failed" });
    expect(sink.vectoredWrites).toBeGreaterThan(1);
    expect(downloads()).toEqual([]);
  });

  it("reports write-failed when closing the finished file fails, and deletes it", async () => {
    const file = payload();
    server.route(
      "/feed.json",
      json(feedFor(server.origin, "0.2.0", { size: file.body.length, sha512: file.sha512 })),
    );
    server.route("/files/app.zip", bytes(file.body));
    const { engine, states } = engineFor(server, dir.path);
    await engine.check();
    sink.closeError = "EIO";
    expect(await engine.download()).toEqual({
      kind: "failed",
      stage: "download",
      cause: "write-failed",
    });
    expect(states.some((state) => state.kind === "downloading" && state.step)).toBe(false);
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
