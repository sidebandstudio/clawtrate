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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startHostRuntime } from "../src/host/runtime.ts";
import {
  keepAside,
  RECOVERY_BUTTONS,
  SESSION_ONLY,
  startupFailure,
} from "../src/main/secret-box.ts";

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
    // Read as LF, whatever line endings the checkout wrote.
    const main = readFileSync(join(import.meta.dirname, "../src/main/index.ts"), "utf8").replaceAll(
      "\r\n",
      "\n",
    );
    const guarded = main.slice(main.indexOf("try {\n    runtime = await startHostRuntime("));
    expect(guarded.indexOf("startupFailure(error)")).toBeGreaterThan(0);
    expect(guarded.indexOf("startupFailure(error)")).toBeLessThan(guarded.indexOf("createWindow("));
    expect(main).toContain("dialog.showErrorBox(title, message);");
    expect(main).toMatch(
      /credentialStatus\?\.\(\)\) === "session"\)\s+void dialog\.showMessageBox/,
    );
  });

  it("a damaged record or unreadable settings offer to start fresh keeping the files; a locked keychain asks to unlock", () => {
    const named = (name: string) => Object.assign(new Error(name), { name });
    expect(startupFailure(named("SecureStorageUnavailableError"))).toMatchObject({
      recover: false,
    });
    expect(startupFailure(named("SecureStorageUnavailableError")).message).toMatch(
      /Unlock your keychain/,
    );
    expect(startupFailure(named("CredentialRecordInvalidError")).recover).toBe("folder");
    expect(startupFailure(named("SavedSettingsInvalidError")).recover).toBe("settings");
    expect(startupFailure(named("SavedSettingsInvalidError")).message).toMatch(
      /saved credentials stay in place/,
    );
    // Starting fresh after damaged credentials is a new device: it says so, and that the old
    // tokens and settings stop being used though they are kept.
    const damaged = startupFailure(named("CredentialRecordInvalidError")).message;
    expect(damaged).toMatch(/new device with a new identity/);
    expect(damaged).toMatch(/old tokens and settings are no longer used/);
    expect(damaged).toMatch(/set aside, unchanged/);
    for (const name of ["CredentialRecordInvalidError", "SavedSettingsInvalidError"]) {
      const said = startupFailure(named(name));
      expect(said.message, name).toMatch(/Start fresh/);
      expect(said.message, name).toMatch(/unchanged/);
      expect(said.message, name).not.toMatch(/remove this device from the gateway/);
    }
    expect(startupFailure(new Error("other")).recover).toBe(false);
    // Reopening discards a session's changes, and the warning says so.
    expect(SESSION_ONLY.message).toMatch(/discards those changes/);
    expect(SESSION_ONLY.message).toMatch(/repeat any pairing changes/);
    expect(RECOVERY_BUTTONS[0]).toMatch(/keep the old files/);
  });

  it("starting fresh sets the data folder aside unchanged, beside it, under a name of its own", async () => {
    const parent = mkdtempSync(join(tmpdir(), "clawtrate-keep-"));
    dirs.push(parent);
    const dir = join(parent, "gateway");
    mkdirSync(dir);
    writeFileSync(join(dir, "credentials.bin"), "sealed-bytes");
    writeFileSync(join(dir, STATE_FILE), "{}");
    const now = new Date("2026-11-22T10:20:30Z");
    const kept = await keepAside(dir, now);
    expect(kept).toBe(join(parent, "gateway-kept-20261122-102030"));
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(kept, "credentials.bin"), "utf8")).toBe("sealed-bytes");
    expect(readFileSync(join(kept, STATE_FILE), "utf8")).toBe("{}");
    // The same moment again: a name of its own, and the first copy untouched.
    mkdirSync(dir);
    writeFileSync(join(dir, STATE_FILE), "[]");
    const second = await keepAside(dir, now);
    expect(second).toBe(`${kept}-2`);
    expect(readFileSync(join(kept, STATE_FILE), "utf8")).toBe("{}");
  });

  it("the main process offers that choice for those cases, and relaunches only after setting the files aside", () => {
    const main = readFileSync(join(import.meta.dirname, "../src/main/index.ts"), "utf8");
    const guarded = main.slice(
      main.indexOf("const { title, message, recover } = startupFailure(error);"),
    );
    expect(guarded).toContain("buttons: [...RECOVERY_BUTTONS]");
    const fresh = guarded.slice(guarded.indexOf("if (choice === 0) {"));
    const aside =
      'await keepAside(recover === "settings" ? join(dir, STATE_FILE) : dir, new Date());';
    expect(fresh.indexOf(aside)).toBeGreaterThan(0);
    expect(fresh.indexOf("app.relaunch({ args: relaunchArgs() });")).toBeGreaterThan(
      fresh.indexOf(aside),
    );
  });

  it("for unreadable settings, starting fresh sets only the settings file aside, and the sealed record stays", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawtrate-keep-settings-"));
    dirs.push(dir);
    writeFileSync(join(dir, "credentials.bin"), "sealed-bytes");
    writeFileSync(join(dir, STATE_FILE), "not json");
    const kept = await keepAside(join(dir, STATE_FILE), new Date("2026-11-22T10:20:30Z"));
    expect(kept).toBe(join(dir, `${STATE_FILE}-kept-20261122-102030`));
    expect(readFileSync(kept, "utf8")).toBe("not json");
    expect(existsSync(join(dir, STATE_FILE))).toBe(false);
    expect(readFileSync(join(dir, "credentials.bin"), "utf8")).toBe("sealed-bytes");
  });

  for (const withSettings of [true, false])
    it(`a damaged earlier key ${withSettings ? "beside settings" : "alone"} is recovered by starting fresh, and kept aside`, async () => {
      const parent = mkdtempSync(join(tmpdir(), "clawtrate-bad-key-"));
      dirs.push(parent);
      const dir = join(parent, "gateway");
      mkdirSync(dir);
      writeFileSync(join(dir, DEVICE_KEY_FILE), "not a key");
      if (withSettings)
        writeFileSync(join(dir, STATE_FILE), JSON.stringify({ "turn-limit-minutes": "30" }));
      const failure = await createSecureCredentials({ dataDir: dir, box: box() })
        .signer.loadIdentity()
        .catch((error: unknown) => error);
      // What the main process does with that failure.
      const { recover } = startupFailure(failure);
      expect(recover).toBe("folder");
      const kept = await keepAside(
        recover === "settings" ? join(dir, STATE_FILE) : dir,
        new Date(),
      );
      // The relaunch opens cleanly, as a new device, and the damaged file is kept.
      expect(
        (await createSecureCredentials({ dataDir: dir, box: box() }).signer.loadIdentity())
          .deviceId,
      ).toMatch(/^[0-9a-f]{64}$/);
      expect(readFileSync(join(kept, DEVICE_KEY_FILE), "utf8")).toBe("not a key");
    });
});
