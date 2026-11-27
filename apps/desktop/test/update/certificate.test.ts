// The feed's certificate is always verified, and only against Node's bundled
// certificate authorities. The server is the test's own on 127.0.0.1, with a
// throwaway self-signed certificate that `openssl` makes in a temporary folder
// and that is never installed anywhere.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, get, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UpdateEngine } from "../../src/main/update/index.ts";
import { feedFor, payload, tempDir } from "./harness.ts";

let dir: { path: string; remove(): void };
let server: Server;
let origin: string;
let certificate: string;
const requests: string[] = [];

beforeAll(async () => {
  dir = tempDir();
  const key = join(dir.path, "key.pem");
  const cert = join(dir.path, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  certificate = readFileSync(cert, "utf8");
  server = createServer({ key: readFileSync(key), cert: certificate }, (request, response) => {
    requests.push(request.url ?? "");
    const file = payload(1000);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(feedFor(origin, "0.2.0", { size: 1000, sha512: file.sha512 })));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  try {
    dir.remove();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const engine = () =>
  new UpdateEngine({
    feedAddress: `${origin}/feed.json`,
    currentVersion: "0.1.0",
    downloadDir: dir.path,
    platform: "darwin",
    arch: "arm64",
  });

/** A request the way Node makes one by default, to show the environment's switch is in effect. */
const plainRequest = () =>
  new Promise<number>((resolve, reject) => {
    get(`${origin}/plain`, { agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    }).on("error", reject);
  });

describe("the feed's certificate", () => {
  it("is verified even when NODE_TLS_REJECT_UNAUTHORIZED=0 turns Node's default check off", async () => {
    const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    requests.length = 0;
    try {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      expect(await plainRequest()).toBe(200);
      expect(await engine().check()).toEqual({
        kind: "failed",
        stage: "check",
        cause: "unreachable",
      });
      expect(requests).toEqual(["/plain"]);
    } finally {
      if (saved === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = saved;
    }
  });

  it("is checked against Node's bundled authorities only, not ones added to the process's default", async () => {
    const saved = getCACertificates("default");
    requests.length = 0;
    try {
      setDefaultCACertificates([certificate]);
      expect(await plainRequest()).toBe(200);
      expect(await engine().check()).toEqual({
        kind: "failed",
        stage: "check",
        cause: "unreachable",
      });
      expect(requests).toEqual(["/plain"]);
    } finally {
      setDefaultCACertificates(saved);
    }
  });
});
