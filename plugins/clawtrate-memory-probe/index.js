import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const workspaceFor = (api, agentId) =>
  api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId);

export function notePath(workspace, path) {
  const target = resolve(workspace, String(path));
  const rel = relative(workspace, target).split(sep).join("/");
  if (rel !== path || !rel.startsWith("memory/") || !rel.endsWith(".md") || isAbsolute(rel)) {
    throw new Error("path must be a Markdown note under memory/");
  }
  return target;
}

export default {
  id: "clawtrate-memory-probe",
  name: "Clawtrate memory probe",
  description: "Proves workspace resolution and a note write from a user plugin.",
  register(api) {
    api.registerGatewayMethod(
      "clawtrate-memory-probe.workspace",
      ({ params, respond }) => {
        const workspace = workspaceFor(api, params.agentId);
        respond(true, { agentId: params.agentId, workspace });
      },
      { scope: "operator.admin" },
    );
    api.registerGatewayMethod(
      "clawtrate-memory-probe.write",
      ({ params, respond }) => {
        const workspace = workspaceFor(api, params.agentId);
        const target = notePath(workspace, params.path);
        mkdirSync(resolve(target, ".."), { recursive: true });
        writeFileSync(target, params.content, "utf8");
        respond(true, { agentId: params.agentId, path: params.path, workspace });
      },
      { scope: "operator.admin" },
    );
  },
};
