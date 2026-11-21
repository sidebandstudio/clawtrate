// What the packaged app's network log (`--log-net-log`) shows it asked for.
// Chromium finishes the file when the app quits, so a log read before then,
// or left by a crash, is cut short and fails to parse.

type Events = { params?: { url?: unknown } }[];

/** Whether an address names a Hunspell dictionary (`.bdic`), judged by its path alone. */
export function isDictionary(url: string): boolean {
  return /\.bdic$/i.test(URL.parse(url)?.pathname ?? "");
}

/** Every address the events ask for, each once, in the order first asked. */
function addresses(events: Events): string[] {
  const urls = events.flatMap((event) =>
    typeof event?.params?.url === "string" ? [event.params.url] : [],
  );
  return [...new Set(urls)];
}

/** The address of every dictionary a finished log shows a request for, each once. */
export function dictionaryRequests(log: string): string[] {
  return addresses((JSON.parse(log) as { events: Events }).events).filter(isDictionary);
}
