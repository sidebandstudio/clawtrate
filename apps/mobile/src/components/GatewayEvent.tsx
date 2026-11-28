import { useState } from "react";
import { Pressable, View } from "react-native";
import { S, TOUCH, useTheme } from "../theme/index.ts";
import { ChevronIcon } from "./icons.tsx";
import { Txt } from "./ui.tsx";

// Keep the disclosure copy in step with packages/ui/src/GatewayEventLine.tsx.
const LABEL = "Text that came with it";
const ATTRIBUTION =
  "Written by whatever started this turn (a command, a bot or another app), not by the gateway or Clawtrate.";

export function GatewayEvent({ line, text }: { line: string; text: string | undefined }) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  const systemLine = (
    <Txt testID="event-line" size={S["text-sm"]} color="text-faint" style={{ textAlign: "center" }}>
      {line}
    </Txt>
  );
  if (text === undefined) return systemLine;

  return (
    <View testID="gateway-event" style={{ alignItems: "center" }}>
      {systemLine}
      <Pressable
        testID="event-text-toggle"
        accessibilityRole="button"
        accessibilityLabel={LABEL}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((was) => !was)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          maxWidth: "100%",
          minHeight: TOUCH.taskRow,
          paddingHorizontal: 14,
          borderRadius: 999,
          backgroundColor: pressed ? c["bg-selected"] : "transparent",
        })}
      >
        <Txt size={S["text-sm"]} color="text-faint" style={{ flexShrink: 1 }}>
          {LABEL}
        </Txt>
        <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
          <ChevronIcon color={c["text-faint"]} size={13} />
        </View>
      </Pressable>
      {open && (
        <View
          testID="event-text"
          accessible
          accessibilityLabel={`${ATTRIBUTION} ${text}`}
          style={{
            alignSelf: "stretch",
            gap: S["space-2"],
            paddingVertical: 9,
            paddingHorizontal: 14,
            borderRadius: S["radius-lg"],
            backgroundColor: c["bg-bubble"],
          }}
        >
          <Txt size={S["text-sm"]} color="text-muted">
            {ATTRIBUTION}
          </Txt>
          <Txt color="text-muted">{text}</Txt>
        </View>
      )}
    </View>
  );
}
