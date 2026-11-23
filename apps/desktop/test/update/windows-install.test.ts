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
const other = base64("CN=Other Publisher, O=Other Publisher, C=US");
const root = Buffer.alloc(32, 1).toString("base64");
const otherRoot = Buffer.alloc(32, 2).toString("base64");
const sha1 = base64("1.3.14.3.2.26");
const sha256 = base64("2.16.840.1.101.3.4.2.1");
// One embedded signature as the helper reads it: result, digest algorithm, subject and root.
const ours = `00000000 ${sha256} ${publisher} ${root}`;
const oursSha1 = `00000000 ${sha1} ${publisher} ${root}`;

// The verified index the helper starts with, which Windows leaves as it is for the first signature.
const NO_INDEX = 4294967295;

/** `<name> <count>`, then each signature with its index and the index Windows says it verified,
 * none for the first, as the helper prints them. */
function signed(name: string, ...signatures: string[]) {
  return [
    `${name} ${signatures.length}`,
    ...signatures.map((line, i) => `signature ${i} ${i === 0 ? NO_INDEX : i} ${line}`),
  ];
}

/** `versions <count>`, then each version resource: its fixed product version and ProductVersions. */
function resources(...lines: string[]) {
  return [`versions ${lines.length}`, ...lines.map((line) => `resource ${line}`)];
}
const offered = `1.2.0.0 ${base64(proof.version)}`;

function facts(
  change: { running?: string[]; file?: string; installer?: string[]; versions?: string[] } = {},
) {
  return [
    ...(change.running ?? signed("running", ours)),
    change.file ?? `file ${proof.identity} ${proof.size} ${proof.sha512}`,
    ...(change.installer ?? signed("installer", ours)),
    ...(change.versions ?? resources(offered)),
    "",
  ].join("\r\n");
}

it("F-231: accepts an installer from the running app's publisher at the offered version", () => {
  expect(windowsRefusal(facts(), proof)).toBeNull();
});

it.each([
  ["an empty answer", ""],
  ["a missing line", facts().split("\r\n").slice(0, 4).join("\r\n")],
  ["an extra line", facts() + "running 1\r\n"],
  ["lines out of order", facts().split("\r\n").reverse().join("\r\n")],
  [
    "a count with a missing signature",
    facts({ installer: ["installer 2", `signature 0 0 ${ours}`] }),
  ],
  ["signatures out of order", facts({ installer: ["installer 1", `signature 1 1 ${ours}`] })],
  [
    "a verified index that is not a number",
    facts({ installer: ["installer 1", `signature 0 - ${ours}`] }),
  ],
  ["no signature lines at all", facts({ installer: ["installer 0"] })],
  [
    "a trust result that is not one",
    facts({ installer: signed("installer", `ok ${sha256} ${publisher} ${root}`) }),
  ],
  [
    "a digest that is not encoded",
    facts({ installer: signed("installer", `00000000 2.16.840 ${publisher} ${root}`) }),
  ],
  [
    "a root that is not a digest",
    facts({ installer: signed("installer", `00000000 ${sha256} ${publisher} root`) }),
  ],
  ["a count with a missing resource", facts({ versions: ["versions 2", `resource ${offered}`] })],
  ["a fixed version that is not one", facts({ versions: resources(`1.2.0 ${base64("1.2.0")}`) })],
  ["a version that is not encoded", facts({ versions: resources("1.2.0.0 1.2.0") })],
  // The helper leaves them unread only when the checks before them fail.
  ["version resources left unread", facts({ versions: ["versions unread"] })],
])("F-231: never treats %s as a pass", (_case, output) => {
  expect(windowsRefusal(output, proof)).toBe("inspection-failed");
});

it("F-231: an unsigned running app is a build that cannot update itself", () => {
  expect(windowsRefusal(facts({ running: signed("running", "800b0100 - - -") }), proof)).toBe(
    "build-not-signed",
  );
});

it.each([
  ["a root Windows does not trust", [`800b0109 ${sha256} ${publisher} ${root}`]],
  ["a change after signing", [`80096010 ${sha256} ${publisher} ${root}`]],
  ["no signer", [`00000000 ${sha256} - -`]],
  ["only a SHA-1 signature", [oursSha1]],
  ["two SHA-256 signatures with different subjects", [ours, `00000000 ${sha256} ${other} ${root}`]],
  [
    "two SHA-256 signatures under different roots",
    [ours, `00000000 ${sha256} ${publisher} ${otherRoot}`],
  ],
  [
    "a trusted SHA-256 signature and one changed after signing",
    [ours, `80096010 ${sha256} ${publisher} ${root}`],
  ],
  ["a second signature with no digest algorithm", [ours, `00000000 - ${publisher} ${root}`]],
])("F-231: refuses when the running app's signatures have %s", (_case, running) => {
  expect(windowsRefusal(facts({ running: signed("running", ...running) }), proof)).toBe(
    "running-signature-untrusted",
  );
});

it.each([
  ["SHA-1 first and SHA-256 second", [`00000000 ${sha1} ${other} ${otherRoot}`, ours]],
  ["SHA-256 twice by the same publisher, as after signing again with a renewal", [ours, ours]],
])("F-231: reads the running app's publisher from its signatures, %s", (_case, running) => {
  expect(windowsRefusal(facts({ running: signed("running", ...running) }), proof)).toBeNull();
});

it.each([
  ["another file", `file 1234.0.9999 ${proof.size} ${proof.sha512}`],
  ["another size", `file ${proof.identity} 4097 -`],
  ["other bytes", `file ${proof.identity} ${proof.size} ${"B".repeat(86)}==`],
])("F-231: reports %s under the helper's hold as a changed download", (_case, file) => {
  expect(windowsRefusal(facts({ file }), proof)).toBe("artifact-changed");
});

it.each([
  ["no signature", ["800b0100 - - -"]],
  ["a change after signing", [`80096010 ${sha256} ${publisher} ${root}`]],
  ["a root Windows does not trust", [`800b0109 ${sha256} ${publisher} ${root}`]],
  ["an expired certificate", [`800b0101 ${sha256} ${publisher} ${root}`]],
  ["no signer", [`00000000 ${sha256} - -`]],
  ["no digest algorithm", [`00000000 - ${publisher} ${root}`]],
  ["only a SHA-1 signature, by the running app's publisher", [oursSha1]],
  [
    "a trusted SHA-1 signature and a SHA-256 one changed after signing",
    [oursSha1, `80096010 ${sha256} ${publisher} ${root}`],
  ],
  [
    "the running app's SHA-256 signature and another SHA-256 one Windows does not trust",
    [ours, `800b0109 ${sha256} ${publisher} ${otherRoot}`],
  ],
  // Every signature the file reports is read in full, or the file is refused.
  [
    "the running app's SHA-256 signature and one with no digest algorithm",
    [ours, `00000000 - ${publisher} ${root}`],
  ],
  ["the running app's SHA-256 signature and one with no signer", [ours, `80096010 ${sha1} - -`]],
])("F-231: refuses an installer with %s", (_case, installer) => {
  expect(windowsRefusal(facts({ installer: signed("installer", ...installer) }), proof)).toBe(
    "windows-signature",
  );
});

it.each([
  ["the running app's", "running", "running-signature-untrusted"],
  ["an installer's", "installer", "windows-signature"],
] as const)(
  "F-231: refuses %s signatures when Windows verified another one than the one asked for",
  (_case, name, refusal) => {
    for (const lines of [
      // Windows says it verified the first signature when asked for the second,
      [`signature 0 ${NO_INDEX} ${oursSha1}`, `signature 1 0 ${ours}`],
      // names no index for the second,
      [`signature 0 ${NO_INDEX} ${oursSha1}`, `signature 1 ${NO_INDEX} ${ours}`],
      // or names the second when asked for the first.
      [`signature 0 1 ${ours}`],
    ])
      expect(windowsRefusal(facts({ [name]: [`${name} ${lines.length}`, ...lines] }), proof)).toBe(
        refusal,
      );
  },
);

it("F-231: accepts a first signature that Windows names as index 0", () => {
  const installer = ["installer 1", `signature 0 0 ${ours}`];
  expect(windowsRefusal(facts({ installer }), proof)).toBeNull();
});

it.each([
  ["SHA-1 first and SHA-256 second, as electron-builder signs by default", [oursSha1, ours]],
  [
    "SHA-1 by another publisher first, SHA-256 by the running app's second",
    [`00000000 ${sha1} ${other} ${otherRoot}`, ours],
  ],
  ["SHA-256 alone", [ours]],
  // The same subject under the same root, from the original certificate and a renewal.
  ["SHA-256 twice by the running app's publisher, as when signed again later", [ours, ours]],
])("F-231: accepts an installer signed %s", (_case, installer) => {
  expect(windowsRefusal(facts({ installer: signed("installer", ...installer) }), proof)).toBeNull();
});

it.each([
  ["another subject under the running app's root", [`00000000 ${sha256} ${other} ${root}`]],
  [
    "the running app's subject under another root",
    [`00000000 ${sha256} ${publisher} ${otherRoot}`],
  ],
  [
    "the running app's SHA-1 signature, and another publisher's SHA-256 one",
    [oursSha1, `00000000 ${sha256} ${other} ${root}`],
  ],
  [
    "the running app's SHA-256 signature and another subject's appended after it",
    [ours, `00000000 ${sha256} ${other} ${root}`],
  ],
  [
    "the running app's SHA-256 signature and its subject's under another root",
    [ours, `00000000 ${sha256} ${publisher} ${otherRoot}`],
  ],
])("F-231: refuses %s as another publisher", (_case, installer) => {
  expect(windowsRefusal(facts({ installer: signed("installer", ...installer) }), proof)).toBe(
    "windows-publisher",
  );
});

it.each([
  ["no version resource", resources()],
  ["another version", resources(`1.2.1.0 ${base64("1.2.1")}`)],
  ["a beta of the same release", resources(`1.2.0.0 ${base64("1.2.0-beta.20261120.1")}`)],
  ["a version resource without ProductVersion", resources("1.2.0.0")],
  ["one translation without ProductVersion", resources(`1.2.0.0 ${base64(proof.version)} -`)],
  ["one translation with another ProductVersion", resources(`${offered} ${base64("1.2.1")}`)],
  ["a second version resource without ProductVersion", resources(offered, "1.2.0.0 -")],
  ["a second version resource with another one", resources(offered, `1.2.1.0 ${base64("1.2.1")}`)],
  ["another fixed major version", resources(`2.2.0.0 ${base64(proof.version)}`)],
  ["another fixed minor version", resources(`1.3.0.0 ${base64(proof.version)}`)],
  ["another fixed patch version", resources(`1.2.1.0 ${base64(proof.version)}`)],
  ["no fixed version", resources(`- ${base64(proof.version)}`)],
])("F-231: refuses an installer with %s", (_case, versions) => {
  expect(windowsRefusal(facts({ versions }), proof)).toBe("installer-version");
});

it.each([
  ["a build number in its fixed version", resources(`1.2.0.42 ${base64(proof.version)}`)],
  ["two translations that agree", resources(`${offered} ${base64(proof.version)}`)],
  ["two version resources that agree", resources(offered, offered)],
])("F-231: accepts an installer with %s", (_case, versions) => {
  expect(windowsRefusal(facts({ versions }), proof)).toBeNull();
});

it("F-231: a beta's installer gives the beta version as its ProductVersion, and the release's numbers", () => {
  const beta = { ...proof, version: "1.2.0-beta.20261120.1" };
  const versions = (product: string) => resources(`1.2.0.0 ${base64(product)}`);
  expect(windowsRefusal(facts({ versions: versions(beta.version) }), beta)).toBeNull();
  expect(windowsRefusal(facts({ versions: versions("1.2.0") }), beta)).toBe("installer-version");
});

it("F-231: a signed Windows build still withholds Download and Restart until the trial", () => {
  expect(windowsInstaller("C:\\Clawtrate\\Clawtrate.exe", vi.fn()).unavailable).toBe(
    "windows-install-pending-trial",
  );
});

it("F-231: inspect reads the download against the running app and reports the verdict", async () => {
  const inspect = vi.fn(async () =>
    facts({ installer: signed("installer", `80096010 ${sha256} - -`) }),
  );
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
