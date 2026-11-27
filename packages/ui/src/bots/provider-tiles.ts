// Connect an account's tiles (bots.md section 5): the gateway's sign-in methods grouped by
// provider. The table is the one place that says which provider a method belongs to, its name and
// logo, and the order and plain names of its methods, the usual one first. A provider or method
// the table doesn't have still shows, under the gateway's own name, after the ones it has.

import { providerName, type GatewayAccount, type SignInMethod } from "@clawtrate/core";
import type { LogoKey } from "./logos/ProviderLogo.tsx";

type Known = {
  key: string;
  name: string;
  logo: LogoKey;
  /** The gateway's provider ids that are this provider: a method's, and an account's. */
  providers: readonly string[];
  /** Its methods by id, the usual one first, each with a short plain name. */
  methods: ReadonlyArray<{ id: string; name: string }>;
};

/**
 * The providers Clawtrate knows, the most used first: this order is the grid's. The methods are
 * every sign-in OpenClaw 2026.10.6 and 2026.11.10 can offer from their bundled plugins.
 */
export const KNOWN_PROVIDERS: readonly Known[] = [
  {
    key: "openai",
    name: "OpenAI",
    logo: "openai",
    providers: ["openai", "openai-codex"],
    methods: [
      { id: "openai/openai-device-code", name: "Use a device code" },
      { id: "openai/openai", name: "Sign in with a browser" },
      { id: "openai/openai-token-sharing", name: "Sign in with ChatGPT" },
    ],
  },
  {
    key: "github-copilot",
    name: "GitHub Copilot",
    logo: "github-copilot",
    providers: ["github-copilot"],
    methods: [
      { id: "github-copilot/github-copilot", name: "Use a device code" },
      { id: "github-copilot/github-copilot-enterprise", name: "GitHub Enterprise" },
    ],
  },
  {
    key: "xai",
    name: "xAI",
    logo: "xai",
    providers: ["xai"],
    methods: [{ id: "xai/xai-oauth", name: "Use a device code" }],
  },
  {
    key: "openrouter",
    name: "OpenRouter",
    logo: "openrouter",
    providers: ["openrouter"],
    methods: [{ id: "openrouter/openrouter-oauth", name: "Sign in with a browser" }],
  },
  {
    key: "minimax",
    name: "MiniMax",
    logo: "minimax",
    providers: ["minimax-portal", "minimax"],
    methods: [
      { id: "minimax/minimax-global-oauth", name: "Global account" },
      { id: "minimax/minimax-cn-oauth", name: "China account" },
    ],
  },
  {
    key: "opencode-go",
    name: "OpenCode Go",
    logo: "opencode",
    providers: ["opencode-go"],
    methods: [{ id: "opencode-go/opencode-go-console", name: "Sign in with a browser" }],
  },
];

/** How many tiles show before "Show more". */
export const FIRST_TILES = 4;

export type TileMethod = { method: SignInMethod; name: string };

export type ProviderTile = {
  key: string;
  name: string;
  /** Null for a provider the app has no logo for. */
  logo: LogoKey | null;
  /** The usual one first. */
  methods: TileMethod[];
  /** The gateway already has an account of this provider. */
  connected: boolean;
  /** Every method of it saves a key billed per token (OpenRouter's). */
  perToken: boolean;
};

/**
 * One tile per provider, from the methods the gateway can start (those that take a typed key stay
 * in the API key path): the known providers in the table's order, then the others in the
 * gateway's order.
 */
export function providerTiles(
  methods: readonly SignInMethod[],
  accounts: readonly GatewayAccount[],
): ProviderTile[] {
  const startable = methods.filter((m) => m.flow !== "key");
  const known: ProviderTile[] = [];
  for (const entry of KNOWN_PROVIDERS) {
    const own = startable.filter((m) => entry.providers.includes(m.provider));
    if (own.length === 0) continue;
    const rank = (m: SignInMethod) => {
      const at = entry.methods.findIndex((each) => each.id === m.id);
      return at < 0 ? entry.methods.length : at;
    };
    known.push({
      key: entry.key,
      name: entry.name,
      logo: entry.logo,
      // A stable sort: methods the table doesn't name keep the gateway's order, after its own.
      methods: [...own]
        .sort((a, b) => rank(a) - rank(b))
        .map((m) => ({ method: m, name: entry.methods[rank(m)]?.name ?? m.label })),
      connected: accounts.some((a) => entry.providers.includes(a.provider)),
      perToken: own.every((m) => m.group === "token"),
    });
  }
  const others: ProviderTile[] = [];
  for (const m of startable) {
    if (KNOWN_PROVIDERS.some((entry) => entry.providers.includes(m.provider))) continue;
    const key = `gateway:${m.provider}`;
    let tile = others.find((each) => each.key === key);
    if (!tile) {
      tile = {
        key,
        name: m.providerLabel ?? providerName(m.provider),
        logo: null,
        methods: [],
        connected: accounts.some((a) => a.provider === m.provider),
        perToken: true,
      };
      others.push(tile);
    }
    tile.methods.push({ method: m, name: m.label });
    tile.perToken &&= m.group === "token";
  }
  return [...known, ...others];
}
