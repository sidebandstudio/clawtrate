import { describe, expect, it } from "vitest";
import {
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
      agents: { ...config.agents, entries: { otto: { tools: { exec: { security: "full" } } } } },
    };
    expect(sandboxProblems(override)).toContain(
      "agents.entries.otto.tools.exec overrides the global exec policy",
    );
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
