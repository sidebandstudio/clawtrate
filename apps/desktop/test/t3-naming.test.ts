// A T3 Code call before its result, against the gateway's own naming
// function: `buildSafeToolName`, from the installed OpenClaw (the one the
// development gateway runs). The effective names a running attempt captured
// and the ones a later `tools.effective` reports are both made by it, so the
// cases where they differ are the gateway's own.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyAgentEvent,
  emptyActivity,
  RawTable,
  type Step,
  type TaskActivity,
} from "@clawtrate/core";
import { beforeAll, describe, expect, it } from "vitest";
import { selectCards } from "../../../packages/ui/src/cards/useCards.ts";

type BuildSafeToolName = (params: {
  serverName: string;
  toolName: string;
  reservedNames: Set<string>;
}) => string;

/** The installed OpenClaw package: `OPENCLAW_PACKAGE_DIR`, or the global one. */
function openclawPackage(): string {
  const dir =
    process.env.OPENCLAW_PACKAGE_DIR ??
    join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "openclaw");
  if (!existsSync(join(dir, "package.json"))) {
    throw new Error(
      `OpenClaw is not installed at ${dir}; the development gateway needs it. Set OPENCLAW_PACKAGE_DIR.`,
    );
  }
  return dir;
}

let buildSafeToolName: BuildSafeToolName;

beforeAll(async () => {
  const dir = openclawPackage();
  const version = (
    JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }
  ).version;
  expect(version, "the OpenClaw these names were read from").toBe("2026.10.6");
  const file = readdirSync(join(dir, "dist")).find((name) =>
    /^agent-bundle-mcp-names-.*\.mjs$/.test(name),
  );
  expect(file, "the gateway's naming module").toBeTruthy();
  const module = (await import(pathToFileURL(join(dir, "dist", file!)).href)) as Record<
    string,
    unknown
  >;
  const found = Object.values(module).find(
    (value) => typeof value === "function" && value.name === "buildSafeToolName",
  );
  expect(found, "buildSafeToolName").toBeTruthy();
  buildSafeToolName = found as BuildSafeToolName;
});

const KEY = "agent:otto:naming";
/** One call to `name`, and its result naming `tool` when given. */
function call(name: string, tool?: string): Pick<TaskActivity, "runs" | "approvals"> {
  const raw = new RawTable();
  const ctx = { sessionKey: KEY, now: 1, raw };
  let a: TaskActivity = emptyActivity;
  let seq = 0;
  const apply = (data: Record<string, unknown>) => {
    seq += 1;
    a = applyAgentEvent(
      a,
      { runId: "r", seq, stream: "tool", ts: seq, sessionKey: KEY, data },
      ctx,
    ).activity;
  };
  apply({ phase: "start", name, toolCallId: "c1", args: { message: "Go" } });
  if (tool) {
    apply({
      phase: "result",
      name,
      toolCallId: "c1",
      isError: false,
      result: {
        content: [{ type: "text", text: "ok" }],
        details: { mcpServer: "coder", mcpTool: tool },
      },
    });
  }
  return a;
}
const rawOf = (step: Step) => step.raw;
/** The calls drawn as T3 Code cards, given the gateway's map at the time. */
const cards = (
  activity: Pick<TaskActivity, "runs" | "approvals">,
  map: Record<string, { server: string; tool: string }>,
) =>
  selectCards(
    {
      runs: activity.runs,
      approvals: activity.approvals,
      linkedRuns: {},
      interSession: [],
      mcpTools: map,
    },
    [],
    rawOf,
  ).mcpCalls.filter((card) => card.codingAgent);

describe("a T3 Code call before its result, by the gateway's own names", () => {
  it("F-132: a collision-renamed T3 Code tool shows as the card from its start, by the map", () => {
    const name = buildSafeToolName({
      serverName: "coder",
      toolName: "t3_thread_launch",
      reservedNames: new Set(["coder__t3_thread_launch"]),
    });
    expect(name).toBe("coder__t3_thread_launch-2");
    const map = { [name]: { server: "coder", tool: "t3_thread_launch" } };
    expect(cards(call(name), map)).toMatchObject([{ tool: "t3_thread_launch", state: "started" }]);
    expect(cards(call(name, "t3_thread_launch"), map)).toMatchObject([{ state: "returned" }]);
  });

  it("F-132: a tool whose own name only ends in a T3 Code tool's is not T3 Code, by the map", () => {
    const name = buildSafeToolName({
      serverName: "coder",
      toolName: "helper__t3_thread_launch",
      reservedNames: new Set(),
    });
    expect(name).toBe("coder__helper__t3_thread_launch");
    expect(
      cards(call(name), { [name]: { server: "coder", tool: "helper__t3_thread_launch" } }),
    ).toEqual([]);
  });

  it("F-132 F-134: when the map is rebuilt from another catalog, the result decides: a card the map made becomes an ordinary step, and a call the map missed becomes the card", () => {
    // The running attempt reserved `coder__t3_thread_launch`, so its T3 Code call is `…-2`. A
    // later map, rebuilt from a catalog that also has an own tool called `t3_thread_launch-2`
    // and no reservation, gives that name to the other tool.
    const running = buildSafeToolName({
      serverName: "coder",
      toolName: "t3_thread_launch",
      reservedNames: new Set(["coder__t3_thread_launch"]),
    });
    const later = buildSafeToolName({
      serverName: "coder",
      toolName: "t3_thread_launch-2",
      reservedNames: new Set(),
    });
    expect(later).toBe(running);
    const rebuilt = { [later]: { server: "coder", tool: "t3_thread_launch-2" } };
    // The map missed it: an ordinary step until its result names T3 Code's tool, then the card.
    expect(cards(call(running), rebuilt)).toEqual([]);
    expect(cards(call(running, "t3_thread_launch"), rebuilt)).toMatchObject([
      { state: "returned" },
    ]);
    // The other way round: the map says T3 Code, the result names the other tool.
    const stale = { [running]: { server: "coder", tool: "t3_thread_launch" } };
    expect(cards(call(running), stale)).toMatchObject([{ state: "started" }]);
    expect(cards(call(running, "t3_thread_launch-2"), stale)).toEqual([]);
  });
});
