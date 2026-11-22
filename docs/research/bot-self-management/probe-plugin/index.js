// Research probe behind docs/research/bot-self-management.md. Not product code.
//
// It answers four questions about OpenClaw 2026.10.6 from inside a plugin:
//   1. What a plugin tool knows about who called it (agent, session, owner bit,
//      the admitted operator's scopes), and whether it can reach a gateway
//      method from there (callGatewayTool, api.runtime.gateway.request).
//   2. Whether a plugin RPC method can call agents.update with its caller's
//      own authority (dispatchGatewayMethod), and nothing more.
//   3. Whether a plugin can run a completion with no tools (api.runtime.llm).
//   4. Whether a plugin can keep records of its own (api.runtime.state).
//
// It is copied into plugins/ only for a run on a named development instance.

import {
  callGatewayTool,
  readGatewayToolOperatorScopes,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";

const ID = "clawtrate-bots-probe";
const records = [];

const settle = async (run) => {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 400) };
  }
};

const roster = (value) =>
  Array.isArray(value?.agents)
    ? value.agents.map((agent) => ({ id: agent.id, name: agent.name ?? agent.identity?.name }))
    : value;

export default {
  id: ID,
  name: "Clawtrate bots probe",
  description: "Research probe: tool context, gateway authority, tool-free completion, state.",
  register(api) {
    let store;
    const state = () =>
      (store ??= api.runtime.state.openKeyedStore({
        namespace: "probe",
        maxEntries: 50,
        defaultTtlMs: 60 * 60_000,
      }));

    api.registerTool(
      {
        contextVersion: 2,
        create(ctx) {
          return {
            name: "clawtrate_probe_self",
            label: "Probe self",
            description: "Research probe. Records the call's context and tries agents.update.",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                target: { type: "string" },
                writes: { type: "boolean" },
              },
            },
            async execute(_toolCallId, params) {
              const target = typeof params?.target === "string" ? params.target : ctx.agentId;
              const record = {
                at: Date.now(),
                context: {
                  agentId: ctx.agentId ?? null,
                  sessionKey: ctx.sessionKey ?? null,
                  messageChannel: ctx.messageChannel ?? null,
                  senderIsOwner: ctx.senderIsOwner ?? null,
                  requesterSenderId: ctx.requesterSenderId ?? null,
                  keys: Object.keys(ctx).sort(),
                },
                operatorScopes: await settle(() => readGatewayToolOperatorScopes() ?? null),
                runtimeGatewayRequest: await settle(async () =>
                  roster(await api.runtime.gateway.request("agents.list", {})),
                ),
                callGatewayToolList: await settle(async () =>
                  roster(await callGatewayTool("agents.list", {}, {})),
                ),
                callGatewayToolUpdate:
                  typeof params?.name === "string"
                    ? await settle(() =>
                        callGatewayTool("agents.update", {}, { agentId: target, name: params.name }),
                      )
                    : null,
                target,
                // The other writes the contract needs, each through the same route.
                writes:
                  params?.writes === true
                    ? {
                        label: await settle(async () => {
                          const cfg = await callGatewayTool("config.get", {}, {});
                          const raw = JSON.stringify({
                            agents: { entries: { [target]: { identity: { theme: "Probe label" } } } },
                          });
                          return callGatewayTool("config.patch", {}, { raw, baseHash: cfg.hash });
                        }),
                        files: await settle(() =>
                          callGatewayTool("agents.files.set", {}, {
                            agentId: target,
                            name: "SOUL.md",
                            content: "Probe soul.\n",
                          }),
                        ),
                        create: await settle(() =>
                          callGatewayTool("agents.create", {}, {
                            name: "Probe Child",
                            workspace: `${ctx.workspaceDir}/../probe-child`,
                          }),
                        ),
                      }
                    : null,
                stateWrite: await settle(() => state().register(`tool:${Date.now()}`, { ok: 1 })),
              };
              records.push(record);
              const text = JSON.stringify(record);
              return { content: [{ type: "text", text }], details: { probe: record } };
            },
          };
        },
      },
      { name: "clawtrate_probe_self" },
    );

    api.registerGatewayMethod(
      `${ID}.results`,
      ({ respond }) => respond(true, { records }),
      { scope: "operator.read" },
    );

    // Registered at read on purpose: the nested call must still need admin.
    api.registerGatewayMethod(
      `${ID}.update`,
      async ({ params, respond }) => {
        const result = await settle(() =>
          dispatchGatewayMethod("agents.update", { agentId: params.agentId, name: params.name }),
        );
        respond(true, { result });
      },
      { scope: "operator.read" },
    );

    api.registerGatewayMethod(
      `${ID}.describe`,
      async ({ params, respond }) => {
        const message = {
          role: "user",
          content: `Reply with JSON only. description: ${JSON.stringify(String(params.words ?? ""))}`,
        };
        const base = {
          messages: [message],
          purpose: `${ID}.describe`,
          maxTokens: 256,
          ...(typeof params.agentId === "string" ? { agentId: params.agentId } : {}),
        };
        const direct = await settle(() => api.runtime.llm.complete(base));
        const isolated = await settle(() =>
          api.runtime.llm.complete({
            ...base,
            systemPrompt: "You are a JSON-only function.",
            execution: { mode: "isolated-agent-runtime", timeoutMs: 30_000 },
          }),
        );
        const brief = (r) =>
          r.ok
            ? {
                ok: true,
                text: String(r.value?.text ?? "").slice(0, 200),
                keys: Object.keys(r.value ?? {}).sort(),
                provider: r.value?.provider ?? null,
                model: r.value?.model ?? null,
                agentId: r.value?.agentId ?? null,
                execution: r.value?.execution ?? null,
              }
            : r;
        respond(true, { direct: brief(direct), isolated: brief(isolated) });
      },
      { scope: "operator.admin" },
    );

    api.registerGatewayMethod(
      `${ID}.state`,
      async ({ respond }) => {
        const s = state();
        const wrote = await settle(() => s.register("rpc", { at: Date.now() }));
        const read = await settle(() => s.lookup("rpc"));
        const count = await settle(() => (s.count ? s.count() : null));
        respond(true, { wrote, read, count });
      },
      { scope: "operator.admin" },
    );
  },
};
