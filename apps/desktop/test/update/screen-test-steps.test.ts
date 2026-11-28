import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readSteps, timeStep } from "./screen-test-steps.ts";

const profiles: string[] = [];
const profile = () => {
  const dir = mkdtempSync(join(tmpdir(), "clawtrate-update-steps-"));
  profiles.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of profiles.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const clock =
  (...times: number[]) =>
  () =>
    times.shift()!;
const at = (ms: number) => new Date(ms).toISOString();

it("times each step, and gives a start without an end no duration", async () => {
  const dir = profile();
  await timeStep(
    dir,
    "folders",
    async () => undefined,
    () => "made",
    clock(1_000, 1_311),
  );
  const held = Promise.withResolvers<boolean>();
  const reading = timeStep(
    dir,
    "read-back",
    () => held.promise,
    (proof) => (proof ? "read" : "wrong size"),
    clock(1_400, 7_000),
  );
  // No line is unreadable, yet the app may have ended or failed to write the end.
  expect(readSteps(dir)).toEqual([
    { step: "folders", at: at(1_000), ms: 311, outcome: "made" },
    { step: "read-back", at: at(1_400), endUnknown: true },
  ]);
  held.resolve(true);
  await reading;
  expect(readSteps(dir)).toEqual([
    { step: "folders", at: at(1_000), ms: 311, outcome: "made" },
    { step: "read-back", at: at(1_400), ms: 5_600, outcome: "read" },
  ]);
});

it("records a step that threw by its signal or code, never its message, and rethrows", async () => {
  const dir = profile();
  const killed = Object.assign(new Error("Command failed: C:\\Users\\someone\\file.exe"), {
    killed: true,
    signal: "SIGTERM",
  });
  await expect(
    timeStep(
      dir,
      "read-back",
      () => Promise.reject(killed),
      () => "read",
      clock(0, 120_000),
    ),
  ).rejects.toBe(killed);
  await expect(
    timeStep(
      dir,
      "folders",
      () => Promise.reject(new Error("C:\\Users\\someone")),
      () => "made",
      clock(120_001, 120_002),
    ),
  ).rejects.toThrow();
  expect(readSteps(dir)).toEqual([
    { step: "read-back", at: at(0), ms: 120_000, outcome: "threw SIGTERM" },
    { step: "folders", at: at(120_001), ms: 1, outcome: "threw" },
  ]);
});

it("keeps the records around a torn line, and the next app's first record whole", async () => {
  const dir = profile();
  await timeStep(
    dir,
    "folders",
    async () => undefined,
    () => "made",
    clock(1_000, 1_300),
  );
  // An app ended while a read-back ran, and while writing a line; the next launch writes on.
  void timeStep(
    dir,
    "read-back",
    () => new Promise(() => {}),
    () => "read",
    clock(1_400),
  );
  appendFileSync(join(dir, "update-steps.jsonl"), '{"step":"read-');
  void timeStep(
    dir,
    "read-back",
    () => new Promise(() => {}),
    () => "read",
    clock(2_000),
  );
  await timeStep(
    dir,
    "folders",
    async () => undefined,
    () => "made",
    clock(2_100, 2_400),
  );
  expect(readSteps(dir)).toEqual([
    { step: "folders", at: at(1_000), ms: 300, outcome: "made" },
    { step: "read-back", at: at(1_400), endUnknown: true },
    // Counted, never copied.
    { unreadable: 1 },
    { step: "read-back", at: at(2_000), endUnknown: true },
    { step: "folders", at: at(2_100), ms: 300, outcome: "made" },
  ]);
});

it("counts a line still being written as unreadable, and gives null without a log", async () => {
  const dir = profile();
  expect(readSteps(dir)).toBeNull();
  void timeStep(
    dir,
    "read-back",
    () => new Promise(() => {}),
    () => "read",
    clock(10),
  );
  appendFileSync(join(dir, "update-steps.jsonl"), '{"step":"read-back","at":10,"ms"');
  expect(readSteps(dir)).toEqual([
    { step: "read-back", at: at(10), endUnknown: true },
    { unreadable: 1 },
  ]);
});
