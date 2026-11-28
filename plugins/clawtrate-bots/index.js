// clawtrate-bots: Clawtrate's plugin for bots. So far:
//   - the records (proposals, agent grants, admission, decline, revocation,
//     cleanup) and the journal, crash settling and Undo that Apply needs
//     (docs/design/main-bot-onboarding.md, sections 5 to 10). It writes
//     nothing to any bot: on OpenClaw 2026.10.6 no stored request can be
//     applied, so accept and Undo refuse, and this entry gives it no Apply;
//   - where each run came from and whether it has read anything from outside,
//     and the three read tools (docs/design/bots-in-clawtrate.md, sections 2 A,
//     4 and 7). Its before_tool_call records each call and decides none yet.
//
//   gateway methods   clawtrate-bots.status, .proposals.list, .proposals.get,
//                     .changes.list, .relay.grants.get, .runs.get
//                     (operator.read); .proposals.decline (operator.write);
//                     .proposals.accept, .changes.undo, .managers.set,
//                     .relay.grants.set, .relay.propose (operator.admin)
//   event             plugin.clawtrate-bots.changed, empty (operator.read)
//   tools             clawtrate_here, clawtrate_tasks, clawtrate_bots
//   hooks             before_tool_call; before_model_resolve,
//                     before_prompt_build and agent_end (which need
//                     hooks.allowConversationAccess), before_message_write,
//                     after_tool_call
//   records           lib/records.js, in the gateway's database; the run
//                     origins in memory (lib/origins.js)

import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { PLUGIN_ID, createBots } from "./lib/bots.js";
import { createHooks } from "./lib/hooks.js";

export default {
  id: PLUGIN_ID,
  name: "Clawtrate bots",
  description:
    "Clawtrate's tools for bots: where a run came from and what a bot can do in Clawtrate. Not made by or affiliated with OpenClaw.",
  register(api) {
    createBots(api, { sdk: { dispatchGatewayMethod } });
    createHooks(api);
  },
};
