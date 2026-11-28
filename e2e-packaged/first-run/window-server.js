/* global ObjC, $ */
// Run by osascript -l JavaScript on the hosted Mac. The window server can see
// system alerts even when System Events has no accessibility tree for them.
ObjC.import("CoreGraphics");

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- osascript calls run.
function run() {
  const list = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID);
  const windows = [];
  // Core Graphics returns CF references. Cast before reading each NSDictionary.
  const count = $.CFArrayGetCount(list);
  for (let index = 0; index < count; index += 1) {
    const window = ObjC.castRefToObject($.CFArrayGetValueAtIndex(list, index));
    const value = (key) => ObjC.unwrap(window.objectForKey($(key))) ?? null;
    windows.push({
      id: value("kCGWindowNumber"),
      pid: value("kCGWindowOwnerPID"),
      owner: value("kCGWindowOwnerName"),
      title: value("kCGWindowName"),
      layer: value("kCGWindowLayer"),
      bounds: ObjC.deepUnwrap(window.objectForKey($("kCGWindowBounds"))),
    });
  }
  return JSON.stringify(windows);
}
