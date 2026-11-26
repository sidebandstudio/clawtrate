// The run-origin store (lib/origins.js): each origin from each OpenClaw
// version's hook frames (design 4.1's table, as runs on both versions showed
// it), "read from outside" (4.3), and every bound.

import { describe, expect, it } from "vitest";
import { LIMITS, RunOrigins, kindOf, originOf, readsOutside, sourceOf } from "../lib/origins.js";

type Json = Record<string, unknown>;
const known = { versionKnown: true };
const owner = { channel: "webchat", senderIsOwner: true };

/** before_prompt_build's context for one run, as each version sends it. */
const frames: Record<
  "typed" | "bot-message" | "report" | "command-line" | "routine" | "check-in" | "chat-app",
  Record<"1006" | "1110", Json>
> = {
  typed: {
    "1006": {
      runId: "r-typed",
      sessionKey: "agent:pip:main",
      agentId: "pip",
      trigger: "user",
      channel: "webchat",
    },
    "1110": {
      runId: "r-typed",
      sessionKey: "agent:pip:main",
      agentId: "pip",
      trigger: "user",
      channel: "webchat",
    },
  },
  "bot-message": {
    "1006": {
      runId: "r-bot",
      sessionKey: "agent:marlow:main",
      agentId: "marlow",
      trigger: "user",
      channel: "webchat",
      inputProvenance: {
        kind: "inter_session",
        sourceTool: "sessions_send",
        sourceSessionKey: "agent:pip:main",
      },
    },
    "1110": {
      runId: "r-bot",
      sessionKey: "agent:marlow:main",
      agentId: "marlow",
      trigger: "user",
      channel: "webchat",
      inputProvenance: {
        kind: "inter_session",
        sourceTool: "sessions_send",
        sourceSessionKey: "agent:pip:main",
      },
    },
  },
  report: {
    "1006": {
      runId: "announce:v1:agent:marlow:dashboard:1",
      sessionKey: "agent:pip:main",
      agentId: "pip",
      trigger: "user",
      channel: "webchat",
      inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce" },
    },
    "1110": {
      runId: "announce:v1:agent:marlow:dashboard:1",
      sessionKey: "agent:pip:main",
      agentId: "pip",
      trigger: "user",
      channel: "webchat",
      inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce" },
    },
  },
  "command-line": {
    "1006": { runId: "r-cli", sessionKey: "agent:pip:main", agentId: "pip", trigger: "user" },
    "1110": { runId: "r-cli", sessionKey: "agent:pip:main", agentId: "pip", trigger: "user" },
  },
  routine: {
    "1006": { runId: "r-cron", sessionKey: "agent:pip:cron:j1", agentId: "pip", trigger: "cron" },
    "1110": {
      runId: "r-cron",
      sessionKey: "agent:pip:cron:j1",
      agentId: "pip",
      trigger: "cron",
      inputProvenance: { kind: "internal_system", sourceTool: "cron" },
    },
  },
  "check-in": {
    "1006": { runId: "r-hb", sessionKey: "agent:pip:main", agentId: "pip", trigger: "heartbeat" },
    "1110": { runId: "r-hb", sessionKey: "agent:pip:main", agentId: "pip", trigger: "heartbeat" },
  },
  "chat-app": {
    "1006": {
      runId: "r-chat",
      sessionKey: "agent:pip:discord:dm:1",
      agentId: "pip",
      trigger: "user",
      channel: "discord",
    },
    "1110": {
      runId: "r-chat",
      sessionKey: "agent:pip:discord:dm:1",
      agentId: "pip",
      trigger: "user",
      channel: "discord",
    },
  },
};

describe("where a run came from", () => {
  for (const [kind, byVersion] of Object.entries(frames)) {
    for (const [version, ctx] of Object.entries(byVersion)) {
      it(`${kind} on ${version}`, () => {
        const store = new RunOrigins();
        expect(store.sawPrompt(ctx)!.kind).toBe(kind);
      });
    }
  }

  it("a task one bot started under another: 2026.11.10 says so; 2026.10.6 sends it as a typed run", () => {
    const task = {
      runId: "r-task",
      sessionKey: "agent:marlow:dashboard:1",
      agentId: "marlow",
      trigger: "user",
      channel: "webchat",
    };
    const by1110 = {
      ...task,
      inputProvenance: { kind: "inter_session", sourceTool: "sessions_spawn" },
    };
    expect(new RunOrigins().sawPrompt(by1110)!.kind).toBe("task");
    // Only Clawtrate's own record of what it sent tells this one apart (design 4.1).
    expect(new RunOrigins().sawPrompt(task)!.kind).toBe("typed");
  });

  it("an unknown trigger or provenance is unknown", () => {
    expect(kindOf({ trigger: "memory", channel: "webchat", provenance: null })).toBe("unknown");
    expect(kindOf({ trigger: "user", channel: "webchat", provenance: { kind: "new_kind" } })).toBe(
      "unknown",
    );
    expect(
      kindOf({ trigger: "user", channel: "webchat", provenance: { kind: "external_user" } }),
    ).toBe("typed");
  });
});

describe("the origin of a call", () => {
  const run = (kind: string, extra: Json = {}) => ({
    kind,
    channel: "webchat",
    readOutside: null,
    lost: false,
    ...extra,
  });

  it("a typed run is never A in this build: it is B", () => {
    expect(originOf(run("typed"), owner, known).origin).toBe("B");
  });

  it("every other origin is C, a version this build doesn't know included", () => {
    for (const kind of [
      "bot-message",
      "task",
      "report",
      "routine",
      "check-in",
      "command-line",
      "unknown",
    ])
      expect(originOf(run(kind), owner, known).origin).toBe("C");
    expect(originOf(run("typed"), owner, { versionKnown: false }).origin).toBe("C");
    expect(originOf(null, owner, known)).toMatchObject({ origin: "C", why: "unknown-run" });
    expect(originOf(run("typed", { lost: true }), owner, known).origin).toBe("C");
  });

  it("a requester on another channel than a typed run's is not that run's", () => {
    expect(originOf(run("typed"), { channel: "discord", senderIsOwner: true }, known).origin).toBe(
      "C",
    );
  });

  it("a chat-app run is O only for the sender OpenClaw resolved as its owner, on that channel", () => {
    const chat = run("chat-app", { channel: "discord" });
    expect(originOf(chat, { channel: "discord", senderIsOwner: true }, known).origin).toBe("O");
    expect(originOf(chat, { channel: "discord", senderIsOwner: false }, known).origin).toBe("C");
    expect(originOf(chat, { channel: "discord" }, known).origin).toBe("C");
    expect(originOf(chat, undefined, known).origin).toBe("C");
    expect(originOf(chat, { channel: "telegram", senderIsOwner: true }, known).origin).toBe("C");
  });

  it("carries what the run read", () => {
    expect(originOf(run("typed", { readOutside: { source: "web" } }), owner, known).read).toBe(
      "web",
    );
  });
});

describe("read from outside", () => {
  it("every tool result counts but 4.3's", () => {
    for (const toolName of [
      "ask_user",
      "progress_card",
      "sessions_spawn",
      "tool_search",
      "tool_describe",
      "tool_call",
      "clawtrate_here",
    ])
      expect(readsOutside({ toolName })).toBe(false);
    for (const toolName of [
      "read",
      "web_search",
      "web_fetch",
      "sessions_send",
      "sessions_history",
      "sessions_list",
      "subagents",
      "automations",
      "exec",
      "mcp__x",
    ])
      expect(readsOutside({ toolName })).toBe(true);
  });

  it("Code Mode's own cell is decided by the calls inside it; the shell's exec is a command", () => {
    expect(readsOutside({ toolName: "exec", toolKind: "code_mode_exec" })).toBe(false);
    expect(readsOutside({ toolName: "exec" })).toBe(true);
  });

  it("names each source", () => {
    expect(sourceOf("web_search")).toBe("web");
    expect(sourceOf("read")).toBe("file");
    expect(sourceOf("exec")).toBe("command");
    expect(sourceOf("sessions_history")).toBe("task");
    expect(sourceOf("sessions_send")).toBe("reply");
    expect(sourceOf("sessions_list")).toBe("tasks");
    expect(sourceOf("mcp__coding_agent__ask")).toBe("tool");
  });

  it("keeps the first source", () => {
    const store = new RunOrigins();
    const run = store.sawPrompt(frames.typed["1006"]!)!;
    store.markRead(run, "web", "web_search");
    store.markRead(run, "file", "read");
    expect(run.readOutside).toMatchObject({ source: "web", tool: "web_search" });
  });

  it("a message that came with files, whenever its model resolution comes", () => {
    const store = new RunOrigins();
    store.sawAttachments({ runId: "r-typed" }, { attachments: [{ kind: "document" }] });
    expect(store.sawPrompt(frames.typed["1110"]!)!.readOutside).toMatchObject({
      source: "attachment",
    });
    const later = new RunOrigins();
    const run = later.sawPrompt(frames.typed["1110"]!)!;
    later.sawAttachments({ runId: "r-typed" }, { attachments: [] });
    expect(run.readOutside).toBeNull();
    later.sawAttachments({ runId: "r-typed" }, { attachments: [{ kind: "image" }] });
    expect(run.readOutside).toMatchObject({ source: "attachment" });
  });

  it("another session's message joining a run marks it; a plain steer is counted", () => {
    const store = new RunOrigins();
    const run = store.sawPrompt(frames.typed["1006"]!)!;
    store.sawMessage(
      { sessionKey: "agent:pip:main", message: { role: "user", content: "also this" } },
      {},
    );
    expect(run.steers).toBe(1);
    expect(run.readOutside).toBeNull();
    store.sawMessage(
      {
        sessionKey: "agent:pip:main",
        message: { role: "user", provenance: { kind: "inter_session" } },
      },
      {},
    );
    expect(run.readOutside).toMatchObject({ source: "message" });
    // After the run ends, a message starts a run of its own instead.
    const other = new RunOrigins();
    const ended = other.sawPrompt(frames.typed["1006"]!)!;
    other.sawEnd({ runId: "r-typed" });
    other.sawMessage(
      {
        sessionKey: "agent:pip:main",
        message: { role: "user", provenance: { kind: "inter_session" } },
      },
      {},
    );
    expect(ended.readOutside).toBeNull();
  });

  it("a run's own first message with its provenance doesn't mark it twice", () => {
    const store = new RunOrigins();
    const run = store.sawPrompt(frames["bot-message"]["1110"]!)!;
    store.sawMessage(
      {
        sessionKey: "agent:marlow:main",
        message: { role: "user", provenance: { kind: "inter_session" } },
      },
      {},
    );
    expect(run.readOutside).toBeNull();
  });
});

describe("finding a tool's run", () => {
  it("2026.10.6: by session and call id, as before_tool_call saw it", () => {
    const store = new RunOrigins();
    store.sawPrompt(frames.typed["1006"]!);
    store.sawCall(
      { toolName: "clawtrate_here", toolCallId: "c1", runId: "r-typed" },
      { sessionKey: "agent:pip:main" },
    );
    expect(store.runForTool({ sessionKey: "agent:pip:main", toolCallId: "c1" })!.runId).toBe(
      "r-typed",
    );
    // A call id another session also used doesn't find this run.
    expect(store.runForTool({ sessionKey: "agent:otto:main", toolCallId: "c1" })).toBeNull();
  });

  it("2026.11.10: by the tool's own run id", () => {
    const store = new RunOrigins();
    store.sawPrompt(frames.typed["1110"]!);
    expect(store.runForTool({ runId: "r-typed" })!.runId).toBe("r-typed");
  });
});

describe("bounds", () => {
  const limits = { ...LIMITS, runs: 3, calls: 2, lost: 2 };
  const typed = (n: number) => ({
    ...frames.typed["1006"]!,
    runId: `r${n}`,
    sessionKey: `agent:pip:s${n}`,
  });

  it("when full, an ended run leaves first; with none ended, a new run isn't held and is C", () => {
    const store = new RunOrigins({ limits });
    for (const n of [1, 2, 3]) store.sawPrompt(typed(n));
    store.sawEnd({ runId: "r2" });
    expect(store.sawPrompt(typed(4))).not.toBeNull();
    expect(store.lookup("r2")).toBeNull();
    expect(store.lookup("r1")).not.toBeNull();
    expect(store.sawPrompt(typed(5))).toBeNull();
    expect(originOf(store.lookup("r5"), owner, known).origin).toBe("C");
  });

  it("a run unseen for a day leaves; one still under way is lost and never held again", () => {
    let now = 0;
    const store = new RunOrigins({ limits, now: () => now });
    const run = store.sawPrompt(typed(1))!;
    store.markRead(run, "web", "web_search");
    store.sawPrompt(typed(2));
    store.sawEnd({ runId: "r2" });
    now = LIMITS.runMs + 1;
    expect(store.lookup("r1")).toMatchObject({ lost: true });
    expect(store.lookup("r2")).toBeNull();
    // Its next prompt doesn't make it new again, without what it had read.
    expect(store.sawPrompt(typed(1))).toBeNull();
    expect(originOf(store.lookup("r1"), owner, known).origin).toBe("C");
  });

  it("the lost list and the call lookup are bounded, oldest first", () => {
    const store = new RunOrigins({ limits });
    for (const n of [1, 2, 3]) store.remember(store.lost, `r${n}`, limits.lost);
    expect([...store.lost]).toEqual(["r2", "r3"]);
    for (const n of [1, 2, 3])
      store.sawCall({ toolName: "read", toolCallId: `c${n}`, runId: "r" }, { sessionKey: "s" });
    expect(store.calls.size).toBe(2);
    expect(store.calls.has("s\0c1")).toBe(false);
  });

  it("after a restart the store is empty: every call is C", () => {
    const store = new RunOrigins();
    expect(
      originOf(
        store.sawCall({ toolName: "automations", runId: "r-typed", toolCallId: "c" }, {}),
        owner,
        known,
      ).origin,
    ).toBe("C");
  });
});
