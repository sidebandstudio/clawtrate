// The Claw moment at the end of install.sh: it plays only at a terminal, only
// after a good install, and changes nothing else about the install.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInTerminal, runPiped, standIns, VERSION, type StandIns } from "./install-stand-ins.ts";

const HIDE = "\u001b[?25l";
const SHOW = "\u001b[?25h";
const SHELLS = ["/bin/sh", "/bin/dash"];
const TERMINAL = { TERM: "xterm-256color", LANG: "en_US.UTF-8" };

// What a good install prints, the same as before the animation was added.
function expected(s: StandIns, arch: string): string {
  const zip = `${s.env.CLAWTRATE_RELEASES}v${VERSION}/Clawtrate-${VERSION}-mac-${arch === "arm64" ? "arm64" : "x64"}.zip`;
  return [
    `Reading the Beta feed: ${s.env.CLAWTRATE_FEED}`,
    `Latest beta: Clawtrate ${VERSION} for ${arch}`,
    `Downloading ${zip}`,
    "SHA-256 matches the feed.",
    `It is Clawtrate ${VERSION} (dev.clawtrate.desktop) for ${arch}.`,
    "Signed with Clawtrate's Developer ID (9X79V37Q89) and notarized by Apple.",
    `Installed Clawtrate ${VERSION} in ${s.applications}/Clawtrate.app.`,
    "Later updates come from Settings in Clawtrate.",
    "",
  ].join("\n");
}

const archOf = (stdout: string) => /^Latest beta: .* for (arm64|x86_64)$/m.exec(stdout)?.[1] ?? "";
// A terminal ends its lines with CR LF.
const lines = (output: string) => output.replaceAll("\r\n", "\n");

describe.skipIf(process.platform !== "darwin")("install.sh's Claw moment", () => {
  let s: StandIns;
  beforeEach(async () => {
    s = await standIns();
  });
  afterEach(async () => {
    await s.close();
  });

  it.each(SHELLS)(
    "prints exactly the install's own lines when stdout is not a terminal (%s)",
    async (shell) => {
      const run = await runPiped(shell, { ...s.env, ...TERMINAL, COLORTERM: "truecolor" });
      expect(run.stderr).toBe("");
      expect(run.stdout).toBe(expected(s, archOf(run.stdout)));
      expect(run.status).toBe(0);
      expect(existsSync(join(s.applications, "Clawtrate.app"))).toBe(true);
    },
  );

  it.each(SHELLS)(
    "plays after the last line of a good install at a terminal (%s)",
    async (shell) => {
      const run = await runInTerminal(shell, { ...s.env, ...TERMINAL });
      expect(run.status).toBe(0);
      const out = lines(run.stdout);
      const end = expected(s, archOf(out));
      expect(out.startsWith(end)).toBe(true);
      const art = out.slice(end.length);
      expect(art.startsWith(`\n${HIDE}`)).toBe(true);
      expect(art.endsWith(SHOW)).toBe(true);
      expect(art.split("\u001b[9A")).toHaveLength(10);
      expect(art).toContain("\u001b[0;38;5;69m");
      expect(art).toMatch(/[▀▄█]/);
    },
    60_000,
  );

  it("draws in 24-bit colour where the terminal says so", async () => {
    const run = await runInTerminal("/bin/sh", { ...s.env, ...TERMINAL, COLORTERM: "truecolor" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("\u001b[0;38;2;91;141;255m");
  }, 60_000);

  const SKIPS = [
    ["CI is set", { CI: "true" }],
    ["CI is set but empty", { CI: "" }],
    ["TERM is dumb", { TERM: "dumb" }],
    ["TERM is unset", { TERM: undefined }],
    ["CLAWTRATE_NO_ANIMATION is set", { CLAWTRATE_NO_ANIMATION: "1" }],
    ["the locale is not UTF-8", { LANG: "C" }],
  ] as const;
  it.each(SKIPS.flatMap(([why, change]) => SHELLS.map((shell) => [why, shell, change] as const)))(
    "is skipped at a terminal when %s (%s)",
    async (_, shell, change) => {
      const env: Record<string, string> = { ...s.env, ...TERMINAL };
      for (const [key, value] of Object.entries(change))
        if (value === undefined) delete env[key];
        else env[key] = value;
      const run = await runInTerminal(shell, env);
      expect(run.status).toBe(0);
      expect(lines(run.stdout)).toBe(expected(s, archOf(run.stdout)));
    },
    60_000,
  );

  it("is skipped in a terminal narrower than the art", async () => {
    const run = await runInTerminal(
      "/bin/sh",
      { ...s.env, ...TERMINAL },
      { before: "stty cols 40 rows 24" },
    );
    expect(run.status).toBe(0);
    expect(lines(run.stdout)).toBe(expected(s, archOf(run.stdout)));
  }, 60_000);

  it("keeps the motion and drops every colour under NO_COLOR", async () => {
    const run = await runInTerminal("/bin/dash", {
      ...s.env,
      ...TERMINAL,
      COLORTERM: "truecolor",
      NO_COLOR: "1",
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(HIDE);
    expect(run.stdout.split("\u001b[9A")).toHaveLength(10);
    expect(run.stdout).toMatch(/[▀▄█]/);
    // No SGR sequence at all: no colour, and no reset either.
    expect(run.stdout).not.toMatch(new RegExp(`${"\u001b"}\\[[0-9;]*m`));
  }, 60_000);

  it.each(SHELLS)(
    "restores the cursor when Ctrl-C ends it early, and the install stands (%s)",
    async (shell) => {
      const run = await runInTerminal(shell, { ...s.env, ...TERMINAL }, { interrupt: HIDE });
      const out = run.stdout;
      const art = out.slice(out.indexOf(HIDE));
      // Stopped part of the way through, and the cursor shown again on the way out.
      expect(art.split("\u001b[9A").length).toBeLessThan(10);
      expect(art.lastIndexOf(SHOW)).toBeGreaterThan(0);
      expect(art.slice(art.lastIndexOf(SHOW))).not.toContain(HIDE);
      expect(run.status).toBe(0);
      expect(existsSync(join(s.applications, "Clawtrate.app"))).toBe(true);
    },
    60_000,
  );

  it("never plays after a failure", async () => {
    mkdirSync(join(s.applications, "Clawtrate.app"));
    const run = await runInTerminal("/bin/sh", { ...s.env, ...TERMINAL });
    expect(run.status).toBe(1);
    expect(lines(run.stdout)).toBe(
      `Stopped: Clawtrate is already installed at ${s.applications}/Clawtrate.app. Update it from Settings, or move it to the Trash and run this again.\nNothing was installed.\n`,
    );
  }, 60_000);
});
