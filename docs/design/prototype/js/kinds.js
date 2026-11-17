// Action cards: from a tool call to a plain-words card (conversation.md, sections 7, 8 and 11).
//
// This file is the prototype of the one mapping the core will hold
// (packages/core/src/actions.ts): a tool's name, its arguments and its result
// give a kind, a fold key, an outcome and the parts of the card's line. Nothing
// in a tool event names the kind, so it is chosen here from the name, by the
// table in section 8.1, and each kind reads its result through an adapter: a
// result without an error flag is not, by itself, proof that the work was done.
// The words are English here; in the app they are strings in the interface
// package, and the core returns only data.
//
// A call, as the prototype's fixtures give it, in the gateway's own shapes:
//   { id, name, args, text, details, isError, started, ended, took, status }
// status, while open: running, review, waiting; once settled by an event:
//   done (a result arrived; the adapter decides the outcome), failed, blocked,
//   denied, stopped, unknown.
// mcp: { server, tool } once the result names them (details.mcpServer, mcpTool);
// nameMap: { server, tool } when the gateway's name mapping gives them before it.
//
// Markup:  CT.actionCard, CT.foldCard, CT.t3Thread, CT.t3Line, CT.thought, CT.runLine
// Engine:  CT.feed({ insert }) places cards in order, folds them, and gathers
//          T3 Code calls into one card per thread.

(function () {
  const CT = window.CT;
  const esc = CT.esc;
  const json = (value) => JSON.stringify(value, null, 2);

  // Small helpers --------------------------------------------------------------------

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
  const lower = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // The program a command runs: its first word that is not an assignment or a wrapper.
  CT.programOf = (command) => {
    const words = String(command || "").trim().split(/\s+/);
    const word = words.find((w) => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && !["sudo", "env", "nohup", "time"].includes(w));
    return word && /^[\w./-]+$/.test(word) ? base(word) : "";
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

  const diffCount = (diff) => {
    const rows = String(diff || "").split("\n");
    return { added: rows.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length, removed: rows.filter((l) => l.startsWith("-") && !l.startsWith("---")).length };
  };
  const diffText = ({ added, removed }) => `+${added} −${removed}`;

  // A path is memory when, inside the workspace, it is MEMORY.md or under memory/ (8.2).
  CT.workspaceRoot = "/home/bot/workspace";
  const relative = (path) => {
    let p = String(path || "").replace(/^\.\//, "");
    if (p.startsWith("/")) p = p.startsWith(`${CT.workspaceRoot}/`) ? p.slice(CT.workspaceRoot.length + 1) : null;
    return p;
  };
  const isMemoryPath = (path) => {
    const p = relative(path);
    return p !== null && (p === "MEMORY.md" || p.startsWith("memory/"));
  };

  // The files a call acts on: its path, or the files a patch names (8.2).
  CT.filesOf = (c) => {
    if (c.name === "apply_patch") return [...String(c.args.input || "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((m) => (m[1] || m[2]).trim());
    if (c.name === "pdf") return c.args.pdfs || (c.args.pdf ? [c.args.pdf] : []);
    if (c.name === "view_image") return c.args.paths || [c.args.path].filter(Boolean);
    return c.args.path ? [c.args.path] : [];
  };

  // T3 Code's structured content: from details, or in history from the gateway's
  // rendering of it at the start of the result text ("structuredContent:\n{…}").
  CT.structured = (c) => {
    if (c.details?.structuredContent) return c.details.structuredContent;
    const m = /^structuredContent:\n(\{[\s\S]*?\})(?:\n\n|$)/.exec(String(c.text || ""));
    try {
      return m ? JSON.parse(m[1]) : null;
    } catch {
      return null;
    }
  };

  // Kinds -------------------------------------------------------------------------------
  //
  // words(c): { run, done, fail: [verb, object], noun?, started?, queued?, suppressed?,
  //             detail, mono, exit, icon? }
  // outcome(c): for a result without an error flag, one of done, partial, started,
  //             queued, made, unconfirmed, suppressed, unavailable, with an optional word.
  // leaves: the effect leaves the gateway, so an open call shows "Call started".

  const three = (run, done, fail, object, detail = "", more = {}) => ({ run: [run, object], done: [done, object], fail: [fail, object], detail, ...more });
  const K = {};

  const fileCount = (calls, verb, action) => {
    const files = calls.map(CT.filesOf);
    if (files.some((f) => !f.length)) return [{ edits: "Made" }[action] || verb, plural(calls.length, action.replace(/s$/, ""), action)];
    const distinct = new Set(files.flat()).size;
    const label = plural(distinct, "file", "files");
    return calls.length > distinct ? [verb, `${label} · ${plural(calls.length, action.replace(/s$/, ""), action)}`] : [verb, label];
  };

  K.read = {
    icon: "read",
    words: (c) => three("Reading", "Read", "Couldn't read", base(c.args.path), c.text && !c.isError ? `${lines(c.text)} lines` : ""),
    plural: (n, calls) => fileCount(calls, "Read", "reads"),
  };

  K.list = {
    icon: "list",
    words: (c) => three("Looking in", "Looked in", "Couldn't open", base(c.args.path)),
    plural: (n) => ["Looked in", `${n} folders`],
  };

  K.edit = {
    icon: "write",
    words: (c) => {
      const files = CT.filesOf(c);
      const o = files.length === 1 ? base(files[0]) : files.length ? `${files.length} files` : "a patch";
      const patch = c.name === "apply_patch";
      return {
        run: [patch && !files.length ? "Applying" : "Editing", o],
        done: [patch && !files.length ? "Applied" : c.details?.created ? "Created" : "Edited", o],
        fail: ["Couldn't edit", o],
        detail: c.details?.diff ? diffText(diffCount(c.details.diff)) : "",
      };
    },
    outcome: (c) => (c.details?.changed === false ? "unchanged" : c.name === "apply_patch" || c.details?.changed || c.details?.diff ? "done" : "made"),
    neutral: () => "File edits",
    plural: (n, calls) => fileCount(calls, "Edited", "edits"),
    foldDetail: (calls) => diffText(calls.reduce((t, c) => ((d) => ({ added: t.added + d.added, removed: t.removed + d.removed }))(diffCount(c.details?.diff)), { added: 0, removed: 0 })),
  };

  K.memory = {
    icon: "memory",
    words: (c) => three("Saving to", "Saved to", "Couldn't save to", "memory", c.name === "write" ? firstWords(c.args.content) : c.details?.diff ? diffText(diffCount(c.details.diff)) : ""),
    outcome: (c) => (c.details?.changed === false ? "unchanged" : c.details?.changed || c.details?.diff ? "done" : "made"),
    neutral: () => "Memory notes",
    foldDetail: (calls) => [...new Set(calls.map((c) => base(c.args.path)))].join(", "),
    // Notes are counted once, by their path; more writes than notes are said as times.
    plural: (n, calls) => {
      const notes = new Set(calls.map((c) => relative(c.args.path))).size;
      return ["Saved", `${plural(notes, "note", "notes")} to memory${n > notes ? ` · ${n} times` : ""}`];
    },
  };

  K.recall = {
    icon: "recall",
    words: (c) =>
      c.name === "memory_get"
        ? { ...three("Reading a note from memory:", "Read from memory:", "Couldn't read from memory:", base(c.args.path)), notfound: ["Found no note", `${base(c.args.path)} in memory`] }
        : three("Searching memory for", "Searched memory for", "Couldn't search memory for", quote(c.args.query), Array.isArray(c.details?.results) && !c.details.unavailable ? `${plural(c.details.results.length, "match", "matches")}${c.details.staleness?.warning ? " · may be out of date" : ""}` : ""),
    outcome: (c) => {
      // A read says status ok, not_found or error, with the code and error (memory-tool contract).
      if (c.name === "memory_get") return c.details?.status === "ok" ? "done" : c.details?.status === "not_found" ? "notfound" : c.details?.status === "error" ? "failed" : "made";
      if (c.details?.unavailable || c.details?.disabled) return "unavailable";
      if (c.details?.partial) return "partial";
      return Array.isArray(c.details?.results) ? "done" : "made";
    },
    neutral: (calls) => (calls[0].name === "memory_get" ? "Memory reads" : "Memory search"),
    plural: (n, calls) => [calls[0].name === "memory_get" ? "Read from memory" : "Searched memory", `${n} times`],
  };

  K.command = {
    icon: "command",
    words: (c) => {
      if (c.name === "code_execution") return three("Running", "Ran", "Couldn't run", "code", c.args.task || "");
      const exit = c.details?.exitCode;
      return three("Running", "Ran", "Couldn't run", CT.programOf(c.args.command) || "a command", c.args.command || "", { mono: true, exit: exit ? `exit ${exit}` : "" });
    },
    outcome: (c) => (c.details?.status === "approval-pending" ? "waiting" : c.name === "code_execution" ? (c.text ? "done" : "made") : c.details?.exitCode !== undefined ? "done" : "made"),
    neutral: () => "Commands",
    plural: (n) => ["Ran", `${n} commands`],
    foldDetail: (calls) => {
      const programs = [...new Set(calls.map((c) => CT.programOf(c.args.command) || "a command"))];
      return programs.length === 1 ? calls[calls.length - 1].args.command || "" : programs.join(", ");
    },
  };

  K.terminal = {
    icon: "command",
    words: (c) => {
      const id = c.args.sessionId || "";
      return (
        {
          list: three("Looking at", "Looked at", "Couldn't look at", "shared terminals"),
          read: three("Reading", "Read", "Couldn't read", "a terminal", id),
          resize: three("Resizing", "Resized", "Couldn't resize", "a terminal", id),
          close: three("Closing", "Closed", "Couldn't close", "a terminal", id),
          input: three("Typing into", "Typed into", "Couldn't type into", "a terminal", id),
        }[c.args.action] || three("Using", "Used", "Couldn't use", "a shared terminal", id)
      );
    },
    plural: (n, calls) => [`${CT.lineOf({ ...calls[0], status: "done" }).verb} ${CT.lineOf({ ...calls[0], status: "done" }).object}`, `${n} times`],
  };

  K.web = {
    icon: "search",
    words: (c) => three("Searching the web for", "Searched the web for", "Couldn't search the web for", quote(c.args.query), Array.isArray(c.details?.results) ? plural(c.details.results.length, "result", "results") : ""),
    outcome: (c) => (Array.isArray(c.details?.results) ? "done" : c.details?.error ? "unavailable" : "made"),
    plural: (n) => ["Searched the web", `${n} times`],
  };

  K.xsearch = {
    icon: "search",
    words: (c) => three("Searching posts on X for", "Searched posts on X for", "Couldn't search posts on X for", quote(c.args.query), Array.isArray(c.details?.citations) ? plural(c.details.citations.length, "source", "sources") : ""),
    outcome: (c) => (c.details?.error ? "unavailable" : c.text || c.details?.content ? "done" : "made"),
    plural: (n) => ["Searched posts on X", `${n} times`],
  };

  // The gateway wraps fetched text in markers of its own; the title is shown without them.
  CT.unwrapExternal = (t) => String(t || "").replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>\s*|\s*<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, "").trim();
  K.page = {
    icon: "web",
    words: (c) => {
      const status = c.details?.status;
      const title = CT.unwrapExternal(c.details?.title);
      return three("Opening", "Opened", "Couldn't open", host(c.args.url), status >= 400 ? `HTTP ${status}${title ? ` · ${title}` : ""}` : title);
    },
    outcome: (c) => (c.details?.text || c.text ? (c.details?.truncated ? "partial" : "done") : "unavailable"),
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
      if (a === "act" && r.kind === "click") return t("Clicking", "Clicked", r.element ? quote(r.element) : r.text ? quote(r.text) : "an element");
      if (a === "act" && (r.kind === "type" || r.kind === "fill")) return t("Typing into", "Typed into", r.element ? quote(r.element) : "a field");
      if (a === "upload") return t("Uploading", "Uploaded", "a file");
      if (a === "dialog") return t("Answering", "Answered", "a dialog");
      return t("Using", "Used", "the browser");
    },
    plural: (n) => ["Used the browser", `${n} actions`],
    foldDetail: (calls) => [...new Set(calls.map((c) => c.page || (c.args.targetUrl ? host(c.args.targetUrl) : "")).filter(Boolean))].join(", "),
  };

  const OBSERVE = ["screenshot", "wait", "list_windows", "get_window_state", "get_accessibility_tree"];
  K.computer = {
    icon: "screen",
    words: (c) => {
      const a = String(c.args.action || "");
      const t = (run, done, object) => ({ ...three(run, done, "Couldn't use", object, c.args.node || ""), fail: ["Couldn't use", "the computer"] });
      if (OBSERVE.includes(a)) return t("Looking at", "Looked at", "the screen");
      if (/^(double|triple)_click$/.test(a)) return t("Double-clicking on", "Double-clicked on", "the screen");
      if (/_click$/.test(a)) return t("Clicking on", "Clicked on", "the screen");
      if (/drag/.test(a)) return t("Dragging on", "Dragged on", "the screen");
      if (a === "type") return t("Typing", "Typed", "");
      if (a === "key" || a === "hold_key") return t("Pressing", "Pressed", c.args.text || "a key");
      if (a === "scroll") return t("Scrolling", "Scrolled", "");
      if (a === "take_control") return t("Handing you", "Handed you", "the computer");
      return t("Using", "Used", "the computer");
    },
    // A mutation's metadata is projected into details.result: ok, and effect when the
    // computer reports one (confirmed, unverifiable, suspected_noop).
    outcome: (c) => {
      if (OBSERVE.includes(c.args.action)) return "done";
      const r = c.details?.result || {};
      if (r.ok === false) return "failed";
      return r.effect === "confirmed" ? "done" : r.effect === "unverifiable" || r.effect === "suspected_noop" ? "unconfirmed" : "made";
    },
    plural: (n) => ["Used the computer", `${n} actions`],
  };

  K.phone = {
    icon: "screen",
    // [running, done, base] for each act: the base form says what was not done.
    words: (c) => {
      const m = c.args.mobileAction || {};
      const [run, done, base, object] =
        c.args.action === "observe"
          ? ["Looking at", "Looked at", "Look at", "the phone"]
          : m.type === "tap" || m.type === "activate"
            ? ["Tapping on", "Tapped on", "Tap on", "the phone"]
            : m.type === "set_text"
              ? ["Entering text on", "Entered text on", "Enter text on", "the phone"]
              : m.type === "swipe" || m.type === "scroll"
                ? ["Swiping on", "Swiped on", "Swipe on", "the phone"]
                : m.type === "global_action"
                  ? ["Pressing", "Pressed", "Press", CT.nameWords(m.name || "a button").replace(/^./, (x) => x.toUpperCase())]
                  : m.type === "wait"
                    ? ["Waiting on", "Waited on", "Wait on", "the phone"]
                    : ["Using", "Used", "Use", "the phone"];
      return { ...three(run, done, "Couldn't use", object, c.args.node || ""), fail: ["Couldn't use", "the phone"], noun: [base, object], refused: ["Didn't " + lower(base), object] };
    },
    // observe gives a snapshot. An act that ran gives the device's outcome code, which the
    // gateway does not fix (open point 7): Call made with the code. confirmation_required
    // and the re-observe codes mean nothing was done.
    outcome: (c) => {
      if (c.args.action === "observe") return c.details?.snapshotId ? "done" : "made";
      if (c.details?.code === "confirmation_required") return { outcome: "refused", word: "Needs confirmation" };
      const code = c.details?.outcome?.code;
      if (["target_stale", "target_not_found", "secure_content", "package_changed"].includes(code)) return { outcome: "refused", word: CT.nameWords(code).replace(/^./, (x) => x.toUpperCase()) };
      return { outcome: "made", word: code ? CT.nameWords(code).replace(/^./, (x) => x.toUpperCase()) : "Call made" };
    },
    neutral: () => "Phone",
    plural: (n) => ["Used the phone", `${n} actions`],
  };

  K.screen = {
    icon: "window",
    words: (c) => three("Changing", "Changed", "Couldn't change", "the Control UI", CT.nameWords(c.args.action || "").replace(/^(\w+) (show|hide)$/, (m, what, how) => `${what} ${how === "show" ? "shown" : "hidden"}`)),
    plural: (n) => ["Changed the Control UI", `${n} times`],
  };

  // A routine's schedule in words (8.2): its time zone is always said.
  const weekdays = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
  CT.scheduleWords = (s) => {
    if (!s) return "";
    const zone = s.tz ? `, ${s.tz}` : ", gateway's time";
    if (s.kind === "every" && s.everyMs) {
      const h = s.everyMs / 3600000;
      return `every ${h >= 1 ? plural(Math.round(h), "hour", "hours") : plural(Math.round(s.everyMs / 60000), "minute", "minutes")}`;
    }
    if (s.kind === "at" && s.at) return `${new Date(s.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}${zone}`;
    const m = /^(\d+) (\d+) \* \* (\d|\*)$/.exec(s.expr || "");
    if (!m) return `${s.expr || ""}${zone}`;
    const h = Number(m[2]);
    const at = `${((h + 11) % 12) + 1}:${m[1].padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
    return `${m[3] === "*" ? "Every day" : weekdays[Number(m[3])]} at ${at}${zone}`;
  };
  K.routine = {
    icon: "clock",
    words: (c) => {
      const name = c.args.job?.name || c.args.name || "";
      const when = CT.scheduleWords(c.args.job?.schedule);
      switch (c.args.action) {
        case "add":
          return three("Creating routine", "Created routine", "Couldn't create routine", name, when);
        case "update":
          return name ? three("Changing routine", "Changed routine", "Couldn't change routine", name, when) : three("Changing", "Changed", "Couldn't change", "a routine", when);
        case "remove":
          return { ...(name ? three("Removing routine", "Removed routine", "Couldn't remove routine", name) : three("Removing", "Removed", "Couldn't remove", "a routine")), notfound: ["Found no routine", `${name || ""} to remove`.trim()] };
        case "run":
          return { ...three("Running routine", "Ran routine", "Couldn't run routine", name || "a routine"), queued: ["Asked routine", `${name || "a routine"} to run`] };
        case "next_check": {
          const ms = c.details?.delayMs;
          const when = ms ? (ms >= 3600000 ? `${Math.round(ms / 3600000)}h` : `${Math.round(ms / 60000)}m`) : c.args.in || "";
          return three("Proposing", "Proposed", "Couldn't propose", `the next check${when ? ` in ${when}` : ""}`);
        }
        case "wake":
          return three("Waking", "Woke", "Couldn't wake", "the scheduler");
        default:
          return three("Looking at", "Looked at", "Couldn't look at", "routines");
      }
    },
    outcome: (c) => {
      const d = c.details || {};
      if (c.args.action === "run") return d.run ? "done" : d.enqueued ? "queued" : "made";
      // Removal is established by the deletion result, not by a job.
      if (c.args.action === "remove") return d.removed === true ? "done" : d.removed === false ? "notfound" : "made";
      if (c.args.action === "next_check") return d.ok === true && d.delayMs ? "done" : "made";
      if (c.args.action === "add" || c.args.action === "update") return d.id ? "done" : "made";
      return "done";
    },
    neutral: () => "Routine look-ups",
    plural: (n) => ["Looked at routines", `${n} times`],
  };

  K.tasks = {
    icon: "tasks",
    words: (c) => {
      if (c.name === "sessions_history") return three("Reading", "Read", "Couldn't read", c.botName ? `${c.botName}'s task` : "a task", c.taskTitle || "");
      if (c.name === "sessions_search") return three("Searching tasks for", "Searched tasks for", "Couldn't search tasks for", quote(c.args.query));
      if (c.name === "agents_list") return three("Looking through", "Looked through", "Couldn't look through", "bots");
      if (c.name === "session_status") return three("Checking", "Checked", "Couldn't check", "this task's status");
      return three("Looking through", "Looked through", "Couldn't look through", "tasks", c.details?.count !== undefined ? plural(c.details.count, "task", "tasks") : "");
    },
    plural: (n, calls) => {
      const l = CT.lineOf({ ...calls[0], status: "done" });
      return [`${l.verb} ${l.object}`, `${n} times`];
    },
  };

  K.helper = {
    icon: "helpers",
    leaves: true,
    words: (c) => {
      if (c.name === "agents_wait") return { ...three("Waiting for", "Waited for", "Couldn't wait for", plural((c.args.ids || []).length, "helper", "helpers")), noun: ["Wait for", plural((c.args.ids || []).length, "helper", "helpers")] };
      if (c.name === "subagents") {
        if (c.args.action === "kill") return { ...three("Stopping", "Asked to stop", "Couldn't stop", "a helper", c.args.target || ""), noun: ["Stop for", "a helper"] };
        if (c.args.action === "steer") return { ...three("Redirecting", "Redirected", "Couldn't redirect", "a helper", c.args.target || ""), noun: ["Redirect for", "a helper"] };
        return three("Looking at", "Looked at", "Couldn't look at", "helpers");
      }
      const label = c.args.label || "";
      return { ...three("Starting", "Started a helper:", "Couldn't start", label || "a helper", firstWords(c.args.task, 8)), noun: ["Helper", label || "for a task"], started: ["Started a helper:", label || "untitled"], refused: ["Didn't start a helper:", label || "untitled"] };
    },
    outcome: (c) => {
      if (c.name === "sessions_spawn") {
        const s = c.details?.status;
        return s === "accepted" ? "started" : s === "forbidden" ? { outcome: "refused", word: "Not run" } : s === "error" ? "failed" : "made";
      }
      return c.name === "subagents" && c.args.action === "list" ? "done" : "made";
    },
    plural: (n) => ["Used helpers", `${n} times`],
  };

  K.question = {
    icon: "question",
    words: (c) => three("Asking you", "Asked you", "Couldn't ask", "a question", c.args.questions?.[0]?.question || ""),
    outcome: (c) => (c.details?.status === "answered" ? { outcome: "done", word: "Answered" } : c.details?.status ? { outcome: "made", word: CT.nameWords(c.details.status).replace(/^./, (x) => x.toUpperCase()) } : "made"),
    plural: (n) => ["Asked you", `${n} questions`],
  };

  K.plan = {
    icon: "plan",
    words: (c) => {
      if (c.name === "create_goal") return three("Setting", "Set", "Couldn't set", "a goal", c.args.objective || "");
      if (c.name === "update_goal") return three("Marking", "Marked", "Couldn't mark", `the goal ${c.args.status || ""}`.trim());
      if (c.name === "get_goal") return three("Checking", "Checked", "Couldn't check", "the goal");
      const steps = c.args.plan || [];
      const done = steps.filter((s) => s.status === "completed").length;
      const first = !c.update;
      return three(first ? "Making" : "Saving", first ? "Made" : "Saved", "Couldn't save", first ? "a plan" : "the plan", done ? `${done} of ${steps.length} done` : `${steps.length} steps`);
    },
    plural: (n, calls) => (calls[0].name === "progress_card" ? ["Saved the plan", `${n} times`] : [`${CT.lineOf({ ...calls[0], status: "done" }).verb} ${CT.lineOf({ ...calls[0], status: "done" }).object}`, `${n} times`]),
    foldDetail: (calls) => K.plan.words(calls[calls.length - 1]).detail,
  };

  const MEDIA = {
    image_generate: ["image", "images", "image"],
    video_generate: ["video", "videos", "film"],
    music_generate: ["track", "tracks", "note"],
  };
  K.media = {
    icon: "image",
    leaves: true,
    words: (c) => {
      if (c.name === "tts") return { ...three("Making", "Made", "Couldn't make", "a voice clip", firstWords(c.args.text)), noun: ["Voice clip", ""], icon: "wave" };
      const [one, many, icon] = MEDIA[c.name];
      if (c.args.action === "list") return { ...three("Looking at", "Looked at", "Couldn't look at", `${one} models`), icon };
      if (c.args.action === "status") return { ...three("Checking", "Checked", "Couldn't check", `${one} generation`), icon };
      const made = c.details?.paths?.length || c.details?.count;
      return {
        ...three("Making", "Made", "Couldn't make", made > 1 ? `${made} ${many}` : `${/^[aeiou]/.test(one) ? "an" : "a"} ${one}`, firstWords(c.args.prompt)),
        noun: [one[0].toUpperCase() + one.slice(1), ""],
        started: ["Started making", c.args.count > 1 ? `${c.args.count} ${many}` : `${/^[aeiou]/.test(one) ? "an" : "a"} ${one}`],
        icon,
      };
    },
    outcome: (c) => {
      if (c.args.action === "list" || c.args.action === "status") return "done";
      if (c.details?.async && c.details?.status === "started") return "started";
      if (c.name === "tts") return c.details?.audioPath ? "done" : "made";
      return c.details?.media || c.details?.paths ? "done" : "made";
    },
    // Each operation has its own plural: listing models or checking a task is not making media.
    plural: (n, calls) => {
      if (calls[0].name === "tts") return ["Made", `${n} voice clips`];
      const [one, many] = MEDIA[calls[0].name];
      if (calls[0].args.action === "list") return ["Looked at", `${one} models · ${n} times`];
      if (calls[0].args.action === "status") return ["Checked", `${one} generation · ${n} times`];
      const made = calls.reduce((t, c) => t + (c.details?.paths?.length || c.details?.count || 0), 0);
      return ["Made", made ? `${made} ${made === 1 ? one : many}` : `${many} · ${n} times`];
    },
    foldDetail: (calls) => (calls[0].args.action === "list" || calls[0].args.action === "status" ? "" : [...new Set(calls.map((c) => firstWords(c.args.prompt || c.args.text, 4)))].join(", ")),
    startedPlural: (n, calls) => ["Started making", `${MEDIA[calls[0].name]?.[1] || "voice clips"} · ${n} times`],
    neutral: (calls) => (calls[0].name === "tts" ? "Speech" : `${MEDIA[calls[0].name][0][0].toUpperCase()}${MEDIA[calls[0].name][0].slice(1)} ${calls[0].args.action === "list" ? "models" : calls[0].args.action === "status" ? "status" : "generation"}`),
  };

  K.look = {
    icon: "read",
    words: (c) => {
      const files = CT.filesOf(c);
      const pdf = c.name === "pdf";
      const o = files.length > 1 ? `${files.length} ${pdf ? "PDFs" : "images"}` : base(files[0]);
      return pdf ? three("Reading", "Read", "Couldn't read", o, c.args.pages ? `pages ${c.args.pages}` : firstWords(c.args.prompt)) : three("Looking at", "Looked at", "Couldn't look at", o, firstWords(c.args.prompt));
    },
    // Documents and images are counted once each; more calls than objects are said as times.
    plural: (n, calls) => {
      const pdf = calls[0].name === "pdf";
      const objects = calls.map(CT.filesOf);
      if (objects.some((f) => !f.length)) return [pdf ? "Read PDFs" : "Looked at images", `${n} times`];
      const k = new Set(objects.flat()).size;
      const label = pdf ? plural(k, "PDF", "PDFs") : plural(k, "image", "images");
      return [pdf ? "Read" : "Looked at", n > 1 && objects.flat().length > k ? `${label} · ${n} times` : label];
    },
    neutral: (calls) => (calls[0].name === "pdf" ? "PDF reading" : "Image viewing"),
    foldDetail: (calls) => [...new Set(calls.flatMap(CT.filesOf).map(base))].join(", "),
  };

  K.channel = {
    icon: "message",
    leaves: true,
    words: (c) => {
      const object = c.details?.channel || c.args.channel || "a conversation";
      const to = c.args.to || c.args.target;
      const detail = `${to ? `to ${to}: ` : ""}${String(c.args.message || "").split("\n")[0]}`;
      return { ...three("Sending", "Message on", "Couldn't send on", object, detail), noun: ["Message on", object], suppressed: ["Didn't send a message on", object] };
    },
    // conversations_send/turn: the published result status; message: no published result.
    outcome: (c) => {
      const s = c.details?.status;
      if (c.name === "message") return "made";
      if (s === "sent") return { outcome: "done", word: "Sent" };
      if (s === "replied") return { outcome: "done", word: "Replied" };
      if (s === "queued") return "queued";
      if (s === "suppressed") return "suppressed";
      if (s === "timeout") return { outcome: "made", word: "No reply in time" };
      return "made";
    },
    plural: (n) => ["Messaged on a channel", `${n} times`],
  };

  K.server = {
    icon: "plug",
    leaves: true,
    words: (c) => ({ ...three("Using", "Used", "Couldn't use", c.mcp.server, CT.nameWords(c.mcp.tool)), noun: ["Tool server", c.mcp.server] }),
    outcome: (c) => (c.details?.status === "blocked" ? "blocked" : ["aborted", "cancelled"].includes(c.details?.status) ? "unknown" : "done"),
    plural: (n, calls) => [`Used ${calls[0].mcp.server}`, `${n} times`],
  };

  K.t3list = {
    icon: "t3",
    words: (c) => {
      const sc = CT.structured(c) || {};
      const what = c.mcp?.tool === "t3_thread_list" ? "threads" : "projects";
      const n = (sc[what] || []).length;
      return three("Looking through", "Looked through", "Couldn't look through", `T3 Code ${what}`, n ? plural(n, what.slice(0, -1), what) : "");
    },
    plural: (n) => ["Looked through T3 Code", `${n} times`],
    foldDetail: () => "projects and threads",
  };

  K.tool = {
    icon: "tool",
    neutral: (calls) => CT.nameWords(calls[0].name).replace(/^./, (x) => x.toUpperCase()),
    words: (c) => three("Using", "Used", "Couldn't use", CT.nameWords(c.name), CT.generalDetail(c.args)),
    outcome: (c) => CT.payloadOutcome(c) || "done",
    plural: (n, calls) => [`Used ${CT.nameWords(calls[0].name)}`, `${n} times`],
  };

  // Each kind's neutral noun: the operation, claiming no outcome (7.4).
  const NEUTRAL = { read: "File reads", list: "Folder listings", web: "Web search", xsearch: "Search on X", page: "Page fetches", browser: "Browser actions", computer: "Computer actions", screen: "Control UI changes", terminal: "Terminal actions", tasks: "Task look-ups", plan: "Plan updates", t3list: "T3 Code look-ups" };
  Object.entries(NEUTRAL).forEach(([k, noun]) => (K[k].neutral = K[k].neutral || (() => noun)));
  K.server.neutral = (calls) => `Tool server ${calls[0].mcp.server}`;

  CT.kinds = K;

  // The table: an exact tool name to a kind (section 8.1).
  const TABLE = {
    read: "read",
    ls: "list",
    write: "edit", edit: "edit", apply_patch: "edit",
    memory_search: "recall", memory_get: "recall",
    exec: "command", code_execution: "command",
    terminal: "terminal",
    web_search: "web",
    x_search: "xsearch",
    web_fetch: "page",
    browser: "browser",
    computer: "computer",
    mobile_ui: "phone",
    screen: "screen",
    automations: "routine", cron: "routine",
    sessions_send: "message",
    sessions_list: "tasks", sessions_history: "tasks", sessions_search: "tasks", session_status: "tasks", agents_list: "tasks",
    sessions_spawn: "helper", agents_wait: "helper", subagents: "helper",
    ask_user: "question",
    progress_card: "plan", create_goal: "plan", update_goal: "plan", get_goal: "plan",
    image_generate: "media", video_generate: "media", music_generate: "media", tts: "media",
    pdf: "look", view_image: "look",
    message: "channel", conversations_send: "channel", conversations_turn: "channel",
  };
  CT.kindTable = TABLE;

  // T3 Code's seven tools (section 11.1), and what each is for.
  CT.t3Tools = {
    t3_project_list: "list",
    t3_thread_list: "list",
    t3_thread_launch: "launch",
    t3_thread_send: "send",
    t3_thread_read: "read",
    t3_thread_wait: "wait",
    t3_thread_interrupt: "interrupt",
  };

  // The kind of a call and its fold key. Recognized per call: a T3 Code call by its
  // result naming one of the seven tools, whatever the server is called; before the
  // result only by the gateway's name mapping, which the result overrules.
  CT.kindOf = (c) => {
    const id = c.mcp || (c.status === "running" || c.status === "waiting" || c.status === "review" ? c.nameMap : null);
    if (id) {
      const op = CT.t3Tools[id.tool];
      if (op === "list") return { kind: "t3list", key: "t3:list", known: Boolean(c.nameMap || c.mcp) };
      if (op) return { kind: "t3", op, key: `once:${c.id}` };
      return { kind: "server", key: `server:${id.server}:${id.tool}`, known: Boolean(c.nameMap) };
    }
    if ((c.name === "write" || c.name === "edit") && isMemoryPath(c.args.path)) return { kind: "memory", key: "memory", known: true };
    if (c.commandBearing) return { kind: "command", key: "command", known: true };
    const kind = TABLE[c.name];
    if (!kind) return { kind: "tool", key: c.builtin ? `tool:${c.name}` : `once:${c.id}` }; // an unknown name folds only when the inventory lists it as built-in
    if (["message", "helper", "question", "channel"].includes(kind)) return { kind, key: `once:${c.id}` };
    if (kind === "routine") return { kind, key: ["status", "list", "get", "runs"].includes(c.args.action) ? `routine:${c.args.action}` : `once:${c.id}` };
    if (["terminal", "media"].includes(kind)) return { kind, key: `${c.name}:${c.args.action || "generate"}` };
    if (["recall", "tasks", "plan", "look"].includes(kind)) return { kind, key: c.name };
    if (kind === "edit" || kind === "read") return { kind, key: kind === "read" ? "read" : "files" };
    return { kind, key: c.name };
  };

  // The general rule (7.3): a payload that carries its own status or code is read from it.
  // Returns an outcome, or null when the payload says nothing of the kind.
  const SUCCESS = ["ok", "completed", "success", "sent", "accepted", "answered"];
  CT.payloadOutcome = (c) => {
    const d = c.details || {};
    if (d.ok === false || d.error || ["error", "failed"].includes(d.status)) return { outcome: "failed" };
    if (d.status === "forbidden") return { outcome: "refused", word: "Not run" };
    if (d.status === "not_found") return { outcome: "notfound" };
    if (d.code === "confirmation_required") return { outcome: "refused", word: "Needs confirmation" };
    if (d.status === "approval-pending") return { outcome: "waiting" };
    if (d.status && !SUCCESS.includes(d.status)) return { outcome: "made", word: CT.nameWords(d.status) };
    if (d.code && !SUCCESS.includes(d.code)) return { outcome: "made", word: CT.nameWords(d.code) };
    return null;
  };

  // Outcomes ------------------------------------------------------------------------------

  const OPEN = ["running", "review", "waiting"];
  const isOpen = (c) => OPEN.includes(c.status);

  // What the call's state says: the event's status, or for a result, the adapter's outcome.
  CT.outcomeOf = (c) => {
    if ((c.status || "done") !== "done") return { outcome: c.status };
    const k = K[CT.kindOf(c).kind];
    const o = k?.outcome ? k.outcome(c) : "done";
    return typeof o === "string" ? { outcome: o } : o;
  };

  // The problem words, in their fixed order (7.4), for a fold's line and the run line.
  const PROBLEMS = { failed: "failed", blocked: "not run", denied: "not run", refused: "not run", unavailable: "unavailable", notfound: "not found", suppressed: "suppressed", stopped: "stopped", unknown: "unknown" };
  const PROBLEM_ORDER = ["failed", "not run", "unavailable", "not found", "suppressed", "stopped", "unknown"];
  // Settled outcomes short of Done, counted after the problems, in this order (7.4).
  const SHORT = { started: "started", queued: "queued", unconfirmed: "not confirmed", made: "call made", unchanged: "no change", partial: "partial" };
  const SHORT_ORDER = ["started", "queued", "not confirmed", "call made", "no change", "partial"];
  CT.problemOf = (c) => PROBLEMS[CT.outcomeOf(c).outcome] || "";

  // The state at the right, for an outcome.
  const right = (c, o) => {
    if (c.lastSeen && isOpen(c)) return `<span class="state">${CT.glyph(c.leaves ? "sending" : "working")}${c.leaves ? "Last seen: call started" : "Last seen running"}</span>`;
    const span = (glyph, word, tone = "") => `<span class="state"${tone ? ` data-tone="${tone}"` : ""}>${CT.glyph(glyph)}${esc(word)}</span>`;
    switch (o.outcome) {
      case "running":
      case "review":
        return c.leaves ? CT.state("call-started") : `<span class="action-elapsed">${esc(c.elapsed || "")}</span>`;
      case "waiting":
        return CT.state(c.readOnly ? "approval" : "waiting-you");
      case "partial":
        return span("queued", "Partial");
      case "started":
        return span("check", "Started");
      case "queued":
        return span("queued", "Queued");
      case "made":
        return span(o.word ? "queued" : "check", o.word || "Call made");
      case "unconfirmed":
        return span("queued", "Not confirmed");
      case "unchanged":
        return span("queued", "No change");
      case "notfound":
        return span("queued", "Not found");
      case "refused":
        return span("stopped", o.word || "Not run");
      case "suppressed":
        return span("stopped", "Suppressed");
      case "unavailable":
        return span("blocked", "Unavailable", "warn");
      case "failed":
        return span("failed", c.failWord || "Failed", "danger");
      case "blocked":
        return span("failed", "Not run", "danger");
      case "denied":
        return span("stopped", c.deniedWord || "Denied");
      case "stopped":
        return span("stopped", "Stopped");
      case "unknown":
        return CT.state("unknown");
      default:
        return o.word ? span("check", o.word, "accent") : `<time class="action-time">${esc(c.took || "")}</time>`;
    }
  };

  // The words of one call in its state (7.3).
  CT.lineOf = (c) => {
    const info = CT.kindOf(c);
    const k = K[info.kind];
    c.leaves = Boolean(k.leaves);
    const w = k.words(c);
    const o = CT.outcomeOf(c);
    const pick = {
      running: c.leaves ? w.noun || w.run : w.run,
      review: ["Reviewing", w.run[1]],
      waiting: info.kind === "command" ? ["Wants to run", w.run[1]] : w.noun || w.run,
      done: w.done,
      partial: w.done,
      started: w.started || ["Started", lower(w.run.join(" "))],
      queued: w.queued || w.noun || w.done,
      made: w.noun || w.done,
      unconfirmed: w.done,
      unchanged: w.unchanged || ["Left", `${w.done[1]} unchanged`],
      notfound: w.notfound || ["Found no", lower(w.done[1] || "result")],
      refused: w.refused || (info.kind === "command" ? ["Didn't run", w.run[1]] : ["Not run:", lower(w.run.join(" "))]),
      suppressed: w.suppressed || ["Didn't", lower(w.run.join(" "))],
      unavailable: w.fail,
      failed: w.fail,
      blocked: [c.blockedBy === "review" ? "Blocked by review" : "Blocked by policy", ""],
      denied: info.kind === "command" ? ["Didn't run", w.run[1]] : w.refused || ["Not run:", lower(w.run.join(" "))],
      stopped: ["Stopped", lower(w.run.join(" "))],
      unknown: w.noun || ["Stopped", lower(w.run.join(" "))],
    }[o.outcome] || w.done;
    let [verb, object] = pick;
    let detail = w.detail;
    let mono = Boolean(w.mono);
    if (o.outcome === "blocked" && info.kind === "command") detail = c.args.command;
    if (c.timedOut || c.cutOff) {
      [verb, object] = [c.timedOut ? "Timed out:" : "Cut off:", CT.programOf(c.args.command)];
      detail = c.timedOut ? `its ${c.args.timeoutSeconds || 120}s limit` : "the run's 50m limit";
      mono = false;
    }
    // A failure's detail is what went wrong, never a count from a result it did not give.
    if (o.outcome === "failed" && !c.timedOut && !c.cutOff) [detail, mono] = [String(c.details?.error || c.text || "").split("\n")[0].slice(0, 120) || (info.kind === "command" ? detail : ""), info.kind === "command" && !c.text && !c.details?.error];
    if (o.outcome === "refused" && c.details?.proposedEffect) detail = `would ${c.details.proposedEffect}`;
    if (o.outcome === "refused" && c.details?.error) detail = c.details.error;
    if (o.outcome === "unavailable" && c.details?.warning) detail = c.details.warning;
    if (o.outcome === "unavailable" && c.details?.error) detail = String(c.details.message || c.details.error).split(/[.\n]/)[0];
    return { kind: info.kind, icon: w.icon || k.icon, verb, object, detail, mono, exit: o.outcome === "done" ? w.exit : "", outcome: o };
  };

  const iconOf = (name) => (name === "t3" ? CT.agentMark() : CT.icon(name));

  // The summary of a card. The verb, icon and object are one sentence, so that on a
  // narrow column they wrap together and the object stays readable (7.9).
  const summary = ({ verb, icon, object, detail, mono, exit, tone, state, spoken, title }) =>
    `<summary aria-label="${esc(spoken)}" title="${esc(title)}">` +
    `<span class="action-sentence"><span class="action-verb">${esc(verb)}</span> ` +
    `<span class="action-what">${icon}${object ? `<span class="action-object">${esc(object)}</span>` : ""}</span></span>` +
    `<span class="action-detail"${tone ? ` data-tone="${tone}"` : ""}>` +
    (detail ? `<span${mono ? ' class="mono"' : ""}>${esc(detail)}</span>` : "") +
    (exit ? `<span class="action-exit">${esc(exit)}</span>` : "") +
    `</span>` +
    `<span class="action-state">${state}</span>${CT.icon("chevron", "icon chevron")}</summary>`;

  const stateWords = (c, o) =>
    ({ running: c.leaves ? "call started" : "running", review: "under review", waiting: "waiting for you", partial: "partial", started: "started", queued: "queued", made: (o.word || "call made").toLowerCase(), unconfirmed: "not confirmed", unchanged: "no change", notfound: "not found", refused: (o.word || "not run").toLowerCase(), suppressed: "suppressed", unavailable: "unavailable", failed: (c.failWord || "failed").toLowerCase(), blocked: "not run", denied: "denied", stopped: "stopped", unknown: "unknown" })[o.outcome] ||
    (o.word ? o.word.toLowerCase() : c.took ? c.took.replace(/s$/, " seconds") : "done");

  CT.toolTitle = (name) => String(name).split(/[_\s.]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

  // The readable view of one call, by kind (section 8.1, "Opened").
  const OUTCOME_SENTENCE = {
    started: "The gateway admitted this and runs it in the background. What it makes arrives as a later message.",
    queued: "Queued: it runs when its turn comes. Nothing here says it has run.",
    made: "The call returned. Its result does not say whether the work was done.",
    unconfirmed: "The action ran, but its effect was not seen on the screen.",
    suppressed: "The gateway chose not to deliver this message.",
    partial: "Only part of the work was done.",
    unchanged: "The gateway reports that nothing changed.",
    notfound: "What was asked for was not there.",
    refused: "Nothing was done.",
  };
  CT.readableOf = (c) => {
    const { kind } = CT.kindOf(c);
    const o = CT.outcomeOf(c);
    const a = c.args || {};
    const rows = [];
    const add = (k, v, opts) => v !== undefined && v !== null && v !== "" && rows.push([k, String(v), opts]);
    let result = "";
    let label = "Result";
    let extra = "";
    switch (kind) {
      case "read":
        add("File", a.path, { mono: true, copy: true, what: "file path" });
        break;
      case "list":
        add("Folder", a.path, { mono: true });
        label = "Entries";
        break;
      case "edit":
      case "memory": {
        CT.filesOf(c).forEach((f, i) => add(i ? "" : CT.filesOf(c).length > 1 ? "Files" : kind === "memory" ? "Note" : "File", f, { mono: true }));
        const d = diffCount(c.details?.diff);
        if (c.details?.diff) add("Change", `${d.added} lines added, ${d.removed} removed`);
        label = kind === "memory" && c.name === "write" ? "Saved" : "Added";
        result = kind === "memory" && c.name === "write" ? a.content || "" : c.details?.diff ? c.details.diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n") : "";
        break;
      }
      case "recall":
        if (c.name === "memory_get") add("Note", a.path, { mono: true });
        else add("Query", a.query);
        if (c.details?.staleness?.warning) add("Note", c.details.staleness.warning);
        if (o.outcome === "unavailable") extra = CT.note(`Memory search is unavailable: ${esc(c.details?.warning || c.details?.error || "the gateway gave no reason")}`);
        label = c.name === "memory_get" ? "The note" : "Matches";
        result = Array.isArray(c.details?.results) ? c.details.results.map((r) => `${r.path}: ${r.snippet}`).join("\n") : "";
        break;
      case "command":
        add("Command", a.command || a.task, { mono: true, copy: true });
        add("Runs on", a.host || "the gateway's host");
        add("Folder", a.workdir || a.cwd, { mono: true });
        label = "Output";
        break;
      case "terminal":
        add("Action", a.action);
        add("Terminal", a.sessionId);
        break;
      case "web":
      case "xsearch":
        add("Query", a.query);
        if (o.outcome === "unavailable") extra = CT.note(esc(c.details?.message || c.details?.error || "The search was unavailable."));
        if (c.details?.results && !isOpen(c)) {
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
        add("Title", CT.unwrapExternal(c.details?.title));
        add("Status", c.details?.status);
        label = "Text";
        break;
      case "browser":
      case "computer":
      case "phone":
        add("Action", [a.action, a.request?.kind, a.mobileAction?.type].filter(Boolean).join(", "));
        add("Target", a.targetUrl || a.request?.element || a.request?.text || (a.coordinate ? a.coordinate.join(", ") : ""));
        add("Typed", a.request?.kind === "type" ? a.request.text : a.action === "type" ? a.text : a.mobileAction?.type === "set_text" ? a.mobileAction.text : "");
        add("Effect", c.details?.result?.effect ? { confirmed: "confirmed", unverifiable: "could not be checked", suspected_noop: "no change was seen" }[c.details.result.effect] : "");
        add("Needs confirmation", c.details?.code === "confirmation_required" ? `${c.details.proposedEffect} (${c.details.target}, in ${c.details.package})` : "");
        add("Device said", c.details?.outcome?.code ? `${c.details.outcome.code}${c.details.outcome.message ? `: ${c.details.outcome.message}` : ""}` : "");
        break;
      case "screen":
        add("Action", a.action);
        break;
      case "routine":
        add("Routine", a.job?.name || a.name);
        add("Schedule", a.job?.schedule ? `${CT.scheduleWords(a.job.schedule)} (${a.job.schedule.kind}${a.job.schedule.expr ? ` ${a.job.schedule.expr}` : ""})` : "");
        add("Does", a.job?.payload?.message);
        break;
      case "plan":
        if (a.plan) {
          return (
            `<ul class="action-plan">` +
            a.plan
              .map((s) => `<li data-status="${s.status}">${s.status === "completed" ? CT.glyph("check") : s.status === "in_progress" ? CT.glyph("working") : '<span class="plan-dot" aria-hidden="true"></span>'}${esc(s.step)}<span class="visually-hidden">, ${s.status.replace("_", " ")}</span></li>`)
              .join("") +
            `</ul>`
          );
        }
        add("Objective", a.objective);
        add("Status", a.status);
        break;
      case "media":
      case "look":
        add("Prompt", a.prompt || a.text);
        add("Pages", a.pages);
        CT.filesOf(c).forEach((f, i) => add(i ? "" : "Input", f, { mono: true }));
        if (o.outcome === "done" && (c.details?.paths || c.details?.audioPath)) {
          return CT.fields(rows) + `<div class="chips">${[...(c.details.paths || [c.details.audioPath])].map((f) => `<span class="chip">${CT.icon("file")}${esc(base(f))}</span>`).join("")}</div>`;
        }
        break;
      case "channel":
        add("Channel", c.details?.channel || a.channel);
        add("To", a.to || a.target);
        add("Status", c.details?.status);
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
    const text = result || (isOpen(c) ? c.partial || "" : c.text || "");
    return (
      (rows.length ? CT.fields(rows) : "") +
      (OUTCOME_SENTENCE[o.outcome] ? CT.note(OUTCOME_SENTENCE[o.outcome]) : "") +
      extra +
      (text
        ? CT.codeBlock({ label: isOpen(c) ? "Output so far" : c.isError ? "Error" : label, text, tone: c.isError ? "danger" : "", live: isOpen(c), copy: isOpen(c) ? "output" : c.isError ? "error" : label, truncated: c.cut || false })
        : isOpen(c)
          ? CT.note(c.leaves ? "Nothing more is reported until the call returns." : "No output yet.")
          : "") +
      (kind === "command" && c.details?.exitCode !== undefined && !isOpen(c) ? CT.fields([["Exit code", String(c.details.exitCode)]]) : "")
    );
  };

  // What the gateway sent for one call: section 9's parts.
  CT.rawOf = (c) => {
    const payload = (isError) => json({ content: [{ type: "text", text: c.text || "" }], ...(c.details ? { details: c.details } : {}), isError });
    const ended = !isOpen(c);
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
  CT.thought = ({ id, time = "", text, open = false, place = "card", raw, call = "" }) =>
    `<details class="thought" data-place="${place}"${id ? ` id="${id}"` : ""}${call ? ` data-call="${esc(call)}"` : ""}${open ? " open" : ""}>` +
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
  const bodyOf = (c, view, thoughtOpen) =>
    (c.thought ? `<div class="action-thought">${CT.thought({ call: c.id, time: c.thought.time, text: c.thought.text, open: thoughtOpen ?? c.thought.open, raw: CT.thoughtRaw(c.thought.text) })}</div>` : "") +
    (c.body || CT.stepBody({ readable: CT.readableOf(c), raw: CT.rawOf(c), view }));

  // One card for one call. opts: { open, view, fresh, thought }.
  CT.actionCard = (c, { open = false, view = "readable", fresh = false, thought } = {}) => {
    c = { status: "done", ...c };
    const line = CT.lineOf(c);
    const icon = isOpen(c) && !c.leaves ? CT.glyph("working") : iconOf(line.icon);
    const words = [line.verb, line.object].filter(Boolean).join(" ");
    const problem = PROBLEMS[line.outcome.outcome];
    return (
      `<details class="card action" data-kind="${line.kind}" data-status="${line.outcome.outcome}"${problem ? ` data-problem="${problem}"` : ""} data-call="${esc(c.id)}" id="${esc(c.id)}" data-testid="tool-call"` +
      `${open ? " open" : ""}${fresh ? ' data-fresh="true"' : ""}>` +
      summary({
        ...line,
        icon,
        state: right(c, line.outcome),
        spoken: `${words}${line.detail ? `, ${line.detail}` : ""}${line.exit ? `, ${line.exit}` : ""}, ${c.lastSeen && isOpen(c) ? "last seen running" : stateWords(c, line.outcome)}`,
        title: `${words}${line.detail ? ` · ${line.detail}` : ""}`,
      }) +
      `<div class="action-body">${bodyOf(c, view, thought)}</div></details>`
    );
  };

  // A row inside an opened fold: the shell's step row, in the singular.
  const ROW_STATUS = { done: "done", partial: "done", started: "done", queued: "done", made: "done", unconfirmed: "done", unchanged: "done", notfound: "skipped", refused: "skipped", running: "running", review: "running", waiting: "waiting", failed: "failed", blocked: "failed", unavailable: "failed", denied: "skipped", suppressed: "skipped", stopped: "skipped", unknown: "skipped" };
  CT.foldRow = (c, { open = false, view = "readable", fresh = false, thought } = {}) => {
    c = { status: "done", ...c };
    const line = CT.lineOf(c);
    const words = [line.verb, line.object].filter(Boolean).join(" ");
    const o = line.outcome.outcome;
    const statusText =
      { failed: c.failWord || "Failed", blocked: "Not run", unavailable: "Unavailable", waiting: "Waiting for you", denied: c.deniedWord || "Denied", suppressed: "Suppressed", stopped: "Stopped", unknown: "Unknown", made: line.outcome.word || "Call made", started: "Started", queued: "Queued", partial: "Partial", unconfirmed: "Not confirmed", unchanged: "No change", notfound: "Not found", refused: line.outcome.word || "Not run" }[o] ??
      (isOpen(c) ? (c.lastSeen ? "Last seen running" : c.elapsed || "") : c.took || "");
    return CT.step({
      id: c.id,
      kind: line.icon === "t3" ? "code" : line.icon,
      status: ROW_STATUS[o] || "done",
      title: words,
      detail: line.detail ? `<span${line.mono ? ' class="mono"' : ""}>${esc(line.detail)}</span>` : "",
      statusText,
      open,
      fresh,
      body: bodyOf(c, view, thought),
    }).replace("<details ", '<details data-testid="tool-call" ');
  };

  // A fold: several calls with one key in a row, one line with a count (7.4).
  CT.foldCard = (calls, { open = false, rows = {}, fresh = false } = {}) => {
    calls = calls.map((c) => ({ status: "done", ...c }));
    const { kind } = CT.kindOf(calls[0]);
    const k = K[kind];
    // The plural is never more complete than the least-established member (7.4).
    const settled = calls.filter((c) => !isOpen(c));
    const outcomes = settled.map((c) => CT.outcomeOf(c).outcome);
    const allDone = outcomes.every((o) => o === "done" || o === "partial");
    const allStarted = outcomes.length && outcomes.every((o) => o === "started");
    const problemsAny = settled.some((c) => CT.problemOf(c));
    const neutral = () => [(k.neutral ? k.neutral(calls) : CT.nameWords(kind).replace(/^./, (x) => x.toUpperCase())), `· ${plural(calls.length, "call", "calls")}`];
    // Done (or Partial, whose past verb is true) beside problems keeps the done plural, with
    // the problems counted; Started alone has its own plural; any other mix is neutral.
    const doneOrProblem = outcomes.every((o) => o === "done" || o === "partial" || PROBLEMS[o]);
    const [verb, object] = allDone || (problemsAny && doneOrProblem) ? k.plural(calls.length, calls) : allStarted && k.startedPlural ? k.startedPlural(calls.length, calls) : neutral();
    const live = [...calls].reverse().find(isOpen); // the latest to start
    const waiting = calls.find((c) => c.status === "waiting");
    const problems = calls.filter((c) => CT.problemOf(c));
    const counts = PROBLEM_ORDER.map((p) => [p, calls.filter((c) => CT.problemOf(c) === p).length]).filter(([, n]) => n);
    const countWords = counts.map(([p, n]) => `${n} ${p}`).join(" · ");
    const shortCounts = SHORT_ORDER.map((w) => [w, settled.filter((c) => SHORT[CT.outcomeOf(c).outcome] === w).length]).filter(([, n]) => n);
    const allWords = [...counts, ...shortCounts].map(([p, n]) => `${n} ${p}`).join(" · ");
    const danger = counts.some(([p]) => p === "failed" || p === "not run");
    const words = (c) => {
      const l = CT.lineOf(c);
      return `${lower(l.verb)}${l.object ? ` ${l.object}` : ""}`;
    };
    const lostLive = live?.lastSeen;
    const busy = Boolean(waiting || live);
    // The detail slot: the first problem, else the running member, else the objects.
    let detail;
    let tone = "";
    if (problems.length) {
      detail = `${busy ? `${countWords}: ` : ""}${words(problems[0])}`;
      tone = danger ? "danger" : "muted";
    } else if (live) {
      detail = words(live);
    } else {
      detail = k.foldDetail ? k.foldDetail(calls) : [...new Set(calls.map((c) => CT.lineOf(c).object))].join(", ");
    }
    // The right side: waiting, else running, else last seen, else the problems, else the duration.
    let state;
    let status = "done";
    if (waiting) {
      state = CT.state("waiting-you");
      status = "waiting";
    } else if (live) {
      state = lostLive ? `<span class="state">${CT.glyph("working")}Last seen running</span>` : `<span class="action-elapsed">${esc(live.elapsed || "")}</span>`;
      status = "running";
    } else if (problems.length || shortCounts.length) {
      // Every outcome short of Done is counted, problems first; no duration then.
      const glyph = danger ? "failed" : problems.length ? "stopped" : shortCounts[0][0] === "started" ? "check" : "queued";
      state = `<span class="state"${danger ? ' data-tone="danger"' : ""}>${CT.glyph(glyph)}${esc(allWords)}</span>`;
      status = danger ? "failed" : problems.length ? "problem" : "short";
    } else {
      const timed = calls.every((c) => c.took);
      const total = calls.reduce((t, c) => t + (parseFloat(c.took) || 0), 0);
      state = `<time class="action-time">${timed && total ? `${total < 10 ? total.toFixed(1) : Math.round(total)}s` : ""}</time>`;
    }
    const label = `${verb} ${object}`;
    const spoken = `${label}, ${detail}, ${waiting ? "waiting for you" : live ? "running" : allWords.replace(/ · /g, ", ") || "done"}`;
    return (
      `<details class="card action" data-fold="${calls.length}" data-kind="${kind}" data-status="${status}"` +
      ` id="fold-${esc(calls[0].id)}" data-first="${esc(calls[0].id)}"${open ? " open" : ""}${fresh ? ' data-fresh="true"' : ""}>` +
      summary({ verb, icon: live && !live.leaves && !problems.length ? CT.glyph("working") : iconOf(k.icon), object, detail, tone, state, spoken, title: `${label} · ${detail}` }) +
      `<div class="action-body"><ol class="fold-rows" aria-label="${esc(label)}">${calls.map((c) => CT.foldRow(c, rows[c.id] || {})).join("")}</ol></div></details>`
    );
  };

  // The run line: after everything the run put in the transcript (7.7).
  CT.runLine = ({ id, label, actions, failed = 0, problems = {}, model, effort, run, open = false }) => {
    const others = ["unavailable", "suppressed", "stopped", "unknown"].filter((p) => problems[p]).map((p) => `<span aria-hidden="true">·</span><span class="run-problem">${problems[p]} ${p === "suppressed" ? "not sent" : p}</span>`);
    return (
      `<details class="run-line"${id ? ` id="${id}"` : ""}${open ? " open" : ""}>` +
      `<summary class="event-line" title="${esc(`${model || "model not reported"} · ${effort ? `${effort} effort requested` : "effort not reported"}`)}">` +
      `<span class="run-label">${esc(label)}</span><span aria-hidden="true">·</span><span class="run-count">${actions} ${actions === 1 ? "action" : "actions"}</span>` +
      (failed ? `<span aria-hidden="true">·</span><span class="run-failed">${failed} failed</span>` : "") +
      others.join("") +
      `${CT.icon("chevron", "icon chevron")}</summary>` +
      `<p class="activity-foot">${CT.activityFoot({ model, effort, run })}</p></details>`
    );
  };

  // T3 Code: one card per thread (section 11) ------------------------------------------------

  // A thread's identity: the server, the environment when given, and the thread id.
  CT.threadKey = (c) => {
    const id = c.mcp || c.nameMap;
    if (!id || !CT.t3Tools[id.tool] || CT.t3Tools[id.tool] === "list") return null;
    const sc = c.mcp ? CT.structured(c) : null;
    const threadId = c.args.threadId || sc?.threadId;
    return threadId ? `${id.server}|${c.args.environmentId || ""}|${threadId}` : null;
  };

  const opOf = (c) => CT.t3Tools[(c.mcp || c.nameMap)?.tool];
  const T3_VERBS = { launch: "Messaged", send: "Followed up with", read: "Read the thread in", wait: "Waited for", interrupt: "Asked" };
  const T3_HEADS = { launch: "started the thread", send: "followed up", read: "read the thread", wait: "waited for a result", interrupt: "asked T3 Code to stop" };
  const RUN_WORDS = {
    preparing: ["Starting", "sending"], queued: ["Starting", "sending"], starting: ["Starting", "sending"],
    running: ["Running", "working", "accent"], waiting: ["Waiting in T3 Code", "waiting", "warn"], completed: ["Completed", "check", "accent"],
    interrupted: ["Interrupted", "stopped"], failed: ["Failed in T3 Code", "failed", "danger"], cancelled: ["Cancelled", "stopped"],
    rolled_back: ["Rolled back", "stopped"], idle: ["Idle", "queued"], interrupt_requested: ["Stop requested", "stopped"], no_active_run: ["Idle", "queued"],
  };

  // Each call's own state (the table in section 11).
  const callState = (c) => ({ running: "call-started", review: "call-started", waiting: "approval", done: "call-made", failed: "failed", blocked: "not-sent", denied: "not-sent", stopped: "delivery-unknown", unknown: "delivery-unknown" })[c.status || "done"];

  // The status T3 Code reported in a returned result, if any.
  const reported = (c) => {
    if ((c.status || "done") !== "done" || c.isError) return null;
    const sc = CT.structured(c) || {};
    return sc.thread?.status || sc.status || null;
  };

  // The thread's state, from its calls (11.2).
  CT.threadState = (calls) => {
    const open = calls.filter((c) => isOpen(c));
    if (open.some((c) => c.status === "waiting")) return { html: CT.state("approval"), word: "waiting for approval" };
    if (open.some((c) => ["launch", "send", "interrupt"].includes(opOf(c)))) return { html: CT.state("call-started"), word: "call started" };
    if (open.length) return { html: CT.state("checking"), word: "checking" };
    const last = [...calls].reverse().find(reported);
    if (last) {
      const [word, glyph, tone] = RUN_WORDS[reported(last)] || [reported(last), "check"];
      return { html: `<span class="state"${tone ? ` data-tone="${tone}"` : ""}>${CT.glyph(glyph)}${esc(word)}</span>`, word: word.toLowerCase(), at: last.ended };
    }
    const sending = [...calls].reverse().find((c) => ["launch", "send", "interrupt"].includes(opOf(c))) || calls[calls.length - 1];
    return { html: CT.state(callState(sending)), word: CT.stateWords[callState(sending)].toLowerCase() };
  };

  const firstLine = (t) => String(t || "").split("\n")[0];

  // What came back, for one call (11.3).
  const cameBack = (c, bot = "Otto") => {
    const op = opOf(c);
    const sc = CT.structured(c) || {};
    if (isOpen(c)) return CT.note(c.status === "waiting" ? "This call waits for your approval. Nothing has been sent." : `${bot} began this call. Nothing yet shows that it was made, and nothing more is reported until it returns.`);
    if (c.status === "failed" || c.isError) return CT.note("The call failed.") + CT.codeBlock({ label: "Error", text: sc.code ? `${sc.code}: ${sc.message}` : c.text || "", tone: "danger", copy: "error" });
    if (c.status === "blocked") return CT.note(`A rule refused this call: ${esc(c.details?.deniedReason || "no reason given")}. Nothing was sent.`);
    if (c.status === "stopped" || c.status === "unknown") return CT.note(`${bot} was stopped before the call returned. The gateway cannot say whether T3 Code received it.`);
    const status = (s) => (RUN_WORDS[s] ? RUN_WORDS[s][0] : s);
    const parts = [];
    if (op === "launch") parts.push(`Thread started${sc.status ? `; its first run: ${status(sc.status)}` : "; no run yet"}.`);
    if (op === "send") parts.push(`${{ started: "Started a new run", queued: "Queued", steered: "Steered the running turn", restarted: "Restarted the turn" }[sc.delivery] || "Taken"}${sc.status ? `; the run: ${status(sc.status)}` : ""}.`);
    if (op === "read") parts.push(`T3 Code reported the thread ${status(sc.thread?.status || "unknown").toLowerCase()}.`);
    if (op === "wait") parts.push(sc.timedOut ? `The wait ended before the run finished; the run: ${status(sc.status)}.` : `The run ended: ${status(sc.status)}.`);
    if (op === "interrupt") parts.push(`${status(sc.status)}.${sc.status === "interrupt_requested" ? " This does not show that T3 Code stopped." : ""}`);
    let reply = "";
    if (op === "read" && Array.isArray(sc.items)) {
      // Two dimensions: more pages (hasMore), and an item whose text was cut (textTruncated).
      const run = sc.thread?.latestRunId;
      const items = sc.items.filter((i) => i.runId === run && i.type === "assistant_message");
      const said = items.map((i) => i.text).join("\n\n");
      const cut = items.some((i) => i.textTruncated);
      if (said) {
        const how = [sc.hasMore ? "First page only: the reply may continue." : "", cut ? "Part of the reply only: its text was cut, and the rest was not read." : ""].filter(Boolean);
        reply = `<div class="exchange-text"><p>${esc(said)}</p></div>` + (how.length ? how.map((h) => CT.note(h)).join("") : CT.note("Read to the end."));
      }
    }
    const final = ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(sc.status || sc.thread?.status);
    return CT.note(parts.join(" ")) + reply + (final ? "" : CT.note("This shows the call was made. It does not show that the work is finished."));
  };

  // One call's item in a thread's card, with its own Raw (11.3).
  const t3Item = (c, { rawOpen = false, hasLine = false } = {}) => {
    const op = opOf(c);
    const sent = c.args.message;
    const raw = CT.rawDisclosure(CT.rawOf(c), rawOpen);
    const chips = op === "launch" ? [["Project", c.args.projectId], ["Title", c.args.title], ["Model", c.args.modelSelection?.model], ["Branch", c.args.workspaceStrategy?.branch]].filter(([, v]) => v) : [];
    return (
      `<li class="exchange-item t3-item" data-call="${esc(c.id)}">${CT.avatar("otto")}<div>` +
      `<div class="exchange-meta" tabindex="-1"><b>Otto</b><span>${T3_HEADS[op]}</span>${c.started ? `<time>${esc(c.started)}</time>` : ""}${CT.state(callState(c))}</div>` +
      (sent ? `<div class="exchange-text"><p>${esc(sent)}</p></div>` : "") +
      (chips.length ? `<div class="chips">${chips.map(([k, v]) => `<span class="chip"><span>${k}</span>${esc(v)}</span>`).join("")}</div>` : "") +
      `<div class="t3-back">${cameBack(c)}</div>` +
      `<div class="card-actions">${hasLine ? CT.linkButton("Show where it happened", { action: "show-where", name: "Show this call where it happened", attrs: `data-call="${esc(c.id)}"` }) : ""}<span class="spacer"></span>` +
      raw.button.replace('data-action="raw"', `data-action="raw" data-call="${esc(c.id)}" aria-label="Raw for this call"`) +
      `</div>${raw.panel}</div></li>`
    );
  };

  const latestLink = (calls) => [...calls].reverse().map((c) => (CT.structured(c) || {}).link || (CT.structured(c) || {}).thread?.link).find(Boolean);
  const sentFirst = (calls) => {
    const c = [...calls].reverse().find((x) => x.args.message) || calls[0];
    return firstLine(c.args.message || c.args.title || "");
  };

  // A thread's card: every call on it, in order, each with its own Raw.
  CT.t3Thread = (calls, { open = false, items = {}, lines = [], fresh = false, before = "" } = {}) => {
    const key = CT.threadKey(calls.find((c) => CT.threadKey(c)) || calls[0]);
    const state = CT.threadState(calls);
    const first = sentFirst(calls);
    const count = calls.length > 1 ? ` · ${calls.length} calls` : "";
    const link = latestLink(calls);
    return (
      `<details class="card messaged" data-target="t3code" data-thread="${esc(key || "")}" id="thread-${esc(calls[0].id)}" data-first="${esc(calls[0].id)}"${open ? " open" : ""}${fresh ? ' data-fresh="true"' : ""}>` +
      `<summary aria-label="${esc(`Messaged T3 Code: ${first}${count}. ${state.word}.`)}"><span class="messaged-verb">Messaged</span><span class="messaged-who">${CT.agentMark()}T3 Code</span>` +
      `<span class="messaged-first">${esc(first)}<span class="t3-count">${esc(count)}</span></span>${state.html}${CT.icon("chevron", "icon chevron")}</summary>` +
      `<div class="messaged-body">` +
      (before ? CT.note(before) : "") +
      (state.at ? CT.note(`T3 Code reported ${esc(state.word)} at ${esc(state.at)}.`) : "") +
      `<ol class="exchange t3-items">${calls.map((c) => t3Item(c, { rawOpen: items[c.id]?.raw, hasLine: lines.includes(c.id) })).join("")}</ol>` +
      (link ? `<div class="card-actions"><a class="link-button" href="#" data-href="${esc(link)}" data-action="open-thread" aria-label="Open the T3 Code thread in your browser">Open thread${CT.icon("external")}</a></div>` : "") +
      `</div></details>`
    );
  };

  // A T3 Code call's own line: a later call on a thread, or a call whose thread is not known.
  CT.t3Line = (c, { open = false, rawOpen = false, fresh = false, thread = null } = {}) => {
    c = { status: "done", ...c };
    const op = opOf(c) || "launch";
    const sc = CT.structured(c) || {};
    const verb = T3_VERBS[op];
    const detail = op === "interrupt" ? "to stop the thread" : c.args.message ? firstLine(c.args.message) : reported(c) ? `reported ${(RUN_WORDS[reported(c)] || [reported(c)])[0].toLowerCase()}` : sc.code ? `${sc.code}` : "";
    const st = callState(c);
    return (
      `<details class="card messaged" data-target="t3code" data-call="${esc(c.id)}" id="${esc(c.id)}"${thread ? ` data-line="${op}" data-thread="${esc(thread)}"` : ""}${open ? " open" : ""}${fresh ? ' data-fresh="true"' : ""}>` +
      `<summary aria-label="${esc(`${verb} T3 Code: ${detail}. ${CT.stateWords[st]}.`)}"><span class="messaged-verb">${verb}</span><span class="messaged-who">${CT.agentMark()}T3 Code</span>` +
      `<span class="messaged-first">${esc(detail)}</span>${CT.state(st)}${CT.icon("chevron", "icon chevron")}</summary>` +
      `<div class="messaged-body"><ol class="exchange t3-items">${t3Item(c, { rawOpen })}</ol>` +
      `<div class="card-actions">` +
      (thread ? CT.linkButton("Show the thread", { action: "show-thread", name: "Show this thread's card", attrs: `data-thread="${esc(thread)}" data-call="${esc(c.id)}"` }) : "") +
      (sc.link ? `<a class="link-button" href="#" data-href="${esc(sc.link)}" data-action="open-thread" aria-label="Open the T3 Code thread in your browser">Open thread${CT.icon("external")}</a>` : "") +
      `</div></div></details>`
    );
  };

  // The engine ---------------------------------------------------------------------------
  //
  // Places cards in order and folds them by the rules in section 7.4, and gathers
  // T3 Code calls into one card per thread by the rules in 11.2 to 11.4.
  // `insert(html)` adds markup where new transcript content goes and returns the
  // first node. Whether a card, a fold, a row, a Thought line or a Raw panel is
  // open, in which view, and where focus is, are the viewer's, and are kept
  // through every update.

  CT.feed = ({ insert, follow = () => {}, instant = () => false, following = () => true }) => {
    const calls = new Map(); // id -> call
    const groups = []; // { type: card | fold | thread | line | t3call, key, ids, el, thread }
    const threads = new Map(); // thread key -> its card's group
    let column = null; // the last group, while nothing has come after it

    const viewOf = (el) => (el?.querySelector('[data-view-button="raw"]')?.getAttribute("aria-selected") === "true" ? "raw" : "readable");

    // Where focus is, said so that the same control can be found after a render.
    const focusOf = (el) => {
      const a = document.activeElement;
      if (!el || !el.contains(a)) return null;
      const call = a.closest("[data-call]")?.dataset.call || a.closest(".step")?.id || null;
      return {
        call,
        summary: a.tagName === "SUMMARY" && a.parentElement === el,
        rowSummary: a.tagName === "SUMMARY" && a.parentElement.classList.contains("step"),
        view: a.dataset.viewButton,
        label: a.getAttribute("aria-label"),
        action: a.dataset.action,
        thought: Boolean(a.closest(".thought")),
      };
    };
    const restoreFocus = (el, f) => {
      if (!f) return;
      const scope = (f.call && (el.querySelector(`.t3-item[data-call="${CSS.escape(f.call)}"]`) || el.querySelector(`[id="${CSS.escape(f.call)}"]`))) || el;
      let target = null;
      if (f.summary) target = el.querySelector(":scope > summary");
      else if (f.rowSummary) target = scope.querySelector(":scope > summary");
      else if (f.thought) target = scope.querySelector(".thought > summary");
      else if (f.view) target = scope.querySelector(`[data-view-button="${f.view}"]`) || scope.querySelector('[aria-label="Raw for this call"]');
      else if (f.label) target = scope.querySelector(`[aria-label="${CSS.escape(f.label)}"]`) || (f.action === "raw" ? scope.querySelector('[aria-label="Raw for this call"]') || scope.querySelector('[data-view-button="raw"]') : null);
      (target || el.querySelector(":scope > summary"))?.focus({ preventScroll: true });
    };

    const keep = (el) => {
      if (!el) return null;
      const rows = {};
      el.querySelectorAll(".fold-rows > li > .step").forEach((r) => (rows[r.id] = { open: r.open, view: viewOf(r), thought: r.querySelector(".action-thought .thought")?.open }));
      const items = {};
      el.querySelectorAll(".t3-item").forEach((i) => (items[i.dataset.call] = { raw: i.querySelector('[data-action="raw"]')?.getAttribute("aria-expanded") === "true" }));
      return {
        open: el.open,
        view: viewOf(el.querySelector(":scope > .action-body")),
        thought: el.querySelector(":scope > .action-body > .action-thought .thought")?.open,
        rows,
        items,
        focus: focusOf(el),
        type: el.dataset.fold !== undefined ? "fold" : el.classList.contains("messaged") ? "t3" : "card",
      };
    };

    const markup = (group, kept, fresh) => {
      const list = group.ids.map((id) => calls.get(id));
      if (group.type === "thread") {
        const items = { ...(kept?.items || {}) };
        // A call that changed in place keeps its view: Raw stays open on its item.
        if (kept?.type === "card" && kept.view === "raw") items[list[0].id] = { raw: true };
        const lines = groups.filter((g) => g.type === "line" && g.thread === group.thread).flatMap((g) => g.ids);
        return CT.t3Thread(list, { open: kept?.open, items, lines, fresh });
      }
      if (group.type === "line" || group.type === "t3call") {
        const raw = kept?.items?.[list[0].id]?.raw || (kept?.type === "card" && kept.view === "raw");
        return CT.t3Line(list[0], { open: kept?.open, rawOpen: raw, fresh, thread: group.type === "line" ? group.thread : null });
      }
      // From a T3 Code line back to an ordinary card (the result overruled the mapping):
      // open stays open, and the item's open Raw becomes the Raw tab.
      if (list.length === 1) {
        const view = kept?.type === "t3" ? (kept.items?.[list[0].id]?.raw ? "raw" : "readable") : kept?.view;
        return CT.actionCard(list[0], { open: kept?.open, view, fresh, thought: kept?.thought });
      }
      // Becoming a fold: an open card opens the fold with its first row open, in its view.
      const rows = { ...(kept?.rows || {}) };
      if (kept && kept.type === "card") rows[list[0].id] = { open: kept.open, view: kept.view, thought: kept.thought };
      const added = list[list.length - 1].id;
      if (fresh && rows[added] === undefined) rows[added] = { fresh: true };
      return CT.foldCard(list, { open: kept?.open, rows });
    };

    const render = (group, fresh = false) => {
      const kept = keep(group.el);
      const html = markup(group, kept, fresh);
      if (group.el) {
        const holder = document.createElement("div");
        holder.innerHTML = html;
        const next = holder.firstElementChild;
        if (kept && kept.type !== (next.dataset.fold !== undefined ? "fold" : next.classList.contains("messaged") ? "t3" : "card")) next.dataset.changed = "true";
        group.el.replaceWith(next);
        group.el = next;
        restoreFocus(next, kept?.focus);
      } else {
        group.el = insert(instant() ? html.replace(' data-fresh="true"', "") : html);
      }
      follow();
      return group.el;
    };
    // A call's own group: its line, card or fold; else the thread's card it is part of.
    const groupOf = (id) => groups.find((g) => g.type !== "thread" && g.ids.includes(id)) || groups.find((g) => g.ids.includes(id));

    const placeT3 = (group, c) => {
      const key = CT.threadKey(c);
      const op = opOf(c);
      if (!key) {
        group.type = "t3call";
        return render(group);
      }
      const thread = threads.get(key);
      if (!thread || thread === group) {
        // The first call seen on this thread: its card is the thread's card.
        group.type = "thread";
        group.thread = key;
        threads.set(key, group);
        return render(group);
      }
      if (c.status === "done" || c.status === "failed" || c.status === "blocked") {
        // Joins only after its result, directly when nothing came between and the reader
        // follows the end with this line closed and unfocused; otherwise it keeps its line.
        if (!thread.ids.includes(c.id)) thread.ids.push(c.id);
        const adjacent = column === group && group.el?.previousElementSibling === thread.el;
        const quiet = group.el && !group.el.open && !group.el.contains(document.activeElement);
        if (adjacent && quiet && following()) {
          const el = group.el;
          groups.splice(groups.indexOf(group), 1);
          column = thread;
          if (instant()) el.remove();
          else {
            el.dataset.joining = "true";
            el.addEventListener("animationend", () => el.remove(), { once: true });
            setTimeout(() => el.remove(), 400);
          }
          return render(thread);
        }
      }
      if (!thread.ids.includes(c.id)) thread.ids.push(c.id);
      group.type = "line";
      group.thread = key;
      render(group);
      render(thread);
      return group.el;
    };

    return {
      calls,
      // A call started, or arrived from history with its state.
      start(call) {
        calls.set(call.id, { status: "running", ...call });
        const c = calls.get(call.id);
        const info = CT.kindOf(c);
        if (info.kind === "t3") {
          column = { type: "t3call", key: info.key, ids: [c.id], el: null };
          groups.push(column);
          const key = CT.threadKey(c);
          const thread = key && threads.get(key);
          if (thread) {
            // Known by the name mapping and its thread: a line now, the thread shows the open call.
            column.type = "line";
            column.thread = key;
            thread.ids.push(c.id);
            render(column, true);
            render(thread);
            return column.el;
          }
          return render(column, true);
        }
        if (column && column.key === info.key && info.known !== false && !info.key.startsWith("once:")) {
          column.ids.push(c.id);
          column.type = "fold";
          return render(column, true);
        }
        column = { type: "card", key: info.key, ids: [c.id], el: null };
        groups.push(column);
        return render(column, true);
      },
      // The call changed: a result, an error, a wait. `patch` is merged into it.
      update(id, patch) {
        calls.set(id, { ...calls.get(id), ...patch });
        const c = calls.get(id);
        const group = groupOf(id);
        if (!group) return null;
        const info = CT.kindOf(c);
        if (info.kind === "t3" && group.type !== "thread" && group.ids.length === 1) return placeT3(group, c);
        if (group.type === "thread") return render(group);
        if (["line", "t3call"].includes(group.type) && info.kind !== "t3") group.type = "card"; // the result overruled the mapping
        render(group);
        const thread = group.thread && threads.get(group.thread);
        if (thread && thread !== group) render(thread);
        return group.el;
      },
      // Something shown between cards: a bubble, a request card, a note. It ends the column.
      gap() {
        column = null;
      },
      get: (id) => calls.get(id),
      elementOf: (id) => groupOf(id)?.el,
      threadOf: (key) => threads.get(key)?.el,
      all: () => [...calls.values()],
    };
  };
})();
