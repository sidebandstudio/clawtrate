// A gateway's children (#845): what `status`, `stop` and the e2e teardown count, and when they warn.

import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  childrenReport,
  countChildren,
  descendants,
  LASTING_SERVER_LIMIT,
  parseElapsed,
  parseProcessTable,
  readProcessTable,
} from "../src/children.ts";
import { CODING_AGENT_SCRIPT, devConfig } from "../src/cli.ts";

const OPENCLAW = "/state/openclaw/dist";
const GATEWAY = 1000;

/** One server as OpenClaw 2026.10.6 and 2026.11.10 run it: relay, group anchor, the agent. */
function serverChain(first: number, ageSeconds: number, parent = GATEWAY): string[] {
  const etime = `${String(Math.floor(ageSeconds / 60)).padStart(2, "0")}:${String(ageSeconds % 60).padStart(2, "0")}`;
  return [
    `${first} ${parent} ${etime} /state/node ${OPENCLAW}/process/supervisor/service-child-relay.js`,
    `${first + 1} ${first} ${etime} /state/node ${OPENCLAW}/process/supervisor/service-child-group-anchor.js`,
    `${first + 2} ${first + 1} ${etime} /state/node /state/tools/dev-gateway/src/coding-agent-mcp.ts`,
  ];
}

function table(servers: number, ageSeconds: number): string {
  return [
    `1 0 10:00 /sbin/launchd`,
    `${GATEWAY} 1 10:00 openclaw-gateway`,
    `1001 ${GATEWAY} 09:00 /state/node ${OPENCLAW}/infra/sqlite-readonly-location.worker.js`,
    // Another gateway's server is not this one's.
    `5000 1 10:00 openclaw-gateway`,
    ...serverChain(5001, 900, 5000),
    ...Array.from({ length: servers }, (_, i) => serverChain(2000 + i * 3, ageSeconds)).flat(),
  ].join("\n");
}

describe("a gateway's children", () => {
  it("reads ps's elapsed times", () => {
    expect(parseElapsed("05")).toBeNull();
    expect(parseElapsed("01:05")).toBe(65_000);
    expect(parseElapsed("02:01:05")).toBe(7_265_000);
    expect(parseElapsed("3-02:01:05")).toBe((3 * 86_400 + 7_265) * 1000);
  });

  it("counts every process under the gateway and its coding-agent servers, no other's", () => {
    const rows = parseProcessTable(table(18, 30));
    expect(descendants(rows, GATEWAY)).toHaveLength(1 + 18 * 3);
    expect(countChildren(rows, GATEWAY)).toEqual({ processes: 55, servers: 18, lasting: 0 });
  });

  it("does not warn about servers younger than an idle limit allows, however many", () => {
    // Right after the seed, every seeded task's server is a few seconds old.
    const report = childrenReport(parseProcessTable(table(18, 30)), GATEWAY);
    expect(report.line).toBe(
      "55 processes, 18 of them the coding agent's servers (0 older than 5 minutes)",
    );
    expect(report.warning).toBeNull();
  });

  it("warns when more servers last than tasks still in use explain", () => {
    expect(
      childrenReport(parseProcessTable(table(LASTING_SERVER_LIMIT, 600)), GATEWAY).warning,
    ).toBeNull();
    const kept = childrenReport(parseProcessTable(table(18, 900)), GATEWAY);
    expect(kept.line).toBe(
      "55 processes, 18 of them the coding agent's servers (18 older than 5 minutes)",
    );
    expect(kept.warning).toMatch(
      /^18 of the coding agent's servers are older than 5 minutes; expected at most 4\. .*within 2 minutes/,
    );
  });

  it("counts one process as one", () => {
    expect(childrenReport(parseProcessTable(table(0, 0)), GATEWAY).line).toBe(
      "1 process, 0 of them the coding agent's servers (0 older than 5 minutes)",
    );
  });

  it("says when it could not list processes", () => {
    expect(childrenReport(null, GATEWAY)).toEqual({
      line: "unknown (could not list processes)",
      warning: null,
    });
  });

  it("reads this machine's processes, this one among them", () => {
    const rows = readProcessTable();
    expect(rows?.some((row) => row.pid === process.pid && row.ppid === process.ppid)).toBe(true);
  });

  it("has the gateway end a task's idle coding-agent server", () => {
    const config = devConfig("token", undefined, "/state/dev") as {
      mcp: { sessionIdleTtlMs: number; servers: Record<string, unknown> };
    };
    expect(config.mcp.sessionIdleTtlMs).toBe(60_000);
  });
});

describe("the stand-in coding agent's process", () => {
  it("exits when its input closes, as when the gateway ends it or goes away", async () => {
    const child = spawn(process.execPath, [CODING_AGENT_SCRIPT], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    let out = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    let timer: NodeJS.Timeout | undefined;
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
      await expect.poll(() => out, { timeout: 20_000 }).toContain('"id":1');
      const closedAt = Date.now();
      child.stdin.end();
      const code = await Promise.race([
        exited,
        new Promise<"still running">((resolve) => {
          timer = setTimeout(() => resolve("still running"), 10_000);
        }),
      ]);
      expect(code).toBe(0);
      expect(Date.now() - closedAt).toBeLessThan(10_000);
    } finally {
      clearTimeout(timer);
      // Never left running, whatever failed above.
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
        child.kill("SIGKILL");
        await exited;
      }
    }
  }, 40_000);
});
