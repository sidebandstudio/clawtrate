import { describe, expect, it } from "vitest";
import { chunkText } from "../src/fake-provider.ts";
import { normalizePrompt, planReply, type ChatMessage } from "../src/scripts.ts";
import { NARRATING_PROMPT, SEED_BOTS, SLOW_PROMPT, UNSEEDED_TURNS } from "../src/seed-data.ts";

const ALL_TOOLS = new Set(["ls", "read", "write", "exec"]);

describe("normalizePrompt", () => {
  it("strips the gateway's timestamp prefix and runtime suffix", () => {
    expect(
      normalizePrompt("[Mon 2026-11-16 16:31 EST] hello\n\nRuntime: agent=main | host=x"),
    ).toBe("hello");
    expect(normalizePrompt("  plain  ")).toBe("plain");
  });
});

describe("planReply", () => {
  const otto = SEED_BOTS.find((bot) => bot.id === "otto")!;
  const turn = otto.tasks[0]!.turns[0]!;
  const user: ChatMessage = { role: "user", content: `[Mon 09:00] ${turn.prompt}` };

  it("plays the scripted rounds in order as tool results come back", () => {
    const first = planReply([{ role: "system", content: "x" }, user], ALL_TOOLS);
    expect(first).toEqual(turn.rounds[0]);
    const second = planReply(
      [user, { role: "assistant", content: null }, { role: "tool", content: "listing" }],
      ALL_TOOLS,
    );
    expect(second).toEqual(turn.rounds[1]);
  });

  it("is deterministic", () => {
    expect(planReply([user], ALL_TOOLS)).toEqual(planReply([user], ALL_TOOLS));
  });

  it("skips rounds whose tool the gateway did not offer", () => {
    const plan = planReply([user], new Set(["read"]));
    expect(plan.some((step) => step.kind === "tool" && step.name === "ls")).toBe(false);
  });

  it("never scripts a shell command", () => {
    const tools = SEED_BOTS.flatMap((bot) =>
      bot.tasks.flatMap((task) => task.turns.flatMap((t) => t.rounds.flat())),
    ).flatMap((step) => (step.kind === "tool" ? [step.name] : []));
    expect(new Set(tools)).toEqual(new Set(["ls", "read", "write"]));
  });

  it("answers unscripted prompts with a stable fallback", () => {
    const plan = planReply([{ role: "user", content: "something new" }], ALL_TOOLS);
    expect(plan.at(-1)).toMatchObject({ kind: "text" });
    expect(JSON.stringify(plan)).toContain("something new");
  });

  it("gives every scripted prompt a unique text", () => {
    const prompts = SEED_BOTS.flatMap((bot) =>
      bot.tasks.flatMap((task) => task.turns.map((t) => t.prompt)),
    );
    expect(new Set(prompts).size).toBe(prompts.length);
  });
});

describe("chunkText", () => {
  it("splits on word boundaries without losing text", () => {
    const text = "The quick brown fox jumps over the lazy dog, twice over.";
    const pieces = chunkText(text, 12);
    expect(pieces.join("")).toBe(text);
    expect(pieces.length).toBeGreaterThan(3);
  });
});

describe("prompts the seed does not send", () => {
  it("are scripted too: one narrates between its tool calls, one streams slowly", () => {
    const narrate = planReply(
      [{ role: "user", content: `[Mon 09:00] ${NARRATING_PROMPT}` }],
      ALL_TOOLS,
    );
    expect(narrate.map((step) => step.kind)).toEqual(["text", "tool"]);
    const slow = planReply([{ role: "user", content: SLOW_PROMPT }], ALL_TOOLS);
    expect(slow).toEqual(UNSEEDED_TURNS[1]!.rounds[0]);
    const text = slow[0]!.kind === "text" ? slow[0] : null;
    // About ten seconds at its own pace.
    expect(chunkText(text!.text).length * text!.delayMs!).toBeGreaterThan(8_000);
  });

  it("are not seeded", () => {
    const seeded = SEED_BOTS.flatMap((bot) => bot.tasks.flatMap((task) => task.turns));
    for (const turn of UNSEEDED_TURNS) expect(seeded).not.toContainEqual(turn);
  });
});
