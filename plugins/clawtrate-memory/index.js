import { listAgentIds, resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import { getAgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import { canonicalPathFromExistingAncestor, root } from "openclaw/plugin-sdk/file-access-runtime";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { registerMemory } from "./lib/memory.js";

export default {
  id: "clawtrate-memory",
  name: "Clawtrate memory",
  description: "List, read and safely change memory notes and shared memory.",
  register(api) {
    registerMemory(api, {
      listAgentIds,
      resolveAgentConfig,
      getAgentWorkspaceAccess,
      root,
      dispatchGatewayMethod,
      canonicalPathFromExistingAncestor,
    });
  },
};
