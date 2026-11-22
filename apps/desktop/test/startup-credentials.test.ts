// A desktop start that can't open this device's credentials: it connects to nothing, and
// says so in fixed words that quote nothing from the files or the error.

import {
  createSecureCredentials,
  newDeviceKeyPem,
  SavedSettingsInvalidError,
  SecureStorageUnavailableError,
  STATE_FILE,
  DEVICE_KEY_FILE,
  type SecretBox,
} from "@clawtrate/core/node";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startHostRuntime } from "../src/host/runtime.ts";
import { SESSION_ONLY, startupFailure } from "../src/main/secret-box.ts";

const SECRET = "shared-token-sentinel-31c9";
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const server of servers.splice(0)) server.close();
});

const flip = (bytes: Uint8Array) => Uint8Array.from(bytes, (byte) => byte ^ 0x5a);
const box = (available = true): SecretBox => ({
  available: async () => available,
  encrypt: async (text) => flip(new TextEncoder().encode(text)),
  decrypt: async (data) => new TextDecoder().decode(flip(data)),
});

/** A listener standing in for a gateway, counting every connection made to it. */
async function countingListener(): Promise<{ url: string; dials: () => number }> {
  let dials = 0;
  const server = createServer((socket) => {
    dials += 1;
    socket.destroy();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `ws://127.0.0.1:${port}`, dials: () => dials };
}

function folder(contents: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "clawtrate-startup-"));
  dirs.push(dir);
  writeFileSync(join(dir, STATE_FILE), JSON.stringify(contents));
  writeFileSync(join(dir, DEVICE_KEY_FILE), newDeviceKeyPem());
  return dir;
}

const start = (dataDir: string, secretBox: SecretBox) =>
  startHostRuntime({
    kind: "desktop",
    displayName: "Clawtrate Test",
    dataDir,
    devGateway: null,
    secretBox,
    resume: true,
  });

describe("a desktop start that can't open this device's credentials", () => {
  it("with its credentials moved and secure storage locked, stops before any connection", async () => {
    const gateway = await countingListener();
    const dir = folder({ connection: JSON.stringify({ url: gateway.url, token: SECRET }) });
    await createSecureCredentials({ dataDir: dir, box: box() }).signer.loadIdentity();
    const failure = await start(dir, box(false)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SecureStorageUnavailableError);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(gateway.dials()).toBe(0);
  });

  it("with an earlier build's settings that can't be read, stops before any connection", async () => {
    const gateway = await countingListener();
    const dir = folder({
      connection: JSON.stringify({ url: gateway.url, token: SECRET }),
      "deviceToken:x:device:operator": `{"token": 7, "note": "${SECRET}"}`,
    });
    const failure = await start(dir, box()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SavedSettingsInvalidError);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(gateway.dials()).toBe(0);
    expect(readFileSync(join(dir, STATE_FILE), "utf8")).toContain(SECRET);
  });

  it("says what happened in fixed words, never the error's own message or cause", () => {
    const named = (name: string) =>
      Object.assign(new Error(`${name}: ${SECRET}`, { cause: SECRET }), { name });
    const cases = [
      named("SecureStorageUnavailableError"),
      named("CredentialRecordInvalidError"),
      named("SavedSettingsInvalidError"),
      new SyntaxError(`Unexpected token in JSON at position 3: "${SECRET}"`),
      SECRET,
    ];
    const said = cases.map((error) => startupFailure(error));
    expect(new Set(said.map(({ title }) => title)).size).toBe(4);
    for (const { title, message } of [...said, SESSION_ONLY])
      expect(`${title}\n${message}`).not.toContain(SECRET);
    expect(said[0]!.message).toMatch(/Unlock your keychain/);
  });

  it("the main process shows that, exits, and warns when this session's pairing can't be kept", () => {
    const main = readFileSync(join(import.meta.dirname, "../src/main/index.ts"), "utf8");
    const guarded = main.slice(main.indexOf("try {\n    runtime = await startHostRuntime("));
    expect(guarded.indexOf("startupFailure(error)")).toBeGreaterThan(0);
    expect(guarded.indexOf("startupFailure(error)")).toBeLessThan(guarded.indexOf("createWindow("));
    expect(main).toContain("dialog.showErrorBox(title, message);");
    expect(main).toMatch(
      /credentialStatus\?\.\(\)\) === "session"\)\s+void dialog\.showMessageBox/,
    );
  });
});
