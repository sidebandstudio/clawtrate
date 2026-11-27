// Stops the Electron app the standalone update check spawned.
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { askToClose } from "../../../../e2e-packaged/windows.ts";

export async function stopElectron(app: ChildProcess) {
  const { pid } = app;
  if (!pid || app.exitCode !== null || app.signalCode !== null) return;
  const deadline = AbortSignal.timeout(25_000);
  const failed = new AbortController();
  // Watched before any request, so an error a kill emits reaches this stop even
  // while another stop of the same app listens too.
  const exited = once(app, "exit", { signal: AbortSignal.any([deadline, failed.signal]) });
  // A request that throws ends the wait above with its error, so none throws past it.
  const send = (request: () => void) => {
    try {
      request();
    } catch (error) {
      failed.abort(error);
    }
  };
  // Through the handle Node holds for this child alone, never its PID, which
  // Windows can give another process once the app has exited.
  const force = () => app.kill("SIGKILL");
  const timer = setTimeout(() => send(force), 15_000);
  try {
    send(() => {
      if (process.platform === "win32") {
        if (askToClose(pid)) force();
      } else app.kill("SIGTERM");
    });
    await exited;
  } catch (error) {
    if (failed.signal.aborted) throw failed.signal.reason;
    if (deadline.aborted)
      throw new Error(`Electron PID ${pid} did not exit after forced shutdown`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
