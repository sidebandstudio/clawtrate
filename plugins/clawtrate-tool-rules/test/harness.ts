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
    pluginId?: string;
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
 * `on: false` leaves the hook API out, as a load without hooks would;
 * `trusted: false` leaves out trusted tool policies, as a host without them
 * would, and `trusted: "refused"` takes the registration and never runs it,
 * as OpenClaw does (with a diagnostic, no throw) for a plugin not explicitly
 * enabled.
 */
export function load(
  options: {
    stateDir: string;
    slots?: Map<unknown, unknown>;
    on?: boolean;
    trusted?: boolean | "refused";
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
  const policies: {
    id: string;
    description: string;
    matcher?: unknown;
    evaluate: (event: Json, ctx: Json) => unknown;
  }[] = [];
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
  if (options.trusted !== false) {
    api.registerTrustedToolPolicy = (policy: (typeof policies)[number]) => {
      if (options.trusted !== "refused") policies.push(policy);
    };
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

  type Ids = { runId?: string; toolCallId?: string; sessionKey?: string };
  const callOf = (agentId: string | undefined, toolName: string, params: Json, ids: Ids) => {
    const runId = ids.runId ?? "run-1";
    const toolCallId = ids.toolCallId ?? "call-1";
    return {
      event: { toolName, params, runId, toolCallId },
      ctx: {
        toolName,
        ...(agentId ? { agentId } : {}),
        sessionKey: ids.sessionKey ?? `agent:${agentId ?? "none"}:main`,
        runId,
        toolCallId,
      },
    };
  };
  const hook = (name: string) => {
    const found = hooks.find((h) => h.name === name);
    if (!found) throw new Error(`no ${name} hook`);
    return found;
  };

  /**
   * Decide one call as the gateway would before asking: the trusted policies
   * first, then, when none decided, the before_tool_call hooks.
   */
  function before(
    agentId: string | undefined,
    toolName: string,
    params: Json = {},
    ids: Ids = {},
  ): HookResult | undefined {
    const { event, ctx } = callOf(agentId, toolName, params, ids);
    for (const policy of policies) {
      const decided = policy.evaluate(event, ctx) as HookResult | undefined;
      if (decided) return decided;
    }
    return hook("before_tool_call").fn(event, ctx) as HookResult | undefined;
  }

  /**
   * A card answered: the answer to the plugin, then, for Allow once, the
   * before_tool_call hooks the gateway runs after a trusted policy's card.
   */
  function answer(
    card: HookResult | undefined,
    decision: string,
    agentId: string | undefined,
    toolName: string,
    params: Json = {},
    ids: Ids = {},
  ): HookResult | undefined {
    if (!card?.requireApproval) throw new Error("no card to answer");
    card.requireApproval.onResolution?.(decision);
    if (decision !== "allow-once") return undefined;
    const { event, ctx } = callOf(agentId, toolName, params, ids);
    return hook("before_tool_call").fn(event, ctx) as HookResult | undefined;
  }

  /** A message written to a task, as the gateway tells before_message_write. */
  function write(sessionKey: string, message: Json): void {
    hook("before_message_write").fn({ message }, { sessionKey });
  }

  /** A run's model call, as the gateway tells model_call_started. */
  function modelCall(runId: string, sessionKey: string): void {
    hook("model_call_started").fn({ runId, sessionKey }, { runId, sessionKey });
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
    policies,
    services,
    events,
    warnings,
    infos,
    call,
    before,
    answer,
    write,
    modelCall,
    save,
    stop: () => {
      services.forEach((service) => service.stop());
      running.delete(api);
    },
  };
}
