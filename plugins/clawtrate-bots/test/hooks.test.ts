// The holds as the gateway calls them (lib/hooks.js), with a stand-in host that
// records what the plugin registers. The read tools' are test/runs.test.ts.

import { describe, expect, it } from "vitest";
import { DEFINITION_MAX_BYTES, createHooks, rosterIds } from "../lib/hooks.js";
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

function host({
  version = "2026.10.6",
  config = CONFIG as Json,
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
  const ended = memoryStore();
  const notes = memoryStore();
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
    sessions: (agentId: string) => (typeof sessions === "function" ? sessions(agentId) : sessions),
    ended,
    notes,
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
  return { plugin, fire, tool, runGet, runGetBy, ended, notes, hooks };
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

  const removed = (result: Json = { details: { ok: true, removed: true } }) => ({
    ...remove,
    result,
  });

  it("is let through, and journaled only once the removal succeeded, with what the gateway reported", async () => {
    const h = host();
    h.fire("cron_changed", {
      action: "started",
      jobId: "j1",
      job: { ...job, description: undefined },
    });
    h.fire("before_prompt_build", {}, routine);
    expect(await h.fire("before_tool_call", remove, {})).toBeUndefined();
    expect(await h.ended.lookup("j1:rr")).toBeUndefined();
    await h.fire("after_tool_call", removed(), {});
    const kept = (await h.ended.lookup("j1:rr")) as Json;
    expect(kept).toMatchObject({
      complete: false,
      notReported: ["delivery", "sessionKey", "deleteAfterRun", "failureAlert"],
    });
    expect(kept.definition).toEqual({
      id: "j1",
      agentId: "pip",
      name: "Morning check",
      schedule: job.schedule,
      payload: job.payload,
    });
  });

  it("a removal the gateway refused leaves no entry", async () => {
    const h = host();
    h.fire("before_prompt_build", {}, routine);
    await h.fire("before_tool_call", remove, {});
    await h.fire(
      "after_tool_call",
      { ...remove, error: "Automations tool is restricted to the current automation." },
      {},
    );
    expect(await h.ended.lookup("j1:rr")).toBeUndefined();
  });

  it("the gateway's own report of the removal settles it too", async () => {
    const h = host();
    h.fire("before_prompt_build", {}, routine);
    await h.fire("before_tool_call", remove, {});
    await h.fire("cron_changed", { action: "removed", jobId: "j1" });
    expect(await h.ended.lookup("j1:rr")).toMatchObject({
      jobId: "j1",
      definition: null,
      complete: false,
    });
  });

  it("is complete, and can be put back, when the plugin holds its own full copy from the call that made it", async () => {
    const h = host();
    const typedRun = {
      runId: "r1",
      sessionKey: "agent:pip:main",
      agentId: "pip",
      trigger: "user",
      channel: "webchat",
    };
    h.fire("before_prompt_build", {}, typedRun);
    const fullJob = {
      name: "Morning check",
      schedule: job.schedule,
      payload: job.payload,
      delivery: { mode: "none" },
    };
    const add = {
      toolName: "automations",
      params: { action: "add", job: fullJob },
      runId: "r1",
      toolCallId: "a1",
    };
    const passed = (await h.fire("before_tool_call", add, toolCtx)) as { params: Json };
    await h.fire(
      "after_tool_call",
      { ...add, params: passed.params, result: { details: { id: "j1", enabled: false } } },
      toolCtx,
    );
    h.fire("before_prompt_build", {}, routine);
    await h.fire("before_tool_call", remove, {});
    await h.fire("after_tool_call", removed(), {});
    const kept = (await h.ended.lookup("j1:rr")) as Json;
    expect(kept).toMatchObject({ complete: true, notReported: [] });
    expect(kept.definition).toMatchObject({ id: "j1", delivery: { mode: "none" }, enabled: false });
  });

  it("a definition over 64 KiB is kept as unknown, and the routine still ends", async () => {
    const h = host();
    h.fire("cron_changed", {
      action: "updated",
      jobId: "j1",
      job: { ...job, payload: { kind: "agentTurn", message: "x".repeat(DEFINITION_MAX_BYTES) } },
    });
    h.fire("before_prompt_build", {}, routine);
    expect(await h.fire("before_tool_call", remove, {})).toBeUndefined();
    await h.fire("after_tool_call", removed(), {});
    expect(await h.ended.lookup("j1:rr")).toMatchObject({ definition: null, complete: false });
  });

  it("knows whether a routine is on, for a run of it", async () => {
    const h = host();
    h.fire("cron_changed", {
      action: "added",
      jobId: "j9",
      job: { ...job, id: "j9", enabled: false },
    });
    h.fire("before_prompt_build", {}, typed);
    expect(
      await h.fire(
        "before_tool_call",
        call("automations", { action: "run", jobId: "j9" }),
        toolCtx,
      ),
    ).toMatchObject({ block: true });
    h.fire("cron_changed", {
      action: "updated",
      jobId: "j9",
      job: { ...job, id: "j9", enabled: true },
    });
    expect(
      await h.fire(
        "before_tool_call",
        call("automations", { action: "run", jobId: "j9" }, "c2"),
        toolCtx,
      ),
    ).toBeUndefined();
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

describe("fix round 2", () => {
  const ok = (text: Json) => ({ content: [{ type: "text", text: JSON.stringify(text) }] });

  it("D4: whether a routine is on comes from the gateway's last report, not the plugin's own copy", async () => {
    const h = host();
    // The owner's routine, made on at once through a call the plugin held: its own copy says on.
    const owner = {
      ...typed,
      runId: "r-o",
      sessionKey: "agent:pip:dashboard:o",
      channel: "discord",
    };
    await h.fire("before_prompt_build", {}, owner);
    const ownerCtx = {
      ...toolCtx,
      sessionKey: owner.sessionKey,
      requester: { channel: "discord", senderIsOwner: true },
    };
    const add = {
      ...call("automations", { action: "add", job: { name: "x", enabled: true } }, "a1"),
      runId: "r-o",
    };
    await h.fire("before_tool_call", add, ownerCtx);
    await h.fire("after_tool_call", { ...add, result: ok({ id: "j1" }) }, ownerCtx);
    await h.fire("cron_changed", {
      jobId: "j1",
      action: "added",
      job: { id: "j1", enabled: true },
    });
    // An operator turns it off: a typed run with nothing read can't start it now.
    await h.fire("cron_changed", {
      jobId: "j1",
      action: "updated",
      job: { id: "j1", enabled: false },
    });
    await h.fire("before_prompt_build", {}, typed);
    const run = call("automations", { action: "run", jobId: "j1", runMode: "force" }, "r1c");
    expect(await h.fire("before_tool_call", run, toolCtx)).toMatchObject({ block: true });
    // And back on: a fresh typed run may.
    await h.fire("cron_changed", {
      jobId: "j1",
      action: "updated",
      job: { id: "j1", enabled: true },
    });
    await h.fire("before_prompt_build", {}, { ...typed, runId: "r2" });
    expect(
      await h.fire("before_tool_call", { ...run, runId: "r2", toolCallId: "r2c" }, toolCtx),
    ).toBeUndefined();
  });

  it("D1: a label is resolved among every bot's sessions, then the reach decides", async () => {
    const rows: Record<string, Json[]> = {
      pip: [{ sessionKey: "agent:pip:dashboard:1", entry: { label: "Compare trail maps" } }],
      marlow: [{ sessionKey: "agent:marlow:dashboard:2", entry: { label: "Review the route" } }],
      otto: [{ sessionKey: "agent:otto:dashboard:3", entry: { label: "Otto's list" } }],
    };
    const h = host({ sessions: (id) => rows[id] ?? [] });
    // A send's reply is outside content, so each send is its own fresh typed run.
    const send = (label: string, id: string) => {
      void h.fire("before_prompt_build", {}, { ...typed, runId: id });
      return { ...call("sessions_send", { label, message: "m" }, id), runId: id };
    };
    expect(
      await h.fire("before_tool_call", send("Compare trail maps", "l1"), toolCtx),
    ).toBeUndefined();
    expect(
      await h.fire("before_tool_call", send("Review the route", "l2"), toolCtx),
    ).toBeUndefined();
    expect(await h.fire("before_tool_call", send("Otto's list", "l3"), toolCtx)).toMatchObject({
      block: true,
    });
    expect(await h.fire("before_tool_call", send("Nobody's", "l4"), toolCtx)).toMatchObject({
      block: true,
    });
  });

  it("D8: check-in notes are written over empty notes or the bot's own, journaled, and not over a person's", async () => {
    const h = host();
    const checkIn = (runId: string) => ({ ...typed, runId, trigger: "heartbeat" });
    const write = (runId: string, scratch: string, id: string) => ({
      ...call("heartbeat_respond", { status: "ok", scratch }, id),
      runId,
    });
    // No notes yet: the prompt has no scratch section.
    await h.fire("before_prompt_build", { prompt: "Follow the notes." }, checkIn("h1"));
    expect(
      await h.fire("before_tool_call", write("h1", "- water plants", "n1"), toolCtx),
    ).toBeUndefined();
    await h.fire(
      "after_tool_call",
      { ...write("h1", "- water plants", "n1"), result: ok({ ok: true }) },
      toolCtx,
    );
    const journal = () =>
      [...h.notes.rows.keys()].filter((k) => k.startsWith("journal:check-in:pip:"));
    // Accepted, not yet saved: nothing is journaled until a check-in shows it.
    expect(journal()).toHaveLength(0);
    // Its own notes, as the next check-in's prompt shows them: it may replace them.
    await h.fire(
      "before_prompt_build",
      { prompt: "Follow the notes.\n\nHeartbeat monitor scratch:\n- water plants" },
      checkIn("h2"),
    );
    expect(
      await h.fire("before_tool_call", write("h2", "- feed cat", "n2"), toolCtx),
    ).toBeUndefined();
    expect(journal()).toHaveLength(1);
    // A person's notes: not replaced.
    await h.fire(
      "before_prompt_build",
      { prompt: "Follow the notes.\n\nHeartbeat monitor scratch:\n- my list" },
      checkIn("h3"),
    );
    expect(
      await h.fire("before_tool_call", write("h3", "- feed cat", "n3"), toolCtx),
    ).toMatchObject({
      block: true,
      blockReason: SAID.notesTheirs,
    });
  });

  it("D8: a routine's notes on 2026.11.10 need its run's scratch_get, and the revision it read", async () => {
    const h = host({ version: "2026.11.10" });
    const routine = {
      ...typed,
      runId: "rr",
      sessionKey: "agent:pip:cron:j9:run:rr",
      trigger: "cron",
      jobId: "j9",
    };
    const ctx = { ...toolCtx, sessionKey: routine.sessionKey };
    await h.fire("before_prompt_build", {}, routine);
    const set = (rev: number, id: string) => ({
      ...call(
        "automations",
        { action: "scratch_set", content: "- step two", expectedRevision: rev },
        id,
      ),
      runId: "rr",
    });
    // Without a scratch_get, the plugin hasn't seen the notes it would replace.
    expect(await h.fire("before_tool_call", set(3, "s0"), ctx)).toMatchObject({
      blockReason: SAID.notesUnseen,
    });
    const get = { ...call("automations", { action: "scratch_get" }, "g1"), runId: "rr" };
    await h.fire("before_tool_call", get, ctx);
    await h.fire(
      "after_tool_call",
      {
        ...get,
        result: ok({ scratch: { content: "- a person's step", revision: 3 }, currentRevision: 3 }),
      },
      ctx,
    );
    expect(await h.fire("before_tool_call", set(3, "s1"), ctx)).toMatchObject({
      blockReason: SAID.notesTheirs,
    });
    await h.fire(
      "after_tool_call",
      { ...get, result: ok({ scratch: null, currentRevision: 0 }) },
      ctx,
    );
    expect(await h.fire("before_tool_call", set(5, "s3"), ctx)).toMatchObject({
      blockReason: SAID.notesUnseen,
    });
    expect(await h.fire("before_tool_call", set(0, "s2"), ctx)).toBeUndefined();
  });

  it("round 3: a check-in's accepted notes are journaled only once a check-in shows them saved; a lost save leaves the journal and the owner as they were", async () => {
    const h = host();
    const checkIn = (runId: string, notes: string | null) =>
      h.fire(
        "before_prompt_build",
        {
          prompt:
            notes === null
              ? "Follow the notes."
              : `Follow the notes.\n\nHeartbeat monitor scratch:\n${notes}`,
        },
        { ...typed, runId, trigger: "heartbeat" },
      );
    const write = (runId: string, scratch: string, id: string) => ({
      ...call("heartbeat_respond", { status: "ok", scratch }, id),
      runId,
    });
    const accept = async (runId: string, scratch: string, id: string) => {
      expect(await h.fire("before_tool_call", write(runId, scratch, id), toolCtx)).toBeUndefined();
      await h.fire(
        "after_tool_call",
        { ...write(runId, scratch, id), result: ok({ ok: true }) },
        toolCtx,
      );
    };
    const journal = () =>
      [...h.notes.rows.keys()].filter((k) => k.startsWith("journal:check-in:pip:"));
    const owner = async () => h.notes.lookup("owner:check-in:pip");
    await checkIn("h1", null);
    await accept("h1", "- water plants", "n1");
    await checkIn("h2", "- water plants");
    await accept("h2", "- feed cat", "n2");
    expect(journal()).toHaveLength(1);
    const before = await owner();
    // The runner's save lost its revision race: the next check-in still shows the old notes.
    await checkIn("h3", "- water plants");
    expect(journal()).toHaveLength(1);
    expect(await owner()).toEqual(before);
    // Still its own notes, so it may propose again; a person's in their place stay theirs.
    await accept("h3", "- feed cat", "n4");
    await checkIn("h4", "- my list");
    expect(await h.fire("before_tool_call", write("h4", "- y", "n5"), toolCtx)).toMatchObject({
      blockReason: SAID.notesTheirs,
    });
    expect(journal()).toHaveLength(1);
    expect(await owner()).toEqual(before);
  });

  it("round 3: a check-in proposal the tool refused is never the bot's, even when its text later shows", async () => {
    const h = host();
    const checkIn = (runId: string, prompt: string) =>
      h.fire("before_prompt_build", { prompt }, { ...typed, runId, trigger: "heartbeat" });
    const write = (runId: string, id: string) => ({
      ...call("heartbeat_respond", { status: "ok", scratch: "- my list" }, id),
      runId,
    });
    await checkIn("h1", "Follow the notes.");
    expect(await h.fire("before_tool_call", write("h1", "n1"), toolCtx)).toBeUndefined();
    await h.fire("after_tool_call", { ...write("h1", "n1"), error: "refused" }, toolCtx);
    // The person wrote the same words themselves.
    await checkIn("h2", "Follow the notes.\n\nHeartbeat monitor scratch:\n- my list");
    expect(await h.fire("before_tool_call", write("h2", "n2"), toolCtx)).toMatchObject({
      blockReason: SAID.notesTheirs,
    });
    expect([...h.notes.rows.keys()]).toEqual([]);
  });

  it("round 3: a routine's notes are its own only at the revision its write made, whatever the text", async () => {
    const h = host({ version: "2026.11.10" });
    const routine = (runId: string) => ({
      ...typed,
      runId,
      sessionKey: `agent:pip:cron:j9:run:${runId}`,
      trigger: "cron",
      jobId: "j9",
    });
    const ctxOf = (runId: string) => ({ ...toolCtx, sessionKey: routine(runId).sessionKey });
    const read = async (runId: string, content: string | null, revision: number) => {
      await h.fire("before_prompt_build", {}, routine(runId));
      const get = { ...call("automations", { action: "scratch_get" }, `g-${runId}`), runId };
      await h.fire("before_tool_call", get, ctxOf(runId));
      await h.fire(
        "after_tool_call",
        {
          ...get,
          result: ok({
            scratch: content === null ? null : { content, revision },
            currentRevision: revision,
          }),
        },
        ctxOf(runId),
      );
    };
    const set = (runId: string, rev: number, id: string) => ({
      ...call(
        "automations",
        { action: "scratch_set", content: "- step two", expectedRevision: rev },
        id,
      ),
      runId,
    });
    const owner = async () => h.notes.lookup("owner:routine:j9");
    await read("r1", null, 0);
    expect(await h.fire("before_tool_call", set("r1", 0, "s1"), ctxOf("r1"))).toBeUndefined();
    await h.fire(
      "after_tool_call",
      {
        ...set("r1", 0, "s1"),
        result: ok({
          ok: true,
          scratch: { content: "- step two", revision: 1 },
          currentRevision: 1,
        }),
      },
      ctxOf("r1"),
    );
    expect(await owner()).toMatchObject({ agentId: "pip", revision: 1 });
    // Its own write, at its revision: it may replace it.
    await read("r2", "- step two", 1);
    expect(await h.fire("before_tool_call", set("r2", 1, "s2"), ctxOf("r2"))).toBeUndefined();
    // A save the gateway refused (a revision race) is no write: nothing journaled.
    await h.fire(
      "after_tool_call",
      { ...set("r2", 1, "s2"), result: ok({ ok: false, reason: "revision" }) },
      ctxOf("r2"),
    );
    expect([...h.notes.rows.keys()].filter((k) => k.startsWith("journal:"))).toHaveLength(1);
    expect(await owner()).toMatchObject({ revision: 1 });
    // The operator replaced the notes (revision 2), then put the same text back (3).
    await read("r3", "- step two", 3);
    expect(await h.fire("before_tool_call", set("r3", 3, "s3"), ctxOf("r3"))).toMatchObject({
      blockReason: SAID.notesTheirs,
    });
  });

  it("round 3: with no roster in the config, the implicit default bot sends to its own session by label", async () => {
    const config = {
      agents: { defaults: { model: { primary: "scripted/dev" } } },
      plugins: CONFIG.plugins,
    };
    const rows: Record<string, Json[]> = {
      main: [{ sessionKey: "agent:main:dashboard:1", entry: { label: "Compare trail maps" } }],
    };
    const h = host({ config, sessions: (id) => rows[id] ?? [] });
    const run = { ...typed, runId: "m1", sessionKey: "agent:main:main", agentId: "main" };
    await h.fire("before_prompt_build", {}, run);
    const send = {
      ...call("sessions_send", { label: "Compare trail maps", message: "m" }, "m1c"),
      runId: "m1",
    };
    expect(
      await h.fire("before_tool_call", send, {
        ...toolCtx,
        sessionKey: run.sessionKey,
        agentId: "main",
      }),
    ).toBeUndefined();
    expect(rosterIds(config)).toEqual(["main"]);
    // The gateway lists `entries` when that key is set, else `list`; either one, even empty, has no implicit bot.
    expect(rosterIds({ agents: { entries: {} } })).toEqual([]);
    expect(rosterIds({ agents: { list: [{ id: "pip" }] } })).toEqual(["pip"]);
    expect(rosterIds({ agents: { entries: { pip: {} }, list: [{ id: "otto" }] } })).toEqual([
      "pip",
    ]);
  });
});
