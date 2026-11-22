// clawtrate-bots: bots and external agents propose changes to bots; a person
// decides (docs/design/main-bot-onboarding.md, sections 5 to 10). This is its
// first part: the records. It keeps proposals and agent grants and decides
// admission, decline and revocation. It writes nothing to any bot: on OpenClaw
// 2026.10.6 no stored request can be applied (section 17), so accept refuses.
//
//   gateway methods   clawtrate-bots.status, .proposals.list, .proposals.get,
//                     .relay.grants.get (operator.read); .proposals.decline
//                     (operator.write); .proposals.accept, .relay.grants.set,
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
