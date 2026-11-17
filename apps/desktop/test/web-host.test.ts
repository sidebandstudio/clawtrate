import { createStore, initialState, type ClawtrateClient } from "@clawtrate/core";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { HostRuntime } from "../src/host/runtime.ts";
import { ACCESS_COOKIE, startWebHost } from "../src/web-host/server.ts";

const TOKEN = "test-access-token";
let host: ReturnType<typeof startWebHost>;
let base: string;

function openBridge(
  headers: Record<string, string>,
): Promise<{ code: "open" | number; first?: unknown }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${base.replace("http", "ws")}/bridge`, { headers });
    socket.once("message", (data) => {
      resolve({ code: "open", first: JSON.parse(String(data)) });
      socket.close();
    });
    socket.once("unexpected-response", (_req, res) => resolve({ code: res.statusCode ?? 0 }));
    socket.once("error", () => {});
  });
}

beforeAll(async () => {
  const staticDir = mkdtempSync(join(tmpdir(), "clawtrate-static-"));
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Clawtrate</title>");
  const store = createStore(initialState);
  const runtime: HostRuntime = {
    client: {
      store,
      get state() {
        return store.get();
      },
    } as unknown as ClawtrateClient,
    info: { kind: "web", version: "test", devGateway: null },
    policy: {},
  };
  host = startWebHost({ runtime, staticDir, host: "127.0.0.1", port: 0, accessToken: TOKEN });
  await new Promise((resolve) => host.server.once("listening", resolve));
  base = `http://127.0.0.1:${(host.server.address() as AddressInfo).port}`;
});

afterAll(() => host.close());

describe("web host access token", () => {
  it("serves nothing without the token", async () => {
    expect((await fetch(`${base}/`)).status).toBe(401);
    expect((await fetch(`${base}/index.html`)).status).toBe(401);
    expect((await fetch(`${base}/?token=wrong`)).status).toBe(401);
  });

  it("trades the token in the link for an HttpOnly cookie and drops it from the URL", async () => {
    const response = await fetch(`${base}/?token=${TOKEN}`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${ACCESS_COOKIE}=`);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const page = await fetch(`${base}/`, { headers: { cookie: cookie.split(";")[0]! } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Clawtrate");
  });

  it("guards the bridge socket with the cookie and the origin", async () => {
    expect((await openBridge({})).code).toBe(401);
    const cookie = `${ACCESS_COOKIE}=${TOKEN}`;
    const crossSite = await openBridge({ cookie, origin: "http://evil.example" });
    expect(crossSite.code).toBe(401);
    const ok = await openBridge({ cookie, origin: base });
    expect(ok.code).toBe("open");
    expect(ok.first).toMatchObject({ type: "hello", info: { kind: "web" } });
  });

  it("does not serve files outside the static directory", async () => {
    const response = await fetch(`${base}/..%2f..%2fpackage.json`, {
      headers: { cookie: `${ACCESS_COOKIE}=${TOKEN}` },
    });
    expect(await response.text()).not.toContain('"name"');
  });
});
