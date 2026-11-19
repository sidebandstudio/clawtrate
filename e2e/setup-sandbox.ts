// A sandbox for the look on this computer (docs/development/setup.md): a
// temporary home of its own, the repository's stand-in for `openclaw`, and
// one development instance of this run's own. The checks write one per
// launch; a developer writes one with
//
//   node e2e/setup-sandbox.ts --instance <name>
//
// which prints the sandbox file's path for `--clawtrate-setup-sandbox=` or
// CLAWTRATE_SETUP_SANDBOX. Everything is under the system's temporary folder.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { stateDirFor, validateInstanceName } from "../tools/dev-gateway/src/instance.ts";
import { STAND_IN_MARK } from "../apps/desktop/src/setup/world.ts";

const STAND_IN = resolve(import.meta.dirname, "openclaw-stand-in.ts");

/** The `openclaw` on PATH, as the dev-gateway tool runs it; empty when there is none. */
export function realOpenclaw(): string {
  try {
    return execFileSync("/usr/bin/which", ["openclaw"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export type Sandbox = { file: string; home: string; program: string; stateDir: string };

/**
 * Writes a sandbox into `dir` (under the temporary folder): its home, the
 * stand-in's wrapper and facts, and the sandbox file. `version` makes the
 * stand-in report another version; `openclaw` is the real program it may run.
 */
export function writeSandbox(options: {
  dir: string;
  instance: string;
  openclaw?: string;
  version?: string;
}): Sandbox {
  const instance = validateInstanceName(options.instance);
  const home = join(options.dir, "home");
  mkdirSync(home, { recursive: true });
  const stateDir = stateDirFor(instance, homedir());
  const facts = join(options.dir, "stand-in.json");
  writeFileSync(
    facts,
    JSON.stringify({
      openclaw: options.openclaw ?? realOpenclaw(),
      instance,
      stateDir,
      ...(options.version ? { version: options.version } : {}),
    }),
  );
  const program = join(options.dir, "bin/openclaw");
  mkdirSync(join(options.dir, "bin"), { recursive: true });
  writeFileSync(
    program,
    `#!/bin/sh\n# ${STAND_IN_MARK}\nexec "${process.execPath}" "${STAND_IN}" "${facts}" "$@"\n`,
  );
  chmodSync(program, 0o755);
  const file = join(options.dir, "sandbox.json");
  writeFileSync(file, JSON.stringify({ home, openclaw: program, instance, stateDir }));
  return { file, home, program, stateDir };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { instance: { type: "string" } } });
  if (!values.instance) throw new Error("--instance <name> names a development instance of yours");
  const dir = mkdtempSync(join(tmpdir(), "clawtrate-sandbox-"));
  console.log(writeSandbox({ dir, instance: values.instance }).file);
}
