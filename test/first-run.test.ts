import { describe, expect, it } from "vitest";
import { forbiddenScreen, STEPS, verdict } from "../e2e-packaged/first-run/verdict.ts";

const passed = () =>
  STEPS.map((step) => ({
    step,
    status: "passed" as const,
    seconds: 1,
    text: "Visible text",
    screenshot: "step.png",
  }));

describe("Packaged first run verdict", () => {
  it("passes after all six steps pass in order", () => expect(verdict(passed())).toBe("passed"));

  it("fails when a step fails or is not reached", () => {
    for (const status of ["failed", "not-reached"] as const) {
      const results = passed();
      expect(verdict(results.map((step, i) => (i === 2 ? { ...step, status } : step)))).toBe(
        "failed",
      );
    }
  });

  it("fails if a step is omitted, duplicated or out of order", () => {
    const results = passed();
    expect(verdict(results.slice(0, -1))).toBe("failed");
    expect(verdict([...results, results[0]!])).toBe("failed");
    expect(verdict([...results].reverse())).toBe("failed");
  });
});

describe("Packaged first run forbidden screens", () => {
  it.each([
    ["AXHeading", "Approve this device"],
    [
      "AXSystemDialog",
      "The git command requires the command line developer tools. Would you like to install the tools now?",
    ],
    ["AXSystemDialog", "Allow “node” to find devices on local networks?"],
    ["AXStaticText", "A pairing request is waiting for the gateway owner."],
    ["AXHeading", "Approval required"],
    ["AXButton", "Allow once"],
    ["AXButton", "Give this device full control"],
    ["AXTextField", "Gateway address"],
    ["AXSecureTextField", "Gateway token, for pairing"],
    ["AXStaticText", "Open a terminal and run the command."],
    ["AXStaticText", "Run this command in your terminal."],
  ])("stops on %s %s", (role, text) => {
    expect(forbiddenScreen([{ role, text }])).toBe(text);
  });

  it("allows the setup confirmation, a non-editable address, and a message composer", () => {
    expect(
      forbiddenScreen([
        { role: "AXStaticText", text: "Set up OpenClaw on this computer?" },
        { role: "AXButton", text: "Set up OpenClaw" },
        { role: "AXStaticText", text: "Gateway address" },
        { role: "AXTextArea", text: "Message your bot" },
      ]),
    ).toBeNull();
  });
});
