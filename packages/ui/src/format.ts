const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact list time: "now", "5m", "3h", "Tue", "Mar 4". */
export function shortTime(timestamp: number | null, now = Date.now()): string {
  if (timestamp === null) return "";
  const delta = now - timestamp;
  if (delta < MINUTE) return "now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  const date = new Date(timestamp);
  if (delta < 6 * DAY) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clockTime(timestamp: number | null): string {
  if (timestamp === null) return "";
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function fullDate(timestamp: number | null): string {
  if (timestamp === null) return "";
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** One-line summary of a tool call's arguments, for the collapsed row. */
export function summarizeArguments(argumentsText: string): string {
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed);
      const shown = entries.slice(0, 2).map(([key, value]) => {
        const text = (typeof value === "string" ? value : JSON.stringify(value)).replace(
          /\s+/g,
          " ",
        );
        return `${key}: ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`;
      });
      if (entries.length > 2) shown.push(`+${entries.length - 2}`);
      return shown.join("  ");
    }
  } catch {
    // Not JSON; show it raw.
  }
  return argumentsText.replace(/\s+/g, " ");
}

export function gatewayLabel(url: string | null): string {
  if (!url) return "No gateway";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
