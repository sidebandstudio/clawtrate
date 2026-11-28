import { describe, expect, it, vi } from "vitest";
import {
  deliverChatLink,
  MAX_CHAT_LINK_BYTES,
  MAX_CHAT_LINK_TEXT,
  parseChatLink,
} from "../src/chat-link.ts";

const LOGS = ["debug", "error", "info", "log", "trace", "warn"] as const;
/** The console, which the core's settings do not type. */
declare const console: Record<(typeof LOGS)[number], (...data: unknown[]) => void>;

const GATEWAY = "0123456789abcdef".repeat(4);
const link = (text: string, rest = "") =>
  `clawtrate://chat?bot=marlow&gateway=${GATEWAY}&text=${text}${rest}`;

describe("Clawtrate links", () => {
  it("F-248: reads the bot, the gateway and the text, in any order", () => {
    expect(parseChatLink(link("Review%20the%20intro"))).toEqual({
      bot: "marlow",
      gateway: GATEWAY,
      text: "Review the intro",
    });
    expect(parseChatLink(`clawtrate://chat?text=Hi&gateway=${GATEWAY}&bot=a_bot-2`)).toEqual({
      bot: "a_bot-2",
      gateway: GATEWAY,
      text: "Hi",
    });
    expect(
      parseChatLink(`clawtrate://chat?bot=${"b".repeat(64)}&gateway=${GATEWAY}&text=x`)?.bot,
      "a 64-character bot id",
    ).toBe("b".repeat(64));
    expect(parseChatLink(`clawtrate://chat?bot=7&gateway=${GATEWAY}&text=x`)?.bot).toBe("7");
  });

  it("F-248: decodes each value once, as UTF-8, with a plus kept only when it is escaped", () => {
    expect(parseChatLink(link("1%2B1%3D2"))?.text).toBe("1+1=2");
    expect(parseChatLink(link("100%2525"))?.text, "decoded once").toBe("100%25");
    expect(parseChatLink(link("caf%C3%A9%20%F0%9F%A6%80"))?.text).toBe("café 🦀");
    expect(parseChatLink(link("a.b_c~d-e"))?.text).toBe("a.b_c~d-e");
    expect(parseChatLink(link("%3Cb%3Ehi%3C%2Fb%3E"))?.text, "markup stays text").toBe("<b>hi</b>");
    expect(
      parseChatLink(`clawtrate://chat?bot=%6Darlow&gateway=${GATEWAY}&text=x`)?.bot,
      "a value may be escaped",
    ).toBe("marlow");
  });

  it("F-248: refuses malformed escapes, invalid UTF-8 and characters a value may not hold", () => {
    for (const text of [
      "%",
      "%2",
      "%zz",
      "%C3",
      "%C3%28",
      "%ED%A0%80", // a surrogate
      "%C0%AF", // an overlong form
      "%FF",
      "a+b",
      "a b",
      "a=b",
      "a#b",
      "a/b",
      "a?b",
      "café",
    ]) {
      expect(parseChatLink(link(text)), text).toBeNull();
    }
  });

  it("F-248: refuses another scheme, route, host, port, path, userinfo or fragment", () => {
    const query = `bot=marlow&gateway=${GATEWAY}&text=x`;
    for (const raw of [
      `CLAWTRATE://chat?${query}`,
      `clawtrate://Chat?${query}`,
      `clawtrate:chat?${query}`,
      `clawtrate:///chat?${query}`,
      `clawtrate://chat/?${query}`,
      `clawtrate://chat/path?${query}`,
      `clawtrate://chat:80?${query}`,
      `clawtrate://user@chat?${query}`,
      `clawtrate://send?${query}`,
      `https://chat?${query}`,
      `clawtrate://chat?${query}#top`,
      `clawtrate://chat`,
      `clawtrate://chat?`,
      ` clawtrate://chat?${query}`,
    ]) {
      expect(parseChatLink(raw), raw).toBeNull();
    }
  });

  it("F-248: refuses unknown, missing, duplicate and empty fields, including a trailing &", () => {
    for (const raw of [
      link("x", "&send=1"),
      link("x", "&task=abc"),
      link("x", "&"),
      link("x", "&text=y"),
      link("x", "&bot=marlow"),
      `clawtrate://chat?bot=marlow&&gateway=${GATEWAY}&text=x`,
      `clawtrate://chat?bot=marlow&gateway=${GATEWAY}`,
      `clawtrate://chat?gateway=${GATEWAY}&text=x`,
      `clawtrate://chat?bot=marlow&text=x`,
      `clawtrate://chat?bot=marlow&gateway=${GATEWAY}&text`,
      `clawtrate://chat?bot=marlow&gateway=${GATEWAY}&text=x=y`,
      `clawtrate://chat?b%6Ft=marlow&gateway=${GATEWAY}&text=x`,
      `clawtrate://chat?Bot=marlow&gateway=${GATEWAY}&text=x`,
    ]) {
      expect(parseChatLink(raw), raw).toBeNull();
    }
  });

  it("F-248: refuses a bot id or gateway identity of the wrong form", () => {
    for (const bot of ["", "Marlow", "_marlow", "-m", "mar.low", "b".repeat(65), "%C3%A9"]) {
      expect(
        parseChatLink(`clawtrate://chat?bot=${bot}&gateway=${GATEWAY}&text=x`),
        bot,
      ).toBeNull();
    }
    for (const gateway of [
      "",
      GATEWAY.toUpperCase(),
      GATEWAY.slice(1),
      GATEWAY + "0",
      "g".repeat(64),
    ]) {
      expect(
        parseChatLink(`clawtrate://chat?bot=marlow&gateway=${gateway}&text=x`),
        gateway,
      ).toBeNull();
    }
  });

  it("F-248: turns CR and CRLF into LF and tabs into spaces, trims, and keeps the rest", () => {
    expect(parseChatLink(link("%20%20a%0D%0Ab%0Dc%09d%0A%0Ae%20%20"))?.text).toBe("a\nb\nc d\n\ne");
    expect(parseChatLink(link("%E3%81%93%E3%82%93%E3%81%AB%E3%81%A1%E3%81%AF"))?.text).toBe(
      "こんにちは",
    );
  });

  it("F-248: refuses control characters, line and paragraph separators and bidi controls", () => {
    for (const escape of [
      "%00",
      "%07",
      "%1B",
      "%7F",
      "%C2%85", // NEL
      "%C2%9F",
      "%E2%80%A8", // U+2028
      "%E2%80%A9", // U+2029
      "%D8%9C", // U+061C
      "%E2%80%8E", // U+200E
      "%E2%80%8F",
      "%E2%80%AA", // U+202A
      "%E2%80%AE", // U+202E
      "%E2%81%A6", // U+2066
      "%E2%81%A9", // U+2069
    ]) {
      expect(parseChatLink(link(`a${escape}b`)), escape).toBeNull();
    }
  });

  it("F-248: needs 1 to 2,000 code points of text after trimming", () => {
    expect(parseChatLink(link("")), "empty").toBeNull();
    expect(parseChatLink(link("%20%0A%09%20")), "only whitespace").toBeNull();
    const most = "a".repeat(MAX_CHAT_LINK_TEXT);
    expect(parseChatLink(link(most))?.text).toBe(most);
    expect(parseChatLink(link(most + "a")), "one too many").toBeNull();
    // An emoji is one code point, two UTF-16 units.
    const crabs = "%F0%9F%A6%80".repeat(600);
    expect([...(parseChatLink(link(crabs))?.text ?? "")]).toHaveLength(600);
    expect(parseChatLink(link(`%20%20${most}%20%20`))?.text, "spaces trimmed first").toBe(most);
  });

  it("F-248: refuses a raw link longer than 8,192 bytes, whatever its text", () => {
    const room = MAX_CHAT_LINK_BYTES - link("").length;
    // Six bytes for each character of text, so the text itself is well under the limit.
    const fits = link("%C3%A9".repeat(Math.floor(room / 6)) + "a".repeat(room % 6));
    expect(fits.length).toBe(MAX_CHAT_LINK_BYTES);
    expect(parseChatLink(fits)).not.toBeNull();
    expect(parseChatLink(fits + "a"), "one byte over").toBeNull();
  });

  it("F-248: hands the interface the values, or that the link was invalid, never the raw link", () => {
    expect(deliverChatLink(3, link("Hi"))).toEqual({
      id: 3,
      status: "valid",
      link: { bot: "marlow", gateway: GATEWAY, text: "Hi" },
    });
    expect(deliverChatLink(4, link("Hi", "&send=1"))).toEqual({ id: 4, status: "invalid" });
  });

  it("F-248: refuses a link without logging it or its text", () => {
    const logged = LOGS.map((name) => vi.spyOn(console, name).mockImplementation(() => {}));
    try {
      for (const raw of [link("%C3"), link("a%00b"), link("Hi", "&send=1"), "clawtrate://x"])
        expect(deliverChatLink(1, raw)).toEqual({ id: 1, status: "invalid" });
      for (const spy of logged) expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
