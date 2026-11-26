// The PR AI disclosure check's decision (.github/scripts/pr-ai-disclosure.mjs). The workflow
// renders the body with GitHub's Markdown API; these tests stand in its HTML.

import { describe, expect, it, vi } from "vitest";
import { checkDisclosure, failure } from "../.github/scripts/pr-ai-disclosure.mjs";

const person = { login: "someone", type: "User" };
const dependabot = { login: "dependabot[bot]", type: "Bot" };
const noFooter = "<p>Closes #1</p>\n<p>Bumps a dependency.</p>\n";

function rendered(html: string) {
  return vi.fn(async (_text: string) => html);
}

describe("Dependabot", () => {
  it("passes without a footer and without rendering the body", async () => {
    const render = rendered(noFooter);
    expect(await checkDisclosure({ author: dependabot, body: "Bumps a dependency.", render })).toBe(
      undefined,
    );
    expect(render).not.toHaveBeenCalled();
  });

  it("passes with an empty body", async () => {
    const render = rendered("");
    expect(await checkDisclosure({ author: dependabot, body: null, render })).toBe(undefined);
  });

  it.each([
    ["a person whose login is Dependabot's", { login: "dependabot[bot]", type: "User" }],
    ["another bot", { login: "renovate[bot]", type: "Bot" }],
    ["a person named after Dependabot", { login: "dependabot", type: "User" }],
    ["no author", undefined],
  ])("does not exempt %s", async (_name, author) => {
    expect(await checkDisclosure({ author, body: "Bumps.", render: rendered(noFooter) })).toBe(
      failure,
    );
  });
});

describe("everyone else", () => {
  it.each([
    ["No AI used.", "<p>Closes #1</p>\n<p>No AI used.</p>\n"],
    ["one AI line", "<p>Closes #1</p>\n<p>AI: Claude Opus 5.5 via Claude Code (T3 Code)</p>\n"],
    [
      "two AI lines",
      "<p>Closes #1</p>\n<p>AI: <code>gpt-6.2-astra</code> via Codex<br>\nAI: Claude Opus 5.5 via Claude Code</p>\n",
    ],
  ])("passes with %s", async (_name, html) => {
    expect(await checkDisclosure({ author: person, body: "x", render: rendered(html) })).toBe(
      undefined,
    );
  });

  it.each([
    ["no footer", noFooter],
    ["an empty body", "\n"],
    ["the template's placeholder", "<p>AI: MODEL via HARNESS</p>\n"],
    ["a bracketed placeholder", "<p>AI: [model] via [harness]</p>\n"],
    ["a footer that is not last", "<p>No AI used.</p>\n<p>Closes #1</p>\n"],
    ["one incomplete line of two", "<p>AI: Claude via Claude Code<br>\nAI: none via Codex</p>\n"],
  ])("fails with %s", async (_name, html) => {
    expect(await checkDisclosure({ author: person, body: "x", render: rendered(html) })).toBe(
      failure,
    );
  });

  it("ignores CodeSmith's footer and renders a blank body as a space", async () => {
    const render = rendered("<p>No AI used.</p>\n");
    await checkDisclosure({
      author: person,
      body: "No AI used.\n\n<!-- codesmith:footer -->\nReviewed.\n<!-- /codesmith:footer -->",
      render,
    });
    expect(render).toHaveBeenCalledWith("No AI used.\n\n");
    await checkDisclosure({ author: person, body: null, render });
    expect(render).toHaveBeenLastCalledWith(" ");
  });
});
