// Parameters read as OpenClaw's tools read them (lib/params.js).

import { describe, expect, it } from "vitest";
import { Ambiguous, botOfKey, readFirst, readParam, snakeKey } from "../lib/params.js";

describe("parameters as the tools read them", () => {
  it("the camelCase key, else its snake_case twin, trimmed", () => {
    expect(snakeKey("agentId")).toBe("agent_id");
    expect(snakeKey("sessionKey")).toBe("session_key");
    expect(readParam({ agentId: " marlow " }, "agentId")).toBe("marlow");
    expect(readParam({ agent_id: "marlow" }, "agentId")).toBe("marlow");
    expect(readParam({ agent_id: "" }, "agentId")).toBeUndefined();
    expect(readParam({ agentId: 5 }, "agentId")).toBeUndefined();
    expect(readParam(null, "agentId")).toBeUndefined();
  });

  it("two spellings that differ are refused; the same value twice is fine", () => {
    expect(() => readParam({ agentId: "pip", agent_id: "marlow" }, "agentId")).toThrow(Ambiguous);
    expect(() => readParam({ agentId: 5, agent_id: "marlow" }, "agentId")).toThrow(Ambiguous);
    expect(readParam({ agentId: "pip", agent_id: " pip" }, "agentId")).toBe("pip");
  });

  it("keys read in turn, as the scheduler reads jobId then id", () => {
    expect(readFirst({ job_id: "j1" }, ["jobId", "id"])).toBe("j1");
    expect(readFirst({ id: "j1" }, ["jobId", "id"])).toBe("j1");
    expect(() => readFirst({ job_id: "j2", id: "j1" }, ["jobId", "id"])).toThrow(Ambiguous);
  });

  it("the bot a session key names", () => {
    expect(botOfKey("agent:Marlow:main")).toBe("marlow");
    expect(botOfKey("main")).toBeNull();
  });
});
