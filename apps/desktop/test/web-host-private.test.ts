// Private mode: a secret kept in the data folder, a sign-in page at the bare
// URL, and sessions that last across host restarts until the secret rotates.

import {
  ACCESS_REFUSED_CLOSE_CODE,
  AttachmentStore,
  createStore,
  initialState,
  type ClawtrateClient,
} from "@clawtrate/core";
import { chmodSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { tempDir } from "../../../test/temp-dir.ts";
import type { HostRuntime } from "../src/host/runtime.ts";
import {
  ACCESS_SECRET_FILE,
  listenChoice,
  loadAccessSecret,
  MAX_AUTH_ATTEMPTS,
  MAX_AUTH_BODY_BYTES,
  SESSION_MAX_AGE_S,
  signSession,
} from "../src/web-host/access.ts";
import { ACCESS_COOKIE, startWebHost } from "../src/web-host/server.ts";

const PUBLIC = "https://clawtrate.example";
const hosts: ReturnType<typeof startWebHost>[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

async function start(
  dataDir: string,
  options: { publicOrigin?: string | null; rotate?: boolean; token?: string } = {},
) {
  const staticDir = tempDir("clawtrate-static-");
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Clawtrate app</title>");
  const state = createStore(initialState);
  const runtime: HostRuntime = {
    client: {
      store: state,
      get state() {
        return state.get();
      },
      withdraw: () => {},
    } as unknown as ClawtrateClient,
    info: { kind: "web", version: "test", devGateway: null },
    policy: { attachments: new AttachmentStore({ newId: () => "up-1" }) },
  };
  const { secret } = loadAccessSecret(dataDir, options.rotate);
  const host = startWebHost({
    runtime,
    staticDir,
    host: "127.0.0.1",
    port: 0,
    accessToken: options.token ?? { secret, publicOrigin: options.publicOrigin ?? null },
  });
  hosts.push(host);
  await new Promise((resolve) => host.server.once("listening", resolve));
  return { secret, base: `http://127.0.0.1:${(host.server.address() as AddressInfo).port}` };
}

function post(
  url: string,
  headers: Record<string, string>,
  body = "",
): Promise<{ status: number; cookie: string; location: string; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers: { "content-length": String(Buffer.byteLength(body)), ...headers },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => (text += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            cookie: res.headers["set-cookie"]?.[0] ?? "",
            location: res.headers.location ?? "",
            text,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const form = { "content-type": "application/x-www-form-urlencoded" };

function signIn(base: string, secret: string, origin = base) {
  return post(`${base}/auth`, { ...form, origin }, `secret=${encodeURIComponent(secret)}`);
}

const pair = (setCookie: string) => setCookie.split(";")[0]!;

function page(base: string, cookie?: string) {
  return fetch(`${base}/`, { headers: cookie ? { cookie } : {} });
}

function openBridge(base: string, headers: Record<string, string>): Promise<"open" | number> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${base.replace("http", "ws")}/bridge`, { headers });
    socket.once("open", () => {
      resolve("open");
      socket.close();
    });
    socket.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    socket.once("error", () => {});
  });
}

describe("private web host", () => {
  it("keeps one secret, owner-only, and a signed-in bookmark works after the host restarts", async () => {
    const dataDir = tempDir("clawtrate-private-");
    const first = await start(dataDir);
    expect(statSync(join(dataDir, ACCESS_SECRET_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    const signedIn = await signIn(first.base, first.secret);
    expect(signedIn.status).toBe(303);
    expect(signedIn.location).toBe("/");
    await hosts.pop()!.close();

    const again = loadAccessSecret(dataDir);
    expect(again).toEqual({ secret: first.secret, created: false });
    const second = await start(dataDir);
    const bookmark = await page(second.base, pair(signedIn.cookie));
    expect(bookmark.status).toBe(200);
    expect(await bookmark.text()).toContain("Clawtrate app");
    expect(
      await openBridge(second.base, { cookie: pair(signedIn.cookie), origin: second.base }),
    ).toBe("open");
  });

  it("refuses a secret file that is a link or that others can read", () => {
    const dataDir = tempDir("clawtrate-private-");
    const elsewhere = join(tempDir("clawtrate-elsewhere-"), "secret");
    writeFileSync(elsewhere, `${"a".repeat(43)}\n`, { mode: 0o600 });
    symlinkSync(elsewhere, join(dataDir, ACCESS_SECRET_FILE));
    expect(() => loadAccessSecret(dataDir)).toThrow(/link/);

    const open = tempDir("clawtrate-private-");
    loadAccessSecret(open);
    chmodSync(join(open, ACCESS_SECRET_FILE), 0o644);
    expect(() => loadAccessSecret(open)).toThrow(/owner only/);
  });

  it("reuses the paired device in the data folder, through creation and rotation", () => {
    const dataDir = tempDir("clawtrate-private-");
    const key = join(dataDir, "device-key.pem");
    const state = join(dataDir, "state.json");
    writeFileSync(key, "paired device key", { mode: 0o600 });
    writeFileSync(state, '{"deviceToken":"kept"}', { mode: 0o600 });
    chmodSync(dataDir, 0o700);
    const created = loadAccessSecret(dataDir);
    const rotated = loadAccessSecret(dataDir, true);
    expect(rotated.created).toBe(true);
    expect(rotated.secret).not.toBe(created.secret);
    expect(readFileSync(key, "utf8")).toBe("paired device key");
    expect(readFileSync(state, "utf8")).toBe('{"deviceToken":"kept"}');
  });

  it("serves a sign-in form at the bare URL and signs in with the secret, never putting it in the cookie", async () => {
    const { base, secret } = await start(tempDir("clawtrate-private-"));
    const signInPage = await page(base);
    expect(signInPage.status).toBe(401);
    expect(signInPage.headers.get("cache-control")).toBe("no-store");
    const html = await signInPage.text();
    expect(html).toContain('action="/auth"');
    expect(html).not.toContain("Clawtrate app");
    expect((await fetch(`${base}/?token=${secret}`, { redirect: "manual" })).status).toBe(401);

    const ok = await signIn(base, `  ${secret}\n`);
    expect(ok.status).toBe(303);
    expect(ok.cookie).toMatch(new RegExp(`^${ACCESS_COOKIE}=`));
    expect(ok.cookie).toMatch(/HttpOnly/);
    expect(ok.cookie).toMatch(/SameSite=Strict/);
    expect(ok.cookie).toMatch(/Path=\//);
    expect(ok.cookie).toMatch(/Max-Age=2592000/);
    expect(ok.cookie).not.toMatch(/Secure/);
    expect(ok.cookie).not.toContain(secret);
    expect((await page(base, pair(ok.cookie))).status).toBe(200);

    expect((await page(base, `${ACCESS_COOKIE}=${secret}`)).status).toBe(401);
    const forged = pair(ok.cookie).replace(/=\d+\./, "=9999999999.");
    expect((await page(base, forged)).status).toBe(401);
  });

  it("refuses a wrong secret, another origin and an oversized form, and bounds the attempts", async () => {
    const { base, secret } = await start(tempDir("clawtrate-private-"));
    expect((await signIn(base, secret, "http://evil.example")).status).toBe(403);
    const big = await post(
      `${base}/auth`,
      { ...form, origin: base },
      "x".repeat(MAX_AUTH_BODY_BYTES + 1),
    );
    expect(big.status).toBe(413);
    for (let i = 2; i <= MAX_AUTH_ATTEMPTS; i += 1) {
      const wrong = await signIn(base, "wrong");
      expect(wrong.status).toBe(401);
      expect(wrong.cookie).toBe("");
      expect(wrong.text).toContain("That secret is not right.");
    }
    const limited = await signIn(base, secret);
    expect(limited.status).toBe(429);
    expect(limited.cookie).toBe("");
  });

  it("signs one browser out and leaves the others signed in", async () => {
    const { base, secret } = await start(tempDir("clawtrate-private-"));
    const one = pair((await signIn(base, secret)).cookie);
    const other = pair((await signIn(base, secret)).cookie);
    expect(
      (await post(`${base}/logout`, { cookie: one, origin: "http://evil.example" })).status,
    ).toBe(403);
    const out = await post(`${base}/logout`, { cookie: one, origin: base });
    expect(out.status).toBe(204);
    expect(out.cookie).toMatch(new RegExp(`^${ACCESS_COOKIE}=;`));
    expect(out.cookie).toMatch(/Max-Age=0/);
    expect((await page(base, pair(out.cookie))).status).toBe(401);
    expect((await page(base, other)).status).toBe(200);
  });

  it("signs every browser out when the secret rotates", async () => {
    const dataDir = tempDir("clawtrate-private-");
    const before = await start(dataDir);
    const cookie = pair((await signIn(before.base, before.secret)).cookie);
    await hosts.pop()!.close();
    const after = await start(dataDir, { rotate: true });
    expect(after.secret).not.toBe(before.secret);
    expect((await page(after.base, cookie)).status).toBe(401);
    expect(await openBridge(after.base, { cookie, origin: after.base })).toBe(401);
    expect((await signIn(after.base, before.secret)).status).toBe(401);
    expect((await signIn(after.base, after.secret)).status).toBe(303);
  });

  it("closes a bridge socket when its session expires, and admits it no more", async () => {
    const { base, secret } = await start(tempDir("clawtrate-private-"));
    // Signed almost a whole session ago, so it has about a second left.
    const cookie = `${ACCESS_COOKIE}=${signSession(secret, Date.now() - SESSION_MAX_AGE_S * 1000 + 1500)}`;
    const socket = new WebSocket(`${base.replace("http", "ws")}/bridge`, {
      headers: { cookie, origin: base },
    });
    await new Promise((resolve) => socket.once("open", resolve));
    const code = await new Promise<number>((resolve) => socket.once("close", resolve));
    expect(code).toBe(ACCESS_REFUSED_CLOSE_CODE);
    expect(await openBridge(base, { cookie, origin: base })).toBe(401);
  });

  it("a session that expires while its bridge is admitted gets a closing socket, never an open-ended one", async () => {
    const { base, secret } = await start(tempDir("clawtrate-private-"));
    const real = Date.now();
    // Two seconds left at the first look; every look after it, ten seconds later.
    const cookie = `${ACCESS_COOKIE}=${signSession(secret, real - SESSION_MAX_AGE_S * 1000 + 2000)}`;
    let looks = 0;
    const clock = vi
      .spyOn(Date, "now")
      .mockImplementation(() => (looks++ === 0 ? real : real + 10_000));
    try {
      const socket = new WebSocket(`${base.replace("http", "ws")}/bridge`, {
        headers: { cookie, origin: base },
      });
      const received: unknown[] = [];
      socket.on("message", (data) => received.push(data));
      const code = await new Promise<number>((resolve) => {
        socket.once("close", resolve);
        socket.once("unexpected-response", () => resolve(401));
      });
      expect([ACCESS_REFUSED_CLOSE_CODE, 401]).toContain(code);
      // Not even the hello's snapshot went out after the session expired.
      expect(received).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  it("behind an HTTPS public origin, sets Secure cookies and takes uploads and the bridge from it", async () => {
    const { base, secret } = await start(tempDir("clawtrate-private-"), { publicOrigin: PUBLIC });
    const ok = await signIn(base, secret, PUBLIC);
    expect(ok.status).toBe(303);
    expect(ok.cookie).toMatch(/; Secure/);
    const cookie = pair(ok.cookie);
    const upload = await post(
      `${base}/attachments?name=a.txt&type=text%2Fplain`,
      { cookie, origin: PUBLIC },
      "hello",
    );
    expect(upload.status).toBe(200);
    const elsewhere = await post(
      `${base}/attachments?name=a.txt&type=text%2Fplain`,
      { cookie, origin: "https://other.example" },
      "hello",
    );
    expect(elsewhere.status).toBe(401);
    expect(await openBridge(base, { cookie, origin: PUBLIC })).toBe("open");
    expect(await openBridge(base, { cookie, origin: "https://other.example" })).toBe(401);
  });
});

describe("web host listen choice", () => {
  const flags = {
    private: false,
    "rotate-access-secret": false,
    "no-access-token": false,
    "dev-gateway": false,
    "setup-look": false,
  };

  it("keeps the disposable mode: every interface, a token per start, no sign-in", async () => {
    expect(listenChoice(flags)).toEqual({ host: "0.0.0.0", publicOrigin: null });
    expect(listenChoice({ ...flags, "no-access-token": true, "dev-gateway": true })).toEqual({
      host: "0.0.0.0",
      publicOrigin: null,
    });
    const { base } = await start(tempDir("clawtrate-token-"), { token: "a-token" });
    const denied = await page(base);
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain("<form");
    expect((await signIn(base, "a-token")).status).toBe(401);
    const link = await fetch(`${base}/?token=a-token`, { redirect: "manual" });
    expect(link.status).toBe(302);
    expect(link.headers.get("set-cookie")).toBe(
      `${ACCESS_COOKIE}=a-token; HttpOnly; SameSite=Strict; Path=/`,
    );
  });

  it("listens on loopback in private mode and refuses any other plain-HTTP bind", () => {
    const own = { ...flags, private: true };
    expect(listenChoice(own)).toEqual({ host: "127.0.0.1", publicOrigin: null });
    expect(listenChoice({ ...own, host: "::1" }).host).toBe("::1");
    for (const host of ["0.0.0.0", "203.0.113.20", "::", "localhost"]) {
      expect(() => listenChoice({ ...own, host })).toThrow(/loopback/);
    }
    expect(listenChoice({ ...own, "public-origin": PUBLIC })).toEqual({
      host: "127.0.0.1",
      publicOrigin: PUBLIC,
    });
    expect(() => listenChoice({ ...own, host: "0.0.0.0", "public-origin": PUBLIC })).toThrow(
      /loopback/,
    );
    for (const origin of ["http://clawtrate.example", `${PUBLIC}/`, `${PUBLIC}/app`, "nonsense"]) {
      expect(() => listenChoice({ ...own, "public-origin": origin })).toThrow(/https:\/\/host/);
    }
  });

  it("refuses private mode with the disposable flags, and its own flags without it", () => {
    const own = { ...flags, private: true };
    for (const flag of ["no-access-token", "dev-gateway", "setup-look"] as const) {
      expect(() => listenChoice({ ...own, [flag]: true })).toThrow(
        `--private cannot be used with --${flag}`,
      );
    }
    expect(() => listenChoice({ ...flags, "rotate-access-secret": true })).toThrow(
      /only allowed with --private/,
    );
    expect(() => listenChoice({ ...flags, "public-origin": PUBLIC })).toThrow(
      /only allowed with --private/,
    );
  });

  it("refuses private mode on Windows, where it cannot check that the secret is owner-only", () => {
    expect(() => listenChoice({ ...flags, private: true }, "win32")).toThrow(
      "--private is not available on Windows yet",
    );
    expect(listenChoice(flags, "win32")).toEqual({ host: "0.0.0.0", publicOrigin: null });
  });
});
