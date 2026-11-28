// A turn the gateway started itself (presentation/gateway-event.ts): the gateway's line,
// centred, then "Text that came with it", a button that opens the note and the event's
// text as text. Both wrap at any text size.

import { useState } from "react";
import { Pressable, View } from "react-native";
import { gatewayEventView } from "../presentation/gateway-event.ts";
import { S, TOUCH, useTheme } from "../theme/index.ts";
import { ChevronIcon } from "./icons.tsx";
import { Txt } from "./ui.tsx";

export function GatewayEvent({ line, text }: { line: string; text: string }) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  const view = gatewayEventView(text, open);
  return (
    <View testID="gateway-event" style={{ alignItems: "center" }}>
      <Txt
        testID="event-line"
        size={S["text-sm"]}
        color="text-faint"
        style={{ textAlign: "center" }}
      >
        {line}
      </Txt>
      <Pressable
        testID="event-text-toggle"
        accessibilityRole="button"
        accessibilityLabel={view.toggle.label}
        accessibilityState={{ expanded: view.toggle.expanded }}
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
          {view.toggle.label}
        </Txt>
        <ChevronIcon color={c["text-faint"]} size={13} />
      </Pressable>
      {view.body && (
        <View
          testID="event-text"
          accessible
          accessibilityLabel={view.body.spoken}
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
            {view.body.note}
          </Txt>
          <Txt color="text-muted">{view.body.text}</Txt>
        </View>
      )}
    </View>
  );
}
