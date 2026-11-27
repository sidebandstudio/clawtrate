import { describe, expect, it } from "vitest";
import {
  ALLOWED_TOOLS,
  CODING_AGENT_SCRIPT,
  checkHistory,
  checkTurnOutcome,
  devConfig,
  expectedFinalText,
  sandboxProblems,
} from "../src/cli.ts";
import { openclawEnv, PASSTHROUGH_ENV, providerEnv } from "../src/env.ts";
import { SEED_BOTS } from "../src/seed-data.ts";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("development gateway config", () => {
  const config = devConfig("test-token");

  /** The problems of a copy of the config with one value set (or removed, for undefined) at a path. */
  const changed = (path: string, value: unknown) => {
    const copy = clone(config) as unknown as Record<string, unknown>;
    const keys = path.split(".");
    let node = copy;
    for (const key of keys.slice(0, -1)) {
      node[key] ??= {};
      node = node[key] as Record<string, unknown>;
    }
    if (value === undefined) delete node[keys.at(-1)!];
    else node[keys.at(-1)!] = value;
    return sandboxProblems(copy);
  };
  const refused = (path: string, value: unknown, problem: RegExp) =>
    expect(changed(path, value)).toEqual(expect.arrayContaining([expect.stringMatching(problem)]));

  it("matches its own contract exactly", () => {
    expect(sandboxProblems(config)).toEqual([]);
  });

  it("reaches only the scripted provider on loopback", () => {
    expect(config.models.mode).toBe("replace");
    expect(Object.keys(config.models.providers)).toEqual(["scripted"]);
    expect(config.models.providers.scripted.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    refused("models.mode", "merge", /^models\.mode must be "replace"/);
    refused(
      "models.providers.hosted",
      { baseUrl: "https://api.example.com/v1" },
      /^models\.providers\.hosted is not allowed$/,
    );
    refused(
      "models.providers.scripted.baseUrl",
      "https://api.example.com/v1",
      /^models\.providers\.scripted\.baseUrl must be/,
    );
  });

  // The cases an independent review found the earlier guard accepted.
  it("refuses a workspace outside the instance", () => {
    refused(
      "agents.entries.main.workspace",
      "/tmp/elsewhere",
      /^agents\.entries\.main\.workspace must be/,
    );
    refused(
      "agents.defaults.workspace",
      "/tmp/elsewhere",
      /^agents\.defaults\.workspace is not allowed$/,
    );
  });

  it("refuses a real model, as primary, per bot or as a fallback", () => {
    refused(
      "agents.entries.main.model",
      "openai/gpt-5",
      /^agents\.entries\.main\.model is not allowed$/,
    );
    refused(
      "agents.defaults.model.primary",
      "anthropic/claude",
      /^agents\.defaults\.model\.primary must be "scripted\/dev-1"/,
    );
    refused(
      "agents.defaults.model.fallbacks",
      ["openai/gpt-5"],
      /^agents\.defaults\.model\.fallbacks is not allowed$/,
    );
  });

  it("refuses weaker gateway auth or automatic pairing", () => {
    refused("gateway.auth.mode", "none", /^gateway\.auth\.mode must be "token"/);
    refused("gateway.auth.token", undefined, /^gateway\.auth\.token is required$/);
    refused(
      "gateway.nodes.pairing.autoApproveLocal",
      true,
      /^gateway\.nodes\.pairing\.autoApproveLocal must be false/,
    );
    refused("gateway.bind", "lan", /^gateway\.bind must be "loopback"/);
  });

  it("refuses importing the login shell's environment", () => {
    refused("env", { shellEnv: { enabled: true } }, /^env is not allowed$/);
  });

  it("refuses another plugin entry or a plugin load path", () => {
    refused(
      "plugins.entries.searxng",
      { enabled: true },
      /^plugins\.entries\.searxng is not allowed$/,
    );
    refused("plugins.load", { paths: ["/x"] }, /^plugins\.load is not allowed$/);
  });

  it("refuses any key the contract does not name, wherever it is", () => {
    refused("somethingNew", true, /^somethingNew is not allowed$/);
    refused("tools.web.search.maxResults", 5, /^tools\.web\.search\.maxResults is not allowed$/);
    refused(
      "agents.entries.otto.tools.exec.safeBins",
      ["cat"],
      /^agents\.entries\.otto\.tools\.exec\.safeBins is not allowed$/,
    );
  });

  it("queues no new-session notice in a bot's main task", () => {
    expect(config.session).toEqual({ notifyOnCreate: false });
    refused("session.notifyOnCreate", true, /^session\.notifyOnCreate must be false/);
    refused("session", undefined, /^session is required$/);
  });

  it("turns memory-search embeddings off", () => {
    expect(config.memory.search).toEqual({ enabled: false, provider: "none" });
    refused("memory", undefined, /^memory is required$/);
    refused("memory.search.enabled", true, /^memory\.search\.enabled must be false/);
    refused(
      "agents.entries.pip.memory",
      { search: { enabled: true } },
      /^agents\.entries\.pip\.memory is not allowed$/,
    );
  });

  it("denies exec globally and lets only the shell bot ask before each command", () => {
    expect(config.tools.exec).toEqual({ mode: "deny" });
    const entries = config.agents.entries as Record<string, { tools: Record<string, unknown> }>;
    expect(entries.otto!.tools.exec).toEqual({ mode: "ask" });
    for (const id of ["main", "clawtrate-main-bot", "marlow", "pip"])
      expect(entries[id]!.tools.exec).toBeUndefined();
    refused("tools.exec.mode", "full", /^tools\.exec\.mode must be "deny"/);
    refused(
      "agents.entries.marlow.tools.exec",
      { mode: "full" },
      /^agents\.entries\.marlow\.tools\.exec is not allowed$/,
    );
    for (const mode of ["full", "auto", "allowlist"]) {
      refused(
        "agents.entries.otto.tools.exec.mode",
        mode,
        /^agents\.entries\.otto\.tools\.exec\.mode must be "ask"/,
      );
    }
  });

  it("lets only the messaging pair message each other", () => {
    expect(config.tools.agentToAgent).toEqual({ enabled: true, allow: ["marlow", "pip"] });
    const entries = config.agents.entries as Record<string, { tools: Record<string, unknown> }>;
    expect(entries.marlow!.tools.agentToAgent).toEqual({ send: ["pip"] });
    expect(entries.pip!.tools.agentToAgent).toEqual({ send: ["marlow"] });
    expect(entries.main!.tools.agentToAgent).toEqual({ send: [] });
    refused("tools.agentToAgent.allow", ["*"], /^tools\.agentToAgent\.allow must be exactly/);
    refused(
      "agents.entries.main.tools.agentToAgent.send",
      ["pip"],
      /^agents\.entries\.main\.tools\.agentToAgent\.send must be exactly \[\]/,
    );
    refused(
      "agents.entries.marlow.tools.agentToAgent",
      undefined,
      /^agents\.entries\.marlow\.tools\.agentToAgent is required$/,
    );
  });

  it("offers only the allowed tools and denies the self-management and network ones", () => {
    expect(config.tools.allow).toEqual([...ALLOWED_TOOLS]);
    for (const tool of ["gateway", "plugins", "openclaw", "web_fetch", "browser", "message"]) {
      expect(config.tools.deny).toContain(tool);
    }
    refused("tools.allow", [...ALLOWED_TOOLS, "browser"], /^tools\.allow must be exactly/);
    refused("tools.deny", ["web_fetch"], /^tools\.deny must be exactly/);
    refused("tools.alsoAllow", ["browser"], /^tools\.alsoAllow is not allowed$/);
    refused("tools.profile", "full", /^tools\.profile is not allowed$/);
    refused(
      "agents.entries.pip.tools.allow",
      ["browser"],
      /^agents\.entries\.pip\.tools\.allow is not allowed$/,
    );
  });

  it("keeps file tools in the workspace and search on the scripted server", () => {
    expect(config.tools.fs).toEqual({ workspaceOnly: true });
    expect(config.tools.web).toEqual({
      search: { enabled: true, provider: "ollama" },
      fetch: { enabled: false },
    });
    expect(config.plugins.entries.ollama).toEqual({
      config: { webSearch: { baseUrl: "http://127.0.0.1:19091" } },
    });
    refused("tools.fs.workspaceOnly", false, /^tools\.fs\.workspaceOnly must be true/);
    refused("tools.web.fetch.enabled", true, /^tools\.web\.fetch\.enabled must be false/);
    refused("tools.web.search.provider", "brave", /^tools\.web\.search\.provider must be "ollama"/);
    for (const url of ["https://ollama.com", "http://ollama-host:11434"]) {
      refused(
        "plugins.entries.ollama.config.webSearch.baseUrl",
        url,
        /^plugins\.entries\.ollama\.config\.webSearch\.baseUrl must be/,
      );
    }
    refused("plugins.entries.ollama.config.webSearch.apiKey", "x", /apiKey is not allowed$/);
  });

  it("runs only the stand-in coding agent as a local MCP server", () => {
    const server = config.mcp.servers.coder;
    expect(server.transport).toBe("stdio");
    expect(server.args).toEqual([CODING_AGENT_SCRIPT]);
    expect(sandboxProblems(config, undefined, server.cwd)).toEqual([]);
    expect(sandboxProblems(config, undefined, "/elsewhere")).toEqual(
      expect.arrayContaining([expect.stringMatching(/^mcp\.servers\.coder\.cwd must be/)]),
    );
    refused(
      "mcp.servers.hosted",
      { url: "https://mcp.example.com" },
      /^mcp\.servers\.hosted is not allowed$/,
    );
    refused("mcp.servers.coder.env", { TOKEN: "x" }, /^mcp\.servers\.coder\.env is not allowed$/);
    refused("mcp.servers.coder.command", "/bin/sh", /^mcp\.servers\.coder\.command must be/);
  });

  it("accepts what the seed writes and nothing more", () => {
    const seeded = clone(config) as unknown as Record<string, Record<string, unknown>>;
    seeded.meta = { lastTouchedVersion: "2026.10.6", migrations: { modelPolicyAllowlist: true } };
    const entries = seeded.agents!.entries as Record<string, Record<string, unknown>>;
    // The gateway's own bot is given its name alone.
    for (const bot of SEED_BOTS)
      entries[bot.id]!.identity = {
        name: bot.name,
        ...(bot.emoji === undefined ? {} : { emoji: bot.emoji }),
        ...(bot.theme === undefined ? {} : { theme: bot.theme }),
      };
    expect(sandboxProblems(seeded)).toEqual([]);
    entries.otto!.identity = { name: "Otto", emoji: "⚙️", theme: "operations", avatar: "x.png" };
    expect(sandboxProblems(seeded)).toEqual(["agents.entries.otto.identity.avatar is not allowed"]);
  });
});

describe("child process environment", () => {
  const shell = {
    PATH: "/usr/bin",
    HOME: "/somewhere/else",
    LANG: "en_US.UTF-8",
    ANTHROPIC_API_KEY: "secret",
    ANTHROPIC_AUTH_TOKEN: "secret",
    ANTHROPIC_BASE_URL: "https://proxy.example.com",
    OPENAI_API_KEY: "secret",
    OPENAI_BASE_URL: "https://proxy.example.com",
    GEMINI_API_KEY: "secret",
    OPENCLAW_GATEWAY_TOKEN: "secret",
    OPENCLAW_PROFILE: "default",
    OPENCLAW_STATE_DIR: "/somewhere/.openclaw",
    NODE_OPTIONS: "--require /tmp/hook.js",
  };

  it("passes only the allowlist plus the dev profile to OpenClaw", () => {
    const env = openclawEnv(shell);
    const allowed = new Set<string>([
      ...PASSTHROUGH_ENV,
      "HOME",
      "OPENCLAW_PROFILE",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_GATEWAY_PORT",
      "NO_COLOR",
    ]);
    expect(Object.keys(env).filter((key) => !allowed.has(key))).toEqual([]);
    expect(env.OPENCLAW_PROFILE).toBe("dev");
    expect(env.OPENCLAW_STATE_DIR).toMatch(/\.openclaw-dev$/);
    expect(env.OPENCLAW_CONFIG_PATH).toMatch(/\.openclaw-dev\/openclaw\.json$/);
    expect(env.OPENCLAW_GATEWAY_PORT).toBe("19001");
  });

  it("never forwards provider keys, tokens or base URLs", () => {
    for (const env of [openclawEnv(shell), providerEnv(shell)]) {
      const leaked = Object.keys(env).filter((key) =>
        /KEY|TOKEN|SECRET|BASE_URL|NODE_OPTIONS/.test(key),
      );
      expect(leaked).toEqual([]);
    }
  });

  it("forwards required native filesystem mode only to named OpenClaw instances", () => {
    const instance = { name: "memory-test", stateDir: "/unused", gatewayPort: 19500 };
    const source = { ...shell, FS_SAFE_NATIVE_MODE: "require" };
    expect(openclawEnv(source, instance).FS_SAFE_NATIVE_MODE).toBe("require");
    expect(
      openclawEnv({ ...source, FS_SAFE_NATIVE_MODE: "off" }, instance).FS_SAFE_NATIVE_MODE,
    ).toBeUndefined();
    expect(openclawEnv(source).FS_SAFE_NATIVE_MODE).toBeUndefined();
    expect(providerEnv(source).FS_SAFE_NATIVE_MODE).toBeUndefined();
  });

  it("gives the scripted provider nothing beyond the allowlist", () => {
    expect(providerEnv(shell)).toEqual({ PATH: "/usr/bin", LANG: "en_US.UTF-8" });
  });
});

describe("seed verification", () => {
  const otto = SEED_BOTS.find((bot) => bot.id === "otto")!;
  const task = otto.tasks.find((t) => t.slug === "disk-space")!;
  const turn = task.turns[0]!;

  it("accepts the scripted outcome and rejects anything else", () => {
    const ok = {
      status: "ok",
      summary: "completed",
      result: { meta: { stopReason: "stop", finalAssistantVisibleText: expectedFinalText(turn) } },
    };
    expect(checkTurnOutcome(ok, turn)).toBeNull();
    expect(checkTurnOutcome({ ...ok, status: "error", summary: "failed" }, turn)).toMatch(
      /status error/,
    );
    expect(
      checkTurnOutcome(
        { ...ok, result: { meta: { ...ok.result.meta, stopReason: "toolUse" } } },
        turn,
      ),
    ).toMatch(/stopped with toolUse/);
    expect(
      checkTurnOutcome(
        { ...ok, result: { meta: { ...ok.result.meta, finalAssistantVisibleText: "Hm" } } },
        turn,
      ),
    ).toMatch(/differs from the script/);
  });

  /** A history as the gateway records the scripted task. */
  const recorded = () =>
    task.turns.flatMap((t) => [
      { role: "user", content: t.prompt },
      ...t.rounds.flatMap((round, r) => {
        const content = round.map((step) =>
          step.kind === "reasoning"
            ? { type: "thinking", thinking: step.text }
            : step.kind === "text"
              ? { type: "text", text: step.text }
              : step.kind === "tool"
                ? { type: "toolCall", id: step.id, name: step.name, arguments: step.arguments }
                : { type: "text", text: "" },
        );
        const last = r === t.rounds.length - 1;
        const results = round.flatMap((step) =>
          step.kind === "tool" ? [{ role: "toolResult", toolName: step.name, isError: false }] : [],
        );
        return [{ role: "assistant", stopReason: last ? "stop" : "toolUse", content }, ...results];
      }),
    ]) as { role?: string; stopReason?: string; isError?: boolean; content?: unknown }[];

  it("checks turns, reasoning, calls, results and replies in history", () => {
    const good = recorded();
    expect(checkHistory(good, task)).toEqual([]);
    expect(checkHistory(good.slice(0, -1), task)).toContain(
      "the session does not end with a completed assistant reply",
    );
    const noReasoning = clone(good).map((m) =>
      Array.isArray(m.content)
        ? { ...m, content: (m.content as { type: string }[]).filter((b) => b.type !== "thinking") }
        : m,
    );
    expect(checkHistory(noReasoning, task)).toContain("the reasoning differs from the script");
    const otherArgs = clone(good);
    const call = otherArgs
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : []))
      .find((b) => b.type === "toolCall")!;
    call.arguments = { path: "/etc" };
    expect(checkHistory(otherArgs, task)).toContain(
      "the tool calls or their arguments differ from the script",
    );
    expect(
      checkHistory([{ role: "user" }, { role: "assistant", stopReason: "stop" }], task),
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/user turns/),
        expect.stringMatching(/tool results/),
      ]),
    );
  });
});

// The background skill review's tools are offered, on each version, and stay denied without it.
describe("the skill review's tools", () => {
  const tools = (openclaw: "2026.10.6" | "2026.11.10", skillReview: boolean) =>
    devConfig("t", undefined, undefined, [], { openclaw, ...(skillReview ? { skillReview } : {}) })
      .tools;

  it("are allowed and not denied when the review is on", () => {
    for (const [version, review] of [
      ["2026.10.6", ["skill_workshop"]],
      ["2026.11.10", ["skill_workshop", "skill_library"]],
    ] as const) {
      const { allow, deny } = tools(version, true);
      for (const tool of review) {
        expect(allow, `${version} allows ${tool}`).toContain(tool);
        expect(deny, `${version} denies ${tool}`).not.toContain(tool);
      }
    }
  });

  it("are denied when the review is off", () => {
    expect(tools("2026.10.6", false).deny).toContain("skill_workshop");
    expect(tools("2026.11.10", false).deny).toEqual(
      expect.arrayContaining(["skill_workshop", "skill_library"]),
    );
  });
});
