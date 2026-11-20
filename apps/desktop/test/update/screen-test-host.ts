import { DesktopUpdateService, type UpdateServiceOptions } from "../../src/main/update/service.ts";

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

declare const __TEST_FEED_PORT__: number;
export function startDesktopUpdates(
  options: Omit<UpdateServiceOptions, "feeds" | "releaseDate" | "loopbackHttpForTests">,
) {
  const origin = "http://127.0.0.1:" + __TEST_FEED_PORT__;
  return DesktopUpdateService.start({
    ...options,
    changed(snapshot) {
      if (!existsSync(join(dirname(options.downloadDir), "hold-events"))) options.changed(snapshot);
    },
    store: {
      get: (key) => options.store.get(key),
      async set(key, value) {
        if (key === "selectedTrack") {
          const profile = dirname(options.downloadDir);
          while (existsSync(join(profile, "hold-choice"))) await pause(20);
          if (existsSync(join(profile, "refuse-choice")))
            throw new Error("Fixture refused the preference write");
        }
        await options.store.set(key, value);
      },
    },
    packaged: true,
    feeds: { stable: origin + "/stable", nightly: origin + "/nightly" },
    releaseDate: null,
    loopbackHttpForTests: { port: __TEST_FEED_PORT__ },
  });
}
