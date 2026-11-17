// Payloads shaped like what OpenClaw 2026.10.6 returns, trimmed to the fields
// that matter and with invented values.

export const agentsList = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    {
      id: "otto",
      name: "otto",
      identity: {
        name: "Otto",
        emoji: "⚙️",
        theme: "operations",
        avatar: "avatar.png",
        avatarUrl: "data:image/png;base64,iVBORw0KGgo=",
      },
      model: { primary: "scripted/dev-1" },
    },
    {
      id: "main",
      identity: { name: "Juniper", emoji: "🌿", avatarUrl: "data:image/png;base64,AAAA" },
      model: { primary: "scripted/dev-1" },
    },
    { id: "helper", kind: "system", identity: { name: "System helper" } },
    {
      id: "bare",
      identity: { avatarUrl: "file:///private/avatar.png" },
    },
  ],
};

export const sessionsList = {
  count: 3,
  sessions: [
    {
      key: "agent:otto:disk-space",
      agentId: "otto",
      sessionId: "s-1",
      label: "Disk almost full",
      displayName: "disk-space",
      lastMessagePreview: "Done. The disk is now at **61%**.",
      updatedAt: 1_000,
      status: "done",
      unread: true,
    },
    {
      key: "agent:otto:backup-check",
      agentId: "otto",
      sessionId: "s-2",
      displayName: "backup-check",
      derivedTitle: "Weekly backup check",
      updatedAt: 3_000,
      hasActiveRun: true,
    },
    {
      key: "agent:main:heat-pump",
      sessionId: "s-3",
      displayName: "heat-pump",
      updatedAt: 2_000,
      lastRunError: "provider timeout",
    },
    { key: "agent:main:old", agentId: "main", archived: true },
  ],
};

export const chatHistory = {
  sessionKey: "agent:otto:disk-space",
  hasMore: false,
  messages: [
    {
      role: "user",
      content: "The disk is 94% full.",
      timestamp: 100,
      __openclaw: { id: "u1", seq: 1 },
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Look before guessing." },
        { type: "toolCall", id: "call_1", name: "ls", arguments: { path: "." } },
      ],
      model: "dev-1",
      timestamp: 110,
      __openclaw: { id: "a1", seq: 2, runId: "run-1" },
    },
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "ls",
      isError: false,
      content: [{ type: "text", text: '"AGENTS.md"\n"notes/"' }],
      __openclaw: { id: "t1", seq: 3, runId: "run-1" },
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "**Found** the cache." }],
      model: "dev-1",
      timestamp: 130,
      __openclaw: { id: "a2", seq: 4, runId: "run-1" },
    },
    { role: "assistant", content: [], __openclaw: { kind: "compaction", id: "c1", seq: 5 } },
    {
      role: "user",
      content: [{ type: "text", text: "Clear it." }],
      timestamp: 200,
      __openclaw: { id: "u2", seq: 6 },
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_2", name: "write", arguments: '{"path":"log.md"}' }],
      timestamp: 210,
      __openclaw: { id: "a3", seq: 7, runId: "run-2" },
    },
    {
      role: "toolResult",
      toolCallId: "call_2",
      isError: true,
      content: [{ type: "text", text: "permission denied" }],
      __openclaw: { id: "t2", seq: 8, runId: "run-2" },
    },
    {
      role: "assistant",
      content: "Could not write the log.",
      timestamp: 220,
      __openclaw: { id: "a4", seq: 9, runId: "run-2" },
    },
  ],
};
