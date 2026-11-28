// Connect an account's tiles (docs/design/bots.md, section 5): the gateway's sign-in methods,
// grouped by provider, from what OpenClaw 2026.10.6 and 2026.11.10 send in
// `models.authStatus` `providerCapabilities[].loginOptions[]` (read from a development gateway of
// each, without its scripted plugin's provider), and what happens to one the app doesn't know.

import {
  providerName,
  readKeyProviders,
  readMethods,
  SETUP_TOKEN_METHOD,
  setupTokenMethods,
  type GatewayAccount,
} from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { FIRST_TILES, KNOWN_PROVIDERS, providerTiles } from "../src/bots/provider-tiles.ts";

/** OpenClaw 2026.10.6's sign-ins, as its gateway sends them. */
const OPENCLAW_2026_10_6 = [
  {
    provider: "github-copilot",
    loginOptions: [
      {
        id: "github-copilot/github-copilot",
        label: "GitHub Copilot",
        hint: "Device login with your GitHub account",
        groupLabel: "Copilot",
        kind: "device-code",
      },
      {
        id: "github-copilot/github-copilot-enterprise",
        label: "GitHub Copilot (Enterprise / data residency)",
        hint: "Device login against your GitHub Enterprise (*.ghe.com) tenant",
        groupLabel: "Copilot",
        kind: "device-code",
      },
    ],
  },
  {
    provider: "minimax-portal",
    loginOptions: [
      {
        id: "minimax/minimax-cn-oauth",
        label: "MiniMax OAuth (CN)",
        hint: "CN endpoint - api.minimaxi.com",
        groupLabel: "MiniMax",
        kind: "device-code",
      },
      {
        id: "minimax/minimax-global-oauth",
        label: "MiniMax OAuth (Global)",
        hint: "Global endpoint - api.minimax.io",
        groupLabel: "MiniMax",
        kind: "device-code",
      },
    ],
  },
  {
    provider: "openai",
    loginOptions: [
      {
        id: "openai/openai-device-code",
        label: "Codex login (device code)",
        hint: "Use a browser code when OpenClaw runs on a remote VM",
        groupLabel: "OpenAI",
        kind: "device-code",
      },
      {
        id: "openai/openai",
        label: "Codex login (browser)",
        hint: "Sign in to Codex locally with your ChatGPT account",
        groupLabel: "OpenAI",
        kind: "oauth",
      },
      {
        id: "openai/openai-token-sharing",
        label: "Sign in with ChatGPT (Beta)",
        hint: "Authorize OpenClaw for eligible Responses models using your Codex allowance",
        groupLabel: "OpenAI",
        kind: "oauth",
      },
    ],
  },
  {
    provider: "openrouter",
    loginOptions: [
      {
        id: "openrouter/openrouter-oauth",
        label: "OpenRouter OAuth",
        hint: "Browser sign-in",
        groupLabel: "OpenRouter",
        kind: "oauth",
      },
    ],
  },
  {
    provider: "xai",
    loginOptions: [
      {
        id: "xai/xai-oauth",
        label: "xAI OAuth",
        hint: "Remote-friendly browser sign-in without a localhost callback",
        groupLabel: "xAI (Grok)",
        kind: "device-code",
      },
    ],
  },
];

/** OpenClaw 2026.11.10's: OpenCode Go is new, and Sign in with ChatGPT lost "(Beta)". */
const OPENCLAW_2026_11_10 = [
  {
    provider: "github-copilot",
    loginOptions: [
      {
        id: "github-copilot/github-copilot",
        label: "GitHub Copilot",
        hint: "Device login with your GitHub account",
        groupLabel: "Copilot",
        kind: "device-code",
      },
      {
        id: "github-copilot/github-copilot-enterprise",
        label: "GitHub Copilot (Enterprise / data residency)",
        hint: "Device login against your GitHub Enterprise (*.ghe.com) tenant",
        groupLabel: "Copilot",
        kind: "device-code",
      },
    ],
  },
  {
    provider: "minimax-portal",
    loginOptions: [
      {
        id: "minimax/minimax-cn-oauth",
        label: "MiniMax OAuth (CN)",
        hint: "CN endpoint - api.minimaxi.com",
        groupLabel: "MiniMax",
        kind: "device-code",
      },
      {
        id: "minimax/minimax-global-oauth",
        label: "MiniMax OAuth (Global)",
        hint: "Global endpoint - api.minimax.io",
        groupLabel: "MiniMax",
        kind: "device-code",
      },
    ],
  },
  {
    provider: "openai",
    loginOptions: [
      {
        id: "openai/openai-device-code",
        label: "Codex login (device code)",
        hint: "Use a browser code when OpenClaw runs on a remote VM",
        groupLabel: "OpenAI",
        kind: "device-code",
      },
      {
        id: "openai/openai",
        label: "Codex login (browser)",
        hint: "Sign in to Codex locally with your ChatGPT account",
        groupLabel: "OpenAI",
        kind: "oauth",
      },
      {
        id: "openai/openai-token-sharing",
        label: "Sign in with ChatGPT",
        hint: "Use your ChatGPT plan for eligible Responses API requests",
        groupLabel: "OpenAI",
        kind: "oauth",
      },
    ],
  },
  {
    provider: "opencode-go",
    loginOptions: [
      {
        id: "opencode-go/opencode-go-console",
        label: "OpenCode Go (browser sign-in)",
        hint: "Sign in in your browser and pick a Console workspace with Go",
        groupLabel: "OpenCode Go",
        kind: "oauth",
      },
    ],
  },
  {
    provider: "openrouter",
    loginOptions: [
      {
        id: "openrouter/openrouter-oauth",
        label: "OpenRouter OAuth",
        hint: "Browser sign-in",
        groupLabel: "OpenRouter",
        kind: "oauth",
      },
    ],
  },
  {
    provider: "xai",
    loginOptions: [
      {
        id: "xai/xai-oauth",
        label: "xAI OAuth",
        hint: "Remote-friendly browser sign-in without a localhost callback",
        groupLabel: "xAI (Grok)",
        kind: "device-code",
      },
    ],
  },
];

/**
 * Anthropic, as both versions send it: a key, and no sign-in an app can start (its Claude plan
 * sign-ins are declared without `credentialOnly`, so `models.authLogin` refuses them).
 */
const ANTHROPIC = { provider: "anthropic", apiKeySupported: true, quickApiKeySetup: true };

const keysOf = (capabilities: unknown[]) =>
  readKeyProviders({
    profiles: [],
    providers: [],
    orders: {},
    keyed: [],
    capabilities: capabilities as Record<string, unknown>[],
    unavailable: null,
  });

const account = (id: string): GatewayAccount => ({
  id,
  provider: id.split(":")[0]!,
  label: null,
  type: "oauth",
  status: "ok",
  expiresAt: null,
  kind: "subscription",
  made: "sign-in",
  keptBy: null,
  logoutSupported: true,
});

const tilesOf = (capabilities: unknown[], accounts: GatewayAccount[] = []) =>
  providerTiles(
    readMethods(capabilities as Record<string, unknown>[]),
    accounts,
    keysOf(capabilities),
  );

const shape = (capabilities: unknown[], accounts: GatewayAccount[] = []) =>
  tilesOf(capabilities, accounts).map((tile) => ({
    name: tile.name,
    logo: tile.logo,
    methods: tile.methods.map(({ method, name }) => `${name} (${method.id})`),
  }));

describe("Connect an account: one tile per provider", () => {
  it("on OpenClaw 2026.10.6, five providers, each with its logo and its methods the usual one first", () => {
    expect(shape(OPENCLAW_2026_10_6)).toEqual([
      {
        name: "OpenAI",
        logo: "openai",
        methods: [
          "Use a device code (openai/openai-device-code)",
          "Sign in with a browser (openai/openai)",
          "Sign in with ChatGPT (openai/openai-token-sharing)",
        ],
      },
      {
        name: "GitHub Copilot",
        logo: "github-copilot",
        methods: [
          "Use a device code (github-copilot/github-copilot)",
          "GitHub Enterprise (github-copilot/github-copilot-enterprise)",
        ],
      },
      { name: "xAI", logo: "xai", methods: ["Use a device code (xai/xai-oauth)"] },
      {
        name: "OpenRouter",
        logo: "openrouter",
        methods: ["Sign in with a browser (openrouter/openrouter-oauth)"],
      },
      {
        name: "MiniMax",
        logo: "minimax",
        methods: [
          "Global account (minimax/minimax-global-oauth)",
          "China account (minimax/minimax-cn-oauth)",
        ],
      },
    ]);
  });

  it("on OpenClaw 2026.11.10, OpenCode Go as a sixth", () => {
    const tiles = shape(OPENCLAW_2026_11_10);
    expect(tiles.map((tile) => tile.name)).toEqual([
      "OpenAI",
      "GitHub Copilot",
      "xAI",
      "OpenRouter",
      "MiniMax",
      "OpenCode Go",
    ]);
    expect(tiles.at(-1)).toEqual({
      name: "OpenCode Go",
      logo: "opencode",
      methods: ["Sign in with a browser (opencode-go/opencode-go-console)"],
    });
    // Every sign-in the gateway offers is behind one tile, once.
    const offered = OPENCLAW_2026_11_10.flatMap((each) => each.loginOptions.map((o) => o.id));
    expect(
      providerTiles(readMethods(OPENCLAW_2026_11_10), [])
        .flatMap((tile) => tile.methods.map((m) => m.method.id))
        .sort(),
    ).toEqual(offered.sort());
  });

  it("shows the first six, most used first, whole rows of one, two or three; the rest wait behind Show more", () => {
    expect(FIRST_TILES).toBe(6);
    const names = (capabilities: unknown[]) => shape(capabilities).map((tile) => tile.name);
    // On 2026.10.6 every tile is among the first; on 2026.11.10 only OpenCode Go waits.
    expect(names([...OPENCLAW_2026_10_6, ANTHROPIC]).slice(FIRST_TILES)).toEqual([]);
    expect(names([...OPENCLAW_2026_11_10, ANTHROPIC]).slice(FIRST_TILES)).toEqual(["OpenCode Go"]);
    // Every tile that was among the first four before Claude came is still among the first.
    const first = names([...OPENCLAW_2026_11_10, ANTHROPIC]).slice(0, FIRST_TILES);
    for (const name of ["OpenAI", "GitHub Copilot", "xAI", "OpenRouter"])
      expect(first, name).toContain(name);
  });

  it("says on a provider's tile that the gateway already has an account of it, whichever id it is kept under", () => {
    const tiles = providerTiles(readMethods(OPENCLAW_2026_11_10), [
      account("openai-codex:work"),
      account("minimax-portal:home"),
    ]);
    expect(tiles.filter((tile) => tile.connected).map((tile) => tile.name)).toEqual([
      "OpenAI",
      "MiniMax",
    ]);
  });

  it("marks OpenRouter, whose sign-in saves a key, as billed per token", () => {
    const tiles = providerTiles(readMethods(OPENCLAW_2026_10_6), []);
    expect(tiles.filter((tile) => tile.perToken).map((tile) => tile.name)).toEqual(["OpenRouter"]);
  });

  it("leaves a method that takes a typed key to the API key path", () => {
    const tiles = providerTiles(
      readMethods([
        {
          provider: "acme",
          loginOptions: [
            {
              id: "acme/device",
              label: "Acme",
              groupLabel: "Acme (scripted)",
              kind: "device-code",
            },
            {
              id: "acme/key",
              label: "Acme API key",
              groupLabel: "Acme (scripted)",
              kind: "secret",
            },
          ],
        },
      ]),
      [],
    );
    expect(tiles.flatMap((tile) => tile.methods.map((m) => m.method.id))).toEqual(["acme/device"]);
  });

  it("names each provider as the rest of the app does, and Anthropic's tile for Claude", () => {
    for (const entry of KNOWN_PROVIDERS)
      for (const id of entry.providers)
        expect(providerName(id), id).toBe(entry.key === "claude" ? "Anthropic" : entry.name);
  });
});

describe("Claude", () => {
  it("is second on both versions, after OpenAI, with its own logo", () => {
    for (const version of [OPENCLAW_2026_10_6, OPENCLAW_2026_11_10]) {
      const tiles = shape([...version, ANTHROPIC]);
      expect(tiles.map((tile) => tile.name).slice(0, 3)).toEqual([
        "OpenAI",
        "Claude",
        "GitHub Copilot",
      ]);
      expect(tiles[1]).toEqual({ name: "Claude", logo: "claude", methods: [] });
    }
  });

  it("takes an Anthropic key on both versions, which offer no sign-in for it, and says it is billed per token", () => {
    for (const version of [OPENCLAW_2026_10_6, OPENCLAW_2026_11_10]) {
      const claude = tilesOf([...version, ANTHROPIC]).find((tile) => tile.key === "claude")!;
      expect(claude.keyProvider).toBe("anthropic");
      expect(claude.perToken).toBe(true);
      expect(claude.connected).toBe(false);
    }
    const claude = tilesOf([ANTHROPIC], [account("anthropic:work")])[0]!;
    expect(claude.connected).toBe(true);
  });

  it("is not shown when the gateway takes no Anthropic key and offers no sign-in for it", () => {
    expect(shape(OPENCLAW_2026_10_6).map((tile) => tile.name)).not.toContain("Claude");
  });

  it("lists a sign-in the gateway offers for it first, and keeps the key beside it", () => {
    const tiles = tilesOf([
      {
        ...ANTHROPIC,
        loginOptions: [
          {
            id: "anthropic/claude-plan",
            label: "Claude plan",
            groupLabel: "Anthropic",
            kind: "oauth",
          },
        ],
      },
    ]);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]!.methods.map((m) => m.method.id)).toEqual(["anthropic/claude-plan"]);
    expect(tiles[0]!.keyProvider).toBe("anthropic");
    expect(tiles[0]!.perToken).toBe(false);
  });

  it("on both versions, with the gateway's setup sign-in, offers the plan's setup token first, then the key (#932)", () => {
    for (const version of [OPENCLAW_2026_10_6, OPENCLAW_2026_11_10]) {
      const capabilities = [...version, ANTHROPIC] as Record<string, unknown>[];
      const methods = [...readMethods(capabilities), ...setupTokenMethods(capabilities, true)];
      const claude = providerTiles(methods, [], keysOf(capabilities)).find(
        (tile) => tile.key === "claude",
      )!;
      expect(claude.methods.map(({ method, name }) => `${name} (${method.id})`)).toEqual([
        `Paste a setup token (${SETUP_TOKEN_METHOD})`,
      ]);
      expect(claude.keyProvider).toBe("anthropic");
      expect(claude.perToken).toBe(false);
      // Without the setup method in the hello, the key alone, as before.
      const keyOnly = providerTiles(
        [...readMethods(capabilities), ...setupTokenMethods(capabilities, false)],
        [],
        keysOf(capabilities),
      ).find((tile) => tile.key === "claude")!;
      expect(keyOnly.methods).toEqual([]);
    }
  });

  it("is the only tile that a key alone brings: another provider's key stays in the API key path", () => {
    const tiles = tilesOf([{ provider: "opencode-go", apiKeySupported: true }, ANTHROPIC]);
    expect(tiles.map((tile) => tile.name)).toEqual(["Claude"]);
  });
});

describe("a provider or method the app doesn't know", () => {
  const PLUGIN = {
    provider: "nimbus",
    loginOptions: [
      {
        id: "nimbus/nimbus-device",
        label: "Nimbus device login",
        groupLabel: "Nimbus Cloud",
        kind: "device-code",
      },
      {
        id: "nimbus/nimbus-browser",
        label: "Nimbus in the browser",
        groupLabel: "Nimbus Cloud",
        kind: "oauth",
      },
    ],
  };

  it("still shows, after the known ones, under the gateway's own names, with no logo", () => {
    const tiles = shape([PLUGIN, ...OPENCLAW_2026_11_10]);
    expect(tiles.at(-1)).toEqual({
      name: "Nimbus Cloud",
      logo: null,
      methods: [
        "Nimbus device login (nimbus/nimbus-device)",
        "Nimbus in the browser (nimbus/nimbus-browser)",
      ],
    });
    expect(tiles).toHaveLength(7);
  });

  it("is named by its provider id when the gateway sends no name for it", () => {
    const tiles = shape([
      { provider: "nimbus", loginOptions: [{ id: "nimbus/x", kind: "oauth" }] },
    ]);
    expect(tiles).toEqual([{ name: "Nimbus", logo: null, methods: ["nimbus/x (nimbus/x)"] }]);
  });

  it("a newer method of a known provider goes behind its tile, after the known ones, under the gateway's label", () => {
    const openai = OPENCLAW_2026_11_10.find((each) => each.provider === "openai")!;
    const newer = {
      ...openai,
      loginOptions: [
        {
          id: "openai/openai-passkey",
          label: "Passkey login",
          groupLabel: "OpenAI",
          kind: "oauth",
        },
        ...openai.loginOptions,
      ],
    };
    expect(shape([newer])[0]!.methods).toEqual([
      "Use a device code (openai/openai-device-code)",
      "Sign in with a browser (openai/openai)",
      "Sign in with ChatGPT (openai/openai-token-sharing)",
      "Passkey login (openai/openai-passkey)",
    ]);
  });

  it("is named by its id even when the id is a name every object has, such as constructor", () => {
    const tiles = shape([
      { provider: "constructor", loginOptions: [{ id: "constructor/x", kind: "oauth" }] },
    ]);
    expect(tiles.map((tile) => tile.name)).toEqual(["Constructor"]);
  });

  it("an account of it says so on its tile", () => {
    const tiles = providerTiles(readMethods([PLUGIN]), [account("nimbus:main")]);
    expect(tiles[0]!.connected).toBe(true);
  });
});
