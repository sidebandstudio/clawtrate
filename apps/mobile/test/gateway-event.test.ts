// #699: a turn the gateway started itself, in the iPhone chat. On OpenClaw 2026.11.10 and later,
// core gives its system item the text the event came with as a second block (`gatewayEvent`,
// #674). The chat keeps the gateway's line as the centred row and puts that text behind "Text that
// came with it", as the desktop does (packages/ui/test/gateway-event.test.ts). Rows have the
// fields a development instance of 2026.11.10 returned, with made-up ids, as there. CI's OpenClaw,
// 2026.10.6, sends no event text, so no Simulator check can show it.

import {
  emptyActivity,
  mapHistory,
  type Task,
  type Transcript,
  type TranscriptItem,
} from "@clawtrate/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { grantingGateway, KEY, openTask } from "../../../packages/core/test/client-harness.ts";
import { helloOk, until } from "../../../packages/core/test/fake-gateway.ts";
import { GATEWAY_EVENT_WORDS as W, gatewayEventView } from "../src/presentation/gateway-event.ts";
import { chatRows, type ChatRow } from "../src/transcript.ts";

const LINE = "The gateway started a turn by itself";
const RESUMED = "The gateway resumed an earlier turn by itself";
// A command's completion as 2026.11.10 words it, with words a person might have typed.
const EXEC = "Exec completed (b7d41c2e, code 0, 12s):\nthe command you ran finished";
const NOTE =
  "Written by whatever started this turn (a command, a bot or another app), not by the gateway or Clawtrate.";

/** A row 2026.11.10 keeps for an event from `sourceTool`, as `chat.history` gives it. */
const eventRow = (text: string, sourceTool = "exec") => ({
  role: "user",
  content: text,
  timestamp: 1_800_000_000_000,
  idempotencyKey: "ev-key",
  provenance: { kind: "internal_system", sourceTool },
  __openclaw: {
    senderIsOwner: false,
    transport: { channel: "webchat", messageId: "ev-key" },
    id: "ev-1",
    idempotencyKey: "ev-key",
    seq: 3,
  },
});

const TASK: Task = {
  key: KEY,
  botId: "otto",
  sessionId: null,
  title: "Disk space",
  preview: null,
  updatedAt: null,
  status: "idle",
  unread: false,
};
const LINK = { connected: true, closed: false };

function transcript(items: TranscriptItem[]): Transcript {
  return {
    ...emptyActivity,
    linkedRuns: {},
    interSession: [],
    mcpTools: {},
    sessionKey: KEY,
    status: "ready",
    items,
    error: null,
    hasMore: false,
    live: null,
    loadedAt: 1,
  };
}

/** The chat's rows but its stamps. */
const shown = (rows: ChatRow[]) => rows.filter((row) => row.kind !== "stamp");

/** The chat's rows for `raw` history, mapped as on a gateway that writes events (2026.11.10) or not. */
const rowsOf = (raw: unknown[], events: boolean) =>
  shown(chatRows(TASK, transcript(mapHistory(raw, { gatewayEvents: events })), "Otto", 0, LINK));

describe("#699: a turn the gateway started itself, in the iPhone chat", () => {
  it("#699: keeps the gateway's line as the centred row and the event's text apart from it, for every kind of event", () => {
    // A wake, a command finishing, a device's, a hook's, a plugin's, a task's and a session's event.
    for (const source of ["cron", "exec", "node", "hook", "plugin", "task", "session"])
      expect(rowsOf([eventRow(EXEC, source)], true), source).toEqual([
        { kind: "event", id: expect.any(String), text: LINE, eventText: EXEC },
      ]);
  });

  it("#699: a restart's resume says the gateway resumed a turn and offers no text, as core gives it, while another event's row does", () => {
    const prompt = "The Gateway restarted while you were working. Resume your work.";
    for (const source of ["restart", "main_session_restart_recovery"]) {
      const rows = rowsOf([eventRow(prompt, source)], true);
      expect(rows, source).toEqual([{ kind: "event", id: expect.any(String), text: RESUMED }]);
      expect(JSON.stringify(rows), source).not.toContain("Resume your work");
    }
    expect(rowsOf([eventRow(prompt, "cron")], true)).toEqual([
      { kind: "event", id: expect.any(String), text: LINE, eventText: prompt },
    ]);
  });

  it('#699: the text is closed at first: its button says "Text that came with it", and none of the text shows', () => {
    const view = gatewayEventView(EXEC);
    expect(view).toEqual({
      toggle: { label: "Text that came with it", expanded: false },
      body: null,
    });
    expect(JSON.stringify(view)).not.toContain("b7d41c2e");
  });

  it("#699: opened, it says who wrote the text before the text, and is read in that order", () => {
    const view = gatewayEventView(EXEC, true);
    expect(view.toggle).toEqual({ label: "Text that came with it", expanded: true });
    expect(view.body).toEqual({ note: NOTE, text: EXEC, spoken: `${NOTE} ${EXEC}` });
  });

  it("#699: says what the desktop says, in its words", () => {
    const desktop = readFileSync(
      join(import.meta.dirname, "../../../packages/ui/src/GatewayEventLine.tsx"),
      "utf8",
    ).replace(/\s+/g, " ");
    expect(desktop).toContain(`data-side="center"> ${W.toggle} <ChevronIcon`);
    expect(desktop).toContain(`<p className="gateway-event-note"> ${W.note} </p>`);
    expect(W).toEqual({ toggle: "Text that came with it", note: NOTE });
  });

  it("#699: markdown, a link or a picture in the event's text stays plain text, as written", () => {
    const text =
      "**bold** and `code`\n[a link](https://example.com)\n![a picture](https://example.com/a.png) <img src=x>";
    expect(rowsOf([eventRow(text)], true)).toEqual([
      { kind: "event", id: expect.any(String), text: LINE, eventText: text },
    ]);
    expect(gatewayEventView(text, true).body?.text).toBe(text);
    // The row draws it as the app's text, never through the bot's markdown.
    const component = readFileSync(
      join(import.meta.dirname, "../src/components/GatewayEvent.tsx"),
      "utf8",
    );
    expect(component).not.toMatch(/from "\.\/Markdown\.tsx"/);
    expect(component).toContain("{view.body.text}</Txt>");
  });

  it("#699: on 2026.10.6 and a gateway that reports no version, the row is the line alone, as before; 2026.11.10 brings the text", async () => {
    const answer = {
      role: "assistant",
      content: [{ type: "text", text: "The build finished." }],
      timestamp: 1_800_000_000_200,
      __openclaw: { id: "a-1", runId: "woken-run", seq: 4 },
    };
    for (const [version, eventText] of [
      ["2026.10.6", undefined],
      [undefined, undefined],
      ["2026.11.10", EXEC],
    ] as const) {
      const gateway = grantingGateway();
      gateway.connectReply = (params) => {
        const { scopes, auth } = params as { scopes: string[]; auth?: { deviceToken?: string } };
        const hello = helloOk(scopes, auth?.deviceToken ?? "device-token");
        // An undefined version leaves the hello without one.
        return { ok: true, payload: { ...hello, server: { ...hello.server, version } } };
      };
      gateway.handlers["chat.history"] = () => ({ messages: [eventRow(EXEC), answer] });
      const { client, transcript: held } = await openTask({ gateway });
      await until(() => held().items.length === 2);
      const rows = shown(chatRows(TASK, held(), "Otto", 0, LINK));
      expect(rows[0], String(version)).toEqual({
        kind: "event",
        id: expect.any(String),
        text: LINE,
        ...(eventText ? { eventText } : {}),
      });
      expect(rows[1], String(version)).toMatchObject({ kind: "bot", text: "The build finished." });
      client.stop();
    }
  });
});
