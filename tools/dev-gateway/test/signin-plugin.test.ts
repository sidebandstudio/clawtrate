// The development sign-in plugin (plugins/clawtrate-dev-signin) as trusted
// code: it works only inside a named development instance the tool started.
// Each test builds such an instance in a temporary home: the state folder,
// the tool's marker naming this process as the gateway, and a copy of the
// plugin inside the folder, as the gateway loads it.

import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECKOUT_DIR } from "../src/env.ts";
import { MARKER_FILE } from "../src/state-guard.ts";

const SOURCE = join(CHECKOUT_DIR, "plugins", "clawtrate-dev-signin", "index.js");
const temps: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "clawtrate-signin-")));
  temps.push(dir);
  return dir;
}

type ProviderAuthMethod = { id: string; run(ctx: unknown): Promise<unknown> };
type Provider = { id: string; auth: ProviderAuthMethod[] };
type Plugin = {
  register(api: unknown): void;
};

let loads = 0;
/** Import a copy of the plugin as a fresh module. */
async function load(path: string): Promise<Plugin> {
  loads += 1;
  const module = (await import(`${pathToFileURL(path).href}?load=${loads}`)) as {
    default: Plugin;
  };
  return module.default;
}

/** A gateway api that records what the plugin registers and logs. */
function api(signinUrl = "http://127.0.0.1:9/scripted/signin") {
  const providers: Provider[] = [];
  const warnings: string[] = [];
  return {
    providers,
    warnings,
    pluginConfig: { signinUrl },
    registerProvider: (provider: Provider) => providers.push(provider),
    logger: { warn: (line: string) => warnings.push(line) },
  };
}

/** A named development instance as the tool leaves it, with this process as its gateway. */
function instance(options: { marker?: Record<string, unknown> | null; name?: string } = {}) {
  const home = temp();
  const name = options.name ?? "signin";
  const stateDir = join(home, `.openclaw-clawtrate-dev-${name}`);
  const copy = join(stateDir, "clawtrate-plugins", "clawtrate-dev-signin", "index.js");
  mkdirSync(join(copy, ".."), { recursive: true });
  copyFileSync(SOURCE, copy);
  if (options.marker !== null) {
    writeFileSync(
      join(stateDir, MARKER_FILE),
      JSON.stringify({
        createdBy: "clawtrate tools/dev-gateway",
        instance: name,
        gatewayPid: process.pid,
        ...options.marker,
      }),
    );
  }
  vi.stubEnv("HOME", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_PROFILE", `clawtrate-dev-${name}`);
  return { home, stateDir, copy };
}

describe("the sign-in plugin outside a development instance", () => {
  it("registers nothing on a gateway the tool did not start, and says why in the log", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "");
    const gateway = api();
    (await load(SOURCE)).register(gateway);
    expect(gateway.providers).toEqual([]);
    expect(gateway.warnings).toEqual([
      "clawtrate-dev-signin registers no sign-ins here: the gateway runs with no OPENCLAW_STATE_DIR",
    ]);
  });

  it("registers its sign-ins inside an instance the tool started", async () => {
    const { copy } = instance();
    const gateway = api();
    (await load(copy)).register(gateway);
    expect(gateway.warnings).toEqual([]);
    expect(gateway.providers.map((p) => [p.id, p.auth.map((m) => m.id)])).toEqual([
      ["acme", ["device-code", "browser", "host", "callback", "api-key"]],
      ["globex", ["api-key"]],
    ]);
  });

  it("registers nothing when any of the tool's evidence is missing or another's", async () => {
    const cases: [string, () => string, RegExp][] = [
      ["no marker", () => instance({ marker: null }).copy, /has no readable marker/],
      [
        "another gateway's marker",
        () => instance({ marker: { gatewayPid: process.pid + 1 } }).copy,
        /is not the gateway the tool started/,
      ],
      [
        "another instance's marker",
        () => instance({ marker: { instance: "other" } }).copy,
        /marker is not the dev-gateway tool's for instance signin/,
      ],
      [
        "a marker someone else wrote",
        () => instance({ marker: { createdBy: "someone" } }).copy,
        /marker is not the dev-gateway tool's/,
      ],
      [
        "another profile",
        () => {
          const { copy } = instance();
          vi.stubEnv("OPENCLAW_PROFILE", "default");
          return copy;
        },
        /profile is "default"/,
      ],
      [
        "a state folder that is not a named instance's",
        () => {
          const { home, copy } = instance();
          vi.stubEnv("OPENCLAW_STATE_DIR", join(home, ".openclaw"));
          return copy;
        },
        /is not a named development instance's/,
      ],
      [
        "a state folder that is a link",
        () => {
          const { home, stateDir } = instance();
          symlinkSync(stateDir, join(home, ".openclaw-clawtrate-dev-link"));
          vi.stubEnv("OPENCLAW_STATE_DIR", join(home, ".openclaw-clawtrate-dev-link"));
          vi.stubEnv("OPENCLAW_PROFILE", "clawtrate-dev-link");
          return join(
            home,
            ".openclaw-clawtrate-dev-link",
            "clawtrate-plugins",
            "clawtrate-dev-signin",
            "index.js",
          );
        },
        /is not a real folder/,
      ],
      [
        "the plugin's code outside the instance",
        () => {
          instance();
          return SOURCE;
        },
        /outside the instance's state folder/,
      ],
    ];
    for (const [what, arrange, why] of cases) {
      const path = arrange();
      const gateway = api();
      (await load(path)).register(gateway);
      expect(gateway.providers, what).toEqual([]);
      expect(gateway.warnings, what).toEqual([expect.stringMatching(why)]);
      vi.unstubAllEnvs();
    }
  });

  it("checks again before each sign-in runs, and contacts nothing when the evidence is gone", async () => {
    const { stateDir, copy } = instance();
    const gateway = api();
    (await load(copy)).register(gateway);
    rmSync(join(stateDir, MARKER_FILE));
    const fetched = vi.spyOn(globalThis, "fetch");
    for (const method of gateway.providers.flatMap((provider) => provider.auth)) {
      await expect(
        method.run({ prompter: { text: async () => "clawtrate-dev-key.acme.x" } }),
        method.id,
      ).rejects.toThrow(/clawtrate-dev-signin refuses to sign in: .*has no readable marker/);
    }
    expect(fetched).not.toHaveBeenCalled();
    fetched.mockRestore();
  });
});

describe("the sign-in plugin's requests", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
  });

  /** A loopback server; returns its address and the bodies it received. */
  async function serve(
    answer: (body: string) => { status: number; headers?: Record<string, string>; body?: string },
  ) {
    const received: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        received.push(body);
        const reply = answer(body);
        res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
        res.end(reply.body ?? "{}");
      });
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    return {
      url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`,
      received,
    };
  }

  async function registered(signinUrl: string) {
    const { copy } = instance();
    const gateway = api(signinUrl);
    (await load(copy)).register(gateway);
    const method = (id: string) => gateway.providers[0]!.auth.find((m) => m.id === id)!;
    return { gateway, method };
  }

  it("never follows a redirect: the sign-in fails and the key goes nowhere else", async () => {
    // Both ends on loopback, so nothing leaves the machine even if it were followed.
    const elsewhere = await serve(() => ({
      status: 200,
      body: JSON.stringify({ status: "approved", account: "acme:caught" }),
    }));
    const scripted = await serve(() => ({
      status: 307,
      headers: { location: `${elsewhere.url}/capture` },
    }));
    const { method } = await registered(`${scripted.url}/scripted/signin`);
    const key = "clawtrate-dev-key.acme.review";
    await expect(method("api-key").run({ prompter: { text: async () => key } })).rejects.toThrow(
      /answered with a redirect, which this plugin never follows/,
    );
    expect(scripted.received).toHaveLength(1);
    expect(elsewhere.received).toEqual([]);
  });

  it("checks the address as loopback when each request is made, not only at registration", async () => {
    const { gateway, method } = await registered("http://127.0.0.1:9/scripted/signin");
    gateway.pluginConfig.signinUrl = "http://192.0.2.1/scripted/signin";
    const fetched = vi.spyOn(globalThis, "fetch");
    await expect(
      method("api-key").run({ prompter: { text: async () => "clawtrate-dev-key.acme.x" } }),
    ).rejects.toThrow(/must be the scripted model on 127\.0\.0\.1/);
    expect(fetched).not.toHaveBeenCalled();
    fetched.mockRestore();
  });

  /** The scripted side of a returning sign-in: a page, then the code the browser brings back. */
  async function returning(tokens: Record<string, unknown>) {
    return serve((body) => {
      const fields = JSON.parse(body || "{}") as Record<string, unknown>;
      if (fields.redirectUri !== undefined)
        return {
          status: 200,
          body: JSON.stringify({
            state: "s1",
            authorizeUrl: `http://127.0.0.1:9/scripted/signin/browser/authorize?state=s1`,
          }),
        };
      return {
        status: 200,
        body: JSON.stringify({ status: "approved", tokens, ...(fields.extra as object) }),
      };
    });
  }

  it("a sign-in on the gateway's machine shows the gateway's note with its port, and finishes when the browser comes back there", async () => {
    const tokens = {
      account: "acme:host",
      access: "a",
      refresh: "r",
      expires: 1,
      email: "x@acme.example",
    };
    const scripted = await returning(tokens);
    const { method } = await registered(`${scripted.url}/scripted/signin`);
    const notes: string[] = [];
    const opened: string[] = [];
    const run = method("host").run({
      openUrl: async (url: string) => void opened.push(url),
      prompter: { note: async (message: string) => void notes.push(message) },
    });
    await vi.waitFor(() => expect(notes).toHaveLength(1));
    const redirectUri = String(
      (JSON.parse(scripted.received[0]!) as { redirectUri: string }).redirectUri,
    );
    // A listener on the gateway's own machine, on loopback, and the port the note names.
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const port = new URL(redirectUri).port;
    expect(notes[0]).toContain(
      `forward the port with: ssh -N -L ${port}:127.0.0.1:${port} user@gateway-host`,
    );
    expect(opened).toEqual(["http://127.0.0.1:9/scripted/signin/browser/authorize?state=s1"]);
    // Another sign-in's state is refused, and the listener closes.
    const refused = expect(run).rejects.toThrow(/another sign-in's state/);
    expect((await fetch(`${redirectUri}?code=c1&state=other`)).status).toBe(200);
    await refused;
    await expect(fetch(redirectUri)).rejects.toThrow();
  });

  it("a returning sign-in brought back with its state saves the account; one approved as unconfirmed hands the gateway a setting it refuses", async () => {
    const tokens = {
      account: "acme:back",
      access: "a",
      refresh: "r",
      expires: 1,
      email: "x@acme.example",
    };
    for (const confirmed of [true, false]) {
      const scripted = await serve((body) => {
        const fields = JSON.parse(body || "{}") as Record<string, unknown>;
        return fields.redirectUri !== undefined
          ? {
              status: 200,
              body: JSON.stringify({ state: "s2", authorizeUrl: "http://127.0.0.1:9/a?state=s2" }),
            }
          : {
              status: 200,
              body: JSON.stringify({
                status: "approved",
                tokens,
                ...(confirmed ? {} : { confirmed: false }),
              }),
            };
      });
      const { method } = await registered(`${scripted.url}/scripted/signin`);
      const run = method("callback").run({ openUrl: async () => undefined, prompter: {} });
      await vi.waitFor(() => expect(scripted.received).toHaveLength(1));
      const redirectUri = (JSON.parse(scripted.received[0]!) as { redirectUri: string })
        .redirectUri;
      await fetch(`${redirectUri}?code=c2&state=s2`);
      const result = (await run) as {
        profiles: Array<{ profileId: string }>;
        configPatch?: unknown;
      };
      expect(result.profiles[0]?.profileId).toBe("acme:back");
      expect(result.configPatch !== undefined).toBe(!confirmed);
    }
  });
});
