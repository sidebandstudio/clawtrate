// Research probes for docs/research/drafts-and-vault.md. Each scenario prints
// what it saw and asserts nothing. Run against a named instance this checkout
// started, with ../drafts-probe-plugin installed on it and the research model
// set up as that note says:
//
//   node docs/research/dev-gateway/drafts-probe/probe.ts <instance> <scenario>
//
// It refuses the default instance. Every value it submits is made up.
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { openInstance, openOperator } from "../../../../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../../../../tools/dev-gateway/src/operator.ts";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const out = (label: string, value: unknown) => console.log(`${label}: ${JSON.stringify(value)}`);

const [name, scenario] = process.argv.slice(2);
if (!name || name === "default" || !scenario) {
  console.error("usage: probe.ts <named instance> <scenario>");
  process.exit(2);
}
const inst = openInstance(name);
const PLUGIN = "clawtrate-drafts-probe";
const ALL = ["operator.read", "operator.write", "operator.approvals", "operator.questions", "operator.admin"];
// Without "plugin-approvals" the gateway finds no route for a plugin hold and refuses it at once.
const CAPS = process.env.PROBE_NO_PLUGIN_CAPS ? ["tool-events"] : ["tool-events", "approvals", "exec-approvals", "plugin-approvals"];

async function task(op: OperatorSession, agentId: string, label: string): Promise<string> {
  const s = rec(await op.request("sessions.create", { agentId, label: `${label} ${Date.now()}` }));
  const key = String(s.key);
  await op.request("sessions.messages.subscribe", { key });
  return key;
}

function toolEvents(op: OperatorSession, runId: string) {
  return op
    .runEvents(runId)
    .filter((e) => e.event === "agent" && rec(e.payload).stream === "tool")
    .map((e) => {
      const d = rec(rec(e.payload).data);
      return { phase: d.phase, name: d.name, args: d.args, result: d.result, isError: d.isError };
    });
}

async function pluginLog(op: OperatorSession) {
  return rec(await op.request(`${PLUGIN}.log`, {})).log as Rec[];
}

const email = (extra: Rec = {}) => ({
  from: "otto@example.com",
  to: ["dana@example.com"],
  cc: ["lee@example.org"],
  subject: "Media box report",
  body: "The disk is 91% full. I moved last month's logs to archive/.",
  ...extra,
});

async function sendTool(op: OperatorSession, key: string, tool: string, args: Rec) {
  const sent = rec(await op.send(key, `#tool ${tool} ${JSON.stringify(args)}`));
  return String(sent.runId);
}

async function waitApproval(op: OperatorSession, after: number) {
  const ev = await op.waitFor("plugin.approval.requested", (e) => e.event === "plugin.approval.requested", 60_000, after);
  return rec(ev.payload);
}

async function workspace(agentId: string): Promise<string> {
  return path.join(inst.stateDir, "workspaces", agentId);
}

const scenarios: Record<string, (op: OperatorSession) => Promise<void>> = {
  async methods(op) {
    const hello = rec(await op.request("status", {}).catch(() => ({})));
    out("status keys", Object.keys(hello));
    const cat = rec(await op.request("tools.catalog", { agentId: "pip" }));
    out("catalog (probe tools)", JSON.stringify(cat).match(/probe_send_[a-z_]+[^}]{0,200}/g));
  },

  async rewrite(op) {
    await op.request(`${PLUGIN}.mode`, { mode: "rewrite" });
    const key = await task(op, "pip", "rewrite");
    const runId = await sendTool(op, key, "probe_send_email", email());
    await op.terminal(runId);
    out("tool events", toolEvents(op, runId));
    out("plugin log", (await pluginLog(op)).filter((r) => r.kind !== "hook" || r.tool === "probe_send_email"));
    const hist = JSON.stringify(await op.request("chat.history", { sessionKey: key, limit: 20 }));
    out("history has original body", hist.includes("The disk is 91% full"));
    out("history has rewritten body", hist.includes("REWRITTEN BY THE HOOK"));
  },

  async "rewrite-write"(op) {
    // A gateway-native tool on the development model: #write writes notes/scratch.md.
    await op.request(`${PLUGIN}.mode`, { mode: "rewrite" });
    const key = await task(op, "main", "rewrite write");
    const runId = String(rec(await op.send(key, "#write")).runId);
    await op.terminal(runId);
    out("tool events", toolEvents(op, runId));
    const file = await readFile(path.join(inst.stateDir, "workspace", "notes", "scratch.md"), "utf8").catch((e) => `unreadable: ${e}`);
    out("notes/scratch.md on disk", file);
  },

  async "hold-allow"(op) {
    await op.request(`${PLUGIN}.mode`, { mode: "hold" });
    const key = await task(op, "pip", "hold allow");
    const after = op.lastSeq;
    const runId = await sendTool(op, key, "probe_send_email", email());
    const req = await waitApproval(op, after);
    out("plugin.approval.requested payload", req);
    out("tool events before the answer", toolEvents(op, runId));
    const list = await op.request("plugin.approval.list", {}).catch((e: Error) => e.message);
    out("plugin.approval.list", list);
    out("resolve", await op.request("plugin.approval.resolve", { id: req.id, decision: "allow-once" }));
    await op.terminal(runId);
    out("tool events", toolEvents(op, runId));
    out("plugin log", (await pluginLog(op)).filter((r) => r.kind === "executed" || r.kind === "resolution" || r.kind === "after").slice(-3));
  },

  async "hold-deny"(op) {
    await op.request(`${PLUGIN}.mode`, { mode: "hold" });
    const key = await task(op, "pip", "hold deny");
    const after = op.lastSeq;
    const runId = await sendTool(op, key, "probe_send_slack_message", {
      workspace: "Example Co",
      to: "#ops",
      thread: "Disk alerts",
      text: "Media box disk at 91%.",
    });
    const req = await waitApproval(op, after);
    out("plugin.approval.requested payload", req);
    out("resolve", await op.request("plugin.approval.resolve", { id: req.id, decision: "deny" }));
    await op.terminal(runId);
    out("tool events", toolEvents(op, runId));
    out("executed records for this call", (await pluginLog(op)).filter((r) => r.kind === "executed" && r.tool === "probe_send_slack_message"));
  },

  async "hold-mutate"(op) {
    await op.request(`${PLUGIN}.mode`, { mode: "hold-mutate" });
    const key = await task(op, "pip", "hold mutate");
    const after = op.lastSeq;
    const runId = await sendTool(op, key, "probe_send_email", email());
    const req = await waitApproval(op, after);
    const callId = String(req.toolCallId ?? rec(req.request).toolCallId ?? "");
    out("toolCallId from the request", callId);
    out("mutate", await op.request(`${PLUGIN}.mutate`, { toolCallId: callId, value: "EDITED AFTER THE HOLD" }).catch((e: Error) => e.message));
    out("resolve", await op.request("plugin.approval.resolve", { id: req.id, decision: "allow-once" }));
    await op.terminal(runId);
    out("what the tool received", (await pluginLog(op)).filter((r) => r.kind === "executed").slice(-1));
  },

  async "file-hold"(op) {
    await fileScenario(op, "hold", true);
  },
  async "file-trusted"(op) {
    await fileScenario(op, "trusted", true);
  },
  async "file-trusted-unchanged"(op) {
    await fileScenario(op, "trusted", false);
  },

  async secrets(op) {
    const NAME = `D8_EXAMPLE_TOKEN_${randomUUID().slice(0, 6).toUpperCase().replace(/-/g, "")}`;
    const VALUE = `example-secret-value-${randomUUID()}`;
    out("entry name", NAME);
    out("made-up value (example)", VALUE);
    const key = await task(op, "pip", "secret request");
    const after = op.lastSeq;
    const runId = await sendTool(op, key, "secrets", {
      action: "request",
      name: NAME,
      reason: "Research: a made-up token",
      allowedHosts: ["api.example.com"],
    });
    const ev = await op.waitFor("question.requested", (e) => e.event === "question.requested", 60_000, after);
    const q = rec(ev.payload);
    const q0 = rec((q.questions as unknown[])[0]);
    out("question.requested payload", q);
    const answer = await op.request("question.resolve", {
      id: q.id,
      answers: { answers: { [String(q0.questionId)]: [VALUE] } },
      secretStoreAllowedHosts: ["api.example.com"],
    });
    out("question.resolve answered", answer);
    const fin = await op.terminal(runId).catch((e: Error) => ({ state: e.message }));
    out("run", rec(fin).state);
    out("tool events", toolEvents(op, runId));
    const hist = JSON.stringify(await op.request("chat.history", { sessionKey: key, limit: 50 }));
    out("value in any event this client received", JSON.stringify(op.events).includes(VALUE));
    out("value in chat.history", hist.includes(VALUE));
    out("name in chat.history", hist.includes(NAME));
    const listed = rec(await op.request("secrets.store.list", {}));
    out("secrets.store.list (this entry)", (listed.entries as Rec[] | undefined)?.filter((e) => e.name === NAME));
    out("value in secrets.store.list", JSON.stringify(listed).includes(VALUE));
    // Another bot, through the bot's own tool.
    const other = await task(op, "marlow", "secret list");
    const lr = await sendTool(op, other, "secrets", { action: "list" });
    await op.terminal(lr);
    const le = toolEvents(op, lr);
    out("Marlow's secrets list sees the entry", JSON.stringify(le).includes(NAME));
    out("Marlow's secrets list shows the value", JSON.stringify(le).includes(VALUE));
    out("Marlow's list result", le.filter((e) => e.phase === "result"));
    await writeFile(path.join(process.env.PROBE_OUT ?? ".", "secret-probe.json"), JSON.stringify({ NAME, VALUE }));
  },

  // Round 1: can a person's edit reach the tool? A trusted-tier hold; the edit
  // delivered through the plugin's own method before the answer; then the
  // ordinary hook, running after the answer, returns the edited params, alone
  // (edit-plain) or with a second hold (edit-approve).
  async "edit-plain"(op) {
    await editScenario(op, "trusted-edit", { second: "none" });
  },
  async "edit-approve"(op) {
    await editScenario(op, "trusted-edit-approve", { second: "allow-once" });
  },
  async "edit-deny-second"(op) {
    await editScenario(op, "trusted-edit-approve", { second: "deny" });
  },
  async "edit-deny-first"(op) {
    await editScenario(op, "trusted-edit-approve", { first: "deny", second: "none" });
  },
  async "edit-readonly"(op) {
    const reader = await openOperator(inst, "Clawtrate drafts probe reader", ["operator.read"], ["tool-events"]);
    try {
      out("edit from a read-only connection", await reader.request(`${PLUGIN}.edit`, { toolCallId: "call_x", params: {} }).catch((e: Error) => `refused: ${e.message}`));
    } finally {
      await reader.close();
    }
    void op;
  },
  async "edit-restart"(op) {
    // Hold, store an edit, restart the gateway in place, then look again.
    await op.request(`${PLUGIN}.mode`, { mode: "trusted-edit-approve" });
    const key = await task(op, "pip", "edit restart");
    const after = op.lastSeq;
    const runId = await sendTool(op, key, "probe_send_email", email());
    const req = await waitApproval(op, after);
    const callId = String(rec(req.request).toolCallId);
    out("held", { id: req.id, toolCallId: callId });
    out("edit", await op.request(`${PLUGIN}.edit`, { toolCallId: callId, params: { ...email(), body: "EDITED BEFORE THE RESTART" } }));
    out("restart", rec(await op.request("gateway.restart.request", { reason: "gateway.restart", skipDeferral: true })).status);
    await new Promise((r) => setTimeout(r, 25_000));
    const again = await openOperator(inst, "Clawtrate drafts probe after restart", ALL, CAPS);
    try {
      out("approvals listed after the restart", await again.request("plugin.approval.list", {}).catch((e: Error) => e.message));
      out("the old hold answered after the restart", await again.request("plugin.approval.resolve", { id: req.id, decision: "allow-once" }).catch((e: Error) => `refused: ${e.message}`));
      out("edit for that call after the restart", await again.request(`${PLUGIN}.edit`, { toolCallId: callId, params: email() }).catch((e: Error) => `refused: ${e.message}`));
      const hist = JSON.stringify(await again.request("chat.history", { sessionKey: key, limit: 20 }));
      out("history after the restart: the edited body", hist.includes("EDITED BEFORE THE RESTART"));
      const m = hist.match(/"text":"[^"]{0,40}(Stand-in|Denied|approval|interrupt|abort)[^"]{0,160}/g);
      out("history after the restart: tool result texts", m);
      out("plugin log after the restart", ((rec(await again.request(`${PLUGIN}.log`, {})).log as Rec[]) ?? []).filter((r) => r.toolCallId === callId).map((r) => r.kind));
      void runId;
    } finally {
      await again.close();
    }
  },
  async "edit-file"(op) {
    await editScenario(op, "trusted-edit-approve", { second: "none", changeFile: true });
  },

  async "secrets-noadmin"(op) {
    // The run is started by a connection holding read, write, approvals and
    // questions (Clawtrate's interactive tier), without admin.
    const w = await openOperator(inst, "Clawtrate drafts probe interactive", ["operator.read", "operator.write", "operator.approvals", "operator.questions"], CAPS);
    try {
      const key = await task(w, "pip", "secret request without admin");
      const after = w.lastSeq;
      const runId = await sendTool(w, key, "secrets", { action: "request", name: "D8_EXAMPLE_NOADMIN", reason: "Research", allowedHosts: ["api.example.com"] });
      await w.terminal(runId);
      out("question.requested seen", w.events.some((e) => e.seq > after && e.event === "question.requested"));
      out("tool events", toolEvents(w, runId).filter((e) => e.phase === "result"));
    } finally {
      await w.close();
    }
    void op;
  },

  async store(op) {
    const NAME = `D8_EXAMPLE_STORE_${randomUUID().slice(0, 6).toUpperCase().replace(/-/g, "")}`;
    const VALUE = `example-secret-value-${randomUUID()}`;
    const entry = async () =>
      ((rec(await op.request("secrets.store.list", {})).entries as Rec[] | undefined) ?? []).filter((e) => e.name === NAME);
    out("set", await op.request("secrets.store.set", { name: NAME, value: VALUE, kind: "secret", allowedHosts: ["api.example.com"] }));
    const listed = await entry();
    out("read back", listed);
    out("value in the read back", JSON.stringify(listed).includes(VALUE));
    out("set again, other hosts", await op.request("secrets.store.set", { name: NAME, value: VALUE, kind: "secret", allowedHosts: ["api.example.net"] }));
    out("read back", await entry());
    const reader = await openOperator(inst, "Clawtrate drafts probe reader", ["operator.read", "operator.write", "operator.approvals", "operator.questions"], CAPS);
    out("list without admin", await reader.request("secrets.store.list", {}).catch((e: Error) => `refused: ${e.message}`));
    out("set without admin", await reader.request("secrets.store.set", { name: NAME, value: "example-other-value", kind: "secret" }).catch((e: Error) => `refused: ${e.message}`));
    await reader.close();
    out("delete", await op.request("secrets.store.delete", { name: NAME }));
    out("read back after delete", await entry());
    out("delete again", await op.request("secrets.store.delete", { name: NAME }).catch((e: Error) => `refused: ${e.message}`));
  },

  async "secrets-delete-by-other"(op) {
    const { NAME } = JSON.parse(await readFile(path.join(process.env.PROBE_OUT ?? ".", "secret-probe.json"), "utf8"));
    const other = await task(op, "marlow", "secret delete");
    const r = await sendTool(op, other, "secrets", { action: "delete", name: NAME });
    await op.terminal(r);
    out("Marlow's delete", toolEvents(op, r).filter((e) => e.phase === "result"));
    const listed = rec(await op.request("secrets.store.list", {}));
    out("secrets.store.list after (this entry)", (listed.entries as Rec[] | undefined)?.filter((e) => e.name === NAME));
  },
};

async function editScenario(
  op: OperatorSession,
  mode: string,
  { first = "allow-once", second, changeFile = false }: { first?: string; second: string; changeFile?: boolean },
) {
  await op.request(`${PLUGIN}.mode`, { mode });
  const dir = await workspace("pip");
  await mkdir(path.join(dir, "outbox"), { recursive: true });
  const file = path.join(dir, "outbox", "report.txt");
  await writeFile(file, "Disk report, first version.\n");
  // The edit goes in from another connection that holds approvals, not admin.
  const editor = await openOperator(inst, "Clawtrate drafts probe editor", ["operator.read", "operator.write", "operator.approvals", "operator.questions"], CAPS);
  try {
    const key = await task(op, "pip", `edit ${mode}`);
    const after = op.lastSeq;
    const original = email({ attachments: ["outbox/report.txt"] });
    const runId = await sendTool(op, key, "probe_send_email", original);
    const req = await waitApproval(op, after);
    const callId = String(rec(req.request).toolCallId);
    out("first hold", { id: req.id, title: rec(req.request).title, toolCallId: callId });
    out("editor saw the first hold", editor.events.some((e) => e.event === "plugin.approval.requested"));
    const edited = { ...original, to: ["dana@example.com", "sam@example.net"], subject: "Media box report: disk at 91%", body: "EDITED BY THE PERSON" };
    const tryEdit = (id: string, p: Rec) => editor.request(`${PLUGIN}.edit`, { toolCallId: id, params: p }).catch((e: Error) => `refused: ${e.message}`);
    out("edit for another call id", await tryEdit("call_not_held", edited));
    out("edit for this call", await tryEdit(callId, edited));
    out("a second edit for this call", await tryEdit(callId, { ...edited, body: "SECOND EDIT" }));
    if (changeFile) {
      await writeFile(file, "Disk report, CHANGED while the card waited.\n");
      out("file changed while waiting", true);
    }
    const afterFirst = op.lastSeq;
    out(`answer the first hold: ${first}`, await op.request("plugin.approval.resolve", { id: req.id, decision: first }));
    out("edit after the answer", await tryEdit(callId, { ...edited, body: "LATE EDIT" }));
    let lastHold = afterFirst;
    if (second !== "none") {
      const req2 = await waitApproval(op, afterFirst);
      lastHold = op.lastSeq;
      out("second hold payload", req2);
      out(`answer the second hold: ${second}`, await op.request("plugin.approval.resolve", { id: req2.id, decision: second }));
    }
    await op.terminal(runId).catch((e: Error) => out("run end", e.message));
    await op.waitFor("a further hold (none expected)", (e) => e.seq > lastHold && e.event === "plugin.approval.requested", 1500, lastHold).then(
      (e) => out("an unexpected further hold", rec(e.payload).id),
      () => out("no further hold after the run", true),
    );
    out("tool events", toolEvents(op, runId));
    out(
      "plugin log",
      (await pluginLog(op)).filter((r) => r.toolCallId === callId && r.kind !== "hook").map((r) => ({ ...r, at: undefined })),
    );
    const hist = JSON.stringify(await op.request("chat.history", { sessionKey: key, limit: 20 }));
    out("history has the original body", hist.includes("The disk is 91% full"));
    out("history has the edited body", hist.includes("EDITED BY THE PERSON"));
  } finally {
    await editor.close();
  }
}

async function fileScenario(op: OperatorSession, mode: string, change: boolean) {
  await op.request(`${PLUGIN}.mode`, { mode });
  const dir = await workspace("pip");
  await mkdir(path.join(dir, "outbox"), { recursive: true });
  const file = path.join(dir, "outbox", "report.txt");
  await writeFile(file, "Disk report, first version.\n");
  const key = await task(op, "pip", `file ${mode}`);
  const after = op.lastSeq;
  const runId = await sendTool(op, key, "probe_send_email", email({ attachments: ["outbox/report.txt"] }));
  const req = await waitApproval(op, after);
  out("approval requested", { id: req.id, title: rec(req.request).title ?? req.title });
  if (change) {
    await writeFile(file, "Disk report, CHANGED while the card waited.\n");
    out("file changed while waiting", true);
  }
  out("resolve", await op.request("plugin.approval.resolve", { id: req.id, decision: "allow-once" }));
  await op.terminal(runId);
  out("tool events", toolEvents(op, runId));
  out(
    "plugin log",
    (await pluginLog(op)).filter((r) => ["executed", "recheck", "trusted-held"].includes(String(r.kind))).slice(-3),
  );
}

const op = await openOperator(inst, "Clawtrate drafts probe", ALL, CAPS);
try {
  const run = scenarios[scenario];
  if (!run) throw new Error(`unknown scenario ${scenario}; one of ${Object.keys(scenarios).join(", ")}`);
  await run(op);
} finally {
  await op.request(`${PLUGIN}.mode`, { mode: "off" }).catch(() => {});
  await op.close();
}
