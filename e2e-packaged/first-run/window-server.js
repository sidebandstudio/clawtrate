/* global ObjC, $ */
// Run by osascript -l JavaScript on the hosted Mac. The window server can see
// system alerts even when System Events has no accessibility tree for them.
ObjC.import("CoreGraphics");

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- osascript calls run.
function run() {
  // kCGWindowListOptionOnScreenOnly, with kCGNullWindowID.
  const raw = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(1, 0));
  if (!Array.isArray(raw)) throw new Error("macOS returned no on-screen window list.");
  return JSON.stringify(
    raw.map((window) => ({
      id: window.kCGWindowNumber,
      pid: window.kCGWindowOwnerPID,
      owner: window.kCGWindowOwnerName ?? null,
      title: window.kCGWindowName ?? null,
      layer: window.kCGWindowLayer,
      bounds: window.kCGWindowBounds,
    })),
  );
}
