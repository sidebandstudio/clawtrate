import { GATEWAY_EVENT_WORDS as W } from "@clawtrate/core";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { S, TOUCH, useTheme } from "../theme/index.ts";
import { ChevronIcon } from "./icons.tsx";
import { Txt } from "./ui.tsx";

export function GatewayEvent({
  line,
  text,
  onDisclosureChange,
}: {
  line: string;
  text: string | undefined;
  onDisclosureChange?: (open: boolean, toggleY: number | null) => void;
}) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  const toggleY = useRef<number | null>(null);
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
        accessibilityLabel={W.label}
        accessibilityState={{ expanded: open }}
        accessibilityValue={open ? undefined : { text: "collapsed" }}
        onLayout={({ nativeEvent }) => {
          toggleY.current = nativeEvent.layout.y;
        }}
        onPress={() => {
          onDisclosureChange?.(!open, toggleY.current);
          setOpen(!open);
        }}
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
          {W.label}
        </Txt>
        <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
          <ChevronIcon color={c["text-faint"]} size={13} />
        </View>
      </Pressable>
      {open && (
        <View
          testID="event-text"
          accessible
          accessibilityLabel={`${W.attribution} ${text}`}
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
            {W.attribution}
          </Txt>
          <Txt color="text-muted">{text}</Txt>
        </View>
      )}
    </View>
  );
}
