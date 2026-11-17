// Which question records the ordinary card may answer (conversation.md
// section 13): decided on the whole record when it is admitted, so a record
// too long to keep raw is still routed by what it really carries.
import { describe, expect, it } from "vitest";
import {
  applyQuestionRequested,
  emptyActivity,
  isOrdinaryQuestionRecord,
  QUESTION,
  type EngineContext,
} from "../src/index.ts";
import { enforce } from "../src/bounds.ts";

const ctx = (): EngineContext => ({ now: 1_000 }) as EngineContext;

function record(question: Record<string, unknown>, more: Record<string, unknown>[] = []) {
  return {
    id: "ask_1",
    questions: [
      {
        questionId: "keep",
        header: "Keep",
        question: "How long should I keep it?",
        options: [{ label: "A week", description: "Until Monday" }, { label: "A month" }],
        isOther: true,
        ...question,
      },
      ...more,
    ],
    sessionKey: "agent:otto:main",
    runId: "run-1",
    createdAtMs: 1,
    expiresAtMs: 2,
    status: "pending",
  };
}

describe("ordinary question records", () => {
  it("takes one to three questions of two to four labelled options, with or without a description", () => {
    expect(isOrdinaryQuestionRecord(record({}))).toBe(true);
    expect(
      isOrdinaryQuestionRecord(
        record({ multiSelect: true, options: [1, 2, 3, 4].map((n) => ({ label: `O${n}` })) }),
      ),
    ).toBe(true);
    const second = {
      questionId: "two",
      header: "Two",
      question: "And?",
      options: [{ label: "x" }, { label: "y" }],
    };
    expect(isOrdinaryQuestionRecord(record({}, [second, { ...second, questionId: "three" }]))).toBe(
      true,
    );
    // Flags that ask for nothing do not disqualify a record.
    expect(
      isOrdinaryQuestionRecord(record({ allowEmpty: false, isSecret: false, defaultAnswers: [] })),
    ).toBe(true);
  });

  it("refuses option counts outside two to four, and options that carry more than a label and a description", () => {
    expect(isOrdinaryQuestionRecord(record({ options: [{ label: "only" }] }))).toBe(false);
    expect(isOrdinaryQuestionRecord(record({ options: [] }))).toBe(false);
    expect(
      isOrdinaryQuestionRecord(
        record({ options: [1, 2, 3, 4, 5].map((n) => ({ label: `O${n}` })) }),
      ),
    ).toBe(false);
    for (const extra of [
      { value: "v" },
      { thumbnail: "data:image/png;base64,AA" },
      { resourceUri: "file:///x" },
      { preview: { kind: "text", text: "x" } },
    ]) {
      expect(
        isOrdinaryQuestionRecord(record({ options: [{ label: "a", ...extra }, { label: "b" }] })),
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it("refuses links, forms, resources, lines, empty answers, defaults and secrets", () => {
    for (const extra of [
      { url: "https://example.org" },
      { presentation: "form" },
      { resource: { uri: "file:///x" } },
      { answerFormat: "lines" },
      { allowEmpty: true },
      { defaultAnswers: ["A week"] },
      { isSecret: true },
      { secretStore: { name: "TOKEN", kind: "secret" } },
      { secretStoreExisting: { updatedAtMs: 1 } },
    ]) {
      expect(isOrdinaryQuestionRecord(record(extra)), JSON.stringify(extra)).toBe(false);
    }
    // Every question must pass: one form among ordinary ones makes the record unanswerable here.
    const form = {
      questionId: "two",
      header: "Two",
      question: "Sign in",
      options: [],
      presentation: "form",
    };
    expect(isOrdinaryQuestionRecord(record({}, [form]))).toBe(false);
    expect(isOrdinaryQuestionRecord({ ...record({}), questions: [] })).toBe(false);
  });

  it("marks the card when it is admitted, and keeps the mark when the raw record is too long to keep", () => {
    const long = record({ question: "x".repeat(4_000) });
    const activity = applyQuestionRequested(emptyActivity, long, ctx());
    expect(activity.questions[0]!.ordinary).toBe(true);
    const kept = enforce(QUESTION, activity.questions[0]!) as (typeof activity.questions)[0];
    expect(kept.raw).toBeNull();
    expect(kept.ordinary).toBe(true);

    const form = applyQuestionRequested(emptyActivity, record({ presentation: "form" }), ctx());
    expect(form.questions[0]!.ordinary).toBe(false);
  });
});
