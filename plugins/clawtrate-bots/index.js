// clawtrate-bots: bots and external agents propose changes to bots; a person
// decides (docs/design/main-bot-onboarding.md, sections 5 to 10). So far: the
// records (proposals, agent grants, admission, decline, revocation, cleanup),
// and the journal, crash settling and Undo that Apply needs. It writes nothing
// to any bot: on OpenClaw 2026.10.6 no stored request can be applied (section
// 17), so accept and Undo refuse, and this entry gives the plugin no way to
// apply.
//
//   gateway methods   clawtrate-bots.status, .proposals.list, .proposals.get,
//                     .changes.list, .relay.grants.get (operator.read);
//                     .proposals.decline (operator.write); .proposals.accept,
//                     .changes.undo, .managers.set, .relay.grants.set,
//                     .relay.propose (operator.admin)
//   event             plugin.clawtrate-bots.changed, empty (operator.read)
//   records           lib/records.js, in the gateway's database

import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { PLUGIN_ID, createBots } from "./lib/bots.js";

export default {
  id: PLUGIN_ID,
  name: "Clawtrate bots",
  description:
    "Keeps bots' and agents' proposed changes to bots for a person to decide. Not made by or affiliated with OpenClaw.",
  register(api) {
    createBots(api, { sdk: { dispatchGatewayMethod } });
  },
};
