// The reading of an action (docs/design/conversation.md, sections 7 and 8).
// Envelopes are cut from the scenario check's records (docs/decisions.md,
// "What each kind of tool call looks like") and from the design's samples
// (docs/design/prototype/js/samples.js); every name and text is invented.

import { describe, expect, it } from "vitest";
import {
  callFromBlock,
  callFromStep,
  foldLineOf,
  groupFeed,
  kindOf,
  lineOf,
  outcomeOf,
  payloadOutcome,
  phraseCall,
  projectArgs,
  projectDetails,
  readableOf,
  runLineOf,
  scheduleWords,
  MAX_ACTION_FACTS_CHARS,
  type ActionCall,
  type FeedEntry,
} from "../src/index.ts";
import type { Run, Step } from "../src/runs.ts";

let n = 0;
/** A call that returned, unless `more` says otherwise. */
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

const line = (c: ActionCall) => lineOf(c);
const words = (c: ActionCall) => {
  const l = lineOf(c);
  return [l.verb, l.object].filter(Boolean).join(" ");
};
const state = (c: ActionCall) => {
  const s = lineOf(c).state;
  return s.type === "word" ? s.word : s.type;
};
const diff = (path: string, added: string[], removed: string[] = []) =>
  [
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,3 +1,6 @@",
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join("\n");

describe("F-488 every kind of 8.1 has its words, its kind and its outcome", () => {
  it("1 read: the file's name, the lines received, Done with its time", () => {
    const c = call(
      "read",
      { path: "logs/backup-2026-11-15.log" },
      { text: "one\ntwo\nthree", details: { kind: "file", content: "one" } },
    );
    expect(kindOf(c)).toMatchObject({ kind: "read", key: "read" });
    expect(words(c)).toBe("Read backup-2026-11-15.log");
    expect(line(c).detail).toBe("3 lines");
    expect(state(c)).toBe("time");
    expect(line(c).running).toBe("Reading backup-2026-11-15.log");
  });
  it("2 ls: looked in a folder, no count from its lines", () => {
    const c = call(
      "ls",
      { path: "logs/archive" },
      { text: "a.gz\nb.gz", details: { content: "a.gz" } },
    );
    expect(words(c)).toBe("Looked in archive");
    expect(line(c).detail).toBe("");
  });
  it("3 write, edit and apply_patch: edited, created, a patch's named files, the change", () => {
    const edit = call(
      "edit",
      { path: "notes/house-log.md", edits: [{ oldText: "a", newText: "b" }] },
      {
        details: {
          changed: true,
          diff: diff("notes/house-log.md", ["", "## Nov 16", "x", "y"]),
          firstChangedLine: 2,
          patch: "",
        },
      },
    );
    expect(words(edit)).toBe("Edited house-log.md");
    expect(line(edit).detail).toBe("+4 −0");
    const created = call(
      "write",
      { path: "notes/backup-exclude.md", content: "x\n" },
      { details: { changed: true, created: true, diff: diff("notes/backup-exclude.md", ["x"]) } },
    );
    expect(words(created)).toBe("Created backup-exclude.md");
    const patch = call("apply_patch", {
      input:
        "*** Begin Patch\n*** Update File: scripts/weekly.sh\n@@\n*** Add File: scripts/exclude.list\n+x\n*** Update File: test/exclude.bats\n*** End Patch",
    });
    expect(words(patch)).toBe("Edited 3 files");
    expect(kindOf(patch).key).toBe("files");
    const bare = call("apply_patch", { input: "garbled" });
    expect(words(bare)).toBe("Applied a patch");
  });
  it("4 a write whose path is memory saves to memory, by its path only", () => {
    const c = call(
      "write",
      { path: "memory/2026-11-17.md", content: "Dana wants the boiler serviced in October." },
      { details: { changed: true, created: true, diff: diff("memory/2026-11-17.md", ["x"]) } },
    );
    expect(kindOf(c)).toMatchObject({ kind: "memory", key: "memory" });
    expect(words(c)).toBe("Saved to memory");
    expect(line(c).detail).toBe('"Dana wants the boiler serviced in…"');
    expect(kindOf(call("write", { path: "./MEMORY.md", content: "x" })).kind).toBe("memory");
    // An absolute path is memory only inside the bot's workspace.
    expect(kindOf(call("write", { path: "/workspace/bot/memory/a.md" }), {}).kind).toBe("edit");
    expect(
      kindOf(call("write", { path: "/workspace/bot/memory/a.md" }), {
        workspaceRoot: "/workspace/bot",
      }).kind,
    ).toBe("memory");
    expect(kindOf(call("write", { path: "notes/memory/a.md" })).kind).toBe("edit");
  });
  it("5 memory_search and memory_get: matches, a note read, partial and unavailable", () => {
    const search = call(
      "memory_search",
      { query: "boiler service" },
      {
        details: {
          results: [
            { path: "memory/a.md", snippet: "x" },
            { path: "memory/b.md", snippet: "y" },
          ],
        },
      },
    );
    expect(words(search)).toBe('Searched memory for "boiler service"');
    expect(line(search).detail).toBe("2 matches");
    const get = call(
      "memory_get",
      { path: "memory/2026-11-12.md" },
      { details: { path: "memory/2026-11-12.md", status: "ok", text: "x" } },
    );
    expect(words(get)).toBe("Read from memory: 2026-11-12.md");
    expect(kindOf(search).key).not.toBe(kindOf(get).key);
  });
  it("6 exec: the program, the command line in mono, exit 1 is Done", () => {
    const c = call(
      "exec",
      { command: "du -sh /srv/media/*", workdir: "/srv/media" },
      {
        commandBearing: true,
        details: {
          status: "completed",
          exitCode: 0,
          exitSignal: null,
          exitReason: "exit",
          durationMs: 1200,
          aggregated: "",
          noOutputTimedOut: false,
          cwd: "/srv/media",
        },
      },
    );
    expect(words(c)).toBe("Ran du");
    expect(line(c)).toMatchObject({
      detail: "du -sh /srv/media/*",
      mono: true,
      exit: "",
      outcome: "done",
    });
    const exit1 = call(
      "exec",
      { command: "grep -c transcode /etc/backup/exclude" },
      {
        text: "0\n\n(Command exited with code 1)",
        details: { status: "completed", exitCode: 1, exitReason: "exit" },
      },
    );
    expect(line(exit1)).toMatchObject({ outcome: "done", exit: "exit 1", problem: null });
    expect(
      words(
        call("exec", { command: "FOO=1 sudo /usr/bin/rsync -a x y" }, { details: { exitCode: 0 } }),
      ),
    ).toBe("Ran rsync");
    expect(words(call("exec", { command: "$(make) && x" }, { details: { exitCode: 0 } }))).toBe(
      "Ran a command",
    );
    expect(words(call("code_execution", { task: "sum the column" }))).toBe("Ran code");
    // Any call the gateway marks as a command is one, whatever its name.
    expect(kindOf(call("shell_run", { command: "ls" }, { commandBearing: true })).kind).toBe(
      "command",
    );
  });
  it("7 terminal: by action, keyed by tool and action", () => {
    const list = call("terminal", { action: "list" }, { details: { sessions: [] } });
    const input = call("terminal", { action: "input", sessionId: "term-2" });
    expect(words(list)).toBe("Looked at shared terminals");
    expect(words(input)).toBe("Typed into a terminal");
    expect(line(input).detail).toBe("term-2");
    expect(kindOf(list).key).not.toBe(kindOf(input).key);
  });
  it("8 web_search: the query in quotes, its results counted", () => {
    const c = call(
      "web_search",
      { query: "cold climate heat pump performance", count: 3 },
      {
        details: {
          kind: "web_search_results",
          provider: "scripted",
          query: "q",
          count: 3,
          tookMs: 2100,
          results: [
            { title: "a", url: "https://a.example" },
            { title: "b", url: "https://b.example" },
            { title: "c", url: "https://c.example" },
          ],
        },
      },
    );
    expect(words(c)).toBe('Searched the web for "cold climate heat pump performance"');
    expect(line(c).detail).toBe("3 results");
    expect(readableOf(c).links.map((l) => l.host)).toEqual(["a.example", "b.example", "c.example"]);
  });
  it("9 x_search: sources from its citations", () => {
    const c = call(
      "x_search",
      { query: "heat pump rebate 2026 experiences" },
      {
        text: "Posts mention a wait.",
        details: { content: "x", citations: ["https://x.example/1", "https://x.example/2"] },
      },
    );
    expect(words(c)).toBe('Searched posts on X for "heat pump rebate 2026 experiences"');
    expect(line(c).detail).toBe("2 sources");
  });
  it("10 web_fetch: the host, the title without the gateway's markers, a status of 400 or more", () => {
    const c = call(
      "web_fetch",
      { url: "https://www.energy.example.org/cold" },
      {
        text: "Field data…",
        details: {
          title:
            '<<<EXTERNAL_UNTRUSTED_CONTENT source="web_fetch">>>\nHeat pumps below freezing\n<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>',
          status: 200,
          text: "Field data",
          truncated: false,
        },
      },
    );
    expect(words(c)).toBe("Opened energy.example.org");
    expect(line(c).detail).toBe("Heat pumps below freezing");
    const missing = call(
      "web_fetch",
      { url: "https://a.example/x" },
      { text: "Not here", details: { title: "Not found", status: 404, text: "Not here" } },
    );
    expect(line(missing).detail).toBe("HTTP 404 · Not found");
  });
  it("11 browser: words follow the action; a click names the element, never its ref", () => {
    expect(
      words(call("browser", { action: "open", targetUrl: "https://shop.example/basket" })),
    ).toBe("Opened shop.example");
    expect(
      words(
        call("browser", {
          action: "act",
          request: { kind: "click", ref: "e14", text: "Add to basket" },
        }),
      ),
    ).toBe('Clicked "Add to basket"');
    expect(words(call("browser", { action: "act", request: { kind: "click", ref: "e14" } }))).toBe(
      "Clicked an element",
    );
    expect(
      words(call("browser", { action: "act", request: { kind: "type", ref: "e20", text: "AB1" } })),
    ).toBe("Typed into a field");
    expect(words(call("browser", { action: "screenshot" }))).toBe("Took a screenshot");
    expect(words(call("browser", { action: "tabs" }))).toBe("Used the browser");
  });
  it("12 computer: an observation is Done; a mutation is Done only when its effect is confirmed", () => {
    expect(
      words(
        call(
          "computer",
          { action: "screenshot", node: "study-mac" },
          { details: { frameId: "f12" } },
        ),
      ),
    ).toBe("Looked at the screen");
    const click = (result: Record<string, unknown>) =>
      call(
        "computer",
        { action: "left_click", coordinate: [412, 220] },
        { details: { result, followUpObservation: { ok: true } } },
      );
    expect(outcomeOf(click({ ok: true, effect: "confirmed" })).outcome).toBe("done");
    expect(outcomeOf(click({ ok: true, effect: "unverifiable" })).outcome).toBe("unconfirmed");
    expect(outcomeOf(click({ ok: true, effect: "suspected_noop" })).outcome).toBe("unconfirmed");
    expect(outcomeOf(click({ ok: true })).outcome).toBe("made");
    expect(outcomeOf(click({ ok: false })).outcome).toBe("failed");
    // A flat effect is not where the gateway projects it.
    expect(
      outcomeOf(
        call("computer", { action: "left_click" }, { details: { ok: true, effect: "confirmed" } }),
      ).outcome,
    ).toBe("made");
    expect(words(click({ ok: true, effect: "confirmed" }))).toBe("Clicked on the screen");
    expect(readableOf(click({ ok: true, effect: "unverifiable" })).rows).toContainEqual({
      label: "Effect",
      value: "could not be checked",
    });
  });
  it("13 mobile_ui: an act that ran is Call made with the device's code, never Tapped", () => {
    const tap = call(
      "mobile_ui",
      {
        action: "act",
        snapshotId: "s5",
        mobileAction: { type: "tap", ref: "n12" },
        confirmed: true,
      },
      {
        details: { outcome: { code: "performed", message: null }, snapshot: { snapshotId: "s6" } },
      },
    );
    expect(line(tap)).toMatchObject({ outcome: "made" });
    expect(state(tap)).toBe("Performed");
    expect(words(call("mobile_ui", { action: "observe" }, { details: { snapshotId: "s4" } }))).toBe(
      "Looked at the phone",
    );
  });
  it("14 screen: the Control UI, the action in words", () => {
    const c = call(
      "screen",
      { action: "desktop_show", environmentId: "env-1" },
      { text: "Shown." },
    );
    expect(words(c)).toBe("Changed the Control UI");
    expect(line(c).detail).toBe("desktop shown");
  });
  it("15 automations: created with its schedule; look-ups keyed by tool and action; next_check never folds", () => {
    const add = call(
      "automations",
      {
        action: "add",
        job: {
          name: "Weekly cleanup",
          schedule: { kind: "cron", expr: "0 9 * * 1", tz: "Europe/London" },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "Clear the cache." },
        },
      },
      { details: { id: "job_3f2a", name: "Weekly cleanup", enabled: true } },
    );
    expect(words(add)).toBe("Created routine Weekly cleanup");
    expect(line(add).detail).toBe("Mondays at 9:00 AM, Europe/London");
    expect(kindOf(call("automations", { action: "list" })).key).toBe("automations:list");
    expect(kindOf(call("cron", { action: "list" })).key).toBe("cron:list");
    expect(kindOf(call("automations", { action: "runs" })).key).toBe("automations:runs");
    expect(kindOf(call("automations", { action: "next_check" })).key).toBeNull();
    expect(
      words(
        call(
          "automations",
          { action: "next_check", in: "30m" },
          { details: { ok: true, delayMs: 1_800_000 } },
        ),
      ),
    ).toBe("Proposed the next check in 30m");
    expect(
      words(
        call(
          "automations",
          { action: "remove", id: "job_1", name: "Old reminder" },
          { details: { ok: true, removed: true } },
        ),
      ),
    ).toBe("Removed routine Old reminder");
    expect(words(call("automations", { action: "wake" }))).toBe("Woke the scheduler");
  });
  it("16 sessions_send is the Messaged card's, never folded", () => {
    expect(kindOf(call("sessions_send", { agentId: "marlow", message: "hi" }))).toMatchObject({
      kind: "message",
      key: null,
    });
  });
  it("17 the task tools: listed, read, searched, checked", () => {
    const list = call(
      "sessions_list",
      { limit: 5 },
      { details: { count: 5, sessions: [], hasMore: false } },
    );
    expect(words(list)).toBe("Looked through tasks");
    expect(line(list).detail).toBe("5 tasks");
    const history = call(
      "sessions_history",
      { sessionKey: "agent:marlow:main" },
      { text: "20 messages." },
    );
    expect(lineOf(history, { botName: (id) => (id === "marlow" ? "Marlow" : null) }).object).toBe(
      "Marlow's task",
    );
    expect(words(call("sessions_search", { query: "boiler" }))).toBe('Searched tasks for "boiler"');
    expect(words(call("session_status", {}))).toBe("Checked this task's status");
    expect(words(call("agents_list", {}))).toBe("Looked through bots");
  });
  it("18 a helper: Started on accepted; its effect leaves the gateway", () => {
    const c = call(
      "sessions_spawn",
      { label: "Price check", task: "Find the current price of the three heat pumps." },
      {
        details: {
          status: "accepted",
          childSessionKey: "agent:otto:subagent:price-check",
          runId: "run_c41e",
        },
      },
    );
    expect(line(c)).toMatchObject({ outcome: "started", leaves: true, key: null });
    expect(words(c)).toBe("Started a helper: Price check");
    const open = call(
      "sessions_spawn",
      { label: "Price check", task: "x" },
      { status: "running", text: null },
    );
    expect(words(open)).toBe("Helper Price check");
    expect(state(open)).toBe("Call started");
    expect(words(call("agents_wait", { ids: ["a", "b"] }))).toBe("Wait for 2 helpers");
  });
  it("19 ask_user: on the read tier the action card, Done only when answered", () => {
    const c = call(
      "ask_user",
      { questions: [{ question: "Which route should I plan for Saturday?" }] },
      { details: { status: "answered", answers: {} } },
    );
    expect(words(c)).toBe("Asked you a question");
    expect(line(c).detail).toBe("Which route should I plan for Saturday?");
    expect(state(c)).toBe("Answered");
    expect(kindOf(c).key).toBeNull();
  });
  it("20 progress_card and the goal tools", () => {
    const plan = call(
      "progress_card",
      {
        plan: [
          { step: "a", status: "completed" },
          { step: "b", status: "in_progress" },
          { step: "c", status: "pending" },
        ],
      },
      { details: { revision: 1, steps: {} } },
    );
    expect(words(plan)).toBe("Made a plan");
    expect(line(plan).detail).toBe("1 of 3 done");
    expect(readableOf(plan).plan.map((s) => s.status)).toEqual([
      "completed",
      "in_progress",
      "pending",
    ]);
    expect(words(call("create_goal", { objective: "Cut the backup under 30 minutes" }))).toBe(
      "Set a goal",
    );
    expect(words(call("update_goal", { status: "complete" }))).toBe("Marked the goal complete");
    expect(words(call("get_goal", {}))).toBe("Checked the goal");
    expect(kindOf(call("get_goal", {})).key).not.toBe(kindOf(call("update_goal", {})).key);
  });
  it("21 media: made by the result's count; a listing and a check are their own operations", () => {
    const made = call(
      "image_generate",
      { action: "generate", prompt: "The same house, at dusk", count: 3 },
      { details: { count: 2, paths: ["media/a.png", "media/b.png"] } },
    );
    expect(words(made)).toBe("Made 2 images");
    expect(readableOf(made).files).toEqual(["media/a.png", "media/b.png"]);
    expect(words(call("image_generate", { action: "list" }, { details: { providers: [] } }))).toBe(
      "Looked at image models",
    );
    expect(words(call("image_generate", { action: "status" }))).toBe("Checked image generation");
    expect(
      words(
        call("tts", { text: "Your boiler is booked." }, { details: { audioPath: "media/r.mp3" } }),
      ),
    ).toBe("Made a voice clip");
    expect(kindOf(call("image_generate", { action: "list" })).key).not.toBe(
      kindOf(call("image_generate", { action: "generate" })).key,
    );
  });
  it("22 pdf and view_image: one named, several counted, a URL in path", () => {
    expect(
      words(
        call("pdf", { pdfs: ["a.pdf", "b.pdf", "c.pdf"], prompt: "x" }, { text: "EPC 2023: D" }),
      ),
    ).toBe("Read 3 PDFs");
    expect(words(call("view_image", { paths: ["p/1.jpg", "p/2.jpg"] }, { text: "100 mm" }))).toBe(
      "Looked at 2 images",
    );
    expect(
      words(call("view_image", { path: "https://example.org/image.png" }, { text: "x" })),
    ).toBe("Looked at image.png");
  });
  it("23 a message on a channel: Sent, Replied, Queued, Suppressed; the message tool is Call made", () => {
    const send = (status: string) =>
      call(
        "conversations_send",
        { conversationRef: "conv_1", message: "Survey booked." },
        { details: { status, conversationRef: "conv_1", channel: "Telegram" } },
      );
    expect(state(send("sent"))).toBe("Sent");
    expect(words(send("sent"))).toBe("Message on Telegram");
    expect(line(send("queued")).outcome).toBe("queued");
    expect(line(send("suppressed"))).toMatchObject({
      outcome: "suppressed",
      verb: "Didn't send a message on",
    });
    expect(line(send("unknown")).outcome).toBe("made");
    const turn = call(
      "conversations_turn",
      { conversationRef: "conv_1", message: "Thursday?", timeoutSeconds: 120 },
      { details: { status: "replied", channel: "Telegram", reply: { text: "Yes" } } },
    );
    expect(state(turn)).toBe("Replied");
    expect(
      state(
        call(
          "conversations_turn",
          { conversationRef: "conv_1", message: "x" },
          { details: { status: "timeout" } },
        ),
      ),
    ).toBe("No reply in time");
    expect(
      line(call("message", { action: "send", channel: "Telegram", target: "Dana", message: "x" }))
        .outcome,
    ).toBe("made");
    // An opaque reference is never shown.
    expect(
      words(
        call(
          "conversations_send",
          { conversationRef: "conv_1", message: "x" },
          { status: "running", text: null },
        ),
      ),
    ).toBe("Message on a conversation");
  });
  it("24 a tool server: the general card until its result names the server and tool, then never folds", () => {
    const before = call(
      "linear__create_issue",
      { title: "Exclude the cache" },
      { status: "running", text: null },
    );
    expect(kindOf(before)).toMatchObject({ kind: "tool", key: null });
    expect(line(before).running).toBe("Using linear create issue");
    const after = call(
      "linear__create_issue",
      { title: "Exclude the cache" },
      {
        text: 'structuredContent:\n{"id":"HOME-42"}',
        details: {
          mcpServer: "linear",
          mcpTool: "create_issue",
          structuredContent: { id: "HOME-42" },
        },
      },
    );
    expect(kindOf(after)).toMatchObject({ kind: "server", key: null, leaves: true });
    expect(words(after)).toBe("Used linear");
    expect(line(after).detail).toBe("create issue");
    // An MCP error result.
    const error = call(
      "coder__send_message",
      { message: "x" },
      {
        isError: true,
        text: "boom",
        details: { mcpServer: "coder", mcpTool: "send_message", status: "error" },
      },
    );
    expect(line(error).outcome).toBe("failed");
  });
  it("25 T3 Code: recognized per call by its result naming one of its seven tools", () => {
    const c = call(
      "anything__t3_thread_launch",
      {},
      { details: { mcpServer: "whatever", mcpTool: "t3_thread_launch" } },
    );
    expect(kindOf(c)).toMatchObject({ kind: "t3", key: null });
    expect(
      kindOf(
        call("t3code__other", {}, { details: { mcpServer: "t3code", mcpTool: "create_issue" } }),
      ).kind,
    ).toBe("server");
  });
  it("26 any other tool: words from its name, the gateway's detail keys, folds only when listed", () => {
    const ok = { details: { ok: true } };
    const c = call("skills_search", { query: "invoice" }, { text: "2 skills match.", ...ok });
    expect(words(c)).toBe("Used skills search");
    expect(line(c).detail).toBe("invoice");
    expect(words(call("getWeatherNow", { location: "Leeds" }, ok))).toBe("Used get weather now");
    expect(words(call("github_publish", { title: "x", path: "notes/backup-exclude.md" }, ok))).toBe(
      "Used github publish",
    );
    expect(line(call("github_publish", { path: "notes/backup-exclude.md" })).detail).toBe(
      "backup-exclude.md",
    );
    expect(words(call("read_PDF_text", {}, ok))).toBe("Used read PDF text");
    expect(kindOf(c).key).toBeNull();
    expect(kindOf({ ...c, builtin: true }).key).toBe("tool:skills_search");
    expect(line(call("skills_search", {}, { isError: true, text: "nope" })).verb).toBe(
      "Couldn't use",
    );
  });
});

describe("F-294 every outcome short of Done", () => {
  it("Failed: a read that errored, with what went wrong as its detail", () => {
    const c = call(
      "read",
      { path: "logs/backup-2026-11-08.log" },
      {
        isError: true,
        text: "ENOENT: no such file or directory, open 'logs/backup-2026-11-08.log'",
      },
    );
    expect(line(c)).toMatchObject({
      outcome: "failed",
      verb: "Couldn't read",
      object: "backup-2026-11-08.log",
      problem: "failed",
    });
    expect(line(c).detail).toMatch(/^ENOENT/);
    expect(state(c)).toBe("Failed");
  });
  it("Timed out: a command past its own limit; Cut off: one its run's limit ended", () => {
    const c = call(
      "exec",
      { command: "rsync -a /srv/media/ nas:/b/", timeoutSeconds: 120 },
      {
        isError: true,
        text: "Command timed out after 120 seconds.",
        details: { status: "failed", timedOut: true, failureKind: "overall-timeout" },
      },
    );
    expect(line(c)).toMatchObject({
      verb: "Timed out:",
      object: "rsync",
      detail: "its 120s limit",
      outcome: "failed",
    });
    expect(state(c)).toBe("Timed out");
    const cut = call("exec", { command: "rsync -a x y" }, { status: "cut-off", text: null });
    expect(line(cut)).toMatchObject({ verb: "Cut off:", object: "rsync", outcome: "failed" });
    expect(state(cut)).toBe("Aborted");
  });
  it("Not run: a denial by the person, an expiry, a rule, the review", () => {
    const denied = call(
      "exec",
      { command: "mv a b" },
      { isError: true, text: "Exec denied (gateway id=apr_1, user-denied): mv a b" },
    );
    expect(line(denied)).toMatchObject({
      outcome: "denied",
      verb: "Didn't run",
      object: "mv",
      problem: "notRun",
    });
    expect(state(denied)).toBe("Denied");
    const expired = call(
      "exec",
      { command: "mv a b" },
      { isError: true, text: "Exec denied (gateway id=apr_1, approval-timeout): mv a b" },
    );
    expect(state(expired)).toBe("Expired");
    const policy = call(
      "exec",
      { command: "rm -rf /srv/media/cache" },
      {
        isError: true,
        text: "exec denied: host=media-box security=deny",
        details: { status: "failed" },
      },
    );
    expect(line(policy)).toMatchObject({
      outcome: "blocked",
      verb: "Blocked by policy",
      detail: "rm -rf /srv/media/cache",
      problem: "notRun",
    });
    expect(lineOf(policy).state).toMatchObject({ word: "Not run", tone: "danger" });
    const review = call(
      "exec",
      { command: "rm x" },
      { isError: true, text: "Exec denied by auto-review (high risk): deletes data" },
    );
    expect(line(review).verb).toBe("Blocked by review");
  });
  it("Not run: a refusal without an error flag (forbidden, confirmation, too many, unsupported)", () => {
    const history = call(
      "sessions_history",
      { sessionKey: "agent:other:main" },
      { details: { status: "forbidden", error: "Session history visibility is restricted." } },
    );
    expect(line(history)).toMatchObject({
      outcome: "refused",
      verb: "Didn't read",
      detail: "Session history visibility is restricted.",
    });
    const search = call(
      "sessions_search",
      { sessionKey: "agent:other:main", query: "boiler" },
      { details: { status: "forbidden", error: "Session search visibility is restricted." } },
    );
    expect(line(search)).toMatchObject({
      outcome: "refused",
      verb: "Didn't search tasks for",
      object: '"boiler"',
    });
    const phone = call(
      "mobile_ui",
      { action: "act", snapshotId: "s4", mobileAction: { type: "tap", x: 100, y: 100 } },
      {
        details: {
          code: "confirmation_required",
          package: "example.app",
          target: "coordinates (100, 100)",
          proposedEffect: "submit information",
        },
      },
    );
    expect(line(phone)).toMatchObject({
      outcome: "refused",
      verb: "Didn't tap on",
      object: "the phone",
      detail: "would submit information",
    });
    expect(state(phone)).toBe("Needs confirmation");
    expect(readableOf(phone).rows.find((r) => r.label === "Needs confirmation")?.value).toContain(
      "submit information",
    );
    const pdfs = call(
      "pdf",
      { pdfs: Array.from({ length: 11 }, (_, i) => `file-${i}.pdf`) },
      {
        text: "Too many PDFs: 11 provided, maximum is 10. Please reduce the number.",
        details: { error: "too_many_pdfs", count: 11, max: 10 },
      },
    );
    expect(line(pdfs)).toMatchObject({
      outcome: "refused",
      verb: "Didn't read",
      object: "11 PDFs",
      detail: "Too many PDFs: 11 provided, maximum is 10. Please reduce the number.",
    });
    expect(state(pdfs)).toBe("Too many");
    const images = call(
      "view_image",
      { paths: Array.from({ length: 21 }, (_, i) => `image-${i}.png`) },
      {
        text: "Too many images: 21 provided, maximum is 20.",
        details: { error: "too_many_images", count: 21, max: 20 },
      },
    );
    expect(line(images)).toMatchObject({
      outcome: "refused",
      verb: "Didn't look at",
      object: "21 images",
    });
    const unsupported = call(
      "view_image",
      { path: "ftp://x/y.png" },
      { text: "Unsupported image reference", details: { error: "unsupported_image_reference" } },
    );
    expect(state(unsupported)).toBe("Unsupported");
    const spawn = call(
      "sessions_spawn",
      { task: "A task", label: "Price check" },
      { details: { status: "forbidden", error: "policy refused" } },
    );
    expect(line(spawn)).toMatchObject({
      outcome: "refused",
      verb: "Didn't start a helper:",
      object: "Price check",
    });
  });
  it("Failed without an error flag: a goal transition refused, a spawn error, a memory read error", () => {
    const goal = call(
      "update_goal",
      { status: "complete" },
      {
        details: {
          status: "error",
          error: "No active goal requires a status change.",
          nextAction: "Do not retry update_goal.",
        },
      },
    );
    expect(line(goal)).toMatchObject({
      outcome: "failed",
      verb: "Couldn't mark",
      object: "the goal complete",
    });
    expect(readableOf(goal).rows).toContainEqual({
      label: "Next",
      value: "Do not retry update_goal.",
    });
    expect(
      line(
        call(
          "sessions_spawn",
          { task: "x", label: "y" },
          { details: { status: "error", error: "bad task name" } },
        ),
      ).outcome,
    ).toBe("failed");
    const memory = call(
      "memory_get",
      { path: "missing.md" },
      {
        details: {
          path: "missing.md",
          text: "",
          status: "error",
          code: "MEMORY_READ_FAILED",
          error: "read failed",
        },
      },
    );
    expect(line(memory)).toMatchObject({
      outcome: "failed",
      verb: "Couldn't read from memory:",
      object: "missing.md",
    });
  });
  it("Not found: a memory note that is not there, a routine removal that found none", () => {
    const note = call(
      "memory_get",
      { path: "missing.md" },
      { details: { path: "missing.md", text: "", status: "not_found" } },
    );
    expect(words(note)).toBe("Found no note missing.md in memory");
    expect(state(note)).toBe("Not found");
    const routine = call(
      "automations",
      { action: "remove", jobId: "job_a", name: "Weekly cleanup" },
      { details: { ok: true, removed: false } },
    );
    expect(words(routine)).toBe("Found no routine Weekly cleanup to remove");
    expect(line(routine).problem).toBe("notFound");
  });
  it("Started, Queued, Partial, Unavailable, Not confirmed, No change, Call made", () => {
    const image = call(
      "image_generate",
      { action: "generate", prompt: "an original sketch" },
      { details: { async: true, status: "started", taskId: "task-a", runId: "run-a" } },
    );
    expect(line(image)).toMatchObject({
      outcome: "started",
      verb: "Started making",
      object: "an image",
    });
    const run = call(
      "automations",
      { action: "run", id: "job_3f2a", name: "Weekly cleanup" },
      { details: { enqueued: true, runId: "cron_run_7" } },
    );
    expect(words(run)).toBe("Asked routine Weekly cleanup to run");
    expect(state(run)).toBe("Queued");
    expect(
      line(
        call("automations", { action: "run", name: "W" }, { details: { run: { status: "ok" } } }),
      ).outcome,
    ).toBe("done");
    const partial = call(
      "memory_search",
      { query: "gutters" },
      { details: { results: [{ path: "m.md", snippet: "x" }], partial: true } },
    );
    expect(line(partial)).toMatchObject({ outcome: "partial", verb: "Searched memory for" });
    const unavailable = call(
      "memory_search",
      { query: "loft insulation" },
      {
        details: {
          results: [],
          disabled: true,
          unavailable: true,
          warning: "Memory search is unavailable for this bot",
        },
      },
    );
    expect(line(unavailable)).toMatchObject({
      outcome: "unavailable",
      verb: "Couldn't search memory for",
      detail: "Memory search is unavailable for this bot",
      problem: "unavailable",
    });
    const x = call(
      "x_search",
      { query: "heat pump rebate 2026 experiences" },
      {
        text: '{"error":"missing_xai_api_key"}',
        details: {
          error: "missing_xai_api_key",
          message: "x_search needs xAI credentials. Sign in on the gateway, then retry.",
        },
      },
    );
    expect(line(x)).toMatchObject({
      outcome: "unavailable",
      detail: "x_search needs xAI credentials",
    });
    expect(
      line(call("web_search", { query: "q" }, { details: { error: "missing_key" } })).outcome,
    ).toBe("unavailable");
    expect(
      line(call("web_fetch", { url: "https://a.example" }, { text: "", details: {} })).outcome,
    ).toBe("unavailable");
    expect(
      line(
        call(
          "web_fetch",
          { url: "https://a.example" },
          { text: "x", details: { text: "x", truncated: true } },
        ),
      ).outcome,
    ).toBe("partial");
    const unchanged = call(
      "edit",
      { path: "notes.md", edits: [] },
      { details: { changed: false } },
    );
    expect(words(unchanged)).toBe("Left notes.md unchanged");
    expect(state(unchanged)).toBe("No change");
    expect(
      words(call("write", { path: "MEMORY.md", content: "same" }, { details: { changed: false } })),
    ).toBe("Left MEMORY.md unchanged");
    // A read without content establishes nothing more.
    expect(line(call("read", { path: "a" }, { text: "" })).outcome).toBe("made");
  });
  it("Stopped and Unknown: a stop before the result, by where the effect goes", () => {
    const read = call("read", { path: "notes.md" }, { status: "stopped", text: null });
    expect(words(read)).toBe("Stopped reading notes.md");
    expect(line(read).problem).toBe("stopped");
    const send = call(
      "conversations_send",
      { conversationRef: "c", message: "x" },
      { status: "stopped", text: null },
    );
    expect(line(send).outcome).toBe("unknown");
    // An aborted MCP call after a stop: the server may have acted.
    const mcp = call("coder__slow_task", {}, { isError: true, text: "Aborted", details: {} });
    expect(line(mcp).outcome).toBe("stopped");
    const server = call(
      "linear__x",
      {},
      { details: { mcpServer: "linear", mcpTool: "x", status: "cancelled" } },
    );
    expect(line(server).outcome).toBe("unknown");
  });
  it("open states: running, waiting for approval, review, last seen, read tier", () => {
    const running = call(
      "read",
      { path: "a.md" },
      { status: "running", text: null, endedAt: null },
    );
    expect(line(running)).toMatchObject({
      outcome: "running",
      verb: "Reading",
      state: { type: "elapsed" },
    });
    const pending = call(
      "exec",
      { command: "echo hi" },
      {
        text: "Approval pending.",
        details: {
          status: "approval-pending",
          approvalId: "approval-a",
          allowedDecisions: ["allow-once", "deny"],
        },
      },
    );
    expect(line(pending)).toMatchObject({
      outcome: "waiting",
      verb: "Wants to run",
      object: "echo",
    });
    expect(state(pending)).toBe("Waiting for you");
    expect(state({ ...pending, readOnly: true })).toBe("Waiting for approval");
    expect(line(call("exec", { command: "mv a b" }, { status: "review", text: null })).verb).toBe(
      "Reviewing",
    );
    expect(state({ ...running, lastSeen: true })).toBe("Last seen running");
    expect(
      state(
        call("sessions_spawn", { label: "x" }, { status: "running", text: null, lastSeen: true }),
      ),
    ).toBe("Last seen: call started");
  });
});

describe("F-294 the general reading of a payload (7.3): every field, for a tool with no row", () => {
  const general = (details: Record<string, unknown>) =>
    outcomeOf(call("custom_tool", {}, { details }));
  it("ok false, error, status error or failed: Failed", () => {
    expect(general({ ok: false }).outcome).toBe("failed");
    expect(general({ error: "boom" }).outcome).toBe("failed");
    expect(general({ status: "error" }).outcome).toBe("failed");
    expect(general({ status: "failed" }).outcome).toBe("failed");
    expect(general({ result: { ok: false } }).outcome).toBe("failed");
  });
  it("forbidden and confirmation_required: Not run", () => {
    expect(general({ status: "forbidden", error: "policy refused" })).toEqual({
      outcome: "refused",
      word: "Not run",
    });
    expect(general({ code: "confirmation_required" })).toEqual({
      outcome: "refused",
      word: "Needs confirmation",
    });
  });
  it("not_found and removed false: Not found", () => {
    expect(general({ status: "not_found" }).outcome).toBe("notfound");
    expect(general({ removed: false }).outcome).toBe("notfound");
  });
  it("approval-pending: Waiting; queued: Queued", () => {
    expect(general({ status: "approval-pending" }).outcome).toBe("waiting");
    expect(general({ status: "queued" }).outcome).toBe("queued");
  });
  it("effect unverifiable or suspected_noop: Not confirmed", () => {
    expect(general({ effect: "unverifiable" }).outcome).toBe("unconfirmed");
    expect(general({ result: { effect: "suspected_noop" } }).outcome).toBe("unconfirmed");
  });
  it("an outcome, or any other status or code: Call made, as received", () => {
    expect(general({ outcome: { code: "unknown" } })).toEqual({ outcome: "made", word: "Unknown" });
    expect(general({ outcome: "pending_review" })).toEqual({
      outcome: "made",
      word: "Pending review",
    });
    expect(general({ status: "throttled" })).toEqual({ outcome: "made", word: "Throttled" });
    expect(general({ code: "E_RATE" })).toEqual({ outcome: "made", word: "E RATE" });
  });
  it("values that say the work was done are no signal against Done", () => {
    for (const status of ["ok", "completed", "success", "sent", "accepted", "answered", "replied"])
      expect(general({ status }).outcome).toBe("done");
    expect(general({ ok: true, removed: true, effect: "confirmed" }).outcome).toBe("done");
    expect(payloadOutcome(null)).toBeNull();
  });
  it("nothing reaches Done by default: a result with no text and no details is Call made", () => {
    expect(outcomeOf(call("custom_tool", {}, { text: "", details: null })).outcome).toBe("made");
  });
});

describe("F-091 F-092 folding (7.4)", () => {
  const read = (path: string, more: Partial<ActionCall> = {}) =>
    call("read", { path }, { text: "a\nb", ...more });
  const fold = (calls: ActionCall[]) => foldLineOf(calls);
  const feed = (calls: Array<ActionCall | "bubble" | "reasoning" | "card">) =>
    groupFeed<string>(
      calls.map((c, i): FeedEntry<string> =>
        c === "bubble"
          ? { type: "bubble", id: `b${i}`, ref: "bubble" }
          : c === "card"
            ? { type: "card", id: `c${i}`, ref: "card" }
            : c === "reasoning"
              ? {
                  type: "reasoning",
                  segment: { id: `r${i}`, text: "hm", startedAt: 0, endedAt: 4000 },
                }
              : { type: "action", call: c },
      ),
    );

  it("F-488 six reads in a row are one card that counts files", () => {
    const groups = feed(["a", "b", "c", "d", "e", "f"].map((p) => read(`logs/${p}.log`)));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ type: "fold" });
    const members = groups[0]!.type === "fold" ? groups[0]!.members.map((m) => m.call) : [];
    const f = fold(members);
    expect(`${f.verb} ${f.object}`).toBe("Read 6 files");
    expect(f.detail).toBe("a.log, b.log, c.log, d.log, e.log, f.log");
    expect(f.state).toEqual({ type: "time", ms: 3600 });
  });
  it("distinct objects: two reads of one file and one of another", () => {
    const f = fold([read("a.md"), read("a.md"), read("b.md")]);
    expect(`${f.verb} ${f.object}`).toBe("Read 2 files · 3 reads");
  });
  it("edits count files, and say times only when a member names none", () => {
    const e = (path: string) =>
      call("edit", { path, edits: [] }, { details: { changed: true, diff: diff(path, ["x"]) } });
    expect(
      `${fold([e("a.md"), e("a.md"), e("b.md")]).verb} ${fold([e("a.md"), e("a.md"), e("b.md")]).object}`,
    ).toBe("Edited 2 files · 3 edits");
    expect(fold([e("a.md"), e("b.md")]).detail).toBe("+2 −0");
    const patch = call("apply_patch", { input: "no files" });
    const mixed = fold([e("a.md"), patch]);
    expect(`${mixed.verb} ${mixed.object}`).toBe("Made 2 edits");
  });
  it("two PDF calls over the same three files, two writes of one note", () => {
    const pdf = () =>
      call(
        "pdf",
        { pdfs: ["one.pdf", "two.pdf", "three.pdf"], prompt: "Compare them." },
        { text: "Analysis" },
      );
    const p = fold([pdf(), pdf()]);
    expect(`${p.verb} ${p.object}`).toBe("Read 3 PDFs · 2 times");
    const note = () =>
      call(
        "write",
        { path: "MEMORY.md", content: "A note." },
        { details: { changed: true, created: false, diff: "@@\n+A note." } },
      );
    const m = fold([note(), note()]);
    expect(`${m.verb} ${m.object}`).toBe("Saved 1 note to memory · 2 times");
  });
  it("background images: the started plural, counted, no duration", () => {
    const media = () =>
      call(
        "image_generate",
        { action: "generate", prompt: "an original sketch" },
        { details: { async: true, status: "started", taskId: "t" } },
      );
    const f = fold([media(), media()]);
    expect(`${f.verb} ${f.object}`).toBe("Started making images · 2 times");
    expect(f.state).toMatchObject({ type: "counts", words: "2 started" });
    expect(f.spoken).toMatch(/2 started$/);
  });
  it("two partial searches keep Partial and no duration", () => {
    const partial = () =>
      call("memory_search", { query: "boiler" }, { details: { results: [], partial: true } });
    const f = fold([partial(), partial()]);
    expect(`${f.verb} ${f.object}`).toBe("Searched memory 2 times");
    expect(f.state).toMatchObject({ type: "counts", words: "2 partial" });
  });
  it("image listings fold as a look-up, never as Made", () => {
    const list = () => call("image_generate", { action: "list" }, { details: { providers: [] } });
    const f = fold([list(), list()]);
    expect(`${f.verb} ${f.object}`).toBe("Looked at image models · 2 times");
  });
  it("a mix of outcomes is neutral, with the counts of what is short of Done", () => {
    const started = call(
      "image_generate",
      { action: "generate", prompt: "x" },
      { details: { async: true, status: "started" } },
    );
    const made = call("image_generate", { action: "generate", prompt: "y" }, { details: {} });
    const f = fold([started, made]);
    expect(`${f.verb} ${f.object}`).toBe("Image generation · 2 calls");
    expect(f.state).toMatchObject({ words: "1 started · 1 call made" });
  });
  it("a failure joins the fold and is named on its line, in --danger", () => {
    const f = fold([
      read("a.md"),
      read("backup-2026-11-08.log", { isError: true, text: "ENOENT" }),
      read("c.md"),
    ]);
    // The done plural counts the two reads that were done, never the failed one.
    expect(`${f.verb} ${f.object}`).toBe("Read 2 files");
    expect(f.detail).toBe("couldn't read backup-2026-11-08.log");
    expect(f.tone).toBe("danger");
    expect(f.state).toMatchObject({ type: "counts", words: "1 failed", danger: true });
    expect(f.status).toBe("failed");
  });
  it("problems are counted in the fixed order and the first problem in row order is named", () => {
    const denied = call(
      "exec",
      { command: "echo hi" },
      { isError: true, text: "Exec denied (gateway id=a, user-denied): echo hi" },
    );
    const failed = call("exec", { command: "echo hello" }, { isError: true, text: "boom" });
    const f = fold([denied, failed]);
    expect(f.state).toMatchObject({ words: "1 failed · 1 not run" });
    expect(f.detail).toBe("didn't run echo");
  });
  it("an earlier failure and a later pending approval: the failure with its count, Waiting for you", () => {
    const failed = call("exec", { command: "mv x y" }, { isError: true, text: "boom" });
    const ok = call("exec", { command: "ls" }, { details: { exitCode: 0 } });
    const waiting = call("exec", { command: "mv a b" }, { status: "waiting", text: null });
    const f = fold([failed, ok, waiting]);
    expect(`${f.verb} ${f.object}`).toBe("Commands · 3 calls");
    expect(f.detail).toBe("1 failed: couldn't run mv");
    expect(f.state).toMatchObject({ type: "waiting" });
  });
  it("two commands that returned approval-pending fold as Waiting, the neutral plural, no duration", () => {
    const pending = (cmd: string) =>
      call(
        "exec",
        { command: cmd },
        { text: "Approval pending.", details: { status: "approval-pending" } },
      );
    const f = fold([pending("echo hi"), pending("echo hello")]);
    expect(`${f.verb} ${f.object}`).toBe("Commands · 2 calls");
    expect(f.status).toBe("waiting");
    expect(f.spoken).toMatch(/waiting for you$/);
  });
  it("all stopped: named and counted", () => {
    const stopped = (p: string) => read(p, { status: "stopped", text: null });
    const f = fold([stopped("a.md"), stopped("b.md"), stopped("notes.md")]);
    expect(f.detail).toBe("stopped reading a.md");
    expect(f.state).toMatchObject({ words: "3 stopped" });
  });
  it("a running member: its words in the detail, its elapsed time at the right", () => {
    const f = fold([
      read("a.md"),
      read("notes.md", { status: "running", text: null, endedAt: null, startedAt: 5000 }),
    ]);
    expect(f.detail).toBe("reading notes.md");
    expect(f.state).toMatchObject({ type: "running", since: 5000 });
  });
  it("a member missing its times gives no partial sum", () => {
    const f = fold([read("a.md"), read("b.md", { startedAt: null })]);
    expect(f.state).toEqual({ type: "time", ms: null });
  });
  it("what breaks a fold: another key, a bubble, a card; reasoning does not", () => {
    expect(feed([read("a"), read("b")]).map((g) => g.type)).toEqual(["fold"]);
    expect(feed([read("a"), "reasoning", read("b")]).map((g) => g.type)).toEqual(["fold"]);
    expect(feed([read("a"), "bubble", read("b")]).map((g) => g.type)).toEqual([
      "action",
      "bubble",
      "action",
    ]);
    expect(feed([read("a"), "card", read("b")]).map((g) => g.type)).toEqual([
      "action",
      "card",
      "action",
    ]);
    expect(feed([read("a"), call("ls", { path: "x" }), read("b")]).map((g) => g.type)).toEqual([
      "action",
      "action",
      "action",
    ]);
  });
  it("keys: automations list and cron list stay two cards; get_goal and update_goal do not fold", () => {
    expect(
      feed([call("automations", { action: "list" }), call("cron", { action: "list" })]).map(
        (g) => g.type,
      ),
    ).toEqual(["action", "action"]);
    expect(
      feed([call("automations", { action: "list" }), call("automations", { action: "list" })]).map(
        (g) => g.type,
      ),
    ).toEqual(["fold"]);
    expect(
      feed([call("get_goal", {}), call("update_goal", { status: "x" })]).map((g) => g.type),
    ).toEqual(["action", "action"]);
    expect(
      feed([call("memory_search", { query: "a" }), call("memory_get", { path: "b" })]).map(
        (g) => g.type,
      ),
    ).toEqual(["action", "action"]);
  });
  it("two calls of an opaque name do not fold; a listed one does", () => {
    expect(
      feed([call("coder__send_message", {}), call("coder__send_message", {})]).map((g) => g.type),
    ).toEqual(["action", "action"]);
    expect(
      feed([
        call("skills_search", {}, { builtin: true }),
        call("skills_search", {}, { builtin: true }),
      ]).map((g) => g.type),
    ).toEqual(["fold"]);
  });
  it("a fold is keyed by its first member's id, and a split or merge keeps that key", () => {
    const a = read("a");
    const b = read("b");
    const c = read("c");
    expect(feed([a, b, c])[0]!.key).toBe(a.id);
    const split = feed([a, "bubble", b, c]);
    expect(split.map((g) => g.key)).toEqual([a.id, "b1", b.id]);
  });
});

describe("F-423 F-090 reasoning, the run line and the status line", () => {
  it("reasoning belongs to the next action, else to the reply, else to the end", () => {
    const a = call("read", { path: "a" });
    const groups = groupFeed<string>([
      { type: "reasoning", segment: { id: "r1", text: "first", startedAt: 0, endedAt: 2000 } },
      { type: "reasoning", segment: { id: "r2", text: "second", startedAt: 2000, endedAt: 4000 } },
      { type: "action", call: a },
      { type: "reasoning", segment: { id: "r3", text: "then", startedAt: 5000, endedAt: 13000 } },
      { type: "bubble", id: "reply", ref: "reply" },
    ]);
    expect(groups[0]).toMatchObject({ type: "action", thought: { id: "r1", ms: 4000 } });
    expect(groups[1]).toMatchObject({
      type: "thought",
      place: "reply",
      thought: { id: "r3", ms: 8000 },
    });
    expect(groups[2]).toMatchObject({ type: "bubble", key: "reply" });
    const only = groupFeed<string>([
      { type: "reasoning", segment: { id: "r", text: "x", startedAt: null, endedAt: null } },
    ]);
    expect(only).toEqual([
      {
        type: "thought",
        key: "r",
        place: "end",
        thought: { id: "r", segments: [expect.anything()], ms: null },
      },
    ]);
  });
  it("a run line counts actions and the failed ones, and only for an ended run with actions", () => {
    const base = { startedAt: 0, endedAt: 72_000, reportedStartAt: 0 };
    const calls = [
      call("read", { path: "a" }),
      call("read", { path: "b" }, { isError: true, text: "x" }),
    ];
    expect(runLineOf({ ...base, state: "completed" }, calls)?.text).toBe(
      "Worked for 1m 12s · 2 actions · 1 failed",
    );
    expect(runLineOf({ ...base, state: "stopped", endedAt: 40_000 }, calls.slice(0, 1))?.text).toBe(
      "Stopped after 40s · 1 action",
    );
    expect(runLineOf({ ...base, state: "failed", endedAt: 12_000 }, calls.slice(0, 1))?.text).toBe(
      "Failed after 12s · 1 action",
    );
    expect(runLineOf({ ...base, state: "completed", endedAt: null }, calls.slice(0, 1))?.text).toBe(
      "Worked · 1 action",
    );
    expect(runLineOf({ ...base, state: "completed" }, [])).toBeNull();
    expect(runLineOf({ ...base, state: "running" }, calls)).toBeNull();
    const unavailable = call(
      "x_search",
      { query: "q" },
      { details: { error: "missing_xai_api_key" } },
    );
    expect(runLineOf({ ...base, state: "completed" }, [unavailable])?.problems).toEqual([
      "1 unavailable",
    ]);
  });
  it("F-082 the status line's action: the latest to start, then the earliest still running", () => {
    const a = call("read", { path: "a" }, { status: "running", text: null });
    const b = call("read", { path: "b" }, { status: "running", text: null });
    const c = call("read", { path: "c" }, { status: "running", text: null });
    expect(phraseCall([a, b, c])?.id).toBe(c.id);
    expect(phraseCall([a, b, { ...c, status: "returned", text: "x" }])?.id).toBe(a.id);
    expect(phraseCall([{ ...a, status: "returned", text: "x" }])).toBeNull();
  });
});

describe("the engine keeps what the reading needs, within its bound", () => {
  it("projections fit and keep the fields the reading reads", () => {
    const content = "x".repeat(50_000);
    const args = projectArgs({ path: "memory/a.md", content });
    expect(JSON.stringify(args).length).toBeLessThanOrEqual(MAX_ACTION_FACTS_CHARS);
    expect(args?.path).toBe("memory/a.md");
    const details = projectDetails({
      changed: true,
      diff: diff(
        "a.md",
        Array.from({ length: 4000 }, () => "line"),
      ),
      patch: "y".repeat(90_000),
      aggregated: "z",
    });
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(MAX_ACTION_FACTS_CHARS);
    expect(details).toMatchObject({ changed: true, diffStat: { added: 4000, removed: 0 } });
    expect(details).not.toHaveProperty("patch");
    const patch = projectArgs({
      input: `*** Begin Patch\n*** Update File: a.sh\n${"+x\n".repeat(20_000)}*** Add File: b.sh\n*** End Patch`,
    });
    expect(patch?.input).toBe("*** Update File: a.sh\n*** Add File: b.sh");
    // A cut value reads the same: the line from a projection equals the line from the whole.
    const whole = call(
      "edit",
      { path: "a.md", edits: [] },
      {
        details: {
          changed: true,
          diff: diff(
            "a.md",
            Array.from({ length: 4000 }, () => "line"),
          ),
        },
      },
    );
    expect(lineOf({ ...whole, details: projectDetails(whole.details) }).detail).toBe(
      lineOf(whole).detail,
    );
  });
  it("a step becomes the same call live and from history", () => {
    const step: Step = {
      id: "tool:call_x",
      kind: "tool",
      title: "Read",
      toolName: "read",
      toolCallId: "call_x",
      status: "running",
      startedAt: 10,
      endedAt: null,
      argsText: { text: '{\n  "path": "a.md"\n}', totalChars: 18 },
      output: null,
      result: null,
      error: null,
      approvalId: null,
      failureKind: null,
      truncated: false,
      replaceable: false,
      correction: 0,
      continuation: null,
      raw: null,
      rawSize: null,
    };
    const run = { state: "running", error: null, ending: null, origin: "local" } as Pick<
      Run,
      "state" | "error" | "ending" | "origin"
    >;
    expect(callFromStep(step, run)).toMatchObject({
      id: "call_x",
      name: "read",
      args: { path: "a.md" },
      status: "running",
    });
    expect(callFromStep(step, { ...run, state: "stopped" }).status).toBe("stopped");
    expect(
      callFromStep(step, { ...run, state: "failed", error: { message: "x", kind: "turn-limit" } })
        .status,
    ).toBe("cut-off");
  });
});

describe("a routine's schedule in words", () => {
  it("says every time zone, the gateway's when it has none", () => {
    expect(scheduleWords({ kind: "cron", expr: "0 9 * * 1", tz: "Europe/London" })).toBe(
      "Mondays at 9:00 AM, Europe/London",
    );
    expect(scheduleWords({ kind: "cron", expr: "30 18 * * *" })).toBe(
      "Every day at 6:30 PM, gateway's time",
    );
    expect(scheduleWords({ kind: "cron", expr: "*/5 * * * *" })).toBe(
      "*/5 * * * *, gateway's time",
    );
    expect(scheduleWords({ kind: "every", everyMs: 7_200_000 })).toBe("every 2 hours");
  });
});

describe("a call with no result in a run that ended without a stop", () => {
  it("reads Unknown and never claims a stop", () => {
    const c = call("read", { path: "notes.md" }, { status: "unreturned", text: null });
    expect(lineOf(c)).toMatchObject({
      outcome: "unknown",
      verb: "No result:",
      object: "reading notes.md",
    });
    expect(lineOf(call("du", { path: "/srv" }, { status: "unreturned", text: null })).verb).toBe(
      "Call to",
    );
  });
});

describe("a plan saved again", () => {
  it("is Made at the gateway's first revision and Saved after it, never by the task's order", () => {
    const plan = call(
      "progress_card",
      { plan: [{ step: "a", status: "pending" }] },
      { details: { revision: 1, steps: { completed: 0, total: 1 } } },
    );
    expect(words(plan)).toBe("Made a plan");
    expect(words({ ...plan, details: { revision: 3, steps: null } })).toBe("Saved the plan");
  });
});

describe("a failure rebuilt from history without details", () => {
  it("takes what went wrong from the result's JSON body, never its opening brace", () => {
    const body = JSON.stringify(
      { status: "error", tool: "read", error: "File not found: missing/old-notes.md." },
      null,
      2,
    );
    const c = call(
      "read",
      { path: "missing/old-notes.md" },
      { isError: true, text: body, details: null, fromHistory: true },
    );
    expect(lineOf(c).detail).toBe("File not found: missing/old-notes.md.");
    expect(lineOf({ ...c, text: '{"status": "error", "err' }).detail).toBe("");
  });
});

describe("the gateway's name map for tool servers", () => {
  it("knows a tool-server call from its start, folds it by server and tool, and lets the result overrule it", () => {
    const ctx = {
      toolServers: { linear__create_issue: { server: "linear", tool: "create_issue" } },
    };
    const open = call("linear__create_issue", { title: "x" }, { status: "running", text: null });
    expect(kindOf(open, ctx)).toMatchObject({
      kind: "server",
      key: "server:linear:create_issue",
      leaves: true,
    });
    expect(lineOf(open, ctx)).toMatchObject({ verb: "Tool server", object: "linear" });
    // Without the map it is the general card and never folds.
    expect(kindOf(open)).toMatchObject({ kind: "tool", key: null });
    // The result names T3 Code's own tool: it is T3 Code's, whatever the map said.
    const t3 = {
      ...open,
      status: "returned" as const,
      details: { mcpServer: "linear", mcpTool: "t3_thread_send" },
    };
    expect(kindOf(t3, ctx).kind).toBe("t3");
    // The map names T3 Code; the result names another tool: an ordinary tool-server call.
    const mapped = { toolServers: { coder__send: { server: "coder", tool: "t3_thread_send" } } };
    const back = call(
      "coder__send",
      {},
      { details: { mcpServer: "coder", mcpTool: "send_message" } },
    );
    expect(kindOf({ ...back, status: "running", details: null }, mapped).kind).toBe("t3");
    expect(kindOf(back, mapped).kind).toBe("server");
  });
});

describe("a call its run's stop cut short", () => {
  it("reads Unknown for an effect that leaves the gateway, Stopped for one that stays, never Failed", () => {
    const mcp = call(
      "coder__slow_task",
      { seconds: 3600 },
      { isError: true, text: "", details: {}, runStopped: true },
    );
    expect(
      outcomeOf(mcp, { toolServers: { coder__slow_task: { server: "coder", tool: "slow_task" } } })
        .outcome,
    ).toBe("unknown");
    expect(
      outcomeOf(call("read", { path: "a" }, { isError: true, text: "", runStopped: true })).outcome,
    ).toBe("stopped");
    // Without a stop, an empty error is a failure.
    expect(outcomeOf(call("read", { path: "a" }, { isError: true, text: "" })).outcome).toBe(
      "failed",
    );
  });
  it("gives no duration under half a second", () => {
    const groups = groupFeed<string>([
      { type: "reasoning", segment: { id: "r", text: "x", startedAt: 0, endedAt: 200 } },
      { type: "bubble", id: "b", ref: "b" },
    ]);
    expect(groups[0]).toMatchObject({ type: "thought", thought: { ms: null } });
  });
});

describe("nothing reaches Done by default (7.3)", () => {
  const outcome = (c: ActionCall, ctx = {}) => lineOf(c, ctx).outcome;
  const servers = { toolServers: { remote_thing: { server: "sample", tool: "thing" } } };
  const empty = { text: "", details: null };

  it("a tool-server call that returned nothing is a call made", () => {
    expect(outcome(call("remote_thing", {}, empty), servers)).toBe("made");
    expect(outcome(call("remote_thing", {}, { text: "Issue 12 created" }), servers)).toBe("done");
  });
  it("a general card's payload with no field the design reads is a call made", () => {
    const c = call("custom_tool", {}, { details: { requestId: "r-1" } });
    expect(outcome(c)).toBe("made");
    expect(outcome(call("custom_tool", {}, { text: "Plain words" }))).toBe("made");
    expect(outcome(call("custom_tool", {}, { details: { ok: true } }))).toBe("done");
    expect(outcome(call("custom_tool", {}, { details: { status: "completed" } }))).toBe("done");
  });
  it("made media needs a path or a medium that is there, not an empty list", () => {
    const make = (details: Record<string, unknown>) =>
      call("image_generate", { action: "generate" }, { details });
    expect(outcome(make({ paths: [] }))).toBe("made");
    expect(outcome(make({ media: [] }))).toBe("made");
    expect(outcome(make({ paths: ["out/a.png"] }))).toBe("done");
  });
  it("a patch that returned no text and no details is a call made", () => {
    const patch = call("apply_patch", { input: "*** Update File: note.md" }, empty);
    expect(outcome(patch)).toBe("made");
    expect(outcome({ ...patch, text: "Success. Updated note.md" })).toBe("done");
  });
  it("the general reading outranks a kind's fallback: refused, queued", () => {
    const get = call("memory_get", { path: "notes.md" }, { details: { status: "forbidden" } });
    expect(outcome(get)).toBe("refused");
    const exec = call("exec", { command: "echo hi" }, { details: { status: "queued" } });
    expect(outcome(exec)).toBe("queued");
  });
  it("a signal at either level outranks a value shown only as received", () => {
    const c = call("custom_tool", {}, { details: { status: "redirect", result: { ok: false } } });
    expect(outcome(c)).toBe("failed");
  });
  it("a plugin's block reads the same with or without the name map", () => {
    const blocked = call("remote_thing", {}, { details: { status: "blocked" }, text: "blocked" });
    expect(lineOf(blocked).outcome).toBe("blocked");
    expect(lineOf(blocked, servers).outcome).toBe("blocked");
    const run = { state: "completed" as const, startedAt: 1_000, endedAt: 2_000 };
    expect(runLineOf(run as Run, [blocked])?.failed).toBe(1);
    expect(runLineOf(run as Run, [blocked], servers)?.failed).toBe(1);
  });
});

describe("a plan as the gateway answered it", () => {
  it("a cleared card says it was cleared, by its payload or its text", () => {
    const cleared = call(
      "progress_card",
      {},
      {
        details: { revision: null, steps: null },
        text: "Progress card cleared",
      },
    );
    expect(words(cleared)).toBe("Cleared the plan");
    expect(lineOf(cleared).outcome).toBe("done");
    expect(words({ ...cleared, details: null })).toBe("Cleared the plan");
    expect(words({ ...cleared, status: "running", text: null, details: null })).toBe(
      "Clearing the plan",
    );
  });
  it("the projection keeps the revision and the step counts", () => {
    const kept = projectDetails({ revision: 4, steps: { completed: 1, total: 2 } });
    expect(kept).toMatchObject({ revision: 4, steps: { completed: 1, total: 2 } });
    const saved = call(
      "progress_card",
      { plan: [] },
      { details: kept, text: "Progress card updated" },
    );
    expect(words(saved)).toBe("Saved the plan");
    expect(line(saved).detail).toBe("1 of 2 done");
  });
  it("a plan with no revision establishes only the call", () => {
    const c = call("progress_card", { plan: [{ step: "a", status: "pending" }] }, empty());
    expect(lineOf(c).outcome).toBe("made");
  });
});

describe("a fold's plural is never more complete than its members (7.4)", () => {
  const read = (path: string, more: Partial<ActionCall> = {}) =>
    call("read", { path }, { text: "contents", ...more });
  it("a failed member is not counted as read, in the line or its accessible name", () => {
    const f = foldLineOf([read("one.md"), read("missing.md", { isError: true, text: "no file" })]);
    expect(`${f.verb} ${f.object}`).toBe("Read 1 file");
    expect(f.spoken).toMatch(/^Read 1 file, couldn't read missing.md, 1 failed$/);
  });
  it("a running member is not counted as read", () => {
    const f = foldLineOf([
      read("one.md"),
      read("two.md", { status: "running", text: null, endedAt: null }),
    ]);
    expect(`${f.verb} ${f.object}`).toBe("Read 1 file");
    expect(f.spoken).toMatch(/^Read 1 file, reading two.md, running$/);
  });
  it("a fold with no Done member uses the neutral plural", () => {
    const f = foldLineOf([
      read("a.md", { isError: true, text: "no" }),
      read("b.md", { isError: true, text: "no" }),
    ]);
    expect(f.verb).not.toMatch(/^Read/);
  });
});

describe("fold keys keep apart what the plural cannot say together", () => {
  it("two different changes of the Control UI do not fold", () => {
    const show = call("screen", { action: "desktop_show" });
    const hide = call("screen", { action: "desktop_hide" });
    expect(kindOf(show).key).not.toBe(kindOf(hide).key);
    expect(kindOf(show).key).toBe(kindOf(call("screen", { action: "desktop_show" })).key);
  });
  it("a result that names another operation of a mapped server keeps it apart", () => {
    const ctx = { toolServers: { remote_thing: { server: "sample", tool: "thing" } } };
    const mapped = call("remote_thing", {}, { details: { mcpServer: "sample", mcpTool: "thing" } });
    const other = call("remote_thing", {}, { details: { mcpServer: "sample", mcpTool: "other" } });
    expect(kindOf(mapped, ctx).key).toBe("server:sample:thing");
    expect(kindOf(other, ctx).key).toBe("server:sample:other");
  });
  it("a general card folds by name when the gateway's inventory lists it, and only then", () => {
    const c = call("skills_search", {});
    expect(kindOf(c).key).toBeNull();
    expect(kindOf(c, { builtinTools: ["skills_search"] }).key).toBe("tool:skills_search");
    expect(kindOf(c, { builtinTools: ["other_tool"] }).key).toBeNull();
  });
});

describe("memory, by the workspace root the gateway names", () => {
  it("an absolute path is memory only inside the root the gateway gave", () => {
    const w = call("write", { path: "/workspace/bot/memory/a.md" }, { details: { changed: true } });
    expect(kindOf(w).kind).toBe("edit");
    expect(kindOf(w, { workspaceRoot: null }).kind).toBe("edit");
    expect(kindOf(w, { workspaceRoot: "/workspace/bot" }).kind).toBe("memory");
    expect(kindOf(w, { workspaceRoot: "/workspace/other" }).kind).toBe("edit");
  });
});

describe("a result history kept only as text", () => {
  const block = (name: string, text: string, args = "{}") => ({
    kind: "tool-call" as const,
    callId: "h-1",
    name,
    argumentsText: args,
    result: { text, isError: false },
  });
  it("is read as its payload when the text is the tool's JSON", () => {
    const refused = callFromBlock(
      block("sessions_history", '{"status":"forbidden","error":"Visibility restricted"}'),
      undefined,
      undefined,
    );
    expect(lineOf(refused).outcome).toBe("refused");
  });
  it("text that is not a payload establishes only the call", () => {
    expect(lineOf(callFromBlock(block("custom_tool", "Done!"), undefined, undefined)).outcome).toBe(
      "made",
    );
  });
  it("a read's content is never taken for a payload", () => {
    const c = callFromBlock(
      block("read", '{"status":"error","error":"in the file"}', '{"path":"a.json"}'),
      undefined,
      undefined,
    );
    expect(lineOf(c).outcome).toBe("done");
  });
});

describe("the arguments' projection", () => {
  it("keeps the keys the reading reads before others take its budget", () => {
    const noise = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`property${i}`, "x".repeat(200)]),
    );
    const kept = projectArgs({ path: "notes.md", irrelevant: noise });
    expect(kept?.path).toBe("notes.md");
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(MAX_ACTION_FACTS_CHARS);
  });
});

function empty(): Partial<ActionCall> {
  return { text: "", details: null };
}
