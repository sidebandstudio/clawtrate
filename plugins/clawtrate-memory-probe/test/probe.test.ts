import { describe, expect, it } from "vitest";
import probe from "../index.js";

type Method = (options: {
  params: Record<string, string>;
  respond: (ok: boolean, payload?: unknown) => void;
}) => void;

describe("the memory probe", () => {
  it("resolves a bot's workspace with the public resolver, admin only, and writes nothing", () => {
    const methods = new Map<string, { handler: Method; scope?: string }>();
    const api = {
      config: { marker: "live-config" },
      runtime: {
        agent: {
          resolveAgentWorkspaceDir(config: unknown, agentId: string) {
            expect(config).toBe(api.config);
            return `/workspaces/${agentId}`;
          },
        },
      },
      registerGatewayMethod(name: string, handler: Method, options: { scope?: string }) {
        methods.set(name, { handler, ...options });
      },
    };
    probe.register(api);
    expect([...methods.keys()]).toEqual(["clawtrate-memory-probe.workspace"]);
    const method = methods.get("clawtrate-memory-probe.workspace")!;
    expect(method.scope).toBe("operator.admin");

    let answer: unknown;
    method.handler({
      params: { agentId: "second" },
      respond: (_ok, payload) => (answer = payload),
    });
    expect(answer).toEqual({ agentId: "second", workspace: "/workspaces/second" });
  });
});
