// The app's quit while setting up may still be draining (docs/design/setup.md
// §10): the first quit is held while setup closes and its programs end, every
// quit asked meanwhile is held too, and only once the drain has ended, or its
// bound has passed, does the app quit.

/**
 * A `before-quit` handler's gate. `drain` closes setup and resolves once its
 * operation and programs have ended or its bound has passed; `quit` asks the
 * app to quit again. Resolves, per quit, whether this one may go ahead.
 */
export function quitGate(
  drain: () => Promise<void>,
  quit: () => void,
): (event: { preventDefault: () => void }) => boolean {
  let stage: "running" | "draining" | "drained" = "running";
  return (event) => {
    if (stage === "drained") return true;
    event.preventDefault();
    if (stage === "draining") return false;
    stage = "draining";
    void drain()
      .catch(() => {})
      .then(() => {
        stage = "drained";
        quit();
      });
    return false;
  };
}
