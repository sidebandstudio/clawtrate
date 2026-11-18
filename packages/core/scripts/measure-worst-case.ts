// Measures the host's memory and serialisation time for a state filled to
// every bound, the documented worst case of `state` (docs/decisions.md). The
// table bounds JSON characters, not the process; this says what that costs.
//
//   node --expose-gc packages/core/scripts/measure-worst-case.ts
//
// Text is a character JavaScript stores in two bytes per character and JSON
// writes unescaped, the most memory per JSON character a bound admits. Each
// value is past its bound, and the client's own enforcement brings it within;
// every string is distinct, so none shares storage with another.
// Run on its own: other work on the machine moves the times, not the sizes.

import { type Bound } from "../src/bounds.ts";
import { STATE, WORST_STATE_CHARS, enforceState } from "../src/state-bounds.ts";
import type { ClawtrateState } from "../src/types.ts";

const WIDE = "\u4e2d";
let made = 0;
/** A distinct string of `count` wide characters: no two values share their storage, as real text would not. */
const wide = (count: number) => {
  const tag = (made += 1).toString(36);
  return WIDE.repeat(Math.max(0, count - tag.length)) + tag;
};

/** A value past `bound` in every dimension. */
function maximal(bound: Bound, variant = { n: 0 }): unknown {
  switch (bound.kind) {
    case "text":
    case "scalar":
      return wide(bound.max + 8);
    case "id":
      return "i".repeat(bound.max + 10);
    case "json":
      return { inner: wide(Math.max(0, bound.max - 12)) };
    case "list":
      return Array.from({ length: bound.max + 1 }, () => maximal(bound.item, variant));
    case "map": {
      const out: Record<string, unknown> = {};
      for (let i = 0; i < bound.max + 1; i += 1)
        out[`k${i}`.padEnd(Math.max(2, bound.key - 2), "k")] = maximal(bound.value, variant);
      return out;
    }
    case "object":
      return Object.fromEntries(
        Object.entries(bound.fields).map(([key, field]) => [key, maximal(field, variant)]),
      );
    case "union": {
      const tags = Object.keys(bound.variants);
      const tag = tags[(variant.n += 1) % tags.length]!;
      return { ...(maximal(bound.variants[tag]!, variant) as object), [bound.tag]: tag };
    }
  }
}

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with node --expose-gc");
const heap = () => {
  gc();
  gc();
  return process.memoryUsage();
};
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

const before = heap();
const state = enforceState(maximal(STATE) as ClawtrateState);
const after = heap();
let started = performance.now();
const json = JSON.stringify(state);
const stringifyMs = performance.now() - started;
started = performance.now();
structuredClone(state);
const cloneMs = performance.now() - started;
console.log(
  `state JSON characters: ${json.length.toLocaleString("en")} of ${WORST_STATE_CHARS.toLocaleString("en")} allowed`,
);
console.log(`heap held by the state: ${mb(after.heapUsed - before.heapUsed)}`);
console.log(`resident set after: ${mb(after.rss)} (before: ${mb(before.rss)})`);
console.log(`JSON.stringify of the whole state: ${stringifyMs.toFixed(0)} ms`);
console.log(
  `structuredClone of the whole state (an Electron IPC snapshot): ${cloneMs.toFixed(0)} ms`,
);
