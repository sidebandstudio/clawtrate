// A feed server of the test's own, on 127.0.0.1 and a port the system picks,
// and a temporary download folder. Nothing here reaches another host.

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UpdateEngine,
  type UpdateEngineOptions,
  type UpdateState,
} from "../../src/main/update/index.ts";

export type Handler = (request: IncomingMessage, response: ServerResponse) => void;

export interface FeedServer {
  readonly port: number;
  readonly origin: string;
  /** Paths requested, in order. */
  readonly requests: string[];
  route(path: string, handler: Handler): void;
  close(): Promise<void>;
}

export async function feedServer(): Promise<FeedServer> {
  const routes = new Map<string, Handler>();
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    requests.push(request.url ?? "");
    const handler = routes.get(request.url ?? "");
    if (handler) return handler(request, response);
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    requests,
    route: (path, handler) => routes.set(path, handler),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const json =
  (body: unknown): Handler =>
  (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  };

export const bytes =
  (body: Buffer, options: { chunked?: boolean } = {}): Handler =>
  (_request, response) => {
    if (options.chunked) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(body);
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(body.length),
    });
    response.end(body);
  };

export function payload(size = 300_000): { body: Buffer; sha512: string } {
  const body = randomBytes(size);
  return { body, sha512: createHash("sha512").update(body).digest("base64") };
}

export function feedFor(
  origin: string,
  version: string,
  file: { size: number; sha512: string; path?: string },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    format: 1,
    track: "stable",
    version,
    releaseDate: "2026-11-01T00:00:00.000Z",
    files: {
      "mac-arm64": {
        url: `${origin}${file.path ?? "/files/app.zip"}`,
        size: file.size,
        sha512: file.sha512,
      },
    },
    ...extra,
  };
}

export function tempDir(): { path: string; remove(): void } {
  const path = mkdtempSync(join(tmpdir(), "clawtrate-update-"));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

/** An engine for the loopback server, on a Mac with Apple silicon, recording every state. */
export function engineFor(
  server: FeedServer,
  downloadDir: string,
  overrides: Partial<UpdateEngineOptions> = {},
): { engine: UpdateEngine; states: UpdateState[] } {
  const states: UpdateState[] = [];
  const engine = new UpdateEngine({
    feedAddress: `${server.origin}/feed.json`,
    currentVersion: "0.1.0",
    downloadDir,
    platform: "darwin",
    arch: "arm64",
    loopbackHttpForTests: { port: server.port },
    onState: (state) => states.push(state),
    ...overrides,
  });
  return { engine, states };
}
