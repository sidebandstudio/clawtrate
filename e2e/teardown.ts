// What a failed real-gateway check leaves behind, cleared before the next check runs. The
// suites are not serial, so the next check runs on the same gateway: a run still going, a
// message the gateway still holds, a pending approval or an open question would reach it.
//
// What a check touched is read from the gateway's own records, not from a list the check
// keeps: every task updated since the check began (a message to another bot updates the
// recipient's task too), and every approval and question asked since then. The checks change
// no gateway setting except the cards spec's saved "Always allow" rule for `sleep 6`, which
// only the check that saves it reads.

/** One gateway method, with credentials that see every device's approvals. */
export type GatewayCall = <T>(method: string, params: unknown) => Promise<T>;

type Listed = { createdAtMs?: number };

/**
 * Stop every run and drop every held message in the tasks updated since `since`, until the
 * gateway shows each idle; then deny the approvals and cancel the questions asked since then.
 * Throws, naming what is left, when a task is still busy after `waitMs` (a minute).
 */
export async function leaveIdle(call: GatewayCall, since: number, waitMs = 60_000): Promise<void> {
  const listed = await call<{ sessions?: Array<{ key: string; updatedAt?: number | null }> }>(
    "sessions.list",
    { limit: 500 },
  );
  const touched = new Set<string>();
  for (const row of listed.sessions ?? []) {
    if ((row.updatedAt ?? 0) >= since) touched.add(row.key);
  }
  const left: string[] = [];
  for (const key of touched) {
    const deadline = Date.now() + waitMs;
    let idle = false;
    while (!idle && Date.now() < deadline) {
      await call("chat.abort", { sessionKey: key }).catch(() => {});
      const history = await call<{
        inFlightRun?: unknown;
        pendingInputs?: { items?: unknown[] };
      }>("chat.history", { sessionKey: key, limit: 1 }).catch(() => null);
      idle =
        history !== null &&
        !history.inFlightRun &&
        (history.pendingInputs?.items ?? []).length === 0;
      if (!idle) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!idle) left.push(`a run or held message in ${key}`);
  }
  const asked = (each: Listed) => (each.createdAtMs ?? 0) >= since;
  const approvals = await call<Array<Listed & { id: string }>>("exec.approval.list", {});
  for (const approval of approvals.filter(asked)) {
    await call("exec.approval.resolve", { id: approval.id, decision: "deny" }).catch(() => {});
  }
  const questions = await call<{ questions?: Array<Listed & { id: string; status?: string }> }>(
    "question.list",
    {},
  );
  for (const question of (questions.questions ?? []).filter(
    (each) => each.status === "pending" && asked(each),
  )) {
    await call("question.resolve", { id: question.id, cancel: true }).catch(() => {});
  }
  const stillAsked = (await call<Array<Listed & { id: string }>>("exec.approval.list", {})).filter(
    asked,
  );
  for (const approval of stillAsked) left.push(`approval ${approval.id}`);
  const stillOpen = (
    (
      await call<{ questions?: Array<Listed & { id: string; status?: string }> }>(
        "question.list",
        {},
      )
    ).questions ?? []
  ).filter((each) => each.status === "pending" && asked(each));
  for (const question of stillOpen) left.push(`question ${question.id}`);
  if (left.length > 0) throw new Error(`a failed check left ${left.join(", ")}`);
}
