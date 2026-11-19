// A fake gateway host for the plugin's tests. The plugin's real register
// code, hook and method handlers run against it, with its store in a
// temporary folder; nothing here touches a gateway.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolRules } from "../index.js";

type Json = Record<string, unknown>;
export type Answer = {
  ok: boolean;
  payload?: Json;
  error?: { code: string; message: string; details?: Json };
};
export type HookResult = {
  block?: boolean;
  blockReason?: string;
  params?: Json;
  requireApproval?: {
    title: string;
    description: string;
    severity?: string;
    timeoutMs?: number;
    allowedDecisions?: string[];
    onResolution?: (decision: string) => void;
  };
};

/** Every host started and not yet stopped, so a test file can make sure it stopped them all. */
export const running = new Set<object>();

/** A temporary state folder, removed by `done`. */
export function tempState() {
  const dir = mkdtempSync(join(tmpdir(), "clawtrate-tool-rules-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Register the plugin on a fake host. `stateDir` is the gateway's state
 * folder; `slots` the process-wide state (fresh per host unless shared);
 * `on: false` leaves the hook API out, as a load without hooks would.
 */
export function load(
  options: {
    stateDir: string;
    slots?: Map<unknown, unknown>;
    on?: boolean;
    config?: Json;
    pluginConfig?: Json;
    workspaces?: Record<string, string>;
    now?: () => number;
    log?: { now?: () => number; retentionMs?: number; max?: number };
    startService?: boolean;
  } = { stateDir: "" },
) {
  const methods = new Map<string, { handler: (opts: Json) => Promise<void>; opts: Json }>();
  const hooks: { name: string; fn: (event: Json, ctx: Json) => unknown; opts: Json }[] = [];
  const services: { start(ctx: Json): void; stop(): void }[] = [];
  const events: { name: string; payload: unknown; opts: unknown }[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const config = options.config ?? {};
  const api: Json = {
    pluginConfig: options.pluginConfig ?? {},
    config,
    runtime: {
      config: { current: () => config },
      agent: {
        resolveAgentWorkspaceDir: (_cfg: unknown, agentId: string) =>
          options.workspaces?.[agentId] ?? `/nonexistent-workspaces/${agentId}`,
      },
    },
    logger: {
      info: (m: string) => infos.push(m),
      warn: (m: string) => warnings.push(m),
      error() {},
    },
    registerGatewayMethod: (name: string, handler: (opts: Json) => Promise<void>, opts: Json) =>
      methods.set(name, { handler, opts }),
    registerService: (service: (typeof services)[number]) => services.push(service),
  };
  if (options.on !== false) {
    api.on = (name: string, fn: (event: Json, ctx: Json) => unknown, opts: Json = {}) =>
      hooks.push({ name, fn, opts });
  }
  const slots = options.slots ?? new Map();
  const handle = createToolRules(api, {
    stateDir: options.stateDir,
    slots,
    ...(options.now ? { now: options.now } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  const gatewayEvents = {
    emit: (name: string, payload: unknown, opts: unknown) => events.push({ name, payload, opts }),
  };
  if (options.startService !== false) {
    for (const service of services) service.start({ gatewayEvents });
    running.add(api);
  }

  async function call(method: string, params: Json = {}, deviceId = "device-A"): Promise<Answer> {
    const entry = methods.get(`clawtrate-tool-rules.${method}`);
    if (!entry) throw new Error(`no method ${method}`);
    let out: Answer | undefined;
    await entry.handler({
      params,
      client: { connId: "conn-A", connect: { device: { id: deviceId } } },
      respond: (ok: boolean, payload?: Json, error?: Answer["error"]) => {
        out = { ok, ...(payload ? { payload } : {}), ...(error ? { error } : {}) };
      },
    });
    return out ?? { ok: false, error: { code: "NONE", message: "no response" } };
  }

  /** Run the plugin's before_tool_call hook as the gateway would for one call. */
  function before(
    agentId: string | undefined,
    toolName: string,
    params: Json = {},
    ids: { runId?: string; toolCallId?: string; sessionKey?: string } = {},
  ): HookResult | undefined {
    const hook = hooks.find((h) => h.name === "before_tool_call");
    if (!hook) throw new Error("no before_tool_call hook");
    const runId = ids.runId ?? "run-1";
    const toolCallId = ids.toolCallId ?? "call-1";
    return hook.fn(
      { toolName, params, runId, toolCallId },
      {
        toolName,
        ...(agentId ? { agentId } : {}),
        sessionKey: ids.sessionKey ?? `agent:${agentId ?? "none"}:main`,
        runId,
        toolCallId,
      },
    ) as HookResult | undefined;
  }

  /** Save a scope's rules as an admin would, reading its version first. */
  async function save(scope: string, rules: Json[], fallback = false): Promise<Answer> {
    const got = await call("get", { scope });
    const version = Number(
      ((got.payload?.scopes as Json | undefined)?.[scope] as Json | undefined)?.version ?? 0,
    );
    return call("set", { scope, rules, fallback, expectedVersion: version });
  }

  return {
    handle,
    methods,
    hooks,
    services,
    events,
    warnings,
    infos,
    call,
    before,
    save,
    stop: () => {
      services.forEach((service) => service.stop());
      running.delete(api);
    },
  };
}
