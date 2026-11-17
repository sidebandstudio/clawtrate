// The fixture mode: the real interface on fixed state, with no gateway and no
// host. It is its own Vite entry (vite.fixture.config.ts), so nothing here is
// part of the Electron renderer or the web preview's build.
//
// The address picks what to show:
//   ?scene=main            one of SCENES in bridge-fixture.ts
//   &bot=otto&task=<key>   the bot and task to open (stored as the app stores them)
//   &panel=open            the Work pane
//   &theme=dark            the app's own theme override
//   &pins=main,otto        pinned bots, in order (this device's rail arrangement)
//   &hidden=marlow         hidden bots
//   &sort=name             the rail's sort order: recent, name or manual

import { App, BridgeProvider } from "@clawtrate/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createFixtureBridge, isScene } from "./bridge-fixture.ts";
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
  const bot = params.get("bot") ?? (stored === null ? OPEN_BOT : null);
  const task = params.get("task") ?? (bot === OPEN_BOT && !params.has("bot") ? OPEN_TASK : null);
  if (bot) write("bot", bot);
  if (bot && task) write("tasks", JSON.stringify({ [bot]: task }));
  const panel = params.get("panel");
  if (panel === "open" || panel === "closed") write("panel", panel);
  const list = (name: string) => params.get(name)?.split(",").filter(Boolean);
  if (params.has("pins") || params.has("hidden") || params.has("sort")) {
    write(
      "roster",
      JSON.stringify({
        pinned: list("pins") ?? [],
        hidden: list("hidden") ?? [],
        sort: params.get("sort") ?? "recent",
        manual: list("order") ?? [],
      }),
    );
  }
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
