// The in-tree lexer that runs before `json5` on OpenClaw's settings file
// (docs/design/setup-effortless.md §3, "Parsing"). `json5` has no depth or
// work limits of its own, so this pass bounds both and checks the whole
// structure first. It records the keys of every object, and refuses what the
// reader must never parse. Where it is stricter than JSON5 (a key with an
// escape, a key that isn't ASCII) it refuses: the file is then read by hand.

export const LEXER_LIMITS = { depth: 32, tokens: 20_000 } as const;

export type LexRefusal = "complex" | "malformed" | "duplicate" | "prototype" | "include";

const PROTOTYPE_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const VALUE_WORDS = new Set(["true", "false", "null", "Infinity", "NaN"]);
const SPACE = /[\t\n\v\f\r \u00a0\u2028\u2029\ufeff\p{Zs}]/uy;
const LINE_END = /[\n\r\u2028\u2029]/g;
const WORD = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const NUMBER =
  /[+-]?(?:Infinity|NaN|0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(?![A-Za-z0-9_$])/y;

/** An open object or array, what it expects next, and whether it is inside `gateway`. */
type Frame = {
  object: boolean;
  expects: "first" | "key" | "colon" | "value" | "next";
  keys: Set<string>;
  key: string;
  gateway: boolean;
};

/** Null when the text may go to `json5`; otherwise why not. */
export function lexSettings(text: string): LexRefusal | null {
  const stack: Frame[] = [];
  let tokens = 0;
  let done = false;
  let at = 0;

  const top = () => stack[stack.length - 1];
  /** A value starts here: top level, after an object's colon, or in an array. */
  const valueAllowed = () => {
    const frame = top();
    if (!frame) return !done;
    return frame.object ? frame.expects === "value" : frame.expects !== "next";
  };
  const valueDone = () => {
    const frame = top();
    if (frame) frame.expects = "next";
    else done = true;
  };

  while (at < text.length) {
    SPACE.lastIndex = at;
    if (SPACE.test(text)) {
      at = SPACE.lastIndex;
      continue;
    }
    if (++tokens > LEXER_LIMITS.tokens) return "complex";
    const char = text[at]!;
    if (text.startsWith("//", at)) {
      LINE_END.lastIndex = at;
      at = LINE_END.exec(text)?.index ?? text.length;
    } else if (text.startsWith("/*", at)) {
      const end = text.indexOf("*/", at + 2);
      if (end < 0) return "malformed";
      at = end + 2;
    } else if (char === "{" || char === "[") {
      if (!valueAllowed()) return "malformed";
      const parent = top();
      if (stack.length >= LEXER_LIMITS.depth) return "complex";
      stack.push({
        object: char === "{",
        expects: "first",
        keys: new Set(),
        key: "",
        gateway:
          parent !== undefined &&
          (parent.gateway || (stack.length === 1 && parent.object && parent.key === "gateway")),
      });
      at++;
    } else if (char === "}" || char === "]") {
      const frame = top();
      // An empty container, or a closing after a value or a trailing comma.
      const trailing = frame?.object ? frame.expects === "key" : frame?.expects === "value";
      if (
        !frame ||
        frame.object !== (char === "}") ||
        !(frame.expects === "first" || frame.expects === "next" || trailing)
      )
        return "malformed";
      stack.pop();
      valueDone();
      at++;
    } else if (char === ":") {
      const frame = top();
      if (!frame?.object || frame.expects !== "colon") return "malformed";
      frame.expects = "value";
      at++;
    } else if (char === ",") {
      const frame = top();
      if (!frame || frame.expects !== "next") return "malformed";
      frame.expects = frame.object ? "key" : "value";
      at++;
    } else {
      const frame = top();
      const isKey =
        frame?.object === true && (frame.expects === "first" || frame.expects === "key");
      let key: string | null = null;
      if (char === '"' || char === "'") {
        let end = at + 1;
        let escaped = false;
        for (; end < text.length && text[end] !== char; end++) {
          if (text[end] === "\n" || text[end] === "\r") return "malformed";
          if (text[end] === "\\") {
            escaped = true;
            end += text.startsWith("\r\n", end + 1) ? 2 : 1;
          }
        }
        if (end >= text.length) return "malformed";
        if (isKey && escaped) return "malformed";
        key = text.slice(at + 1, end);
        at = end + 1;
      } else {
        WORD.lastIndex = at;
        const word = WORD.exec(text)?.[0];
        if (word !== undefined && text[at + word.length] !== "\\") {
          if (!isKey && !VALUE_WORDS.has(word)) return "malformed";
          key = word;
          at += word.length;
        } else {
          NUMBER.lastIndex = at;
          const number = NUMBER.exec(text)?.[0];
          if (number === undefined || isKey) return "malformed";
          at += number.length;
        }
      }
      if (isKey && frame && key !== null) {
        if (PROTOTYPE_NAMES.has(key)) return "prototype";
        if (key === "$include" && (stack.length === 1 || frame.gateway)) return "include";
        if (frame.keys.has(key)) return "duplicate";
        frame.keys.add(key);
        frame.key = key;
        frame.expects = "colon";
      } else {
        if (!valueAllowed()) return "malformed";
        valueDone();
      }
    }
  }
  return done && stack.length === 0 ? null : "malformed";
}
