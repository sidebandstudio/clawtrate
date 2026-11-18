import type { Bot, Task } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { waitingWords } from "../src/Rail.tsx";
import { isActive, neighbour } from "../src/RailActions.tsx";
import { arrange, toSidebar, type RosterPrefs } from "../src/roster.ts";
import { summarize, taskState } from "../src/selection.ts";

const bot = (id: string, name: string): Bot => ({
  id,
  name,
  emoji: null,
  avatarUrl: null,
  theme: null,
  model: null,
  isDefault: false,
});
const task = (key: string, change: Partial<Task> = {}): Task => ({
  key,
  botId: key.split(":")[1]!,
  sessionId: key,
  title: key,
  preview: null,
  updatedAt: 1,
  status: "done",
  unread: false,
  ...change,
});
const prefs = (change: Partial<RosterPrefs>): RosterPrefs => ({
  pinned: [],
  hidden: [],
  sort: "name",
  manual: [],
  sections: [],
  ...change,
});

describe("the rail's sections and task states", () => {
  it("F-016: sections follow the list, each in the chosen order, a pinned or hidden bot in neither", () => {
    const bots = [
      bot("a", "Atlas"),
      bot("b", "Bree"),
      bot("c", "Cato"),
      bot("d", "Dax"),
      bot("e", "Eve"),
    ];
    const arranged = arrange(
      bots,
      {},
      prefs({
        pinned: ["e"],
        hidden: ["d"],
        sections: [
          { name: "Work", bots: ["c", "b", "e"] },
          { name: "Gone", bots: ["d"] },
        ],
      }),
    );
    expect(arranged.pinned.map((each) => each.id)).toEqual(["e"]);
    expect(arranged.list.map((each) => each.id)).toEqual(["a"]);
    expect(arranged.sections).toEqual([{ name: "Work", bots: [bots[1], bots[2]] }]);
    expect(arranged.hidden.map((each) => each.id)).toEqual(["d"]);
  });

  it("F-014 F-016: this device's arrangement is the base of the gateway's first one", () => {
    expect(
      toSidebar(
        prefs({
          pinned: ["a"],
          hidden: ["b"],
          manual: ["c"],
          sections: [{ name: "W", bots: ["d"] }],
        }),
      ),
    ).toEqual({ pins: ["a"], hidden: ["b"], order: ["c"], sections: [{ name: "W", bots: ["d"] }] });
  });

  it("F-021: line two says what the earliest waiting task waits on, and nothing waits when none does", () => {
    expect(waitingWords([task("agent:o:a")])).toBeNull();
    expect(
      waitingWords([
        task("agent:o:a", { status: "waiting", waitingFor: "approval", waitingSince: 20 }),
        task("agent:o:b", { status: "waiting", waitingFor: "question", waitingSince: 10 }),
      ]),
    ).toBe("Waiting for you: a question");
    expect(waitingWords([task("agent:o:a", { status: "waiting", waitingFor: "approval" })])).toBe(
      "Waiting for you: approve a command",
    );
  });

  it("F-057: a stopped task shows its mark until it is opened; a queued one shows its own; the avatar takes stopped, not queued", () => {
    const stopped = task("agent:o:s", { status: "stopped", updatedAt: 5 });
    const queued = task("agent:o:q", { status: "queued" });
    expect(taskState(stopped, {}, null)).toBe("stopped");
    expect(taskState(stopped, { [stopped.key]: 5 }, null)).toBeNull();
    expect(taskState(stopped, {}, stopped.key)).toBeNull();
    expect(taskState(queued, {}, null)).toBe("queued");
    expect(summarize([queued], {}, null).state).toBeNull();
    expect(summarize([queued, stopped], {}, null).state).toBe("stopped");
    expect(summarize([stopped, task("agent:o:w", { status: "waiting" })], {}, null).state).toBe(
      "waiting",
    );
  });

  it("F-277 F-278: archiving or deleting an active task stops it first; focus goes to the next row, else the previous", () => {
    expect(isActive({ status: "running" })).toBe(true);
    expect(isActive({ status: "waiting" })).toBe(true);
    expect(isActive({ status: "queued" })).toBe(true);
    expect(isActive({ status: "done" })).toBe(false);
    const list = [task("agent:o:1"), task("agent:o:2"), task("agent:o:3")];
    expect(neighbour(list, "agent:o:2")).toBe("agent:o:3");
    expect(neighbour(list, "agent:o:3")).toBe("agent:o:2");
    expect(neighbour([list[0]!], "agent:o:1")).toBeNull();
  });
});
