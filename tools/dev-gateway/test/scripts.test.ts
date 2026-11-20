import { describe, expect, it } from "vitest";
import { chunkText } from "../src/fake-provider.ts";
import { normalizePrompt, planReply, type ChatMessage } from "../src/scripts.ts";
import { SEED_BOTS } from "../src/seed-data.ts";

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

  it("answers the memory question with the memory the task received, through an internal heading", () => {
    const plan = planReply(
      [
        {
          role: "system",
          content:
            "## /state/workspaces/otto/USER.md\nPrefers weekly summaries.\n## /state/workspaces/otto/MEMORY.md\nKeep a weekly release log.\n\n## Preferred days\nFridays.\n## /state/workspaces/otto/AGENTS.md\nOther rules.",
        },
        { role: "user", content: "[Mon 09:00] What do you remember about me?" },
      ],
      ALL_TOOLS,
    );
    const text = plan.find((step) => step.kind === "text");
    expect(text).toMatchObject({
      kind: "text",
      text: "Keep a weekly release log.\n\n## Preferred days\nFridays.",
    });
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

describe("the end-to-end runs the seed does not leave behind", () => {
  it("are scenarios: one narrates between its tool calls, one streams slowly", () => {
    // Three rounds: text and a listing, text and a write, then text.
    const narrate = planReply(
      [{ role: "user", content: "[Mon 09:00] #text #list #write" }],
      ALL_TOOLS,
    );
    expect(narrate.map((step) => step.kind)).toEqual(["text", "tool"]);
    const slow = planReply([{ role: "user", content: "#stream 8" }], ALL_TOOLS);
    // About ten seconds at its own pace.
    const ms = slow.reduce(
      (sum, step) =>
        step.kind === "text" || step.kind === "reasoning"
          ? sum + chunkText(step.text).length * (step.delayMs ?? 0)
          : sum,
      0,
    );
    expect(ms).toBeGreaterThan(9_000);
    expect(ms).toBeLessThan(14_000);
  });
});
