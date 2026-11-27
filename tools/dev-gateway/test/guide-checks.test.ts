// The guide checks' cleanup after turning the switch off (guide-checks.ts): which bots' files it
// snapshots and puts back.
import { describe, expect, it } from "vitest";
import { otherFolders } from "../src/guide-checks.ts";

describe("the switch-off check's cleanup", () => {
  it("snapshots one bot per other workspace, and none that shares Pip's", () => {
    const agents = {
      agents: [
        { id: "pip", workspace: "/w/pip" },
        { id: "shared", workspace: "/w/pip" },
        { id: "otto", workspace: "/w/otto" },
        { id: "otto-twin", workspace: "/w/otto" },
        { id: "marlow" },
      ],
    };
    // Pip's own folder is put back from Pip's original, never from a later snapshot.
    expect(otherFolders(agents, "pip")).toEqual(["otto", "marlow"]);
    expect(otherFolders({}, "pip")).toEqual([]);
  });
});
