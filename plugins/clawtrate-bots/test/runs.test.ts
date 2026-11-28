// The hooks, tools and methods as the gateway calls them (lib/hooks.js,
// lib/runs.js), with a stand-in host that records what the plugin registers.

import { describe, expect, it } from "vitest";
import { createHooks } from "../lib/hooks.js";
import { createRuns, madeSession, versionKnown } from "../lib/runs.js";

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

function host({
  version = "2026.10.6",
  config = CONFIG as Json | (() => Json),
  sessions = [] as Json[] | ((agentId: string) => Json[]),
} = {}) {
  const hooks = new Map<string, Handler>();
  const tools = new Map<
    string,
    (ctx: Json) => {
      execute: (id: string, params: Json) => Promise<{ content: { text: string }[] }>;
    }
  >();
  const methods = new Map<string, (opts: Json) => Promise<void>>();
  const api = {
    on: (name: string, handler: Handler) => hooks.set(name, handler),
    registerTool: (factory: never, opts: { name: string }) => tools.set(opts.name, factory),
    registerGatewayMethod: (name: string, handler: never) => methods.set(name, handler),
    logger: { warn: () => {} },
    runtime: { version },
  };
  const plugin = createHooks(api, {
    slots: {},
    config: () => (typeof config === "function" ? (config as () => Json)() : config),
    sessions: (agentId: string) => (typeof sessions === "function" ? sessions(agentId) : sessions),
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
  return { plugin, fire, tool, runGet, runGetBy, hooks };
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
  it("know only the versions whose fields this build reads", () => {
    expect(versionKnown("2026.10.6")).toBe(true);
    expect(versionKnown("2026.11.10")).toBe(true);
    expect(versionKnown("v2026.11.10-beta.1")).toBe(true);
    expect(versionKnown("2026.11.11")).toBe(true);
    expect(versionKnown("2026.11.12")).toBe(false);
    expect(versionKnown("2026.12.1")).toBe(false);
    expect(versionKnown(undefined)).toBe(false);
  });

  it("record each call's run and mark it read from outside as the call passes, deciding nothing", async () => {
    const h = host();
    h.fire("before_prompt_build", {}, typed);
    expect(
      await h.fire("before_tool_call", call("web_search", { query: "q" }), toolCtx),
    ).toBeUndefined();
    expect(await h.runGet("r1")).toMatchObject({
      known: true,
      kind: "typed",
      channel: "webchat",
      readOutside: { source: "web", tool: "web_search" },
    });
    // A call the plugin can't read is still not stopped by its recording.
    const broken = {
      toolName: "read",
      runId: "r1",
      get toolCallId(): string {
        throw new Error("unreadable");
      },
    };
    expect(await h.fire("before_tool_call", broken as never, toolCtx)).toBeUndefined();
  });

  it("an unknown run, and conversation access off, are known as nothing", async () => {
    const off = host({ config: { ...CONFIG, plugins: {} } });
    off.fire("before_tool_call", call("read", { path: "x" }), toolCtx);
    expect(await off.runGet("r1")).toEqual({ runId: "r1", known: false, why: "access" });
  });

  it("a record made before conversation access was turned off isn't known again, off or back on, through the method too", async () => {
    // A config write replaces the gateway's snapshot object, as here.
    let current = structuredClone(CONFIG) as Json;
    const h = host({ config: () => current });
    h.fire("before_prompt_build", {}, typed);
    expect(await h.runGet("r1")).toMatchObject({ known: true, kind: "typed" });
    current = { ...structuredClone(CONFIG), plugins: { entries: {} } };
    expect(await h.runGet("r1")).toEqual({ runId: "r1", known: false, why: "access" });
    current = structuredClone(CONFIG) as Json;
    expect(await h.runGet("r1")).toMatchObject({ runId: "r1", known: false });
    // A run that starts after access is back is recorded as usual.
    h.fire("before_prompt_build", {}, { ...typed, runId: "r2" });
    expect(await h.runGet("r2")).toMatchObject({ known: true, kind: "typed", readOutside: null });
  });

  it("a spawn whose result reports a failure stops waiting, so the person's next task keeps its origin", async () => {
    const h = host();
    h.fire("before_prompt_build", {}, typed);
    h.fire("before_tool_call", call("sessions_spawn", { task: "t", label: "x" }, "c9"), toolCtx);
    h.fire(
      "after_tool_call",
      {
        ...call("sessions_spawn", { task: "t", label: "x" }, "c9"),
        result: {
          content: [{ type: "text", text: '{"status":"error","error":"label already in use: x"}' }],
        },
      },
      toolCtx,
    );
    h.fire(
      "before_prompt_build",
      {},
      { ...typed, runId: "r2", sessionKey: "agent:pip:dashboard:7" },
    );
    expect(await h.runGet("r2")).toMatchObject({ kind: "typed" });
  });

  it("the config is looked at before a call's origin is read, so a write invalidates the record for that very call", async () => {
    let current = structuredClone(CONFIG) as Json;
    const h = host({ config: () => current });
    h.fire("before_prompt_build", {}, typed);
    current = structuredClone(CONFIG) as Json; // a config write, access still on
    const { origin } = (
      h.plugin as unknown as { sawCall: (e: Json, c: Json) => { origin: Json } }
    ).sawCall(call("write", { path: "x" }, "w1"), toolCtx);
    expect(origin).toMatchObject({ origin: "C", read: "lost" });
  });

  it("on a version this build doesn't know, runs.get knows no run", async () => {
    const h = host({ version: "2026.12.1" });
    h.fire("before_prompt_build", {}, typed);
    expect(await h.runGet("r1")).toEqual({ runId: "r1", known: false, why: "version" });
  });

  it("clawtrate_tasks leaves out the bot's main conversation", async () => {
    const h = host({
      sessions: [{ sessionKey: "agent:pip:main", entry: { label: "Main", updatedAt: 1 } }],
    });
    h.fire("before_prompt_build", {}, typed);
    expect(await h.tool("clawtrate_tasks", toolCtx, "c2")).not.toMatch(/Main/);
  });

  it("the read tools look at the config before reading a run's origin too", async () => {
    const seen: Json[] = [];
    let current = structuredClone(CONFIG) as Json;
    const hooks = new Map<string, Handler>();
    const tools = new Map<
      string,
      (ctx: Json) => { execute: (id: string, p: Json) => Promise<unknown> }
    >();
    createRuns(
      {
        on: (name: string, handler: Handler) => hooks.set(name, handler),
        registerTool: (factory: never, opts: { name: string }) => tools.set(opts.name, factory),
        runtime: { version: "2026.10.6" },
      } as never,
      {
        slots: {},
        config: () => current,
        sessions: () => [],
        describeHolds: (origin: Json) => {
          seen.push(origin);
          return [];
        },
      } as never,
    );
    hooks.get("before_prompt_build")!({}, typed);
    current = structuredClone(CONFIG) as Json; // a config write, access still on
    await tools.get("clawtrate_here")!({ ...toolCtx, runId: "r1" }).execute("c9", {});
    expect(seen.at(-1)).toMatchObject({ origin: "C", read: "lost" });
  });

  it("a run that may be a spawn's unnamed child is C with something lost, and runs.get says pending", async () => {
    const h = host();
    h.fire("before_prompt_build", {}, typed);
    h.fire("before_tool_call", call("sessions_spawn", { task: "t", visible: true }, "s1"), toolCtx);
    const other = { ...typed, runId: "r2", sessionKey: "agent:pip:dashboard:7" };
    h.fire("before_prompt_build", {}, other);
    const sawCall = (h.plugin as unknown as { sawCall: (e: Json, c: Json) => { origin: Json } })
      .sawCall;
    expect(
      sawCall(
        { ...call("write", { path: "x" }, "w1"), runId: "r2" },
        { ...toolCtx, sessionKey: other.sessionKey },
      ).origin,
    ).toMatchObject({ origin: "C", read: "lost" });
    expect(await h.runGet("r2")).toMatchObject({ pending: true });
    // The result names another session: this one is the person's own again.
    h.fire(
      "after_tool_call",
      {
        ...call("sessions_spawn", { task: "t", visible: true }, "s1"),
        result: { details: { status: "accepted", childSessionKey: "agent:pip:dashboard:child" } },
      },
      toolCtx,
    );
    expect(await h.runGet("r2")).toMatchObject({ pending: false, kind: "typed" });
  });

  it("a routine's run is found by its session, since no client knows its run id", async () => {
    const h = host();
    const routine = {
      runId: "rr",
      sessionKey: "agent:pip:cron:j1:run:rr",
      agentId: "pip",
      trigger: "cron",
      jobId: "j1",
    };
    h.fire("before_prompt_build", {}, routine);
    expect(await h.runGetBy({ sessionKey: routine.sessionKey })).toMatchObject({
      known: true,
      kind: "routine",
      runId: "rr",
    });
  });
});

describe("the read tools", () => {
  it("clawtrate_here: can't tell from the plugin alone, says what was read, and returns no text a bot wrote", async () => {
    const h = host({
      sessions: [{ sessionKey: "agent:pip:main", entry: { label: "Pip's own label" } }],
    });
    h.fire("before_prompt_build", {}, typed);
    h.fire("before_tool_call", call("clawtrate_here", {}, "c2"), toolCtx);
    const text = await h.tool("clawtrate_here", toolCtx, "c2");
    expect(text).toMatch(/^In Clawtrate: can't tell yet/);
    expect(text).toMatch(/haven't read anything from outside/);
    expect(text).not.toMatch(/Pip/);
    expect((await h.runGet("r1")).readOutside).toBeNull();
    h.fire("before_tool_call", call("web_search", { query: "q" }, "c3"), toolCtx);
    h.fire("before_tool_call", call("clawtrate_here", {}, "c4"), toolCtx);
    expect(await h.tool("clawtrate_here", toolCtx, "c4")).toMatch(
      /You've read a web page in this run/,
    );
  });

  it("clawtrate_here: no, in a run another bot's message started", async () => {
    const h = host();
    h.fire(
      "before_prompt_build",
      {},
      { ...typed, inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" } },
    );
    h.fire("before_tool_call", call("clawtrate_here", {}, "c2"), toolCtx);
    expect(await h.tool("clawtrate_here", toolCtx, "c2")).toMatch(
      /^In Clawtrate: no\. This run was started by a message from another bot/,
    );
  });

  it("clawtrate_bots: find returns ids only and reads nothing from outside; a full list does", async () => {
    const h = host();
    h.fire("before_prompt_build", {}, typed);
    h.fire("before_tool_call", call("clawtrate_bots", { find: "marlow" }, "c2"), toolCtx);
    const found = await h.tool("clawtrate_bots", toolCtx, "c2", { find: "marlow" });
    expect(found).toMatch(/id marlow; you can hand work to it;/);
    expect(found).not.toMatch(/Marlow/);
    expect((await h.runGet("r1")).readOutside).toBeNull();
    // A full list returns names a bot may have chosen: it marks the run.
    h.fire("before_tool_call", call("clawtrate_bots", {}, "c4"), toolCtx);
    const all = await h.tool("clawtrate_bots", toolCtx, "c4");
    expect(all).toMatch(/id marlow, called «Marlow»/);
    expect(all).toMatch(
      /id otto, called «Otto»; you can hand work to it once your person asks you to/,
    );
    expect(all).not.toMatch(/id main\b/);
    expect((await h.runGet("r1")).readOutside).toEqual({ source: "names", tool: "clawtrate_bots" });
  });

  it("clawtrate_tasks: titles are outside content; states filter; the limit is checked", async () => {
    const sessions = [
      { sessionKey: "agent:pip:main", entry: { updatedAt: 2 } },
      {
        sessionKey: "agent:pip:dashboard:1",
        entry: {
          label: "Compare trail maps",
          spawnedBy: "agent:pip:main",
          status: "done",
          updatedAt: 3,
        },
      },
      { sessionKey: "agent:marlow:main", entry: { label: "Not Pip's" } },
    ];
    const h = host({ sessions });
    h.fire("before_prompt_build", {}, typed);
    h.fire("before_tool_call", call("clawtrate_tasks", {}, "c2"), toolCtx);
    const text = await h.tool("clawtrate_tasks", toolCtx, "c2");
    expect(text).toMatch(/«Compare trail maps»: done, started by you/);
    expect(text).not.toMatch(/Not Pip's/);
    expect((await h.runGet("r1")).readOutside).toEqual({
      source: "titles",
      tool: "clawtrate_tasks",
    });
    expect(await h.tool("clawtrate_tasks", toolCtx, "c3", { limit: 51 })).toMatch(/limit must be/);
    expect(await h.tool("clawtrate_tasks", toolCtx, "c3", { state: "failed" })).toMatch(
      /no tasks that are failed/,
    );
  });

  it("2026.11.10: a tool finds its run by its own run id", async () => {
    const h = host({ version: "2026.11.10" });
    h.fire("before_prompt_build", {}, typed);
    expect(await h.tool("clawtrate_here", { ...toolCtx, runId: "r1" }, "never-seen")).toMatch(
      /^In Clawtrate: can't tell yet/,
    );
  });
});

describe("fix round", () => {
  it("a spawn's result marks its session a task, from details or the result's JSON text", async () => {
    expect(
      madeSession({ details: { status: "accepted", childSessionKey: "agent:pip:dashboard:1" } }),
    ).toBe("agent:pip:dashboard:1");
    expect(
      madeSession({ content: [{ type: "text", text: '{"sessionKey":"agent:marlow:x"}' }] }),
    ).toBe("agent:marlow:x");
    expect(madeSession({ content: [{ type: "text", text: "not json" }] })).toBeNull();
    const h = host();
    h.fire("before_prompt_build", {}, typed);
    h.fire("before_tool_call", call("web_search", { query: "q" }), toolCtx);
    h.fire("before_tool_call", call("sessions_spawn", { task: "#x" }, "c2"), toolCtx);
    h.fire(
      "after_tool_call",
      {
        ...call("sessions_spawn", { task: "#x" }, "c2"),
        result: { details: { childSessionKey: "agent:pip:dashboard:7" } },
      },
      toolCtx,
    );
    h.fire(
      "before_prompt_build",
      {},
      {
        runId: "t1",
        sessionKey: "agent:pip:dashboard:7",
        agentId: "pip",
        trigger: "user",
        channel: "webchat",
      },
    );
    expect(await h.runGet("t1")).toMatchObject({ kind: "task", readOutside: { source: "web" } });
  });

  it("an after_tool_call for a run never seen starting makes it lost", async () => {
    const h = host();
    h.fire("after_tool_call", call("web_fetch", { url: "x" }), toolCtx);
    h.fire("before_prompt_build", {}, typed);
    expect(await h.runGet("r1")).toEqual({ runId: "r1", known: false });
  });

  it("clawtrate_tasks looks in every other bot's sessions, past the 50 clawtrate_bots lists", async () => {
    const entries: Json = { pip: {} };
    for (let i = 1; i <= 60; i += 1) entries[`bot${i}`] = {};
    const h = host({
      config: { ...CONFIG, agents: { ...CONFIG.agents, entries } } as Json,
      sessions: (agentId) =>
        agentId === "bot60"
          ? [
              {
                sessionKey: "agent:bot60:dashboard:1",
                entry: { label: "Under the sixtieth", spawnedBy: "agent:pip:main", updatedAt: 5 },
              },
            ]
          : [],
    });
    h.fire("before_prompt_build", {}, typed);
    h.fire("before_tool_call", call("clawtrate_tasks", {}, "c2"), toolCtx);
    expect(await h.tool("clawtrate_tasks", toolCtx, "c2")).toMatch(/«Under the sixtieth»/);
  });

  it("clawtrate_bots find searches every other bot, past the 50 the full list shows", async () => {
    const entries: Json = { pip: {} };
    for (let i = 1; i <= 60; i += 1) entries[`bot${i}`] = { identity: { name: `Bot ${i}` } };
    const h = host({ config: { ...CONFIG, agents: { ...CONFIG.agents, entries } } as Json });
    h.fire("before_prompt_build", {}, typed);
    h.fire("before_tool_call", call("clawtrate_bots", { find: "Bot 60" }, "c2"), toolCtx);
    const found = await h.tool("clawtrate_bots", toolCtx, "c2", { find: "Bot 60" });
    expect(found).toMatch(/- id bot60;/);
  });

  it("with conversation access off, every run is C with something read, in the holds and in clawtrate_here alike", async () => {
    const seen: Json[] = [];
    const config = structuredClone(CONFIG) as Json;
    const hooks = new Map<string, Handler>();
    const tools = new Map<
      string,
      (ctx: Json) => { execute: (id: string, p: Json) => Promise<{ content: { text: string }[] }> }
    >();
    const runs = createRuns(
      {
        on: (name: string, handler: Handler) => hooks.set(name, handler),
        registerTool: (factory: never, opts: { name: string }) => tools.set(opts.name, factory),
        runtime: { version: "2026.10.6" },
      } as never,
      {
        slots: {},
        config: () => config,
        sessions: () => [],
        describeHolds: (origin: Json) => {
          seen.push(origin);
          return [];
        },
      } as never,
    );
    // The run was recorded while access was on; then the person turned it off.
    hooks.get("before_prompt_build")!({}, typed);
    (config as { plugins: Json }).plugins = { entries: {} };
    expect(runs.sawCall(call("write", {}, "c2"), toolCtx).origin).toMatchObject({
      origin: "C",
      read: "lost",
    });
    const answer = await tools.get("clawtrate_here")!(toolCtx).execute("c2", {});
    expect(seen.at(-1)).toMatchObject({ origin: "C", read: "lost", kind: "unknown" });
    expect(answer.content[0]!.text).not.toMatch(/can't tell yet/);
  });

  it("clawtrate_tasks lists the tasks it started under other bots", async () => {
    const h = host({
      sessions: [
        {
          sessionKey: "agent:marlow:dashboard:2",
          entry: { label: "Review the route", spawnedBy: "agent:pip:main", updatedAt: 5 },
        },
      ],
    });
    h.fire("before_prompt_build", {}, typed);
    h.fire("before_tool_call", call("clawtrate_tasks", {}, "c2"), toolCtx);
    expect(await h.tool("clawtrate_tasks", toolCtx, "c2")).toMatch(
      /«Review the route»: state unknown, started by you/,
    );
  });
});
