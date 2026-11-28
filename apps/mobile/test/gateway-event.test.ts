// #699: OpenClaw 2026.11.10 includes event text in system rows. CI's 2026.10.6
// gateway does not, so test the history mapping and disclosure in Node.

import {
  emptyActivity,
  initialState,
  mapHistory,
  type Bot,
  type ClawtrateState,
  type Task,
  type Transcript,
  type TranscriptItem,
} from "@clawtrate/core";
import type * as ReactModule from "react";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import type { LayoutChangeEvent } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantingGateway, KEY, openTask } from "../../../packages/core/test/client-harness.ts";
import { helloOk, until } from "../../../packages/core/test/fake-gateway.ts";
import { GatewayEvent } from "../src/components/GatewayEvent.tsx";
import { Txt } from "../src/components/ui.tsx";
import { createSecrets, REDACTED } from "../src/host/secrets.ts";
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
const useState = vi.hoisted(() =>
  vi.fn<(initial: unknown) => [unknown, (next: unknown) => void]>(),
);
const redact = vi.hoisted(() => vi.fn<(text: string) => string>());
vi.mock("react", async (load) => ({
  ...(await load<typeof ReactModule>()),
  useState,
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: () => {},
}));
vi.mock("react-native", () => ({
  Pressable: "Pressable",
  Text: "Text",
  View: "View",
  ScrollView: "ScrollView",
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "SafeAreaView" }));
vi.mock("../src/components/BotFiles.tsx", () => ({ BotFiles: "BotFiles" }));
vi.mock("../src/components/Markdown.tsx", () => ({ Markdown: "Markdown" }));
vi.mock("../src/components/SentFiles.tsx", () => ({ SentFiles: "SentFiles" }));
vi.mock("../src/components/Avatar.tsx", () => ({ Avatar: "Avatar" }));
vi.mock("../src/components/Strip.tsx", () => ({ StatusStrip: "StatusStrip" }));
vi.mock("../src/components/icons.tsx", () => ({
  BackIcon: "BackIcon",
  ChevronIcon: "ChevronIcon",
  EyeIcon: "EyeIcon",
  SettingsIcon: "SettingsIcon",
}));
vi.mock("../src/runtime.ts", () => ({ useRuntime: () => ({ readOn: () => null, redact }) }));
vi.mock("../src/theme/index.ts", async (load) => {
  const theme = await load<typeof ThemeModule>();
  return { ...theme, useTheme: () => theme.themeFor("light") };
});

beforeEach(() => {
  let open: boolean | undefined;
  useState.mockImplementation((initial) => {
    const current = (open ??= Boolean(initial));
    return [current, (next) => (open = Boolean(next))];
  });
  redact.mockImplementation((text) => text);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type NativeProps = {
  children?: ReactNode;
  testID?: string;
  onPress?: () => void;
  accessibilityLabel?: string;
  allowFontScaling?: boolean;
  numberOfLines?: number;
  onLayout?: (event: LayoutChangeEvent) => void;
  row?: ChatRow;
};
type NativeElement = ReactElement<NativeProps>;

// The app's TypeScript project checks these components with native globals.
// Load them at runtime here so Expo's globals stay out of the Node project.
const { Chat } = await vi.importActual<{
  Chat(props: {
    state: ClawtrateState;
    bot: Bot;
    task: Task;
    now: number;
    onBack: () => void;
    onRead: (task: Task) => void;
  }): NativeElement;
}>("../src/screens/Chat.tsx");
const { PROTECTED_BAND } = await vi.importActual<{ PROTECTED_BAND: number }>(
  "../src/components/Top.tsx",
);

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

const BOT: Bot = {
  id: TASK.botId,
  name: "Otto",
  emoji: null,
  avatarUrl: null,
  theme: null,
  model: null,
  isDefault: true,
};

type ScrollTo = (options: { y: number; animated: boolean }) => void;
type ScrollToEnd = (options: { animated: boolean }) => void;
type ScrollProps = NativeProps & {
  ref: { current: { scrollTo: ScrollTo; scrollToEnd: ScrollToEnd } | null };
  onScroll: (event: {
    nativeEvent: {
      contentOffset: { y: number };
      contentSize: { height: number };
      layoutMeasurement: { height: number };
    };
  }) => void;
  onContentSizeChange: (width: number, height: number) => void;
  onScrollBeginDrag: () => void;
};

const layout = (y: number, height: number): LayoutChangeEvent =>
  ({ nativeEvent: { layout: { x: 0, y, width: 390, height } } }) as LayoutChangeEvent;

function renderChild(element: NativeElement): NativeElement {
  if (typeof element.type !== "function") throw new Error("Expected a component");
  return (element.type as (props: NativeProps) => NativeElement)(element.props);
}

/** Drive the real Chat and RowView while native sections are plain elements. */
function eventInChat(raw: unknown) {
  const useDisclosureState = useState.getMockImplementation()!;
  // Chat's state, kept in call order, so a later draw shows what its callbacks set.
  const states: unknown[] = [];
  const draw = (): NativeElement => {
    let slot = 0;
    useState.mockImplementation((initial) => {
      const index = slot++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [
        states[index],
        (next) => {
          states[index] = typeof next === "function" ? next(states[index]) : next;
        },
      ];
    });
    try {
      return Chat({
        state: {
          ...initialState,
          connection: { ...initialState.connection, status: "connected" },
          transcripts: { [TASK.key]: transcript(mapHistory([raw], { gatewayEvents: true })) },
        },
        bot: BOT,
        task: TASK,
        now: 0,
        onBack: () => {},
        onRead: () => {},
      });
    } finally {
      useState.mockImplementation(useDisclosureState);
    }
  };
  const [pane] = childrenOf(draw());
  const [scroller] = childrenOf(pane!) as ReactElement<ScrollProps>[];
  expect(scroller?.props.testID).toBe("transcript");
  const [, body] = childrenOf(scroller!);
  const row = childrenOf(body!).find(
    (element) => childrenOf(element)[0]?.props.row?.kind === "event",
  );
  if (!row) throw new Error("Expected an event row in the transcript");
  const component = renderChild(childrenOf(row)[0]!);
  return {
    scroll: scroller!.props,
    body: body!.props,
    row: row.props,
    event: () => renderChild(component),
    /** Whether Chat's next draw shows Jump to latest. */
    jumpShown: () =>
      childrenOf(childrenOf(draw())[0]!).some((overlay) => {
        if (typeof overlay.type !== "function" || overlay.type.name !== "JumpToLatest")
          return false;
        const [button] = childrenOf(renderChild(overlay));
        expect(button?.props.testID).toBe("jump-to-latest");
        return true;
      }),
  };
}

const VIEW = 500;

/**
 * In a 500-point view, the reader at `offset` in content `height` points tall
 * opens the event, whose button sits 1,400 points down the content. Its text
 * adds `added` points. `resize` lays out new content and runs the next frame,
 * and the view reports a move as Fabric does, only when the offset changed.
 */
function openInChat(raw: unknown, at: { height: number; offset: number; added: number }) {
  const { scroll, body, row, event, jumpShown } = eventInChat(raw);
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  const scrollTo = vi.fn<ScrollTo>();
  const scrollToEnd = vi.fn<ScrollToEnd>();
  scroll.ref.current = { scrollTo, scrollToEnd };
  const sendScroll = (y: number, height: number) =>
    scroll.onScroll({
      nativeEvent: {
        contentOffset: { y },
        contentSize: { height },
        layoutMeasurement: { height: VIEW },
      },
    });
  const resize = (height: number) => {
    scroll.onContentSizeChange(390, height);
    for (const frame of frames.splice(0)) frame(0);
  };

  scroll.onLayout!(layout(0, VIEW));
  scroll.onContentSizeChange(390, at.height);
  body.onLayout!(layout(100, at.height - 100));
  row.onLayout!(layout(1_270, 74));
  sendScroll(at.offset, at.height);
  const toggle = childrenOf(event())[1]!;
  toggle.props.onLayout!(layout(30, 44));
  toggle.props.onPress!();
  // A queued event for the old scroll extent still reports where the reader was.
  sendScroll(at.offset, at.height);
  row.onLayout!(layout(1_270, 74 + at.added));
  resize(at.height + at.added);
  const moved = scrollTo.mock.lastCall?.[0].y;
  if (moved !== undefined && moved !== at.offset) sendScroll(moved, at.height + at.added);

  const close = () => {
    childrenOf(event())[1]!.props.onPress!();
    row.onLayout!(layout(1_270, 74));
    resize(at.height);
  };
  return { scroll, sendScroll, resize, close, scrollTo, scrollToEnd, jumpShown };
}

function pressEvent(event: () => NativeElement): NativeElement {
  const toggle = childrenOf(event()).find((child) => child.props.testID === "event-text-toggle");
  expect(toggle?.props.onPress).toBeTypeOf("function");
  toggle!.props.onPress!();
  return event();
}

describe("iPhone gateway events (#699)", () => {
  it("F-613: Chat opens event text after redacting a held token", () => {
    const token = "example-event-credential";
    const secrets = createSecrets();
    secrets.learn("connection", JSON.stringify({ token }));
    redact.mockImplementation(secrets.redact);
    const { event } = eventInChat(eventRow(`output ${token}`));
    const [, , details] = childrenOf(pressEvent(event));
    expect(details?.props.accessibilityLabel).toBe(`${NOTE} output ${REDACTED}`);
    expect(childrenOf(details!)[1]?.props.children).toBe(`output ${REDACTED}`);
  });

  it.each([
    ["empty", eventRow("")],
    ["whitespace-only", eventRow("  \n\t")],
    ["differently shaped", { ...eventRow(EXEC), idempotencyKey: "client:user" }],
  ])("F-613: a %s event stays a single system line", (_case, raw) => {
    const line = eventInChat(raw).event();
    expect(line.type).toBe(Txt);
    expect(line.props.children).toBe(LINE);
  });

  it("F-613: the event and attribution can wrap across lines", () => {
    const { event } = eventInChat(eventRow(EXEC));
    const [, , details] = childrenOf(pressEvent(event));
    for (const line of childrenOf(details!)) {
      const nativeText = renderChild(line);
      expect(nativeText.type).toBe("Text");
      expect(nativeText.props.numberOfLines ?? 0).toBe(0);
    }
  });

  it("F-613: the disclosure keeps native font scaling on", () => {
    const { event } = eventInChat(eventRow(EXEC));
    const [line, toggle, details] = childrenOf(pressEvent(event));
    for (const text of [line!, childrenOf(toggle!)[0]!, ...childrenOf(details!)])
      expect(renderChild(text).props.allowFontScaling ?? true).toBe(true);
  });

  it("F-613: the system line is read without the event body", () => {
    const { event } = eventInChat(eventRow(EXEC));
    const [closedLine] = childrenOf(event());
    const [openedLine] = childrenOf(pressEvent(event));
    for (const line of [closedLine!, openedLine!]) {
      const { accessibilityLabel, children } = renderChild(line).props;
      expect(accessibilityLabel ?? children).toBe(LINE);
    }
  });

  it("F-613: opening a long event keeps its button and attribution in view", () => {
    // The reader is at the end, and the text pushes the end 780 points down.
    const { scroll, sendScroll, scrollTo, scrollToEnd } = openInChat(eventRow(EXEC.repeat(20)), {
      height: 1_500,
      offset: 1_000,
      added: 780,
    });
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 1_400 - PROTECTED_BAND, animated: false });

    scroll.onScrollBeginDrag();
    sendScroll(1_780, 2_280);
    scroll.onContentSizeChange(390, 2_320);
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
  });

  it("F-613: a short event opened at the end keeps the next message in view", () => {
    // The event is the last row, and its text adds 80 points.
    const { resize, scrollTo, scrollToEnd, jumpShown } = openInChat(eventRow(EXEC), {
      height: 1_500,
      offset: 1_000,
      added: 80,
    });
    expect(jumpShown()).toBe(false);

    resize(1_700);
    expect(scrollToEnd).toHaveBeenLastCalledWith({ animated: false });
    // Opening went to the end, with the button 222 points below the header.
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 1_080, animated: false });
  });

  it.each([
    // A reply sits under the event, so its text shows without a scroll.
    ["a short event", EXEC, { height: 1_600, offset: 1_100, added: 80 }, false],
    // The button is held under the header, and closing leaves the reader 48 points from the end.
    ["a long event", EXEC.repeat(20), { height: 1_850, offset: 1_290, added: 780 }, true],
  ])("F-613: %s closed again at the end follows the next message", (_case, text, at, held) => {
    const { resize, close, scrollToEnd, jumpShown } = openInChat(eventRow(text), at);
    expect(jumpShown()).toBe(held);

    close();
    expect(jumpShown()).toBe(false);
    scrollToEnd.mockClear();
    resize(at.height + 120);
    expect(scrollToEnd).toHaveBeenLastCalledWith({ animated: false });
  });

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
      accessibilityValue: { text: "collapsed" },
    });
    expect(childrenOf(toggle)[0]?.props.children).toBe(LABEL);
  });

  it("#699: opening the disclosure shows and reads the attribution before the event text", () => {
    pressToggle();
    const [, toggle, body] = childrenOf(renderEvent());
    expect(toggle?.props).toMatchObject({
      accessibilityState: { expanded: true },
      accessibilityValue: undefined,
    });
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
