// What the app switcher keeps of the app is a picture of its screen when it
// leaves the foreground, stored in the app's container. So as soon as the app
// is no longer active, a cover with the mark goes over everything: the snapshot
// shows the cover, never a transcript or Settings. The Settings sheet is its
// own window, so it has a cover of its own.

import { useEffect, useState } from "react";
import { AppState, Image, StyleSheet, View } from "react-native";
import MARK from "../../assets/logo-mark.png";
import { covered } from "../privacy.ts";
import { useTheme } from "../theme/index.ts";

export function PrivacyCover() {
  const { c } = useTheme();
  const [state, setState] = useState<string | null>(AppState.currentState ?? null);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", setState);
    return () => subscription.remove();
  }, []);
  if (!covered(state)) return null;
  return (
    <View
      testID="privacy-cover"
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: c.bg, alignItems: "center", justifyContent: "center" },
      ]}
    >
      <Image source={MARK} style={{ width: 56, height: 56, borderRadius: 16 }} />
    </View>
  );
}
