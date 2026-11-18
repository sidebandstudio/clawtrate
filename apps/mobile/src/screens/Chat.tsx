// A task's chat (visual-language.md, sections 8 and 12), for reading: the
// task's title first, the stamps, your messages and the bot's as bubbles, the
// bot's markdown rendered, and each of its actions as one quiet line in the
// engine's words. A run that goes on while the task is open is said in the
// status line's words, and its history shows when it ends. Sending belongs
// to a later build, so there is no composer.

import type { Bot, ClawtrateState, Task } from "@clawtrate/core";
import { CONVERSATION_WORDS as W, emptyBody } from "@clawtrate/ui/conversation-words";
import { useEffect, useRef, type ComponentRef, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Markdown } from "../components/Markdown.tsx";
import { BackButton, Top } from "../components/Top.tsx";
import { Button, Dot, Txt } from "../components/ui.tsx";
import { useRuntime } from "../runtime.ts";
import { S, TOUCH, useTheme } from "../theme/index.ts";
import { chatRows, type ChatRow } from "../transcript.ts";

/** Within this distance of the end, new content is followed. */
const NEAR_END = 96;

function RowView({ row }: { row: ChatRow }) {
  const { c } = useTheme();
  switch (row.kind) {
    case "stamp":
      return (
        <Txt
          testID="stamp"
          size={S["text-xs"]}
          color="text-faint"
          style={{ textAlign: "center", marginTop: 22, marginBottom: 10 }}
        >
          {row.text}
        </Txt>
      );
    case "user":
      return (
        <View
          testID="turn-user"
          style={{
            alignSelf: "flex-end",
            maxWidth: "78%",
            backgroundColor: c["bubble-user"],
            borderRadius: S["radius-lg"],
            paddingVertical: 9,
            paddingHorizontal: 14,
          }}
        >
          <Txt size={TOUCH.bodyText} color="bubble-user-text" selectable>
            {row.text}
          </Txt>
        </View>
      );
    case "bot":
      return (
        <View
          testID="turn-bot"
          style={{
            alignSelf: "flex-start",
            maxWidth: "86%",
            backgroundColor: c["bg-bubble"],
            borderRadius: S["radius-lg"],
            paddingVertical: 9,
            paddingHorizontal: 14,
          }}
        >
          <Markdown text={row.text} />
        </View>
      );
    case "action":
      return (
        <Txt
          testID="action-line"
          accessibilityLabel={row.spoken}
          size={S["text-sm"]}
          color={row.tone === "danger" ? "danger" : "text-faint"}
          style={{ paddingHorizontal: 14 }}
        >
          {row.text}
        </Txt>
      );
    case "event":
      return (
        <Txt
          testID="event-line"
          size={S["text-sm"]}
          color="text-faint"
          style={{ textAlign: "center" }}
        >
          {row.text}
        </Txt>
      );
    case "running":
      return (
        <View
          testID="running"
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: S["space-2"],
            paddingHorizontal: 14,
          }}
        >
          <Dot tone="connected" />
          <Txt testID="running-text" size={S["text-sm"]} color="text-muted">
            {row.text}
          </Txt>
        </View>
      );
  }
}

/** The task's name, the first line of every transcript. */
function TaskLine({ task }: { task: Task }) {
  return (
    <Txt
      testID="task-line"
      accessibilityRole="header"
      size={S["text-base"]}
      weight="medium"
      style={{ textAlign: "center", marginBottom: S["space-2"] }}
    >
      {task.title}
    </Txt>
  );
}

function Empty({
  title,
  body,
  children,
}: {
  title: string;
  body: string | null;
  children?: ReactNode;
}) {
  return (
    <View
      testID="chat-empty"
      style={{ alignItems: "center", gap: S["space-2"], paddingTop: S["space-10"] }}
    >
      <Txt weight="medium" accessibilityRole="header">
        {title}
      </Txt>
      {body && (
        <Txt size={S["text-sm"]} color="text-faint" style={{ textAlign: "center" }}>
          {body}
        </Txt>
      )}
      {children}
    </View>
  );
}

export function Chat({
  state,
  bot,
  task,
  now,
  onBack,
  onRead,
}: {
  state: ClawtrateState;
  bot: Bot;
  task: Task;
  now: number;
  onBack: () => void;
  /** The task has been read as of what it now shows. */
  onRead: (task: Task) => void;
}) {
  const { send } = useRuntime();
  const { c } = useTheme();
  const transcript = state.transcripts[task.key];
  const online = state.connection.status === "connected";
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);
  const atEnd = useRef(true);

  // The task is open while its chat is on screen.
  useEffect(() => {
    void send({ type: "openSession", key: task.key }).catch(() => {});
    return () => {
      void send({ type: "closeSession", key: task.key }).catch(() => {});
    };
  }, [send, task.key]);

  // What is on screen has been read.
  const ready = transcript?.status === "ready";
  useEffect(() => {
    if (ready) onRead(task);
  }, [ready, task, onRead]);

  const reload = () => {
    void send({ type: "closeSession", key: task.key })
      .then(() => send({ type: "openSession", key: task.key }))
      .catch(() => {});
  };

  const items = transcript?.items.length ?? 0;
  let body: ReactNode;
  if (!online && (!transcript || items === 0)) {
    body = <Empty title={W.waitingTitle} body={W.waitingBody} />;
  } else if (!transcript || (transcript.status === "loading" && items === 0)) {
    body = (
      <View
        accessibilityLabel={W.loading}
        testID="chat-loading"
        style={{ gap: S["space-4"], paddingTop: S["space-4"] }}
      >
        <View
          style={{
            alignSelf: "flex-end",
            width: "46%",
            height: 40,
            borderRadius: S["radius-lg"],
            backgroundColor: c["bg-bubble"],
          }}
        />
        <View
          style={{
            width: "62%",
            height: 88,
            borderRadius: S["radius-lg"],
            backgroundColor: c["bg-bubble"],
          }}
        />
        <View
          style={{
            width: "38%",
            height: 40,
            borderRadius: S["radius-lg"],
            backgroundColor: c["bg-bubble"],
          }}
        />
      </View>
    );
  } else if (transcript.status === "error" && items === 0) {
    body = (
      <Empty title={W.loadFailed} body={transcript.error}>
        <Button label={W.tryAgain} onPress={reload} testID="chat-try-again" />
      </Empty>
    );
  } else {
    const rows = chatRows(task, transcript, bot.name, now, online);
    body =
      rows.length === 0 ? (
        <Empty title={W.emptyTitle} body={emptyBody(bot.name)} />
      ) : (
        <View style={{ gap: 4 }}>
          {transcript.status === "error" && (
            <View
              accessibilityRole="alert"
              style={{
                backgroundColor: c["danger-soft"],
                borderRadius: S["radius-md"],
                padding: S["space-3"],
                gap: S["space-2"],
              }}
            >
              <Txt size={S["text-sm"]}>{W.refreshFailed}</Txt>
              <Button label={W.tryAgain} onPress={reload} />
            </View>
          )}
          {rows.map((row, index) => {
            const previous = rows[index - 1];
            // 16 points when the sender changes, 4 within one sender.
            const changes =
              previous !== undefined &&
              previous.kind !== "stamp" &&
              (previous.kind === "user") !== (row.kind === "user");
            return (
              <View key={`${row.kind}:${row.id}`} style={{ marginTop: changes ? 12 : 0 }}>
                <RowView row={row} />
              </View>
            );
          })}
        </View>
      );
  }

  return (
    <SafeAreaView edges={["top", "bottom"]} style={{ flex: 1, backgroundColor: c.bg }}>
      <Top
        state={state}
        taskKey={task.key}
        bot={bot}
        left={<BackButton label={`Back to ${bot.name}'s tasks`} onPress={onBack} />}
      />
      <ScrollView
        ref={scroller}
        testID="transcript"
        accessibilityLabel="Conversation"
        contentContainerStyle={{ paddingHorizontal: S["space-4"], paddingBottom: S["space-6"] }}
        scrollEventThrottle={64}
        onScroll={({ nativeEvent }) => {
          const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
          // Before the view has its height, nothing says where the reader is.
          if (layoutMeasurement.height === 0) return;
          atEnd.current =
            contentSize.height - (contentOffset.y + layoutMeasurement.height) < NEAR_END;
        }}
        onContentSizeChange={() => {
          if (atEnd.current) scroller.current?.scrollToEnd({ animated: false });
        }}
      >
        <TaskLine task={task} />
        {body}
      </ScrollView>
    </SafeAreaView>
  );
}
