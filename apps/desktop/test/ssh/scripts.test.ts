// The CODE, START and STOP scripts (apps/desktop/src/main/ssh/scripts.ts), run
// here as the other computer's `/bin/sh -s` would run them, in a home of the
// test's own with a stand-in `openclaw` in the first fixed place, and their
// output parsed as the host parses it. No `ssh` and no OpenClaw program run.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  maxScriptOutput,
  parseScriptOutput,
  remoteScript,
  SCRIPT_BODIES,
} from "../../src/main/ssh/scripts.ts";
import { tempDir } from "./harness.ts";

describe.skipIf(process.platform === "win32")("the CODE, START and STOP scripts", () => {
  let home: string;
  beforeAll(() => {
    home = tempDir("clawtrate-scripts-");
    const bin = join(home, ".openclaw", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "openclaw"),
      [
        "#!/bin/sh",
        'printf \'%s\\n\' "$*" >> "$HOME/calls"',
        'case "$*" in',
        '  *"qr --json --voice-node --url ws://127.0.0.1:"*) printf \'{"setupCode":"abc"}\' ;;',
        '  *"gateway start") exit 3 ;;',
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "openclaw"), 0o755);
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  const run = (text: string) =>
    spawnSync("/bin/sh", ["-s"], {
      input: `echo 'a login file says hello'\n${text}`,
      env: { HOME: home, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 20_000,
    });
  const calls = () => {
    try {
      return readFileSync(join(home, "calls"), "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };

  it("F-496: CODE runs the one fixed command for the profile and port it was given, and its answer comes back whole", () => {
    rmSync(join(home, "calls"), { force: true });
    const script = remoteScript("code", { profile: "default", port: 19420 });
    const out = run(script.text);
    expect(out.status).toBe(0);
    expect(parseScriptOutput("code", out.stdout, script.requestId)).toEqual({
      ok: true,
      program: "~/.openclaw/bin/openclaw",
      answer: { text: '{"setupCode":"abc"}', exit: 0 },
    });
    expect(calls()).toEqual(["qr --json --voice-node --url ws://127.0.0.1:19420"]);
    const own = remoteScript("code", { profile: "clawtrate", port: 19421 });
    expect(run(own.text).status).toBe(0);
    expect(calls().at(-1)).toBe(
      "--profile clawtrate qr --json --voice-node --url ws://127.0.0.1:19421",
    );
  });

  it("F-497 F-499: START and STOP each run their one command, and the exit status comes back", () => {
    rmSync(join(home, "calls"), { force: true });
    const start = remoteScript("start", { profile: "default", port: 19420 });
    const started = parseScriptOutput("start", run(start.text).stdout, start.requestId);
    expect(started).toMatchObject({ ok: true, answer: { exit: 3 } });
    const stop = remoteScript("stop", { profile: "clawtrate", port: 19420 });
    expect(parseScriptOutput("stop", run(stop.text).stdout, stop.requestId)).toMatchObject({
      ok: true,
      answer: { exit: 0 },
    });
    expect(calls()).toEqual(["gateway start", "--profile clawtrate gateway stop"]);
  });

  it("the host writes only a validated profile and port; the script refuses anything else before it runs a program", () => {
    expect(() => remoteScript("code", { profile: "work" as "default", port: 19420 })).toThrow();
    expect(() => remoteScript("code", { profile: "default", port: 80 })).toThrow();
    expect(() => remoteScript("code", { profile: "default", port: 19420.5 })).toThrow();
    rmSync(join(home, "calls"), { force: true });
    // The body checks again: a profile or a port no host would write ends the script at once.
    for (const values of ["profile='x;id'\nport='19420'\n", "profile='default'\nport='1$(id)'\n"]) {
      const out = run(
        `request_id='00000000-0000-4000-8000-000000000000'\n${values}${SCRIPT_BODIES.code}`,
      );
      expect(out.status).toBe(64);
    }
    expect(calls()).toEqual([]);
    // The only values in the constant bodies come from those three assignments.
    for (const body of Object.values(SCRIPT_BODIES)) {
      expect(body).not.toMatch(/request_id=|profile=|port=/);
    }
  });

  it("what a login file prints before the begin line is dropped, a fake answer included, and a cut or tampered answer isn't read", () => {
    const script = remoteScript("code", { profile: "default", port: 19420 });
    const fake = '{"k":"answer","v":"e30=","exit":0}\n';
    const out = run(script.text);
    expect(parseScriptOutput("code", fake + out.stdout, script.requestId)).toMatchObject({
      ok: true,
      answer: { text: '{"setupCode":"abc"}' },
    });
    expect(parseScriptOutput("code", out.stdout, "00000000-0000-4000-8000-000000000000")).toEqual({
      ok: false,
      reason: "no-begin",
    });
    const cut = out.stdout.slice(0, out.stdout.indexOf('{"k":"end"'));
    expect(parseScriptOutput("code", cut, script.requestId)).toEqual({
      ok: false,
      reason: "no-end",
    });
    expect(
      parseScriptOutput("code", "x".repeat(maxScriptOutput("code") + 1), script.requestId),
    ).toEqual({ ok: false, reason: "too-large" });
  });
});
