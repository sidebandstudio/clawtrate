// Typed words that mean Stop. The gateway itself treats its own abort words
// ("stop", "please stop", "/stop" and others, `abort-trigger-text` in OpenClaw
// 2026.10.6) as a command and stops the run, but not "Stop now", the words
// Grok Bot's guide tells a person to send. Clawtrate reads those as Stop: sent
// while a run is running or waiting, they stop it through `chat.abort` as the
// Stop button does, and are not sent as a message (parity F-097).

const TRAILING_PUNCTUATION = /[.!?…,;:'"’”)\]]+$/u;

/** The typed stop requests, written as the person might type them, normalized. */
const STOP_NOW = new Set(["stop now", "stop now please", "please stop now"]);

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
