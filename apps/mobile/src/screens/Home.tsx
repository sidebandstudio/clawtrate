// Home (visual-language.md, section 12): the bots, pinned tiles first, then
// rows at touch size with the avatar, the name, the newest task's line, the
// time, the unread dot and the state mark. A row does not unfold; it is the
// bot's summary and opens the bot's task list. Pulling the list down asks the
// gateway for its bots and tasks again, as Retry now does.

import type { ClawtrateState } from "@clawtrate/core";
import { LIST_WORDS } from "@clawtrate/ui/summary";
import type { SeenMap } from "@clawtrate/ui/unread";
import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Avatar } from "../components/Avatar.tsx";
import { SettingsButton, Top } from "../components/Top.tsx";
import { Txt, UnreadDot } from "../components/ui.tsx";
import { StateMark } from "../components/StateMark.tsx";
import { homeModel, type BotRow } from "../lists.ts";
import { useRuntime } from "../runtime.ts";
import { S, TOUCH, useTheme } from "../theme/index.ts";

function Row({ row, onOpen }: { row: BotRow; onOpen: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable
      testID={`bot-${row.bot.id}`}
      accessibilityRole="button"
      accessibilityLabel={row.spoken}
      onPress={onOpen}
      style={({ pressed }) => ({
        minHeight: TOUCH.row,
        flexDirection: "row",
        alignItems: "center",
        gap: S["space-3"],
        paddingHorizontal: 10,
        borderRadius: S["radius-lg"],
        backgroundColor: pressed ? c["bg-hover"] : "transparent",
      })}
    >
      <Avatar
        bot={row.bot}
        size={TOUCH.avatarRow}
        primary={row.primary}
        state={row.state === "working" ? "working" : "idle"}
      />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: S["space-2"] }}>
          <Txt size={TOUCH.bodyText} weight="medium" numberOfLines={1} style={{ flexShrink: 1 }}>
            {row.name}
          </Txt>
          {row.label && (
            <View
              style={{
                backgroundColor: c["bg-bubble"],
                borderRadius: 999,
                paddingHorizontal: 8,
                paddingVertical: 1,
                flexShrink: 2,
              }}
            >
              <Txt
                testID={`bot-label-${row.bot.id}`}
                size={S["text-xs"]}
                color="text-faint"
                numberOfLines={1}
              >
                {row.label}
              </Txt>
            </View>
          )}
          <Txt
            testID={`bot-time-${row.bot.id}`}
            size={S["text-xs"]}
            color="text-faint"
            style={{ marginLeft: "auto", fontVariant: ["tabular-nums"] }}
          >
            {row.time}
          </Txt>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: S["space-2"] }}>
          {row.state && <StateMark state={row.state} />}
          <Txt
            testID={`bot-preview-${row.bot.id}`}
            size={S["text-md"]}
            color={row.waiting ? "warn" : "text-muted"}
            numberOfLines={1}
            style={{ flex: 1 }}
          >
            {row.preview}
          </Txt>
          {row.unread && <UnreadDot />}
        </View>
      </View>
    </Pressable>
  );
}

function Tile({ row, onOpen }: { row: BotRow; onOpen: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable
      testID={`pin-${row.bot.id}`}
      accessibilityRole="button"
      accessibilityLabel={row.spoken}
      onPress={onOpen}
      style={({ pressed }) => ({
        width: "33.333%",
        alignItems: "center",
        gap: 6,
        paddingVertical: 10,
        borderRadius: S["radius-lg"],
        backgroundColor: pressed ? c["bg-hover"] : "transparent",
      })}
    >
      <View>
        <Avatar bot={row.bot} size={S["avatar-pin"]} primary={row.primary} />
        {row.state && (
          <View
            style={{
              position: "absolute",
              top: -2,
              right: -2,
              padding: 2,
              borderRadius: 8,
              backgroundColor: c.bg,
            }}
          >
            <StateMark state={row.state} />
          </View>
        )}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "90%" }}>
        <Txt size={S["text-sm"]} numberOfLines={1}>
          {row.name}
        </Txt>
        {row.unread && <UnreadDot />}
      </View>
    </Pressable>
  );
}

export function Home({
  state,
  seen,
  now,
  onOpenBot,
  onSettings,
}: {
  state: ClawtrateState;
  seen: SeenMap;
  now: number;
  onOpenBot: (botId: string) => void;
  onSettings: () => void;
}) {
  const { send } = useRuntime();
  const { c } = useTheme();
  const [refreshing, setRefreshing] = useState(false);
  const model = homeModel(state, seen, now);
  const refresh = async () => {
    setRefreshing(true);
    try {
      // Connected, this reloads the bots and tasks; otherwise it reconnects now.
      await send({ type: "retry" });
    } catch {
      // The strip says what went wrong.
    } finally {
      setRefreshing(false);
    }
  };
  const empty = state.bots.length === 0;
  return (
    <SafeAreaView edges={["top"]} style={{ flex: 1, backgroundColor: c.bg }}>
      <Top
        state={state}
        taskKey={null}
        left={<SettingsButton state={state} onPress={onSettings} />}
      />
      <ScrollView
        testID="home"
        accessibilityLabel="Bots"
        contentContainerStyle={{ paddingHorizontal: S["space-2"], paddingBottom: S["space-8"] }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      >
        {model.pinned.length > 0 && (
          <View
            testID="pin-grid"
            style={{ flexDirection: "row", flexWrap: "wrap", marginBottom: S["space-2"] }}
          >
            {model.pinned.map((row) => (
              <Tile key={row.bot.id} row={row} onOpen={() => onOpenBot(row.bot.id)} />
            ))}
          </View>
        )}
        {model.rows.map((row) => (
          <Row key={row.bot.id} row={row} onOpen={() => onOpenBot(row.bot.id)} />
        ))}
        {model.sections.map((section) => (
          <View key={section.name}>
            <Txt
              size={S["text-sm"]}
              color="text-faint"
              style={{ marginTop: 14, marginBottom: 6, paddingHorizontal: 10 }}
            >
              {section.name}
            </Txt>
            {section.rows.map((row) => (
              <Row key={row.bot.id} row={row} onOpen={() => onOpenBot(row.bot.id)} />
            ))}
          </View>
        ))}
        {empty && (
          <View
            style={{ padding: S["space-5"], gap: S["space-1"] }}
            accessibilityState={{ busy: state.discovery.status === "loading" }}
          >
            <Txt weight="medium">
              {state.discovery.status === "loading"
                ? LIST_WORDS.loadingTitle
                : LIST_WORDS.emptyTitle}
            </Txt>
            <Txt size={S["text-sm"]} color="text-faint">
              {state.discovery.status === "loading" ? LIST_WORDS.loadingBody : LIST_WORDS.emptyBody}
            </Txt>
          </View>
        )}
        {state.discovery.partial && (
          <Txt size={S["text-sm"]} color="text-faint" style={{ padding: 10 }}>
            {LIST_WORDS.partial}
          </Txt>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
