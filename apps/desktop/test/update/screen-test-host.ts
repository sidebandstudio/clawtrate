import { DesktopUpdateService, type UpdateServiceOptions } from "../../src/main/update/service.ts";

declare const __TEST_FEED_PORT__: number;
export function startDesktopUpdates(
  options: Omit<UpdateServiceOptions, "feeds" | "releaseDate" | "loopbackHttpForTests">,
) {
  const origin = "http://127.0.0.1:" + __TEST_FEED_PORT__;
  return DesktopUpdateService.start({
    ...options,
    packaged: true,
    feeds: { stable: origin + "/stable", nightly: origin + "/nightly" },
    releaseDate: null,
    loopbackHttpForTests: { port: __TEST_FEED_PORT__ },
  });
}
