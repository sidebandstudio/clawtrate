import { expect, it, vi } from "vitest";
import type { VerifiedArtifact } from "../../src/main/update/install.ts";
import { windowsInstaller, windowsRefusal } from "../../src/main/windows-install.ts";

// Stand-ins for what the Windows helper reads. e2e-updates/windows-authenticode.spec.ts reads
// real signatures on Windows.
const proof: VerifiedArtifact = {
  offerId: "offer",
  track: "stable",
  version: "1.2.0",
  path: "C:\\Updates\\offer\\Clawtrate-1.2.0-win-x64.exe",
  identity: "1234.0.5678",
  sha512: "A".repeat(86) + "==",
  size: 4096,
};
const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const publisher = base64("CN=Example Publisher, O=Example Publisher, C=US");
const root = Buffer.alloc(32, 1).toString("base64");

function facts(change: Partial<Record<"running" | "file" | "installer" | "version", string>> = {}) {
  return [
    change.running ?? `running 00000000 ${publisher} ${root}`,
    change.file ?? `file ${proof.identity} ${proof.size} ${proof.sha512}`,
    change.installer ?? `installer 00000000 ${publisher} ${root}`,
    change.version ?? `version ${base64(proof.version)}`,
    "",
  ].join("\r\n");
}

it("F-231: accepts an installer from the running app's publisher at the offered version", () => {
  expect(windowsRefusal(facts(), proof)).toBeNull();
});

it.each([
  ["an empty answer", ""],
  ["a missing line", facts().split("\r\n").slice(0, 3).join("\r\n")],
  ["an extra line", facts() + "running 00000000 - -\r\n"],
  ["lines out of order", facts().split("\r\n").reverse().join("\r\n")],
  ["a trust result that is not one", facts({ installer: `installer ok ${publisher} ${root}` })],
  ["a root that is not a digest", facts({ installer: `installer 00000000 ${publisher} root` })],
])("F-231: never treats %s as a pass", (_case, output) => {
  expect(windowsRefusal(output, proof)).toBe("inspection-failed");
});

it("F-231: an unsigned running app is a build that cannot update itself", () => {
  expect(windowsRefusal(facts({ running: "running 800b0100 - -" }), proof)).toBe(
    "build-not-signed",
  );
});

it.each([
  ["a root Windows does not trust", `running 800b0109 ${publisher} ${root}`],
  ["a change after signing", `running 80096010 ${publisher} ${root}`],
  ["no signer", "running 00000000 - -"],
])("F-231: refuses when the running app's signature has %s", (_case, running) => {
  expect(windowsRefusal(facts({ running }), proof)).toBe("running-signature-untrusted");
});

it.each([
  ["another file", `file 1234.0.9999 ${proof.size} ${proof.sha512}`],
  ["another size", `file ${proof.identity} 4097 -`],
  ["other bytes", `file ${proof.identity} ${proof.size} ${"B".repeat(86)}==`],
])("F-231: reports %s under the helper's hold as a changed download", (_case, file) => {
  expect(windowsRefusal(facts({ file }), proof)).toBe("artifact-changed");
});

it.each([
  ["no signature", "installer 800b0100 - -"],
  ["a change after signing", `installer 80096010 ${publisher} ${root}`],
  ["a root Windows does not trust", `installer 800b0109 ${publisher} ${root}`],
  ["an expired certificate", `installer 800b0101 ${publisher} ${root}`],
  ["no signer", "installer 00000000 - -"],
])("F-231: refuses an installer with %s", (_case, installer) => {
  expect(windowsRefusal(facts({ installer }), proof)).toBe("windows-signature");
});

it("F-231: refuses another subject under the running app's root", () => {
  const other = base64("CN=Other Publisher, O=Other Publisher, C=US");
  expect(windowsRefusal(facts({ installer: `installer 00000000 ${other} ${root}` }), proof)).toBe(
    "windows-publisher",
  );
});

it("F-231: refuses the running app's subject under another root", () => {
  const otherRoot = Buffer.alloc(32, 2).toString("base64");
  expect(
    windowsRefusal(facts({ installer: `installer 00000000 ${publisher} ${otherRoot}` }), proof),
  ).toBe("windows-publisher");
});

it.each([
  ["another version", `version ${base64("1.2.1")}`],
  ["a beta of the same release", `version ${base64("1.2.0-beta.20261120.1")}`],
  ["no version", "version -"],
])("F-231: refuses an installer with %s", (_case, version) => {
  expect(windowsRefusal(facts({ version }), proof)).toBe("installer-version");
});

it("F-231: a signed Windows build still withholds Download and Restart until the trial", () => {
  expect(windowsInstaller("C:\\Clawtrate\\Clawtrate.exe", vi.fn()).unavailable).toBe(
    "windows-install-pending-trial",
  );
});

it("F-231: inspect reads the download against the running app and reports the verdict", async () => {
  const inspect = vi.fn(async () => facts({ installer: "installer 80096010 - -" }));
  const installer = windowsInstaller("C:\\Clawtrate\\Clawtrate.exe", inspect);
  expect(await installer.inspect(proof)).toBe("windows-signature");
  expect(inspect).toHaveBeenCalledExactlyOnceWith(
    proof,
    "C:\\Clawtrate\\Clawtrate.exe",
    expect.any(AbortSignal),
  );
  inspect.mockResolvedValue(facts());
  expect(await installer.inspect(proof)).toBeNull();
});

it("F-231: a helper that fails is inspection-failed, never a pass", async () => {
  const installer = windowsInstaller("app.exe", async () => {
    throw Error("PowerShell stopped");
  });
  expect(await installer.inspect(proof)).toBe("inspection-failed");
  expect(await installer.launch(proof, new AbortController().signal, () => {})).toBe(
    "artifact-changed",
  );
});

it("F-231: retiring the offer during inspection reports the download as changed", async () => {
  const answer = Promise.withResolvers<string>();
  const installer = windowsInstaller("app.exe", () => answer.promise);
  const inspected = installer.inspect(proof);
  installer.retire!();
  answer.resolve(facts());
  expect(await inspected).toBe("artifact-changed");
  expect(await installer.launch(proof, new AbortController().signal, () => {})).toBe(
    "artifact-changed",
  );
});

it.each([
  ["another offer", { offerId: "other" }],
  ["another file", { identity: "1234.0.9999" }],
  ["other bytes", { sha512: "B".repeat(86) + "==" }],
])("F-231: launch refuses %s than inspect accepted", async (_case, change) => {
  const inspect = vi.fn(async () => facts());
  const installer = windowsInstaller("app.exe", inspect);
  expect(await installer.inspect(proof)).toBeNull();
  const handed = vi.fn();
  expect(
    await installer.launch({ ...proof, ...change }, new AbortController().signal, handed),
  ).toBe("artifact-changed");
  expect(inspect).toHaveBeenCalledOnce();
  expect(handed).not.toHaveBeenCalled();
});

it("F-231: launch reads the download again and catches a swap since inspect", async () => {
  const inspect = vi.fn(async () => facts());
  const installer = windowsInstaller("app.exe", inspect);
  expect(await installer.inspect(proof)).toBeNull();
  inspect.mockResolvedValue(
    facts({ file: `file ${proof.identity} ${proof.size} ${"B".repeat(86)}==` }),
  );
  const signal = new AbortController().signal;
  expect(await installer.launch(proof, signal, () => {})).toBe("artifact-changed");
  expect(inspect).toHaveBeenLastCalledWith(proof, "app.exe", signal);
});

it("F-231: after a clean second reading, launch still refuses until the trial", async () => {
  const inspect = vi.fn(async () => facts());
  const installer = windowsInstaller("app.exe", inspect);
  expect(await installer.inspect(proof)).toBeNull();
  const handed = vi.fn(),
    submitted = vi.fn();
  expect(await installer.launch(proof, new AbortController().signal, handed, submitted)).toBe(
    "windows-install-pending-trial",
  );
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(handed).not.toHaveBeenCalled();
  expect(submitted).not.toHaveBeenCalled();
  // One inspection covers one launch.
  expect(await installer.launch(proof, new AbortController().signal, handed)).toBe(
    "artifact-changed",
  );
});

it("F-231: retire forgets the inspected download", async () => {
  const installer = windowsInstaller("app.exe", async () => facts());
  expect(await installer.inspect(proof)).toBeNull();
  installer.retire!();
  expect(await installer.launch(proof, new AbortController().signal, () => {})).toBe(
    "artifact-changed",
  );
});
