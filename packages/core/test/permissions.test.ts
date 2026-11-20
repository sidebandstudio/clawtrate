// What a bot may do (docs/design/controls.md sections 2 to 5): the lines read
// from the gateway's and the rules plugin's answers, and each choice's write,
// against a fake connection that answers as OpenClaw 2026.10.6 and the plugin
// did on a development gateway.
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { describe, expect, it } from "vitest";
import {
  AdminNeededError,
  choiceRefusal,
  permissionGroups,
  type BotPermissions,
  type PermissionLine,
} from "../src/index.ts";
import { PermissionsEngine, type PermissionsContext } from "../src/permissions-engine.ts";

type Json = Record<string, unknown>;

const CATALOG = {
  groups: [
    {
      id: "fs",
      label: "Files",
      source: "core",
      tools: ["ls", "read", "write", "edit", "apply_patch"].map((id) => ({ id, source: "core" })),
    },
    {
      id: "runtime",
      label: "Runtime",
      source: "core",
      tools: ["exec", "process"].map((id) => ({ id, source: "core" })),
    },
    {
      id: "web",
      label: "Web",
      source: "core",
      tools: ["web_search", "web_fetch"].map((id) => ({ id, source: "core" })),
    },
    {
      id: "agents",
      label: "Agents",
      source: "core",
      tools: ["ask_user", "progress_card"].map((id) => ({ id, source: "core" })),
    },
    { id: "ui", label: "UI", source: "core", tools: [{ id: "browser", source: "core" }] },
    {
      id: "plugin:ollama",
      label: "ollama",
      source: "plugin",
      pluginId: "ollama",
      tools: [{ id: "node_inference", source: "plugin", pluginId: "ollama" }],
    },
  ],
};

/** A gateway that answers as the development gateway: its config, catalog, listing and plugin. */
class Gateway {
  config: Json = {
    tools: {
      allow: [
        "read",
        "write",
        "apply_patch",
        "edit",
        "ls",
        "exec",
        "web_search",
        "ask_user",
        "coder__*",
      ],
      deny: ["web_fetch", "browser", "node_inference"],
      exec: { mode: "deny" },
    },
    agents: { entries: { otto: { tools: { exec: { mode: "ask" } } }, pip: { tools: {} } } },
    mcp: { servers: { coder: { command: "/not/kept", args: ["/not/kept/either"] } } },
  };
  hash = 1;
  scopes: Record<string, { version: number; fallback: boolean; rules: Json[] }> = {};
  plugin: "running" | "stopped" | "unavailable" | "lost" | "old" = "running";
  sent: Array<{ method: string; params: Json }> = [];
  ids = 0;

  ctx(admin = true): PermissionsContext {
    return {
      session: () => (method, params) => this.answer(method, params as Json),
      connected: () => true,
      admin: () => admin,
      rulesMethods: () => this.plugin !== "unavailable",
      latestTask: (bot) => `agent:${bot}:main`,
      now: () => 1_795_000_000_000,
    };
  }

  async answer(method: string, params: Json): Promise<unknown> {
    this.sent.push({ method, params });
    switch (method) {
      case "config.get":
        return { config: this.config, hash: `h${this.hash}` };
      case "config.patch": {
        if (params.baseHash !== `h${this.hash}`)
          throw new Error("config changed since last load; re-run config.get and retry");
        const patch = JSON.parse(String(params.raw)) as Json;
        const paths = (params.replacePaths as string[] | undefined) ?? [];
        merge(this.config, patch, paths, "");
        this.hash += 1;
        return { ok: true };
      }
      case "tools.catalog":
        return CATALOG;
      case "tools.effective":
        return {
          toolAccess: {
            tools: [
              { id: "read", status: "available" },
              { id: "exec", status: "available" },
            ],
          },
          groups: [
            {
              id: "mcp",
              tools: [
                {
                  id: "coder__run_checks",
                  source: "mcp",
                  mcpServer: "coder",
                  mcpToolName: "run_checks",
                },
              ],
            },
          ],
        };
      case "clawtrate-tool-rules.status":
        if (this.plugin === "stopped") throw new Error("unknown method");
        return {
          plugin: "clawtrate-tool-rules",
          version: this.plugin === "old" ? "0.9.0" : "1.0.0",
          rules:
            this.plugin === "lost"
              ? { state: "lost", reason: "not JSON", keptCopyReadAt: null }
              : { state: "read", readAt: 1 },
          enforcing: this.plugin === "lost" ? "ask-every-call" : "rules",
          hook: { registered: true, lastCallAt: 1_794_999_000_000 },
        };
      case "clawtrate-tool-rules.get": {
        if (this.plugin !== "running") throw new Error("Rules unavailable: lost");
        const scope = String(params.scope);
        return { scopes: this.scopes[scope] ? { [scope]: this.scopes[scope] } : {} };
      }
      case "clawtrate-tool-rules.set": {
        const scope = String(params.scope);
        const before = this.scopes[scope];
        if ((before?.version ?? 0) !== params.expectedVersion) throw new Error("version_conflict");
        const rules = (params.rules as Json[]).map((r) =>
          r.id
            ? { ...r, version: (before?.rules.find((b) => b.id === r.id)?.version as number) ?? 1 }
            : { ...r, id: `r${(this.ids += 1)}`, version: 1 },
        );
        this.scopes[scope] = {
          version: (before?.version ?? 0) + 1,
          fallback: params.fallback === true,
          rules,
        };
        return this.scopes[scope];
      }
    }
    throw new Error(`unexpected ${method}`);
  }

  writes() {
    return this.sent.filter(
      (each) => each.method === "config.patch" || each.method === "clawtrate-tool-rules.set",
    );
  }
}

function merge(target: Json, patch: Json, paths: string[], at: string): void {
  for (const [key, value] of Object.entries(patch)) {
    const path = at ? `${at}.${key}` : key;
    if (value === null) delete target[key];
    else if (typeof value === "object" && !Array.isArray(value) && !paths.includes(path)) {
      target[key] = (target[key] as Json | undefined) ?? {};
      merge(target[key] as Json, value as Json, paths, path);
    } else target[key] = value;
  }
}

const line = (view: BotPermissions, id: string): PermissionLine => {
  const found = view.lines.find((each) => each.id === id);
  if (!found) throw new Error(`no line ${id}`);
  return found;
};
const botTools = (gw: Gateway, bot: string) =>
  ((gw.config.agents as Json).entries as Record<string, Json>)[bot]!.tools as Json;

describe("what a bot may do", () => {
  it("F-176: reads each tool group as one line, with its value, from the gateway's settings and the latest task's listing", async () => {
    const gw = new Gateway();
    const view = await new PermissionsEngine(gw.ctx()).read("otto");
    expect(line(view, "read")).toMatchObject({
      value: "allowed",
      tools: ["read", "ls"],
      offered: "yes",
    });
    expect(line(view, "files")).toMatchObject({ value: "allowed", choice: "allow" });
    // Run commands: Otto's own policy replaces the default for every bot.
    expect(line(view, "exec")).toMatchObject({ value: "asks", mark: "gateway", choice: "ask" });
    expect(line(view, "exec").exec).toEqual({ own: "ask", every: "deny", applies: "ask" });
    // Asking you questions is always without asking.
    expect(line(view, "ask")).toMatchObject({ value: "allowed", kind: "question" });
    // A tool server, and a plugin's tools under its name.
    expect(line(view, "server:coder")).toMatchObject({
      tools: ["coder__*"],
      value: "allowed",
      offered: "yes",
    });
    expect(line(view, "plugin:ollama")).toMatchObject({
      words: "From ollama",
      value: "never",
      mark: "set",
    });
    // A tool the allow list leaves out is not offered.
    expect(line(view, "tool:progress_card")).toMatchObject({ value: "not-offered" });
    // Nothing of the config but the tool settings is in the answer.
    expect(JSON.stringify(view)).not.toContain("/not/kept");
    const groups = permissionGroups(view.lines);
    expect(groups.never).toContain("browser");
    expect(groups.asks).toEqual(["exec"]);
    expect(groups.notOffered).toContain("tool:progress_card");
  });

  it("F-176: Never adds the line's tools to the bot's own deny list in one config.patch against the hash read, and is saved only once the read-back shows it", async () => {
    const gw = new Gateway();
    const engine = new PermissionsEngine(gw.ctx());
    const view = await engine.read("pip");
    const result = await engine.choose("pip", "files", "never", {
      configHash: view.configHash,
      rulesVersion: view.versions.bot,
    });
    expect(result.outcome).toBe("saved");
    expect(botTools(gw, "pip").deny).toEqual(["write", "edit", "apply_patch"]);
    const patch = gw.writes()[0]!;
    expect(patch.params.replacePaths).toEqual(["agents.entries.pip.tools.deny"]);
    expect(gw.writes()).toHaveLength(1);
    expect(line(result.view!, "files")).toMatchObject({
      value: "never",
      mark: "gateway",
      choice: "never",
    });
    // Allow takes them off again; an empty list is removed whole.
    const back = await engine.choose("pip", "files", "allow", {
      configHash: result.view!.configHash,
      rulesVersion: null,
    });
    expect(back.outcome).toBe("saved");
    expect(botTools(gw, "pip").deny).toBeUndefined();
  });

  it("F-176: Ask writes a whole-tool Ask to the bot's scope at the version read, keeping its other rules, then takes the deny off", async () => {
    const gw = new Gateway();
    gw.scopes.pip = {
      version: 3,
      fallback: false,
      rules: [
        {
          id: "a1",
          version: 2,
          action: "never",
          tools: ["write"],
          target: { kind: "path", pattern: "secrets/**" },
          note: "Keep keys away",
        },
      ],
    };
    botTools(gw, "pip").deny = ["read", "ls"];
    const engine = new PermissionsEngine(gw.ctx());
    const view = await engine.read("pip");
    expect(line(view, "read").value).toBe("never");
    const result = await engine.choose("pip", "read", "ask", {
      configHash: view.configHash,
      rulesVersion: view.versions.bot,
    });
    expect(result.outcome).toBe("saved");
    const [set, patch] = gw.writes();
    expect(set!.method).toBe("clawtrate-tool-rules.set");
    expect(set!.params).toEqual({
      scope: "pip",
      rules: [
        {
          id: "a1",
          action: "never",
          tools: ["write"],
          target: { kind: "path", pattern: "secrets/**" },
          note: "Keep keys away",
        },
        { action: "ask", tools: ["read", "ls"] },
      ],
      fallback: false,
      expectedVersion: 3,
    });
    expect(patch!.method).toBe("config.patch");
    expect(line(result.view!, "read")).toMatchObject({
      value: "asks",
      mark: "plugin",
      ownAsk: true,
    });
    // The Ask is the plugin's: Allow does not undo it here.
    expect(choiceRefusal(result.view!, line(result.view!, "read"), "allow", true)).toMatch(
      /rules page/,
    );
  });

  it("Ask replaces the deny list it read and no newer one: another client's change after the rule landed is kept, and both outcomes are said", async () => {
    const gw = new Gateway();
    botTools(gw, "pip").deny = ["write", "edit", "apply_patch"];
    const engine = new PermissionsEngine(gw.ctx());
    const view = await engine.read("pip");
    const answer = gw.answer.bind(gw);
    gw.answer = async (method, params) => {
      const got = await answer(method, params);
      // Another operator denies ls right after the rules plugin took the Ask.
      if (method === "clawtrate-tool-rules.set") {
        (botTools(gw, "pip").deny as string[]).push("ls");
        gw.hash += 1;
      }
      return got;
    };
    const result = await engine.choose("pip", "files", "ask", {
      configHash: view.configHash,
      rulesVersion: view.versions.bot,
    });
    expect(result.outcome).toBe("partial");
    expect(result.error).toBe("Someone else changed these settings.");
    expect(botTools(gw, "pip").deny).toEqual(["write", "edit", "apply_patch", "ls"]);
    expect(gw.writes().map((w) => w.method)).toEqual(["clawtrate-tool-rules.set"]);
    expect(gw.scopes.pip!.rules).toEqual([
      expect.objectContaining({ action: "ask", tools: ["write", "edit", "apply_patch"] }),
    ]);
  });

  it("a choice stays on the gateway it started on: after a switch between Ask's two writes, the other gateway gets nothing", async () => {
    const first = new Gateway();
    const second = new Gateway();
    botTools(first, "pip").deny = ["read", "ls"];
    botTools(second, "pip").deny = ["read", "ls"];
    let current = first;
    const ctx: PermissionsContext = {
      ...first.ctx(),
      session: () => {
        const bound = current;
        return (method, params) => bound.answer(method, params as Json);
      },
    };
    const engine = new PermissionsEngine(ctx);
    const view = await engine.read("pip");
    const answer = first.answer.bind(first);
    first.answer = async (method, params) => {
      const got = await answer(method, params);
      if (method === "clawtrate-tool-rules.set") current = second;
      return got;
    };
    const result = await engine.choose("pip", "read", "ask", {
      configHash: view.configHash,
      rulesVersion: view.versions.bot,
    });
    expect(second.sent).toEqual([]);
    expect(result.outcome).toBe("saved");
    expect(botTools(first, "pip").deny).toBeUndefined();
  });

  it("F-177: a rule for every bot and the bot's own rule both apply on the bot's line; another bot's line shows only the rule for every bot", async () => {
    const gw = new Gateway();
    gw.scopes["*"] = {
      version: 1,
      fallback: false,
      rules: [{ id: "e1", version: 1, action: "ask", tools: ["web_search"] }],
    };
    gw.scopes.otto = {
      version: 1,
      fallback: false,
      rules: [{ id: "o1", version: 1, action: "ask", tools: ["write", "edit", "apply_patch"] }],
    };
    const engine = new PermissionsEngine(gw.ctx());
    const otto = await engine.read("otto");
    const pip = await engine.read("pip");
    expect(line(otto, "files")).toMatchObject({ value: "asks", ownAsk: true });
    expect(line(otto, "files").exceptions).toEqual([
      expect.objectContaining({ kind: "rule", scope: "bot", action: "ask", id: "o1" }),
    ]);
    expect(line(otto, "web").exceptions).toContainEqual(
      expect.objectContaining({ kind: "rule", scope: "every", action: "ask", id: "e1" }),
    );
    expect(line(pip, "files")).toMatchObject({ value: "allowed" });
    expect(line(pip, "web")).toMatchObject({ value: "asks", ownAsk: false });
  });

  it("a Never rule of the plugin on some of a line's tools limits the line and is named, and the line's other tools stay as they are", async () => {
    const gw = new Gateway();
    gw.scopes.otto = {
      version: 1,
      fallback: false,
      rules: [{ id: "n1", version: 1, action: "never", tools: ["ls"] }],
    };
    const otto = await new PermissionsEngine(gw.ctx()).read("otto");
    expect(line(otto, "read")).toMatchObject({ value: "limited", mark: "plugin", choice: "allow" });
    expect(line(otto, "read").exceptions).toEqual([
      expect.objectContaining({
        kind: "rule",
        scope: "bot",
        action: "never",
        id: "n1",
        tools: ["ls"],
      }),
    ]);
  });

  it("a tool the gateway's settings deny for every bot reads Never with the padlock, whatever the bot's own allow or Ask, and no choice can be made", async () => {
    const gw = new Gateway();
    (gw.config.tools as Json).deny = ["web_search", "web_fetch", "browser", "node_inference"];
    gw.scopes.otto = {
      version: 1,
      fallback: false,
      rules: [
        { id: "o1", version: 1, action: "allow", tools: ["web_search"] },
        { id: "o2", version: 1, action: "ask", tools: ["web_search"] },
      ],
    };
    const engine = new PermissionsEngine(gw.ctx());
    const view = await engine.read("otto");
    expect(line(view, "web")).toMatchObject({ value: "never", mark: "set" });
    for (const choice of ["allow", "ask", "never"] as const)
      expect(choiceRefusal(view, line(view, "web"), choice, true)).toMatch(/for every bot/);
    await expect(
      engine.choose("otto", "web", "allow", {
        configHash: view.configHash,
        rulesVersion: view.versions.bot,
      }),
    ).rejects.toThrow(/for every bot/);
    expect(gw.writes()).toEqual([]);
  });

  it("a deny of the bot's own on some of a line's tools is Limited, names them, checks no choice, and Never then denies the rest", async () => {
    const gw = new Gateway();
    botTools(gw, "pip").deny = ["edit"];
    const engine = new PermissionsEngine(gw.ctx());
    const view = await engine.read("pip");
    expect(line(view, "files")).toMatchObject({ value: "limited", mark: "gateway", choice: null });
    expect(line(view, "files").exceptions).toEqual([{ kind: "bot-deny", tools: ["edit"] }]);
    expect(choiceRefusal(view, line(view, "files"), "never", true)).toBeNull();
    const result = await engine.choose("pip", "files", "never", {
      configHash: view.configHash,
      rulesVersion: view.versions.bot,
    });
    expect(result.outcome).toBe("saved");
    expect(botTools(gw, "pip").deny).toEqual(["edit", "write", "apply_patch"]);
    expect(line(result.view!, "files")).toMatchObject({ value: "never", choice: "never" });
  });

  it("F-222: a tool server's Never writes `<server>__*` to the bot's own deny list, and Allow takes it off", async () => {
    const gw = new Gateway();
    const engine = new PermissionsEngine(gw.ctx());
    const view = await engine.read("pip");
    const result = await engine.choose("pip", "server:coder", "never", {
      configHash: view.configHash,
      rulesVersion: null,
    });
    expect(result.outcome).toBe("saved");
    expect(botTools(gw, "pip").deny).toEqual(["coder__*"]);
    expect(line(result.view!, "server:coder")).toMatchObject({ value: "never", mark: "gateway" });
    const back = await engine.choose("pip", "server:coder", "allow", {
      configHash: result.view!.configHash,
      rulesVersion: null,
    });
    expect(back.outcome).toBe("saved");
    expect(botTools(gw, "pip").deny).toBeUndefined();
  });

  it("F-176: Run commands writes the bot's own command policy, and takes exec off its deny list", async () => {
    const gw = new Gateway();
    botTools(gw, "pip").deny = ["exec"];
    const engine = new PermissionsEngine(gw.ctx());
    const view = await engine.read("pip");
    expect(line(view, "exec")).toMatchObject({ value: "never", mark: "gateway" });
    const result = await engine.choose("pip", "exec", "exec-ask", {
      configHash: view.configHash,
      rulesVersion: null,
    });
    expect(result.outcome).toBe("saved");
    expect(botTools(gw, "pip")).toEqual({ exec: { mode: "ask" } });
    expect(gw.writes()).toHaveLength(1);
  });

  it("F-176: below admin a choice is refused before anything is sent", async () => {
    const gw = new Gateway();
    const engine = new PermissionsEngine(gw.ctx(false));
    await expect(
      engine.choose("pip", "files", "never", { configHash: null, rulesVersion: null }),
    ).rejects.toBeInstanceOf(AdminNeededError);
    expect(gw.sent).toEqual([]);
  });

  it("F-176: a settings hash that changed since the page read it is a conflict, answered with what the gateway has now, and nothing is written", async () => {
    const gw = new Gateway();
    const engine = new PermissionsEngine(gw.ctx());
    const view = await engine.read("pip");
    gw.hash += 1;
    const result = await engine.choose("pip", "files", "never", {
      configHash: view.configHash,
      rulesVersion: null,
    });
    expect(result.outcome).toBe("conflict");
    expect(result.view?.configHash).toBe(`h${gw.hash}`);
    expect(gw.writes()).toEqual([]);
  });

  it("F-176: a write the gateway refuses answers failed, with what the gateway has now", async () => {
    const gw = new Gateway();
    const engine = new PermissionsEngine(gw.ctx());
    const view = await engine.read("pip");
    const answer = gw.answer.bind(gw);
    gw.answer = async (method, params) => {
      if (method === "config.patch")
        throw new GatewayProtocolRequestError({
          code: "INVALID_REQUEST",
          message: "invalid config",
        });
      return answer(method, params);
    };
    const result = await engine.choose("pip", "files", "never", {
      configHash: view.configHash,
      rulesVersion: null,
    });
    expect(result).toMatchObject({ outcome: "failed", error: "invalid config" });
    expect(line(result.view!, "files").value).toBe("allowed");
  });

  it("F-176: a write whose answer is lost is saved only if the read after it shows it, and else couldn't be confirmed", async () => {
    for (const applied of [true, false]) {
      const gw = new Gateway();
      const engine = new PermissionsEngine(gw.ctx());
      const view = await engine.read("pip");
      const answer = gw.answer.bind(gw);
      gw.answer = async (method, params) => {
        if (method !== "config.patch") return answer(method, params);
        if (applied) await answer(method, params);
        throw new Error("request timed out");
      };
      const result = await engine.choose("pip", "files", "never", {
        configHash: view.configHash,
        rulesVersion: null,
      });
      expect(result.outcome).toBe(applied ? "saved" : "unconfirmed");
      if (!applied) expect(result.error).toBe("request timed out");
    }
    // The answer came, and the read after it did not: not confirmed, never saved or failed.
    const gw = new Gateway();
    const engine = new PermissionsEngine(gw.ctx());
    const view = await engine.read("pip");
    const answer = gw.answer.bind(gw);
    let patched = false;
    gw.answer = async (method, params) => {
      if (patched && method === "config.get") throw new Error("request timed out");
      const got = await answer(method, params);
      if (method === "config.patch") patched = true;
      return got;
    };
    const result = await engine.choose("pip", "files", "never", {
      configHash: view.configHash,
      rulesVersion: null,
    });
    expect(result).toMatchObject({ outcome: "unconfirmed", view: null });
  });
});

describe("a read that fails or can't be read", () => {
  const broken = (method: string, reply: unknown) => {
    const gw = new Gateway();
    const answer = gw.answer.bind(gw);
    gw.answer = async (m, params) => (m === method ? reply : answer(m, params));
    return gw;
  };

  it.each([
    ["config.get without its config", "config.get", { hash: "h1" }],
    [
      "config.get whose deny list isn't a list",
      "config.get",
      { config: { tools: { deny: "exec" } }, hash: "h1" },
    ],
    ["tools.catalog without groups", "tools.catalog", {}],
    [
      "tools.catalog with a tool without an id",
      "tools.catalog",
      { groups: [{ id: "fs", tools: [{}] }] },
    ],
  ])("%s fails the whole read: no line reads Allowed from it", async (_name, method, reply) => {
    const engine = new PermissionsEngine(broken(method, reply).ctx());
    await expect(engine.read("otto")).rejects.toThrow(/couldn't be read/);
  });

  it("a listing of the latest task that can't be read is a failed listing, not an empty one", async () => {
    const view = await new PermissionsEngine(broken("tools.effective", { ok: true }).ctx()).read(
      "otto",
    );
    expect(view.offered).toMatchObject({ status: "failed" });
    // Its lines are those of the settings alone, as before a first task.
    const gw = new Gateway();
    const none = await new PermissionsEngine({ ...gw.ctx(), latestTask: () => null }).read("otto");
    expect(view.lines.map((each) => [each.id, each.value])).toEqual(
      none.lines.map((each) => [each.id, each.value]),
    );
  });

  it.each([
    ["without scopes", {}],
    [
      "with a rule it can't read",
      { scopes: { otto: { version: 2, fallback: false, rules: [{ id: "n1", action: "never" }] } } },
    ],
  ])(
    "the plugin's rules %s are not read: its lines are Unknown, never Allowed",
    async (_name, reply) => {
      const gw = broken("clawtrate-tool-rules.get", reply);
      gw.scopes.otto = { version: 2, fallback: false, rules: [] };
      const view = await new PermissionsEngine(gw.ctx()).read("otto");
      expect(view.rules.from).toBe(null);
      expect(choiceRefusal(view, line(view, "files"), "ask", true)).toMatch(/rules plugin/);
    },
  );

  it("a plugin status that can't be read is Unavailable, apart from one that reports it isn't enforcing", async () => {
    const view = await new PermissionsEngine(
      broken("clawtrate-tool-rules.status", { ok: 1 }).ctx(),
    ).read("otto");
    expect(view.plugin).toEqual({
      kind: "stopped",
      reason: "its status answer couldn't be read",
      answered: false,
    });
  });
});

describe("the rules plugin's state", () => {
  it("F-176: says what the plugin's own status says, and never reads a plugin line as held while it isn't running", async () => {
    const gw = new Gateway();
    gw.scopes.otto = {
      version: 1,
      fallback: false,
      rules: [{ id: "o1", version: 1, action: "ask", tools: ["write", "edit", "apply_patch"] }],
    };
    const engine = new PermissionsEngine(gw.ctx());
    const running = await engine.read("otto");
    expect(running.plugin).toMatchObject({
      kind: "running",
      rules: "read",
      enforcing: "rules",
      lastCallAt: 1_794_999_000_000,
    });
    expect(running.rules.from).toBe("now");
    // Stopped: the copy this client read stands in, and the line is Unknown, not Asks first.
    gw.plugin = "stopped";
    const stopped = await engine.read("otto");
    expect(stopped.plugin).toMatchObject({ kind: "stopped" });
    expect(stopped.rules.from).toBe("kept");
    expect(line(stopped, "files")).toMatchObject({ value: "unknown", mark: "not-now" });
    expect(choiceRefusal(stopped, line(stopped, "files"), "ask", true)).toMatch(
      /needs Clawtrate's rules plugin/,
    );
    // A gateway whose method list does not name the plugin.
    gw.plugin = "unavailable";
    expect((await engine.read("otto")).plugin).toEqual({ kind: "unavailable" });
    gw.plugin = "old";
    expect((await engine.read("otto")).plugin).toEqual({ kind: "old", version: "0.9.0" });
  });

  it("F-176: rules lost on the gateway: the plugin asks before every call, get and set are refused, and a client that never read them names no rule", async () => {
    const gw = new Gateway();
    gw.plugin = "lost";
    const view = await new PermissionsEngine(gw.ctx()).read("otto");
    expect(view.plugin).toMatchObject({
      kind: "running",
      rules: "lost",
      enforcing: "ask-every-call",
      lostReason: "not JSON",
    });
    expect(view.rules).toEqual({ from: null, readAt: null });
    expect(gw.sent.some((each) => each.method === "clawtrate-tool-rules.get")).toBe(false);
    expect(line(view, "files").exceptions).toEqual([]);
  });
});
