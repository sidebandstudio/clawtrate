// Typed words that mean Stop. The gateway itself treats its own abort words
// ("stop", "please stop", "/stop" and others, `abort-trigger-text` in OpenClaw
// 2026.10.6) as a command and stops the run, but not "Stop now", the words
// Grok Bot's guide tells a person to send. Clawtrate reads those as Stop: sent
// while a run is running or waiting, they stop it through `chat.abort` as the
// Stop button does, and are not sent as a message (parity F-097).

const TRAILING_PUNCTUATION = /[.!?…,;:'"’”)\]]+$/u;

/** The typed stop requests, written as the person might type them, normalized. */
const STOP_NOW = new Set(["stop now", "stop now please", "please stop now"]);

/**
 * The gateway's own abort words, which it handles as a command rather than a message: "/stop" and
 * these (`abort-trigger-text` and `isAbortRequestText` in OpenClaw 2026.10.6).
 */
const GATEWAY_STOP_WORDS = new Set([
  "/stop",
  "stop",
  "esc",
  "abort",
  "exit",
  "interrupt",
  "detente",
  "deten",
  "detén",
  "arrete",
  "arrête",
  "停止",
  "停下来",
  "暂停",
  "やめて",
  "止めて",
  "रुको",
  "توقف",
  "стоп",
  "остановись",
  "останови",
  "остановить",
  "прекрати",
  "halt",
  "anhalten",
  "aufhören",
  "hoer auf",
  "stopp",
  "pare",
  "stop openclaw",
  "openclaw stop",
  "stop action",
  "stop current action",
  "stop run",
  "stop current run",
  "stop agent",
  "stop the agent",
  "stop don't do anything",
  "stop dont do anything",
  "stop do not do anything",
  "stop doing anything",
  "do not do that",
  "please stop",
  "stop please",
]);

/** The gateway's trailing punctuation for its abort words. */
const GATEWAY_TRAILING_PUNCTUATION = /[.!?！？…,，。;；:：'"’”)\]}]+$/u;

/** Whether the gateway handles `text` as its stop command, normalized as it does. */
export function isStopCommand(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .replace(GATEWAY_TRAILING_PUNCTUATION, "")
    .trim();
  return GATEWAY_STOP_WORDS.has(normalized);
}

/** Whether `text` is a typed request to stop the run now. */
export function isStopNow(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(TRAILING_PUNCTUATION, "")
    .trim();
  return STOP_NOW.has(normalized);
}
