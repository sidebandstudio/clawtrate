// What a bot may do (docs/design/controls.md sections 2 to 5), answered on
// made-up facts shaped like the development gateway's: its tool lists, Otto's
// own command policy, a tool server, and the rules plugin's rules for Otto and
// for every bot. The view goes through the same reading the engine uses
// (`permissionsView`), so the fixture shows what a real read would.
//
// From the address: `rules=` the plugin (`running`, the default; `noplugin`,
// `stopped`, `old`, `unchecked`, `lost` with no copy, `kept` lost with a copy),
// `read=none` (Clawtrate never read its rules), `perm=` the page (`loading`,
// `error`, `fresh`: before the bot's first task), `override=1` (the gateway's
// settings deny a tool the bot allows), `write=` how a save goes (`refused`,
// `conflict`, `hidden`: sent and not shown by the read-back, `lost`: no answer came).

import {
  choiceRefusal,
  choiceShown,
  denyWrite,
  EVERY_BOT,
  execWrite,
  permissionsView,
  readToolCatalog,
  readToolSettings,
  type BotPermissions,
  type BridgeCommand,
  type ConfigWrite,
  type PermissionFacts,
  type PermissionWrite,
  type RulesPluginStatus,
  type RulesScope,
} from "@clawtrate/core";

type Json = Record<string, unknown>;

export type PermissionParams = {
  rules: string | null;
  read: string | null;
  perm: string | null;
  override: boolean;
  write: string | null;
};

export function permissionParams(params: URLSearchParams): PermissionParams {
  return {
    rules: params.get("rules"),
    read: params.get("read"),
    perm: params.get("perm"),
    override: params.get("override") === "1",
    write: params.get("write"),
  };
}

const MINUTE = 60_000;
const core = (ids: string[]) => ids.map((id) => ({ id, source: "core" }));
/** The gateway's catalog, as the development gateway lists it (OpenClaw 2026.10.6), in part. */
const CATALOG = {
  groups: [
    { id: "fs", label: "Files", tools: core(["ls", "read", "write", "edit", "apply_patch"]) },
    { id: "runtime", label: "Runtime", tools: core(["exec", "process", "code_execution"]) },
    { id: "web", label: "Web", tools: core(["web_search", "web_fetch", "x_search"]) },
    {
      id: "sessions",
      label: "Sessions",
      tools: core(["sessions_list", "sessions_history", "sessions_send"]),
    },
    { id: "ui", label: "UI", tools: core(["browser", "canvas"]) },
    { id: "messaging", label: "Messaging", tools: core(["message"]) },
    { id: "automation", label: "Automation", tools: core(["automations", "gateway", "plugins"]) },
    { id: "agents", label: "Agents", tools: core(["progress_card", "ask_user", "agents_list"]) },
    { id: "media", label: "Media", tools: core(["image_generate", "tts"]) },
    {
      id: "plugin:ollama",
      label: "ollama",
      source: "plugin",
      pluginId: "ollama",
      tools: [{ id: "node_inference", source: "plugin", pluginId: "ollama" }],
    },
  ],
};

function initialConfig(override: boolean): Json {
  return {
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
        "sessions_send",
        "sessions_list",
        "progress_card",
        "automations",
        "coder__*",
      ],
      deny: [
        "gateway",
        "plugins",
        "web_fetch",
        "x_search",
        "code_execution",
        "browser",
        "canvas",
        "message",
        "image_generate",
        "tts",
        "node_inference",
        ...(override ? ["web_search"] : []),
      ],
      exec: { mode: "deny" },
    },
    agents: {
      entries: {
        main: { tools: {} },
        otto: { tools: { exec: { mode: "ask" }, deny: ["automations"] } },
        marlow: { tools: {} },
        pip: { tools: {} },
      },
    },
    mcp: { servers: { coder: {} } },
  };
}

const rule = (id: string, action: string, tools: string[], pattern?: string) => ({
  id,
  version: 1,
  action,
  tools,
  ...(pattern ? { target: { kind: "path", pattern } } : {}),
});

function initialScopes(): Record<string, RulesScope> {
  return {
    otto: {
      version: 3,
      fallback: false,
      rules: [
        {
          ...rule("3f2a9c1b0d4e", "never", ["write", "edit", "apply_patch"], "secrets/**"),
          version: 2,
        },
        rule("7b1e0c4d2a9f", "ask", ["sessions_send"]),
      ] as RulesScope["rules"],
    },
    [EVERY_BOT]: {
      version: 1,
      fallback: false,
      rules: [
        rule("a1c4e7b20d3f", "never", ["write", "edit", "apply_patch"], "**/.ssh/**"),
      ] as RulesScope["rules"],
    },
  };
}

/** The permissions commands, answered on made-up facts. Undefined for any other command. */
export function permissionCommands(now: number, params: PermissionParams, admin: () => boolean) {
  let config = initialConfig(params.override);
  let hash = 1;
  const scopes = initialScopes();
  const readAt = now - 5 * MINUTE;
  const plugin = (): RulesPluginStatus => {
    switch (params.rules) {
      case "noplugin":
        return { kind: "unavailable" };
      case "stopped":
        return { kind: "stopped", reason: "unknown method", answered: false };
      case "old":
        return { kind: "old", version: "0.9.0" };
      case "unchecked":
        return { kind: "unchecked" };
      case "lost":
      case "kept":
        return {
          kind: "running",
          version: "1.0.0",
          answeredAt: now - MINUTE,
          lastCallAt: now - 2 * MINUTE,
          rules: "lost",
          lostReason: "the rules file is not JSON",
          keptCopyReadAt: params.rules === "kept" ? readAt : null,
          enforcing: params.rules === "kept" ? "kept-copy" : "ask-every-call",
        };
      default:
        return {
          kind: "running",
          version: "1.0.0",
          answeredAt: now - MINUTE,
          lastCallAt: now - 2 * MINUTE,
          rules: "read",
          lostReason: null,
          keptCopyReadAt: null,
          enforcing: "rules",
        };
    }
  };
  const facts = (botId: string): PermissionFacts => {
    const status = plugin();
    const readable = status.kind === "running" && status.rules !== "lost";
    const known =
      readable ||
      (params.read !== "none" && status.kind !== "unchecked" && !(status.kind === "unavailable"));
    return {
      botId,
      settings: readToolSettings({ config, hash: `fixture-${hash}` }, botId),
      catalog: readToolCatalog(CATALOG),
      offered:
        params.perm === "fresh"
          ? { status: "no-task" }
          : {
              status: "listed",
              taskKey: `agent:${botId}:main`,
              available: [
                "read",
                "ls",
                "write",
                "edit",
                "apply_patch",
                "exec",
                "web_search",
                "sessions_send",
                "sessions_list",
                "ask_user",
                "progress_card",
              ],
              servers: ["coder"],
            },
      plugin: status,
      rules: readable
        ? { from: "now", readAt: now - 30_000 }
        : known
          ? { from: "kept", readAt }
          : { from: null, readAt: null },
      botScope: known ? (scopes[botId] ?? null) : null,
      everyScope: known ? (scopes[EVERY_BOT] ?? null) : null,
      now: now - 30_000,
    };
  };
  const view = (botId: string): BotPermissions => permissionsView(facts(botId));
  const apply = (write: ConfigWrite) => {
    config = structuredClone(config);
    merge(config, write.patch, write.replacePaths, "");
    hash += 1;
  };

  return (command: BridgeCommand): Promise<unknown> | undefined => {
    if (command.type === "readPermissions") {
      if (params.perm === "loading") return new Promise(() => {});
      if (params.perm === "error") return Promise.reject(new Error("The gateway did not answer."));
      return delay(view(command.botId));
    }
    if (command.type !== "setPermission") return undefined;
    if (!admin())
      return Promise.reject(new Error("Changing what a bot may do needs admin access."));
    const before = facts(command.botId);
    const shown = permissionsView(before);
    const line = shown.lines.find((each) => each.id === command.line);
    if (!line) return Promise.reject(new Error("That line isn't one of this bot's any more."));
    const refusal = choiceRefusal(shown, line, command.choice, true);
    if (refusal) return Promise.reject(new Error(refusal));
    if (params.write === "conflict") {
      hash += 1;
      return delay<PermissionWrite>(
        { outcome: "conflict", error: null, view: view(command.botId) },
        600,
      );
    }
    if (params.write === "refused")
      return delay<PermissionWrite>(
        { outcome: "failed", error: "invalid config", view: view(command.botId) },
        600,
      );
    if (params.write === "lost")
      return delay<PermissionWrite>(
        {
          outcome: "unconfirmed",
          error: "The gateway did not answer in time.",
          view: view(command.botId),
        },
        600,
      );
    if (params.write !== "hidden") {
      const { settings, catalog } = before;
      const choice = command.choice;
      if (choice === "full" || choice === "auto" || choice === "exec-ask" || choice === "deny")
        apply(execWrite(command.botId, settings, choice, catalog));
      else if (choice === "ask") {
        const scope = scopes[command.botId] ?? { version: 0, fallback: false, rules: [] };
        scopes[command.botId] = {
          version: scope.version + 1,
          fallback: scope.fallback,
          rules: [
            ...scope.rules,
            { id: "5d0c2e8a1b7f", version: 1, action: "ask", tools: line.tools, target: null },
          ],
        };
        const deny = denyWrite(command.botId, settings, line, false, catalog);
        if (deny) apply(deny);
      } else {
        const deny = denyWrite(command.botId, settings, line, choice === "never", catalog);
        if (deny) apply(deny);
      }
    }
    const after = view(command.botId);
    const result: PermissionWrite = {
      outcome: choiceShown(
        after.lines.find((each) => each.id === command.line),
        command.choice,
      )
        ? "saved"
        : "not-shown",
      error: null,
      view: after,
    };
    return delay(result, 600);
  };
}

const delay = <T>(value: T, ms = 120) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

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
