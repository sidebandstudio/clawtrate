// A check-ins draft sends only what the person touched, against the base it
// disclosed, and moves that base only when rebased after a conflict
// (packages/ui/src/check-ins/draft.ts). The words a cadence is shown in are
// exact (words.ts).

import type { CheckInsState } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { draftToSave, openDraft, rebase, type Draft } from "../src/check-ins/draft.ts";
import { cadence, choiceWords } from "../src/check-ins/words.ts";

const state = (main: { every: string; prompt: string | null }, kept = false): CheckInsState => ({
  status: "ready",
  error: null,
  gatewayId: "gw-1",
  scheduler: true,
  jobs: [
    {
      botId: "main",
      enabled: true,
      everyMs: main.every === "24h" ? 86_400_000 : 1_800_000,
      nextRunAtMs: null,
    },
  ],
  settings: kept ? [] : [{ botId: "main", ...main, promptCut: false }],
  defaults: {
    inherited: kept ? ["main", "otto"] : [],
    inheritedCut: false,
    every: "30m",
    everyCut: false,
    prompt: null,
    promptCut: false,
  },
  save: null,
});

describe("F-201 a check-ins draft", () => {
  it("F-201: after a conflict on the cadence, a prompt the person never edited is not sent, whatever the gateway's prompt became", () => {
    let draft: Draft = openDraft(state({ every: "30m", prompt: "A" }), "main")!;
    draft = { ...draft, choice: "daily", touched: { ...draft.touched, every: true } };
    expect(draftToSave(draft)).toMatchObject({ every: "24h", prompt: null });
    // Another client set the cadence and the prompt; the first save conflicted.
    draft = rebase(draft, state({ every: "2h", prompt: "B" }));
    expect(draft.prompt).toBe("B");
    expect(draftToSave(draft)).toEqual({
      gatewayId: "gw-1",
      every: "24h",
      prompt: null,
      was: { every: "2h", prompt: "B" },
      kept: [],
    });
  });

  it("F-201: the bots a draft said it would also write are what its save sends until it is rebased", () => {
    const draft = openDraft(state({ every: "30m", prompt: null }, true), "pip")!;
    expect(draft.base.kept.map((each) => each.botId)).toEqual(["main", "otto"]);
    const later = { ...state({ every: "30m", prompt: null }, true) };
    later.defaults = { ...later.defaults!, inherited: ["main", "otto", "quill"] };
    // A refresh behind the dialog changes nothing the draft claims.
    expect(
      draftToSave({ ...draft, choice: "daily", touched: { every: true, prompt: false } }).kept,
    ).toHaveLength(2);
    expect(rebase(draft, later).base.kept).toHaveLength(3);
  });

  it("F-201: an edited prompt is sent even if the gateway's prompt is now too long to edit, so the save is a conflict, not a silent drop", () => {
    let draft = openDraft(state({ every: "30m", prompt: "A" }), "main")!;
    draft = { ...draft, prompt: "Mine", touched: { every: false, prompt: true } };
    expect(draftToSave(draft).prompt).toBe("Mine");
    const cut = state({ every: "30m", prompt: "x".repeat(4_000) });
    cut.settings = [{ ...cut.settings![0]!, promptCut: true }];
    const after = rebase(draft, cut);
    expect(after.touched.prompt).toBe(false);
    expect(draftToSave(after).prompt).toBeNull();
  });

  it("F-201: an edit the person made and undid sends nothing", () => {
    const draft = openDraft(state({ every: "30m", prompt: "A" }), "main")!;
    expect(
      draftToSave({
        ...draft,
        choice: "asneeded",
        prompt: "A",
        touched: { every: true, prompt: true },
      }),
    ).toMatchObject({ every: null, prompt: null });
  });

  it("is not opened while nothing says which gateway the check-ins are from", () => {
    expect(
      openDraft({ ...state({ every: "30m", prompt: null }), gatewayId: null }, "main"),
    ).toBeNull();
  });
});

describe("F-201 check-in words", () => {
  it("F-201: a cadence is said exactly, in seconds when it is not whole minutes", () => {
    expect(cadence(90_000)).toBe("90 seconds");
    expect(cadence(1_000)).toBe("1 second");
    expect(cadence(1_800_000)).toBe("30 minutes");
    expect(cadence(5_400_000)).toBe("90 minutes");
    expect(cadence(7_200_000)).toBe("2 hours");
    expect(cadence(1_500)).toBe("1,500 milliseconds");
  });

  it("F-201: As needed says its prompt asks for quiet only when the prompt is the gateway's own", () => {
    expect(choiceWords("asneeded", "Juniper", true)).toContain("stay quiet");
    expect(choiceWords("asneeded", "Juniper", false)).not.toContain("quiet");
  });
});
