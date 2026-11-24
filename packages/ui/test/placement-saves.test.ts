// Placement saves above Work (`RunsOn.tsx`): a save begun under a connection's fallback key
// before its gateway was confirmed still ends on the confirmed gateway, and the redirect that
// carries it is dropped once no such save is out.

import { describe, expect, it } from "vitest";
import {
  beginSave,
  beginWorkspaceSave,
  EMPTY_SAVES,
  endWorkspaceSave,
  finishSave,
  promoteScope,
} from "../src/machines/RunsOn.tsx";

describe("placement saves (F-046)", () => {
  it("keeps a fallback redirect only while a save begun under it is out, across reconnects", () => {
    let state = EMPTY_SAVES;
    for (const connection of ["first", "second", "third"]) {
      const fallback = `connection:${connection}`;
      state = beginSave(state, fallback);
      state = promoteScope(state, fallback, "gateway:g1");
      expect(state.entries["gateway:g1"]!.pending).toBe(1);
      expect(Object.keys(state.redirects)).toEqual([fallback]);
      // The save ends through its fallback key, on the confirmed gateway.
      state = finishSave(state, fallback, "otto");
      expect(state.entries["gateway:g1"]!.pending).toBe(0);
      expect(state.redirects).toEqual({});
    }
  });

  it("F-274: a workspace save out keeps the redirect after the command save ends, and settles on the confirmed gateway", () => {
    let state = beginWorkspaceSave(beginSave(EMPTY_SAVES, "connection:a"), "connection:a");
    state = promoteScope(state, "connection:a", "gateway:g1");
    expect(state.redirects["connection:a"]).toEqual({ to: "gateway:g1", pending: 2 });
    state = finishSave(state, "connection:a", "otto");
    expect(state.redirects["connection:a"]).toEqual({ to: "gateway:g1", pending: 1 });
    // Only command saves hold the picker.
    expect(state.entries["gateway:g1"]!.pending).toBe(0);
    const before = state.entries["gateway:g1"]!.workspaceSeq;
    state = endWorkspaceSave(state, "connection:a", true);
    expect(state.redirects).toEqual({});
    expect(state.entries["gateway:g1"]!.workspacePending).toBe(0);
    expect(state.entries["gateway:g1"]!.workspaceSeq).toBeGreaterThan(before);
    expect(state.entries["connection:a"]).toBeUndefined();
  });

  it("keeps a redirect until the last of its saves ends", () => {
    let state = beginSave(beginSave(EMPTY_SAVES, "connection:a"), "connection:a");
    state = promoteScope(state, "connection:a", "gateway:g1");
    state = finishSave(state, "connection:a", "otto");
    expect(state.redirects["connection:a"]).toEqual({ to: "gateway:g1", pending: 1 });
    state = finishSave(state, "connection:a", "pip");
    expect(state.redirects).toEqual({});
    expect(state.entries["gateway:g1"]!.pending).toBe(0);
  });
});
