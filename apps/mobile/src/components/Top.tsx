// The shell's top band (visual-language.md, sections 8 and 12): no bar, round
// controls that float, and in a bot's screens the title pill with its avatar
// and name between them; then the status strip.

import type { Bot, ClawtrateState } from "@clawtrate/core";
import { gatewayDot, gatewayState } from "@clawtrate/ui/gateway-state";
import type { ReactNode } from "react";
import { View } from "react-native";
import { S, TOUCH, useTheme } from "../theme/index.ts";
import { Avatar } from "./Avatar.tsx";
import { BackIcon, SettingsIcon } from "./icons.tsx";
import { StatusStrip } from "./Strip.tsx";
import { Dot, RoundButton, Txt } from "./ui.tsx";

export function Top({
  state,
  left,
  bot,
  taskKey,
}: {
  state: ClawtrateState;
  left: ReactNode;
  bot?: Bot;
  taskKey: string | null;
}) {
  const { c, scheme } = useTheme();
  return (
    <View
      style={{ paddingHorizontal: S["space-3"], gap: S["space-2"], paddingBottom: S["space-2"] }}
    >
      <View style={{ height: 56, flexDirection: "row", alignItems: "center", gap: S["space-3"] }}>
        {left}
        {bot && (
          <View
            testID="title-pill"
            accessible
            accessibilityLabel={bot.name}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: S["space-2"],
              height: 36,
              paddingLeft: 7,
              paddingRight: S["space-4"],
              borderRadius: 999,
              backgroundColor: c["bg-raised"],
              borderWidth: 1,
              borderColor:
                scheme === "dark" ? "rgba(255, 255, 255, 0.07)" : "rgba(17, 18, 19, 0.06)",
              maxWidth: 240,
              marginLeft: "auto",
              marginRight: "auto",
              transform: [{ translateX: -(TOUCH.roundButton + S["space-3"]) / 2 }],
            }}
          >
            <Avatar bot={bot} size={S["avatar-pill"]} />
            <Txt size={S["text-md"]} weight="medium" numberOfLines={1}>
              {bot.name}
            </Txt>
          </View>
        )}
      </View>
      <StatusStrip state={state} taskKey={taskKey} />
    </View>
  );
}

/** Home's round Settings button, with the gateway's presence on it as the dot. */
export function SettingsButton({ state, onPress }: { state: ClawtrateState; onPress: () => void }) {
  const { c } = useTheme();
  const words = gatewayState(state.connection);
  const dot = gatewayDot(words);
  return (
    <View>
      <RoundButton
        label={`Settings. Gateway ${words.toLowerCase()}.`}
        onPress={onPress}
        testID="settings-button"
      >
        <SettingsIcon color={c.text} />
      </RoundButton>
      <View
        testID={`connection-dot-${dot}`}
        pointerEvents="none"
        style={{
          position: "absolute",
          top: 1,
          right: 1,
          padding: 2,
          borderRadius: 7,
          backgroundColor: c.bg,
        }}
      >
        <Dot tone={dot === "disconnected" ? "off" : dot} />
      </View>
    </View>
  );
}

export function BackButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <RoundButton label={label} onPress={onPress} testID="back">
      <BackIcon color={c.text} />
    </RoundButton>
  );
}
