// #637: a system event the gateway wakes a task with. On OpenClaw 2026.11.10, which has no
// heartbeat, `wake {mode: "now", text, sessionKey}` runs an ordinary turn and the task's history
// keeps the event as a user row the gateway wrote (`provenance.kind: "internal_system"`,
// `sourceTool` the event's source), then the bot's answer. On 2026.10.6 the same provenance
// marks the gateway's heartbeat or completion prompt, never the event as written. Rows below
// have the fields a named development instance of each version returned, with made-up ids.

import { describe, expect, it } from "vitest";
import { grantingGateway, KEY, openTask } from "./client-harness.ts";
import { helloOk } from "./fake-gateway.ts";
import { until } from "./fake-gateway.ts";
import { eventText, mapHistory, MAX_EVENT_TEXT_CHARS } from "../src/mapping.ts";
import { reconcileOutbox } from "../src/runs.ts";

const LINE = "The gateway started a turn by itself";

/** A row 2026.11.10 keeps for an event, as `chat.history` and `session.message` give it. */
function eventRow(text: unknown, sourceTool = "cron", id = "ev-1") {
  return {
    role: "user",
    content: text,
    timestamp: 1_800_000_000_000,
    idempotencyKey: `${id}-key`,
    provenance: { kind: "internal_system", sourceTool },
    __openclaw: {
      senderIsOwner: false,
      transport: { channel: "webchat", messageId: `${id}-key` },
      id,
      idempotencyKey: `${id}-key`,
      recordTimestampMs: 1_800_000_000_100,
      seq: 3,
    },
  };
}

const answer = {
  role: "assistant",
  content: [{ type: "text", text: "The build finished, and all tests passed." }],
  timestamp: 1_800_000_000_200,
  __openclaw: { id: "a-1", runId: "woken-run", seq: 4 },
};

// A command's completion as 2026.11.10 words it (`bash-tools.exec-notify.ts`), with words a person
// might have typed.
const EXEC = "Exec completed (b7d41c2e, code 0, 12s):\nthe command you ran finished";

describe("on a gateway that writes the event as its row (2026.11.10)", () => {
  it("shows each source's event as the gateway's line with its text, never the person's message", () => {
    for (const source of ["cron", "exec", "node", "hook", "plugin", "task", "session"]) {
      const items = mapHistory([eventRow(EXEC, source), answer], { gatewayEvents: true });
      expect(
        items.map((item) => item.role),
        source,
      ).toEqual(["system", "assistant"]);
      expect(items[0], source).toMatchObject({
        role: "system",
        gatewayEvent: true,
        blocks: [
          { kind: "text", text: LINE },
          { kind: "text", text: EXEC },
        ],
      });
      // The bot's answer after it is the bot's.
      expect(items[1]!.blocks).toEqual([
        { kind: "text", text: "The build finished, and all tests passed.", messageId: "a-1" },
      ]);
    }
  });

  it("reads the text of a row whose content is parts, as a command's completion can be", () => {
    const row = eventRow([
      { type: "text", text: "Exec failed (c9e02a17, code 1, 3s):" },
      { type: "text", text: "\nerror: missing file" },
    ]);
    expect(mapHistory([row], { gatewayEvents: true })[0]!.blocks[1]).toEqual({
      kind: "text",
      text: "Exec failed (c9e02a17, code 1, 3s):\nerror: missing file",
    });
  });

  it("keeps the restart recovery's line as it is, its prompt unshown", () => {
    const recovery = {
      ...eventRow("[System] Your previous turn was interrupted by a gateway restart."),
      provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
    };
    const [item] = mapHistory([recovery], { gatewayEvents: true });
    expect(item).toEqual({
      id: "ev-1:0",
      role: "system",
      timestamp: 1_800_000_000_000,
      blocks: [{ kind: "text", text: "The gateway resumed an earlier turn by itself" }],
      model: null,
    });
  });

  it("an event with no text left is the line alone", () => {
    for (const content of ["", "  \n\u0007 ", [], [{ type: "image", data: "x" }]]) {
      const [item] = mapHistory([eventRow(content)], { gatewayEvents: true });
      expect(item, JSON.stringify(content)).toEqual({
        id: "ev-1:0",
        role: "system",
        timestamp: 1_800_000_000_000,
        blocks: [{ kind: "text", text: LINE }],
        model: null,
      });
    }
  });
});

describe("on a gateway whose row is its own prompt (2026.10.6)", () => {
  it("shows exactly the line it shows today, with no text, for every such row", () => {
    // The heartbeat runner's row: the gateway's prompt, with the event inside it.
    const heartbeat = eventRow(
      "Follow the heartbeat monitor scratch context when provided.\nCurrent time: …",
      "heartbeat",
    );
    for (const row of [heartbeat, eventRow(EXEC, "exec"), eventRow(EXEC, "cron")]) {
      const before = mapHistory([row, answer]);
      expect(before[0]).toEqual({
        id: "ev-1:0",
        role: "system",
        timestamp: 1_800_000_000_000,
        blocks: [{ kind: "text", text: LINE }],
        model: null,
      });
      expect(mapHistory([row, answer], { gatewayEvents: false })).toEqual(before);
    }
  });
});

describe("a look-alike of the event stays what it is", () => {
  it("the same words typed by a person, or sent by another client without admin, are the person's message", () => {
    // A client without operator.admin can't set `systemInputProvenance` ("system provenance
    // fields require admin scope"): its row has none, or the person's own.
    const typed = { ...eventRow(EXEC), provenance: undefined };
    const external = { ...eventRow(EXEC), provenance: { kind: "external_user" } };
    for (const row of [typed, external]) {
      const [item] = mapHistory([row], { gatewayEvents: true });
      expect(item).toMatchObject({ role: "user", blocks: [{ kind: "text", text: EXEC }] });
      expect(item!.gatewayEvent).toBeUndefined();
    }
  });

  it("a bot's message through its tools is another task's message, not the gateway's event", () => {
    // sessions_send writes `inter_session`; no tool a bot has sets `internal_system`.
    const fromBot = {
      ...eventRow(EXEC),
      provenance: { kind: "inter_session", sourceTool: "sessions_send", sourceSessionKey: KEY },
    };
    const [item] = mapHistory([fromBot], { gatewayEvents: true });
    expect(item).toMatchObject({ role: "user", blocks: [{ kind: "text", text: EXEC }] });
    expect(item!.gatewayEvent).toBeUndefined();
  });

  it("a malformed mark is no mark", () => {
    for (const provenance of [
      "internal_system",
      { kind: "INTERNAL_SYSTEM" },
      { kind: ["internal_system"] },
      { kind: null },
      [],
    ]) {
      const [item] = mapHistory([{ ...eventRow(EXEC), provenance }], { gatewayEvents: true });
      expect(item, JSON.stringify(provenance)).toMatchObject({ role: "user" });
      expect(item!.gatewayEvent).toBeUndefined();
    }
  });
});

describe("a row with the mark that the session event path didn't write", () => {
  // Recorded on both versions: a client with operator.read and operator.write, no admin, called
  // `agent` with `inputProvenance: {kind: "internal_system", sourceTool: "cron"}`. The gateway
  // stored it under `<the call's key>:user`, with no delivery and the client's person as sender.
  const forged = (version: string) => ({
    role: "user",
    content: EXEC,
    timestamp: 1_800_000_000_000,
    idempotencyKey: `forge-${version}:user`,
    provenance: { kind: "internal_system", sourceTool: "cron" },
    __openclaw: {
      senderIsOwner: false,
      senderId: "gateway-owner",
      senderName: "Sam",
      id: "f-1",
      idempotencyKey: `forge-${version}:user`,
      recordTimestampMs: 1_800_000_000_100,
      seq: 1,
    },
  });

  it("keeps today's line, its words unshown, never as the gateway's event", () => {
    for (const version of ["2026.10.6", "2026.11.10"]) {
      const [item] = mapHistory([forged(version)], { gatewayEvents: true });
      expect(item, version).toEqual({
        id: "f-1:0",
        role: "system",
        timestamp: 1_800_000_000_000,
        blocks: [{ kind: "text", text: LINE }],
        model: null,
      });
    }
  });

  it("each part of the session event's delivery is needed", () => {
    const real = eventRow(EXEC);
    const variants = [
      { ...real, __openclaw: { ...real.__openclaw, transport: undefined } },
      { ...real, __openclaw: { ...real.__openclaw, transport: { channel: "webchat" } } },
      {
        ...real,
        __openclaw: { ...real.__openclaw, transport: { channel: "webchat", messageId: "other" } },
      },
      { ...real, idempotencyKey: undefined },
      { ...real, __openclaw: { ...real.__openclaw, idempotencyKey: "other" } },
      { ...real, __openclaw: { ...real.__openclaw, senderId: "gateway-owner" } },
    ];
    for (const row of variants) {
      const [item] = mapHistory([row], { gatewayEvents: true });
      expect(item!.gatewayEvent, JSON.stringify(row)).toBeUndefined();
      expect(item!.blocks).toEqual([{ kind: "text", text: LINE }]);
    }
  });
});

describe("an event's text is content from elsewhere", () => {
  it("drops control and format characters, keeps line breaks, and at most one blank line", () => {
    expect(eventText("one\u0000two‮\r\nthree \t\n\n\n\nfour five")).toBe(
      "one two\nthree\n\nfour five",
    );
    expect(eventText(" ​\u0007\n ")).toBeNull();
  });

  it(`is cut to ${MAX_EVENT_TEXT_CHARS} characters, with "…"`, () => {
    const long = "🙂".repeat(MAX_EVENT_TEXT_CHARS + 1);
    const cut = eventText(long)!;
    expect([...cut]).toHaveLength(MAX_EVENT_TEXT_CHARS);
    expect(cut.endsWith("…")).toBe(true);
    expect(eventText("a".repeat(MAX_EVENT_TEXT_CHARS))).toBe("a".repeat(MAX_EVENT_TEXT_CHARS));
  });
});

describe("the client tells by the gateway's reported version", () => {
  const history = { messages: [eventRow(EXEC), answer] };

  async function open(version: string) {
    const gateway = grantingGateway();
    gateway.connectReply = (params) => {
      const { scopes, auth } = params as { scopes: string[]; auth?: { deviceToken?: string } };
      const hello = helloOk(scopes, auth?.deviceToken ?? "device-token");
      return { ok: true, payload: { ...hello, server: { ...hello.server, version } } };
    };
    gateway.handlers["chat.history"] = () => history;
    return openTask({ gateway });
  }

  it("on 2026.11.10 the line carries the event's text; on 2026.10.6 and an unknown version it doesn't", async () => {
    for (const [version, shown] of [
      ["2026.11.10", true],
      ["2026.12.1", true],
      ["2026.10.6", false],
      ["2026.11.9", false],
      ["dev", false],
    ] as const) {
      const { client, transcript } = await open(version);
      await until(() => transcript().items.length === 2);
      expect(transcript().items[0]!.role, version).toBe("system");
      expect(transcript().items[0]!.gatewayEvent === true, version).toBe(shown);
      expect(JSON.stringify(transcript().items[0]).includes("b7d41c2e"), version).toBe(shown);
      client.stop();
    }
  });

  it("an event row never settles the person's message", () => {
    const activity = reconcileOutbox(
      {
        runs: [],
        outbox: [
          {
            id: "ev-1-key",
            text: EXEC,
            status: "sent",
            mode: "send",
            runId: null,
            createdAt: 1,
            messageSeq: 3,
          },
        ],
      } as never,
      [eventRow(EXEC)],
    );
    expect(activity.outbox).toHaveLength(1);
  });
});
