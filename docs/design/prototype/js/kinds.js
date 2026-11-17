// Action cards: from a tool call to a plain-words card (conversation.md, sections 7 and 8).
//
// This file is the prototype of the one mapping the core will hold
// (packages/core/src/actions.ts): a tool's name, its arguments and its result
// give a kind, a fold key and the parts of the card's line. Nothing in a tool
// event names the kind, so it is chosen here from the name, by the table in
// section 8.1. The words are English here; in the app they are strings in the
// interface package, and the core returns only data.
//
// A call, as the prototype's fixtures give it:
//   { id, name, args, text, details, isError, started, took, status }
// status: running, review, waiting, done, failed, blocked, denied, stopped,
// unknown, made (a returned call whose delivery is not established).
//
// Markup:   CT.actionCard(call, opts), CT.foldCard(calls, opts), CT.thought(...),
//           CT.runLine(...)
// Engine:   CT.feed({ insert }) places cards in order and folds them.

(function () {
  const CT = window.CT;
  const esc = CT.esc;
  const json = (value) => JSON.stringify(value, null, 2);

  // Small helpers for objects ---------------------------------------------------------

  const base = (path) => String(path || "").split("/").filter(Boolean).pop() || String(path || ".");
  const host = (url) => {
    try {
      return new URL(url).host.replace(/^www\./, "");
    } catch {
      return String(url || "");
    }
  };
  const quote = (text) => {
    const t = String(text || "").trim();
    return `"${t.length > 40 ? `${t.slice(0, 39).trimEnd()}…` : t}"`;
  };
  const firstWords = (text, n = 6) => {
    const words = String(text || "").replace(/^#+\s*/, "").split(/\s+/).filter(Boolean);
    return words.length ? quote(words.slice(0, n).join(" ") + (words.length > n ? "…" : "")) : "";
  };
  const lines = (text) => (text ? String(text).replace(/\n$/, "").split("\n").length : 0);

  // The program a command runs: its first word that is not an assignment, sudo or env.
  CT.programOf = (command) => {
    const words = String(command || "").trim().split(/\s+/);
    const word = words.find((w) => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && w !== "sudo" && w !== "env");
    return word && !word.startsWith("<<") ? base(word) : "";
  };

  // The general card's words, from a name (section 8.3).
  CT.nameWords = (name) =>
    String(name || "tool")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[_\-.\s]+/)
      .filter(Boolean)
      .map((part) => (/^[A-Z]{2,5}$/.test(part) ? part : part.toLowerCase()))
      .join(" ");

  // The gateway's own detail keys, in its order (tool-display, "fallback").
  const DETAIL_KEYS = ["command", "path", "url", "targetUrl", "targetId", "ref", "element", "node", "nodeId", "id", "requestId", "to", "channelId", "guildId", "userId", "name", "query", "pattern", "messageId"];
  CT.generalDetail = (args = {}) => {
    const key = DETAIL_KEYS.find((k) => args[k] !== undefined && args[k] !== "");
    if (!key) return "";
    const value = String(args[key]);
    if (key === "path") return base(value);
    if (/url/i.test(key)) return host(value);
    return value.length > 60 ? `${value.slice(0, 59)}…` : value;
  };

  // Lines added and removed, from a unified diff.
  const diffCount = (diff) => {
    const rows = String(diff || "").split("\n");
    const added = rows.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
    const removed = rows.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
    return { added, removed };
  };
  const diffText = ({ added, removed }) => `+${added} −${removed}`;

  // Files are counted once: three edits to two files are "2 files".
  const files = (calls) => {
    const k = new Set(calls.map((c) => c.args.path || c.id)).size;
    return `${k} ${k === 1 ? "file" : "files"}`;
  };

  const isMemoryPath = (path) => /^(\.\/)?(MEMORY\.md$|memory\/)/.test(String(path || ""));

  // Kinds -------------------------------------------------------------------------------
  //
  // Each kind gives its icon, and for a call the verb in each tense, the object,
  // the detail, and the plural line for a fold. `run`, `done` and `fail` are
  // [verb, object].

  const three = (run, done, fail, object, detail = "", more = {}) => ({ run: [run, object], done: [done, object], fail: [fail, object], detail, ...more });

  const K = {};

  K.read = {
    icon: "read",
    words: (c) => three("Reading", "Read", "Couldn't read", base(c.args.path), c.text && !c.isError ? `${lines(c.text)} lines` : ""),
    plural: (n, calls) => ["Read", files(calls)],
  };

  K.list = {
    icon: "list",
    words: (c) => three("Looking in", "Looked in", "Couldn't open", base(c.args.path), c.text && !c.isError ? `${lines(c.text)} entries` : ""),
    plural: (n) => ["Looked in", `${n} folders`],
  };

  K.edit = {
    icon: "write",
    words: (c) => {
      const patch = c.name === "apply_patch";
      const o = patch ? "a patch" : base(c.args.path);
      const done = patch ? "Applied" : c.details?.created ? "Created" : "Edited";
      return { run: [patch ? "Applying" : "Editing", o], done: [done, o], fail: ["Couldn't edit", o], detail: c.details?.diff ? diffText(diffCount(c.details.diff)) : "" };
    },
    plural: (n, calls) => ["Edited", files(calls)],
    foldDetail: (calls) =>
      diffText(
        calls.reduce(
          (t, c) => {
            const d = diffCount(c.details?.diff);
            return { added: t.added + d.added, removed: t.removed + d.removed };
          },
          { added: 0, removed: 0 },
        ),
      ),
  };

  K.memory = {
    icon: "memory",
    words: (c) => three("Saving to", "Saved to", "Couldn't save to", "memory", firstWords(c.args.content || c.args.edits?.[0]?.newText)),
    plural: (n) => ["Saved", `${n} notes to memory`],
  };

  K.recall = {
    icon: "recall",
    words: (c) =>
      c.name === "memory_get"
        ? three("Reading from memory", "Read from memory", "Couldn't read from memory", base(c.args.path))
        : three("Searching memory for", "Searched memory for", "Couldn't search memory for", quote(c.args.query), c.details?.count !== undefined ? `${c.details.count} matches` : ""),
    plural: (n) => ["Looked in memory", `${n} times`],
  };

  K.command = {
    icon: "command",
    words: (c) => {
      if (c.name === "code_execution") return three("Running", "Ran", "Couldn't run", "code", c.args.task || "");
      const exit = c.details?.exitCode;
      return three("Running", "Ran", "Couldn't run", CT.programOf(c.args.command) || "a command", c.args.command || "", { mono: true, exit: exit ? `exit ${exit}` : "" });
    },
    plural: (n) => ["Ran", `${n} commands`],
    foldDetail: (calls) => {
      const programs = [...new Set(calls.map((c) => CT.programOf(c.args.command) || "a command"))];
      return programs.length === 1 ? calls[calls.length - 1].args.command || "" : programs.join(", ");
    },
  };

  K.web = {
    icon: "search",
    words: (c) => three("Searching the web for", "Searched the web for", "Couldn't search the web for", quote(c.args.query), c.details?.results ? `${c.details.results.length} results` : ""),
    plural: (n) => ["Searched the web", `${n} times`],
  };

  K.xsearch = {
    icon: "search",
    words: (c) => three("Searching posts on X for", "Searched posts on X for", "Couldn't search posts on X for", quote(c.args.query)),
    plural: (n) => ["Searched posts on X", `${n} times`],
  };

  K.page = {
    icon: "web",
    words: (c) => three("Opening", "Opened", "Couldn't open", host(c.args.url), c.details?.title || ""),
    plural: (n) => ["Opened", `${n} pages`],
  };

  K.browser = {
    icon: "window",
    words: (c) => {
      const a = c.args.action;
      const r = c.args.request || {};
      const t = (run, done, object) => ({ ...three(run, done, "Couldn't use", object, c.page || (c.args.targetUrl ? host(c.args.targetUrl) : "")), fail: ["Couldn't use", "the browser"] });
      if (a === "open" || a === "navigate") return t("Opening", "Opened", host(c.args.targetUrl));
      if (a === "snapshot") return t("Reading", "Read", "the page");
      if (a === "screenshot") return t("Taking", "Took", "a screenshot");
      if (a === "act" && r.kind === "click") return t("Clicking", "Clicked", quote(r.text || r.ref));
      if (a === "act" && (r.kind === "type" || r.kind === "fill")) return t("Typing into", "Typed into", quote(r.element || r.ref));
      if (a === "upload") return t("Uploading", "Uploaded", "a file");
      if (a === "dialog") return t("Answering", "Answered", "a dialog");
      return t("Using", "Used", "the browser");
    },
    plural: (n) => ["Used the browser", `${n} actions`],
    foldDetail: (calls) => [...new Set(calls.map((c) => c.page || (c.args.targetUrl ? host(c.args.targetUrl) : "")).filter(Boolean))].join(", "),
  };

  K.computer = {
    icon: "screen",
    words: (c) => {
      const a = String(c.args.action || "");
      const what = c.name === "mobile_ui" ? "the phone" : "the computer";
      const t = (run, done, object) => ({ ...three(run, done, "Couldn't use", object, c.args.node || c.args.nodeId || ""), fail: ["Couldn't use", what] });
      if (c.name === "mobile_ui") return t("Using", "Used", "the phone");
      if (/screenshot/.test(a)) return t("Looking at", "Looked at", "the screen");
      if (/click/.test(a)) return t("Clicking on", "Clicked on", "the screen");
      if (/type/.test(a)) return t("Typing", "Typed", "");
      if (/key/.test(a)) return t("Pressing", "Pressed", c.args.text || "a key");
      if (/scroll/.test(a)) return t("Scrolling", "Scrolled", "");
      return t("Using", "Used", what);
    },
    plural: (n, calls) => [calls[0].name === "mobile_ui" ? "Used the phone" : "Used the computer", `${n} actions`],
  };

  // A routine's schedule in words, from the sample's own shape (open point 3).
  const weekdays = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
  const scheduleWords = (s) => {
    const m = /^(\d+) (\d+) \* \* (\d)$/.exec(s?.expr || "");
    if (!m) return s?.expr || "";
    const h = Number(m[2]);
    return `${weekdays[Number(m[3])]} at ${((h + 11) % 12) + 1}:${m[1].padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  };
  K.routine = {
    icon: "clock",
    words: (c) => {
      const name = c.args.job?.name || c.args.name || "";
      const when = scheduleWords(c.args.job?.schedule);
      switch (c.args.action) {
        case "add":
          return three("Creating routine", "Created routine", "Couldn't create routine", name, when);
        case "update":
          return name ? three("Changing routine", "Changed routine", "Couldn't change routine", name, when) : three("Changing", "Changed", "Couldn't change", "a routine", when);
        case "remove":
          return name ? three("Removing routine", "Removed routine", "Couldn't remove routine", name) : three("Removing", "Removed", "Couldn't remove", "a routine");
        case "run":
          return three("Running routine", "Ran routine", "Couldn't run routine", name);
        default:
          return three("Looking at", "Looked at", "Couldn't look at", "routines");
      }
    },
    plural: (n) => ["Looked at routines", `${n} times`],
  };

  K.tasks = {
    icon: "tasks",
    words: (c) => {
      if (c.name === "sessions_history") {
        const who = c.botName ? `${c.botName}'s task` : "a task";
        return three("Reading", "Read", "Couldn't read", who, c.taskTitle || "");
      }
      if (c.name === "sessions_search") return three("Searching tasks for", "Searched tasks for", "Couldn't search tasks for", quote(c.args.query));
      if (c.name === "agents_list") return three("Looking through", "Looked through", "Couldn't look through", "bots");
      if (c.name === "session_status") return three("Checking", "Checked", "Couldn't check", "this task");
      return three("Looking through", "Looked through", "Couldn't look through", "tasks", c.details?.count !== undefined ? `${c.details.count} tasks` : "");
    },
    plural: (n) => ["Looked through tasks", `${n} times`],
  };

  K.helper = {
    icon: "helpers",
    words: (c) => {
      if (c.name === "agents_wait") return three("Waiting for", "Waited for", "Couldn't wait for", `${(c.args.ids || []).length} helpers`);
      if (c.name === "subagents") {
        if (c.args.action === "kill") return three("Stopping", "Stopped", "Couldn't stop", "a helper", c.args.target || "");
        if (c.args.action === "steer") return three("Redirecting", "Redirected", "Couldn't redirect", "a helper", c.args.target || "");
        return three("Looking at", "Looked at", "Couldn't look at", "helpers");
      }
      return { run: ["Starting", "a helper"], done: ["Started a helper:", c.args.label || "untitled"], fail: ["Couldn't start", "a helper"], detail: firstWords(c.args.task, 8) };
    },
    plural: (n) => ["Used helpers", `${n} times`],
  };

  K.question = {
    icon: "question",
    words: (c) => three("Asking you", "Asked you", "Couldn't ask", "a question", c.args.questions?.[0]?.question || ""),
    plural: (n) => ["Asked you", `${n} questions`],
  };

  K.plan = {
    icon: "plan",
    words: (c) => {
      if (/goal/.test(c.name)) {
        const set = c.name === "create_goal";
        return { run: [set ? "Setting" : "Updating", set ? "a goal" : "the goal"], done: [set ? "Set" : "Updated", set ? "a goal" : "the goal"], fail: ["Couldn't save", "the goal"], detail: c.args.objective || c.args.status || "" };
      }
      const plan = c.args.plan || [];
      const done = plan.filter((s) => s.status === "done").length;
      const first = !c.update;
      return {
        run: [first ? "Making" : "Updating", first ? "a plan" : "the plan"],
        done: [first ? "Made" : "Updated", first ? "a plan" : "the plan"],
        fail: ["Couldn't save", "the plan"],
        detail: done ? `${done} of ${plan.length} done` : `${plan.length} steps`,
      };
    },
    plural: (n) => ["Updated the plan", `${n} times`],
    foldDetail: (calls) => K.plan.words(calls[calls.length - 1]).detail,
  };

  K.media = {
    icon: "image",
    words: (c) => {
      const n = Number(c.args.count || 1);
      const made = {
        image_generate: [n > 1 ? `${n} images` : "an image", "image"],
        video_generate: ["a video", "film"],
        music_generate: ["a track", "note"],
        tts: ["a voice clip", "wave"],
      }[c.name];
      if (made) return three("Making", "Made", "Couldn't make", made[0], firstWords(c.args.prompt || c.args.text), { icon: made[1] });
      return three("Looking at", "Looked at", "Couldn't look at", base(c.args.path || c.args.url));
    },
    plural: (n, calls) => {
      const what = { image_generate: "images", video_generate: "videos", music_generate: "tracks", tts: "voice clips" }[calls[0].name];
      return what ? ["Made", `${n} ${what}`] : ["Looked at", `${n} images`];
    },
  };

  K.channel = {
    icon: "message",
    words: (c) => {
      const ch = c.args.channel || "a channel";
      return { run: ["Sending a message on", ch], done: ["Messaged", c.args.to ? `${c.args.to} on ${ch}` : ch], fail: ["Couldn't send on", ch], detail: String(c.args.message || "").split("\n")[0] };
    },
    plural: (n) => ["Messaged on a channel", `${n} times`],
  };

  K.server = {
    icon: "plug",
    words: (c) => three("Using", "Used", "Couldn't use", c.mcp.server, CT.nameWords(c.mcp.tool)),
    plural: (n, calls) => [`Used ${calls[0].mcp.server}`, `${n} times`],
  };

  K.tool = {
    icon: "tool",
    words: (c) => three("Using", "Used", "Couldn't use", CT.nameWords(c.name), CT.generalDetail(c.args)),
    plural: (n, calls) => [`Used ${CT.nameWords(calls[0].name)}`, `${n} times`],
  };

  // T3 Code's listings: ordinary lines in its family (section 11.3).
  K.t3 = {
    icon: "t3",
    words: (c) => {
      const what = c.mcp.tool === "list_threads" ? "threads" : "projects";
      return three("Looking through", "Looked through", "Couldn't look through", `T3 Code ${what}`, c.text && !c.isError ? `${lines(c.text)} ${what}` : "");
    },
    plural: (n) => ["Looked through T3 Code", `${n} times`],
    foldDetail: () => "projects and threads",
  };

  CT.kinds = K;

  // The table: an exact tool name to a kind (section 8.1).
  const TABLE = {
    read: "read", pdf: "read",
    ls: "list",
    write: "edit", edit: "edit", apply_patch: "edit",
    memory_search: "recall", memory_get: "recall",
    exec: "command", bash: "command", terminal: "command", code_execution: "command",
    web_search: "web",
    x_search: "xsearch",
    web_fetch: "page",
    browser: "browser",
    computer: "computer", screen: "computer", mobile_ui: "computer",
    automations: "routine", cron: "routine",
    sessions_send: "message",
    sessions_list: "tasks", sessions_history: "tasks", sessions_search: "tasks", session_status: "tasks", agents_list: "tasks",
    sessions_spawn: "helper", agents_wait: "helper", subagents: "helper",
    ask_user: "question",
    progress_card: "plan", create_goal: "plan", update_goal: "plan", get_goal: "plan",
    image_generate: "media", video_generate: "media", music_generate: "media", tts: "media", view_image: "media", image: "media",
    message: "channel", conversations_send: "channel", conversations_turn: "channel",
  };
  CT.kindTable = TABLE;

  // T3 Code's own tools, as its tool server names them. The real names come from
  // T3 Code's tool list (open point 8); these are invented for the prototype.
  CT.t3Tools = { start_thread: "start", send_followup: "follow-up", read_result: "check", wait_for_result: "check", stop_thread: "stop", list_projects: "list", list_threads: "list" };

  // The kind of a call, and what it folds with. `mcp` is { server, tool } once
  // the result names them, or the gateway's name mapping does before it.
  CT.kindOf = (c) => {
    if (c.mcp) {
      const op = c.mcp.server === "t3code" && CT.t3Tools[c.mcp.tool];
      if (op === "list") return { kind: "t3", key: "t3:list", op };
      if (op) return { kind: "t3", key: `t3:${c.thread || c.id}`, op };
      return { kind: "server", key: `server:${c.mcp.server}:${c.mcp.tool}` };
    }
    if ((c.name === "write" || c.name === "edit") && isMemoryPath(c.args.path)) return { kind: "memory", key: "memory" };
    if (c.commandBearing) return { kind: "command", key: "command" };
    const kind = TABLE[c.name];
    if (kind === "routine") return { kind, key: ["list", "status", "runs"].includes(c.args.action) ? "routine:list" : `once:${c.id}` };
    if (["helper", "question", "channel", "message"].includes(kind)) return { kind, key: `once:${c.id}` };
    if (kind === "media") return { kind, key: `media:${c.name}` };
    if (kind === "computer") return { kind, key: `computer:${c.name === "mobile_ui" ? "phone" : "computer"}` };
    if (kind) return { kind, key: kind };
    // A tool-server call not yet identified never folds, so nothing moves when it is.
    if (c.name.includes("__")) return { kind: "tool", key: `once:${c.id}` };
    return { kind: "tool", key: `tool:${c.name}` };
  };

  // The parts of a card's line ----------------------------------------------------------

  const TENSE = { running: "run", review: "run", waiting: "run", done: "done", made: "done", failed: "fail", blocked: "done", denied: "run", stopped: "run", unknown: "run" };
  const running = (c) => ["running", "review"].includes(c.status);
  const iconOf = (name) => (name === "t3" ? CT.agentMark() : CT.icon(name));

  // The state at the right.
  const right = (c) => {
    if (c.lastSeen && running(c)) return `<span class="state">${CT.glyph("working")}Last seen running</span>`;
    switch (c.status) {
      case "running":
      case "review":
        return `<span class="action-elapsed">${esc(c.elapsed || "")}</span>`;
      case "waiting":
        return CT.state(c.readOnly ? "approval" : "waiting-you");
      case "failed":
        return `<span class="state" data-tone="danger">${CT.glyph("failed")}${esc(c.failWord || "Failed")}</span>`;
      case "blocked":
        return `<span class="state" data-tone="danger">${CT.glyph("failed")}Not run</span>`;
      case "denied":
        return `<span class="state">${CT.glyph("stopped")}${esc(c.deniedWord || "Denied")}</span>`;
      case "stopped":
        return `<span class="state">${CT.glyph("stopped")}Stopped</span>`;
      case "unknown":
        return CT.state("unknown");
      case "made":
        return CT.state("call-made");
      default:
        return `<time class="action-time">${esc(c.took || "")}</time>`;
    }
  };

  // The words of one call in its current state.
  CT.lineOf = (c) => {
    const { kind } = CT.kindOf(c);
    const w = K[kind].words(c);
    let [verb, object] = w[TENSE[c.status] || "done"];
    let detail = w.detail;
    let mono = Boolean(w.mono);
    if (c.status === "review") verb = "Reviewing";
    if (c.status === "stopped" || c.status === "unknown") verb = `Stopped ${verb.charAt(0).toLowerCase()}${verb.slice(1)}`;
    if (kind === "command" && c.status === "waiting") verb = "Wants to run";
    if (kind === "command" && c.status === "denied") verb = "Didn't run";
    if (c.status === "blocked") [verb, object] = [c.blockedBy === "review" ? "Blocked by review" : "Blocked by policy", ""];
    if (c.timedOut || c.cutOff) {
      [verb, object] = [c.timedOut ? "Timed out:" : "Cut off:", CT.programOf(c.args.command)];
      detail = c.timedOut ? `its ${c.args.timeoutSeconds || 120}s limit` : "the run's 50m limit";
      mono = false;
    }
    return { kind, icon: w.icon || K[kind].icon, verb, object, detail, mono, exit: c.status === "done" ? w.exit : "" };
  };

  // The summary of a card: verb, icon and object, detail, state, chevron.
  const summary = ({ verb, icon, object, detail, mono, exit, tone, state, spoken, title }) =>
    `<summary aria-label="${esc(spoken)}" title="${esc(title)}">` +
    `<span class="action-verb">${esc(verb)}</span>` +
    `<span class="action-what">${icon}${object ? `<span class="action-object">${esc(object)}</span>` : ""}</span>` +
    `<span class="action-detail"${tone ? ` data-tone="${tone}"` : ""}>` +
    (detail ? `<span${mono ? ' class="mono"' : ""}>${esc(detail)}</span>` : "") +
    (exit ? `<span class="action-exit">${esc(exit)}</span>` : "") +
    `</span>` +
    `<span class="action-state">${state}</span>${CT.icon("chevron", "icon chevron")}</summary>`;

  const spokenState = (c) =>
    ({ running: "running", review: "under review", waiting: "waiting for you", failed: c.failWord || "failed", blocked: "not run", denied: c.deniedWord || "denied", stopped: "stopped", unknown: "unknown", made: "call made" })[c.status] ||
    (c.took ? c.took.replace(/s$/, " seconds") : "done");

  CT.toolTitle = (name) => String(name).split(/[_\s.]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

  // The readable view of one call, by kind (section 8.1, last column).
  CT.readableOf = (c) => {
    const { kind } = CT.kindOf(c);
    const a = c.args || {};
    const rows = [];
    const add = (k, v, opts) => v !== undefined && v !== null && v !== "" && rows.push([k, String(v), opts]);
    let result = "";
    let label = "Result";
    switch (kind) {
      case "read":
        add("File", a.path, { mono: true, copy: true, what: "file path" });
        break;
      case "list":
        add("Folder", a.path, { mono: true });
        label = "Entries";
        break;
      case "edit": {
        add("File", a.path, { mono: true });
        const d = diffCount(c.details?.diff);
        if (c.details?.diff) add("Change", `${d.added} lines added, ${d.removed} removed`);
        label = "Added";
        result = c.details?.diff ? c.details.diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n") : "";
        break;
      }
      case "memory":
        add("Note", a.path, { mono: true });
        label = "Saved";
        result = a.content || "";
        break;
      case "recall":
        if (c.name === "memory_get") add("Note", a.path, { mono: true });
        else add("Query", a.query);
        label = c.name === "memory_get" ? "The note" : "Matches";
        break;
      case "command":
        add("Command", a.command || a.task, { mono: true, copy: true });
        add("Runs on", a.host || "the gateway's host");
        add("Folder", a.workdir || a.cwd, { mono: true });
        label = "Output";
        break;
      case "web":
      case "xsearch":
        add("Query", a.query);
        if (c.details?.results && !running(c)) {
          return (
            CT.fields(rows) +
            `<p class="code-label">Results</p><ul class="action-links">` +
            c.details.results.map((r) => `<li><a href="#" data-action="elsewhere" data-where="Opens ${esc(r.url)} in the system browser.">${esc(r.title)}</a><span>${esc(host(r.url))}</span></li>`).join("") +
            `</ul>`
          );
        }
        break;
      case "page":
        add("Address", a.url, { mono: true });
        add("Title", c.details?.title);
        label = "Text";
        break;
      case "browser":
      case "computer":
        add("Action", a.action + (a.request?.kind ? `, ${a.request.kind}` : ""));
        add("Target", a.targetUrl || a.request?.text || a.request?.element || a.request?.ref || (a.coordinate ? a.coordinate.join(", ") : ""));
        add("Typed", a.request?.kind === "type" ? a.request.text : a.action === "type" ? a.text : "");
        break;
      case "routine":
        add("Routine", a.job?.name || a.name);
        add("Schedule", a.job?.schedule ? `${scheduleWords(a.job.schedule)} (${a.job.schedule.expr})` : "");
        add("Does", a.job?.payload?.message);
        break;
      case "plan":
        if (a.plan) {
          return (
            `<ul class="action-plan">` +
            a.plan.map((s) => `<li data-done="${s.status === "done"}">${s.status === "done" ? CT.glyph("check") : '<span class="plan-dot" aria-hidden="true"></span>'}${esc(s.step)}</li>`).join("") +
            `</ul>`
          );
        }
        add("Objective", a.objective);
        break;
      case "media":
        add("Prompt", a.prompt || a.text);
        add("Model", a.model);
        if (c.files && !running(c)) return CT.fields(rows) + `<div class="chips">${c.files.map((f) => `<span class="chip">${CT.icon("file")}${esc(f)}</span>`).join("")}</div>`;
        break;
      case "channel":
        add("Channel", a.channel);
        add("To", a.to);
        add("Text", a.message);
        break;
      case "server":
        add("Server", c.mcp.server);
        add("Tool", CT.nameWords(c.mcp.tool));
        Object.entries(a).forEach(([k, v]) => add(k, typeof v === "string" ? v : json(v), { mono: typeof v !== "string" }));
        break;
      default:
        Object.entries(a).forEach(([k, v]) => add(k, typeof v === "string" ? v : json(v), { mono: typeof v !== "string" }));
        add("The gateway calls it", c.title || CT.toolTitle(c.name));
    }
    const text = result || (running(c) ? c.partial || "" : c.text || "");
    return (
      (rows.length ? CT.fields(rows) : "") +
      (text
        ? CT.codeBlock({ label: running(c) ? "Output so far" : c.isError ? "Error" : label, text, tone: c.isError ? "danger" : "", live: running(c), copy: running(c) ? "output" : c.isError ? "error" : label, truncated: c.cut || false })
        : running(c)
          ? CT.note("No output yet.")
          : "") +
      (kind === "command" && c.details?.exitCode !== undefined && !running(c) ? CT.fields([["Exit code", String(c.details.exitCode)]]) : "")
    );
  };

  // What the gateway sent for one call: section 9's parts.
  CT.rawOf = (c) => {
    const payload = (isError) => json({ content: [{ type: "text", text: c.text || "" }], ...(c.details ? { details: c.details } : {}), isError });
    const ended = !running(c) && c.status !== "waiting";
    return {
      tool: c.name,
      args: json(c.args),
      result: ended && !c.isError && c.status !== "blocked" ? payload(false) : "",
      error: ended && (c.isError || c.status === "blocked") ? payload(true) : "",
      running: !ended,
      timing: [["Started", c.started || "not reported"], ["Ended", ended ? c.ended || "not reported" : "not reported"], ["Took", ended && c.took ? c.took.replace(/s$/, " s") : "not reported"]],
      ids: [["Tool call", c.id], ["Item", `tool:${c.id}`], ["Run", c.run || "run_7f3a91c2"], ["Session", c.session || "agent:otto:weekly-backup-check"]],
    };
  };

  // The "Thought" line: inside a card, or over a reply. Its text only when opened.
  CT.thought = ({ id, time = "", text, open = false, place = "card", raw }) =>
    `<details class="thought" data-place="${place}"${id ? ` id="${id}"` : ""}${open ? " open" : ""}>` +
    `<summary class="event-line">Thought${time ? ` for ${esc(time)}` : ""}${CT.icon("chevron", "icon chevron")}</summary>` +
    `<div class="thought-body">${String(text)
      .split("\n\n")
      .map((p) => `<p class="step-thought">${esc(p)}</p>`)
      .join("")}` +
    (raw ? CT.cardFoot("", raw) : "") +
    `</div></details>`;

  CT.thoughtRaw = (text, run = "run_7f3a91c2") => ({
    events: [["Event (a sample in the app's own shape)", json({ stream: "thinking", runId: run, data: { text } })]],
    ids: [["Run", run], ["Session", "agent:otto:weekly-backup-check"]],
  });

  // The body of a card or row: the reasoning that led to it, then Readable and Raw.
  const bodyOf = (c, view) =>
    (c.thought ? `<div class="action-thought">${CT.thought({ time: c.thought.time, text: c.thought.text, open: c.thought.open, raw: CT.thoughtRaw(c.thought.text) })}</div>` : "") +
    (c.body || CT.stepBody({ readable: CT.readableOf(c), raw: CT.rawOf(c), view }));

  // One card for one call. opts: { open, view, fresh }.
  CT.actionCard = (c, { open = false, view = "readable", fresh = false } = {}) => {
    c = { status: "done", ...c };
    const line = CT.lineOf(c);
    const icon = running(c) ? CT.glyph("working") : iconOf(line.icon);
    const words = [line.verb, line.object].filter(Boolean).join(" ");
    const state = c.lastSeen && running(c) ? "last seen running" : spokenState(c);
    return (
      `<details class="card action" data-kind="${line.kind}" data-status="${c.status}" data-call="${esc(c.id)}" id="${esc(c.id)}" data-testid="tool-call"` +
      `${open ? " open" : ""}${fresh ? ' data-fresh="true"' : ""}>` +
      summary({
        ...line,
        icon,
        state: right(c),
        spoken: `${words}${line.detail ? `, ${line.detail}` : ""}${line.exit ? `, ${line.exit}` : ""}, ${state}`,
        title: `${words}${line.detail ? ` · ${line.detail}` : ""}`,
      }) +
      `<div class="action-body">${bodyOf(c, view)}</div></details>`
    );
  };

  // A row inside an opened fold: the shell's step row, in the singular.
  const ROW_STATUS = { done: "done", made: "done", running: "running", review: "running", waiting: "waiting", failed: "failed", blocked: "failed", denied: "skipped", stopped: "skipped", unknown: "skipped" };
  CT.foldRow = (c, { open = false, view = "readable", fresh = false } = {}) => {
    c = { status: "done", ...c };
    const line = CT.lineOf(c);
    const words = [line.verb, line.object].filter(Boolean).join(" ");
    const statusText =
      { failed: c.failWord || "Failed", blocked: "Not run", waiting: "Waiting for you", denied: c.deniedWord || "Denied", stopped: "Stopped", unknown: "Unknown", made: "Call made" }[c.status] ??
      (running(c) ? (c.lastSeen ? "Last seen running" : c.elapsed || "") : c.took || "");
    return CT.step({
      id: c.id,
      kind: line.icon === "t3" ? "code" : line.icon,
      status: ROW_STATUS[c.status],
      title: words,
      detail: line.detail ? `<span${line.mono ? ' class="mono"' : ""}>${esc(line.detail)}</span>` : "",
      statusText,
      open,
      fresh,
      body: bodyOf(c, view),
    }).replace("<details ", '<details data-testid="tool-call" ');
  };

  // A fold: several calls of one kind in a row, one line with a count.
  CT.foldCard = (calls, { open = false, rows = {}, fresh = false } = {}) => {
    calls = calls.map((c) => ({ status: "done", ...c }));
    const { kind } = CT.kindOf(calls[0]);
    const k = K[kind];
    const [verb, object] = k.plural(calls.length, calls);
    const live = calls.find(running);
    const waiting = calls.find((c) => c.status === "waiting");
    const failed = calls.filter((c) => c.status === "failed" || c.status === "blocked");
    const lower = (c) => {
      const l = CT.lineOf(c);
      return `${l.verb.charAt(0).toLowerCase()}${l.verb.slice(1)}${l.object ? ` ${l.object}` : ""}`;
    };
    let detail;
    let tone = "";
    let state;
    let status = "done";
    if (failed.length) {
      detail = lower(failed[0]);
      tone = "danger";
      state = `${live ? CT.glyph("working") : ""}<span class="state" data-tone="danger">${live ? "" : CT.glyph("failed")}${failed.length} failed</span>`;
      status = "failed";
    } else if (waiting) {
      detail = lower(waiting);
      state = CT.state("waiting-you");
      status = "waiting";
    } else if (live) {
      detail = lower(live);
      state = live.lastSeen ? `<span class="state">${CT.glyph("working")}Last seen running</span>` : `<span class="action-elapsed">${esc(live.elapsed || "")}</span>`;
      status = "running";
    } else {
      detail = k.foldDetail ? k.foldDetail(calls) : [...new Set(calls.map((c) => CT.lineOf(c).object))].join(", ");
      const total = calls.reduce((t, c) => t + (parseFloat(c.took) || 0), 0);
      state = `<time class="action-time">${total ? `${total < 10 ? total.toFixed(1) : Math.round(total)}s` : ""}</time>`;
    }
    const words = `${verb} ${object}`;
    const spoken = `${words}, ${detail}, ${failed.length ? `${failed.length} failed` : waiting ? "waiting for you" : live ? "running" : "done"}`;
    return (
      `<details class="card action" data-fold="${calls.length}" data-kind="${kind}" data-status="${status}"` +
      ` id="fold-${esc(calls[0].id)}" data-first="${esc(calls[0].id)}"${open ? " open" : ""}${fresh ? ' data-fresh="true"' : ""}>` +
      summary({ verb, icon: live && !failed.length ? CT.glyph("working") : iconOf(k.icon), object, detail, tone, state, spoken, title: `${words} · ${detail}` }) +
      `<div class="action-body"><ol class="fold-rows" aria-label="${esc(words)}">${calls.map((c) => CT.foldRow(c, rows[c.id] || {})).join("")}</ol></div></details>`
    );
  };

  // The run line: after everything the run put in the transcript.
  CT.runLine = ({ id, label, actions, failed = 0, model, effort, run, open = false }) =>
    `<details class="run-line"${id ? ` id="${id}"` : ""}${open ? " open" : ""}>` +
    `<summary class="event-line" title="${esc(`${model || "model not reported"} · ${effort ? `${effort} effort requested` : "effort not reported"}`)}">` +
    `<span class="run-label">${esc(label)}</span><span aria-hidden="true">·</span><span class="run-count">${actions} ${actions === 1 ? "action" : "actions"}</span>` +
    (failed ? `<span aria-hidden="true">·</span><span class="run-failed">${failed} failed</span>` : "") +
    `${CT.icon("chevron", "icon chevron")}</summary>` +
    `<p class="activity-foot">${CT.activityFoot({ model, effort, run })}</p></details>`;

  // The engine ---------------------------------------------------------------------------
  //
  // Places cards in order and folds them by the rule in section 7.4. `insert(html)`
  // adds markup where new transcript content goes and returns the first node.
  // Whether a card, a fold or a row is open, and in which view, is the viewer's,
  // and is kept through every update.

  CT.feed = ({ insert, follow = () => {}, instant = () => false }) => {
    const calls = new Map(); // id -> call
    const groups = []; // { key, ids, el }
    let column = null; // the last group, while nothing has come after it

    const viewOf = (el) => (el?.querySelector('[data-view-button="raw"]')?.getAttribute("aria-selected") === "true" ? "raw" : "readable");
    const keep = (el) => {
      if (!el) return null;
      const rows = {};
      el.querySelectorAll(".fold-rows > li > .step").forEach((r) => (rows[r.id] = { open: r.open, view: viewOf(r) }));
      return { open: el.open, view: viewOf(el.querySelector(":scope > .action-body")), rows, focus: el.contains(document.activeElement), fold: el.dataset.fold !== undefined };
    };

    const render = (group, fresh) => {
      const list = group.ids.map((id) => calls.get(id));
      const kept = keep(group.el);
      let html;
      if (list.length === 1) {
        html = CT.actionCard(list[0], { open: kept?.open, view: kept?.view, fresh });
      } else {
        // Becoming a fold: an open card opens the fold with its first row open, in its view.
        const rows = { ...(kept?.rows || {}) };
        if (kept && !kept.fold) rows[list[0].id] = { open: kept.open, view: kept.view };
        const added = list[list.length - 1].id;
        if (fresh && rows[added] === undefined) rows[added] = { fresh: true };
        html = CT.foldCard(list, { open: kept?.open, rows });
      }
      if (group.el) {
        const holder = document.createElement("div");
        holder.innerHTML = html;
        const next = holder.firstElementChild;
        group.el.replaceWith(next);
        if (kept?.focus) next.querySelector("summary")?.focus({ preventScroll: true });
        group.el = next;
      } else {
        group.el = insert(instant() ? html.replace(' data-fresh="true"', "") : html);
      }
      follow();
      return group.el;
    };
    const groupOf = (id) => groups.find((g) => g.ids.includes(id));

    return {
      calls,
      // A call started, or arrived from history with its state.
      start(call) {
        calls.set(call.id, { status: "running", ...call });
        const { key } = CT.kindOf(call);
        if (column && column.key === key && !key.startsWith("once:")) {
          column.ids.push(call.id);
          return render(column, true);
        }
        column = { key, ids: [call.id], el: null };
        groups.push(column);
        return render(column, true);
      },
      // The call changed: a result, an error, a wait. `patch` is merged into it.
      update(id, patch) {
        calls.set(id, { ...calls.get(id), ...patch });
        const group = groupOf(id);
        if (group) render(group, false);
        return group?.el;
      },
      // Something shown between cards: a bubble, a request card, a note. It ends the column.
      gap() {
        column = null;
      },
      get: (id) => calls.get(id),
      elementOf: (id) => groupOf(id)?.el,
      all: () => [...calls.values()],
    };
  };
})();
