// The app: the connection screens until the gateway's bots have loaded, then
// Home, a bot's task list and a task's chat, with Settings as a sheet. The
// shell stays up through every reconnect once it has something to show. One
// screen shows at a time, except on iPhone Duo unfolded, where the list and
// the chat share the window (presentation/panes.ts).

import type { ConnectionError, Task } from "@clawtrate/core";
import { markSeen, type SeenMap } from "../../../packages/ui/src/unread.ts";
import { useCallback, useEffect, useState } from "react";
import { StatusBar, StyleSheet, useColorScheme, View, type ViewStyle } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { BotTasks } from "./screens/BotTasks.tsx";
import { Chat, NoChat } from "./screens/Chat.tsx";
import { Address, Pairing, Protocol, Setup, Welcome } from "./screens/Connect.tsx";
import { Home } from "./screens/Home.tsx";
import { Settings } from "./screens/Settings.tsx";
import {
  back,
  connectView,
  current,
  HOME,
  inShell,
  keptMismatch,
  panesFor,
  type Route,
} from "./navigation.ts";
import { panes } from "./presentation/panes.ts";
import { RuntimeContext, startRuntime, useClawtrateState } from "./runtime.ts";
import { useSwitcherProbe } from "./switcher-probe.ts";
import { ThemeContext, themeFor, useTheme } from "./theme/index.ts";
import { useWindowShape, WindowShapeProvider } from "./window-shape.tsx";

/** A clock for the rows' relative times: once a minute is enough. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Screens() {
  const state = useClawtrateState();
  const now = useMinuteClock();
  const theme = useTheme();
  const shape = useWindowShape();
  const [route, setRoute] = useState<Route>(HOME);
  const [addressOpen, setAddressOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mismatch, setMismatch] = useState<ConnectionError | null>(null);
  // What this viewer has read: the gateway's unread marks need write to change.
  const [seen, setSeen] = useState<SeenMap>({});
  const onRead = useCallback((task: Task) => setSeen((was) => markSeen(was, task)), []);

  const kept = keptMismatch(state, mismatch);
  if (kept !== mismatch) setMismatch(kept);

  const another = () => {
    setMismatch(null);
    setAddressOpen(true);
    setSettingsOpen(false);
    setRoute(HOME);
  };

  if (!inShell(state, kept)) {
    const { connection } = state;
    switch (connectView(state, kept, addressOpen)) {
      case "protocol":
        return <Protocol connection={connection} error={kept!} onAnother={another} />;
      case "pairing":
        return <Pairing connection={connection} onAnother={another} />;
      case "setup":
        return <Setup connection={connection} discovery={state.discovery} onAnother={another} />;
      case "address":
        return <Address connection={connection} onBack={() => setAddressOpen(false)} />;
      case "welcome":
        return <Welcome connection={connection} onConnect={() => setAddressOpen(true)} />;
    }
  }

  const found = current(route, state);
  const bot = found.name === "home" ? undefined : state.bots.find((b) => b.id === found.botId);
  const task =
    found.name === "task"
      ? (state.tasksByBot[found.botId] ?? []).find((t) => t.key === found.key)
      : undefined;
  // A task the list has not sent yet shows its bot's tasks until it arrives.
  const shown = found.name === "task" && !task ? back(found) : found;
  const layout = panes(shape);
  const show = panesFor(shown, layout.kind === "split");
  // Each pane keeps its key whichever way the window is split, so folding or
  // unfolding keeps the chat that is open, scrolled where it was.
  const place = (pane: "list" | "chat"): ViewStyle =>
    layout.kind === "split"
      ? { position: "absolute", top: 0, bottom: 0, left: layout[pane].x, width: layout[pane].width }
      : StyleSheet.absoluteFill;
  const list =
    show.list === "bot" && bot ? (
      <BotTasks
        state={state}
        bot={bot}
        seen={seen}
        now={now}
        openKey={show.chat === "task" && shown.name === "task" ? shown.key : null}
        onBack={() => setRoute(HOME)}
        onOpenTask={(key) => setRoute({ name: "task", botId: bot.id, key })}
      />
    ) : show.list ? (
      <Home
        state={state}
        seen={seen}
        now={now}
        onOpenBot={(botId) => setRoute({ name: "bot", botId })}
        onSettings={() => setSettingsOpen(true)}
      />
    ) : null;
  const chat =
    show.chat === "task" && shown.name === "task" && bot && task ? (
      <Chat
        state={state}
        bot={bot}
        task={task}
        now={now}
        onBack={() => setRoute(back(shown))}
        onRead={onRead}
      />
    ) : show.chat ? (
      <NoChat />
    ) : null;
  const divided = layout.kind === "split" && !layout.atFold;
  return (
    <View style={{ flex: 1, backgroundColor: theme.c.bg }}>
      {[
        list && (
          <View key="list" style={place("list")}>
            {list}
          </View>
        ),
        chat && (
          <View
            key="chat"
            style={[
              place("chat"),
              divided && {
                borderLeftWidth: StyleSheet.hairlineWidth,
                borderLeftColor: theme.c.border,
              },
            ]}
          >
            {chat}
          </View>
        ),
      ]}
      {show.list === "home" && (
        <Settings
          connection={state.connection}
          showChannelChats={state.showChannelChats === true}
          visible={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onForget={another}
        />
      )}
    </View>
  );
}

export function App({ switcherProbePort }: { switcherProbePort?: number }) {
  useSwitcherProbe(switcherProbePort);
  const [runtime] = useState(startRuntime);
  const scheme = useColorScheme();
  const theme = themeFor(scheme);
  return (
    <RuntimeContext.Provider value={runtime}>
      <ThemeContext.Provider value={theme}>
        <SafeAreaProvider>
          <StatusBar barStyle={theme.scheme === "dark" ? "light-content" : "dark-content"} />
          <WindowShapeProvider>
            <Screens />
          </WindowShapeProvider>
        </SafeAreaProvider>
      </ThemeContext.Provider>
    </RuntimeContext.Provider>
  );
}
