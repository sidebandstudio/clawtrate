// before_tool_call for every bot the plugin serves: it records the call's run
// (lib/runs.js), decides the call's hold (lib/holds.js), and refuses a held
// call whenever it can't decide it. Both OpenClaw versions also block a call
// when this hook throws or takes 15 seconds (their global hook runner runs
// before_tool_call fail-closed); the hook doesn't rely on that.

import { SAID, decide, describeHolds, holdOf } from "./holds.js";
import { createRuns, reachOf } from "./runs.js";

/** Routines' definitions as the gateway's cron_changed hook last reported them, newest last. */
export const DEFINITIONS_MAX = 512;
/** A routine that ended itself is kept this long, at most this many, oldest first out. */
export const ENDED = Object.freeze({
  namespace: "routines-ended",
  maxEntries: 256,
  overflowPolicy: "evict-oldest",
  defaultTtlMs: 90 * 24 * 60 * 60 * 1000,
});
export const DEFINITION_MAX_BYTES = 64 * 1024;
/** What a routine's definition holds that the gateway's hook doesn't report. */
export const NOT_REPORTED = Object.freeze([
  "delivery",
  "sessionKey",
  "deleteAfterRun",
  "failureAlert",
]);
const DEFINITIONS_KEY = Symbol.for("clawtrate-bots.definitions.v1");

export function createHooks(api, options = {}) {
  const runs = createRuns(api, { ...options, describeHolds });
  const slots = options.slots ?? globalThis;
  slots[DEFINITIONS_KEY] ??= new Map();
  const definitions = slots[DEFINITIONS_KEY];
  const ended = options.ended ?? api.runtime?.state?.openKeyedStore?.(ENDED);
  const config = () => options.config?.() ?? api.runtime?.config?.current?.() ?? {};
  const workspaceOf = (cfg, agentId) => {
    try {
      return api.runtime?.agent?.resolveAgentWorkspaceDir?.(cfg, agentId) ?? null;
    } catch {
      return null;
    }
  };

  api.on("cron_changed", (event) => {
    const id = typeof event?.jobId === "string" ? event.jobId : null;
    if (!id) return;
    if (event.action === "removed") return void definitions.delete(id);
    if (!event.job || typeof event.job !== "object") return;
    definitions.delete(id);
    definitions.set(id, event.job);
    while (definitions.size > DEFINITIONS_MAX) definitions.delete(definitions.keys().next().value);
  });

  /** Journals a routine that ends itself: its whole definition as the gateway reported it. */
  async function keepRoutine(jobId, run) {
    const job = definitions.get(jobId);
    if (!job || !ended) return false;
    // As JSON: the gateway's report leaves absent fields undefined, which the store refuses.
    const { state: _state, ...reported } = job;
    const definition = JSON.parse(JSON.stringify(reported));
    const entry = {
      jobId,
      agentId: run.agentId,
      runId: run.runId,
      definition,
      notReported: NOT_REPORTED,
      at: (options.now ?? Date.now)(),
    };
    if (Buffer.byteLength(JSON.stringify(entry)) > DEFINITION_MAX_BYTES) return false;
    await ended.registerIfAbsent(`${jobId}:${run.runId}`, entry);
    return true;
  }

  // A routine that ended itself, as journaled: what step 3's line and Undo read.
  api.registerGatewayMethod?.(
    "clawtrate-bots.routines.ended",
    async (opts) => {
      const jobId = typeof opts.params?.jobId === "string" ? opts.params.jobId : "";
      // Its entries' keys are `<jobId>:<runId>`, and ";" sorts right after ":".
      const rows =
        jobId && ended
          ? await ended.entriesInKeyRange({
              keyStartInclusive: `${jobId}:`,
              keyEndExclusive: `${jobId};`,
              limit: 16,
            })
          : [];
      const found = rows.filter((row) => row.value?.jobId === jobId).at(-1)?.value ?? null;
      opts.respond(true, { jobId, entry: found });
    },
    { scope: "operator.read" },
  );

  api.on("before_tool_call", async (event, ctx) => {
    let run;
    let decision;
    try {
      const seen = runs.sawCall(event, ctx);
      run = seen.run;
      const caller = ctx?.agentId ?? run?.agentId ?? null;
      const cfg = config();
      decision = decide({
        event,
        origin: seen.origin,
        run,
        caller,
        reach: reachOf(cfg, caller),
        workspaceDir: run?.workspaceDir ?? workspaceOf(cfg, caller),
      });
      if (decision.journalRoutine && !(await keepRoutine(decision.journalRoutine, run)))
        decision = { block: true, reason: SAID.cantKeep };
    } catch (error) {
      api.logger?.warn?.(
        `clawtrate-bots: couldn't check a ${event?.toolName} call: ${error?.message}`,
      );
      let held = true;
      try {
        held = holdOf(event, ctx?.agentId ?? null) !== null;
      } catch {
        // can't tell whether it is held: refuse
      }
      return held ? { block: true, blockReason: SAID.failed } : undefined;
    }
    runs.afterDecision(run, event, !decision.block, ctx);
    if (decision.block) return { block: true, blockReason: decision.reason };
    if (decision.approval)
      return {
        requireApproval: {
          ...decision.approval,
          severity: "warning",
          allowedDecisions: ["allow-once", "deny"],
        },
      };
    if (decision.params) return { params: decision.params };
    return undefined;
  });

  return { ...runs, definitions, keepRoutine };
}
