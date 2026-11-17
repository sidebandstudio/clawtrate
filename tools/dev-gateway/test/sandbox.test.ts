import { describe, expect, it } from "vitest";
import {
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

  it("passes every sandbox guarantee", () => {
    expect(sandboxProblems(config)).toEqual([]);
  });

  it("reaches only the scripted provider on loopback", () => {
    expect(config.models.mode).toBe("replace");
    expect(Object.keys(config.models.providers)).toEqual(["scripted"]);
    expect(config.models.providers.scripted.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  });

  it("turns memory-search embeddings off", () => {
    expect(config.memory.search).toEqual({ enabled: false, provider: "none" });
    const broken = clone(config) as Record<string, unknown>;
    delete broken.memory;
    expect(sandboxProblems(broken)).toContain("memory.search.enabled must be false");
  });

  it("denies exec globally and rejects per-bot overrides", () => {
    expect(config.tools.exec).toEqual({ mode: "deny" });
    const noPolicy = clone(config);
    noPolicy.tools.exec = {} as typeof noPolicy.tools.exec;
    expect(sandboxProblems(noPolicy)).toContain('tools.exec.mode must be "deny"');
    const override = {
      ...clone(config),
      agents: { ...config.agents, entries: { marlow: { tools: { exec: { security: "full" } } } } },
    };
    expect(sandboxProblems(override)).toContain(
      "agents.entries.marlow.tools.exec overrides the global exec policy",
    );
  });

  it("lets only the shell bot ask before each command, and nothing more", () => {
    const entries = config.agents.entries as Record<string, { tools: Record<string, unknown> }>;
    expect(entries.otto!.tools.exec).toEqual({ mode: "ask" });
    for (const id of ["main", "marlow", "pip"]) expect(entries[id]!.tools.exec).toBeUndefined();
    for (const exec of [
      { mode: "full" },
      { mode: "auto" },
      { mode: "allowlist" },
      { mode: "ask", safeBins: ["cat"] },
      { security: "full", ask: "off" },
    ]) {
      const loose = clone(config) as typeof config;
      (
        loose.agents.entries as Record<string, { tools: Record<string, unknown> }>
      ).otto!.tools.exec = exec;
      expect(sandboxProblems(loose)).toContain(
        'agents.entries.otto.tools.exec must be exactly { mode: "ask" }',
      );
    }
    const extra = clone(config) as typeof config;
    (extra.tools.exec as Record<string, unknown>).safeBins = ["cat"];
    expect(sandboxProblems(extra)).toContain("tools.exec must set only mode (found safeBins)");
  });

  it("lets only the messaging pair message each other", () => {
    expect(config.tools.agentToAgent).toEqual({ enabled: true, allow: ["marlow", "pip"] });
    const entries = config.agents.entries as Record<string, { tools: Record<string, unknown> }>;
    expect(entries.marlow!.tools.agentToAgent).toEqual({ send: ["pip"] });
    expect(entries.pip!.tools.agentToAgent).toEqual({ send: ["marlow"] });
    expect(entries.main!.tools.agentToAgent).toEqual({ send: [] });
    expect(entries.otto!.tools.agentToAgent).toEqual({ send: [] });
    const wider = clone(config) as typeof config;
    (wider.tools.agentToAgent as { allow: string[] }).allow = ["*"];
    expect(sandboxProblems(wider)).toContain(
      "tools.agentToAgent.allow must be exactly marlow and pip",
    );
    const outward = clone(config) as typeof config;
    (
      outward.agents.entries as Record<string, { tools: Record<string, unknown> }>
    ).main!.tools.agentToAgent = { send: ["pip"] };
    expect(sandboxProblems(outward)).toContain("agents.entries.main may message only no other bot");
  });

  it("keeps file tools in the workspace, search on loopback and network tools denied", () => {
    expect(config.tools.fs).toEqual({ workspaceOnly: true });
    expect(config.tools.web).toEqual({
      search: { enabled: true, provider: "ollama" },
      fetch: { enabled: false },
    });
    expect(config.plugins.entries.ollama).toEqual({
      config: { webSearch: { baseUrl: "http://127.0.0.1:19091" } },
    });
    for (const tool of ["web_fetch", "browser", "message", "nodes", "tts"]) {
      expect(config.tools.deny).toContain(tool);
    }
    /** The problems of a copy of the config with one value set at a path. */
    const broken = (path: string, value: unknown) => {
      const copy = clone(config) as unknown as Record<string, unknown>;
      const keys = path.split(".");
      let node = copy;
      for (const key of keys.slice(0, -1)) {
        node[key] ??= {};
        node = node[key] as Record<string, unknown>;
      }
      node[keys.at(-1)!] = value;
      return sandboxProblems(copy);
    };
    expect(broken("tools.fs.workspaceOnly", false)).toContain(
      "tools.fs.workspaceOnly must be true",
    );
    expect(broken("tools.web.fetch.enabled", true)).toContain(
      "tools.web.fetch.enabled must be false",
    );
    expect(broken("tools.web.search.provider", "brave")).toContain(
      'tools.web.search must be exactly { enabled, provider: "ollama" }',
    );
    for (const url of ["https://ollama.com", "http://ollama-host:11434"]) {
      expect(broken("plugins.entries.ollama.config.webSearch.baseUrl", url)).toContain(
        "web search must go only to the scripted server on loopback",
      );
    }
    expect(broken("plugins.entries.ollama.config.webSearch.apiKey", "x")).toContain(
      "web search must go only to the scripted server on loopback",
    );
    expect(broken("tools.deny", ["web_fetch"])).toEqual(
      expect.arrayContaining([expect.stringMatching(/^tools.deny must include .*browser/)]),
    );
    expect(broken("tools.alsoAllow", ["browser"])).toContain("tools.alsoAllow must not be set");
    expect(broken("plugins.load", { paths: ["/x"] })).toContain("plugins.load must not be set");
  });

  it("runs only the stand-in coding agent as a local MCP server", () => {
    const server = config.mcp.servers.coder;
    expect(server.transport).toBe("stdio");
    expect(server.args).toEqual([CODING_AGENT_SCRIPT]);
    expect(sandboxProblems(config, undefined, server.cwd)).toEqual([]);
    expect(sandboxProblems(config, undefined, "/elsewhere")).toContain(
      "the coder MCP server must run in the instance's folder",
    );
    const remote = clone(config) as Record<string, unknown> & typeof config;
    (remote.mcp.servers as Record<string, unknown>).hosted = { url: "https://mcp.example.com" };
    expect(sandboxProblems(remote)).toContain('mcp.servers must contain only "coder"');
    const env = clone(config) as typeof config;
    (env.mcp.servers.coder as Record<string, unknown>).env = { TOKEN: "x" };
    expect(sandboxProblems(env)).toContain("the coder MCP server may not set env");
  });

  it("requires explicit pairing approval and a loopback bind", () => {
    expect(config.gateway.nodes.pairing.autoApproveLocal).toBe(false);
    expect(config.gateway.bind).toBe("loopback");
  });

  it("rejects an extra provider", () => {
    const extra = clone(config) as { models: { providers: Record<string, unknown> } };
    extra.models.providers.hosted = { baseUrl: "https://api.example.com/v1" };
    expect(sandboxProblems(extra)).toContain('models.providers must contain only "scripted"');
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

  it("checks turns, tool results and a completed final reply in history", () => {
    const tools = task.turns
      .flatMap((t) => t.rounds.flat())
      .filter((s) => s.kind === "tool").length;
    const good = [
      ...task.turns.flatMap(() => [{ role: "user" }]),
      ...Array.from({ length: tools }, () => ({ role: "toolResult", isError: false })),
      { role: "assistant", stopReason: "stop" },
    ];
    expect(checkHistory(good, task)).toEqual([]);
    expect(checkHistory(good.slice(0, -1), task)).toContain(
      "the session does not end with a completed assistant reply",
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
