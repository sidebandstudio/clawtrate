import { DesktopUpdateService, type UpdateServiceOptions } from "../../src/main/update/service.ts";

import type { UpdateInstallRefusal } from "@clawtrate/core";
import type { UpdateInstaller } from "../../src/main/update/install.ts";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

declare const __TEST_FEED_PORT__: number;
export async function startDesktopUpdates(
  options: Omit<UpdateServiceOptions, "feeds" | "releaseDate" | "loopbackHttpForTests">,
) {
  const origin = "http://127.0.0.1:" + __TEST_FEED_PORT__;
  const profile = dirname(options.downloadDir);
  const mode = process.env.UPDATE_SCREEN_TEST_INSTALLER;
  const refusal = join(profile, "inspect-refusal");
  const installer: UpdateInstaller = {
    unavailable: mode === "unsigned" ? "build-not-signed" : null,
    ...(mode === "mac" ? { completesOnQuit: true } : {}),
    requestsQuit: true,
    async inspect() {
      while (existsSync(join(profile, "hold-inspect"))) await pause(20);
      return existsSync(refusal) ? (readFileSync(refusal, "utf8") as UpdateInstallRefusal) : null;
    },
    async launch(_file, _signal, handed) {
      while (existsSync(join(profile, "hold-launch"))) await pause(20);
      if (existsSync(join(profile, "block-quit"))) return "quit-blocked";
      handed();
      return null;
    },
  };
  const service = await DesktopUpdateService.start({
    ...options,
    installer,
    quitAfterLaunch: () => {
      throw Error("Unexpected quit in screen test");
    },
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
  const restart = service.restart.bind(service);
  service.restart = (id) => {
    appendFileSync(join(profile, "restart-calls"), JSON.stringify(id) + "\n");
    return restart(id);
  };
  return service;
}
