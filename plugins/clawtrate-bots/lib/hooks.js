// before_tool_call for every bot the plugin serves: it records the call's run
// and marks the run read from outside (lib/runs.js). It decides no call yet,
// and never throws: on both OpenClaw versions a before_tool_call handler that
// throws or takes 15 seconds blocks the call (their global hook runner runs it
// fail-closed), and recording must never stop a bot's tools.

import { createRuns } from "./runs.js";

export function createHooks(api, options = {}) {
  const runs = createRuns(api, options);
  api.on("before_tool_call", (event, ctx) => {
    try {
      const { run } = runs.sawCall(event, ctx);
      runs.afterDecision(run, event, true);
    } catch (error) {
      api.logger?.warn?.(
        `clawtrate-bots: couldn't record a ${event?.toolName} call: ${error?.message}`,
      );
    }
    return undefined;
  });
  return runs;
}
