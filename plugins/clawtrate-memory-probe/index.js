export default {
  id: "clawtrate-memory-probe",
  name: "Clawtrate memory probe",
  description: "Proves workspace resolution from a user plugin.",
  register(api) {
    api.registerGatewayMethod(
      "clawtrate-memory-probe.workspace",
      ({ params, respond }) => {
        const workspace = api.runtime.agent.resolveAgentWorkspaceDir(api.config, params.agentId);
        respond(true, { agentId: params.agentId, workspace });
      },
      { scope: "operator.admin" },
    );
  },
};
