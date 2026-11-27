// What a development gateway's process tree holds (#845). The gateway runs the stand-in coding
// agent (`coding-agent-mcp.ts`) as a stdio MCP server, one for each task that has had a turn,
// each under two processes of OpenClaw's own (`service-child-relay.js`, then
// `service-child-group-anchor.js`). With `mcp.sessionIdleTtlMs` it ends a task's server once the
// task has been idle that long. Without it, every task kept its server until the gateway stopped.
//
// `status`, `stop` and the end-to-end teardown report the count, and say so when servers last
// longer than an idle limit allows. A report never fails a command: a loaded machine can be slow
// to end a server, and a task in use keeps its server for as long as it is used.

import { spawnSync } from "node:child_process";

/** How long a task's server outlives the task's last turn: the gateway's `mcp.sessionIdleTtlMs`. */
export const CODING_AGENT_IDLE_MS = 60_000;
/** How often the gateway ends idle servers: a fixed minute in OpenClaw 2026.10.6 and 2026.11.10. */
export const IDLE_SWEEP_MS = 60_000;
/**
 * A server this old has outlived several idle limits, so its task was in use the whole time or
 * the server was not ended. Five minutes is over twice the longest an idle server should last.
 */
export const LASTING_SERVER_MS = 5 * 60_000;
/** More lasting servers than this is reported: more tasks than any check keeps in use that long. */
export const LASTING_SERVER_LIMIT = 4;

export type ProcessRow = { pid: number; ppid: number; ageMs: number; command: string };

/** `ps`'s elapsed time, `[[dd-]hh:]mm:ss`, in milliseconds; null when it is not one. */
export function parseElapsed(text: string): number | null {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return null;
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return (
    (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000
  );
}

/** Rows of `ps -o pid=,ppid=,etime=,command=`; lines it cannot read are left out. */
export function parseProcessTable(stdout: string): ProcessRow[] {
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    const ageMs = match ? parseElapsed(match[3]!) : null;
    return match && ageMs !== null
      ? [{ pid: Number(match[1]), ppid: Number(match[2]), ageMs, command: match[4]! }]
      : [];
  });
}

/** Every process on the machine, or null when `ps` could not list them. */
export function readProcessTable(): ProcessRow[] | null {
  const result = spawnSync("ps", ["-axww", "-o", "pid=,ppid=,etime=,command="], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  return parseProcessTable(result.stdout);
}

/** The processes under `root`, children before grandchildren. */
export function descendants(rows: readonly ProcessRow[], root: number): ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row]);
  const found: ProcessRow[] = [];
  const seen = new Set([root]);
  for (let queue = [root]; queue.length > 0;) {
    const next: number[] = [];
    for (const pid of queue) {
      for (const child of byParent.get(pid) ?? []) {
        if (seen.has(child.pid)) continue;
        seen.add(child.pid);
        found.push(child);
        next.push(child.pid);
      }
    }
    queue = next;
  }
  return found;
}

const isCodingAgent = (command: string) => /(^|[\s/])coding-agent-mcp\.ts(\s|$)/.test(command);

export type ChildrenCount = {
  /** Every process under the gateway. */
  processes: number;
  /** The stand-in coding agent's servers among them. */
  servers: number;
  /** Servers older than LASTING_SERVER_MS. */
  lasting: number;
};

export function countChildren(rows: readonly ProcessRow[], gatewayPid: number): ChildrenCount {
  const under = descendants(rows, gatewayPid);
  const servers = under.filter((row) => isCodingAgent(row.command));
  return {
    processes: under.length,
    servers: servers.length,
    lasting: servers.filter((row) => row.ageMs > LASTING_SERVER_MS).length,
  };
}

/**
 * The gateway's children in one line, and a warning when more servers last than tasks in use
 * explain. Null rows (`ps` failed) say so instead.
 */
export function childrenReport(
  rows: readonly ProcessRow[] | null,
  gatewayPid: number,
): { line: string; warning: string | null } {
  if (rows === null) return { line: "unknown (could not list processes)", warning: null };
  const count = countChildren(rows, gatewayPid);
  const line =
    `${count.processes} ${count.processes === 1 ? "process" : "processes"}, ${count.servers} of them the coding agent's servers` +
    ` (${count.lasting} older than ${LASTING_SERVER_MS / 60_000} minutes)`;
  const idleMinutes = (CODING_AGENT_IDLE_MS + IDLE_SWEEP_MS) / 60_000;
  const warning =
    count.lasting > LASTING_SERVER_LIMIT
      ? `${count.lasting} of the coding agent's servers are older than ${LASTING_SERVER_MS / 60_000} minutes; ` +
        `expected at most ${LASTING_SERVER_LIMIT}. A task's server should end within ` +
        `${idleMinutes} minutes of the task's last turn (mcp.sessionIdleTtlMs), so these are ` +
        "tasks still in use or servers the gateway kept (#845)."
      : null;
  return { line, warning };
}
