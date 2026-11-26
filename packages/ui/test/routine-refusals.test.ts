// A routine action the host refused says why: a changed connection, another gateway at the same
// address, or access. Only `admin` reads as access.

import { expect, it } from "vitest";
import { notSentDelete, notSentNote } from "../src/routines/refusals.ts";

const CHANGED = "since this was opened, so nothing was sent. Look again, then try again.";

it("a delete refused for another gateway at the same address says the connection changed, as a moved target does", () => {
  expect(notSentDelete("gateway")).toBe(`The connection changed ${CHANGED}`);
  expect(notSentDelete("changed")).toBe(`The connection changed ${CHANGED}`);
});

it("a delete refused below admin, or offline, says this connection can't change routines", () => {
  expect(notSentDelete("admin")).toBe("Nothing was sent: this connection can't change routines.");
  expect(notSentDelete("offline")).toBe("Nothing was sent: this connection can't change routines.");
});

it("a row's pause or run refused for another gateway says the connection changed; for access, only that nothing was sent", () => {
  expect(notSentNote("gateway")).toBe(`the connection changed ${CHANGED}`);
  expect(notSentNote("changed")).toBe(`the connection changed ${CHANGED}`);
  expect(notSentNote("admin")).toBe("nothing was sent.");
  expect(notSentNote("offline")).toBe("nothing was sent.");
});
