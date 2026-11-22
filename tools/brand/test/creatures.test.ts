// The design prototype draws the creatures from a copy of the shared spec;
// the copy must be the spec as it stands.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CREATURES_PATH, creaturesScript, SPEC_PATH } from "../src/make-creatures.ts";

describe("the prototype's creature spec", () => {
  it("is the shared spec with its types stripped (run `pnpm brand:creatures` after changing it)", () => {
    expect(readFileSync(CREATURES_PATH, "utf8")).toBe(
      creaturesScript(readFileSync(SPEC_PATH, "utf8")),
    );
  });

  it("exposes the spec's functions to the page", () => {
    const window: Record<string, Record<string, unknown>> = {};
    new Function("window", readFileSync(CREATURES_PATH, "utf8"))(window);
    const spec = window.ClawtrateCreatures!;
    expect(typeof spec.avatarScene).toBe("function");
    expect((spec.defaultAvatar as (id: string) => { family: string })("otto").family).toBe(
      "clawling",
    );
  });
});
