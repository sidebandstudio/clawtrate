// #699: OpenClaw 2026.11.10 includes event text in system rows. CI's 2026.10.6
// gateway does not, so test the history mapping and disclosure in Node.

import {
  emptyActivity,
  mapHistory,
  type Task,
  type Transcript,
  type TranscriptItem,
} from "@clawtrate/core";
import type * as ReactModule from "react";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { grantingGateway, KEY, openTask } from "../../../packages/core/test/client-harness.ts";
import { helloOk, until } from "../../../packages/core/test/fake-gateway.ts";
import { GatewayEvent } from "../src/components/GatewayEvent.tsx";
import { Txt } from "../src/components/ui.tsx";
import type * as ThemeModule from "../src/theme/index.ts";
import { chatRows, type ChatRow } from "../src/transcript.ts";

const LINE = "The gateway started a turn by itself";
const RESUMED = "The gateway resumed an earlier turn by itself";
// A command's completion as 2026.11.10 words it, with words a person might have typed.
const EXEC = "Exec completed (b7d41c2e, code 0, 12s):\nthe command you ran finished";
const LABEL = "Text that came with it";
const NOTE =
  "Written by whatever started this turn (a command, a bot or another app), not by the gateway or Clawtrate.";

// Render the iPhone component's element tree without a native runtime. Keep its
// initial state and apply the state update the real button sends on each press.
const useOpen = vi.hoisted(() =>
  vi.fn<(initial: boolean) => [boolean, (update: (open: boolean) => boolean) => void]>(),
);
vi.mock("react", async (load) => ({
  ...(await load<typeof ReactModule>()),
  useState: useOpen,
}));
vi.mock("react-native", () => ({ Pressable: "Pressable", Text: "Text", View: "View" }));
vi.mock("../src/components/icons.tsx", () => ({ ChevronIcon: "ChevronIcon" }));
vi.mock("../src/theme/index.ts", async (load) => {
  const theme = await load<typeof ThemeModule>();
  return { ...theme, useTheme: () => theme.themeFor("light") };
});

beforeEach(() => {
  let open: boolean | undefined;
  useOpen.mockImplementation((initial) => {
    const current = (open ??= initial);
    return [current, (update) => (open = update(current))];
  });
});

type NativeProps = {
  children?: ReactNode;
  testID?: string;
  onPress?: () => void;
};
type NativeElement = ReactElement<NativeProps>;

function renderEvent(line = LINE, text: string | undefined = EXEC): NativeElement {
  return GatewayEvent({ line, text });
}

function childrenOf(element: NativeElement): NativeElement[] {
  return Children.toArray(element.props.children).filter(isValidElement<NativeProps>);
}

function pressToggle(): void {
  childrenOf(renderEvent())
    .find((child) => child.props.testID === "event-text-toggle")
    ?.props.onPress?.();
}

function expectLineOnly(row: ChatRow | undefined, line: string): void {
  expect(row).toEqual({ kind: "event", id: expect.any(String), text: line });
  if (row?.kind !== "event") throw new Error("Expected a system event row");
  const rendered: NativeElement = GatewayEvent({ line: row.text, text: row.eventText });
  expect(rendered.type).toBe(Txt);
  expect(rendered.props).toMatchObject({
    testID: "event-line",
    style: { textAlign: "center" },
    children: line,
  });
}

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

describe("iPhone gateway events (#699)", () => {
  it("#699: keeps the centred gateway line apart from the event text", () => {
    for (const source of ["cron", "exec", "node", "hook", "plugin", "task", "session"])
      expect(rowsOf([eventRow(EXEC, source)], true), source).toEqual([
        { kind: "event", id: expect.any(String), text: LINE, eventText: EXEC },
      ]);

    const [line] = childrenOf(renderEvent());
    expect(line?.type).toBe(Txt);
    expect(line?.props).toMatchObject({
      testID: "event-line",
      style: { textAlign: "center" },
      children: LINE,
    });
  });

  it("#699: a restart shows the resume line alone", () => {
    const prompt = "The Gateway restarted while you were working. Resume your work.";
    for (const source of ["restart", "main_session_restart_recovery"])
      expectLineOnly(rowsOf([eventRow(prompt, source)], true)[0], RESUMED);
  });

  it("#699: the disclosure starts closed and announces a collapsed button", () => {
    const children = childrenOf(renderEvent());
    expect(children.map((child) => child.props.testID)).toEqual([
      "event-line",
      "event-text-toggle",
    ]);
    const toggle = children[1]!;
    expect(toggle.props).toMatchObject({
      accessibilityRole: "button",
      accessibilityLabel: LABEL,
      accessibilityState: { expanded: false },
    });
    expect(childrenOf(toggle)[0]?.props.children).toBe(LABEL);
  });

  it("#699: opening the disclosure shows and reads the attribution before the event text", () => {
    pressToggle();
    const [, toggle, body] = childrenOf(renderEvent());
    expect(toggle?.props).toMatchObject({ accessibilityState: { expanded: true } });
    expect(body?.props).toMatchObject({
      testID: "event-text",
      accessible: true,
      accessibilityLabel: `${NOTE} ${EXEC}`,
    });
    expect(childrenOf(body!).map((child) => child.props.children)).toEqual([NOTE, EXEC]);

    pressToggle();
    expect(childrenOf(renderEvent())).toHaveLength(2);
  });

  it("#699: markdown, links and images in the event stay plain text", () => {
    const text =
      "**bold** and `code`\n[a link](https://example.com)\n![a picture](https://example.com/a.png) <img src=x>";
    const row = rowsOf([eventRow(text)], true)[0];
    expect(row).toMatchObject({ kind: "event", eventText: text });
    if (row?.kind !== "event") throw new Error("Expected a system event row");

    pressToggle();
    const body = childrenOf(renderEvent(row.text, row.eventText))[2]!;
    const content = childrenOf(body)[1]!;
    expect(content.type).toBe(Txt);
    expect(content.props.children).toBe(text);
    expect(content.props.onPress).toBeUndefined();
  });

  it("#699: only a gateway version with event text offers a disclosure", async () => {
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
      try {
        await until(() => held().items.length === 2);
        const [event, reply] = shown(chatRows(TASK, held(), "Otto", 0, LINK));
        if (eventText) {
          expect(event).toEqual({
            kind: "event",
            id: expect.any(String),
            text: LINE,
            eventText,
          });
        } else {
          expectLineOnly(event, LINE);
        }
        expect(reply).toMatchObject({ kind: "bot", text: "The build finished." });
      } finally {
        client.stop();
      }
    }
  });
});
