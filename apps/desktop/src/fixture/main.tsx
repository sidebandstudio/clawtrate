// The fixture mode: the real interface on fixed state, with no gateway and no
// host. It is its own Vite entry (vite.fixture.config.ts), so nothing here is
// part of the Electron renderer or the web preview's build.
//
// The address picks what to show:
//   ?scene=main            one of SCENES in bridge-fixture.ts, or of CARD_SCENES in cards.ts
//   &bot=otto&task=<key>   the bot and task to open (stored as the app stores them)
//   &panel=open            the Work pane
//   &theme=dark            the app's own theme override

import { App, BridgeProvider } from "@clawtrate/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createFixtureBridge, isScene } from "./bridge-fixture.ts";
import { CARD_TASKS, isCardScene } from "./cards.ts";
import { OPEN_BOT, OPEN_TASK } from "./data.ts";

const params = new URLSearchParams(location.search);

/** Write the selection the way the app stores it, before it first renders. */
function seedPreferences() {
  const write = (key: string, value: string) => {
    try {
      localStorage.setItem(`clawtrate.${key}`, value);
    } catch {
      // Storage may be unavailable; the app then opens its defaults.
    }
  };
  let stored: string | null = null;
  try {
    stored = localStorage.getItem("clawtrate.bot");
  } catch {
    // As above.
  }
  // A card scene opens its own task unless the address names one.
  const card = isCardScene(params.get("scene"))
    ? params.get("scene")!.startsWith("received")
      ? CARD_TASKS.marlow
      : CARD_TASKS.otto
    : null;
  const bot = params.get("bot") ?? card?.botId ?? (stored === null ? OPEN_BOT : null);
  const task =
    params.get("task") ?? card?.key ?? (bot === OPEN_BOT && !params.has("bot") ? OPEN_TASK : null);
  if (bot) write("bot", bot);
  if (bot && task) write("tasks", JSON.stringify({ [bot]: task }));
  const panel = params.get("panel");
  if (panel === "open" || panel === "closed") write("panel", panel);
}

seedPreferences();
document.documentElement.dataset.host = "web";
const sceneName = params.get("scene");
const bridge = createFixtureBridge(isScene(sceneName) ? sceneName : "main");
// For tests and manual checks: change the state from the console.
Object.assign(window, { clawtrateFixture: bridge });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BridgeProvider bridge={bridge}>
      <App info={bridge.info} />
    </BridgeProvider>
  </StrictMode>,
);
