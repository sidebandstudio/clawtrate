import { describe, expect, it } from "vitest";
import {
  checkExampleHistory,
  checkRecipientExchange,
  resultProblems,
  scriptedSteps,
} from "../src/examples.ts";
import { SCENARIO_EXAMPLES, type ScenarioExample } from "../src/seed-data.ts";

const example = (slug: string): ScenarioExample => SCENARIO_EXAMPLES.find((e) => e.slug === slug)!;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The scripted text of one of show-your-work's results. */
const resultText = (i: number) => example("show-your-work").results[i]!.content[0] as string;

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
      content: [{ type: "text", text: resultText(0) }],
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
      content: [{ type: "text", text: resultText(1) }],
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
    const wrong = clone(showYourWork());
    wrong[2]!.content = [{ type: "text", text: "wrong result" }];
    expect(checkExampleHistory(wrong, example("show-your-work"))).toEqual([
      expect.stringMatching(/^result 1 \(ls\) text differs from the script/),
    ]);
  });

  it("takes a result's error flag only as a boolean", () => {
    for (const flag of ["true", "", "false", 0, null]) {
      const rows = clone(showYourWork());
      (rows[2] as Record<string, unknown>).isError = flag;
      expect(checkExampleHistory(rows, example("show-your-work"))).toEqual([
        expect.stringMatching(/^result 1 \(ls\) has isError .*, expected false$/),
      ]);
    }
    const missing = clone(showYourWork());
    delete (missing[2] as Record<string, unknown>).isError;
    expect(checkExampleHistory(missing, example("show-your-work"))).toEqual([
      "result 1 (ls) has isError undefined, expected false",
    ]);
  });

  it("takes a command's duration only as a whole number of at least 0", () => {
    const expected = example("list-workspace").results;
    const row = (durationMs: unknown) => [
      {
        role: "toolResult",
        toolName: "exec",
        isError: false,
        content: [{ type: "text", text: expected[0]!.content[0] as string }],
        details: { exitCode: 0, durationMs, cwd: "/state/workspaces/otto" },
      },
    ];
    expect(resultProblems(row(12), expected)).toEqual([]);
    expect(resultProblems(row(0), expected)).toEqual([]);
    for (const bad of [-1, 1.5, "12", null, Number.NaN]) {
      expect(resultProblems(row(bad), expected)).toEqual([
        "result 1 (exec) details.durationMs differs",
      ]);
    }
  });

  it("refuses other arguments, a missing result or an empty one", () => {
    const moved = clone(showYourWork());
    (moved[1]!.content as { arguments?: unknown }[])[1]!.arguments = { path: "/" };
    expect(checkExampleHistory(moved, example("show-your-work"))).toEqual([
      expect.stringMatching(/^expected the scripted calls and arguments/),
    ]);
    const empty = clone(showYourWork());
    empty[2]!.content = [{ type: "text", text: "" }];
    expect(checkExampleHistory(empty, example("show-your-work"))).toEqual([
      expect.stringMatching(/^result 1 \(ls\) text differs/),
    ]);
    const missing = showYourWork().filter((row) => row.toolName !== "read");
    expect(checkExampleHistory(missing, example("show-your-work"))).toEqual(
      expect.arrayContaining([expect.stringMatching(/tool results/)]),
    );
  });

  it("checks the recipient's side of a bot-to-bot example", () => {
    const sender = "agent:pip:ask-marlow";
    const reply = example("main").finalText;
    const message = "#reply Could you look over the plan?";
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
        content: message,
      },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: reply }] },
    ];
    expect(checkRecipientExchange(rows, sender, message, reply)).toEqual([]);
    const changed = (f: (r: typeof rows) => void) => {
      const copy = clone(rows);
      f(copy);
      return checkRecipientExchange(copy, sender, message, reply);
    };
    expect(changed((r) => (r[2]!.role = "user"))).toEqual(["the forwarded message has role user"]);
    expect(
      changed((r) => ((r[2]!.provenance as { sourceTool: string }).sourceTool = "other")),
    ).toEqual([expect.stringMatching(/provenance/)]);
    expect(changed((r) => (r[2]!.content = "#reply other"))).toEqual([
      expect.stringMatching(/forwarded message is/),
    ]);
    expect(changed((r) => r.splice(3, 1))).toEqual([
      "the recipient's reply is not after the message",
    ]);
    expect(changed((r) => r.splice(2, 1))).toEqual([
      `expected one message from ${sender} in the recipient's history, found 0`,
    ]);
  });
});
