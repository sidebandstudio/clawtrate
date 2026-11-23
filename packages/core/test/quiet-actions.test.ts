// The conversation with "Show commands" off (docs/design/conversation.md, 7.11):
// plain words for every action, a status phrase for each kind, and a message
// that repeats a reply leaves its text out. Every name and text is invented.

import { describe, expect, it } from "vitest";
import {
  actionWords,
  foldLineOf,
  kindPhrase,
  lineOf,
  mergeThoughts,
  readableOf,
  type ActionCall,
} from "../src/index.ts";

let n = 0;
function call(
  name: string,
  args: Record<string, unknown>,
  more: Partial<ActionCall> = {},
): ActionCall {
  n += 1;
  return {
    id: `call_${n}`,
    name,
    args,
    status: "returned",
    isError: false,
    text: "ok",
    details: null,
    commandBearing: false,
    startedAt: 1_000,
    endedAt: 1_600,
    fromHistory: false,
    ...more,
  };
}

const QUIET = { quiet: true };
const COMMAND = "/bin/zsh -lc 'cat /var/log/backup/backup-2026-11-15.log | tail -n 40'";

describe("F-530: without commands shown, an action reads in plain words", () => {
  it("a command is 'a command': no program, no command line, no exit code", () => {
    const ran = call("exec", { command: COMMAND }, { details: { exitCode: 1 } });
    const shown = lineOf(ran);
    expect(shown.object).toBe("zsh");
    expect(shown.detail).toBe(COMMAND);
    expect(shown.exit).toBe("exit 1");
    const quiet = lineOf(ran, QUIET);
    expect([quiet.verb, quiet.object]).toEqual(["Ran", "a command"]);
    expect(quiet.detail).toBe("");
    expect(quiet.mono).toBe(false);
    expect(quiet.exit).toBe("");
    expect(quiet.spoken).not.toContain("zsh");
    expect(quiet.title).toBe("Ran a command");
  });

  it("in every state: running, waiting, blocked and failed say 'a command' too", () => {
    const running = lineOf(call("exec", { command: COMMAND }, { status: "running" }), QUIET);
    expect(running.running).toBe("Running a command");
    expect(`${running.verb} ${running.object}`).toBe("Running a command");
    const blocked = lineOf(
      call("exec", { command: COMMAND }, { details: { status: "blocked" }, isError: true }),
      QUIET,
    );
    expect(blocked.detail).toBe("");
    expect(blocked.title).not.toContain("cat");
    const failed = lineOf(
      call("exec", { command: COMMAND }, { isError: true, text: "", details: null }),
      QUIET,
    );
    expect(failed.object).toBe("a command");
    expect(failed.title).not.toContain("/bin/zsh");
  });

  it("other kinds keep their plain words", () => {
    const read = lineOf(call("read", { path: "/var/log/backup/notes.md" }), QUIET);
    expect(`${read.verb} ${read.object}`).toBe("Read notes.md");
    const web = lineOf(call("web_search", { query: "heat pump" }), QUIET);
    expect(`${web.verb} ${web.object}`).toBe('Searched the web for "heat pump"');
  });

  it("a fold of commands names none of them", () => {
    const calls = [
      call("exec", { command: "du -sh /srv/media/*" }, { details: { exitCode: 0 } }),
      call("exec", { command: "mv /srv/a /srv/b" }, { details: { exitCode: 0 } }),
    ];
    expect(foldLineOf(calls).detail).toBe("du, mv");
    const quiet = foldLineOf(calls, QUIET);
    expect(`${quiet.verb} ${quiet.object}`).toBe("Ran 2 commands");
    expect(quiet.detail).toBe("");
  });

  it("the readable view says where a command ran and what came back, not the command", () => {
    const ran = call(
      "exec",
      { command: COMMAND, workdir: "/srv/media" },
      { details: { exitCode: 0 }, text: "all clear" },
    );
    const labels = (quiet: boolean) =>
      readableOf(ran, quiet ? QUIET : {}).rows.map((row) => row.label);
    expect(labels(false)).toEqual(expect.arrayContaining(["Command", "Folder"]));
    expect(labels(true)).not.toContain("Command");
    expect(labels(true)).not.toContain("Folder");
    expect(readableOf(ran, QUIET).block?.text).toContain("all clear");
  });

  it("opened, a command's output and error name neither its exit code nor, when denied, the command", () => {
    const exited = call(
      "exec",
      { command: COMMAND },
      { details: { exitCode: 1 }, text: "no such file\n\n(Command exited with code 1)" },
    );
    expect(readableOf(exited).block?.text).toContain("(Command exited with code 1)");
    expect(readableOf(exited, QUIET).block?.text).toBe("no such file");
    const denied = call(
      "exec",
      { command: "rm -rf /srv/cache" },
      { isError: true, text: "Exec denied (gateway id=a, user-denied): rm -rf /srv/cache" },
    );
    expect(readableOf(denied).block?.text).toContain("rm -rf /srv/cache");
    expect(readableOf(denied, QUIET).block?.text).toBe("Exec denied (gateway id=a, user-denied)");
    expect(lineOf(denied, QUIET).title).not.toContain("rm -rf");
  });

  it("a blocked command reads 'Blocked by policy', with no object added", () => {
    const blocked = call(
      "exec",
      { command: COMMAND },
      { details: { status: "blocked" }, isError: true },
    );
    expect(lineOf(blocked, QUIET).title).toBe("Blocked by policy");
  });

  it("the readable view has no exit code without commands shown", () => {
    const ran = call("exec", { command: COMMAND }, { details: { exitCode: 3 }, text: "out" });
    expect(readableOf(ran).exitCode).toBe(3);
    expect(readableOf(ran, QUIET).exitCode).toBeNull();
  });
});

describe("F-529: the status line names the kind of work, not the call", () => {
  it("each kind has its phrase; a message to a bot keeps its card's words", () => {
    const cases: Array<[ActionCall, string]> = [
      [call("exec", { command: COMMAND }, { status: "running" }), "Using the computer"],
      [call("read", { path: "a.log" }, { status: "running" }), "Reading files"],
      [call("web_search", { query: "x" }, { status: "running" }), "Searching the web"],
      [call("browser", { action: "open" }, { status: "running" }), "Using the browser"],
      [call("memory_search", { query: "x" }, { status: "running" }), "Searching memory"],
      [
        call(
          "sessions_send",
          { sessionKey: "agent:juniper:main", message: "Hi" },
          { status: "running" },
        ),
        "Messaging Juniper",
      ],
    ];
    const ctx = { botName: (id: string) => (id === "juniper" ? "Juniper" : null) };
    for (const [each, phrase] of cases) expect(kindPhrase(each, ctx)).toBe(phrase);
  });

  it("every kind has a phrase in plain words", () => {
    for (const phrase of Object.values(actionWords.KIND_PHRASES)) {
      expect(phrase).toMatch(/^[A-Z][a-z]+( [a-zA-Z]+)*$/);
      expect(phrase).not.toMatch(/zsh|exec|bash/);
    }
  });
});

describe("F-532: a message that repeats a reply beside it leaves its text out", () => {
  it("the line keeps what it did and its state, without the text", () => {
    const sent = call(
      "conversations_send",
      { message: "Survey booked for Dec 2." },
      { details: { status: "sent" } },
    );
    expect(lineOf(sent).detail).toContain("Survey booked");
    const once = lineOf({ ...sent, repeatsReply: true });
    expect(once.detail).toBe("");
    expect(`${once.verb} ${once.object}`).toBe("Message on a conversation");
    expect(once.state).toMatchObject({ word: "Sent" });
  });

  it("keeps the recipient, and a failed send keeps its reason", () => {
    const to = call(
      "message",
      { to: "the survey office", message: "Booked." },
      { details: { status: "sent" } },
    );
    expect(lineOf({ ...to, repeatsReply: true }).detail).toBe("to the survey office");
    const failed = call(
      "conversations_send",
      { message: "Booked." },
      { isError: true, text: "The destination is unavailable.", details: null },
    );
    expect(lineOf(failed).detail).toContain("The destination is unavailable");
    expect(lineOf({ ...failed, repeatsReply: true }).detail).toContain(
      "The destination is unavailable",
    );
  });

  it("only a message on a channel: another kind's detail is kept", () => {
    const read = call("read", { path: "notes.md" }, { text: "one\ntwo" });
    expect(lineOf({ ...read, repeatsReply: true }).detail).toBe(lineOf(read).detail);
  });
});

describe("F-528: reasoning that led to actions is one Thought line", () => {
  it("merges the segments in order, with their durations added", () => {
    const merged = mergeThoughts([
      {
        id: "r1",
        segments: [{ id: "r1", text: "first", startedAt: 0, endedAt: 2000 }],
        ms: 2000,
      },
      {
        id: "r2",
        segments: [{ id: "r2", text: "then", startedAt: 3000, endedAt: 6000 }],
        ms: 3000,
      },
    ]);
    expect(merged.id).toBe("r1");
    expect(merged.segments.map((s) => s.text)).toEqual(["first", "then"]);
    expect(merged.ms).toBe(5000);
  });
});
