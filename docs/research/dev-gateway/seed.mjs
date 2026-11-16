#!/usr/bin/env node
// Seed a development gateway with bots, instructions and transcripts, then
// verify the result. Exits non-zero if any run fails or a transcript is not
// what the script expects.
//
// Uses the trusted loopback backend identity (client id "gateway-client",
// mode "backend", shared token, no device), so it only works on loopback.
//
// Usage (from a folder where @openclaw/gateway-client@2026.10.6 is installed):
//   OPENCLAW_DEV_URL=ws://127.0.0.1:19101 OPENCLAW_DEV_TOKEN=<dev token> node seed.mjs
//
// Run it against a fresh profile. Session labels must be unique, so a second
// run needs SEED_LABEL_SUFFIX set (for example " (2)").
//
// Needs the scripted fake provider (fake-openai.mjs) and, for the coding-agent
// task, the fake MCP server configured as mcp.servers.coder.

import { GatewayClient } from "@openclaw/gateway-client";
import crypto from "node:crypto";

const url = process.env.OPENCLAW_DEV_URL ?? "ws://127.0.0.1:19101";
const token = process.env.OPENCLAW_DEV_TOKEN;
const suffix = process.env.SEED_LABEL_SUFFIX ?? "";
if (!token) throw new Error("set OPENCLAW_DEV_TOKEN to the development gateway token");

const BOTS = [
  { name: "Atlas", emoji: "🧭", soul: "You are Atlas, a careful research assistant. Cite sources." },
  { name: "Pixel", emoji: "🎨", soul: "You are Pixel, a design helper. Keep answers short." },
  { name: "Ledger", emoji: "📒", soul: "You are Ledger. You track tasks and deadlines." },
];

// Each task becomes a session under the bot. A "send" step starts a run on the
// fake model and waits for its terminal outcome; "expect" checks the history
// after the step. An "inject" step writes an assistant row without a model call.
const TASKS = {
  Atlas: [
    {
      label: "Laptop comparison",
      steps: [
        { send: "Compare three light laptops", expect: { assistantText: "Echo: Compare three light laptops" } },
        { inject: "Shortlist saved.", expect: { assistantText: "Shortlist saved." } },
      ],
    },
    { label: "Workspace listing", steps: [{ send: '#tool ls {"path":"."}', expect: { toolResult: "ls" } }] },
    {
      label: "Hand off to the coding agent",
      steps: [
        {
          send: '#tool coder__send_message {"message":"Add a dark mode toggle"}',
          expect: { toolResult: "coder__send_message", resultIncludes: "Scripted coding agent received" },
        },
      ],
    },
  ],
  Pixel: [
    {
      label: "Ask Atlas",
      steps: [
        {
          send: "#ask agent:atlas:main Which laptop is lightest?",
          expect: { toolResult: "sessions_send", resultIncludes: '"status": "ok"' },
        },
      ],
    },
  ],
  Ledger: [{ label: "Weekly plan", steps: [{ send: "Plan my week", expect: { assistantText: "Echo: Plan my week" } }] }],
};

const client = await new Promise((resolve, reject) => {
  const c = new GatewayClient({
    url,
    token,
    clientName: "gateway-client",
    mode: "backend",
    clientVersion: "0.0.1",
    platform: process.platform,
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
    minProtocol: 4,
    maxProtocol: 4,
    onHelloOk: () => resolve(c),
    onConnectError: reject,
  });
  c.start();
});
const call = (method, params, timeoutMs = 60_000) => client.request(method, params, { timeoutMs });

async function waitForRun(runId, label) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const r = await call("agent.wait", { runId, timeoutMs: 30_000 }, 40_000);
    if (r.status === "ok") return r;
    if (r.status !== "pending" && r.status !== "timeout") {
      throw new Error(`${label}: run ${runId} ended with ${r.status}: ${r.error ?? r.stopReason ?? ""}`);
    }
    if (Date.now() > deadline) throw new Error(`${label}: run ${runId} did not finish`);
  }
}

const textOf = (m) =>
  typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").join("");

async function verify(sessionKey, expect, label) {
  const { messages } = await call("chat.history", { sessionKey, limit: 50 });
  if (expect.assistantText && !messages.some((m) => m.role === "assistant" && textOf(m).includes(expect.assistantText))) {
    throw new Error(`${label}: no assistant row containing ${JSON.stringify(expect.assistantText)}`);
  }
  if (expect.toolResult) {
    const row = messages.find((m) => m.role === "toolResult" && m.toolName === expect.toolResult);
    if (!row || row.isError) throw new Error(`${label}: missing or failed ${expect.toolResult} result`);
    if (expect.resultIncludes && !textOf(row).includes(expect.resultIncludes)) {
      throw new Error(`${label}: ${expect.toolResult} result lacks ${JSON.stringify(expect.resultIncludes)}`);
    }
  }
}

const existing = new Map((await call("agents.list", {})).agents.map((a) => [a.name, a.id]));
for (const bot of BOTS) {
  const agentId = existing.get(bot.name) ?? (await call("agents.create", { name: bot.name, emoji: bot.emoji })).agentId;
  await call("agents.files.set", { agentId, name: "SOUL.md", content: bot.soul + "\n" });
  for (const task of TASKS[bot.name] ?? []) {
    const label = `${bot.name} / ${task.label}`;
    const [first, ...rest] = task.steps;
    const created = await call("sessions.create", { agentId, label: task.label + suffix, ...(first.send ? { message: first.send } : {}) });
    if (created.runError) throw new Error(`${label}: ${created.runError.code} ${created.runError.message}`);
    const sessionKey = created.key;
    const steps = first.send ? rest : task.steps;
    if (first.send) {
      if (!created.runId) throw new Error(`${label}: sessions.create started no run`);
      await waitForRun(created.runId, label);
      await verify(sessionKey, first.expect ?? {}, label);
    }
    for (const step of steps) {
      if (step.inject) await call("chat.inject", { sessionKey, message: step.inject });
      if (step.send) {
        const sent = await call("chat.send", { sessionKey, message: step.send, idempotencyKey: crypto.randomUUID() });
        await waitForRun(sent.runId, label);
      }
      await verify(sessionKey, step.expect ?? {}, label);
    }
    console.log(`ok  ${label} -> ${sessionKey}`);
  }
}
await client.stopAndWait();
