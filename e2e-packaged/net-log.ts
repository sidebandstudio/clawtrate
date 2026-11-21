// What the packaged app's network log (`--log-net-log`) shows it asked for.
// Chromium finishes the file when the app quits, so a log read before then,
// or left by a crash, is cut short and fails to parse.

/** The address of every Hunspell dictionary (`.bdic`) the log shows a request for, each once. */
export function dictionaryRequests(log: string): string[] {
  const { events } = JSON.parse(log) as { events: { params?: { url?: unknown } }[] };
  const urls = events.flatMap(({ params }) =>
    typeof params?.url === "string" && /\.bdic$/i.test(params.url) ? [params.url] : [],
  );
  return [...new Set(urls)];
}
