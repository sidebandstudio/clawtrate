// The routine editor reads cron expressions with croner, the gateway's own parser, so its checks
// and its preview say what the gateway will do (docs/design/automation.md, section 9). That holds
// only while `@clawtrate/ui` pins the croner version every OpenClaw the project tests against
// runs (#751).
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import {
  isOpenclawVersion,
  OPENCLAW_VERSIONS,
  type OpenclawVersion,
} from "../tools/dev-gateway/src/versions.ts";

const ROOT = join(import.meta.dirname, "..");
const json = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

/**
 * The croner each listed OpenClaw loads. A version added to OPENCLAW_VERSIONS needs its entry here.
 * The second test reads the OpenClaw a run installed: ci.yml's `check` installs the pin, and the
 * OpenClaw latest workflow installs npm's newest, which need not be listed yet. A listed version
 * is checked against its entry; any other against the croner packages/ui pins.
 */
const GATEWAY_CRONER: Record<OpenclawVersion, string> = {
  "2026.10.6": "10.0.1",
  "2026.11.10": "10.0.1",
};

it("@clawtrate/ui pins the croner version every listed OpenClaw runs", () => {
  const runs = OPENCLAW_VERSIONS.map(
    (version) => `OpenClaw ${version} runs croner ${GATEWAY_CRONER[version]}`,
  );
  const croners = [...new Set(OPENCLAW_VERSIONS.map((version) => GATEWAY_CRONER[version]))];
  expect(
    croners,
    `The OpenClaw versions the project tests against run different croner versions (${runs.join(", ")}). ` +
      `The routine editor reads cron with one croner, so it can match only one of them. ` +
      `Which one is a product decision: make it before listing these versions together.`,
  ).toHaveLength(1);
  const ui = (json(join(ROOT, "packages/ui/package.json")).dependencies as Record<string, string>)
    .croner;
  expect(
    ui,
    `${runs.join(", ")}, and packages/ui/package.json pins croner ${ui}. ` +
      `Pin croner to exactly ${croners[0]} there, run pnpm install, and update the croner version in ` +
      `docs/design/automation.md and docs/decisions.md. Croner moves only with the OpenClaw versions.`,
  ).toBe(croners[0]);
});

it("the OpenClaw at OPENCLAW_PACKAGE_DIR runs the croner the routine editor expects", () => {
  // The OpenClaw package set aside for the tests. Never a global one: on a computer that runs its
  // own gateway, that is the person's own OpenClaw (#597).
  const dir = process.env.OPENCLAW_PACKAGE_DIR ?? "";
  if (!dir || !existsSync(join(dir, "package.json")))
    throw new Error(
      `OpenClaw is not installed at ${dir || "OPENCLAW_PACKAGE_DIR"}; this check reads its croner version. Set OPENCLAW_PACKAGE_DIR.`,
    );
  const manifest = resolve(dir, "package.json");
  const version = String(json(manifest).version);
  // The copy the gateway loads, resolved from its own package.
  const gateway = String(json(createRequire(manifest).resolve("croner/package.json")).version);
  if (isOpenclawVersion(version)) {
    expect(
      gateway,
      `OpenClaw ${version} runs croner ${gateway}, and this file records ${GATEWAY_CRONER[version]} for it. ` +
        `Record ${gateway}. If the listed OpenClaw versions then run different croner versions, ` +
        `the editor can follow only one of them, and which one is a product decision.`,
    ).toBe(GATEWAY_CRONER[version]);
    return;
  }
  const ui = (json(join(ROOT, "packages/ui/package.json")).dependencies as Record<string, string>)
    .croner;
  expect(
    gateway,
    `OpenClaw ${version} runs croner ${gateway}, and the routine editor reads cron with croner ${ui}, ` +
      `the version packages/ui/package.json pins. This newer OpenClaw reads cron differently from the ` +
      `routine editor, so the editor's checks and preview will be wrong on gateways that run it. ` +
      `Which croner the editor follows is a product decision: make it before OpenClaw ${version} is ` +
      `listed in OPENCLAW_VERSIONS (tools/dev-gateway/src/versions.ts).`,
  ).toBe(ui);
});
