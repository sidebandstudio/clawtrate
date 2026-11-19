// What the artifact scenarios hand over: made here, the same at every start,
// and the gateway's stored copy of the old route is the only one forgotten.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  elevationLog,
  forgetHandover,
  HANDOVER,
  handoverFiles,
  LARGE_BYTES,
  OLD_ROUTE_TEXT,
  PAGE_ID,
  seedHandover,
  trailChime,
  trailGuidePage,
} from "../src/handover.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "handover-"));
  made.push(dir);
  return dir;
};

describe("the handover files", () => {
  it(
    "are made by the tool, the same each time, at the sizes the scenarios name",
    { timeout: 120_000 },
    () => {
      const files = handoverFiles();
      expect(files).toEqual(handoverFiles());
      expect(elevationLog().length).toBe(LARGE_BYTES);
      const chime = trailChime();
      expect(chime.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(chime.length).toBe(44 + 8000 * 2 * 2);
      const png = files[HANDOVER.picture]!;
      expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(files[HANDOVER.photo]!.length).toBeGreaterThan(262_144);
    },
  );

  it("seeds the workspace and the canvas document the gateway reads", { timeout: 60_000 }, () => {
    const state = temp();
    const workspace = join(state, "workspace");
    seedHandover(workspace, state);
    expect(readFileSync(join(workspace, HANDOVER.gone), "utf8")).toBe(OLD_ROUTE_TEXT);
    const page = join(state, "canvas", "documents", PAGE_ID);
    expect(JSON.parse(readFileSync(join(page, "manifest.json"), "utf8"))).toMatchObject({
      id: PAGE_ID,
      localEntrypoint: "index.html",
      cspSandbox: "scripts",
    });
    expect(readFileSync(join(page, "index.html"), "utf8")).toBe(trailGuidePage());
  });

  it("forgets only the stored copy whose bytes are the old route's", () => {
    const state = temp();
    const store = join(state, "media", "outgoing", "originals");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "a.md"), OLD_ROUTE_TEXT);
    writeFileSync(join(store, "b.md"), `${OLD_ROUTE_TEXT}more`);
    writeFileSync(join(store, "c.png"), Buffer.from([137, 80, 78, 71]));
    expect(forgetHandover(state)).toBe(1);
    expect(readdirSync(store).sort()).toEqual(["b.md", "c.png"]);
    expect(forgetHandover(state)).toBe(0);
    expect(forgetHandover(temp())).toBe(0);
  });
});
