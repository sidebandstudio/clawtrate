// Research plugin for docs/research/drafts-and-vault.md. Development instances
// only: it is installed with `openclaw --profile clawtrate-dev-<name> plugins
// install --link` into a named instance started by `pnpm dev-gateway`, and
// never anywhere else.
//
// It adds two stand-in send tools that send nothing: each returns exactly the
// arguments it received, and the size and SHA-256 of each attached file as it
// read them when it ran. A `before_tool_call` hook, switched by the `mode`
// method, rewrites their arguments, holds them with `requireApproval`, or
// mutates its own returned arguments after the hold. A trusted tool policy
// holds a call and an ordinary hook then rechecks the attached files after the
// answer. `after_tool_call` keeps what the tools received. Nothing is written
// to disk; the log lives in memory and holds only these tools' own arguments.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ID = "clawtrate-drafts-probe";
const SEND_TOOLS = ["probe_send_email", "probe_send_slack_message"];
const MODES = ["off", "rewrite", "hold", "hold-mutate", "trusted"];
const LOG_LIMIT = 50;

// The gateway can evaluate this module more than once (each registry it
// builds loads the plugin again), so the hook, the tools and the methods may
// come from different evaluations. Their state lives in one shared object.
const state = (globalThis[Symbol.for(`${ID}.state`)] ??= { mode: "off", log: [], held: new Map() });
const log = state.log;
const held = state.held; // toolCallId -> { returned, hashes }

const record = (entry) => {
  log.push({ at: Date.now(), ...entry });
  if (log.length > LOG_LIMIT) log.shift();
};

function workspaceOf(api, agentId) {
  try {
    return api.runtime?.agent?.resolveAgentWorkspaceDir?.(api.config, agentId) ?? null;
  } catch {
    return null;
  }
}

async function hashAttachments(api, agentId, attachments) {
  const root = workspaceOf(api, agentId);
  const list = Array.isArray(attachments) ? attachments : [];
  const out = [];
  for (const rel of list) {
    if (typeof rel !== "string" || !root) {
      out.push({ path: String(rel), error: "no workspace" });
      continue;
    }
    const full = path.resolve(root, rel);
    if (!full.startsWith(root + path.sep)) {
      out.push({ path: rel, error: "outside the workspace" });
      continue;
    }
    try {
      const bytes = await readFile(full);
      out.push({ path: rel, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    } catch (error) {
      out.push({ path: rel, error: String(error?.code ?? error) });
    }
  }
  return out;
}

const sameHashes = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const emailSchema = {
  type: "object",
  additionalProperties: false,
  required: ["to", "subject", "body"],
  properties: {
    from: { type: "string" },
    to: { type: "array", items: { type: "string" } },
    cc: { type: "array", items: { type: "string" } },
    subject: { type: "string" },
    body: { type: "string" },
    attachments: { type: "array", items: { type: "string" } },
  },
};

const slackSchema = {
  type: "object",
  additionalProperties: false,
  required: ["workspace", "to", "text"],
  properties: {
    workspace: { type: "string" },
    to: { type: "string" },
    thread: { type: "string" },
    text: { type: "string" },
  },
};

function standIn(api, name, description, parameters) {
  return (toolContext) => ({
    name,
    description,
    parameters,
    async execute(toolCallId, params) {
      const agentId = toolContext?.agentId ?? null;
      const attachments = await hashAttachments(api, agentId, params?.attachments);
      const received = JSON.parse(JSON.stringify(params ?? {}));
      record({ kind: "executed", tool: name, toolCallId, agentId, received, attachments });
      return {
        content: [{ type: "text", text: `Stand-in: nothing was sent. Received ${JSON.stringify(received)}` }],
        details: { standIn: true, sent: false, received, attachments },
      };
    },
  });
}

export default {
  id: ID,
  name: "Clawtrate drafts probe",
  description: "Research only: stand-in send tools and a before_tool_call hook for the drafts design.",
  register(api) {
    api.registerTool(standIn(api, "probe_send_email", "Stand-in: pretends to send an email. Sends nothing.", emailSchema), {
      name: "probe_send_email",
    });
    api.registerTool(
      standIn(api, "probe_send_slack_message", "Stand-in: pretends to post a Slack message. Sends nothing.", slackSchema),
      { name: "probe_send_slack_message" },
    );

    api.registerTrustedToolPolicy?.({
      id: "hold-recheck",
      description: "Research: hold a stand-in send, then let the ordinary hook recheck attachments.",
      matcher: SEND_TOOLS,
      async evaluate(event, ctx) {
        if (state.mode !== "trusted") return undefined;
        const hashes = await hashAttachments(api, ctx.agentId, event.params?.attachments);
        held.set(event.toolCallId, { returned: null, hashes });
        record({ kind: "trusted-held", tool: event.toolName, toolCallId: event.toolCallId, hashes });
        return {
          requireApproval: {
            title: "Send this draft?",
            description: `Research hold of ${event.toolName}`,
            timeoutMs: 600000,
            allowedDecisions: ["allow-once", "deny"],
            pluginId: ID,
          },
        };
      },
    });

    api.on(
      "before_tool_call",
      async (event, ctx) => {
        if (![...SEND_TOOLS, "write"].includes(event.toolName)) return undefined;
        record({
          kind: "hook",
          mode: state.mode,
          tool: event.toolName,
          toolCallId: event.toolCallId,
          eventKeys: Object.keys(event).sort(),
          ctxKeys: Object.keys(ctx ?? {}).sort(),
          agentId: ctx?.agentId,
          toolOwnerPluginId: ctx?.toolOwnerPluginId ?? null,
          params: SEND_TOOLS.includes(event.toolName) ? event.params : { keys: Object.keys(event.params ?? {}) },
        });
        if (state.mode === "off") return undefined;
        if (state.mode === "rewrite") {
          const key = event.toolName === "probe_send_slack_message" ? "text" : event.toolName === "write" ? "content" : "body";
          return { params: { ...event.params, [key]: "REWRITTEN BY THE HOOK" } };
        }
        if (state.mode === "hold" || state.mode === "hold-mutate") {
          const hashes = await hashAttachments(api, ctx?.agentId, event.params?.attachments);
          const returned = JSON.parse(JSON.stringify(event.params ?? {}));
          held.set(event.toolCallId, { returned, hashes });
          return {
            params: returned,
            requireApproval: {
              title: "Send this draft?",
              description: `Research hold of ${event.toolName}`,
              timeoutMs: 600000,
              allowedDecisions: ["allow-once", "deny"],
              onResolution: (decision) => record({ kind: "resolution", toolCallId: event.toolCallId, decision }),
            },
          };
        }
        if (state.mode === "trusted") {
          // Runs after the trusted policy's approval was answered.
          const before = held.get(event.toolCallId)?.hashes;
          const now = await hashAttachments(api, ctx?.agentId, event.params?.attachments);
          record({ kind: "recheck", toolCallId: event.toolCallId, before, now });
          if (before && !sameHashes(before, now)) {
            return { block: true, blockReason: "An attached file changed after the draft was shown. Nothing was sent." };
          }
        }
        return undefined;
      },
    );

    api.on(
      "after_tool_call",
      (event) => {
        if (![...SEND_TOOLS, "write"].includes(event.toolName)) return;
        record({
          kind: "after",
          tool: event.toolName,
          toolCallId: event.toolCallId,
          params: SEND_TOOLS.includes(event.toolName) ? event.params : { keys: Object.keys(event.params ?? {}) },
          error: event.error ?? null,
        });
      },
    );

    api.registerGatewayMethod(
      `${ID}.mode`,
      ({ params, respond }) => {
        if (params?.mode !== undefined) {
          if (!MODES.includes(params.mode)) return respond(false, { error: `mode must be one of ${MODES.join(", ")}` });
          state.mode = params.mode;
        }
        respond(true, { mode: state.mode });
      },
      { scope: "operator.admin" },
    );

    // Mutate the arguments object this plugin returned with its hold, after
    // the hold, to see whether the gateway kept a copy.
    api.registerGatewayMethod(
      `${ID}.mutate`,
      ({ params, respond }) => {
        const entry = held.get(params?.toolCallId);
        if (!entry?.returned) return respond(false, { error: "no held call with that id" });
        const key = "body" in entry.returned ? "body" : "text" in entry.returned ? "text" : "content";
        entry.returned[key] = String(params?.value ?? "EDITED AFTER THE HOLD");
        respond(true, { mutated: key });
      },
      { scope: "operator.admin" },
    );

    api.registerGatewayMethod(`${ID}.log`, ({ respond }) => respond(true, { mode: state.mode, log }), {
      scope: "operator.admin",
    });

    // Diagnostics: which typed hooks the gateway's global hook runner sees.
    api.registerGatewayMethod(
      `${ID}.hooks`,
      async ({ respond }) => {
        try {
          const mod = await import("/opt/homebrew/lib/node_modules/openclaw/dist/hook-runner-global-CS_Svhrc.mjs").catch(() => null);
          const reg = mod?.c?.();
          respond(true, {
            loaded: Boolean(mod),
            hasBefore: mod?.n?.()?.hasHooks?.("before_tool_call") ?? null,
            typedHooks: (reg?.typedHooks ?? []).map((h) => `${h.pluginId}:${h.hookName}`),
          });
        } catch (error) {
          respond(true, { error: String(error) });
        }
      },
      { scope: "operator.admin" },
    );
  },
};
