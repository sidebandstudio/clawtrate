import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { LOCAL_GATEWAY_HELPER, localGatewayBuild } from "../../apps/desktop/packaging/config.ts";

const [app] = process.argv.slice(2);
if (
  process.platform !== "darwin" ||
  process.arch !== "arm64" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
  process.env.GITHUB_EVENT_NAME !== "pull_request" ||
  !app ||
  !isAbsolute(app) ||
  !app.endsWith(".app")
) {
  throw new Error("This check only adds a helper to a pull request build on a hosted Mac.");
}

const contents = join(app, "Contents");
const helpers = join(contents, "Helpers");
const helper = join(helpers, LOCAL_GATEWAY_HELPER);
if (!existsSync(join(contents, "MacOS", "Clawtrate"))) {
  throw new Error("The packaged Clawtrate executable is missing.");
}

if (existsSync(helper)) {
  console.log("bundled");
} else {
  mkdirSync(helpers, { recursive: true });
  // Keep stdout for the provenance value the workflow passes to the check.
  const options: ExecFileSyncOptions = { stdio: ["ignore", 2, 2] };
  execFileSync("/usr/bin/xcrun", localGatewayBuild(helper), options);
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app], options);
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], options);
  console.log("added-by-check");
}
