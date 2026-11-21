// Scripted scheduled jobs (routines) for a development gateway. The
// gateway's scheduler is off here (`cron.enabled: false`), so a job never
// fires on its schedule; `cron.run {mode: "force"}` runs one now, and the
// scripted model answers the directive in its message like any other turn.
// Results stay with the run (`delivery: {mode: "none"}`): a gateway with no
// channel fails the default delivery after the work has succeeded.
//
// `pnpm dev-gateway routines --instance <name>` adds them; the end-to-end
// checks add their own copies with `scriptedRoutine`.

/** Calls one gateway method with the instance's own operator credentials. */
export type GatewayCall = (method: string, params: unknown) => Promise<unknown>;

export type ScriptedRoutine = {
  name: string;
  agentId: string;
  schedule: Record<string, unknown>;
  sessionTarget: "isolated";
  wakeMode: "now";
  payload: { kind: "agentTurn"; message: string };
  delivery: { mode: "none" };
};

const job = (
  name: string,
  agentId: string,
  schedule: Record<string, unknown>,
  message: string,
): ScriptedRoutine => ({
  name,
  agentId,
  schedule,
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message },
  delivery: { mode: "none" },
});

/** The sample routines: a weekday digest that shows its steps, and a slow weekly check. */
export const SCRIPTED_ROUTINES: ScriptedRoutine[] = [
  job(
    "Morning digest",
    "marlow",
    { kind: "cron", expr: "0 8 * * 1-5", tz: "America/New_York" },
    "Summarise the notes I added yesterday, and list anything I need to answer today. #steps",
  ),
  job(
    "Weekly backup check",
    "otto",
    { kind: "cron", expr: "30 3 * * 0", tz: "America/New_York" },
    "Check last night's backup finished. #slow 3",
  ),
];

/** A routine of the sample's shape under another name, for a check that needs one of its own. */
export function scriptedRoutine(
  name: string,
  agentId = "marlow",
  message = "#steps",
): ScriptedRoutine {
  return job(name, agentId, { kind: "every", everyMs: 3_600_000 }, message);
}

/** Add each sample routine the gateway does not list by name yet; returns the ids of all of them. */
export async function addScriptedRoutines(call: GatewayCall): Promise<string[]> {
  const listed = (await call("cron.list", { includeDisabled: true, limit: 200 })) as {
    jobs?: Array<{ id: string; name?: string }>;
  };
  const ids: string[] = [];
  for (const routine of SCRIPTED_ROUTINES) {
    const existing = listed.jobs?.find((each) => each.name === routine.name);
    ids.push(existing ? existing.id : ((await call("cron.add", routine)) as { id: string }).id);
  }
  return ids;
}
