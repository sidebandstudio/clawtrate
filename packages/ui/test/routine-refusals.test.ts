// A routine action the host refused says why: a changed connection, another gateway at the same
// address, or access. Only `admin` reads as access.

import { expect, it } from "vitest";
import { notSentDelete, notSentNote, runNoteWords, switchNote } from "../src/routines/refusals.ts";

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

// #848: the words the engine gives a write whose answer was lost, as it gives them.
const CUT = "The connection changed before the gateway answered.";
const LATE = "The gateway didn't answer in time.";

it("#848: a pause or resume whose answer was lost is not confirmed, never couldn't, with what the read back found; a refusal is the gateway's", () => {
  // A dropped connection and a stopped client give the same words: nothing can be read back.
  expect(
    switchNote("pause", {
      status: "unknown",
      error: `${CUT} Clawtrate couldn't read the routine back, so whether it was paused isn't known.`,
    }),
  ).toBe(
    "Not confirmed. The connection changed before the gateway answered. Clawtrate couldn't read the routine back, so whether it was paused isn't known.",
  );
  expect(
    switchNote("resume", {
      status: "unknown",
      error: `${LATE} Read back just now, it is still paused: the change hasn't taken, or not yet.`,
    }),
  ).toBe(
    "Not confirmed. The gateway didn't answer in time. Read back just now, it is still paused: the change hasn't taken, or not yet.",
  );
  expect(switchNote("pause", { status: "refused", error: "cron busy" })).toBe(
    "Couldn't pause: cron busy",
  );
  expect(switchNote("pause", { status: "not-sent", reason: "offline" })).toBe(
    "Couldn't pause: nothing was sent.",
  );
});

it("#848: a Run now whose answer was lost is not confirmed, never couldn't, with what the read back found; a refusal is the gateway's", () => {
  expect(
    runNoteWords(
      {
        status: "unknown",
        error: `${CUT} Clawtrate couldn't read the routine back, so whether a run started isn't known.`,
      },
      false,
    ),
  ).toBe(
    "Not confirmed. The connection changed before the gateway answered. Clawtrate couldn't read the routine back, so whether a run started isn't known.",
  );
  expect(
    runNoteWords(
      {
        status: "unknown",
        error: `${LATE} Read back just now, no run is under way: this one may still start, or may already have finished.`,
      },
      false,
    ),
  ).toBe(
    "Not confirmed. The gateway didn't answer in time. Read back just now, no run is under way: this one may still start, or may already have finished.",
  );
  expect(runNoteWords({ status: "failed", error: "cron busy" }, false)).toBe(
    "Couldn't start a run: cron busy",
  );
});
