// The gateway's map from a tool-server tool's effective name to its server and
// tool (`tools.effective`), kept per task: evidence of a call's tool before its
// result, read when the task opens and again when the gateway reports its
// plugins changed.
import { describe, expect, it } from "vitest";
import { builtinToolNames, mcpToolMap } from "../src/cards.ts";
import { MAX_BUILTIN_TOOLS, MAX_MCP_TOOLS } from "../src/state-bounds.ts";
import { KEY, openTask } from "./client-harness.ts";
import { GatewayError, until } from "./fake-gateway.ts";

const entry = (id: string, server: string, tool: string, extra: Record<string, unknown> = {}) => ({
  id,
  label: tool,
  description: "",
  rawDescription: "",
  source: "mcp",
  pluginId: "bundle-mcp",
  mcpServer: server,
  mcpToolName: tool,
  ...extra,
});
/** As OpenClaw 2026.10.6 answers it: `{agentId, profile, groups, toolAccess, notices}`. */
const answer = (tools: unknown[]) => ({
  agentId: "otto",
  profile: "default",
  groups: [
    {
      id: "core",
      label: "Built-in",
      source: "core",
      tools: [{ id: "read", label: "read", description: "", rawDescription: "", source: "core" }],
    },
    { id: "mcp", label: "MCP", source: "mcp", tools },
  ],
  toolAccess: {},
  notices: [],
});

describe("the tool map from tools.effective", () => {
  it("keeps tool-server tools by effective name, leaves out denied and other tools, and stops at its bound", () => {
    expect(
      mcpToolMap(
        answer([
          entry("t3code__t3_thread_launch", "t3code", "t3_thread_launch"),
          entry("t3code__t3_thread_launch-2", "t3code", "t3_thread_launch-2"),
          entry("coder__send_message", "coder", "send_message", { deniedBySession: true }),
          { id: "no_server", source: "mcp", mcpToolName: "x" },
        ]),
        MAX_MCP_TOOLS,
      ),
    ).toEqual({
      t3code__t3_thread_launch: { server: "t3code", tool: "t3_thread_launch" },
      "t3code__t3_thread_launch-2": { server: "t3code", tool: "t3_thread_launch-2" },
    });
    const many = Array.from({ length: MAX_MCP_TOOLS + 5 }, (_, i) =>
      entry(`s__t${i}`, "s", `t${i}`),
    );
    expect(Object.keys(mcpToolMap(answer(many), MAX_MCP_TOOLS))).toHaveLength(MAX_MCP_TOOLS);
    expect(mcpToolMap(null, MAX_MCP_TOOLS)).toEqual({});
  });

  it("is read for a task when it opens, again when the gateway reports its plugins changed, and kept when a read fails", async () => {
    let tools = [entry("t3code__t3_thread_launch", "t3code", "t3_thread_launch")];
    let fail = false;
    const asked: unknown[] = [];
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["tools.effective"] = (params) => {
      asked.push(params);
      if (fail) throw new GatewayError({ code: "UNAVAILABLE", message: "busy" });
      return answer(tools);
    };
    try {
      // The task opened before the handler: the next opening reads it.
      client.closeSession(KEY);
      client.openSession(KEY);
      await until(() => Object.keys(transcript()?.mcpTools ?? {}).length === 1);
      expect(asked.at(-1)).toEqual({ sessionKey: KEY });
      expect(transcript().mcpTools).toEqual({
        t3code__t3_thread_launch: { server: "t3code", tool: "t3_thread_launch" },
      });

      tools = [entry("t3code__t3_thread_send", "t3code", "t3_thread_send")];
      gateway.emit("plugins.changed", {});
      await until(() => "t3code__t3_thread_send" in transcript().mcpTools);
      expect(Object.keys(transcript().mcpTools)).toEqual(["t3code__t3_thread_send"]);

      fail = true;
      const before = asked.length;
      gateway.emit("plugins.changed", {});
      await until(() => asked.length > before);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(Object.keys(transcript().mcpTools)).toEqual(["t3code__t3_thread_send"]);
    } finally {
      client.stop();
    }
  });

  it("tries a failed first read again, so a task opened while the gateway was busy still gets its map", async () => {
    let failures = 1;
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["tools.effective"] = () => {
      if (failures > 0) {
        failures -= 1;
        throw new GatewayError({ code: "UNAVAILABLE", message: "busy" });
      }
      return answer([entry("coder__slow_task", "coder", "slow_task")]);
    };
    try {
      client.closeSession(KEY);
      client.openSession(KEY);
      // Without the map, history's tool-server call would read as a general card until the
      // gateway's plugins changed: the read is tried again a little later.
      await until(() => "coder__slow_task" in (transcript()?.mcpTools ?? {}), 5_000);
      expect(transcript().mcpTools).toEqual({
        coder__slow_task: { server: "coder", tool: "slow_task" },
      });
    } finally {
      client.stop();
    }
  });

  it("reads a task's map one read at a time, so the map after a change is the one kept", async () => {
    const answers: Array<(value: unknown) => void> = [];
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["tools.effective"] = () => new Promise((resolve) => answers.push(resolve));
    try {
      gateway.emit("plugins.changed", {});
      await until(() => answers.length === 1);
      // The catalog changes while that read is in flight: the next read waits for it.
      gateway.emit("plugins.changed", {});
      gateway.emit("plugins.changed", {});
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(answers).toHaveLength(1);
      answers[0]!(answer([entry("t3code__t3_thread_launch", "t3code", "t3_thread_launch")]));
      // Then one more read, for both changes, whose answer is the map kept.
      await until(() => answers.length === 2);
      answers[1]!(answer([entry("t3code__t3_thread_send", "t3code", "t3_thread_send")]));
      await until(() => "t3code__t3_thread_send" in transcript().mcpTools);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(answers).toHaveLength(2);
      expect(transcript().mcpTools).toEqual({
        t3code__t3_thread_send: { server: "t3code", tool: "t3_thread_send" },
      });
    } finally {
      client.stop();
    }
  });

  it("drops an answer for a task released while it was read", async () => {
    let answerRead!: (value: unknown) => void;
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["tools.effective"] = () => new Promise((resolve) => (answerRead = resolve));
    try {
      gateway.emit("plugins.changed", {});
      await until(() => answerRead !== undefined);
      client.closeSession(KEY);
      client.openSession(KEY);
      answerRead(answer([entry("t3code__t3_thread_launch", "t3code", "t3_thread_launch")]));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(transcript()?.mcpTools ?? {}).toEqual({});
    } finally {
      client.stop();
    }
  });
});

describe("the inventory's built-in and plugin tools, and the bot's workspace root", () => {
  const plugin = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    label: id,
    description: "",
    rawDescription: "",
    source: "plugin",
    pluginId: "skills",
    ...extra,
  });
  const withPlugins = (tools: unknown[]) => ({
    ...answer([entry("coder__send_message", "coder", "send_message")]),
    groups: [
      ...answer([entry("coder__send_message", "coder", "send_message")]).groups,
      { id: "plugins", label: "Plugins", source: "plugin", tools },
    ],
  });

  it("names core and plugin tools, never a tool-server or denied one, up to its bound", () => {
    expect(
      builtinToolNames(
        withPlugins([plugin("skills_search"), plugin("hidden", { deniedBySession: true })]),
        MAX_BUILTIN_TOOLS,
      ),
    ).toEqual(["read", "skills_search"]);
    const many = Array.from({ length: MAX_BUILTIN_TOOLS + 3 }, (_, i) => plugin(`p${i}`));
    expect(builtinToolNames(withPlugins(many), MAX_BUILTIN_TOOLS)).toHaveLength(MAX_BUILTIN_TOOLS);
  });

  it("are read when a task opens: the inventory from tools.effective, the root from agents.files.list", async () => {
    const asked: unknown[] = [];
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["tools.effective"] = () => withPlugins([plugin("skills_search")]);
    gateway.handlers["agents.files.list"] = (params) => {
      asked.push(params);
      return { agentId: "otto", workspace: "/workspace/otto", files: [] };
    };
    try {
      client.closeSession(KEY);
      client.openSession(KEY);
      await until(() => transcript()?.workspaceRoot === "/workspace/otto");
      await until(() => (transcript()?.builtinTools ?? []).includes("skills_search"));
      expect(asked).toEqual([{ agentId: "otto" }]);
      expect(transcript().builtinTools).toEqual(["read", "skills_search"]);
    } finally {
      client.stop();
    }
  });

  it("leaves the root unknown when the gateway does not give it", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["agents.files.list"] = () => {
      throw new GatewayError({ code: "INVALID_REQUEST", message: "unknown method" });
    };
    try {
      client.closeSession(KEY);
      client.openSession(KEY);
      await until(() => transcript()?.status === "ready");
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(transcript().workspaceRoot ?? null).toBeNull();
    } finally {
      client.stop();
    }
  });
});
