// The holds as the gateway calls them (lib/hooks.js), with a stand-in host that
// records what the plugin registers. The read tools' are test/runs.test.ts.

import { describe, expect, it } from "vitest";
import { DEFINITION_MAX_BYTES, createHooks } from "../lib/hooks.js";
import { SAID } from "../lib/holds.js";
import { memoryStore } from "./harness.ts";

type Json = Record<string, unknown>;
type Handler = (event: Json, ctx: Json) => unknown;

const CONFIG = {
  agents: {
    defaults: { systemAgent: { agentId: "main" }, model: { primary: "scripted/dev" } },
    entries: {
      pip: { identity: { name: "Pip" }, subagents: { allowAgents: ["marlow"] } },
      marlow: { identity: { name: "Marlow" } },
      otto: { name: "Otto" },
      main: {},
    },
  },
  plugins: { entries: { "clawtrate-bots": { hooks: { allowConversationAccess: true } } } },
};

function host({ version = "2026.10.6", config = CONFIG as Json, sessions = [] as Json[] } = {}) {
  const hooks = new Map<string, Handler>();
  const tools = new Map<
    string,
    (ctx: Json) => {
      execute: (id: string, params: Json) => Promise<{ content: { text: string }[] }>;
    }
  >();
  const methods = new Map<string, (opts: Json) => Promise<void>>();
  const ended = memoryStore();
  const api = {
    on: (name: string, handler: Handler) => hooks.set(name, handler),
    registerTool: (factory: never, opts: { name: string }) => tools.set(opts.name, factory),
    registerGatewayMethod: (name: string, handler: never) => methods.set(name, handler),
    logger: { warn: () => {} },
    runtime: { version },
  };
  const plugin = createHooks(api, {
    slots: {},
    config: () => config,
    sessions: () => sessions,
    ended,
  } as never);
  const fire = (name: string, event: Json, ctx: Json = {}) => hooks.get(name)!(event, ctx);
  const tool = async (name: string, ctx: Json, callId: string, params: Json = {}) =>
    (await tools.get(name)!(ctx).execute(callId, params)).content[0]!.text;
  const runGet = async (runId: string) => {
    let payload: Json = {};
    await methods.get("clawtrate-bots.runs.get")!({
      params: { runId },
      respond: (_ok: boolean, p: Json) => (payload = p),
    });
    return payload;
  };
  const runGetBy = async (params: Json) => {
    let payload: Json = {};
    await methods.get("clawtrate-bots.runs.get")!({
      params,
      respond: (_ok: boolean, p: Json) => (payload = p),
    });
    return payload;
  };
  return { plugin, fire, tool, runGet, runGetBy, ended, hooks };
}

const typed = {
  runId: "r1",
  sessionKey: "agent:pip:main",
  agentId: "pip",
  trigger: "user",
  channel: "webchat",
};
const call = (toolName: string, params: Json, toolCallId = "c1") => ({
  toolName,
  params,
  runId: "r1",
  toolCallId,
});
const toolCtx = {
  sessionKey: "agent:pip:main",
  agentId: "pip",
  requester: { channel: "webchat", senderIsOwner: true },
};

describe("the hooks", () => {
  it("a typed run's new routine is stored off, and the run is then marked by the scheduler's result", async () => {
    const h = host();
    h.fire("before_prompt_build", {}, typed);
    const out = (await h.fire(
      "before_tool_call",
      call("automations", { action: "add", job: { name: "x" } }),
      toolCtx,
    )) as Json;
    expect((out.params as { job: Json }).job.enabled).toBe(false);
    expect((await h.runGet("r1")).readOutside).toEqual({ source: "tool", tool: "automations" });
  });

  it("an unknown run, a version this build doesn't know, and conversation access off are all C", async () => {
    const add = call("automations", { action: "add", job: { name: "x" } });
    expect(await host().fire("before_tool_call", add, toolCtx)).toMatchObject({
      block: true,
      blockReason: SAID.notDone,
    });
    const newer = host({ version: "2026.12.1" });
    newer.fire("before_prompt_build", {}, typed);
    expect(await newer.fire("before_tool_call", add, toolCtx)).toMatchObject({ block: true });
    // With conversation access off the gateway never calls before_prompt_build: no run is known.
    const off = host({ config: { ...CONFIG, plugins: {} } });
    expect(await off.fire("before_tool_call", add, toolCtx)).toMatchObject({ block: true });
  });

  it("a call the hold can't decide is refused; a call no hold covers isn't", async () => {
    const h = host();
    h.fire("before_prompt_build", {}, typed);
    const broken = {
      toolName: "automations",
      runId: "r1",
      toolCallId: "c9",
      get params(): Json {
        throw new Error("unreadable");
      },
    };
    expect(await h.fire("before_tool_call", broken as never, toolCtx)).toEqual({
      block: true,
      blockReason: SAID.failed,
    });
    const brokenRead = {
      toolName: "read",
      runId: "r1",
      toolCallId: "c8",
      get params(): Json {
        throw new Error("unreadable");
      },
    };
    expect(await h.fire("before_tool_call", brokenRead as never, toolCtx)).toBeUndefined();
  });

  it("the owner's approval is OpenClaw's own, with Allow once and Deny", async () => {
    const h = host();
    h.fire("before_prompt_build", {}, { ...typed, channel: "discord" });
    const out = (await h.fire("before_tool_call", call("plugins", { action: "install" }), {
      ...toolCtx,
      requester: { channel: "discord", senderIsOwner: true },
    })) as Json;
    expect(out.requireApproval).toMatchObject({
      title: "Change OpenClaw",
      allowedDecisions: ["allow-once", "deny"],
    });
  });
});

describe("a routine that ends itself", () => {
  const routine = {
    runId: "rr",
    sessionKey: "agent:pip:cron:j1:run:rr",
    agentId: "pip",
    trigger: "cron",
    jobId: "j1",
  };
  const remove = {
    toolName: "automations",
    params: { action: "remove", jobId: "j1" },
    runId: "rr",
    toolCallId: "c1",
  };
  const job = {
    id: "j1",
    agentId: "pip",
    name: "Morning check",
    schedule: { kind: "cron", expr: "0 8 * * *" },
    payload: { kind: "agentTurn", message: "check" },
    state: { lastRunAtMs: 1 },
  };

  it("is done once its definition is journaled, without its run state", async () => {
    const h = host();
    h.fire("cron_changed", { action: "started", jobId: "j1", job });
    h.fire("before_prompt_build", {}, routine);
    expect(await h.fire("before_tool_call", remove, {})).toBeUndefined();
    const kept = (await h.ended.lookup("j1:rr")) as Json;
    expect(kept.definition).toEqual({
      id: "j1",
      agentId: "pip",
      name: "Morning check",
      schedule: job.schedule,
      payload: job.payload,
    });
    expect(kept.notReported).toContain("delivery");
  });

  it("keeps a definition the gateway reported with absent fields, as JSON", async () => {
    const h = host();
    h.fire("cron_changed", {
      action: "started",
      jobId: "j1",
      job: { ...job, description: undefined },
    });
    h.fire("before_prompt_build", {}, routine);
    expect(await h.fire("before_tool_call", remove, {})).toBeUndefined();
    expect(((await h.ended.lookup("j1:rr")) as Json).definition).not.toHaveProperty("description");
  });

  it("is not done when its definition isn't known, or is over 64 KiB", async () => {
    const unknown = host();
    unknown.fire("before_prompt_build", {}, routine);
    expect(await unknown.fire("before_tool_call", remove, {})).toEqual({
      block: true,
      blockReason: SAID.cantKeep,
    });
    const large = host();
    large.fire("cron_changed", {
      action: "updated",
      jobId: "j1",
      job: { ...job, payload: { kind: "agentTurn", message: "x".repeat(DEFINITION_MAX_BYTES) } },
    });
    large.fire("before_prompt_build", {}, routine);
    expect(await large.fire("before_tool_call", remove, {})).toEqual({
      block: true,
      blockReason: SAID.cantKeep,
    });
    // A removed routine's definition is forgotten.
    const gone = host();
    gone.fire("cron_changed", { action: "added", jobId: "j1", job });
    gone.fire("cron_changed", { action: "removed", jobId: "j1" });
    gone.fire("before_prompt_build", {}, routine);
    expect(await gone.fire("before_tool_call", remove, {})).toMatchObject({ block: true });
  });
});

describe("the read tools and the holds", () => {
  it("a hand-off after clawtrate_bots with find is within reach; after the full list it isn't (the case that must keep working, and the one that breaks)", async () => {
    const h = host();
    h.fire("before_prompt_build", {}, typed);
    h.fire("before_tool_call", call("clawtrate_bots", { find: "marlow" }, "c2"), toolCtx);
    const found = await h.tool("clawtrate_bots", toolCtx, "c2", { find: "marlow" });
    expect(found).toMatch(/id marlow; you can hand work to it;/);
    expect(found).not.toMatch(/Marlow/);
    expect((await h.runGet("r1")).readOutside).toBeNull();
    // So the hand-off that follows is still within reach with nothing read.
    expect(
      await h.fire(
        "before_tool_call",
        call("sessions_spawn", { agentId: "marlow", task: "t" }, "c3"),
        toolCtx,
      ),
    ).toBeUndefined();
    // A full list returns names a bot may have chosen: after it, the hand-off isn't made.
    h.fire("before_tool_call", call("clawtrate_bots", {}, "c4"), toolCtx);
    const all = await h.tool("clawtrate_bots", toolCtx, "c4");
    expect(all).toMatch(/id marlow, called «Marlow»/);
    expect(all).toMatch(
      /id otto, called «Otto»; you can hand work to it once your person asks you to/,
    );
    expect(all).not.toMatch(/id main\b/);
    expect((await h.runGet("r1")).readOutside).toEqual({ source: "names", tool: "clawtrate_bots" });
    expect(
      await h.fire(
        "before_tool_call",
        call("sessions_spawn", { agentId: "marlow", task: "t" }, "c5"),
        toolCtx,
      ),
    ).toMatchObject({ block: true });
  });
});
