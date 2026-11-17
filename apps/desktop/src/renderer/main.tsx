import { App, BridgeProvider } from "@clawtrate/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createDesktopBridge } from "./bridge-desktop.ts";
import { createWebBridge } from "./bridge-web.ts";

async function boot() {
  const root = createRoot(document.getElementById("root")!);
  const api = window.clawtrateHost;
  document.documentElement.dataset.host = api ? "desktop" : "web";
  if (api) document.documentElement.dataset.platform = api.platform;
  try {
    const bridge = api ? await createDesktopBridge(api) : await createWebBridge();
    root.render(
      <StrictMode>
        <BridgeProvider bridge={bridge}>
          <App info={bridge.info} />
        </BridgeProvider>
      </StrictMode>,
    );
  } catch (error) {
    root.render(
      <main className="connect">
        <div className="panel" role="alert">
          <h2>Clawtrate could not start</h2>
          <p className="panel-lede">{error instanceof Error ? error.message : String(error)}</p>
        </div>
      </main>,
    );
  }
}

void boot();
