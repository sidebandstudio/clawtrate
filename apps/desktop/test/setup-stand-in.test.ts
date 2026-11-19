// The repository's stand-in for `openclaw` (e2e/openclaw-stand-in.ts), the
// only program a sandboxed look runs: it answers status from the instance's
// recorded facts, probes nothing but that instance's port, and refuses every
// command but the look's own. A fake "real program" and a local health
// server stand in for OpenClaw here.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MARKER_FILE } from "../../../tools/dev-gateway/src/state-guard.ts";
import { parseStatus } from "../src/setup/parse.ts";

const STAND_IN = resolve(import.meta.dirname, "../../../e2e/openclaw-stand-in.ts");
const PROFILE = "clawtrate-dev-su1-stand";

let dir: string;
let server: Server | null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clawtrate-stand-in-"));
  server = null;
});
afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  rmSync(dir, { recursive: true, force: true });
});

/** A state folder with the tool's marker for `port`, a config, and a fake real program that logs its arguments. */
function instance(port: number) {
  const stateDir = join(dir, `.openclaw-${PROFILE}`);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, MARKER_FILE),
    JSON.stringify({
      createdBy: "clawtrate tools/dev-gateway",
      instance: "su1-stand",
      gatewayPort: port,
    }),
  );
  writeFileSync(join(stateDir, "openclaw.json"), JSON.stringify({ gateway: { bind: "loopback" } }));
  const calls = join(dir, "calls.log");
  const fake = join(dir, "real-openclaw");
  writeFileSync(
    fake,
    `#!/bin/sh\necho "$*" >> "${calls}"\ncase "$*" in *--version*) echo "OpenClaw 2026.10.6 (fe06181)";; *auth.mode*) echo '"token"';; *) echo '{}';; esac\n`,
  );
  chmodSync(fake, 0o755);
  const facts = join(dir, "facts.json");
  writeFileSync(facts, JSON.stringify({ openclaw: fake, instance: "su1-stand", stateDir }));
  // Asynchronous: the health server answers from this process while the stand-in runs.
  const run = (args: string[], env: Record<string, string> = {}) =>
    new Promise<{ status: number | null; stdout: string }>((done) => {
      const child = spawn(process.execPath, [STAND_IN, facts, ...args], {
        env: {
          PATH: "/usr/bin:/bin",
          HOME: dir,
          OPENCLAW_PROFILE: PROFILE,
          OPENCLAW_STATE_DIR: stateDir,
          ...env,
        },
      });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.on("close", (status) => done({ status, stdout }));
    });
  const called = () => {
    try {
      return readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return { run, called, stateDir };
}

async function healthServer(): Promise<number> {
  server = createServer((request, response) => {
    response.statusCode = request.url === "/healthz" ? 200 : 404;
    response.end("{}");
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", () => done()));
  return (server!.address() as AddressInfo).port;
}

describe("the stand-in for openclaw", () => {
  it("answers status from the instance's recorded facts, on its own loopback port, without running the real status", async () => {
    const port = await healthServer();
    const { run, called } = instance(port);
    const result = await run(["--profile", PROFILE, "gateway", "status", "--json"]);
    expect(result.status).toBe(0);
    const status = parseStatus(result.stdout)!;
    expect(status).toMatchObject({
      port,
      bind: "loopback",
      listening: true,
      endpointConfirmed: true,
      service: "none",
      configExists: true,
    });
    expect(status.answered?.text).toBe("2026.10.6");
    // The real program ran for its version only.
    expect(called()).toEqual([`--profile ${PROFILE} --version`]);
  });

  it("says a stopped instance is not answering", async () => {
    const { run } = instance(19999);
    const status = parseStatus(
      (await run(["--profile", PROFILE, "gateway", "status", "--json"])).stdout,
    )!;
    expect(status).toMatchObject({ listening: false, unanswered: true, answered: null });
  });

  it("refuses the deep status, other commands, another profile, and an environment that isn't the instance's", async () => {
    const { run, called } = instance(19999);
    for (const args of [
      ["--profile", PROFILE, "gateway", "status", "--json", "--deep"],
      ["--profile", PROFILE, "gateway", "start"],
      ["--profile", PROFILE, "qr", "--json", "--voice-node", "--url", "ws://127.0.0.1:19998"],
      ["--profile", "clawtrate-dev-other", "--version"],
      ["gateway", "status", "--json"],
    ]) {
      expect((await run(args)).status, args.join(" ")).toBe(2);
    }
    expect(
      (await run(["--profile", PROFILE, "--version"], { OPENCLAW_STATE_DIR: dir })).status,
    ).toBe(2);
    expect(called()).toEqual([]);
  });

  it("runs the real program for the auth mode and the code, for this instance alone", async () => {
    const { run, called } = instance(19940);
    expect(
      (
        await run(["--profile", PROFILE, "config", "get", "gateway.auth.mode", "--json"])
      ).stdout.trim(),
    ).toBe('"token"');
    await run([
      "--profile",
      PROFILE,
      "qr",
      "--json",
      "--voice-node",
      "--url",
      "ws://127.0.0.1:19940",
    ]);
    expect(called()).toEqual([
      `--profile ${PROFILE} config get gateway.auth.mode --json`,
      `--profile ${PROFILE} qr --json --voice-node --url ws://127.0.0.1:19940`,
    ]);
  });
});
