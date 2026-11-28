// Controls (docs/design/controls.md): what a bot may do and what holds each rule,
// one line's rule with its four facts, asks and the rules that answer them, rules for every
// bot, saved approvals, activity, messaging between bots and what a new bot
// starts with. On top of bots.js, bot-settings.js and t3.js. Nothing here talks
// to a gateway: every value is a local fixture, and every state comes from the
// address (controls.md, section 23).

(function () {
  const CT = window.CT;
  const app = window.app;
  const D = CT.botsData;
  const p = (name) => CT.params.get(name);
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name, cls) => CT.icon(name, cls);
  const { isAdmin, adminBar, button, note, copy, announce, B } = D;
  const BS = window.botSettings;
  const panel = $("#panel-settings");
  const botName = (id) => app.bots.find((b) => b.id === id)?.name || id;
  const current = () => app.model.selectedBot;
  // A connection is judged by the scopes the gateway granted it (section 2, Access).
  const SCOPES = { read: ["operator.read"], write: ["operator.read", "operator.write", "operator.approvals", "operator.questions"], admin: ["operator.read", "operator.write", "operator.approvals", "operator.questions", "operator.admin"] };
  const canApprove = () => (SCOPES[B.access] || []).includes("operator.approvals");

  // The rules plugin, as its status method would report it (section 2).
  const RULES = p("rules") || "running";
  // The expired request's own value (form=fromcard).
  const FROM_TARGET = "notes/disk-2026-11-18.md";
  const PLUGIN = { running: "running", noplugin: "absent", stopped: "stopped", old: "old", unchecked: "unchecked" }[RULES] || "running";
  const C = {
    plugin: PLUGIN,
    state: ["loading", "error"].includes(RULES) ? RULES : "ready",
    line: p("line") || "files",
    part: p("part") || "rules",
    write: p("write") || null,
    waiting: p("waiting") === "1",
    override: p("override") === "1",
    // The hold (section 2): null, "writing", "done" (written and read back).
    hold: p("held") === "1" ? "done" : null,
    holdBot: "otto",
    holdLines: null, // the confirmed entries, by line, taken when the hold is read back
    form: p("form") === "fromcard" ? { pattern: FROM_TARGET, action: "allow", note: "", from: "5:41 PM" } : p("form") === "open" ? { pattern: p("pattern") === "long" ? "a".repeat(1001) : "", action: p("limit") === "never" ? "never" : p("limit") === "ask" ? "ask" : p("limit") === "allow" ? "allow" : "never" } : null,
    saveNote: null,
    revoked: new Set(p("saved") === "revoked" ? ["rg1"] : []),
    auditBot: "all",
    auditVerdict: "all",
    logOpen: p("log") || null,
    older: false,
  };
  const running = () => C.plugin === "running";
  const PLUGIN_WORDS = {
    running: "Rules plugin answered at 5:46 PM. Last tool call seen 5:46 PM.",
    absent: "Rules methods unavailable on this gateway.",
    stopped: "Clawtrate's rules plugin isn't answering.",
    old: "Clawtrate's rules plugin is version 0.9; Otto's rules need 1.0 or newer.",
    unchecked: "Checking Clawtrate's rules plugin…",
  };
  const pluginLine = (bot) =>
    `<p class="c-plugin" role="status"${running() || C.plugin === "unchecked" ? "" : ' data-tone="danger"'}>${icon("plug")}<span>${esc(PLUGIN_WORDS[C.plugin].replace("Otto", botName(bot || "otto")))}</span></p>`;

  // Marks (section 2): who holds the line, in words, never colour alone.
  const MARKS = {
    gateway: ["approval", "The gateway enforces this"],
    plugin: ["plug", "Only while Clawtrate's rules plugin runs"],
    notnow: ["warning", "Not enforced now: the rules plugin isn't running"],
    memory: ["plug", "Only while Clawtrate's memory plugin runs"],
    set: ["lock", "Set on the gateway"],
    shown: ["eye", "Shown only"],
  };
  const mark = (kind) => (kind && MARKS[kind] ? `<span class="c-mark"${kind === "notnow" ? ' data-tone="danger"' : ""}>${icon(MARKS[kind][0])}${MARKS[kind][1]}</span>` : "");
  const markWords = (kind) => (kind && MARKS[kind] ? MARKS[kind][1] : "");
  const pluginMark = () => (running() ? "plugin" : "notnow");

  // The lines of section 4: plain words, and the gateway's tools behind them.
  const LINES = [
    { id: "read", words: "Read files", icon: "read", tools: ["read", "ls"], kind: "path", verb: "reads files" },
    { id: "files", words: "Change files", icon: "write", tools: ["write", "edit", "apply_patch"], kind: "path", verb: "changes files" },
    { id: "exec", words: "Run commands", icon: "command", tools: ["exec", "process"], kind: "command", verb: "runs commands" },
    { id: "web", words: "Search the web", icon: "web", tools: ["web_search", "web_fetch"], kind: null, verb: "searches the web" },
    { id: "message", words: "Message other bots", icon: "message", tools: ["sessions_send"], kind: null, verb: "messages other bots" },
    { id: "tasks", words: "Look at its tasks", icon: "tasks", tools: ["sessions_list", "sessions_history"], kind: null, verb: "looks at its tasks" },
    { id: "ask", words: "Ask you questions", icon: "question", tools: ["ask_user"], kind: null, fixed: true, verb: "asks you questions" },
    { id: "routines", words: "Manage routines", icon: "clock", tools: ["automations", "cron"], kind: null, verb: "manages routines" },
    { id: "browser", words: "Use the browser", icon: "screen", tools: ["browser"], kind: null, verb: "uses the browser" },
    { id: "gateway", words: "Change the gateway's settings", icon: "settings", tools: ["gateway", "plugins"], kind: null, verb: "changes the gateway's settings" },
    { id: "coder", words: "Coding agent coder", icon: "code", tools: ["coder__*"], kind: "tool", verb: "uses the coding agent coder" },
    { id: "t3code", words: "T3 Code", icon: "plugin", tools: ["t3code__*"], kind: "tool", verb: "uses T3 Code" },
  ];
  const NOT_OFFERED = [
    ["Search posts on X", "x_search", "Comes with xAI; Otto's model is OpenAI's."],
    ["Run code", "code_execution", "Comes with xAI; Otto's model is OpenAI's."],
  ];
  const lineOf = (id) => LINES.find((l) => l.id === id);
  const EXEC = [
    ["full", "Allow all", "Otto runs any command without asking, as the user of the machine it runs on."],
    ["auto", "Review first", "Commands on the machine's allowlist run; the gateway's reviewer decides the rest and asks you when unsure."],
    ["ask", "Ask", "Otto asks on an allowlist miss. Safe bins can run without asking. OpenClaw refuses some commands outright."],
    ["deny", "Never", "Otto can't run commands."],
  ];

  // Each bot's own settings. value: allow | ask | never. by: default | bot (its own
  // deny list or command policy) | rule (the plugin) | gateway (the gateway's ceiling).
  const gatewayExec = p("cmd") === "create" && p("cmdpolicy") !== "ask"
    ? { value: "allow", mode: "full", by: "default" }
    : { value: "never", mode: "deny", by: "default" };
  const base = () => ({
    read: { value: "allow", by: "default" },
    files: { value: "allow", by: "default" },
    exec: { ...gatewayExec },
    web: { value: "allow", by: "default" },
    message: { value: "allow", by: "default" },
    tasks: { value: "allow", by: "default" },
    ask: { value: "allow", by: "fixed" },
    routines: { value: "allow", by: "default" },
    browser: { value: "never", by: "gateway" },
    gateway: { value: "never", by: "bot" },
    coder: { value: "allow", by: "default" },
    t3code: { value: "never", by: "bot" },
  });
  // Lazily, so a bot created after the page loaded has its state too.
  const P = new Proxy({}, { get: (o, k) => (typeof k === "string" && !(k in o) && app.bots.some((b) => b.id === k) ? (o[k] = base()) : o[k]) });
  Object.assign(P.otto, {
    exec: { value: "ask", mode: "auto", by: "bot" },
    message: { value: "ask", by: "rule", set: "Nov 14, 9:20 AM, from this device, version 3" },
    routines: { value: "never", by: "bot" },
  });
  if (p("machine") === "gatewayhost") P.otto.exec.host = "gateway";
  // cmdpolicy=allowlist|legacy: a command policy set some other way, shown as its own value.
  if (p("cmdpolicy") === "allowlist") Object.assign(P.otto.exec, { mode: "allowlist", value: "ask" });
  if (p("cmdpolicy") === "legacy") Object.assign(P.otto.exec, { mode: "legacy", value: "ask" });
  if (C.override) {
    P.otto.web = { value: "never", by: "gateway", own: "allow" };
    P.otto.exec.machineAlways = true;
  }
  // Rules about what a tool acts on, by scope ("*" is every bot), each with its version and last decided call.
  let seq = 10;
  const RULESET = {
    otto: [
      { id: "r1", line: "files", action: "never", pattern: "secrets/**", version: 2, set: "Nov 12, 4:05 PM", note: "Keep keys away", last: { time: "5:43 PM", log: "e3" } },
      { id: "r2", line: "exec", action: "ask", pattern: "rm *", version: 1, set: "Nov 13, 8:40 PM", last: null },
    ],
    "*": [{ id: "a1", line: "files", action: "never", pattern: "**/.ssh/**", version: 1, set: "Nov 10, 6:12 PM", last: null }],
  };
  // The rule that asked about the expired card's request (form=fromcard) and the live card at the limit (ask=full).
  const ASKER = { id: "r3", line: "files", action: "ask", pattern: "notes/**", version: 1, set: "Nov 16, 9:10 AM", last: null };
  const LIMIT = { allow: 20, ask: 20, never: 50 };
  // A bot's routines (section 3): there an ask is refused with no card.
  const ROUTINES = { otto: ["Weekly cleanup"] };
  const askLimits = (bot) => {
    const name = esc(botName(bot));
    const rs = ROUTINES[bot] || [];
    const there = rs.length
      ? `${name} has ${rs.length} routine${rs.length === 1 ? "" : "s"}, ${rs.map(esc).join(", ")}. There, Ask first means refused: a routine's run has no one to ask, and the call is refused with no card. The routine's own summary may still say the work was done. `
      : "";
    return `<p class="b-hint" data-testid="ask-limits">${there}Approval routing from another bot's message is unverified.</p>`;
  };
  const fill = (action, n, prefix) => {
    for (let i = 0; i < n; i += 1) RULESET.otto.push({ id: `${prefix}${i}`, line: "files", action, pattern: `${prefix}/${i}/**`, version: 1, set: "Nov 9", last: null });
  };
  if (p("limit") === "allow") fill("allow", 20, "drafts");
  if (p("limit") === "ask") fill("ask", 20, "outbox");
  if (p("limit") === "never") fill("never", 48, "vault"); // with Otto's own, 49: one short of the limit
  if (p("ask") === "full") fill("allow", 20, "drafts");
  if ((p("form") === "fromcard" && p("asker") !== "fallback") || p("ask") === "full") RULESET.otto.push({ ...ASKER });
  const pluginRules = (bot, line) => (RULESET[bot] || []).filter((r) => r.line === line);
  const allRulesFor = (line) => RULESET["*"].filter((r) => r.line === line);
  // Every rule that applies to the bot on a line: its own and the rules for every bot.
  const rulesFor = (bot, line) => [...pluginRules(bot, line), ...allRulesFor(line)];
  // A glob as the plugin matches it: * within a folder or word, ** across folders.
  const matches = (pattern, target) => new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$").test(target);
  // What the next call does, by the order of section 3 (the rules plugin's part, with the gateway's around it).
  function decide(bot, lineId, target) {
    const s = P[bot][lineId];
    if (s.by === "gateway" || s.value === "never") return { verdict: "never", by: "the gateway", words: `the gateway's deny in ${botName(bot)}'s settings` };
    const rs = rulesFor(bot, lineId).filter((r) => matches(r.pattern, target));
    const owner = (r) => (RULESET["*"].includes(r) ? "the rule for every bot" : `${botName(bot)}'s rule`);
    const never = rs.find((r) => r.action === "never");
    if (never) return { verdict: "never", rule: never, words: `${owner(never)} 'never under ${never.pattern}'` };
    const ask = rs.find((r) => r.action === "ask");
    if (ask) return { verdict: "ask", rule: ask, words: `${owner(ask)} 'Ask first · ${ask.pattern}'` };
    if (P[bot].fallback && !rs.some((r) => r.action === "allow")) return { verdict: "ask", words: "'Ask when nothing else decides'" };
    return { verdict: "runs" };
  }
  const ACTION_WORDS = { allow: "Allow without asking", ask: "Ask first", never: "Never" };
  const ACTION_SHORT = { allow: "Allow", ask: "Ask first", never: "Never" };
  const KIND_HELP = {
    path: "A path in Otto's workspace. * within a folder, ** across folders.",
    command: "A command. * matches the rest of a word or line.",
    tool: "A tool of the server, or *.",
  };
  const KIND_EXAMPLE = { path: "For example, secrets/**", command: "For example, rm *", tool: "For example, run_checks" };
  // This device's last read of the plugin's rules (section 2). read=none: it never read them.
  const NEVER_READ = p("read") === "none";
  // With no earlier read, this device knows none of the plugin's rules.
  if (NEVER_READ && PLUGIN !== "running") {
    RULESET.otto = [];
    RULESET["*"] = [];
    P.otto.message = { value: "allow", by: "default" };
  }
  // The tool groups whose rules need the plugin, for the not-enforced note and the hold: every line with a
  // rule for this bot or for every bot, messaging when an outgoing or incoming rule applies, and every
  // offered tool but ask_user when "Ask when nothing else decides" is on.
  const pluginLines = (bot) => (NEVER_READ ? [] : LINES.filter((l) => !l.fixed && (P[bot].fallback ? P[bot][l.id].value !== "never" : P[bot][l.id].by === "rule" || rulesFor(bot, l.id).length )).map((l) => l.id));
  const heldLines = (bot) => {
    if (C.hold !== "done" || C.holdBot !== bot) return [];
    if (!C.holdLines) C.holdLines = pluginLines(bot);
    return C.holdLines;
  };
  const release = (bot, line) => {
    if (C.holdBot === bot && C.holdLines) C.holdLines = C.holdLines.filter((x) => x !== line);
  };

  // The machine's approvals file as its own fact; below admin it can't be read (section 5).
  const machineWords = (bot, short) => {
    if (!isAdmin()) return short ? "machine policy unavailable" : "Machine policy unavailable.";
    const host = bot === "otto" && P[bot].exec.host !== "gateway" ? "media-box" : "the gateway's machine";
    return `${host}'s ${short ? "file" : "approvals file"}: ${P[bot].exec.machineAlways ? "asks every time" : "asks for commands not on its allowlist"}`;
  };
  // A line's value, its exceptions and its mark, in one place (section 4).
  function lineState(bot, id) {
    const s = P[bot][id];
    const rs = rulesFor(bot, id);
    const nevers = rs.filter((r) => r.action === "never");
    const asks = rs.filter((r) => r.action === "ask");
    if (heldLines(bot).includes(id)) return { value: "never", word: "Never", sub: "", mark: "gateway" };
    if (s.by === "gateway") return { value: "never", word: "Never", sub: "", mark: "set" };
    if (s.value === "never") return { value: "never", word: "Never", sub: "", mark: "gateway" };
    if (id === "message" && !effectiveTargets(bot).length) return { value: "never", word: "Never", sub: PAIRS ? "No bot: the gateway's pairs" : "No bot", mark: PAIRS ? "set" : "gateway" };
    if (s.by === "rule") return running() ? { value: "ask", word: "Asks first", sub: "", mark: "plugin" } : { value: "unknown", word: "Unknown", sub: "Not enforced now: asks first", mark: "notnow" };
    if (id === "exec") {
      const extra = asks.length ? `Always before ${asks[0].pattern}` : "";
      if (asks.length && !running()) return { value: "unknown", word: "Unknown", sub: `Not enforced now: asks before ${asks[0].pattern}. The gateway still ${s.mode === "auto" ? "reviews first" : "applies Otto's policy"}`.replace("Otto", botName(bot)), mark: "notnow", tone: "danger" };
      const sub = [`${botName(bot)}'s setting: ${execWord(s.mode)}`, machineWords(bot, true), asks.length ? `${botName(bot)}'s rule: Ask first · ${asks[0].pattern}` : ""].filter(Boolean).join("; ");
      const free = s.mode === "full" && !asks.length && !s.machineAlways;
      return { value: free ? "allow" : "ask", word: free ? "Allowed" : "Asks first", sub, mark: s.machineAlways ? "set" : "gateway" };
    }
    if (nevers.length || asks.length) {
      const words = [nevers.length ? `Never under ${nevers.map((r) => r.pattern).join(" or ")}` : "", asks.length ? `asks before ${asks.map((r) => r.pattern).join(" or ")}` : ""].filter(Boolean).join("; ");
      if (!running()) return { value: "unknown", word: "Unknown", sub: `Not enforced now: ${words.charAt(0).toLowerCase() + words.slice(1)}`, mark: "notnow" };
      if (asks.length) return { value: "ask", word: "Asks first", sub: words.charAt(0).toUpperCase() + words.slice(1), mark: "plugin" };
      return { value: "allow", word: "Limited", sub: words.charAt(0).toUpperCase() + words.slice(1), mark: "plugin" };
    }
    return { value: "allow", word: "Allowed", sub: "", mark: "" };
  }
  function counts(bot) {
    const c = { allow: 0, ask: 0, never: 0, unknown: 0 };
    LINES.forEach((l) => (c[lineState(bot, l.id).value] += 1));
    return c;
  }
  const countWords = (c, bot) => (bot && P[bot].fallback ? `${c.never} never · the rules plugin can ask for other calls` : `${c.never} never · ${c.ask} ask first · ${c.allow} without asking${c.unknown ? ` · ${c.unknown} unknown` : ""}`);

  const sub = (title, backTo, backLabel) =>
    `<div class="b-subhead"><button type="button" class="icon-button" data-variant="quiet" data-bs="${backTo}" aria-label="${backLabel}">${icon("back")}</button>` +
    `<h3 tabindex="-1" data-bs-focus>${title}</h3></div>`;
  const openRow = (label, value, attrs) =>
    `<div><button type="button" class="b-open c-wraprow" ${attrs}><span>${label}</span><span class="c-wrapvalue">${value}</span>${icon("chevron")}</button></div>`;
  const fact = (label, value) => `<div><dt>${label}</dt><dd class="b-wrap-value">${value}</dd></div>`;
  const sw = (on, attrs, label) => `<button type="button" class="b-switch" role="switch" aria-checked="${on}" aria-label="${label}" ${attrs}></button>`;
  const switchRow = (title, subline, on, attrs, label) =>
    `<div class="b-row"><span class="b-row-main"><span>${title}</span>${subline ? `<small>${subline}</small>` : ""}</span>${sw(on, attrs, label)}</div>`;
  const skeleton = (label, n = 4) =>
    `<div aria-busy="true" aria-label="${label}">${Array.from({ length: n }, () => `<div class="skeleton" style="height:48px;width:100%;margin-top:12px"></div>`).join("")}</div>`;
  const failed = (title, retry) =>
    `<div class="work-empty"><span class="empty-mark">${icon("warning")}</span><h4>${title}</h4><p>The gateway did not answer.</p><div style="margin-top:10px">${button("Try again", `data-c="${retry}" data-size="sm"`)}</div></div>`;

  // The Tools group's first rows in the bot's settings (bot-settings.js calls this).
  CT.botsToolsRows = (id) => {
    const c = counts(id);
    return (
      openRow(`What ${esc(botName(id))} may do`, countWords(c, id), `data-bs="rules" aria-label="What ${esc(botName(id))} may do: ${countWords(c, id)}. Open."`) +
      openRow("Messaging other bots", esc(messagingShort(id)), `data-bs="messaging" aria-label="Messaging other bots: ${esc(messagingShort(id))}. Open."`)
    );
  };

  // What a bot may do (section 4) --------------------------------------------------------------

  function ruleLine(bot, l) {
    const st = lineState(bot, l.id);
    const target = l.id === "message" ? 'data-bs="messaging"' : `data-bs="rule" data-c-line="${l.id}"`;
    const name = `${l.words}, ${st.word.toLowerCase()}${st.sub ? `, ${st.sub.toLowerCase()}` : ""}${st.mark ? `, ${markWords(st.mark).toLowerCase()}` : ""}. Open.`;
    return (
      `<div><button type="button" class="b-open c-line" ${target} aria-label="${esc(name)}">` +
      `<span class="c-line-main">${icon(l.icon)}<span class="c-line-words"><span>${l.words}</span>${st.sub ? `<small${st.tone || st.mark === "notnow" ? ' data-tone="danger"' : ""}>${esc(st.sub)}</small>` : ""}${mark(st.mark)}</span></span>` +
      `<span class="c-line-value"><b${st.value === "unknown" ? ' data-tone="warn"' : ""}>${st.word}</b></span>${icon("chevron")}</button></div>`
    );
  }

  function glance(bot) {
    const linkTo = (l, extra) => `<button type="button" class="c-glance-link" ${l.id === "message" ? 'data-bs="messaging"' : `data-bs="rule" data-c-line="${l.id}"`}>${l.words}${extra ? ` (${esc(extra)})` : ""}</button>`;
    const by = (v) => LINES.filter((l) => lineState(bot, l.id).value === v);
    const nevers = by("never").map((l) => linkTo(l, lineState(bot, l.id).sub.toLowerCase()));
    const scoped = running()
      ? LINES.filter((l) => l.id !== "exec" && lineState(bot, l.id).value === "allow")
          .map((l) => [l, rulesFor(bot, l.id).filter((r) => r.action === "never")])
          .filter(([, rs]) => rs.length)
          .map(([l, rs]) => `${l.words.toLowerCase().replace("change files", "changing files")} under ${rs.map((r) => esc(r.pattern)).join(" or ")}`)
      : [];
    const asks = by("ask").map((l) => {
      const st = lineState(bot, l.id);
      return linkTo(l, st.sub);
    });
    const allows = by("allow").map((l) => {
      const st = lineState(bot, l.id);
      return linkTo(l, st.word === "Limited" ? st.sub.replace("Never under", "not under") : "");
    });
    const unknown = by("unknown").map((l) => linkTo(l));
    const block = (title, n, items, extra, cls) =>
      items.length || extra
        ? `<section class="c-glance-block"${cls ? ` data-kind="${cls}"` : ""} aria-label="${title}"><h4>${title} <span class="c-glance-n">${n}</span></h4><p>${items.join(", ")}${extra ? `; and ${extra}` : ""}</p></section>`
        : `<section class="c-glance-block" data-empty${cls ? ` data-kind="${cls}"` : ""} aria-label="${title}: nothing"><h4>${title} <span class="c-glance-n">${n}</span> <span class="b-faint">Nothing</span></h4></section>`;
    return (
      `<div class="c-glance">` +
      block("Never", nevers.length, nevers, scoped.join(", "), "never") +
      (P[bot].fallback
        ? block("The rules plugin can ask for other calls", asks.length + allows.length, [...asks, ...allows], "", "ask")
        : block("Asks first", asks.length, asks, "", "ask") + block("Without asking", allows.length, allows, "", "allow")) +
      (unknown.length ? block("Not enforced now", unknown.length, unknown, "", "unknown") : "") +
      `</div>`
    );
  }

  // What isn't held while the plugin isn't running, in words, from this device's last read (section 2).
  function notHeldWords(bot) {
    const items = [];
    const files = rulesFor(bot, "files").filter((r) => r.action === "never");
    if (files.length) items.push(`changing files under ${files.map((r) => esc(r.pattern)).join(" or ")}`);
    const fileAsks = rulesFor(bot, "files").filter((r) => r.action === "ask");
    if (fileAsks.length) items.push(`changing files under ${fileAsks.map((r) => esc(r.pattern)).join(" or ")} without asking`);
    if (P[bot].message.by === "rule") items.push("messaging other bots");
    rulesFor(bot, "exec").filter((r) => r.action === "ask").forEach((r) => items.push(`commands matching ${esc(r.pattern)}`));
    if (P[bot].fallback) items.push("any tool no rule covers");
    return items.length > 1 ? `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}` : items[0] || "";
  }
  const lineList = (ids) => {
    const w = ids.map((id) => lineOf(id).words);
    return w.length > 1 ? `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}` : w[0] || "";
  };
  // The exact tool names a hold would deny (section 2).
  const toolList = (ids) => {
    const t = ids.flatMap((id) => lineOf(id).tools).map((x) => `<code>${esc(x)}</code>`);
    return t.length > 1 ? `${t.slice(0, -1).join(", ")} and ${t[t.length - 1]}` : t[0] || "";
  };
  const perLine = `<p class="b-hint" style="margin:6px 0 0">To deny a tool, <button type="button" class="link-button" data-c="to-lines">open its line below</button> and choose Never.</p>`;
  function notEnforcedNote(bot) {
    const name = esc(botName(bot));
    const ls = pluginLines(bot);
    if (heldLines(bot).length) {
      if (running()) return note(`<p><b>Clawtrate's rules plugin is running again.</b> ${name}'s settings still deny ${lineList(ls)}, which Clawtrate added while it wasn't. Change them on each line.</p>`, "warn");
      return note(`<p><b>Denied in ${name}'s settings.</b> ${lineList(ls)} are denied in ${name}'s own settings (read back 5:47 PM), which the gateway enforces.</p>`, "warn");
    }
    if (running() || C.plugin === "unchecked") return "";
    if (NEVER_READ) return note(`<p><b>Not known right now.</b> Clawtrate's rules plugin isn't answering, and this device has never read its rules, so it can't tell which aren't being enforced.</p>` + perLine, "danger");
    if (!ls.length) return "";
    const writing = C.hold === "writing" && C.holdBot === bot;
    const bulk = !writing && isAdmin() && !P[bot].fallback;
    return note(
      `<p><b>Enforcement not confirmed.</b> Clawtrate cannot confirm these plugin rules are being enforced. The gateway's own restrictions still apply. <span class="b-faint">Rules as last read on this device, 5:41 PM.</span>${bulk ? ` Denying them adds ${toolList(ls)} to ${name}'s own deny list.` : ""}</p>` +
        (writing
          ? `<p class="b-hint" role="status" style="margin:6px 0 0">Writing the deny…</p>`
          : P[bot].fallback
            ? perLine
            : isAdmin()
              ? `<div class="b-actions">${button(`Deny these in ${name}'s settings`, 'data-c="hold" data-size="sm"', "primary")}</div>`
              : `<p class="b-hint" style="margin:6px 0 0">Only a connection with admin access can deny these.</p>`),
      "danger",
    );
  }

  function holdsBlock(bot) {
    const s = P[bot];
    const ok = (text) => `<li>${icon("check")}${text}</li>`;
    const bad = (text) => `<li data-tone="warn">${icon("warning")}${text}</li>`;
    const name = esc(botName(bot));
    const cmdHost = s.exec.host === "gateway" || bot !== "otto";
    return (
      `<h4 class="b-group">For these rules to hold</h4><ul class="c-holds">` +
      (s.gateway.value === "never" ? ok(`${name} can't change the gateway or its plugins: Never.`) : bad(`${name} can change the gateway or its plugins, and so its rules.`)) +
      (s.exec.mode === "deny"
        ? ok(`${name} can't run commands.`)
        : cmdHost
          ? bad(`${name} runs commands on the gateway's machine as its user. A command can change the gateway's settings and the rules plugin's store, so ${name}'s plugin rules are advice until Run commands is Never there or runs elsewhere.`)
          : ok(`${name}'s commands run on media-box, not on the gateway's machine.`)) +
      `<li>${icon("file")}A rule about a file tool covers that tool, not the file.</li>` +
      `<li data-testid="create-bot">${icon("command")}The built-in gateway and plugins tools have no Create bot action. The agents.create method requires admin. A command that invokes the gateway's CLI is governed by the effective exec policy. Clawtrate writes no command mode when it creates the bot. The bot inherits the gateway's command policy.` +
      (isAdmin() && !["ask", "deny"].includes(s.exec.mode) ? ` ${button("Set configured command policy to Ask", 'data-c="exec-ask" data-size="sm"')}` : "") +
      `</li></ul>`
    );
  }

  function rulesView(bot) {
    const name = esc(botName(bot));
    let html = sub(`What ${name} may do`, "main", "Back to settings");
    if (C.state === "loading") return html + skeleton(`Loading what ${name} may do`);
    if (C.state === "error") return html + failed(`Couldn't load what ${name} may do`, "reload");
    html += pluginLine(bot) + notEnforcedNote(bot) + glance(bot);
    html +=
      RULES === "fresh"
        ? `<p class="b-hint">${name} hasn't run yet, so the gateway hasn't listed its tools. These lines come from its settings.</p>`
        : RULES === "stale"
          ? `<p class="b-hint">Offered: the gateway's listing for ${name}'s latest task, Nov 17. It can be out of date until ${name} runs again.</p>`
          : `<p class="b-hint">From ${name}'s settings and the gateway's, read at 5:41 PM. Each line opens its exact rule.</p>`;
    (P[bot].fallback
      ? [
          ["Never", ["never"]],
          ["The rules plugin can ask for other calls", ["ask", "allow"]],
          ["Not enforced now", ["unknown"]],
        ]
      : [
          ["Never", ["never"]],
          ["Asks first", ["ask"]],
          ["Without asking", ["allow"]],
          ["Not enforced now", ["unknown"]],
        ]
    ).forEach(([title, vs]) => {
      const ls = LINES.filter((l) => vs.includes(lineState(bot, l.id).value));
      if (ls.length) html += `<h4 class="b-group">${title}</h4><dl class="facts">${ls.map((l) => ruleLine(bot, l)).join("")}</dl>`;
    });
    html +=
      `<details class="b-disclosure"><summary>${icon("chevron")}Not offered to ${name}: ${NOT_OFFERED.length} tools</summary><div class="b-disclosure-body"><dl class="facts">` +
      NOT_OFFERED.map(([w, t, why]) => fact(`${w} <code>${t}</code>`, `<span class="b-faint">${why}</span>`)).join("") +
      `</dl></div></details>`;
    html += holdsBlock(bot);
    const dis = isAdmin() ? "" : " disabled";
    const mode = P[bot].exec.mode;
    html += `<h4 class="b-group">When nothing else decides</h4><dl class="facts">`;
    if (mode === "auto" || mode === "ask")
      html += switchRow("Review commands automatically", `On: the gateway's reviewer decides commands that aren't on the machine's allowlist, and asks you when it is unsure. Off: Ask on an allowlist miss. Safe bins can run without asking. OpenClaw refuses some commands outright. ${markWords("gateway")}.`, mode === "auto", `data-c="review"${dis}`, "Review commands automatically");
    html +=
      switchRow(
        "Ask when nothing else decides",
        running() ? `On: any other tool that no rule covers asks you first. Off: it runs. ${markWords("plugin")}.` : "Asking needs Clawtrate's rules plugin running. Without it, tools that no rule covers run.",
        Boolean(P[bot].fallback),
        `data-c="fallback"${running() ? dis : " disabled"}`,
        "Ask when nothing else decides",
      ) +
      `</dl>` +
      (P[bot].fallback ? `<p class="b-hint">${name} will ask for every file it reads and every search it makes.</p>` : "") +
      `<p class="b-hint"><button type="button" class="link-button" data-c="open-permissions">Rules for every bot also apply: ${RULESET["*"].length} rule${RULESET["*"].length === 1 ? "" : "s"}. See Settings, Permissions.</button></p>`;
    return html;
  }

  // One line, opened (section 5) ----------------------------------------------------------------

  // Said before a save, never after (section 3): what was seen when a setting changed while a request waited.
  const waitingNote = (bot) =>
    C.waiting && !C.saving
      ? note(`<p>A pending request may stay open after you change a setting. Its answer and its outcome are shown separately.</p><div class="b-actions">${button("Show the request", 'data-c="show-request" data-size="sm"')}</div>`, "warn")
      : "";
  const execWord = (m) => (EXEC.find(([v]) => v === m) || [m, { allowlist: "Only listed commands", legacy: "Legacy setting: security allowlist, ask on miss" }[m]])[1];
  function choiceGroup(bot, l) {
    const s = P[bot][l.id];
    const name = esc(botName(bot));
    const locked = s.by === "gateway";
    const dis = !isAdmin() || locked || l.fixed || C.saving;
    if (l.id === "exec") {
      const other = { allowlist: "Only listed commands", legacy: "Legacy setting: security allowlist, ask on miss" }[s.mode];
      const extraOpt = other ? `<button type="button" role="radio" aria-checked="true" tabindex="0" data-c="exec" data-value="${s.mode}" aria-disabled="true">${other}</button>` : "";
      const opts = extraOpt + EXEC.map(([v, label]) => `<button type="button" role="radio" aria-checked="${s.mode === v}" tabindex="${s.mode === v ? 0 : -1}" data-c="exec" data-value="${v}"${dis ? ' aria-disabled="true"' : ""}>${label}</button>`).join("");
      return (
        waitingNote(bot) +
        `<p class="c-choice-label" id="c-choice-label">${name} may:</p><div class="c-choice" role="radiogroup" aria-labelledby="c-choice-label" data-four>${opts}</div>` +
        `<p class="c-sentence" role="status">${C.saving ? "Saving…" : other ? `${other}: set outside Clawtrate. It can be left by choosing another value, not chosen again here. ${markWords("gateway")}.` : `${esc(EXEC.find(([v]) => v === s.mode)[2].replace(/Otto/g, botName(bot)))} ${markWords("gateway")}.`}</p>`
      );
    }
    const chosen = heldLines(bot).includes(l.id) ? "never" : locked ? s.own || "allow" : s.by === "rule" ? "ask" : s.value;
    const opts = [
      ["allow", "Allow"],
      ["ask", "Ask"],
      ["never", "Never"],
    ]
      .map(([v, label]) => {
        const noAsk = (v === "ask" && !running()) || (v === "allow" && s.by === "rule");
        return `<button type="button" role="radio" aria-checked="${chosen === v}" tabindex="${chosen === v ? 0 : -1}" data-c="choose" data-value="${v}"${dis || noAsk ? ' aria-disabled="true"' : ""}>${label}</button>`;
      })
      .join("");
    const sentence = C.saving
      ? "Saving…"
      : l.fixed
        ? `${name} asks its questions in the conversation, which already waits for you.`
        : locked
          ? `${name}'s own choice, Allow, has no effect while the gateway's settings deny this tool for every bot. ${markWords("set")}.`
          : chosen === "allow"
            ? rulesFor(bot, l.id).length
              ? `${name}'s own setting is Allow. See Effective for the rules that apply.`
              : `${name} ${l.verb} without asking.`
            : chosen === "ask"
              ? `${name} asks you before it ${l.verb}. ${markWords("plugin")}.`
              : `${name} can't ${l.words.toLowerCase()}. The gateway removes the tools from ${name}'s tools.`;
    return (
      waitingNote(bot) +
      `<p class="c-choice-label" id="c-choice-label">${name} may:</p><div class="c-choice" role="radiogroup" aria-labelledby="c-choice-label"${locked ? " data-locked" : ""}>${opts}</div>` +
      `<p class="c-sentence" role="status">${sentence}</p>` +
      (!running() && !l.fixed && !locked ? `<p class="b-hint">Asking needs Clawtrate's rules plugin running.</p>` : "") +
      (s.by === "rule" && !l.fixed ? `<p class="b-hint">This Ask is changed on the rules page, Settings, Permissions.</p>` : "") +
      (chosen === "ask" && !l.fixed
        ? askLimits(bot)
        : "")
    );
  }

  function fourFacts(bot, l) {
    const s = P[bot][l.id];
    const st = lineState(bot, l.id);
    const name = esc(botName(bot));
    const own = l.id === "exec" ? (s.by === "default" ? "No override. Uses the gateway's command policy." : `${execWord(s.mode)}. It replaces the default for ${name}.`) : s.by === "gateway" ? `Allow (no effect)` : s.by === "rule" ? "Ask (the rules plugin)" : s.value === "never" ? "Never (its deny list)" : "Allow";
    const deflt = l.id === "exec" ? `Commands: ${execWord(gatewayExec.mode)} <span class="c-mark">${icon("lock")}Set on the gateway</span>` : s.by === "gateway" ? `Never <span class="c-mark">${icon("lock")}Set on the gateway</span>` : "None";
    const owner = (r) => (RULESET["*"].includes(r) ? "a rule for every bot" : `${botName(bot)}'s rule`);
    let effective;
    if (heldLines(bot).includes(l.id)) effective = `Never. Denied in ${botName(bot)}'s settings.`;
    else if (l.id === "exec") effective = "Not given as one verdict: the three facts above are shown separately";
    else if (st.value === "unknown") effective = `Not enforced now: the rule that ${st.sub.replace("Not enforced now: ", "")}`;
    else if (st.word === "Limited" || (st.value === "ask" && rulesFor(bot, l.id).length && s.by !== "rule")) {
      const rs = rulesFor(bot, l.id);
      const nev = rs.filter((r) => r.action === "never").map((r) => `${r.pattern} (${owner(r)})`);
      const ask = rs.filter((r) => r.action === "ask").map((r) => `${r.pattern} (${owner(r)})`);
      effective = `Allowed, except ${[nev.length ? `never under ${nev.join(" or ")}` : "", ask.length ? `asks first under ${ask.join(" or ")}` : ""].filter(Boolean).join("; ")}, only while the rules plugin runs`;
    } else effective = st.word;
    const execAsks = rulesFor(bot, "exec").filter((r) => r.action === "ask");
    const pluginRow = execAsks.length ? (running() ? `${botName(bot)}'s rule: Ask first · ${execAsks[0].pattern}, only while the rules plugin runs` : `Not enforced now: ${botName(bot)}'s rule 'Ask first · ${execAsks[0].pattern}'.`) : "None";
    const observed = { files: "Last call 5:46 PM: write, finished (its activity record)", exec: "Last call 5:44 PM: ran on media-box (its own result)", message: "Last call 5:31 PM: a send, refused (its own result)" }[l.id];
    return (
      `<dl class="facts" style="margin-top:14px">` +
      fact("Offered", s.by === "gateway" || s.value === "never" ? `No: removed from ${name}'s tools` : RULES === "fresh" ? "Not listed yet" : `Yes, in ${name}'s latest task (Nov 17 listing)`) +
      fact("Default for every bot", deflt) +
      fact(`${name}'s own setting`, l.id === "exec" && heldLines(bot).includes("exec") ? `Never. Denied in ${name}'s settings.` : own) +
      (l.id === "exec" ? fact("Machine policy", esc(machineWords(bot))) + fact("Rules plugin", esc(pluginRow)) : "") +
      fact("Effective", esc(effective)) +
      fact("Observed", bot === "otto" && observed ? observed : "No call in the activity record") +
      fact("Tools", `<span class="c-tools">${l.tools.map((t) => `<code>${esc(t)}</code>`).join("")}</span>${copy("tool names", l.tools.join(" "))}`) +
      fact("Held by", st.mark ? markWords(st.mark) : "Nothing holds it back") +
      fact("Set", s.set ? esc(s.set) : s.by === "default" || s.by === "fixed" ? "Not set: the gateway's default" : "In the gateway's settings. The gateway doesn't record when.") +
      `</dl>`
    );
  }

  function ruleView(bot) {
    const l = lineOf(C.line) || lineOf("files");
    const s = P[bot][l.id];
    const name = esc(botName(bot));
    let html = sub(l.words, "rules", `Back to what ${name} may do`);
    html += choiceGroup(bot, l);
    if (C.saveNote) html += C.saveNote;
    if (l.id === "exec" && s.machineAlways) html += note(`<p>media-box's approvals file always asks. Allowlist entries don't stop it.</p>`, "", icon("lock"));
    else if (l.id === "exec" && s.mode !== "deny")
      html += `<p class="b-hint">Two checks: Clawtrate's rules plugin first, then the gateway's own (${name}'s policy and media-box's approvals file). An allow in one never passes the other.</p>`;
    html += fourFacts(bot, l);
    if (l.kind) html += actsOnPart(bot, l);
    html += `<details class="b-disclosure"><summary>${icon("chevron")}Raw</summary><div class="b-disclosure-body"><pre class="code-block"><code>${esc(rawFor(bot, l))}</code></pre></div></details>`;
    return html;
  }

  function rawFor(bot, l) {
    const s = P[bot][l.id];
    if (l.id === "exec") return JSON.stringify({ [`agents.entries.${bot}.tools.exec`]: { mode: s.mode }, "tools.exec": { mode: "deny" } }, null, 2);
    if (s.by === "gateway") return JSON.stringify({ "tools.deny": l.tools }, null, 2);
    if (s.by === "rule") return JSON.stringify({ agentId: bot, tools: l.tools, action: "ask", version: 3 }, null, 2);
    if (s.value === "never") return JSON.stringify({ [`agents.entries.${bot}.tools.deny`]: l.tools }, null, 2);
    return JSON.stringify({ [`agents.entries.${bot}.tools.deny`]: [], rules: pluginRules(bot, l.id).map(({ action, pattern, version }) => ({ action, pattern, version })) }, null, 2);
  }

  // Rules about what a tool acts on, and the one contract (section 6).
  function actsOnPart(bot, l) {
    const name = esc(botName(bot));
    let html = `<h4 class="b-group">Rules about what it acts on</h4>`;
    if (!running()) {
      const rs = pluginRules(bot, l.id);
      if (C.plugin === "absent" || !rs.length) return html + `<p class="b-hint">Rules about what it acts on need Clawtrate's rules plugin.</p>`;
      return html + `<dl class="facts">${rs.map((r) => `<div class="b-row"><span class="b-row-main"><span>${ACTION_SHORT[r.action]} · ${r.action === "never" ? "under" : "matching"} <code>${esc(r.pattern)}</code></span><small data-tone="danger">${markWords("notnow")}</small></span></div>`).join("")}</dl>`;
    }
    const order = { never: 0, ask: 1, allow: 2 };
    const own = pluginRules(bot, l.id).sort((a, b) => order[a.action] - order[b.action]);
    const shown = own;
    const lastOf = (r) => (r.last ? `<button type="button" class="link-button" data-c="to-record" data-value="${r.last.log}">Last decided a call: ${r.last.time}</button>` : "No recorded use");
    const rows = [
      ...shown.map(
        (r) =>
          `<div class="b-row"><span class="b-row-main"><span>${ACTION_SHORT[r.action]} · ${r.action === "never" ? "under" : "matching"} <code>${esc(r.pattern)}</code></span>` +
          `<small>${name}'s rule, version ${r.version} · set ${esc(r.set)} · ${markWords("plugin")}</small>${r.note ? `<small class="c-rule-note">Note, not evaluated: "${esc(r.note)}"</small>` : ""}<small>${lastOf(r)}</small></span>` +
          `${isAdmin() ? `${button("Edit", `data-c="rule-edit" data-value="${r.id}" data-size="sm"`, "quiet")}${button("Remove", `data-c="rule-remove" data-value="${r.id}" data-size="sm"`, "quiet")}` : ""}</div>`,
      ),
      ...allRulesFor(l.id).map((r) => `<div class="b-row"><span class="b-row-main"><span>${ACTION_SHORT[r.action]} · ${r.action === "never" ? "under" : "matching"} <code>${esc(r.pattern)}</code></span><small>A rule for every bot, version ${r.version} · edited in Settings, Permissions</small><small>${lastOf(r)}</small></span></div>`),
    ];
    html += rows.length ? `<dl class="facts">${rows.join("")}</dl>` : `<p class="b-hint">No rules. ${name} may ${l.words.toLowerCase()} as chosen above.</p>`;
    if (C.followup) html += C.followup;
    if (C.form && isAdmin()) html += ruleForm(bot, l);
    else if (isAdmin()) html += `<div class="b-actions" style="margin-top:8px">${button("Add a rule", 'data-c="form-open" data-size="sm"')}</div>`;
    return html;
  }

  // What the new rule will change, worked out from the rules already there (section 6, F-328).
  function predictLine(bot, l, f) {
    if (!f.from) return "";
    const say = (t) => `<p class="c-sentence" data-testid="form-predict">${t}</p>`;
    if (f.pattern !== FROM_TARGET || f.action !== "allow") return say("The new rule applies to future matching calls.");
    const before = decide(bot, l.id, FROM_TARGET);
    if (before.verdict === "never") return say(`${esc(before.words.charAt(0).toUpperCase() + before.words.slice(1))} still refuses this call.`);
    if (before.rule && before.rule.action === "ask")
      return say("This Allow leaves the matching Ask in place.") + (isAdmin() ? `<div class="b-actions">${button("Change that rule to Allow", `data-c="asker-allow" data-value="${before.rule.id}" data-size="sm"`)}</div>` : "");
    if (before.verdict === "ask") return say("This Allow passes the plugin's fallback for this request. Gateway policy still applies.");
    return say("The new rule applies to future matching calls.");
  }
  function ruleForm(bot, l) {
    const name = esc(botName(bot));
    const f = C.form;
    const len = f.pattern.length;
    const count = (a) => (RULESET[bot] || []).filter((r) => r.action === a).length;
    let error = "";
    if (len > 1000) error = `A rule can be at most 1,000 characters. This one is ${len.toLocaleString("en-US")}.`;
    else if (count(f.action) >= LIMIT[f.action]) error = `${name} has ${LIMIT[f.action]} ${f.action === "allow" ? "allow" : f.action === "ask" ? "ask" : "never"} rules, the most a scope can hold. Remove one to add another.`;
    else if (f.tried && (RULESET[bot] || []).some((r) => r.line === l.id && r.action === f.action && r.pattern === f.pattern)) error = `${name} already has this rule.`;
    const ready = len > 0 && !error;
    return (
      `<div class="c-form" role="group" aria-label="Add a rule">` +
      `<p class="b-hint" style="margin:0">A rule is built from choices: nothing on the gateway can evaluate a sentence. Add a note in your own words if it helps.</p>` +
      (f.from ? `<p class="b-hint" style="margin:0" data-testid="form-from">${f.live ? `Filled in from ${name}'s request at ${f.from}. Adding it doesn't answer or run that request.` : `Filled in from ${name}'s expired request at ${f.from}. The expired call doesn't run.`}</p>` : "") +
      `<p style="margin:0">When ${name} wants to: <b>${l.words.toLowerCase()}</b></p>` +
      `<label>acting on:<input class="input" data-c-pattern value="${esc(f.pattern)}" placeholder="${KIND_EXAMPLE[l.kind]}" aria-describedby="c-pattern-help${error ? " c-pattern-error" : ""}"${error ? ' aria-invalid="true"' : ""} spellcheck="false" autocomplete="off" /></label>` +
      `<p class="b-hint" id="c-pattern-help" style="margin:0">${KIND_HELP[l.kind].replace("Otto", name)}</p>` +
      (error ? `<p class="b-field-error" id="c-pattern-error" role="alert" style="margin:0">${error}</p>` : "") +
      `<label>It should:<select class="input" data-c-action>${Object.entries(ACTION_WORDS)
        .map(([v, w]) => `<option value="${v}"${f.action === v ? " selected" : ""}>${w}</option>`)
        .join("")}</select></label>` +
      (f.action === "ask" ? askLimits(bot) : "") +
      (f.pattern && !error ? predictLine(bot, l, f) : "") +
      `<label>Note (optional):<input class="input" data-c-note value="${esc(f.note || "")}" placeholder="In your own words" autocomplete="off" /></label>` +
      `<p class="b-hint" style="margin:0">Shown beside the rule. Nothing evaluates it.</p>` +
      `<div class="b-actions">${button("Add rule", `data-c="form-add" data-size="sm"${ready ? "" : " disabled"}`, "primary")}${button("Cancel", 'data-c="form-cancel" data-size="sm"', "quiet")}</div>` +
      `</div>`
    );
  }

  // Messaging other bots (section 11) -------------------------------------------------------------

  const MSG = p("msg") || "";
  const PAIRS = MSG === "gateway" ? [["marlow", "pip"]] : null; // null: bots may message each other
  // Outgoing lists only; whether a bot's sends ask first is its Message other bots line (P), one source.
  const M = new Proxy({}, { get: (o, k) => (typeof k === "string" && !(k in o) && app.bots.some((b) => b.id === k) ? (o[k] = { out: "gateway", outOnly: [] }) : o[k]) });
  M.marlow = { out: "some", outOnly: ["pip"] };
  M.pip = { out: "some", outOnly: ["marlow"] };
  const asksToSend = (bot) => P[bot].message.by === "rule";
  if (MSG === "none") M.otto.out = "none";
  if (MSG === "some") Object.assign(M.otto, { out: "some", outOnly: ["pip"] });
  const pairAllows = (a, b) => !PAIRS || PAIRS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  function effectiveTargets(bot) {
    const m = M[bot];
    const others = app.bots.filter((b) => b.id !== bot).map((b) => b.id);
    const byPairs = others.filter((o) => pairAllows(bot, o));
    const list = m.out === "none" ? [] : m.out === "some" ? m.outOnly.filter((o) => byPairs.includes(o)) : byPairs;
    return list;
  }
  const names = (ids) => (ids.length ? (ids.length === app.bots.length - 1 && !PAIRS ? "any bot" : ids.map(botName).join(", ").replace(/, ([^,]*)$/, " and $1")) : "no bot");
  function messagingShort(id) {
    if (heldLines(id).includes("message")) return "Never. The gateway denies sessions_send";
    const t = effectiveTargets(id);
    return `May message ${names(t)}${asksToSend(id) && t.length ? (running() ? ", asks first" : ", ask not enforced now") : ""}`;
  }
  function messagingView(bot) {
    const name = esc(botName(bot));
    const m = M[bot];
    const dis = isAdmin() ? "" : " disabled";
    const others = app.bots.filter((b) => b.id !== bot);
    let html = sub("Messaging other bots", "rules", `Back to what ${name} may do`);
    const t = effectiveTargets(bot);
    html += heldLines(bot).includes("message")
      ? `<p class="c-effective" role="status"><b>Effective:</b> Never. The gateway denies sessions_send.</p>`
      : `<p class="c-effective" role="status"><b>Effective:</b> ${name} may message ${esc(names(t))}${t.length && asksToSend(bot) && running() ? ", asking you first" : ""}. <span class="b-faint">From the gateway's settings and ${name}'s.</span></p>`;
    html += `<dl class="facts">${fact("For every bot", PAIRS ? "Only these pairs may message each other: Marlow and Pip." : "Bots may message each other.")}</dl><p class="c-sentence">${mark("set")}</p>`;
    // Outgoing: the gateway's list.
    const outRadios = [
      ["gateway", "Use the gateway's list"],
      ["some", "Only these"],
      ["none", "No bot"],
    ]
      .map(([v, l]) => `<div><button type="button" class="b-open" role="radio" aria-checked="${m.out === v}" tabindex="${m.out === v ? 0 : -1}" data-c="msg-out" data-value="${v}"${dis}><span>${l}</span>${m.out === v ? icon("check") : ""}</button></div>`)
      .join("");
    html += `<h4 class="b-group" id="c-out-label">${name} may message:</h4><dl class="facts" role="radiogroup" aria-labelledby="c-out-label">${outRadios}</dl>`;
    if (m.out === "some")
      html +=
        `<dl class="facts" style="margin-top:8px">${others
          .map((o) => {
            const ok = pairAllows(bot, o.id);
            return `<div class="b-row"><label class="b-check"><input type="checkbox" data-c-peer="out" value="${o.id}"${m.outOnly.includes(o.id) ? " checked" : ""}${dis}${ok ? "" : " disabled"} /> ${esc(o.name)}${ok ? "" : ` <span class="b-faint">· Not a permitted pair on this gateway</span>`}</label></div>`;
          })
          .join("")}</dl>` + (m.outOnly.length ? "" : `<p class="b-field-error" role="alert">Choose at least one bot, or choose No bot. Nothing is saved until then.</p>`);
    html += `<p class="c-sentence">${mark("gateway")} ${name}'s own list, agentToAgent.send.</p>`;
    html += `<dl class="facts" style="margin-top:8px">${switchRow("Ask me first", running() ? `A card asks you before each message ${name} sends. ${markWords("plugin")}.` : "Asking needs Clawtrate's rules plugin running.", asksToSend(bot) && running(), `data-c="msg-out-ask"${running() ? dis : " disabled"}`, "Ask me first, outgoing")}</dl>`;
    html += `<p class="b-hint">Messages from other bots: about 41,200 tokens of ${name}'s this week, counting only runs a send's result names. <button type="button" class="link-button" data-bs="usage">See Usage</button></p>`;
    return html;
  }

  // Settings, Permissions (sections 7, 8, 9) ---------------------------------------------------

  CT.botsSections.push(["permissions", "Permissions"]);
  CT.botsSectionViews = CT.botsSectionViews || {};
  CT.botsSectionViews.permissions = ({ back }) => {
    const seg =
      `<div class="seg c-section-seg" role="radiogroup" aria-label="Permissions">` +
      [
        ["rules", "Rules"],
        ["saved", "Saved approvals"],
        ["activity", "Activity"],
      ]
        .map(([v, l]) => `<button type="button" role="radio" aria-checked="${C.part === v}" tabindex="${C.part === v ? 0 : -1}" data-c="part" data-value="${v}">${l}</button>`)
        .join("") +
      `</div>`;
    const view = C.part === "saved" ? savedPart() : C.part === "activity" ? activityPart() : rulesPart();
    return { title: "Permissions", back, body: pluginLine("otto").replace("Otto's rules", "these rules") + seg + view.body, foot: view.foot || "" };
  };

  function rulesPart() {
    let body =
      `<h4 class="b-group">Set on the gateway for every bot</h4>` +
      `<p class="c-subgroup">Ceilings</p><dl class="facts">` +
      fact("Never", `Use the browser${C.override ? ", Search the web" : ""}`) +
      fact("Tools offered", "The coding profile") +
      fact("Messaging", PAIRS ? "Only Marlow and Pip, with each other" : "Bots may message each other") +
      `</dl><p class="b-hint">No bot's own settings can grant these back. ${mark("set")}</p>` +
      `<p class="c-subgroup">Defaults</p><dl class="facts">` +
      fact("Commands", "Never, for bots that set none") +
      `</dl><p class="b-hint">A bot's own setting replaces a default for that bot, wider or narrower. ${mark("set")}</p>` +
      `<dl class="facts">${fact("media-box's approvals file", isAdmin() ? (C.override ? "Always ask" : "Ask for commands not on its allowlist") : `<span class="b-faint">Seeing a machine's approvals needs admin access.</span>`)}</dl>` +
      `<p class="b-hint">Set on the gateway. Clawtrate can't change it.</p>`;
    body += `<h4 class="b-group">Rules for every bot</h4>`;
    if (!running()) body += `<p class="b-hint">${PLUGIN_WORDS[C.plugin].replace("Otto's rules", "These rules")} ${RULESET["*"].length ? `${RULESET["*"].length} ${RULESET["*"].length === 1 ? "rule for every bot isn't" : "rules for every bot aren't"} enforced now.` : ""}</p>`;
    else {
      body += `<dl class="facts">${RULESET["*"]
        .map((r) => `<div class="b-row"><span class="b-row-main"><span>${ACTION_SHORT[r.action]} · ${esc(r.words || lineOf(r.line).words)}${r.words ? "" : ` under <code>${esc(r.pattern)}</code>`}</span><small>Every bot · version ${r.version} · set ${esc(r.set)} · ${markWords("plugin")}</small></span>${isAdmin() ? button("Remove", `data-c="all-remove" data-value="${r.id}" data-size="sm"`, "quiet") : ""}</div>`)
        .join("")}</dl>`;
      if (isAdmin()) body += `<div class="b-actions" style="margin-top:8px">${button("Add a rule", 'data-c="all-add" data-size="sm"')}</div>`;
    }
    body += `<h4 class="b-group">Each bot</h4><dl class="facts">` + app.bots.map((b) => openRow(esc(b.name), countWords(counts(b.id), b.id), `data-c="open-bot-rules" data-value="${b.id}"`)).join("") + `</dl>`;
    body +=
      `<h4 class="b-group">What a new bot starts with</h4><dl class="facts">` +
      fact("Run commands", "Uses the gateway's command policy") +
      fact("Direct tool access", "Proposed deny list: gateway, plugins and openclaw") +
      fact("T3 Code", "Proposed default: Off") +
      fact("Everything else", "As the gateway's settings for every bot") +
      `</dl>` +
      `<p class="b-hint">New bot writes no command mode or tool deny list. The gateway's command policy applies from creation.</p>`;
    return { body, foot: isAdmin() ? "" : adminBar("Changing rules for every bot needs admin access.") };
  }

  const ROUTINE_GRANTS = [{ id: "rg1", what: "Routine Weekly cleanup (Otto) may run <code>du -sh /srv</code> in <code>/srv</code>", grant: "grant 3f2a", granted: "granted Nov 12", until: "until Dec 12", used: "used 4 times, last Nov 17, 3:00 AM" }];
  const ALLOW = [{ id: "al1", what: "<code>ls</code> · Otto · on the gateway's machine · from Always allow", used: "last used 5:40 PM · covers what the gateway matches it to, which can be wider than this exact command" }];

  function savedPart() {
    if (!canApprove())
      return {
        body: `<p class="b-hint">A standing approval lets a call run without a card later.</p>`,
        foot: `<section class="access-bar" role="region" aria-label="Access"><div class="access-row">${icon("eye")}<span class="shelf-text"><b>Read-only.</b> Seeing saved approvals needs approvals access.</span>${button("Request access", 'data-b="request-write" data-size="sm"', "primary")}</div></section>`,
      };
    if (p("saved") === "error") return { body: failed("Couldn't load saved approvals", "saved-retry") };
    if (p("saved") === "empty") return { body: `<div class="work-empty"><span class="empty-mark">${icon("approval")}</span><h4>No saved approvals</h4><p>When a routine's command is allowed for some days, or a command's card adds it to a machine's allowlist, it is listed here.</p></div>` };
    const row = (g, kind, action) => {
      const gone = C.revoked.has(g.id);
      return (
        `<div class="b-row"><span class="b-row-main"><span${gone ? ' class="c-struck"' : ""}>${g.what}</span>` +
        `<small>${[g.grant, g.granted, g.until, g.used].filter(Boolean).join(" · ")}${kind === "allow" ? " · When it was added isn't recorded." : ""}</small><small>${markWords("gateway")}</small>` +
        (gone ? `<small role="status">${kind === "allow" ? "Removed 5:50 PM. Otto asks again the next time it runs this on that machine." : "Revoked 5:50 PM. The routine's next matching command no longer runs under this grant."}</small>` : "") +
        `</span>${gone ? "" : action}</div>`
      );
    };
    let body = `<p class="b-hint" style="margin-top:0">The standing approvals the gateway keeps. Clawtrate's rules plugin makes none: its standing permissions are its Allow rules, in Rules.</p>`;
    body += `<h4 class="b-group">Routines' grants</h4><dl class="facts">${ROUTINE_GRANTS.map((g) => row(g, "routine", button("Revoke", `data-c="revoke" data-value="${g.id}" data-size="sm"`))).join("")}</dl>`;
    body += `<h4 class="b-group">Machines' allowlists</h4>`;
    body += isAdmin() ? `<dl class="facts">${ALLOW.map((g) => row(g, "allow", button("Remove…", `data-c="allow-remove" data-value="${g.id}" data-size="sm"`, "quiet"))).join("")}</dl>` : `<p class="b-hint">Seeing machines' allowlists needs admin access.</p>`;
    body += `<p class="b-hint">The gateway also keeps short grants for some commands on paired machines. It doesn't list them, so they aren't here; each ends within 30 days, or when the machine's pairing changes.</p>`;
    return { body, foot: isAdmin() ? "" : adminBar("Removing an allowlist entry needs admin access.") };
  }

  // The audit log's records, and what joins to them (section 9).
  const LOG = [
    { id: "e1", time: "5:46 PM", bot: "otto", task: "Disk almost full on the media box", what: "write", tag: "Allowed", tone: "", cause: "Cause not recorded", needs: null },
    { id: "e2", time: "5:44 PM", bot: "otto", task: "Disk almost full on the media box", what: "exec", tag: "Asked", tone: "warn", cause: "Recorded: answered Allow once", needs: "approvals" },
    { id: "e3", time: "5:43 PM", bot: "otto", task: "Disk almost full on the media box", what: "write · secrets/api.env", tag: "Blocked", tone: "danger", cause: "Recorded: Otto's rule 'never under secrets/**', version 1 (now version 2)", needs: null, step: "o1" },
    { id: "e4", time: "5:40 PM", bot: "otto", task: "Weekly backup check", what: "exec", tag: "Allowed", tone: "", cause: "Cause not recorded", needs: null },
    { id: "e5", time: "5:31 PM", bot: "marlow", task: "Main", what: "sessions_send", tag: "Blocked", tone: "danger", cause: "Inferred: Marlow's messaging list didn't name Pip when it was read at 5:30 PM", needs: null },
    { id: "e6", time: "5:12 PM", bot: "juniper", task: "Heat pump vs. gas furnace", what: "web_search", tag: "Allowed", tone: "", cause: "Cause not recorded", needs: null },
    { id: "e7", time: "3:00 AM", bot: "otto", task: "Weekly cleanup (routine)", what: "exec", tag: "Allowed", tone: "", cause: "Cause not recorded", needs: null },
    { id: "e8", time: "2:58 AM", bot: "pip", task: "Plan the week", what: "write", tag: "Denied", tone: "danger", cause: "Recorded: answered Deny", needs: "approvals" },
  ];
  const OLDER = [{ id: "e9", time: "Nov 17", bot: "otto", task: "Router firmware", what: "web_fetch", tag: "Allowed", tone: "", cause: "Cause not recorded", needs: null }];
  function activityPart() {
    const a = p("audit");
    if (a === "error") return { body: failed("Couldn't load activity", "audit-retry") };
    if (a === "loading") return { body: skeleton("Loading activity", 5) };
    if (a === "off") return { body: `<div class="work-empty"><span class="empty-mark">${icon("eye")}</span><h4>No activity recorded</h4><p>The gateway isn't recording activity: its audit log is switched off in its settings.</p></div>` };
    const verdicts = ["All", "Allowed", "Asked", "Denied", "Blocked"];
    const filters =
      `<div class="c-filters" role="group" aria-label="Filters">` +
      `<label class="b-hint" style="margin:0">Bot <select class="input" data-c-auditbot><option value="all">Every bot</option>${app.bots.map((b) => `<option value="${b.id}"${C.auditBot === b.id ? " selected" : ""}>${esc(b.name)}</option>`).join("")}</select></label>` +
      `<label class="b-hint" style="margin:0">Verdict <select class="input" data-c-verdict>${verdicts.map((v) => `<option value="${v.toLowerCase()}"${C.auditVerdict === v.toLowerCase() ? " selected" : ""}>${v}</option>`).join("")}</select></label>` +
      `</div>`;
    const all = a === "empty" ? [] : C.older ? [...LOG, ...OLDER] : LOG;
    const rows = all.filter((e) => (C.auditBot === "all" || e.bot === C.auditBot) && (C.auditVerdict === "all" || e.tag.toLowerCase() === C.auditVerdict));
    const list = rows.length
      ? `<ul class="c-logs">${rows
          .map((e) => {
            const cause = e.needs && !canApprove() ? "Needs approvals access" : e.cause;
            return (
              `<li><button type="button" class="c-log" data-c="log" data-value="${e.id}" aria-expanded="${C.logOpen === e.id}" aria-label="${esc(`${e.time}, ${botName(e.bot)}, ${e.what}, ${e.tag}, ${cause}`)}">` +
              `<span class="c-log-time">${e.time}</span><span class="avatar" aria-hidden="true">${CT.character(e.bot)}</span><span class="c-log-what"><span class="mono">${esc(e.what)}</span><br /><span class="b-faint">${esc(e.task)}</span></span>` +
              `<span class="c-tag"${e.tone ? ` data-tone="${e.tone}"` : ""}>${e.tag}</span><span class="c-log-source">${esc(cause)}</span></button>` +
              (C.logOpen === e.id
                ? `<div class="c-log-open"><dl class="facts">${fact("Run", `<span class="mono">run 7c1e…${e.id}</span>`)}${fact("Call", `<span class="mono">sha256:4b2f…${e.id}</span>`)}${fact("The gateway's record", `<span class="mono">${e.id}-4b2f</span>`)}${fact("Kept until", "Dec 18")}</dl>${e.step ? `<div class="b-actions" style="margin-top:8px">${button("Show in chat", `data-c="show-in-chat" data-value="${e.id}" data-size="sm"`)}</div>` : `<p class="b-hint">This step isn't in a task this device has loaded.</p>`}</div>`
                : "") +
              `</li>`
            );
          })
          .join("")}</ul>`
      : `<div class="work-empty"><span class="empty-mark">${icon("list")}</span><h4>No tool activity in the last 30 days.</h4><p>What your bots do with their tools shows here.</p></div>`;
    const body =
      `<p class="b-lead" style="text-align:left;margin-top:0">What your bots did with their tools, and what a record says caused it.</p>` +
      filters +
      list +
      (rows.length && !C.older && a !== "empty" ? `<div class="b-actions" style="margin-top:8px">${button("Show older", 'data-c="older" data-size="sm"', "quiet")}</div>` : "") +
      (a === "partial" ? `<p class="b-hint">Records before Oct 19 have expired.</p>` : "") +
      `<p class="b-hint">The gateway keeps 30 days of activity, up to 100,000 records, without arguments or results. A call to a tool the gateway removed leaves no record here.</p>`;
    return { body };
  }

  // Wiring ---------------------------------------------------------------------------------------

  CT.botsPageViews = Object.assign(CT.botsPageViews || {}, { rules: rulesView, rule: ruleView, messaging: messagingView });
  // What each page's access bar says below admin (section 2, Access).
  CT.botsPageNeeds = Object.assign(CT.botsPageNeeds || {}, {
    rules: (n) => `Changing ${n}'s permissions needs admin access.`,
    rule: (n) => `Changing ${n}'s permissions needs admin access.`,
    messaging: (n) => `Changing ${n}'s messaging needs admin access.`,
    memory: (n) => `Changing ${n}'s memory needs admin access. The gateway lets only admin connections write a bot's files.`,
    memitem: (n) => `Changing ${n}'s memory needs admin access. The gateway lets only admin connections write a bot's files.`,
    machine: (n) => `Changing where ${n} runs needs admin access.`,
    usage: () => "Pausing a routine needs admin access. A budget is yours to set.",
  });

  const rerenderTab = () => BS.render();
  const rerenderSettings = () => D.renderSettings();

  function save(bot, apply, words) {
    if (!isAdmin() || C.saving) return;
    const mode = C.write;
    C.write = null;
    if (mode === "refused") {
      C.saveNote = note(`<p>Couldn't save: the gateway refused the change. Nothing changed.</p>`, "danger");
      rerenderTab();
      announce("Couldn't save");
      return;
    }
    if (mode === "conflict") {
      C.saveNote = note(`<p>Someone else changed ${esc(botName(bot))}'s settings. This shows what the gateway has now.</p>`, "warn");
      rerenderTab();
      announce("Someone else changed these settings");
      return;
    }
    C.saving = true;
    rerenderTab();
    setTimeout(
      () => {
        C.saving = false;
        apply();
        C.saveNote =
          mode === "timeout"
            ? `<p class="b-hint" role="status">Checked whether this was saved: it was.</p>`
            : null;
        rerenderTab();
        announce(`Saved. ${words}`);
      },
      mode === "timeout" ? 900 : 250,
    );
  }

  document.addEventListener(
    "click",
    (event) => {
      // Before bot-settings.js navigates: remember which line opens, and where Back returns.
      const nav = event.target.closest("[data-bs]");
      if (nav && panel.contains(nav)) {
        if (nav.dataset.cLine) C.line = nav.dataset.cLine;
        const to = nav.dataset.bs;
        const from = BS.S.view;
        if (to !== from) {
          C.saveNote = null;
          C.form = to === "rule" && p("form") === "open" && !C.formSeen ? C.form : null;
          C.formSeen = true;
        }
        if (to === "rules" && (from === "rule" || from === "messaging")) {
          const target = from === "rule" ? `.c-line[data-c-line="${C.line}"]` : '.c-line[data-bs="messaging"]';
          setTimeout(() => $(target, panel)?.focus(), 40);
        }
      }
    },
    true,
  );

  document.addEventListener("click", (event) => {
    const t = event.target.closest("[data-c]");
    if (!t) return;
    const what = t.dataset.c;
    const value = t.dataset.value;
    const bot = current();
    if (t.getAttribute("aria-disabled") === "true" || t.disabled) return;
    switch (what) {
      case "reload":
        C.state = "ready";
        return rerenderTab();
      case "hold":
        // One config.patch; the lines change only once the read-back has the entries.
        C.hold = "writing";
        C.holdBot = bot;
        C.holdLines = pluginLines(bot);
        rerenderTab();
        return setTimeout(() => {
          C.hold = "done";
          rerenderTab();
          announce(`Saved. ${lineList(pluginLines(bot))} denied in ${botName(bot)}'s settings`);
        }, 300);
      case "to-lines":
        return $("#panel-settings .c-line")?.focus();
      case "exec-ask":
        return save(bot, () => Object.assign(P[bot].exec, { mode: "ask", value: "ask", by: "bot" }), "Configured command policy: ask");
      case "asker-allow": {
        const r = (RULESET[bot] || []).find((x) => x.id === value);
        if (!r) return;
        Object.assign(r, { action: "allow", version: r.version + 1, set: "Just now" });
        rerenderTab();
        return announce(`Saved. ${botName(bot)}'s rule '${r.pattern}' allows without asking, version ${r.version}`);
      }
      case "ask-once":
      case "ask-deny":
        return answerCard(t.closest(".request"), what === "ask-once");
      case "card-make-rule":
        C.form = { pattern: FROM_TARGET, action: "allow", note: "", from: "5:44 PM", live: true };
      // falls through: the form is on the Change files page
      case "to-rules-list":
        C.line = "files";
        app.setPanel(true);
        BS.S.view = "rule";
        $("#tab-settings").click();
        return BS.render(true);
      case "show-task": {
        app.setPanel(false);
        app.openTask("otto", "o1");
        return setTimeout(() => $("#transcript .request[data-state='pending']:last-of-type, #transcript [data-testid='followup']")?.scrollIntoView({ block: "center" }), 40);
      }
      case "choose": {
        const l = lineOf(C.line);
        const s = P[bot][l.id];
        const cur = heldLines(bot).includes(l.id) ? "never" : s.by === "rule" ? "ask" : s.value;
        if (cur === value) return;
        return save(
          bot,
          () => {
            P[bot][l.id] = { value, by: value === "allow" ? "default" : value === "ask" ? "rule" : "bot", set: value === "ask" ? "Just now, from this device, version 1" : undefined };
            if (value !== "never") release(bot, l.id);
          },
          `${l.words}: ${value === "allow" ? "allowed" : value === "ask" ? "asks first" : "never"}`,
        );
      }
      case "exec": {
        const s = P[bot].exec;
        if (s.mode === value) return;
        const apply = () => {
          Object.assign(P[bot].exec, { mode: value, value: value === "full" ? "allow" : value === "deny" ? "never" : "ask", by: "bot" });
          if (value !== "deny") release(bot, "exec");
        };
        const words = `Run commands: ${EXEC.find(([v]) => v === value)[1].toLowerCase()}`;
        if (value === "full")
          return D.confirmBox({
            title: `Let ${botName(bot)} run any command without asking?`,
            text: "It can then change or delete anything the machine's user can, including the gateway's settings and its rules.",
            label: "Allow all commands",
            run: () => {
              save(bot, apply, words);
              setTimeout(() => $('[data-c="exec"][data-value="full"]', panel)?.focus(), 300);
            },
          });
        return save(bot, apply, words);
      }
      case "review": {
        const s = P[bot].exec;
        return save(bot, () => Object.assign(s, { mode: s.mode === "auto" ? "ask" : "auto", value: "ask" }), `Review commands automatically: ${s.mode === "auto" ? "off" : "on"}`);
      }
      case "fallback":
        return save(bot, () => (P[bot].fallback = !P[bot].fallback), `Ask when nothing else decides: ${P[bot].fallback ? "off" : "on"}`);
      case "open-permissions":
        C.part = "rules";
        return D.openSettings(t, "permissions");
      case "to-record":
        C.part = "activity";
        C.logOpen = value;
        C.auditBot = "all";
        C.auditVerdict = "all";
        return D.openSettings(t, "permissions");
      case "to-saved":
        C.part = "saved";
        return D.openSettings(t, "permissions");
      case "form-open":
        C.form = { pattern: "", action: "never", note: "" };
        rerenderTab();
        return setTimeout(() => $("[data-c-pattern]", panel)?.focus(), 30);
      case "form-cancel":
        C.form = null;
        rerenderTab();
        return setTimeout(() => $('[data-c="form-open"]', panel)?.focus(), 30);
      case "form-add": {
        const l = lineOf(C.line);
        C.form.tried = true;
        if ((RULESET[bot] || []).some((r) => r.line === l.id && r.action === C.form.action && r.pattern === C.form.pattern)) return rerenderTab();
        (RULESET[bot] = RULESET[bot] || []).unshift({ id: `n${(seq += 1)}`, line: l.id, action: C.form.action, pattern: C.form.pattern, version: 1, set: "Just now", note: (C.form.note || "").trim(), last: null });
        const added = ACTION_SHORT[C.form.action];
        const from = C.form.from ? C.form.pattern : null;
        C.form = null;
        // From an expired card: Otto makes the same call again, and the order of section 3 decides it.
        if (from) nextCall(bot, l.id, from);
        rerenderTab();
        announce(`Rule added: ${added}`);
        return setTimeout(() => $('[data-c="form-open"]', panel)?.focus(), 30);
      }
      case "rule-remove":
        RULESET[bot] = RULESET[bot].filter((r) => r.id !== value);
        rerenderTab();
        return announce("Rule removed");
      case "rule-edit":
        return announce("Editing a rule opens the same form, filled in, and saves a new version.");
      case "msg-out": {
        M[bot].out = value;
        rerenderTab();
        return announce(`Saved. ${botName(bot)} may message ${names(effectiveTargets(bot))}`);
      }
      case "msg-out-ask": {
        P[bot].message = asksToSend(bot) ? { value: "allow", by: "default" } : { value: "ask", by: "rule", set: "Just now, from this device, version 1" };
        rerenderTab();
        return announce(`Saved. Ask me first: ${asksToSend(bot) ? "on" : "off"}`);
      }
      case "show-request":
        return announce("The request is in Otto's task 'Disk almost full on the media box'.");
      case "part":
        C.part = value;
        return rerenderSettings();
      case "open-bot-rules":
        $("#settings-dialog").close();
        app.openTask(value, app.bots.find((b) => b.id === value).tasks[0].id);
        BS.S.view = "rules";
        return CT.botsOpenSettings ? (CT.botsOpenSettings(value, "rules"), BS.render(true)) : BS.render(true);
      case "all-remove":
        RULESET["*"] = RULESET["*"].filter((r) => r.id !== value);
        rerenderSettings();
        return announce("Rule removed");
      case "all-add":
        return announce("Adding a rule for every bot uses the same form, with the action as a choice of lines.");
      case "revoke":
        C.revoked.add(value);
        rerenderSettings();
        return announce("Revoked");
      case "allow-remove":
        return D.confirmBox({
          title: "Remove this allowlist entry?",
          text: "Otto asks again the next time it runs ls on the gateway's machine. This rewrites that machine's approvals file.",
          label: "Remove",
          run: () => {
            C.revoked.add(value);
            rerenderSettings();
            announce("Removed");
          },
        });
      case "log":
        C.logOpen = C.logOpen === value ? null : value;
        return rerenderSettings();
      case "older":
        C.older = true;
        return rerenderSettings();
      case "show-in-chat": {
        const e = LOG.find((x) => x.id === value);
        $("#settings-dialog").close();
        app.openTask(e.bot, e.step);
        return setTimeout(() => {
          const step = $(`#transcript [data-record="${e.id}"]`);
          if (!step) return;
          step.scrollIntoView({ block: "center" });
          step.setAttribute("tabindex", "-1");
          step.focus();
          step.dataset.highlight = "true";
          announce("Showing the step in the chat");
        }, 60);
      }
      case "saved-retry":
      case "audit-retry":
        return rerenderSettings();
    }
  });

  document.addEventListener("input", (event) => {
    const t = event.target;
    if (t.matches("[data-c-pattern]") && C.form) {
      C.form.pattern = t.value;
      C.form.tried = false;
      const pos = t.selectionStart;
      rerenderTab();
      const f = $("[data-c-pattern]", panel);
      f?.focus();
      f?.setSelectionRange(pos, pos);
    }
  });
  document.addEventListener("change", (event) => {
    const t = event.target;
    if (t.matches("[data-c-action]") && C.form) {
      C.form.action = t.value;
      rerenderTab();
      $("[data-c-action]", panel)?.focus();
    }
    if (t.matches("[data-c-note]") && C.form) C.form.note = t.value;
    if (t.matches("[data-c-peer]")) {
      const list = M[current()][`${t.dataset.cPeer}Only`];
      if (t.checked && !list.includes(t.value)) list.push(t.value);
      if (!t.checked) list.splice(list.indexOf(t.value), 1);
      rerenderTab();
      $(`[data-c-peer="${t.dataset.cPeer}"][value="${t.value}"]`, panel)?.focus();
    }
    if (t.matches("[data-c-auditbot]")) {
      C.auditBot = t.value;
      rerenderSettings();
      $("[data-c-auditbot]")?.focus();
    }
    if (t.matches("[data-c-verdict]")) {
      C.auditVerdict = t.value;
      rerenderSettings();
      $("[data-c-verdict]")?.focus();
    }
  });

  // In the conversation (section 18) ----------------------------------------------------------------
  const otto = app.bots.find((x) => x.id === "otto");
  const diskTask = otto.tasks.find((x) => x.id === "o1");
  const refresh = (botId, taskId) => {
    if (app.model.selectedBot === botId && app.model.selectedTask === taskId) app.openTask(botId, taskId);
  };
  // The step Activity's record e3 opens (section 9).
  if (diskTask && typeof diskTask.html === "string")
    diskTask.html += `<div class="card turn-error" data-record="e3" data-testid="step-e3">${icon("warning")}<p class="turn-error-title">Blocked by policy: write secrets/api.env</p><p class="turn-error-reason">Clawtrate's rules plugin: Otto's rule 'never under secrets/**', version 1. Not run.</p></div>`;
  // A rules-plugin card: Allow once and Deny, never Always allow; at the allow limit, the limit and the way to the rules.
  const askCard = (n) => {
    const full = (RULESET.otto || []).filter((r) => r.action === "allow").length >= LIMIT.allow;
    return (
      `<section class="card request" data-kind="approval" data-state="pending" data-c-card="${n}" role="region" aria-label="Otto wants to change a file. Needs approval.">` +
      `<header class="request-head"><h3 class="request-title">Otto wants to change a file</h3><span class="tag" data-tone="warn">Needs approval</span></header>` +
      `<p class="request-summary">Write notes/disk-2026-11-18.md in Otto's workspace.</p>` +
      `<p class="request-asker">Asked by Clawtrate's rules plugin: Otto's rule 'Ask first · notes/**', version 1.</p>` +
      (canApprove()
        ? `<div class="request-actions"><button type="button" class="button" data-variant="primary" data-c="ask-once">Allow once</button><span class="spacer"></span><button type="button" class="button" data-variant="quiet" data-c="ask-deny">Deny</button></div>`
        : `<p class="request-ended">You can read this request but not answer it from this device.</p>`) +
      (full
        ? `<p class="c-sentence" data-testid="card-limit">Otto has 20 allow rules, the most a scope can hold. <button type="button" class="link-button" data-c="to-rules-list">Open the rules list</button></p>`
        : isAdmin()
          ? `<p class="c-sentence"><button type="button" class="link-button" data-c="card-make-rule">Make a rule…</button></p>`
          : "") +
      `<p class="request-foot">The rules plugin asks for a 10-minute wait.</p></section>`
    );
  };
  let asked = 0;
  function answerCard(card, once) {
    if (!card || !diskTask || !canApprove()) return;
    const n = card.dataset.cCard;
    const resolved =
      `<section class="card request" data-kind="approval" data-state="resolved" data-c-card="${n}" role="region" aria-label="Otto wanted to change a file. ${once ? "Allowed once" : "Denied"}.">` +
      `<header class="request-head"><h3 class="request-title">Otto wanted to change a file</h3><span class="tag">${once ? "Allowed once" : "Denied"}</span></header>` +
      `<p class="c-outcome">Your answer: ${once ? "Allowed once" : "Denied"}, 5:44 PM.</p><p class="c-outcome">Then: ${once ? "Ran." : "Not run."}</p>` +
      `<p class="c-outcome">Nothing was saved and no rule was removed.</p></section>` +
      (once ? `<div class="event-line" data-side="center" data-testid="ran-line">Otto wrote notes/disk-2026-11-18.md</div>` : "");
    diskTask.html = diskTask.html.replace(card.outerHTML, resolved);
    if (!diskTask.html.includes(resolved)) diskTask.html = diskTask.html.replace(new RegExp(`<section class="card request" data-kind="approval" data-state="pending" data-c-card="${n}"[\\s\\S]*?</section>`), resolved);
    refresh("otto", "o1");
    announce(once ? "Allowed once" : "Denied");
    // Otto makes the same call again: the rule still asks, so a new card.
    if (once && asked < 5)
      setTimeout(() => {
        asked += 1;
        diskTask.html += `<div class="event-line" data-side="center">Otto tries the same write again.</div>` + askCard(asked);
        refresh("otto", "o1");
      }, 200);
  }
  if (p("ask") === "full" && diskTask) {
    asked = 1;
    diskTask.html += askCard(1);
  }
  // After a rule made from an expired card, the next matching call, decided by the order of section 3.
  function nextCall(bot, lineId, target) {
    const d = decide(bot, lineId, target);
    if (!diskTask) return;
    diskTask.html +=
      d.verdict === "ask"
        ? `<div data-testid="followup">${askCard(9).replace("Otto's rule 'Ask first · notes/**', version 1", d.words.replace(/^./, (c) => c.toUpperCase()))}</div>`
        : d.verdict === "never"
          ? `<div class="card turn-error" data-testid="followup">${icon("warning")}<p class="turn-error-title">Blocked by policy: write ${esc(target)}</p></div>`
          : `<div class="event-line" data-side="center" data-testid="followup">Otto wrote ${esc(target)}. No card: no rule asks.</div>`;
    C.followup = `<p class="c-sentence" role="status" data-testid="followup-line">Otto made the same call again: ${d.verdict === "ask" ? "it asked first" : d.verdict === "never" ? "it was refused" : "it ran without asking"}, as the form said. <button type="button" class="link-button" data-c="show-task">Show the task</button></p>`;
  }
  if (p("asker") === "fallback") P.otto.fallback = true;
  refresh("otto", "o1");
  // An example of the gateway's own card for a command missing the machine allowlist (section 10).
  if (p("cmd") === "create" && p("cmdpolicy") === "ask") {
    const pip = app.bots.find((x) => x.id === "pip");
    P.pip.exec = { value: "ask", mode: "ask", by: "bot" };
    const pt = pip.tasks.find((x) => x.id === "p1");
    pt.html =
      `<div class="turn" data-role="user"><div class="msg" data-role="user"><div class="bubble">Make yourself a helper bot for the trip planning.</div></div></div>` +
      `<section class="card request" data-kind="approval" data-state="pending" data-testid="create-card" role="region" aria-label="Pip wants to run a command. Needs approval.">` +
      `<header class="request-head"><h3 class="request-title">Pip wants to run a command</h3><span class="tag" data-tone="warn">Needs approval</span></header>` +
      `<p class="request-summary"><code>openclaw agents add helper --workspace workspaces/helper</code> on the gateway's machine</p>` +
      `<p class="request-asker">Asked by the gateway: Pip's configured command policy, Ask. The command isn't on the gateway machine's allowlist.</p>` +
      `<p class="request-foot">Example: a command missing the machine allowlist.</p></section>`;
    refresh("pip", "p1");
  }

  CT.ctl = { C, P, M, LINES, RULESET, mark, markWords, MARKS, lineState, counts, sub, openRow, fact, switchRow, skeleton, failed, sw, esc, icon, running, pluginMark, decide };
  window.controls = { C, P, M, RULESET, decide };
  BS.render();
})();
