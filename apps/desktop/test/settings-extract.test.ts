// The settings reader's parsing rules (docs/design/setup-effortless.md §3,
// "Parsing" and "What it extracts"): the lexer's limits and rejections, then
// what is taken from a parsed file. Every rejection has its own fixture, and
// each fixture differs from an accepted file by that one fault.

import { describe, expect, it } from "vitest";
import {
  extractSettings,
  TOKEN_MAX_BYTES,
  type SettingsProfile,
} from "../src/setup/settings-extract.ts";
import { LEXER_LIMITS, lexSettings } from "../src/setup/settings-lexer.ts";

const TOKEN = "dev-token.0123456789abcdef";
/** An accepted file, with `gateway` replaced by the argument. */
const withGateway = (gateway: string) => `{ gateway: ${gateway} }`;
const tokenAuth = (auth: string) => withGateway(`{ mode: "local", port: 19555, auth: ${auth} }`);
const refused = (reason: string, why: string) => ({ kind: "refused", reason, why });
const extract = (text: string, profile: SettingsProfile = "default") =>
  extractSettings(text, profile);

describe("the lexer", () => {
  it.each([
    ["JSON", `{"gateway": {"port": 1, "auth": {"token": "a"}}, "list": [1, 2.5e3, -0, null]}`],
    ["comments", `// top\n{ /* a */ gateway: { port: 1 } // end\n}`],
    ["trailing commas", `{ a: [1, 2,], b: { c: 'x', }, }`],
    ["JSON5 numbers", `{ a: 0x1F, b: .5, c: +Infinity, d: -NaN, e: 5. }`],
    ["escapes in values", `{ a: "line\\nnext \\u0041 \\"q\\"", b: 'it\\'s', c: "cont\\\nued" }`],
    ["escaped line and paragraph separators", `{ a: "x\\u2028y\\u2029z", b: "cont\\\u2028ued" }`],
    ["an include outside gateway", `{ agents: { $include: "./agents.json5" } }`],
    ["the same key in two objects", `{ a: { x: 1 }, b: { x: 2 } }`],
    ["empty containers", `{ a: {}, b: [] }`],
  ])("passes %s", (_, text) => {
    expect(lexSettings(text)).toBe(null);
  });

  it("refuses nesting deeper than its limit, and allows the limit", () => {
    const nest = (depth: number) => "[".repeat(depth) + "]".repeat(depth);
    expect(lexSettings(nest(LEXER_LIMITS.depth))).toBe(null);
    expect(lexSettings(nest(LEXER_LIMITS.depth + 1))).toBe("complex");
  });

  it("refuses more tokens than its limit, and allows the limit", () => {
    // `[`, `]`, and a value and a comma per item.
    const list = (items: number) => `[${"0,".repeat(items)}]`;
    const items = (LEXER_LIMITS.tokens - 2) / 2;
    expect(lexSettings(list(items))).toBe(null);
    expect(lexSettings(list(items) + " ")).toBe(null);
    expect(lexSettings(`[0,${"0,".repeat(items)}]`)).toBe("complex");
  });

  it("counts comments as tokens", () => {
    expect(lexSettings(`${"/**/".repeat(LEXER_LIMITS.tokens)}{}`)).toBe("complex");
  });

  it.each([
    ["a quoted duplicate", `{ "a": 1, "a": 2 }`],
    ["an unquoted and a quoted duplicate", `{ a: 1, 'a': 2 }`],
    ["a duplicate under gateway", withGateway(`{ auth: { token: "a", token: "b" } }`)],
  ])("refuses %s", (_, text) => {
    expect(lexSettings(text)).toBe("duplicate");
  });

  it.each(["__proto__", "constructor", "prototype"])("refuses the key %s anywhere", (name) => {
    expect(lexSettings(`{ ${name}: {} }`)).toBe("prototype");
    expect(lexSettings(`{ a: [{ "${name}": 1 }] }`)).toBe("prototype");
  });

  it.each([
    ["at the root", `{ $include: "./more.json5", gateway: {} }`],
    ["in gateway", withGateway(`{ $include: "./gateway.json5" }`)],
    ["deep under gateway", withGateway(`{ auth: { "$include": "./auth.json5" } }`)],
    ["in an array under gateway", withGateway(`{ list: [{ $include: "./x.json5" }] }`)],
    ["under env", `{ env: { $include: "./env.json5" } }`],
    ["under env.vars", `{ env: { vars: { "$include": "./vars.json5" } } }`],
  ])("refuses $include %s", (_, text) => {
    expect(lexSettings(text)).toBe("include");
  });

  it.each([
    ["an escaped key, which could spell another", `{ "\\u0061": 1 }`],
    ["an escaped unquoted key", `{ \\u0061: 1 }`],
    ["a word that isn't a value", `{ a: undefined }`],
    ["a numeric key", `{ 1: 2 }`],
    ["a missing colon", `{ a 1 }`],
    ["a missing comma", `{ a: 1 b: 2 }`],
    ["a lone comma", `[,]`],
    ["two values", `{} {}`],
    ["an unclosed object", `{ a: 1`],
    ["a mismatched close", `{ a: [1} ]`],
    ["an unterminated string", `{ a: "x }`],
    ["a newline in a string", `{ a: "x\ny" }`],
    ["an unterminated comment", `{} /*`],
    ["a raw line separator in a string", `{ a: "x\u2028y" }`],
    ["a raw paragraph separator in a string", `{ a: 'x\u2029y' }`],
    ["a close after a colon", `{ a: }`],
    ["nothing", ``],
  ])("refuses %s as malformed", (_, text) => {
    expect(lexSettings(text)).toBe("malformed");
  });
});

describe("what is taken from the settings", () => {
  it("takes a local gateway's literal token and port", () => {
    expect(extract(tokenAuth(`{ mode: "token", token: "${TOKEN}" }`))).toEqual({
      kind: "found",
      token: TOKEN,
      port: 19555,
    });
  });

  it("takes an absent mode, an absent auth mode and the default port", () => {
    expect(extract(withGateway(`{ auth: { token: "${TOKEN}" } }`))).toEqual({
      kind: "found",
      token: TOKEN,
      port: 18789,
    });
  });

  it("trims as OpenClaw does and keeps ordinary punctuation", () => {
    const token = `a-b_c.d~e!f@g#h%i^j&k*l(m)n+o=p[q]r{s}t|u;v:w'x"y,z<>?/`;
    const quoted = JSON.stringify(`  ${token}\t`);
    expect(extract(tokenAuth(`{ token: ${quoted} }`))).toMatchObject({ token });
  });

  // A token and a password, with the mode absent, token, or password: never a token.
  it.each([
    ["no mode", `{ token: "${TOKEN}", password: "pw" }`],
    ["token mode", `{ mode: "token", token: "${TOKEN}", password: "pw" }`],
    ["an empty password", `{ mode: "token", token: "${TOKEN}", password: "" }`],
    ["a null password", `{ token: "${TOKEN}", password: null }`],
  ])("never stages a token beside a password: %s", (_, auth) => {
    expect(extract(tokenAuth(auth))).toEqual(refused("credential", "password"));
  });

  // With the mode absent, a password OpenClaw could resolve elsewhere would make it password mode.
  it.each([
    [
      "a remote password",
      withGateway(`{ remote: { password: "pw" }, auth: { token: "${TOKEN}" } }`),
    ],
    [
      "a password in env",
      `{ env: { OPENCLAW_GATEWAY_PASSWORD: "pw" }, ${withGateway(`{ auth: { token: "${TOKEN}" } }`).slice(1)}`,
    ],
    [
      "a password in env.vars",
      `{ env: { vars: { OPENCLAW_GATEWAY_PASSWORD: "pw" } }, ${withGateway(`{ auth: { token: "${TOKEN}" } }`).slice(1)}`,
    ],
    [
      "a lower-case key in env",
      `{ env: { openclaw_gateway_password: "" }, ${withGateway(`{ auth: { token: "${TOKEN}" } }`).slice(1)}`,
    ],
    [
      "a padded key in env",
      `{ env: { " OPENCLAW_GATEWAY_PASSWORD": "pw" }, ${withGateway(`{ auth: { token: "${TOKEN}" } }`).slice(1)}`,
    ],
    [
      "a padded key in env.vars",
      `{ env: { vars: { "OPENCLAW_GATEWAY_PASSWORD ": "pw" } }, ${withGateway(`{ auth: { token: "${TOKEN}" } }`).slice(1)}`,
    ],
    [
      "a tab-padded key in env",
      `{ env: { "\tOPENCLAW_GATEWAY_PASSWORD": "pw" }, ${withGateway(`{ auth: { token: "${TOKEN}" } }`).slice(1)}`,
    ],
    [
      "the login-shell import turned on",
      `{ env: { shellEnv: { enabled: true } }, ${withGateway(`{ auth: { token: "${TOKEN}" } }`).slice(1)}`,
    ],
    [
      "the login-shell import turned on by the file's env",
      `{ env: { vars: { OPENCLAW_LOAD_SHELL_ENV: "1" } }, ${withGateway(`{ auth: { token: "${TOKEN}" } }`).slice(1)}`,
    ],
  ])("refuses an implicit mode beside %s", (_, text) => {
    expect(extract(text)).toEqual(refused("credential", "password"));
  });

  it.each([
    [
      "a remote password",
      withGateway(`{ remote: { password: "pw" }, auth: { mode: "token", token: "${TOKEN}" } }`),
    ],
    [
      "a password in env",
      `{ env: { OPENCLAW_GATEWAY_PASSWORD: "pw" }, ${withGateway(`{ auth: { mode: "token", token: "${TOKEN}" } }`).slice(1)}`,
    ],
    [
      "a password in env.vars",
      `{ env: { vars: { OPENCLAW_GATEWAY_PASSWORD: "pw" } }, ${withGateway(`{ auth: { mode: "token", token: "${TOKEN}" } }`).slice(1)}`,
    ],
    [
      "a padded key in env",
      `{ env: { " OPENCLAW_GATEWAY_PASSWORD": "pw" }, ${withGateway(`{ auth: { mode: "token", token: "${TOKEN}" } }`).slice(1)}`,
    ],
    [
      "a padded key in env.vars",
      `{ env: { vars: { "OPENCLAW_GATEWAY_PASSWORD ": "pw" } }, ${withGateway(`{ auth: { mode: "token", token: "${TOKEN}" } }`).slice(1)}`,
    ],
    [
      "login-shell import",
      `{ env: { shellEnv: { enabled: true } }, ${withGateway(`{ auth: { mode: "token", token: "${TOKEN}" } }`).slice(1)}`,
    ],
  ])("takes an explicit token beside an unused %s", (_, text) => {
    expect(extract(text)).toEqual({ kind: "found", token: TOKEN, port: 18789 });
  });

  it.each(["password", "none", "trusted-proxy", "", "TOKEN"])(
    "refuses the auth mode %j",
    (mode) => {
      expect(extract(tokenAuth(`{ mode: "${mode}", token: "${TOKEN}" }`))).toEqual(
        refused("credential", "auth-mode"),
      );
    },
  );

  it.each([
    ["a SecretRef", `{ source: "env", provider: "default", id: "OPENCLAW_TOKEN" }`, "secret-ref"],
    ["a legacy SecretRef", `{ source: "file", id: "token" }`, "secret-ref"],
    ["a number", `12345`, "secret-ref"],
    ["null", `null`, "secret-ref"],
    ["${…}", `"\${OPENCLAW_TOKEN}"`, "indirect"],
    ["${…} inside text", `"abc\${OPENCLAW_TOKEN}def"`, "indirect"],
    ["an escaped $${…}", '"$$' + '{OPENCLAW_TOKEN}"', "indirect"],
    ["$NAME", '"$OPENCLAW_TOKEN"', "indirect"],
    ["a legacy env marker", `"secretref-env:OPENCLAW_TOKEN"`, "indirect"],
    ["an older env marker", `"__env__:OPENCLAW_TOKEN"`, "indirect"],
    ["OpenClaw's example token", `"change-me-to-a-long-random-token"`, "placeholder"],
    ["OpenClaw's short example", `" change-me-now "`, "placeholder"],
    ["the word undefined", `"undefined"`, "placeholder"],
    ["the word null", `"null"`, "placeholder"],
    ["the redaction sentinel", `"__OPENCLAW_REDACTED__"`, "redacted"],
    ["the sentinel with spaces", `" __OPENCLAW_REDACTED__ "`, "redacted"],
    ["another display marker", `"[REDACTED]"`, "redacted"],
    ["an empty token", `""`, "empty"],
    ["only spaces", `"  \\t "`, "empty"],
    ["a token too long", JSON.stringify("x".repeat(TOKEN_MAX_BYTES + 1)), "long"],
    ["a token too long in bytes", JSON.stringify("é".repeat(TOKEN_MAX_BYTES / 2 + 1)), "long"],
    ["a NUL", `"abc\\u0000def"`, "control"],
    ["a newline inside", `"abc\\ndef"`, "control"],
    ["DEL", `"abc\\u007fdef"`, "control"],
    ["a C1 control", `"abc\\u0085def"`, "control"],
    ["a line separator", `"abc\\u2028def"`, "control"],
    ["a paragraph separator", `"abc\\u2029def"`, "control"],
  ])("refuses %s as the token", (_, value, why) => {
    expect(extract(tokenAuth(`{ token: ${value} }`))).toEqual(refused("credential", why));
  });

  it.each(["$cost-2026", "$lower_case", "$1ABC", "a$NAME", "$"])(
    "keeps a literal %j that isn't OpenClaw's $NAME shorthand",
    (token) => {
      expect(extract(tokenAuth(`{ token: "${token}" }`))).toMatchObject({ kind: "found", token });
    },
  );

  it("allows a token at the length limit", () => {
    const token = "x".repeat(TOKEN_MAX_BYTES);
    expect(extract(tokenAuth(`{ token: "${token}" }`))).toMatchObject({ token });
  });

  it.each([
    ["no gateway", `{ agents: {} }`, "no-token"],
    ["no auth", withGateway(`{ port: 19555 }`), "no-token"],
    ["no token", tokenAuth(`{ mode: "token" }`), "no-token"],
  ])("finds no credential with %s", (_, text, why) => {
    expect(extract(text)).toEqual(refused("credential", why));
  });

  it.each(["remote", "Local", ""])("refuses the gateway mode %j", (mode) => {
    expect(extract(withGateway(`{ mode: "${mode}", auth: { token: "a" } }`))).toEqual(
      refused("address", "remote"),
    );
  });

  it.each(["0", "65536", "-1", "19555.5", `"19555"`, "Infinity", "NaN", "null"])(
    "refuses the port %s",
    (port) => {
      expect(extract(withGateway(`{ port: ${port}, auth: { token: "a" } }`))).toEqual(
        refused("address", "port"),
      );
    },
  );

  /** A file whose `env` or `env.vars` sets the login-shell switch to this value, with the auth mode absent or token. */
  const withSwitch = (where: "env" | "vars", value: unknown, mode = "") => {
    const declared = `OPENCLAW_LOAD_SHELL_ENV: ${JSON.stringify(value)}`;
    const env = where === "env" ? `{ ${declared} }` : `{ vars: { ${declared} } }`;
    return `{ env: ${env}, ${withGateway(`{ auth: { ${mode}token: "${TOKEN}" } }`).slice(1)}`;
  };

  // OpenClaw reads the switch with `isTruthyEnvValue`: on for true, 1, yes and on, in any case
  // and trimmed; anything else off. It applies only string values.
  describe.each(["env", "vars"] as const)("the login-shell switch in %s", (where) => {
    it.each(["0", "false", "off", "no", " OFF ", "", "maybe"])(
      "takes an implicit mode when it is %j",
      (value) => {
        expect(extract(withSwitch(where, value))).toEqual({
          kind: "found",
          token: TOKEN,
          port: 18789,
        });
      },
    );

    it.each([true, 1])("takes an implicit mode when it isn't text (%j)", (value) => {
      expect(extract(withSwitch(where, value))).toMatchObject({ kind: "found" });
    });

    it.each(["1", "true", "yes", "on", " On ", "TRUE", "${LOAD_SHELL}"])(
      "refuses an implicit mode when it is %j",
      (value) => {
        expect(extract(withSwitch(where, value))).toEqual(refused("credential", "password"));
      },
    );

    it("takes an explicit token when it is on", () => {
      expect(extract(withSwitch(where, "1", 'mode: "token", '))).toMatchObject({ kind: "found" });
    });
  });

  it("takes an implicit mode when the login-shell import is plainly off", () => {
    const off = `{ env: { shellEnv: { enabled: false, timeoutMs: 1000 } }, ${withGateway(`{ auth: { token: "${TOKEN}" } }`).slice(1)}`;
    expect(extract(off)).toEqual({ kind: "found", token: TOKEN, port: 18789 });
  });

  it("takes each profile's own default port when the file names none", () => {
    const text = withGateway(`{ auth: { token: "${TOKEN}" } }`);
    expect(extract(text, "default")).toMatchObject({ port: 18789 });
    expect(extract(text, "clawtrate")).toMatchObject({ port: 22768 });
    expect(
      extract(withGateway(`{ port: 19556, auth: { token: "a" } }`), "clawtrate"),
    ).toMatchObject({ port: 19556 });
  });

  it.each([
    [
      "env",
      `{ env: { OPENCLAW_GATEWAY_PORT: "19999" }, gateway: { port: 19555, auth: { token: "a" } } }`,
    ],
    [
      "env.vars",
      `{ env: { vars: { OPENCLAW_GATEWAY_PORT: "19999" } }, gateway: { auth: { token: "a" } } }`,
    ],
    [
      "a lower-case key",
      `{ env: { openclaw_gateway_port: "19999" }, gateway: { auth: { token: "a" } } }`,
    ],
    [
      "a padded key",
      `{ env: { " OPENCLAW_GATEWAY_PORT": "19999" }, gateway: { auth: { token: "a" } } }`,
    ],
    [
      "a tab-padded key in env.vars",
      `{ env: { vars: { "OPENCLAW_GATEWAY_PORT\t": "19999" } }, gateway: { auth: { token: "a" } } }`,
    ],
  ])("refuses a port the file's %s could override", (_, text) => {
    expect(extract(text)).toEqual(refused("address", "port"));
  });

  it.each([
    ["a root that isn't an object", `[1]`],
    ["a gateway that isn't an object", `{ gateway: [] }`],
    ["auth that isn't an object", withGateway(`{ auth: "token" }`)],
  ])("refuses %s", (_, text) => {
    expect(extract(text)).toEqual(refused("unreadable", "shape"));
  });

  it("refuses what the lexer refuses before parsing it", () => {
    expect(extract(tokenAuth(`{ token: "a", token: "b" }`))).toEqual(
      refused("unreadable", "duplicate"),
    );
    expect(extract(`{ $include: "./x.json5" }`)).toEqual(refused("unreadable", "include"));
  });

  it("refuses what json5 itself can't parse", () => {
    // Leading zeros pass the lexer's number shape; json5 refuses them.
    expect(extract(`{ a: 01 }`)).toEqual(refused("unreadable", "malformed"));
  });
});
