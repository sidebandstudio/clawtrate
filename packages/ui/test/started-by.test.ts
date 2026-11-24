// A task a bot started (F-565): the line under its name and the bot's brief, in each state.

import type { Bot, ClawtrateBridge, Task } from "@clawtrate/core";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BridgeProvider } from "../src/bridge.tsx";
import { BriefTurn, StartedLine, starterOf } from "../src/StartedBy.tsx";

const pip: Bot = {
  id: "pip",
  name: "Pip",
  emoji: null,
  avatarUrl: null,
  theme: null,
  model: null,
  isDefault: false,
};
const task = (key: string, botId: string, title: string, extra: Partial<Task> = {}): Task => ({
  key,
  botId,
  sessionId: null,
  title,
  preview: null,
  updatedAt: null,
  status: "done",
  unread: false,
  ...extra,
});
const main = task("agent:pip:main", "pip", "Main", { isMain: true });
const started = task("agent:pip:dashboard:1", "pip", "Compare trail maps", {
  startedBy: { botId: "pip", fromKey: "agent:pip:main" },
});
const forMarlow = task("agent:marlow:dashboard:2", "marlow", "Review the route", {
  startedBy: { botId: "pip", fromKey: "agent:pip:main" },
});

const html = (element: ReactElement) =>
  renderToStaticMarkup(
    createElement(BridgeProvider, { bridge: {} as ClawtrateBridge, children: element }),
  );
const text = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");

describe("F-565: the line a task a bot started shows", () => {
  it("F-565: names the bot and the task it came from, with a button that opens it", () => {
    const starter = starterOf(started, [pip], { pip: [main, started] })!;
    const opened: [string, string][] = [];
    const line = StartedLine({ starter, onOpen: (bot, key) => opened.push([bot, key]) });
    const markup = html(line);
    expect(text(markup)).toBe("Pip started this task from Main · Open Main");
    expect(markup).toContain('<button type="button" class="link-button"');
    expect(markup).toContain('<span aria-hidden="true"> · </span>');
    // The button opens the task it came from, under that task's bot.
    const button = findButton(line);
    button.props.onClick();
    expect(opened).toEqual([["pip", "agent:pip:main"]]);
  });

  it("F-565: a task started under another bot names the bot that started it", () => {
    const starter = starterOf(forMarlow, [pip], { pip: [main], marlow: [forMarlow] })!;
    expect(text(html(StartedLine({ starter, onOpen: () => {} })))).toBe(
      "Pip started this task from Main · Open Main",
    );
  });

  it("F-565: when the task it came from is not listed, the line says only who started it", () => {
    const starter = starterOf(started, [pip], { pip: [started] })!;
    const markup = html(StartedLine({ starter, onOpen: () => {} }));
    expect(text(markup)).toBe("Pip started this task.");
    expect(markup).not.toContain("<button");
    const unnamed = starterOf({ ...started, startedBy: { botId: "pip", fromKey: null } }, [pip], {
      pip: [main],
    })!;
    expect(text(html(StartedLine({ starter: unnamed, onOpen: () => {} })))).toBe(
      "Pip started this task.",
    );
  });

  it("F-565: when it cannot be opened from here, the line offers nothing", () => {
    const starter = starterOf(started, [pip], { pip: [main, started] })!;
    const markup = html(StartedLine({ starter, onOpen: null }));
    expect(text(markup)).toBe("Pip started this task from Main.");
    expect(markup).not.toContain("<button");
  });

  it("F-565: a bot this client does not list is named by its id; a task no bot started has no line", () => {
    const starter = starterOf(started, [], { pip: [main] })!;
    expect(text(html(StartedLine({ starter, onOpen: null })))).toBe(
      "pip started this task from Main.",
    );
    expect(starterOf(main, [pip], { pip: [main] })).toBeNull();
  });

  it("F-565: the label the bot gave its task is text, never markup", () => {
    const from = task("agent:pip:dashboard:3", "pip", "<b>Trip</b> & co");
    const child = { ...started, startedBy: { botId: "pip", fromKey: from.key } };
    const markup = html(
      StartedLine({ starter: starterOf(child, [pip], { pip: [from] })!, onOpen: () => {} }),
    );
    expect(markup).toContain("&lt;b&gt;Trip&lt;/b&gt; &amp; co");
    expect(markup).not.toContain("<b>");
  });
});

describe("F-565: the brief a task a bot started begins with", () => {
  it("F-565: is drawn as the bot's brief, named for it, not as the person's message", () => {
    const starter = starterOf(started, [pip], { pip: [main] })!;
    const markup = html(createElement(BriefTurn, { text: "Compare the two routes.", starter }));
    expect(markup).toContain('data-role="brief"');
    expect(markup).toContain('<figcaption class="brief-head">');
    expect(text(markup)).toBe("Pip's briefCompare the two routes.");
    expect(markup).not.toContain('data-role="user"');
    expect(markup).toContain('class="avatar"');
  });

  it("F-565: without a listed bot it is still the bot's brief, by its id, without an avatar", () => {
    const starter = starterOf(started, [], {})!;
    const markup = html(createElement(BriefTurn, { text: "Go.", starter }));
    expect(text(markup)).toBe("pip's briefGo.");
    expect(markup).not.toContain('class="avatar"');
  });
});

/** The button in a rendered element tree. */
function findButton(node: unknown): { props: { onClick: () => void } } {
  const element = node as { type?: unknown; props?: { children?: unknown } } | null;
  if (!element || typeof element !== "object") throw new Error("no button");
  if (element.type === "button") return element as { props: { onClick: () => void } };
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    try {
      return findButton(child);
    } catch {
      // keep looking
    }
  }
  throw new Error("no button");
}
