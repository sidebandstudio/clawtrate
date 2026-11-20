// Only the desktop update screen test selects this build config. Production's
// entry always uses its own compiled sources and has no loopback transport.
import { fileURLToPath } from "node:url";
import config from "../../electron.vite.config.ts";

const port = Number(process.env.UPDATE_SCREEN_TEST_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Missing test feed port");
export default {
  ...config,
  main: {
    ...config.main,
    define: { ...config.main?.define, __TEST_FEED_PORT__: String(port) },
    resolve: {
      alias: {
        "./update/build-info.ts": fileURLToPath(new URL("./screen-test-host.ts", import.meta.url)),
      },
    },
  },
};
