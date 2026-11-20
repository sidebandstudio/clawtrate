import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { runUpdatePowerShell } from "../../src/main/private-update-directory.ts";
import { windowsInstall } from "../../src/main/windows-install.ts";
import type { VerifiedArtifact } from "../../src/main/update/install.ts";

vi.mock("../../src/main/private-update-directory.ts", () => ({ runUpdatePowerShell: vi.fn() }));
const file: VerifiedArtifact = {
  offerId: "offer",
  track: "stable",
  version: "1.1.0",
  path: "fixture.exe",
  identity: "1.2.3",
  sha512: "fixture",
  size: 10,
};
const pin = "AB".repeat(32);
const proof = ["proof", file.identity, String(file.size), file.sha512, pin, pin];

function nativeStandIn() {
  const stdout = new EventEmitter(),
    end = vi.fn();
  const done = Promise.withResolvers<{ stdout: string; stderr: string }>();
  const task = Object.assign(done.promise, { child: { stdout, stdin: { on: vi.fn(), end } } });
  vi.mocked(runUpdatePowerShell).mockReturnValueOnce(
    task as unknown as ReturnType<typeof runUpdatePowerShell>,
  );
  return { stdout, end, finish: (value: string) => done.resolve({ stdout: value, stderr: "" }) };
}

it("Windows inspection passes the kept file proof and never authorizes process creation", async () => {
  const native = nativeStandIn();
  const pending = windowsInstall(file, pin, false);
  expect(runUpdatePowerShell).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({
      CLAWTRATE_UPDATE_FILE: file.path,
      CLAWTRATE_UPDATE_SIZE: "10",
      CLAWTRATE_INSTALL_MODE: "inspect",
      CLAWTRATE_RUNNING_IMAGE: process.execPath,
    }),
    120000,
    undefined,
  );
  native.stdout.emit("data", [...proof.slice(0, -1), "other"].join(" ") + "\r\n");
  native.finish("ok");
  expect(await pending).toBe("publisher-mismatch");
  expect(native.end).not.toHaveBeenCalled();
});

it.each(["ready", "quit", "unprepared", "trust"] as const)(
  "Windows writes a launch authorization only to a prepared helper in a live session (%s)",
  async (action) => {
    const native = nativeStandIn(),
      controller = new AbortController();
    const pending = windowsInstall(file, pin, true, controller.signal);
    if (action === "quit") controller.abort();
    if (action === "ready" || action === "quit") {
      native.stdout.emit("data", "pro");
      expect(native.end).not.toHaveBeenCalled();
      native.stdout.emit("data", proof.join(" ").slice(3) + "\r\n");
      expect(native.end).toHaveBeenCalledExactlyOnceWith(action === "ready" ? "launch\n" : "");
      native.finish("ok");
    } else {
      native.finish(action === "trust" ? "authenticode-trust" : "ok");
      expect(native.end).not.toHaveBeenCalled();
    }
    expect(await pending).toBe(
      action === "ready" ? null : action === "trust" ? "authenticode-trust" : "installer-failed",
    );
  },
);

it.each([
  [1, "artifact-changed"],
  [2, "artifact-changed"],
  [3, "artifact-changed"],
  [4, "running-publisher-mismatch"],
  [5, "publisher-mismatch"],
] as const)("Windows refuses field %i of a mismatching locked proof", async (index, reason) => {
  const native = nativeStandIn();
  const pending = windowsInstall(file, pin, true, new AbortController().signal);
  const fields = [...proof];
  fields[index] = "different";
  native.stdout.emit("data", fields.join(" ") + "\n");
  expect(native.end).toHaveBeenCalledExactlyOnceWith("");
  native.finish("installer-failed");
  expect(await pending).toBe(reason);
});

it.each(["running-signature-untrusted", "installation-context", "inspection-failed"])(
  "preserves the native inspection result %s",
  async (reason) => {
    const native = nativeStandIn();
    const pending = windowsInstall(file, pin, false);
    native.finish(reason);
    expect(await pending).toBe(reason);
  },
);

it.each([
  ["1.1.0", "installer-product"],
  ["1.0.9", "installer-version"],
  ["1.1.0-nightly.20261101.2", "installer-version"],
])("checks the signed setup kind and full offer version against %s", async (actual, reason) => {
  const native = nativeStandIn();
  const pending = windowsInstall(file, pin, false);
  const [script, env] = vi.mocked(runUpdatePowerShell).mock.lastCall!;
  expect(script).toContain('metadata.OriginalFilename != "ClawtrateSetup.exe"');
  expect(script).toContain("metadata.ProductVersion != expectedVersion");
  expect(env.CLAWTRATE_UPDATE_VERSION).toBe(file.version);
  native.finish(
    actual === env.CLAWTRATE_UPDATE_VERSION ? "installer-product" : "installer-version",
  );
  expect(await pending).toBe(reason);
});

it("requests quit only after the owner holds the process and package and reports a blocked exit", async () => {
  const native = nativeStandIn(),
    quit = vi.fn();
  const pending = windowsInstall(file, pin, true, new AbortController().signal, quit);
  const [script, env] = vi.mocked(runUpdatePowerShell).mock.lastCall!;
  expect(env.CLAWTRATE_OWNER_PID).toBe(String(process.pid));
  expect(script.indexOf("WaitForSingleObject(ownerHandle, 30000)")).toBeLessThan(
    script.indexOf("if (!CreateProcessW"),
  );
  expect(script.indexOf("WaitForSingleObject(child.process, UInt32.MaxValue)")).toBeLessThan(
    script.lastIndexOf("locks.Pop().Dispose()"),
  );
  native.stdout.emit("data", proof.join(" ") + "\n");
  expect(quit).not.toHaveBeenCalled();
  native.stdout.emit("data", "waiting\nwaiting\n");
  expect(quit).toHaveBeenCalledTimes(1);
  native.finish("quit-blocked");
  expect(await pending).toBe("quit-blocked");
});

it("refuses a coexisting per-user registration at another location before a machine handoff", async () => {
  const native = nativeStandIn();
  const pending = windowsInstall(file, pin, true);
  const [script] = vi.mocked(runUpdatePowerShell).mock.lastCall!;
  expect(script.indexOf("otherUserRegistration = true")).toBeLessThan(
    script.indexOf("String.Equals(location, dir"),
  );
  expect(script).toContain('result == "/allusers" && otherUserRegistration ? null');
  native.finish("installation-context");
  expect(await pending).toBe("installation-context");
  expect(native.end).not.toHaveBeenCalled();
});
