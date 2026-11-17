import { describe, expect, it } from "vitest";
import { checkExampleHistory, checkRecipientExchange, scriptedSteps } from "../src/examples.ts";
import { SCENARIO_EXAMPLES, type ScenarioExample } from "../src/seed-data.ts";

const example = (slug: string): ScenarioExample => SCENARIO_EXAMPLES.find((e) => e.slug === slug)!;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The show-your-work example's history as the gateway records it. */
function showYourWork() {
  const steps = scriptedSteps(example("show-your-work"));
  expect(steps.reasoning).toHaveLength(2);
  return [
    { role: "user", content: "Show your work: what is in your workspace?" },
    {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "thinking", thinking: steps.reasoning[0] },
        { type: "toolCall", id: "a", name: "ls", arguments: steps.calls[0]!.arguments },
      ],
    },
    {
      role: "toolResult",
      toolName: "ls",
      isError: false,
      content: [{ type: "text", text: '"AGENTS.md"' }],
    },
    {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "thinking", thinking: steps.reasoning[1] },
        { type: "toolCall", id: "b", name: "read", arguments: steps.calls[1]!.arguments },
      ],
    },
    {
      role: "toolResult",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "# Juniper" }],
    },
    {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: example("show-your-work").finalText }],
    },
  ];
}

describe("the seeded examples' verifier", () => {
  it("accepts the recorded example", () => {
    expect(checkExampleHistory(showYourWork(), example("show-your-work"))).toEqual([]);
  });

  it("refuses an example whose reasoning is missing", () => {
    const rows = showYourWork().map((row) =>
      Array.isArray(row.content)
        ? {
            ...row,
            content: row.content.filter((b) => (b as { type: string }).type !== "thinking"),
          }
        : row,
    );
    expect(checkExampleHistory(rows, example("show-your-work"))).toEqual([
      expect.stringMatching(/^expected reasoning/),
    ]);
  });

  it("refuses other arguments, a missing result or an empty one", () => {
    const moved = clone(showYourWork());
    (moved[1]!.content as { arguments?: unknown }[])[1]!.arguments = { path: "/" };
    expect(checkExampleHistory(moved, example("show-your-work"))).toEqual([
      expect.stringMatching(/^expected the scripted calls and arguments/),
    ]);
    const empty = clone(showYourWork());
    empty[2]!.content = [{ type: "text", text: "" }];
    expect(checkExampleHistory(empty, example("show-your-work"))).toContain(
      "a successful tool result is empty",
    );
    const missing = showYourWork().filter((row) => row.toolName !== "read");
    expect(checkExampleHistory(missing, example("show-your-work"))).toEqual(
      expect.arrayContaining([expect.stringMatching(/tool results/)]),
    );
  });

  it("checks the recipient's side of a bot-to-bot example", () => {
    const sender = "agent:pip:ask-marlow";
    const reply = example("main").finalText;
    const rows = [
      { role: "user", content: "Reply with a note on Saturday's plan." },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: reply }] },
      {
        role: "assistant",
        provenance: {
          kind: "inter_session",
          sourceSessionKey: sender,
          sourceTool: "sessions_send",
        },
        content: "#reply Could you look over the plan?",
      },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: reply }] },
    ];
    expect(checkRecipientExchange(rows, sender, "Could you look over the plan?", reply)).toEqual(
      [],
    );
    expect(
      checkRecipientExchange(rows.slice(0, 3), sender, "Could you look over the plan?", reply),
    ).toEqual(["the recipient's reply is not after the message"]);
    expect(
      checkRecipientExchange(rows.slice(0, 2), sender, "Could you look over the plan?", reply),
    ).toEqual([`the recipient has no message from ${sender}`]);
  });
});
