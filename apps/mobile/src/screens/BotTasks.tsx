// A bot's task list (visual-language.md, section 12): the bot's avatar and name,
// then its task rows at touch size with the title, the time and at most one
// mark. Back returns to Home. "New task" needs a connection that writes, which
// this build does not ask for, so it is not shown.

import type { Bot, ClawtrateState } from "@clawtrate/core";
import { noTasksBody, TASK_WORDS } from "@clawtrate/ui/summary";
import type { SeenMap } from "@clawtrate/ui/unread";
import { Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Avatar } from "../components/Avatar.tsx";
import { StateMark } from "../components/StateMark.tsx";
import { BackButton, Top } from "../components/Top.tsx";
import { Txt, UnreadDot } from "../components/ui.tsx";
import { taskRows } from "../lists.ts";
import { S, TOUCH, useTheme } from "../theme/index.ts";

export function BotTasks({
  state,
  bot,
  seen,
  now,
  onBack,
  onOpenTask,
}: {
  state: ClawtrateState;
  bot: Bot;
  seen: SeenMap;
  now: number;
  onBack: () => void;
  onOpenTask: (key: string) => void;
}) {
  const { c } = useTheme();
  const tasks = state.tasksByBot[bot.id];
  const rows = taskRows(tasks ?? [], seen, now);
  return (
    <SafeAreaView edges={["top"]} style={{ flex: 1, backgroundColor: c.bg }}>
      <Top
        state={state}
        taskKey={null}
        left={<BackButton label={TASK_WORDS.back} onPress={onBack} />}
      />
      <ScrollView
        testID={`bot-tasks-${bot.id}`}
        accessibilityLabel={`${bot.name}'s tasks`}
        contentContainerStyle={{ paddingHorizontal: S["space-2"], paddingBottom: S["space-8"] }}
      >
        <View style={{ alignItems: "center", gap: S["space-2"], paddingVertical: S["space-4"] }}>
          <Avatar bot={bot} size={S["avatar-hero"]} primary={bot.isDefault} />
          <Txt testID="bot-name" size={TOUCH.bodyText} weight="medium" accessibilityRole="header">
            {bot.name}
          </Txt>
          {bot.theme && (
            <Txt size={S["text-sm"]} color="text-faint">
              {bot.theme}
            </Txt>
          )}
        </View>
        {rows.map((row) => (
          <Pressable
            key={row.task.key}
            testID={`task-${row.task.key}`}
            accessibilityRole="button"
            accessibilityLabel={row.spoken}
            onPress={() => onOpenTask(row.task.key)}
            style={({ pressed }) => ({
              minHeight: TOUCH.taskRow,
              flexDirection: "row",
              alignItems: "center",
              gap: S["space-3"],
              paddingHorizontal: S["space-3"],
              borderRadius: S["radius-sm"],
              backgroundColor: pressed ? c["bg-hover"] : "transparent",
            })}
          >
            <Txt
              size={S["text-base"]}
              color={row.unread || row.state === "working" ? "text" : "text-muted"}
              numberOfLines={1}
              style={{ flex: 1 }}
            >
              {row.title}
            </Txt>
            {row.time !== "" && (
              <Txt size={S["text-xs"]} color="text-faint" style={{ fontVariant: ["tabular-nums"] }}>
                {row.time}
              </Txt>
            )}
            <View style={{ width: 12, alignItems: "center" }}>
              {row.state ? <StateMark state={row.state} /> : row.unread ? <UnreadDot /> : null}
            </View>
          </Pressable>
        ))}
        {tasks === undefined && (
          <Txt size={S["text-sm"]} color="text-faint" style={{ padding: S["space-3"] }}>
            {TASK_WORDS.loading}
          </Txt>
        )}
        {tasks !== undefined && rows.length === 0 && (
          <View style={{ padding: S["space-3"], gap: S["space-1"] }}>
            <Txt weight="medium">{TASK_WORDS.none}</Txt>
            <Txt size={S["text-sm"]} color="text-faint">
              {noTasksBody(bot.name)}
            </Txt>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
