// C-05: the browser's debugging endpoints are used only on literal loopback,
// with no redirects, and only through a debugger URL on the same address and
// port. Discovery here goes to real servers on loopback, so a redirect is a
// real one, not only the fetch option.

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { cdpTargets } from "../lib/cdp.js";
import { parseCdpUrl } from "../lib/config.js";
import { ATLAS_TAB, FOREIGN_TAB, FakeBrowser, load, page } from "./harness.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** A loopback server answering every request with `handler`. Returns its port. */
async function serve(
  handler: (
    url: string,
    port: number,
  ) => { status: number; headers?: Record<string, string>; body?: string },
  host = "127.0.0.1",
): Promise<number> {
  const server = createServer((req, res) => {
    const port = (server.address() as { port: number }).port;
    const { status, headers = {}, body = "" } = handler(req.url ?? "/", port);
    res.writeHead(status, headers);
    res.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return (server.address() as { port: number }).port;
}

/** A private-range address, built here so no such literal sits in the repository. */
const PRIVATE_ADDRESS = [10, 0, 0, 1].join(".");

const bot = (base: string) => ({ agentId: "atlas", profile: "bot-atlas", ...parseCdpUrl(base) });

describe("C-05a: only literal loopback endpoints are accepted", () => {
  it("refuses hostnames, other addresses, credentials, paths, other schemes and bad ports", () => {
    for (const url of [
      "http://localhost:9222",
      "http://example.invalid:9222",
      `http://${PRIVATE_ADDRESS}:9222`,
      "http://127.0.0.2:9222",
      "http://0.0.0.0:9222",
      "http://[::ffff:127.0.0.1]:9222",
      "http://user:pass@127.0.0.1:9222",
      "http://127.0.0.1@example.invalid:9222",
      "https://127.0.0.1:9222",
      "ws://127.0.0.1:9222",
      "http://127.0.0.1:9222/json",
      "http://127.0.0.1:9222?x=1",
      "http://127.0.0.1",
      "http://127.0.0.1:0",
      "http://127.0.0.1:09222",
      "http://127.0.0.1:65536",
      " http://127.0.0.1:9222",
    ]) {
      expect(() => parseCdpUrl(url), url).toThrow(/cdpUrl/);
    }
    expect(parseCdpUrl("http://127.0.0.1:9222/")).toMatchObject({ host: "127.0.0.1", port: 9222 });
    expect(parseCdpUrl("http://[::1]:9222")).toMatchObject({
      host: "[::1]",
      port: 9222,
      base: "http://[::1]:9222",
    });
  });

  it("a plugin config with an outside endpoint does not load and contacts nothing", () => {
    const browser = new FakeBrowser();
    expect(() =>
      load({
        browser,
        config: {
          bots: { atlas: { profile: "bot-atlas", cdpUrl: "http://example.invalid:9222" } },
        },
      }),
    ).toThrow();
    expect(browser.fetches).toEqual([]);
  });
});

describe("C-05b: discovery refuses redirects", () => {
  it("asks fetch for no redirects", async () => {
    const h = load();
    await h.call("tabs", {});
    expect(h.browser.fetches.length).toBeGreaterThan(0);
    expect(h.browser.fetches.every((f) => f.init?.redirect === "error")).toBe(true);
  });

  it("a real redirect, to loopback or elsewhere, is refused and not followed", async () => {
    let followed = 0;
    const target = await serve(() => {
      followed += 1;
      return { status: 200, body: "[]" };
    });
    for (const status of [301, 302, 307, 308]) {
      const port = await serve(() => ({
        status,
        headers: { location: `http://127.0.0.1:${target}/json/list` },
      }));
      await expect(cdpTargets(bot(`http://127.0.0.1:${port}`))).rejects.toThrow();
    }
    expect(followed).toBe(0);
  });

  it("a fetch that followed a redirect anyway is refused", async () => {
    const response = new Response("[]", { status: 200 });
    Object.defineProperty(response, "redirected", { value: true });
    await expect(
      cdpTargets(bot("http://127.0.0.1:19113"), { fetchImpl: async () => response }),
    ).rejects.toMatchObject({
      reason: "discovery_failed",
    });
  });

  it("a status other than 200, a body that is not JSON or too large is refused", async () => {
    for (const answer of [
      { status: 500, body: "[]" },
      { status: 200, body: "not json" },
      { status: 200, body: `[${"0,".repeat(600000)}0]` },
    ]) {
      const port = await serve(() => answer);
      await expect(
        cdpTargets(bot(`http://127.0.0.1:${port}`)),
        String(answer.status),
      ).rejects.toThrow();
    }
  });
});

describe("C-05c: only a debugger URL on the same address and port", () => {
  it("drops targets whose debugger URL is on another host, another port, another scheme or path", async () => {
    const port = await serve((_url, own) => ({
      status: 200,
      body: JSON.stringify([
        page(`http://127.0.0.1:${own}`, ATLAS_TAB),
        {
          ...page(`http://127.0.0.1:${own}`, FOREIGN_TAB),
          webSocketDebuggerUrl: `ws://127.0.0.1:${own + 1}/devtools/page/${FOREIGN_TAB}`,
        },
        {
          ...page(`http://127.0.0.1:${own}`, "D".repeat(32)),
          webSocketDebuggerUrl: `ws://evil.invalid:${own}/devtools/page/${"D".repeat(32)}`,
        },
        {
          ...page(`http://127.0.0.1:${own}`, "E".repeat(32)),
          webSocketDebuggerUrl: `wss://127.0.0.1:${own}/devtools/page/${"E".repeat(32)}`,
        },
        {
          ...page(`http://127.0.0.1:${own}`, "F".repeat(32)),
          webSocketDebuggerUrl: `ws://user@127.0.0.1:${own}/devtools/page/${"F".repeat(32)}`,
        },
        {
          ...page(`http://127.0.0.1:${own}`, "1".repeat(32)),
          webSocketDebuggerUrl: `ws://127.0.0.1:${own}/devtools/browser/${"1".repeat(32)}`,
        },
        {
          ...page(`http://127.0.0.1:${own}`, "2".repeat(32)),
          webSocketDebuggerUrl: `ws://[::1]:${own}/devtools/page/${"2".repeat(32)}`,
        },
        { ...page(`http://127.0.0.1:${own}`, "3".repeat(32)), type: "service_worker" },
        { ...page(`http://127.0.0.1:${own}`, "../x/../../y"), id: "../x" },
      ]),
    }));
    const targets = await cdpTargets(bot(`http://127.0.0.1:${port}`));
    expect(targets.map((t) => t.id)).toEqual([ATLAS_TAB]);
  });

  it("an IPv6 loopback endpoint accepts only its own IPv6 debugger URLs", async () => {
    let port: number;
    try {
      port = await serve(
        (_url, own) => ({
          status: 200,
          body: JSON.stringify([
            {
              ...page(`http://127.0.0.1:${own}`, ATLAS_TAB),
              webSocketDebuggerUrl: `ws://[::1]:${own}/devtools/page/${ATLAS_TAB}`,
            },
            page(`http://127.0.0.1:${own}`, FOREIGN_TAB),
          ]),
        }),
        "::1",
      );
    } catch {
      return; // no IPv6 loopback on this machine
    }
    const targets = await cdpTargets(bot(`http://[::1]:${port}`));
    expect(targets.map((t) => t.id)).toEqual([ATLAS_TAB]);
  });

  it("a foreign debugger URL is never connected to, through view or control", async () => {
    const h = load();
    h.browser.lists.set("http://127.0.0.1:19113", [
      {
        ...page("http://127.0.0.1:19113", FOREIGN_TAB),
        webSocketDebuggerUrl: `ws://127.0.0.1:19999/devtools/page/${FOREIGN_TAB}`,
      },
    ]);
    expect((await h.call("view.open", { targetId: FOREIGN_TAB })).ok).toBe(false);
    expect((await h.call("control.take", { targetId: FOREIGN_TAB })).ok).toBe(false);
    expect(h.browser.log.filter((e) => e.kind === "connect")).toEqual([]);
  });

  it("every connection the plugin makes is the bot's own endpoint", async () => {
    const h = load();
    const generation = (await h.call("control.take", { targetId: ATLAS_TAB })).payload!.generation;
    await h.call("input", { targetId: ATLAS_TAB, generation, kind: "text", text: "x" });
    const opened = await h.call("view.open", { targetId: ATLAS_TAB });
    await h.upgrade(String(opened.payload!.wsPath));
    const urls = new Set(h.browser.log.filter((e) => e.kind === "connect").map((e) => e.url));
    expect(urls).toEqual(new Set([`ws://127.0.0.1:19113/devtools/page/${ATLAS_TAB}`]));
    expect(h.browser.fetches.every((f) => f.url === "http://127.0.0.1:19113/json/list")).toBe(true);
  });
});
