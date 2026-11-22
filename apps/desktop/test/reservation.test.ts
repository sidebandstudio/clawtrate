// A release run's reserved output: created exclusively with its marker, and
// accepted by the build only while it holds nothing else.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  freshReservation,
  RESERVATION_FILE,
  reserve,
  reservedBy,
} from "../packaging/reservation.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clawtrate-reservation-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("creates the folder only if no one has, with the owner's marker", () => {
  const folder = join(root, "dist");
  reserve(folder, "run-a");
  expect(reservedBy(folder, "run-a")).toBe(true);
  expect(reservedBy(folder, "run-b")).toBe(false);
  expect(() => reserve(folder, "run-b")).toThrow(expect.objectContaining({ code: "EEXIST" }));
  expect(reservedBy(folder, "run-a")).toBe(true);
});

it("lets a build start only from a reservation of its own that holds nothing else", () => {
  const folder = join(root, "out");
  reserve(folder, "run-a");
  expect(freshReservation(folder, "run-a")).toBe(true);
  expect(freshReservation(folder, "run-b")).toBe(false);
  expect(freshReservation(folder, undefined)).toBe(false);
  writeFileSync(join(folder, "app.zip"), "x");
  expect(freshReservation(folder, "run-a")).toBe(false);
  const unmarked = join(root, "unmarked");
  mkdirSync(unmarked);
  expect(freshReservation(unmarked, "run-a")).toBe(false);
  expect(RESERVATION_FILE.startsWith(".")).toBe(true);
});
