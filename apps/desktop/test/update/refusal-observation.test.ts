import { afterEach, expect, it, vi } from "vitest";
import { observeRefusal } from "./refusal-observation.ts";

afterEach(() => {
  vi.restoreAllMocks();
});
const clock =
  (...times: number[]) =>
  () =>
    times.shift()!;

it("logs a matched refusal's reason and wall time once the assertion settles", async () => {
  const lines: string[][] = [];
  const held = Promise.withResolvers<string>();
  const observed = observeRefusal(
    "artifact-changed",
    () => held.promise,
    clock(10.2, 1_321.7),
    (...line) => lines.push(line),
  );
  await Promise.resolve();
  expect(lines).toEqual([]);
  held.resolve("what the host said");
  await observed;
  expect(lines).toEqual([
    ["Refusal assertion", '{"reason":"artifact-changed","outcome":"matched","ms":1312}'],
  ]);
});

it("logs an assertion that ended unmatched and rethrows its own rejection", async () => {
  const lines: string[][] = [];
  const failure = new Error("Expected: mac-archive, Received: false");
  await expect(
    observeRefusal(
      "mac-archive",
      () => Promise.reject(failure),
      clock(0, 5_004.4),
      (...line) => lines.push(line),
    ),
  ).rejects.toBe(failure);
  expect(lines).toEqual([
    ["Refusal assertion", '{"reason":"mac-archive","outcome":"unmatched","ms":5004}'],
  ]);
});

it("keeps the assertion's result when its line can't be written", async () => {
  const failure = new Error("Expected: installer-version");
  const broken = () => {
    throw new Error("pipe closed");
  };
  await expect(
    observeRefusal("installer-version", () => Promise.reject(failure), clock(0, 1), broken),
  ).rejects.toBe(failure);
  await expect(
    observeRefusal("installer-version", async () => undefined, clock(0, 1), broken),
  ).resolves.toBeUndefined();
});

it("times by performance.now and writes to the console by default", async () => {
  vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(350.6);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await observeRefusal("no-installer-path", async () => undefined);
  expect(log.mock.calls).toEqual([
    ["Refusal assertion", '{"reason":"no-installer-path","outcome":"matched","ms":251}'],
  ]);
});
