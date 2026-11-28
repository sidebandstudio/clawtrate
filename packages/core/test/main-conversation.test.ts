import { describe, expect, it } from "vitest";
import {
  botMainConversation,
  botMainConversationKey,
  mapSessionRow,
  tasksUnderBot,
  type Task,
} from "../src/index.ts";

function task(key: string, extra: Record<string, unknown> = {}): Task {
  return mapSessionRow({ key, updatedAt: 1, ...extra })!;
}

describe("a bot's main conversation (docs/design/bot-opens-main.md)", () => {
  it("is the row the gateway marks main", () => {
    const main = task("agent:marlow:main");
    const tasks = [task("agent:marlow:dashboard:0001"), main];
    expect(botMainConversationKey("marlow", tasks)).toBe("agent:marlow:main");
    expect(botMainConversation("marlow", tasks)).toBe(main);
  });

  it("is the row marked main even when its key is another", () => {
    // `session.scope: "global"` files it under `global` for the bot; a row that says so is it.
    const marked = task("global", { agentId: "marlow", isMain: true });
    expect(botMainConversationKey("marlow", [marked])).toBe("global");
  });

  it("is the row the gateway classifies as main, whatever its key, and is not one of its tasks", () => {
    const classified = task("agent:marlow:home", { agentId: "marlow", classification: "main" });
    expect(classified.isMain).toBe(true);
    expect(botMainConversationKey("marlow", [classified])).toBe("agent:marlow:home");
    expect(tasksUnderBot([classified])).toEqual([]);
  });

  it("is never another bot's main row", () => {
    expect(botMainConversationKey("pip", [task("agent:marlow:main")])).toBe("agent:pip:main");
  });

  it("is a stand-in at the bot's own key when the gateway lists none, with nothing made", () => {
    const tasks = [task("agent:pip:dashboard:0001")];
    expect(botMainConversationKey("pip", tasks)).toBe("agent:pip:main");
    expect(botMainConversationKey("pip", undefined)).toBe("agent:pip:main");
    const standIn = botMainConversation("pip", tasks);
    expect(standIn).toMatchObject({ key: "agent:pip:main", botId: "pip", isMain: true });
    expect(tasks).toHaveLength(1);
  });

  it("is left out of the tasks listed under the bot, which keep their order", () => {
    const tasks = [
      task("agent:marlow:dashboard:0002"),
      task("agent:marlow:main"),
      task("agent:marlow:dashboard:0001"),
    ];
    expect(tasksUnderBot(tasks).map((each) => each.key)).toEqual([
      "agent:marlow:dashboard:0002",
      "agent:marlow:dashboard:0001",
    ]);
    expect(tasksUnderBot([task("agent:marlow:main")])).toEqual([]);
  });
});
