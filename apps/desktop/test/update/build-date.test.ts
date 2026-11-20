// The build's release date, from the constant the build writes to the engine
// that counts F-010 from it. electron-vite replaces `__CLAWTRATE_RELEASE_DATE__`
// with the build's value; here the same value is a global set before the module
// is loaded, which is what the replaced text evaluates to.

import { afterEach, describe, expect, it, vi } from "vitest";
import { updateDefines } from "../../packaging/update-defines.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("the build's release date", () => {
  it("is the defined constant, and the production engine counts F-010 from it", async () => {
    const defines = updateDefines({ SOURCE_DATE_EPOCH: "1700000000" }, new Date());
    vi.stubGlobal("__CLAWTRATE_RELEASE_DATE__", JSON.parse(defines.__CLAWTRATE_RELEASE_DATE__!));
    vi.resetModules();
    const info = await import("../../src/main/update/build-info.ts");
    expect(info.BUILD_RELEASE_DATE).toBe("2023-11-14T22:13:20.000Z");
    const engine = info.productionUpdateEngine({
      currentVersion: "0.1.0",
      downloadDir: "unused",
      platform: "darwin",
      arch: "arm64",
    });
    vi.spyOn(engine, "newer", "get").mockReturnValue({
      version: "0.2.0",
      releaseDate: "2023-11-29T00:00:00.000Z",
    });
    expect(engine.updateRequired(new Date("2023-11-28T22:13:20.000Z"))).toBe(false);
    expect(engine.updateRequired(new Date("2023-11-28T22:13:20.001Z"))).toBe(true);
  });
});
