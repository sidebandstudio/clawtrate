// Which hosts pair with full control (docs/decisions.md, "Scopes, once, at the first
// pairing"): the packaged Mac app, which asks for it with its Keychain box. A host without
// a box, or a read-only one, keeps asking for read, and its interface says nothing of it.

import { newDeviceKeyPem, STATE_FILE, DEVICE_KEY_FILE, type SecretBox } from "@clawtrate/core/node";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startHostRuntime } from "../src/host/runtime.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const flip = (bytes: Uint8Array) => Uint8Array.from(bytes, (byte) => byte ^ 0x3c);
const box: SecretBox = {
  available: async () => true,
  encrypt: async (text) => flip(new TextEncoder().encode(text)),
  decrypt: async (data) => new TextDecoder().decode(flip(data)),
};

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "clawtrate-full-control-"));
  dirs.push(dir);
  writeFileSync(join(dir, STATE_FILE), "{}");
  writeFileSync(join(dir, DEVICE_KEY_FILE), newDeviceKeyPem());
  return dir;
}

const start = (options: { secretBox?: SecretBox; fullAccess?: boolean; readOnly?: boolean }) =>
  startHostRuntime({
    kind: "desktop",
    displayName: "Clawtrate Test",
    dataDir: folder(),
    devGateway: null,
    resume: false,
    ...options,
  });

describe("which hosts pair with full control", () => {
  it("the Mac app's start, with its Keychain box, tells the interface it asks for full control", async () => {
    const runtime = await start({ secretBox: box, fullAccess: true });
    expect(runtime.info.fullControl).toBe(true);
    runtime.client.stop();
  });

  const closed: Array<[string, Parameters<typeof start>[0]]> = [
    ["without the flag", { secretBox: box }],
    ["without a Keychain box", { fullAccess: true }],
    ["read-only", { secretBox: box, fullAccess: true, readOnly: true }],
    // The Keychain can't be used, so it runs session-only and asks for read (`SESSION_ONLY`).
    [
      "whose Keychain can't be used",
      { secretBox: { ...box, available: async () => false }, fullAccess: true },
    ],
  ];
  for (const [name, options] of closed) {
    it(`a host ${name} doesn't`, async () => {
      const runtime = await start(options);
      expect(runtime.info.fullControl).toBeUndefined();
      runtime.client.stop();
    });
  }
});
