const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function dayIndex(timestamp: number): number {
  const date = new Date(timestamp);
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY);
}

/** Whole calendar days between a time and now, in the viewer's time zone. */
export function daysAgo(timestamp: number, now = Date.now()): number {
  return dayIndex(now) - dayIndex(timestamp);
}

/**
 * The time on a rail row: today as "5:36 PM", then "Yesterday", a weekday
 * within the week, and "Nov 9" after that.
 */
export function rowTime(timestamp: number | null, now = Date.now()): string {
  if (timestamp === null) return "";
  const days = daysAgo(timestamp, now);
  const date = new Date(timestamp);
  if (days <= 0) return clockTime(timestamp);
  if (days === 1) return "Yesterday";
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A stamp between messages: "Today 5:36 PM", "Yesterday 9:02 AM", "Mon, Nov 9 2:14 PM". */
export function stampTime(timestamp: number, now = Date.now()): string {
  const days = daysAgo(timestamp, now);
  if (days <= 0) return `Today ${clockTime(timestamp)}`;
  if (days === 1) return `Yesterday ${clockTime(timestamp)}`;
  const date = new Date(timestamp);
  const day = date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `${day} ${clockTime(timestamp)}`;
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

/** A task's context use, for its header: "Context: 18,432 of 128,000 tokens". */
export function contextWords(
  context: { used: number; window: number; fresh: boolean } | undefined,
): string {
  if (!context) return "Context: unavailable";
  const n = (value: number) => value.toLocaleString(undefined);
  return `Context: ${context.fresh ? "" : "about "}${n(context.used)} of ${n(context.window)} tokens`;
}
