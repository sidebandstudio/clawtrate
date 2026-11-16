#!/usr/bin/env node
// Seed a development gateway with bots, instructions and transcripts.
// Uses the trusted loopback backend identity (client id "gateway-client",
// mode "backend", shared token, no device), so it only works on loopback.
//
// Usage (from a folder where @openclaw/gateway-client@2026.10.6 is installed):
//   OPENCLAW_DEV_URL=ws://127.0.0.1:19101 OPENCLAW_DEV_TOKEN=<dev token> node seed.mjs
//
// Needs the scripted fake provider (fake-openai.mjs) running, because the
// "send" steps start real runs against it.

import { GatewayClient } from "@openclaw/gateway-client";
import crypto from "node:crypto";

const url = process.env.OPENCLAW_DEV_URL ?? "ws://127.0.0.1:19101";
const token = process.env.OPENCLAW_DEV_TOKEN;
if (!token) throw new Error("set OPENCLAW_DEV_TOKEN to the development gateway token");

const BOTS = [
  { name: "Atlas", emoji: "🧭", soul: "You are Atlas, a careful research assistant. Cite sources." },
  { name: "Pixel", emoji: "🎨", soul: "You are Pixel, a design helper. Keep answers short." },
  { name: "Ledger", emoji: "📒", soul: "You are Ledger. You track tasks and deadlines." },
];

// Each entry becomes a task (session) under the bot. "send" starts a run on
// the fake model; "inject" writes an assistant row without a model call.
const TASKS = {
  Atlas: [
    { label: "Laptop comparison", steps: [{ send: "Compare three light laptops" }, { inject: "Shortlist saved." }] },
    { label: "Workspace listing", steps: [{ send: '#tool ls {"path":"."}' }] },
  ],
  Pixel: [{ label: "Ask Atlas", steps: [{ send: "#ask agent:atlas:main Which laptop is lightest?" }] }],
  Ledger: [{ label: "Weekly plan", steps: [{ send: "Plan my week" }] }],
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
const call = (method, params) => client.request(method, params, { timeoutMs: 60_000 });

const existing = new Map((await call("agents.list", {})).agents.map((a) => [a.name, a.id]));
for (const bot of BOTS) {
  const agentId = existing.get(bot.name) ?? (await call("agents.create", { name: bot.name, emoji: bot.emoji })).agentId;
  await call("agents.files.set", { agentId, name: "SOUL.md", content: bot.soul + "\n" });
  for (const task of TASKS[bot.name] ?? []) {
    const first = task.steps[0];
    const created = await call("sessions.create", {
      agentId,
      label: task.label,
      ...(first.send ? { message: first.send } : {}),
    });
    for (const step of task.steps.slice(first.send ? 1 : 0)) {
      if (step.inject) await call("chat.inject", { sessionKey: created.key, message: step.inject });
      if (step.send) {
        await call("chat.send", { sessionKey: created.key, message: step.send, idempotencyKey: crypto.randomUUID() });
      }
    }
    console.log(`${bot.name}: ${task.label} -> ${created.key}`);
  }
}
await client.stopAndWait();
