// Which launches keep this device's credentials in the Keychain through safeStorage, and
// that no shipped host turns full access on: it stays off until the paths that need it
// bring their own consent and transport checks (docs/decisions.md, "Scopes, once, at the first pairing").

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { mustSandbox } from "../src/setup/world.ts";
import {
  keychainCheckName,
  MOCK_KEYCHAIN_SWITCH,
  safeStorageBox,
  usesSecureStorage,
  type SafeStorageLike,
} from "../src/main/secret-box.ts";

const ROOT = join(import.meta.dirname, "../../..");

function fakeSafeStorage(available: boolean, backend = "unknown"): SafeStorageLike {
  return {
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async (text) => Buffer.from(`sealed:${text}`),
    decryptStringAsync: async (data) => ({ result: data.toString().replace(/^sealed:/, "") }),
    getSelectedStorageBackend: () => backend,
  };
}

/** Every TypeScript source file under a folder. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("the Keychain through safeStorage", () => {
  it("is available where safeStorage says so, except Linux's basic_text, which protects nothing", async () => {
    expect(await safeStorageBox(fakeSafeStorage(true), "darwin").available()).toBe(true);
    expect(await safeStorageBox(fakeSafeStorage(false), "darwin").available()).toBe(false);
    const basic = fakeSafeStorage(true, "basic_text");
    expect(await safeStorageBox(basic, "linux").available()).toBe(false);
    expect(
      await safeStorageBox(fakeSafeStorage(true, "gnome_libsecret"), "linux").available(),
    ).toBe(true);
    const box = safeStorageBox(fakeSafeStorage(true), "darwin");
    expect(await box.decrypt(await box.encrypt("record"))).toBe("record");
  });

  it("is used by a person's app on macOS, and by a packaged launch check under its own name only", () => {
    const production = { kind: "production" };
    const sandbox = { kind: "sandbox" };
    expect(usesSecureStorage(production, "darwin", null)).toBe(true);
    expect(usesSecureStorage(production, "win32", null)).toBe(false);
    expect(usesSecureStorage(sandbox, "darwin", null)).toBe(false);
    expect(usesSecureStorage({ kind: "refused" }, "darwin", null)).toBe(false);

    const hex = "0123456789abcdef";
    expect(keychainCheckName(sandbox, true, "darwin", hex)).toBe(`Clawtrate Check ${hex}`);
    expect(usesSecureStorage(sandbox, "darwin", `Clawtrate Check ${hex}`)).toBe(true);
    // Never a person's app, a development build, another system or another name.
    expect(keychainCheckName(production, true, "darwin", hex)).toBe(null);
    expect(keychainCheckName(sandbox, false, "darwin", hex)).toBe(null);
    expect(keychainCheckName(sandbox, true, "win32", hex)).toBe(null);
    for (const value of ["", "0123456789ABCDEF", `${hex}0`, "Clawtrate", "../x"])
      expect(keychainCheckName(sandbox, true, "darwin", value), value).toBe(null);
  });

  it("Chromium's mock Keychain is never used: such a launch is sandboxed, and keeps no credentials there", () => {
    const mock = (name: string) => name === MOCK_KEYCHAIN_SWITCH;
    expect(mustSandbox({ packaged: true, env: {}, switches: mock })).toBe(true);
    const hex = "0123456789abcdef";
    for (const kind of ["production", "sandbox"]) {
      expect(usesSecureStorage({ kind }, "darwin", null, true), kind).toBe(false);
      expect(keychainCheckName({ kind }, true, "darwin", hex, true), kind).toBe(null);
    }
    expect(usesSecureStorage({ kind: "sandbox" }, "darwin", `Clawtrate Check ${hex}`, true)).toBe(
      false,
    );
  });

  it("full access has no switch: it follows from the Keychain box, on a host that allows writes", () => {
    const shipped = [
      ...sources(join(ROOT, "apps/desktop/src")),
      ...sources(join(ROOT, "packages/ui/src")),
      ...sources(join(ROOT, "packages/core/src")),
    ];
    // No option turns it on or off (docs/decisions.md, 2026-11-25): only the client's own
    // state for the current connection, set in one place.
    const allowed = [
      "packages/core/src/client.ts PropertyDeclaration private fullAccess = false;",
      "packages/core/src/client.ts assignment this.fullAccess = routed && secure",
    ];
    const found: string[] = [];
    const named = (name: ts.Node | undefined) =>
      name !== undefined &&
      (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isPrivateIdentifier(name)
        ? name.text === "fullAccess"
        : ts.isComputedPropertyName(name));
    for (const file of shipped) {
      const path = relative(ROOT, file).split(sep).join("/");
      const text = readFileSync(file, "utf8");
      if (!text.includes("fullAccess")) continue;
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        const say = (kind: string, at: ts.Node = node) =>
          found.push(`${path} ${kind} ${at.getText(source).replace(/\s+/g, " ")}`);
        if (
          (ts.isPropertyAssignment(node) ||
            ts.isShorthandPropertyAssignment(node) ||
            ts.isPropertyDeclaration(node) ||
            ts.isPropertySignature(node) ||
            ts.isMethodDeclaration(node) ||
            ts.isGetAccessorDeclaration(node) ||
            ts.isSetAccessorDeclaration(node)) &&
          named(node.name) &&
          !ts.isComputedPropertyName(node.name)
        )
          say(ts.SyntaxKind[node.kind]!);
        else if (ts.isStringLiteralLike(node) && node.text.includes("fullAccess")) say("string");
        else if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
          node.left.getText(source).includes("fullAccess")
        )
          say("assignment");
        else if (
          ts.isPropertyAccessExpression(node) &&
          node.name.text === "fullAccess" &&
          !(
            ts.isBinaryExpression(node.parent) &&
            node.parent.left === node &&
            node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ) &&
          !ts.isPropertyAccessExpression(node.parent)
        )
          say("read");
        else if (ts.isElementAccessExpression(node) || ts.isComputedPropertyName(node)) {
          if (node.getText(source).includes("fullAccess")) say("computed");
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    // The state's declaration and one assignment; reads of that state decide scopes, and set
    // nothing.
    const reads = found.filter((line) => line.endsWith("read this.fullAccess"));
    expect(found.filter((line) => !line.endsWith("read this.fullAccess")).sort()).toEqual(
      allowed.sort(),
    );
    expect(reads.every((line) => line.startsWith("packages/core/src/client.ts "))).toBe(true);
    const client = readFileSync(join(ROOT, "packages/core/src/client.ts"), "utf8");
    expect(client).toContain("const full = !this.options.readOnly;");
    // A protected address, or this computer's gateway when every socket of the connection is
    // proved, for a plain connect's token; a first pairing there needs the person's consent
    // (setup-effortless.md §3).
    expect(client).toContain(
      "const proved = !this.setupIntent && !this.setupCode && this.socketsProved(settings.url);",
    );
    expect(client).toContain(
      "const routed = full && (protectedGatewayUrl(settings.url) || proved);",
    );
    // Every socket is the setup's own factory, with its last proof, retries on it included, or
    // the route the gateway was saved with; the gate reads exactly that, and nothing looser.
    expect(client).toContain(
      "? { createSocket: this.setupCheck.createSocket, prove: this.setupCheck.prove }",
    );
    expect(client).toContain(
      "const create = own?.createSocket ?? (fromRoute ? fromRoute.createSocket : undefined);",
    );
    expect(client).toContain(
      [
        "  private socketsProved(url: string): boolean {",
        "    const check = this.setupCheck?.url === url ? this.setupCheck : null;",
        "    // The setup's own factory, when it has one, makes every socket: its last proof decides.",
        "    if (check?.createSocket) return !!check.prove;",
        "    return this.savedRoute?.url === url && !!this.savedRoute.sockets;",
        "  }",
      ].join("\n"),
    );
    expect(client).toContain("return consent?.() === true;");
    // The main process gives the host the Keychain box only in the branch that uses it.
    const main = readFileSync(join(ROOT, "apps/desktop/src/main/index.ts"), "utf8");
    expect(main).toMatch(
      /hasSwitch\(MOCK_KEYCHAIN_SWITCH\),\s*\)\s*\?\s*(\/\/[^\n]*\n\s*)?\{\s*secretBox: safeStorageBox\(safeStorage, process\.platform\)\s*\}\s*:\s*\{\}/,
    );
    // The runtime says so to the interface only with a box, and never on a read-only host.
    const runtime = readFileSync(join(ROOT, "apps/desktop/src/host/runtime.ts"), "utf8");
    expect(runtime).toContain("const full = !!options.secretBox && !options.readOnly;");
  });
});
