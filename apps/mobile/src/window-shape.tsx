// The window's shape as UIKit reports it to the app's own native view
// (apps/mobile/modules/clawtrate-layout): mounted once under the screens, it
// fills the window and sends its size, hinge, size class, bar edge, safe area
// and reserved regions whenever one changes. Before its first report there is
// no shape, and the app shows the phone's stack.

import { requireNativeView } from "expo";
import { createContext, useContext, useState, type ReactNode } from "react";
import { StyleSheet, type ViewProps } from "react-native";
import type { WindowShape } from "./presentation/panes.ts";

const LayoutView = requireNativeView<
  ViewProps & { onLayoutChange: (event: { nativeEvent: WindowShape }) => void }
>("ClawtrateLayout");

const ShapeContext = createContext<WindowShape | null>(null);

export function WindowShapeProvider({ children }: { children: ReactNode }) {
  const [shape, setShape] = useState<WindowShape | null>(null);
  return (
    <ShapeContext.Provider value={shape}>
      <LayoutView
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={StyleSheet.absoluteFill}
        onLayoutChange={({ nativeEvent }) => setShape(nativeEvent)}
      />
      {children}
    </ShapeContext.Provider>
  );
}

export function useWindowShape(): WindowShape | null {
  return useContext(ShapeContext);
}
