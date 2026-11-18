// Controls (docs/design/controls.md): what a bot may do, one line's rule,
// rules about what a tool acts on, rules for every bot, saved approvals,
// activity, messaging between bots and what a new bot starts with. On top of
// bots.js, bot-settings.js and t3.js. Nothing here talks to a gateway: every
// value is a local fixture, and every state comes from the address.
//
// More address parameters (controls.md, section 23):
//   bview=rules|rule|messaging   a page in the bot's Settings tab; line=<id> for rule
//   section=permissions&part=rules|saved|activity
//   rules=noplugin|stopped|loading|error|fresh|stale
//   override=1   waiting=1   write=refused|timeout|conflict
//   form=open    pattern=long   limit=allow|ask
//   saved=empty|error|revoked    audit=empty|off|error|grant
//   msg=noplugin|none|some|gateway

(function () {
  const CT = window.CT;
  const app = window.app;
  const D = CT.botsData;
  const p = (name) => CT.params.get(name);
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name, cls) => CT.icon(name, cls);
  const { isAdmin, adminBar, button, note, copy, announce, B } = D;
  const BS = window.botSettings;
  const panel = $("#panel-settings");
  const botName = (id) => app.bots.find((b) => b.id === id)?.name || id;
  const current = () => app.model.selectedBot;
  const canApprove = () => B.access !== "read";

  // The enforcement mark (section 2): who holds the line, in words, never colour alone.
  const MARKS = {
    gateway: ["approval", "The gateway enforces this"],
    plugin: ["plug", "Clawtrate's rules plugin enforces this"],
    memory: ["plug", "Clawtrate's memory plugin enforces this"],
    budget: ["plug", "Clawtrate's budget plugin enforces this"],
    set: ["lock", "Set on the gateway"],
    shown: ["eye", "Shown only"],
  };
  const mark = (kind) => (kind && MARKS[kind] ? `<span class="c-mark">${icon(MARKS[kind][0])}${MARKS[kind][1]}</span>` : "");
  const markWords = (kind) => (kind && MARKS[kind] ? MARKS[kind][1] : "");

  // The rules plugin, as the gateway reports it.
  const RULES = p("rules") || "ready";
  const C = {
    plugin: RULES !== "noplugin",
    stopped: RULES === "stopped",
    state: ["loading", "error"].includes(RULES) ? RULES : "ready",
    line: p("line") || "files",
    part: p("part") || "rules",
    write: p("write") || null,
    waiting: p("waiting") === "1",
    override: p("override") === "1",
    form: p("form") === "open" ? { pattern: p("pattern") === "long" ? "a".repeat(1001) : "", action: "never" } : null,
    saveNote: null,
    revoked: new Set(p("saved") === "revoked" ? ["g1"] : []),
    auditFilter: p("audit") === "grant" ? "grant" : "all",
    auditBot: "all",
    logOpen: null,
    msgOpen: false,
  };

  // The lines of section 4: plain words, and the gateway's tools behind them.
  const LINES = [
    { id: "read", words: "Read files", icon: "read", tools: ["read", "ls"], kind: "path" },
    { id: "files", words: "Change files", icon: "write", tools: ["write", "edit", "apply_patch"], kind: "path" },
    { id: "exec", words: "Run commands", icon: "command", tools: ["exec", "process"], kind: "command" },
    { id: "web", words: "Search the web", icon: "web", tools: ["web_search", "web_fetch"], kind: "address" },
    { id: "message", words: "Message other bots", icon: "message", tools: ["sessions_send"], kind: "recipient" },
    { id: "tasks", words: "Look at its tasks", icon: "tasks", tools: ["sessions_list", "sessions_history"], kind: null },
    { id: "ask", words: "Ask you questions", icon: "question", tools: ["ask_user"], kind: null, fixed: true },
    { id: "routines", words: "Manage routines", icon: "clock", tools: ["automations", "cron"], kind: null },
    { id: "browser", words: "Use the browser", icon: "screen", tools: ["browser"], kind: "address" },
    { id: "gateway", words: "Change the gateway's settings", icon: "settings", tools: ["gateway", "plugins"], kind: null },
    { id: "coder", words: "Coding agent coder", icon: "code", tools: ["coder__*"], kind: "tool" },
    { id: "t3code", words: "T3 Code", icon: "plugin", tools: ["t3code__*"], kind: "tool" },
  ];
  const NOT_OFFERED = [
    ["Search posts on X", "x_search", "Comes with xAI; Otto's model is OpenAI's."],
    ["Run code", "code_execution", "Comes with xAI; Otto's model is OpenAI's."],
  ];
  const lineOf = (id) => LINES.find((l) => l.id === id);

  // What each bot has, as the gateway and the plugin would report it.
  // value: allow | ask | never. by: default | bot | rule | all | gateway | gwdefault.
  const base = () => ({
    read: { value: "allow", by: "default" },
    files: { value: "allow", by: "default" },
    exec: { value: "ask", mode: "ask", by: "bot" },
    web: { value: "allow", by: "default" },
    message: { value: "allow", by: "default" },
    tasks: { value: "allow", by: "default" },
    ask: { value: "allow", by: "fixed" },
    routines: { value: "allow", by: "default" },
    browser: { value: "never", by: "gateway" },
    gateway: C.plugin ? { value: "ask", by: "rule", set: "Nov 12, 4:02 PM, from this device", defaulted: true } : { value: "never", by: "bot", defaulted: true },
    coder: { value: "allow", by: "default" },
    t3code: { value: "never", by: "bot", t3: true },
  });
  const P = {};
  app.bots.forEach((b) => (P[b.id] = base()));
  Object.assign(P.otto, {
    exec: { value: "ask", mode: "auto", by: "bot" },
    message: C.plugin ? { value: "ask", by: "rule", set: "Nov 14, 9:20 AM, from this device" } : { value: "allow", by: "default" },
    routines: { value: "never", by: "bot" },
  });
  P.marlow.exec = { value: "never", mode: "deny", by: "bot" };
  P.pip.exec = { value: "never", mode: "deny", by: "bot" };
  P.juniper.exec = { value: "never", mode: "deny", by: "bot" };
  if (C.override) {
    // The gateway denies web search for every bot, and media-box always asks.
    P.otto.web = { value: "never", by: "gateway", own: "allow" };
    P.otto.exec.machineAlways = true;
  }
  // Rules about what a tool acts on, by scope ("*" is every bot).
  let seq = 10;
  const RULESET = {
    otto: C.plugin
      ? [
          { id: "r1", line: "files", action: "never", pattern: "secrets/**", set: "Nov 12, 4:05 PM" },
          { id: "r2", line: "exec", action: "ask", pattern: "rm *", set: "Nov 13, 8:40 PM" },
        ]
      : [],
    "*": C.plugin
      ? [
          { id: "a1", line: "files", action: "never", pattern: "**/.ssh/**", set: "Nov 10, 6:12 PM" },
          { id: "a2", line: "message", action: "ask", pattern: "*", set: "Nov 10, 6:14 PM", words: "Send messages on channels" },
        ]
      : [],
  };
  if (p("limit") === "allow") for (let i = 0; i < 20; i += 1) RULESET.otto.push({ id: `l${i}`, line: "files", action: "allow", pattern: `drafts/${i}/**`, set: "Nov 9" });
  if (p("limit") === "ask") for (let i = 0; i < 20; i += 1) RULESET.otto.push({ id: `k${i}`, line: "files", action: "ask", pattern: `outbox/${i}/**`, set: "Nov 9" });
  const rulesFor = (bot, line) => (RULESET[bot] || []).filter((r) => r.line === line);
  const allRulesFor = (line) => RULESET["*"].filter((r) => r.line === line && !r.words);
  const ACTION_WORDS = { allow: "Allow without asking", ask: "Ask first", never: "Never" };
  const ACTION_SHORT = { allow: "Allow", ask: "Ask first", never: "Never" };
  const KIND_HELP = {
    path: "A path in Otto's workspace. * matches within a folder, ** across folders.",
    command: "A command. * matches the rest of a word or line.",
    recipient: "A bot's name.",
    address: "An address. * matches within a part of it.",
    tool: "A tool of the server, or *.",
  };
  const KIND_EXAMPLE = { path: "For example, secrets/**", command: "For example, rm *", recipient: "For example, pip", address: "For example, *.example.net", tool: "For example, run_checks" };

  // A line's value, mark and words, in one place.
  function lineState(bot, id) {
    const s = P[bot][id];
    if (C.stopped && !["gateway", "fixed"].includes(s.by) && !(s.by === "bot" && s.value === "never")) return { word: "Unknown", tone: "warn", mark: "plugin", value: "unknown" };
    const word = s.value === "allow" ? "Allowed" : s.value === "ask" ? "Asks first" : "Never";
    let k = s.by === "gateway" || s.by === "gwdefault" ? "set" : s.by === "rule" || s.by === "all" ? "plugin" : s.value === "allow" && s.by !== "bot" ? "" : "gateway";
    if (id === "exec" && s.machineAlways) k = "set";
    return { word, mark: k, value: s.value };
  }
  function counts(bot) {
    const c = { allow: 0, ask: 0, never: 0 };
    LINES.forEach((l) => {
      const v = lineState(bot, l.id).value;
      if (c[v] !== undefined) c[v] += 1;
    });
    return c;
  }
  const countWords = (c) => `${c.allow} without asking · ${c.ask} ask first · ${c.never} never`;
  const countShort = (c) => `${c.allow} without asking, ${c.ask} ask first, ${c.never} never`;

  const sub = (title, backTo, backLabel) =>
    `<div class="b-subhead"><button type="button" class="icon-button" data-variant="quiet" data-bs="${backTo}" aria-label="${backLabel}">${icon("back")}</button>` +
    `<h3 tabindex="-1" data-bs-focus>${title}</h3></div>`;
  const openRow = (label, value, attrs) =>
    `<div><button type="button" class="b-open" ${attrs}><span>${label}</span><span class="b-open-value"><span>${value}</span></span>${icon("chevron")}</button></div>`;
  const fact = (label, value) => `<div><dt>${label}</dt><dd class="b-wrap-value">${value}</dd></div>`;
  const sw = (on, attrs, label) => `<button type="button" class="b-switch" role="switch" aria-checked="${on}" aria-label="${label}" ${attrs}></button>`;
  const switchRow = (title, subline, on, attrs, label) =>
    `<div class="b-row"><span class="b-row-main"><span>${title}</span>${subline ? `<small>${subline}</small>` : ""}</span>${sw(on, attrs, label)}</div>`;
  const skeleton = (label, n = 4) =>
    `<div aria-busy="true" aria-label="${label}">${Array.from({ length: n }, () => `<div class="skeleton" style="height:48px;width:100%;margin-top:12px"></div>`).join("")}</div>`;
  const failed = (title, retry) =>
    `<div class="work-empty"><span class="empty-mark">${icon("warning")}</span><h4>${title}</h4><p>The gateway did not answer.</p><div style="margin-top:10px">${button("Try again", `data-c="${retry}" data-size="sm"`)}</div></div>`;
  const pluginNote = () =>
    note(
      `<p><b>Asking first, and rules about what a tool acts on, need Clawtrate's rules plugin on the gateway.</b> Without it, ${esc(botName(current()))}'s settings can allow or deny each tool, and commands can ask.</p>`,
      "",
      icon("plug"),
    );

  // The Tools group's first rows in the bot's settings (bot-settings.js calls this).
  CT.botsToolsRows = (id) => {
    const c = counts(id);
    return (
      `<div><button type="button" class="b-open" data-bs="rules" aria-label="What ${esc(botName(id))} may do: ${countShort(c)}. Open."><span>What ${esc(botName(id))} may do</span><span class="b-open-value"><span>${countShort(c)}</span></span>${icon("chevron")}</button></div>` +
      openRow("Messaging other bots", esc(messagingShort(id)), `data-bs="messaging" aria-label="Messaging other bots: ${esc(messagingShort(id))}. Open."`)
    );
  };

  // What a bot may do (section 4) --------------------------------------------------------------

  function ruleLine(bot, l) {
    const st = lineState(bot, l.id);
    const rs = rulesFor(bot, l.id);
    const more = rs.length ? (rs.length === 1 ? `1 rule: ${ACTION_SHORT[rs[0].action].toLowerCase()} ${rs[0].action === "never" ? "under" : "matching"} ${esc(rs[0].pattern)}` : `${rs.length} rules`) : "";
    const target = l.id === "message" ? 'data-bs="messaging"' : `data-bs="rule" data-c-line="${l.id}"`;
    const name = `${l.words}, ${st.word.toLowerCase()}${more ? `, ${more}` : ""}${st.mark ? `, ${markWords(st.mark).toLowerCase()}` : ""}. Open.`;
    return (
      `<div><button type="button" class="b-open c-line" ${target} aria-label="${esc(name)}">` +
      `<span class="c-line-main">${icon(l.icon)}<span class="c-line-words"><span>${l.words}</span>${more ? `<small>${more}</small>` : ""}${mark(st.mark)}</span></span>` +
      `<span class="c-line-value"><b${st.tone ? ` data-tone="${st.tone}"` : ""}>${st.word}</b></span>${icon("chevron")}</button></div>`
    );
  }

  function rulesView(bot) {
    const name = esc(botName(bot));
    let html = sub(`What ${name} may do`, "main", "Back to settings");
    if (C.state === "loading") return html + skeleton(`Loading what ${name} may do`);
    if (C.state === "error") return html + failed(`Couldn't load what ${name} may do`, "reload");
    const c = counts(bot);
    html += `<p class="c-counts">${countWords(c)}</p>`;
    html +=
      RULES === "fresh"
        ? `<p class="b-hint">${name} hasn't run yet, so the gateway hasn't listed its tools. These lines come from its settings.</p>`
        : RULES === "stale"
          ? `<p class="b-hint">The tool list is the gateway's listing for ${name}'s latest task, Nov 17. It can be out of date until ${name} runs again.</p>`
          : `<p class="b-hint">From ${name}'s settings and the gateway's, read at 5:41 PM. Open a line for its exact rule.</p>`;
    if (!C.plugin) html += pluginNote();
    if (C.stopped)
      html += note(`<p>Couldn't read Clawtrate's rules from the gateway. Lines that depend on them read Unknown.</p><div class="b-actions">${button("Try again", 'data-c="plugin-retry" data-size="sm"')}</div>`, "warn");
    const groups = [
      ["Without asking", "allow"],
      ["Asks first", "ask"],
      ["Never", "never"],
      ["Unknown", "unknown"],
    ];
    groups.forEach(([title, v]) => {
      const ls = LINES.filter((l) => lineState(bot, l.id).value === v);
      if (!ls.length) return;
      html += `<h4 class="b-group">${title}</h4><dl class="facts">${ls.map((l) => ruleLine(bot, l)).join("")}</dl>`;
    });
    html +=
      `<details class="b-disclosure"><summary>${icon("chevron")}Not offered to ${name}: ${NOT_OFFERED.length} tools</summary><div class="b-disclosure-body"><dl class="facts">` +
      NOT_OFFERED.map(([w, t, why]) => fact(`${w} <code>${t}</code>`, `<span class="b-faint">${why}</span>`)).join("") +
      `</dl></div></details>`;
    const dis = isAdmin() ? "" : " disabled";
    const review = P[bot].exec.mode === "auto";
    html +=
      `<h4 class="b-group">When nothing else decides</h4><dl class="facts">` +
      switchRow(
        "Review commands automatically",
        `On: the gateway's reviewer decides commands that no rule covers, and asks you when it is unsure. Off: every such command asks you. ${markWords("gateway")}.`,
        review,
        `data-c="review"${dis}${P[bot].exec.mode === "deny" || P[bot].exec.mode === "full" ? " disabled" : ""}`,
        "Review commands automatically",
      ) +
      switchRow(
        "Ask when nothing else decides",
        C.plugin ? `On: any other tool that no rule covers asks you first. Off: it runs. ${markWords("plugin")}.` : "Asking needs Clawtrate's rules plugin. Without it, tools that no rule covers run.",
        Boolean(P[bot].fallback),
        `data-c="fallback"${C.plugin ? dis : " disabled"}`,
        "Ask when nothing else decides",
      ) +
      `</dl>` +
      (P[bot].fallback ? `<p class="b-hint">${name} will ask for every file it reads and every search it makes. Rules that allow come first.</p>` : "") +
      (C.plugin ? `<p class="b-hint"><button type="button" class="link-button" data-c="open-permissions">Rules for every bot also apply: ${RULESET["*"].length} rules. See Settings, Permissions.</button></p>` : "");
    return html;
  }

  // One line, opened (section 5) ----------------------------------------------------------------

  const EXEC = [
    ["full", "Allow all", "Otto runs any command without asking, as the gateway machine's user."],
    ["auto", "Review first", "The gateway's reviewer decides each command Otto hasn't been allowed; it asks you when unsure."],
    ["ask", "Ask", "Otto asks you before each command it hasn't been allowed."],
    ["deny", "Never", "Otto can't run commands."],
  ];
  const BY_WORDS = {
    default: "Nothing: it may use it",
    bot: "{n}'s settings",
    rule: "{n}'s rule",
    all: "A rule for every bot",
    gateway: "The gateway's settings for every bot",
    gwdefault: "The gateway's settings for every bot",
    fixed: "Nothing: a question already asks you",
  };

  function choiceGroup(bot, l) {
    const s = P[bot][l.id];
    const st = lineState(bot, l.id);
    const name = esc(botName(bot));
    const locked = s.by === "gateway";
    const dis = !isAdmin() || locked || l.fixed;
    if (l.id === "exec") {
      const opts = EXEC.map(([v, label]) => {
        const on = s.mode === v;
        return `<button type="button" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-c="exec" data-value="${v}"${dis ? ' aria-disabled="true"' : ""}>${label}</button>`;
      }).join("");
      return (
        `<p class="c-choice-label" id="c-choice-label">${name} may:</p><div class="c-choice" role="radiogroup" aria-labelledby="c-choice-label" data-four>${opts}</div>` +
        `<p class="c-sentence" role="status">${C.saving ? "Saving…" : esc(EXEC.find(([v]) => v === s.mode)[2].replace(/Otto/g, botName(bot)))}</p>`
      );
    }
    const opts = [
      ["allow", "Allow"],
      ["ask", "Ask"],
      ["never", "Never"],
    ]
      .map(([v, label]) => {
        const on = (locked ? s.own || "never" : s.value) === v && !(locked && v === "never" && !s.own);
        const noAsk = v === "ask" && !C.plugin;
        return `<button type="button" role="radio" aria-checked="${locked ? v === (s.own || "allow") : s.value === v}" tabindex="${s.value === v ? 0 : -1}" data-c="choose" data-value="${v}"${dis || noAsk ? ' aria-disabled="true"' : ""}>${label}</button>` + (on ? "" : "");
      })
      .join("");
    const sentence = C.saving
      ? "Saving…"
      : l.fixed
        ? `${name} asks its questions in the conversation, which already waits for you. No choice is needed.`
        : locked
          ? `${name}'s own choice, ${s.own === "allow" ? "Allow" : "Allow"}, has no effect while the gateway's settings deny this tool for every bot.`
          : st.value === "allow"
            ? `${name} ${l.words.toLowerCase().replace(/^(read|change|search|use|manage)/, (w) => ({ read: "reads", change: "changes", search: "searches", use: "uses", manage: "manages" })[w]).replace(/^look at/, "looks at")} without asking.`
            : st.value === "ask"
              ? `${name} asks you before it ${l.words.toLowerCase().replace(/^(read|change|search|use|manage)/, (w) => ({ read: "reads", change: "changes", search: "searches", use: "uses", manage: "manages" })[w]).replace(/^look at/, "looks at")}.`
              : `${name} can't ${l.words.toLowerCase().replace(/^coding agent/, "use the coding agent")}. The gateway removes the tools from ${name}'s tools.`;
    return (
      `<p class="c-choice-label" id="c-choice-label">${name} may:</p><div class="c-choice" role="radiogroup" aria-labelledby="c-choice-label"${locked ? " data-locked" : ""}>${opts}</div>` +
      `<p class="c-sentence" role="status">${sentence}</p>` +
      (!C.plugin && !l.fixed ? `<p class="b-hint">Asking needs Clawtrate's rules plugin.</p>` : "") +
      (l.kind && C.plugin && st.value === "ask" ? `<p class="b-hint">In routines, Ask works as Never: a routine's run has no one to ask.</p>` : "")
    );
  }

  function ruleView(bot) {
    const l = lineOf(C.line) || lineOf("files");
    const s = P[bot][l.id];
    const st = lineState(bot, l.id);
    const name = esc(botName(bot));
    let html = sub(l.words, "rules", `Back to what ${name} may do`);
    html += choiceGroup(bot, l);
    if (C.saveNote) html += C.saveNote;
    if (l.id === "exec" && s.machineAlways)
      html += note(`<p>media-box always asks for commands. Saved approvals don't stop it.</p>`, "", icon("lock"));
    else if (l.id === "exec" && s.mode !== "deny")
      html += `<p class="b-hint">${name}'s command policy asks for commands it hasn't allowed before. A saved approval here doesn't stop that. Runs on: media-box; media-box's own approvals also apply.</p>`;
    const by = BY_WORDS[s.by].replace("{n}", botName(bot));
    const lastUsed = { files: "5:46 PM, in 'Disk almost full on the media box'", exec: "5:44 PM, in 'Disk almost full on the media box'", read: "5:40 PM, in 'Weekly backup check'", web: "Nov 16, in 'Router firmware'" }[l.id];
    html +=
      `<dl class="facts" style="margin-top:14px">` +
      fact("Tools", `<span class="c-tools">${l.tools.map((t) => `<code>${esc(t)}</code>`).join("")}</span>${copy("tool names", l.tools.join(" "))}`) +
      fact("Decided by", esc(by)) +
      fact("Enforced by", st.mark ? markWords(st.mark) : "Nothing needs enforcing: it is allowed") +
      fact("Set", s.set ? esc(s.set) : s.by === "default" || s.by === "fixed" ? "Not set: the gateway's default" : `In ${name}'s settings on the gateway. The gateway doesn't record when.`) +
      fact("Last used", lastUsed ? `${esc(lastUsed)} <button type="button" class="link-button" data-c="to-activity">Show in Activity</button>` : "Not in the last 30 days") +
      `</dl>`;
    if (l.kind) html += actsOnPart(bot, l);
    if (l.id === "files" && C.plugin)
      html += `<h4 class="b-group">Saved approvals</h4><dl class="facts">${openRow("Allow under notes/**, for 1 hour", "until 6:41 PM · used 3 times", 'data-c="to-saved"')}</dl>`;
    html += `<details class="b-disclosure"><summary>${icon("chevron")}Raw</summary><div class="b-disclosure-body"><pre class="code-block"><code>${esc(rawFor(bot, l))}</code></pre></div></details>`;
    return html;
  }

  function rawFor(bot, l) {
    const s = P[bot][l.id];
    if (l.id === "exec") return JSON.stringify({ [`agents.entries.${bot}.tools.exec`]: { mode: s.mode } }, null, 2);
    if (s.by === "gateway") return JSON.stringify({ "tools.deny": l.tools }, null, 2);
    if (s.by === "rule") return JSON.stringify({ agentId: bot, tools: l.tools, action: s.value }, null, 2);
    if (s.value === "never") return JSON.stringify({ [`agents.entries.${bot}.tools.deny`]: l.tools }, null, 2);
    return JSON.stringify({ [`agents.entries.${bot}.tools.deny`]: [], rules: rulesFor(bot, l.id).map(({ action, pattern }) => ({ action, pattern })) }, null, 2);
  }

  // Rules about what a tool acts on (section 6).
  function actsOnPart(bot, l) {
    const name = esc(botName(bot));
    let html = `<h4 class="b-group">Rules about what it acts on</h4>`;
    if (!C.plugin) return html + `<p class="b-hint">Rules about what it acts on need Clawtrate's rules plugin.</p>`;
    const order = { never: 0, ask: 1, allow: 2 };
    const own = rulesFor(bot, l.id).sort((a, b) => order[a.action] - order[b.action]);
    const every = allRulesFor(l.id);
    const rows = [
      ...own.map((r) => `<div class="b-row"><span class="b-row-main"><span>${ACTION_SHORT[r.action]} · ${r.action === "never" ? "under" : "matching"} <code>${esc(r.pattern)}</code></span><small>${name}'s rule · set ${esc(r.set)} · ${markWords("plugin")}</small></span>${isAdmin() ? `${button("Edit", `data-c="rule-edit" data-value="${r.id}" data-size="sm"`, "quiet")}${button("Remove", `data-c="rule-remove" data-value="${r.id}" data-size="sm"`, "quiet")}` : ""}</div>`),
      ...every.map((r) => `<div class="b-row"><span class="b-row-main"><span>${ACTION_SHORT[r.action]} · under <code>${esc(r.pattern)}</code></span><small>A rule for every bot · edited in Settings, Permissions</small></span></div>`),
    ];
    html += rows.length ? `<dl class="facts">${rows.join("")}</dl>` : `<p class="b-hint">No rules. ${name} may ${l.words.toLowerCase()} as chosen above.</p>`;
    if (C.form) html += ruleForm(bot, l);
    else if (isAdmin()) html += `<div class="b-actions" style="margin-top:8px">${button("Add a rule", 'data-c="form-open" data-size="sm"')}</div>`;
    return html;
  }

  function ruleForm(bot, l) {
    const name = esc(botName(bot));
    const f = C.form;
    const len = f.pattern.length;
    const scope = rulesFor(bot, l.id).length + 0;
    const allows = (RULESET[bot] || []).filter((r) => r.action === "allow").length;
    const asks = (RULESET[bot] || []).filter((r) => r.action === "ask").length;
    let error = "";
    if (len > 1000) error = `A rule can be at most 1,000 characters. This one is ${len.toLocaleString("en-US")}.`;
    else if (f.action === "allow" && allows >= 20) error = `${name} has 20 allow rules, the most a scope can hold. Remove one to add another.`;
    else if (f.action === "ask" && asks >= 20) error = `${name} has 20 ask rules, the most a scope can hold. Remove one to add another.`;
    else if (f.tried && (RULESET[bot] || []).some((r) => r.line === l.id && r.action === f.action && r.pattern === f.pattern)) error = `${name} already has this rule.`;
    void scope;
    const ready = len > 0 && !error;
    return (
      `<div class="c-form" role="group" aria-label="Add a rule">` +
      `<p style="margin:0">When ${name} wants to: <b>${l.words.toLowerCase()}</b></p>` +
      `<label>acting on:<input class="input" data-c-pattern value="${esc(f.pattern)}" placeholder="${KIND_EXAMPLE[l.kind]}" aria-describedby="c-pattern-help${error ? " c-pattern-error" : ""}"${error ? ' aria-invalid="true"' : ""} spellcheck="false" autocomplete="off" /></label>` +
      `<p class="b-hint" id="c-pattern-help" style="margin:0">${KIND_HELP[l.kind]}</p>` +
      (error ? `<p class="b-field-error" id="c-pattern-error" role="alert" style="margin:0">${error}</p>` : "") +
      `<label>It should:<select class="input" data-c-action>${Object.entries(ACTION_WORDS)
        .map(([v, w]) => `<option value="${v}"${f.action === v ? " selected" : ""}>${w}</option>`)
        .join("")}</select></label>` +
      `<div class="b-actions">${button("Add rule", `data-c="form-add" data-size="sm"${ready ? "" : " disabled"}`, "primary")}${button("Cancel", 'data-c="form-cancel" data-size="sm"', "quiet")}</div>` +
      `</div>`
    );
  }

  // Messaging other bots (section 11) -------------------------------------------------------------

  const MSG = p("msg") || "";
  const M = {};
  app.bots.forEach((b) => (M[b.id] = { out: "any", outOnly: [], outAsk: false, in: "any", inOnly: [], inAsk: false }));
  M.otto.outAsk = C.plugin;
  M.marlow = { out: "some", outOnly: ["pip"], outAsk: false, in: "any", inOnly: [], inAsk: false };
  M.pip = { out: "some", outOnly: ["marlow"], outAsk: false, in: "some", inOnly: ["marlow"], inAsk: false };
  if (MSG === "none") M.otto.out = "none";
  if (MSG === "some") Object.assign(M.otto, { out: "some", outOnly: ["pip"] });
  function messagingShort(id) {
    const m = M[id];
    const out = m.out === "any" ? "Any bot" : m.out === "none" ? "No bot" : `Only ${m.outOnly.map(botName).join(", ")}`;
    return `${out}${m.outAsk && C.plugin ? ", asks first" : ""}`;
  }
  function messagingView(bot) {
    const name = esc(botName(bot));
    const m = M[bot];
    const dis = isAdmin() ? "" : " disabled";
    const others = app.bots.filter((b) => b.id !== bot);
    const half = (dir, title, plugin) => {
      const val = m[dir];
      const disabled = dis || (plugin && !C.plugin ? " disabled" : "");
      const radios = [
        ["any", "Any bot"],
        ["some", "Only these"],
        ["none", "No bot"],
      ]
        .map(([v, l]) => `<div><button type="button" class="b-open" role="radio" aria-checked="${val === v}" tabindex="${val === v ? 0 : -1}" data-c="msg-${dir}" data-value="${v}"${disabled}><span>${l}</span>${val === v ? icon("check") : ""}</button></div>`)
        .join("");
      const list = m[`${dir}Only`];
      return (
        `<h4 class="b-group" id="c-${dir}-label">${title}</h4>` +
        (plugin && !C.plugin ? `<p class="b-hint">Who may message ${name} needs Clawtrate's rules plugin. The gateway only lets each bot limit whom it messages.</p>` : "") +
        `<dl class="facts" role="radiogroup" aria-labelledby="c-${dir}-label">${radios}</dl>` +
        (val === "some"
          ? `<dl class="facts" style="margin-top:8px">${others.map((o) => `<div class="b-row"><label class="b-check"><input type="checkbox" data-c-peer="${dir}" value="${o.id}"${list.includes(o.id) ? " checked" : ""}${disabled} /> ${esc(o.name)}</label></div>`).join("")}</dl>` +
            (list.length ? "" : `<p class="b-field-error" role="alert">Choose at least one bot, or choose No bot. Nothing is saved until then.</p>`)
          : "") +
        `<dl class="facts" style="margin-top:8px">${switchRow("Ask me first", C.plugin ? `A card asks you before each message ${dir === "out" ? `${name} sends` : `another bot sends ${name}`}. ${markWords("plugin")}.` : "Asking needs Clawtrate's rules plugin.", m[`${dir}Ask`] && C.plugin, `data-c="msg-${dir}-ask"${C.plugin ? dis : " disabled"}`, `Ask me first, ${dir === "out" ? "outgoing" : "incoming"}`)}</dl>` +
        `<p class="c-sentence">${plugin ? markWords("plugin") : markWords("gateway")}${plugin ? "" : `: ${name}'s own list, agentToAgent.send.`}</p>`
      );
    };
    let html = sub("Messaging other bots", "rules", `Back to what ${name} may do`);
    if (MSG === "gateway") html += `<dl class="facts">${fact("For every bot", "The gateway lets only these pairs message each other: Marlow and Pip.")}</dl><p class="c-sentence">${mark("set")} Set on the gateway. ${name}'s own list narrows it.</p>`;
    else html += `<dl class="facts">${fact("For every bot", "The gateway lets bots message each other.")}</dl><p class="c-sentence">${mark("set")} ${name}'s own list narrows it.</p>`;
    html += half("out", `${name} may message:`, false) + half("in", `Other bots may message ${name}:`, true);
    html += `<p class="b-hint">Messages from other bots used about 41,200 of ${name}'s tokens this week, in the runs Clawtrate could attribute. <button type="button" class="link-button" data-bs="usage">See Usage</button></p>`;
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
    return { title: "Permissions", back, body: seg + view.body, foot: view.foot || "" };
  };

  function rulesPart() {
    let body =
      `<h4 class="b-group">Set on the gateway for every bot</h4><dl class="facts">` +
      fact("Never", `Use the browser${C.override ? ", Search the web" : ""} <span class="c-mark">${icon("lock")}Set on the gateway</span>`) +
      fact("Tools offered", "The coding profile") +
      fact("Commands", "Ask, for bots that set none") +
      fact("Messaging", MSG === "gateway" ? "Only Marlow and Pip, with each other" : "Bots may message each other") +
      fact("media-box's approvals", isAdmin() ? (C.override ? "Always ask" : "Ask for commands not on its list") : `<span class="b-faint">Seeing a machine's approvals needs admin access.</span>`) +
      `</dl><p class="b-hint">Set on the gateway. Clawtrate can't change it. Every bot's own settings can narrow these, never widen them.</p>`;
    body += `<h4 class="b-group">Rules for every bot</h4>`;
    if (!C.plugin) body += pluginNote();
    else {
      body += RULESET["*"].length
        ? `<dl class="facts">${RULESET["*"]
            .map(
              (r) =>
                `<div class="b-row"><span class="b-row-main"><span>${ACTION_SHORT[r.action]} · ${esc(r.words || lineOf(r.line).words)}${r.words ? "" : ` under <code>${esc(r.pattern)}</code>`}</span><small>Every bot · set ${esc(r.set)} · ${markWords("plugin")}</small></span>${isAdmin() ? button("Remove", `data-c="all-remove" data-value="${r.id}" data-size="sm"`, "quiet") : ""}</div>`,
            )
            .join("")}</dl>`
        : `<p class="b-hint">No rules for every bot. Each bot's settings can still allow, ask or deny.</p>`;
      if (isAdmin()) body += `<div class="b-actions" style="margin-top:8px">${button("Add a rule", 'data-c="all-add" data-size="sm"')}</div>`;
    }
    body +=
      `<h4 class="b-group">Each bot</h4><dl class="facts">` +
      app.bots.map((b) => openRow(esc(b.name), countShort(counts(b.id)), `data-c="open-bot-rules" data-value="${b.id}"`)).join("") +
      `</dl>`;
    body +=
      `<h4 class="b-group">What a new bot starts with</h4><dl class="facts">` +
      fact("Run commands", "Review first") +
      fact("Change the gateway's settings", C.plugin ? "Asks first" : "Never") +
      fact("T3 Code", "Off") +
      fact("Ask when nothing else decides", "Off") +
      fact("Everything else", "As the gateway's settings for every bot") +
      `</dl>` +
      (C.plugin ? "" : `<p class="b-hint">Without the rules plugin a bot can't be made to ask, so new bots start with this denied.</p>`) +
      `<p class="b-hint">Kept as your preference with the gateway, so your devices agree. A bot made outside Clawtrate keeps what its maker gave it.</p>`;
    return { body, foot: isAdmin() ? "" : adminBar("Changing rules for every bot needs admin access.") };
  }

  const GRANTS = [{ id: "g1", what: "Change files under notes/**", bot: "otto", granted: "Granted 5:41 PM from this device", until: "Until 6:41 PM", used: "Used 3 times, last 5:46 PM" }];
  const ROUTINE_GRANTS = [{ id: "rg1", what: "Routine Weekly cleanup (Otto) may run <code>du -sh /srv</code> in <code>/srv</code>", bot: "otto", granted: "Granted Nov 12", until: "Until Dec 12", used: "Used 4 times, last Nov 17, 3:00 AM" }];
  const ALLOW = [{ id: "al1", what: "<code>ls</code> · Otto · On the gateway's machine · From Always allow", bot: "otto", used: "Last used 5:40 PM" }];

  function savedPart() {
    if (!canApprove())
      return {
        body: `<p class="b-hint">Standing approvals let a call run without a card later.</p>`,
        foot: `<section class="access-bar" role="region" aria-label="Access"><div class="access-row">${icon("eye")}<span class="shelf-text"><b>Read-only.</b> Seeing saved approvals needs a connection that can answer approvals.</span>${button("Request access", 'data-b="request-write" data-size="sm"', "primary")}</div></section>`,
      };
    if (p("saved") === "error") return { body: failed("Couldn't load saved approvals", "saved-retry") };
    if (p("saved") === "empty") return { body: `<div class="work-empty"><span class="empty-mark">${icon("approval")}</span><h4>No saved approvals</h4><p>When you choose Always allow on a card, it is listed here.</p></div>` };
    const row = (g, kind, action) => {
      const gone = C.revoked.has(g.id);
      return (
        `<div class="b-row"><span class="b-row-main"><span${gone ? ' class="c-struck"' : ""}>${g.what}${kind === "grant" ? ` · ${esc(botName(g.bot))}` : ""}</span>` +
        `<small>${[g.granted, g.until, g.used].filter(Boolean).join(" · ")}${kind === "allow" ? " · When it was added isn't recorded." : ""} · ${markWords(kind === "grant" ? "plugin" : "gateway")}</small>` +
        (gone ? `<small role="status">Revoked. The next matching action asks again, unless another saved approval or a rule decides.</small>` : "") +
        `</span>${gone ? "" : action}</div>`
      );
    };
    let body = `<div class="c-filters"><label class="b-hint" style="margin:0">Bot <select class="input" data-c-savedbot style="height:32px;width:auto"><option>Every bot</option>${app.bots.map((b) => `<option>${esc(b.name)}</option>`).join("")}</select></label></div>`;
    if (C.plugin) body += `<h4 class="b-group">Clawtrate's grants</h4><dl class="facts">${GRANTS.map((g) => row(g, "grant", button("Revoke", `data-c="revoke" data-value="${g.id}" data-size="sm"`))).join("")}</dl>`;
    body += `<h4 class="b-group">Routines' grants</h4><dl class="facts">${ROUTINE_GRANTS.map((g) => row(g, "routine", button("Revoke", `data-c="revoke" data-value="${g.id}" data-size="sm"`))).join("")}</dl>`;
    body += `<h4 class="b-group">Machines' allowlists</h4>`;
    body += isAdmin()
      ? `<dl class="facts">${ALLOW.map((g) => row(g, "allow", button("Remove…", `data-c="allow-remove" data-value="${g.id}" data-size="sm"`, "quiet"))).join("")}</dl>`
      : `<p class="b-hint">Seeing machines' allowlists needs admin access.</p>`;
    body += `<p class="b-hint">The gateway also keeps short grants for some commands on paired machines. It doesn't list them, so they aren't here; each ends within 30 days, or when the machine's pairing changes.</p>`;
    return { body, foot: isAdmin() ? "" : adminBar("Removing an allowlist entry needs admin access.") };
  }

  const LOG = [
    { id: "e1", time: "5:46 PM", bot: "otto", task: "Disk almost full on the media box", what: "Changed notes/disk-2026-11-16.md", tag: "Allowed", tone: "", source: "A saved approval: change files under notes/**, for 1 hour", grant: true },
    { id: "e2", time: "5:44 PM", bot: "otto", task: "Disk almost full on the media box", what: "Ran du -sh /srv", tag: "Asked · allowed once", tone: "warn", source: "Your answer: allow once", needs: "approvals" },
    { id: "e3", time: "5:43 PM", bot: "otto", task: "Disk almost full on the media box", what: "Tried to change secrets/api.env", tag: "Blocked", tone: "danger", source: "Otto's rule: never under secrets/" },
    { id: "e4", time: "5:40 PM", bot: "otto", task: "Weekly backup check", what: "Ran ls", tag: "Allowed", tone: "", source: "The gateway's command allowlist", grant: true },
    { id: "e5", time: "5:31 PM", bot: "marlow", task: "Main", what: "Tried to message Pip", tag: "Blocked", tone: "danger", source: "Marlow's messaging settings" },
    { id: "e6", time: "5:12 PM", bot: "juniper", task: "Heat pump vs. gas furnace", what: "Searched the web for heat pump installers", tag: "Allowed", tone: "", source: "Not reported" },
    { id: "e7", time: "3:00 AM", bot: "otto", task: "Weekly cleanup (routine)", what: "Ran du -sh /srv", tag: "Allowed", tone: "", source: "A saved approval: routine Weekly cleanup", grant: true },
    { id: "e8", time: "2:58 AM", bot: "pip", task: "Plan the week", what: "Denied: write notes/week.md", tag: "Denied", tone: "danger", source: "Your answer: deny", needs: "approvals" },
  ];
  function activityPart() {
    const a = p("audit");
    if (a === "error") return { body: failed("Couldn't load activity", "audit-retry") };
    if (a === "off") return { body: `<div class="work-empty"><span class="empty-mark">${icon("eye")}</span><h4>No activity recorded</h4><p>The gateway isn't recording activity: its audit log is switched off in its settings.</p></div>` };
    const filters =
      `<div class="c-filters"><label class="b-hint" style="margin:0">Bot <select class="input" data-c-auditbot style="height:32px;width:auto"><option value="all">Every bot</option>${app.bots.map((b) => `<option value="${b.id}"${C.auditBot === b.id ? " selected" : ""}>${esc(b.name)}</option>`).join("")}</select></label>` +
      `<div class="seg" role="radiogroup" aria-label="Verdict">${[
        ["all", "All"],
        ["Allowed", "Allowed"],
        ["grant", "By a saved approval"],
        ["Asked", "Asked"],
        ["Denied", "Denied"],
        ["Blocked", "Blocked"],
      ]
        .map(([v, l]) => `<button type="button" role="radio" aria-checked="${C.auditFilter === v}" tabindex="${C.auditFilter === v ? 0 : -1}" data-c="audit-filter" data-value="${v}">${l}</button>`)
        .join("")}</div></div>`;
    const rows = (a === "empty" ? [] : LOG).filter(
      (e) =>
        (C.auditBot === "all" || e.bot === C.auditBot) &&
        (C.auditFilter === "all" || (C.auditFilter === "grant" ? e.grant : e.tag.startsWith(C.auditFilter))),
    );
    const list = rows.length
      ? `<ul class="c-logs">${rows
          .map((e) => {
            const src = e.needs && !canApprove() ? "Needs approvals access" : e.source;
            return (
              `<li><button type="button" class="c-log" data-c="log" data-value="${e.id}" aria-expanded="${C.logOpen === e.id}" aria-label="${esc(`${e.time}, ${botName(e.bot)}, ${e.what}, ${e.tag}, ${src}`)}">` +
              `<span class="c-log-time">${e.time}</span><span class="avatar" aria-hidden="true">${CT.character(e.bot)}</span><span class="c-log-what">${esc(e.what)}<br /><span class="b-faint">${esc(e.task)}</span></span>` +
              `<span class="c-tag"${e.tone ? ` data-tone="${e.tone}"` : ""}>${e.tag}</span><span class="c-log-source">${esc(src)}</span></button>` +
              (C.logOpen === e.id
                ? `<div style="padding:0 14px 12px"><dl class="facts">${fact("Run", `<span class="mono">run 7c1e…${e.id}</span>`)}${fact("Tool", e.what.startsWith("Ran") ? "<code>exec</code>" : e.what.includes("message") ? "<code>sessions_send</code>" : e.what.startsWith("Searched") ? "<code>web_search</code>" : "<code>write</code>")}${fact("The gateway's record", `<span class="mono">${e.id}-4b2f</span>`)}</dl><div class="b-actions" style="margin-top:8px">${button("Show in chat", 'data-c="show-in-chat" data-size="sm"')}</div></div>`
                : "") +
              `</li>`
            );
          })
          .join("")}</ul>`
      : `<div class="work-empty"><span class="empty-mark">${icon("list")}</span><h4>No tool activity in the last 30 days.</h4><p>What your bots do with their tools shows here.</p></div>`;
    const body =
      `<p class="b-lead" style="text-align:left;margin-top:0">What your bots did with their tools, and what allowed it.</p>` +
      filters +
      list +
      `<p class="b-hint">The gateway keeps 30 days of activity, up to 100,000 records, without arguments or results. A call to a tool the gateway removed leaves no record here; it shows only in its task.</p>`;
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
    usage: () => "An enforced budget needs admin access. A budget Clawtrate only shows is yours to set.",
  });

  const rerenderTab = () => BS.render();
  const rerenderSettings = () => D.renderSettings();

  function save(bot, apply, words) {
    if (!isAdmin()) return;
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
        C.saveNote = C.waiting
          ? note(`<p>Saved. ${esc(botName(bot))} still has a request waiting in 'Disk almost full on the media box'; your answer there decides it.</p><div class="b-actions">${button("Show the request", 'data-c="show-request" data-size="sm"')}</div>`)
          : mode === "timeout"
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
          const target = from === "rule" ? `[data-c-line="${C.line}"]` : '[data-bs="messaging"]';
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
    const inPanel = panel.contains(t);
    if (t.getAttribute("aria-disabled") === "true" || t.disabled) return;
    switch (what) {
      case "reload":
      case "plugin-retry":
        C.state = "ready";
        C.stopped = false;
        return rerenderTab();
      case "choose": {
        const l = lineOf(C.line);
        const s = P[bot][l.id];
        if (s.value === value) return;
        return save(bot, () => {
          P[bot][l.id] = { value, by: value === "allow" ? "default" : value === "ask" ? "rule" : "bot", set: value === "ask" ? "Just now, from this device" : undefined };
        }, `${l.words}: ${value === "allow" ? "allowed" : value === "ask" ? "asks first" : "never"}`);
      }
      case "exec": {
        const s = P[bot].exec;
        if (s.mode === value) return;
        const apply = () => Object.assign(P[bot].exec, { mode: value, value: value === "full" ? "allow" : value === "deny" ? "never" : "ask", by: "bot" });
        const words = `Run commands: ${EXEC.find(([v]) => v === value)[1].toLowerCase()}`;
        if (value === "full")
          return D.confirmBox({
            title: `Let ${botName(bot)} run any command without asking?`,
            text: "It can then change or delete anything the machine's user can.",
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
      case "to-activity":
        C.part = "activity";
        C.auditBot = bot;
        return D.openSettings(t, "permissions");
      case "to-saved":
        C.part = "saved";
        return D.openSettings(t, "permissions");
      case "form-open":
        C.form = { pattern: "", action: "never" };
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
        (RULESET[bot] = RULESET[bot] || []).push({ id: `n${(seq += 1)}`, line: l.id, action: C.form.action, pattern: C.form.pattern, set: "Just now" });
        C.form = null;
        rerenderTab();
        announce(`Rule added: ${ACTION_SHORT[RULESET[bot].at(-1).action]}`);
        return setTimeout(() => $('[data-c="form-open"]', panel)?.focus(), 30);
      }
      case "rule-remove":
        RULESET[bot] = RULESET[bot].filter((r) => r.id !== value);
        rerenderTab();
        return announce("Rule removed");
      case "rule-edit":
        return announce("Editing a rule opens the same form, filled in.");
      case "msg-out":
      case "msg-in": {
        const dir = what === "msg-out" ? "out" : "in";
        M[bot][dir] = value;
        rerenderTab();
        return announce(`Saved. ${dir === "out" ? `${botName(bot)} may message` : `Other bots may message ${botName(bot)}`}: ${value === "any" ? "any bot" : value === "none" ? "no bot" : "only these"}`);
      }
      case "msg-out-ask":
      case "msg-in-ask": {
        const k = what === "msg-out-ask" ? "outAsk" : "inAsk";
        M[bot][k] = !M[bot][k];
        rerenderTab();
        return announce(`Saved. Ask me first: ${M[bot][k] ? "on" : "off"}`);
      }
      case "show-request":
        return announce("The request is in Otto's task 'Disk almost full on the media box'.");
      // Settings, Permissions.
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
            ALLOW[0].what = ALLOW[0].what;
            rerenderSettings();
            announce("Removed");
          },
        });
      case "audit-filter":
        C.auditFilter = value;
        return rerenderSettings();
      case "log":
        C.logOpen = C.logOpen === value ? null : value;
        return rerenderSettings();
      case "show-in-chat":
        return announce("Showing the step in the chat");
      case "saved-retry":
      case "audit-retry":
        return rerenderSettings();
    }
    void inPanel;
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
  });

  // Choices and segments are radio groups: arrows move and choose (bots.js does this for
  // role="radio" inside a role="radiogroup", which these are).

  CT.ctl = { C, P, M, LINES, RULESET, mark, markWords, MARKS, lineState, counts, sub, openRow, fact, switchRow, skeleton, failed, sw, esc, icon };
  window.controls = { C, P, M, RULESET };
  BS.render();
})();
