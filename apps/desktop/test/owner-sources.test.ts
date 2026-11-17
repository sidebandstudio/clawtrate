// The second guard on what the host keeps works on the source, not on live
// objects: every collection that can outlive the call that made it (a
// `new Map`, `Set`, `WeakMap` or `WeakSet`, or an array, kept in a class
// field, at module level, or in a variable a later-running function captures)
// must be either a field the retention registry names (`owners.ts`) or on the
// allowlist below, each entry with its bound or its lifetime in one line.
// `owner-scan.ts` finds them. A false alarm is the intended cost: it adds a line here.

import { ownerClassFields } from "@clawtrate/core";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scan, scanText } from "./owner-scan.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
/** The engine, and the hosts that hold its bridge. */
const SCANNED = ["packages/core/src", "apps/desktop/src/web-host", "apps/desktop/src/main"];

/** Collections kept outside the registry's fields: why each one is bounded. */
const ALLOWED: Record<string, string> = {
  // Static: built once from constants, never grown.
  "packages/core/src/approvals.ts:APPROVAL_KINDS": "static, three kinds",
  "packages/core/src/approvals.ts:DECISIONS": "static, three decisions",
  "packages/core/src/cards.ts:T3_CODE_TOOLS": "static, T3 Code's seven tool names",
  "packages/core/src/client.ts:REQUESTED_SCOPES": "static, one scope",
  "packages/core/src/client.ts:CLIENT_CAPS": "static, one cap",
  "packages/core/src/client.ts:APPROVAL_CAPS": "static, three caps",
  "packages/core/src/client.ts:APPROVAL_SOURCES": "static, three list readers",
  "packages/core/src/runs.ts:TERMINAL_RUN_STATES": "static, the terminal run states",
  "packages/core/src/runs.ts:TIMEOUT_PHASES": "static, five phases",
  "packages/core/src/runs.ts:HARD_TIMEOUT_PHASES": "static, three phases",
  "packages/core/src/approval-refusals.ts:REFUSED_DECISION_ANSWERS":
    "static, the six answers that establish a decision was not applied",
  "packages/core/src/approval-refusals.ts:LEGACY": "static, two method names",
  "packages/core/src/runs.ts:UNORDINARY_QUESTION_FIELDS":
    "static, the eight question fields the ordinary card cannot show",
  "packages/core/src/scopes.ts:READ_SCOPES": "static, one scope",
  "packages/core/src/scopes.ts:INTERACTIVE_SCOPES": "static, four scopes",
  "packages/core/src/scopes.ts:IMPLIED_BY_WRITE": "static, the scopes write implies",
  "packages/core/src/state-bounds.ts:SESSION_ROW_FIELDS": "static, the twenty-one fields read",
  "packages/core/src/state-bounds.ts:SESSION_ROW_IDS": "static, five field names",
  // Weak: an entry lives only as long as the object it is keyed by.
  "packages/core/src/bounds.ts:bounded": "weak, keyed by retained objects",
  "packages/core/src/bounds.ts:draws": "weak, keyed by bounds, which are static",
  "packages/core/src/runs.ts:sizes": "weak, keyed by retained objects",
  "packages/core/src/bounds.ts:drawsOn>out":
    "static, one set of pool names per bound, kept in `draws`",
  // Capped.
  "packages/core/src/bounds.ts:unknownKeys":
    "capped at `MAX_UNKNOWN_KEYS` (64) keys of 96 characters",
  // One read: kept while one list read is in flight, then dropped.
  "packages/core/src/client.ts:afterActivityOnce>steered":
    "transient, the held messages released as steers in one synchronous update, at most the task's outbox (16)",
  "packages/core/src/client.ts:backfillApprovalKind>pendingBefore":
    "one list read; the task's pending approvals, at most `MAX_PENDING_APPROVAL_COUNT`",
  "packages/core/src/client.ts:backfillApprovalKind>mine":
    "one list read; the bounded cards of that list that belong to the task",
  "packages/core/src/client.ts:backfillQuestions>pendingBefore":
    "one list read; the task's pending questions, at most `MAX_PENDING_QUESTIONS_PER_TASK`",
  // The renderer's side of the web bridge, in a browser tab, not the host.
  "packages/core/src/remote-bridge.ts:createRemoteBridge>listeners":
    "renderer; one per subscription, removed by its unsubscribe",
  "packages/core/src/remote-bridge.ts:createRemoteBridge>pending":
    "renderer; commands awaiting an answer, each answered by the host or rejected when the socket closes",
  "packages/core/src/remote-bridge.ts:createRemoteBridge>wanted":
    "renderer; the tasks the host accepted as open, at most `MAX_VIEWER_OPEN_TASKS`, plus opens in flight",
  // Hosts.
  "apps/desktop/src/main/index.ts:main>sessions":
    "one bridge session per open window, removed when it closes",
  "apps/desktop/src/web-host/server.ts:<anonymous>>chunks":
    "one upload's body while it arrives, within its declared length, dropped at the deadline",
};

describe("the source keeps no collection outside the registry", () => {
  const found = scan(
    SCANNED.map((dir) => `${root}${dir}`),
    root,
  );
  const fields = ownerClassFields();

  it("every class field holding a collection is one the registry names", () => {
    const unnamed = found
      .filter((each) => each.kind === "field")
      .filter((each) => !(fields[each.owner!] ?? []).includes(each.name))
      .map((each) => each.where);
    expect([...new Set(unnamed)]).toEqual([]);
  });

  it("every collection kept at module level or in a closure is on the allowlist, with its reason", () => {
    const unlisted = found
      .filter((each) => each.kind !== "field" && !(each.where in ALLOWED))
      .map((each) => `${each.where} (line ${each.line})`);
    expect(unlisted).toEqual([]);
  });

  it("names nothing that is no longer there", () => {
    const where = new Set(found.map((each) => each.where));
    expect(Object.keys(ALLOWED).filter((each) => !where.has(each))).toEqual([]);
    for (const [name, list] of Object.entries(fields)) {
      for (const field of list)
        expect(
          where.has(found.find((each) => each.owner === name && each.name === field)?.where ?? ""),
          `${name}.${field}`,
        ).toBe(true);
    }
  });

  it("finds a collection a closure keeps, as the review's hidden store map did", () => {
    const text = `
      export function createStore() {
        let value = 0;
        const hidden = new Map<string, string>();
        return { get: () => { hidden.set("k", "v"); return value; } };
      }
      export function local(items: number[]) {
        const seen = new Set<number>();
        items.forEach((item) => seen.add(item));
        return seen.size;
      }
      class Grown { private readonly added: string[] = []; }
      const moduleLevel = new WeakSet<object>();
    `;
    expect(scanText("probe.ts", text).map((each) => each.where)).toEqual([
      "probe.ts:createStore>hidden",
      "probe.ts:Grown.added",
      "probe.ts:moduleLevel",
    ]);
  });
});
