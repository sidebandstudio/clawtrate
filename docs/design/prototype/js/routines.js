// The screens of docs/design/automation.md on local fixtures: the Routines
// view (list and calendar), a routine's page and its runs, a run's
// conversation, the editor, pause, run now, delete, the request for admin
// access, a bot's check-ins and the away card. No gateway, no network.
//
// The clock is fixed at Wednesday, Nov 18, 2026, 10:12 AM in New York, which
// is the viewer's own time zone here, so every state draws the same words.
// The address picks any state; docs/design/automation.md, section 18, lists them.

(function () {
  const CT = window.CT;
  const P = CT.params;
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const icon = (n, c) => CT.icon(n, c);
  const glyph = (s) => `<span class="glyph" data-state="${s}" aria-hidden="true"></span>`;
  const button = (label, attrs = "", variant = "") =>
    `<button type="button" class="button"${variant ? ` data-variant="${variant}"` : ""} ${attrs}>${label}</button>`;
  const note = (html, tone = "") =>
    `<div class="b-note"${tone ? ` data-tone="${tone}"` : ""}>${icon(tone ? "warning" : "clock")}<div>${html}</div></div>`;
  // The copy button of conversation.md §9, with its two outcomes.
  const copyButton = (what, text) =>
    `<button type="button" class="copy" aria-label="Copy ${esc(what)}" title="Copy ${esc(what)}" data-what="${esc(what)}" data-copy="${esc(text)}">${icon("copy")}</button>`;
  const sw = (on, attrs, label) =>
    `<button type="button" class="b-switch" role="switch" aria-checked="${on}" aria-label="${esc(label)}" ${attrs}></button>`;

  // Time ------------------------------------------------------------------------------

  const VIEWER = "America/New_York";
  const MIN = 60e3;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const NOW = Date.UTC(2026, 10, 18, 15, 12);
  const fmt = {};
  const formatter = (tz) =>
    (fmt[tz] ||= new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short",
    }));
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  function parts(ms, tz) {
    const o = {};
    for (const p of formatter(tz).formatToParts(ms)) o[p.type] = p.value;
    return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, min: +o.minute, dow: DOW[o.weekday] };
  }
  function fromZoned(y, m, d, h, min, tz) {
    let guess = Date.UTC(y, m - 1, d, h, min);
    for (let i = 0; i < 2; i++) {
      const p = parts(guess, tz);
      guess -= Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - Date.UTC(y, m - 1, d, h, min);
    }
    return guess;
  }
  const city = (tz) => (tz ? tz.split("/").pop().replace(/_/g, " ") : "");
  const clock = (ms, tz = VIEWER) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(ms);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayIndex = (ms, tz) => {
    const p = parts(ms, tz);
    return Date.UTC(p.y, p.m - 1, p.d) / DAY;
  };
  function dayWord(ms, tz = VIEWER, cap = false) {
    const diff = dayIndex(ms, tz) - dayIndex(NOW, tz);
    const p = parts(ms, tz);
    let w = diff === 0 ? "today" : diff === 1 ? "tomorrow" : diff === -1 ? "yesterday" : Math.abs(diff) < 6 ? WEEK[p.dow] : `${MONTHS[p.m - 1]} ${p.d}`;
    if (cap) w = w[0].toUpperCase() + w.slice(1);
    return w;
  }
  const when = (ms, tz = VIEWER, cap = false) => `${dayWord(ms, tz, cap)} ${clock(ms, tz)}`;
  const longDate = (ms, tz) => {
    const p = parts(ms, tz);
    return `${WEEK[p.dow]} ${MONTHS[p.m - 1]} ${p.d}`;
  };
  // The gateway's `at` is an ISO 8601 string; one without an offset is UTC.
  const atMs = (iso) => Date.parse(/(Z|[+-]\d\d:?\d\d)$/i.test(iso) ? iso : `${iso}Z`);
  // The instant written with the offset its zone has at that instant: the gateway keeps no zone for `at`.
  function isoWithOffset(ms, tz) {
    const p = parts(ms, tz);
    const off = Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - Math.floor(ms / MIN) * MIN) / MIN);
    const two = (n) => String(Math.abs(n)).padStart(2, "0");
    return `${p.y}-${two(p.m)}-${two(p.d)}T${two(p.h)}:${two(p.min)}:00${off < 0 ? "-" : "+"}${two(Math.trunc(off / 60))}:${two(off % 60)}`;
  }
  const at = (daysAgo, h, min) => {
    const p = parts(NOW - daysAgo * DAY, VIEWER);
    return fromZoned(p.y, p.m, p.d, h, min, VIEWER);
  };

  // Schedules ---------------------------------------------------------------------------

  // A cron expression this page reads: fixed minute and hour, with a day-of-week
  // field (*, a range or a list) or a fixed day of the month.
  function readCron(expr) {
    const f = expr.trim().split(/\s+/);
    if (f.length !== 5 || !/^\d+$/.test(f[0]) || !/^\d+$/.test(f[1]) || f[3] !== "*") return null;
    let dows = null;
    if (f[4] === "*") dows = [0, 1, 2, 3, 4, 5, 6];
    else if (/^\d-\d$/.test(f[4])) {
      const [a, b] = f[4].split("-").map(Number);
      dows = [];
      for (let i = a; i <= b; i++) dows.push(i % 7);
    } else if (/^\d(,\d)*$/.test(f[4])) dows = f[4].split(",").map((x) => +x % 7);
    else return null;
    const dom = f[2] === "*" ? null : /^\d+$/.test(f[2]) ? +f[2] : undefined;
    if (dom === undefined) return null;
    return { min: +f[0], h: +f[1], dows, dom };
  }
  const plainCron = (c) => c && c.dom === null;
  function hm(h, min) {
    const d = new Date(Date.UTC(2026, 0, 1, h, min));
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" }).format(d);
  }
  const plural = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
  function everyWords(ms) {
    if (ms % HOUR === 0) return ms === HOUR ? "Every hour" : `Every ${ms / HOUR} hours`;
    return `Every ${Math.round(ms / MIN)} minutes`;
  }
  // conversation.md §8.2: the schedule in words, with the zone always said.
  function words(s, withZone = true) {
    const zone = s.tz ? `, ${city(s.tz)}` : ", gateway's time";
    if (s.kind === "every") return everyWords(s.everyMs);
    // An `at` is an instant with no zone of its own, so it is said in the viewer's.
    if (s.kind === "at") {
      const t = atMs(s.at);
      return `Once, ${MONTHS[parts(t, VIEWER).m - 1]} ${parts(t, VIEWER).d} at ${clock(t)}${withZone ? `, ${city(VIEWER)}` : ""}`;
    }
    const c = readCron(s.expr);
    if (!plainCron(c)) return { mono: s.expr, zone: withZone ? zone : "" };
    const t = hm(c.h, c.min);
    const d = c.dows;
    let day;
    if (d.length === 7) day = "Every day";
    else if (d.join() === "1,2,3,4,5") day = "Weekdays";
    else if (d.length === 1) day = plural[d[0]];
    else day = d.map((x) => WEEK[x]).join(", ");
    return `${day} at ${t}${withZone ? zone : ""}`;
  }
  const wordsHtml = (s, withZone = true) => {
    const w = words(s, withZone);
    return typeof w === "string" ? esc(w) : `<code class="r-mono">${esc(w.mono)}</code>${esc(w.zone)}`;
  };
  const wordsText = (s) => {
    const w = words(s);
    return typeof w === "string" ? w : `${w.mono}${w.zone}`;
  };

  // The next occurrences after `from`, computed here: the gateway gives only the next one.
  function occurrences(s, from, until, max = 400) {
    const out = [];
    if (s.kind === "every") {
      const anchor = s.anchorMs ?? 0;
      let t = anchor + Math.ceil((from - anchor) / s.everyMs) * s.everyMs;
      for (; t < until && out.length < max; t += s.everyMs) out.push(t);
      return out;
    }
    if (s.kind === "at") return atMs(s.at) >= from && atMs(s.at) < until ? [atMs(s.at)] : [];
    const c = readCron(s.expr);
    if (!c) return [];
    const tz = s.tz || VIEWER;
    const start = parts(from - DAY, tz);
    for (let i = 0; i < 400 && out.length < max; i++) {
      const base = Date.UTC(start.y, start.m - 1, start.d + i);
      const day = new Date(base);
      const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
      const dow = day.getUTCDay();
      if (c.dom !== null ? d !== c.dom : !c.dows.includes(dow)) continue;
      const t = fromZoned(y, m, d, c.h, c.min, tz);
      if (t >= until) break;
      if (t >= from) out.push(t);
    }
    return out;
  }
  const nextRun = (r) => (r.enabled ? occurrences(r.schedule, NOW, NOW + 400 * DAY, 1)[0] : undefined);
  const perDay = (r) => (r.schedule.kind === "every" ? DAY / r.schedule.everyMs : 1);

  // Fixtures ------------------------------------------------------------------------------

  const bots = [
    { id: "juniper", name: "Juniper", preview: "Ask these five, and get the answers in writing.", time: "5:24 PM" },
    { id: "marlow", name: "Marlow", preview: "Tightened the intro and cut about 80 words.", time: "4:58 PM" },
    { id: "otto", name: "Otto", preview: "Done. The disk is now at 61%.", time: "5:36 PM" },
    { id: "pip", name: "Pip", preview: "Here is the week, with Thursday kept clear.", time: "3:10 PM" },
  ];
  const botName = (id) => bots.find((b) => b.id === id)?.name ?? id;

  const run = (daysAgo, h, min, extra = {}) => ({ at: at(daysAgo, h, min), status: "ok", completion: "succeeded", dur: 2.6, tokens: 200, inT: 120, outT: 80, manual: false, ...extra });
  const PREAMBLE =
    "This is an unattended scheduled run. Nobody is present to clarify or approve, so complete the task with what you have. Your final reply is the deliverable — not a plan, an acknowledgement, or a request for input. If nothing needs doing, reply exactly NO_REPLY.";
  // A run's `history` is what cron.history returned for its runId: the first message as
  // the gateway recorded it, and the reply. Runs without it returned no messages.
  const recorded = (instruction, reply) => ({ message: `${instruction}\n\n${PREAMBLE}`, reply });
  const DIGEST_SUMMARY =
    "Three notes from yesterday. The draft for Sam is ready to send. Two emails need an answer today: the venue's question about numbers and the printer's quote.";
  let routines = [
    {
      id: "digest", bot: "marlow", name: "Morning digest", enabled: true,
      schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "America/New_York" },
      payload: { kind: "agentTurn", message: "Summarise the notes I added yesterday, and list anything I need to answer today." },
      sessionTarget: "isolated", delivery: "none", updatedAtMs: NOW - 3 * DAY,
      runs: [
        run(0, 8, 0, { summary: DIGEST_SUMMARY, history: recorded("Summarise the notes I added yesterday, and list anything I need to answer today.", DIGEST_SUMMARY) }),
        // Recorded before the instruction was last edited: the run shows what it was sent.
        run(1, 11, 40, { manual: true, dur: 3.1, tokens: 214, summary: "Two notes from yesterday, both about the venue.", history: recorded("Summarise the notes I added yesterday.", "Two notes from yesterday, both about the venue.") }),
        run(1, 8, 0, { completion: "failed", delivery: "No channel is set up to deliver to." }),
        run(2, 8, 0, { status: "error", completion: "failed", error: "The model didn't answer within 120 seconds.\nThe gateway will try again at the next run." }),
        run(5, 8, 0, { status: "skipped", completion: "unknown" }),
        run(6, 8, 0, {}),
      ],
    },
    {
      id: "reminder", bot: "marlow", name: "Send the draft to Sam", enabled: true,
      schedule: { kind: "at", at: "2026-11-20T14:00:00.000Z" },
      payload: { kind: "systemEvent", text: "Reminder: send the newsletter draft to Sam before the weekend." },
      sessionTarget: "main", delivery: "announce", updatedAtMs: NOW - DAY, runs: [],
    },
    {
      id: "backup", bot: "otto", name: "Nightly backup check", enabled: true,
      schedule: { kind: "cron", expr: "30 3 * * *", tz: "America/New_York" },
      payload: { kind: "agentTurn", message: "Check that last night's backup finished on every machine, and tell me only if one did not." },
      sessionTarget: "isolated", delivery: "none", updatedAtMs: NOW - 9 * DAY,
      runs: [
        run(0, 3, 30, { status: "error", completion: "failed", error: "exec denied: the command needs approval, and nobody was there to approve it.", dur: 4.2, tokens: 310 }),
        run(1, 3, 30, { dur: 5.0, tokens: 290 }),
        run(2, 3, 30, { dur: 4.8, tokens: 288 }),
      ],
    },
    {
      id: "watch", bot: "otto", name: "Disk space watch", enabled: true,
      schedule: { kind: "every", everyMs: 30 * MIN, anchorMs: 0 },
      trigger: "df --output=pcent / | tail -1 | tr -dc 0-9 | awk '$1 > 85'",
      payload: { kind: "agentTurn", message: "The media box's disk is over 85%. Find what grew and tell me what is safe to clear." },
      sessionTarget: "isolated", delivery: "none", updatedAtMs: NOW - 2 * DAY,
      runs: [run(0, 10, 0, { status: "skipped", completion: "unknown", dur: 0.2, tokens: 0 })],
    },
    {
      id: "renewal", bot: "otto", name: "Certificate renewal", enabled: true,
      schedule: { kind: "cron", expr: "0 9 1 * *", tz: "Europe/Berlin" },
      payload: { kind: "agentTurn", message: "Check the expiry of every certificate on the rack and renew any with less than 30 days left." },
      sessionTarget: "isolated", delivery: "none", updatedAtMs: NOW - 20 * DAY,
      runs: [run(17, 3, 0, { dur: 12.4, tokens: 1840 })],
    },
    {
      id: "standup", bot: "pip", name: "Plan the week", enabled: true,
      schedule: { kind: "cron", expr: "0 17 * * 0", tz: "Europe/London" },
      payload: { kind: "agentTurn", message: "Plan next week from my calendar. Keep Thursday afternoon clear." },
      sessionTarget: "isolated", delivery: "none", updatedAtMs: NOW - 4 * DAY,
      runs: [run(3, 12, 0, { dur: 8.1, tokens: 960 })],
    },
    {
      id: "cleanup", bot: "pip", name: "Inbox tidy-up", enabled: false,
      schedule: { kind: "cron", expr: "0 16 * * 5", tz: "America/New_York" },
      payload: { kind: "agentTurn", message: "Archive newsletters older than a week and list anything that still needs me." },
      sessionTarget: "isolated", delivery: "none", updatedAtMs: NOW - 12 * DAY, runs: [],
    },
  ];

  // Check-ins: the gateway's heartbeat jobs as cron.list returns them, per bot.
  // "default" marks a bot that checks in through the gateway's default setting.
  const checkins = {
    juniper: { every: 30 * MIN, source: "default", prompt: "" },
    marlow: null,
    otto: null,
    pip: null,
  };

  // State from the address ----------------------------------------------------------------

  const S = {
    view: P.get("view") || "list",
    bot: P.get("bot") || "",
    routine: P.get("routine") || "digest",
    access: P.get("access") || "admin",
    req: P.get("req") || "",
    state: P.get("state") || "",
    run: P.has("run") ? +P.get("run") : null,
    runstate: P.get("runstate") || "",
    edit: P.get("edit") || "",
    editstate: P.get("editstate") || "",
    away: P.get("away") === "1",
    from: "list",
    starting: false,
    already: false,
    rowError: null,
    deleted: false,
  };
  const r0 = () => routines.find((r) => r.id === S.routine);
  if (S.state === "running") r0().running = at(0, 10, 11);
  if (S.state === "paused") r0().enabled = false;
  if (S.state === "noruns") r0().runs = [];
  if (S.state === "deleted") S.deleted = true;
  // A successful one-shot: the gateway sends finished, then removed, and keeps nothing of it.
  if (S.state === "ran-once") {
    r0().runs = [run(0, 9, 0, { summary: "Posted the reminder in Marlow's main conversation.", dur: 0.4, tokens: 0 })];
    r0().gone = true;
    S.deleted = "once";
  }
  if (S.state === "failed") r0().runs.unshift(run(0, 9, 0, { status: "error", completion: "failed", error: "The model didn't answer within 120 seconds." }));
  const ci = P.get("checkins");
  if (ci) {
    const b = S.bot || "juniper";
    checkins[b] = ci === "off" ? { every: 0, source: "own", prompt: "" } : { every: ci === "daily" ? DAY : ci === "every" ? 2 * HOUR : 30 * MIN, source: b === "juniper" ? "default" : "own", prompt: "" };
  }
  if (S.view === "checkins") S.bot ||= "juniper";
  const isAdmin = () => S.access === "admin";
  const schedulerOff = () => S.state === "scheduler-off";
  let lastFocus = null;

  function announce(text) {
    const live = $("#r-announce");
    live.textContent = "";
    setTimeout(() => (live.textContent = text), 30);
  }

  // Words for a routine ----------------------------------------------------------------------

  const lastRun = (r) => r.runs[0];
  function outcome(x) {
    if (x.status === "error") return { mark: "failed", tone: "danger", short: "failed", text: `Failed: ${x.error.split("\n")[0]}` };
    if (x.status === "skipped") return { mark: "stopped", short: "skipped", text: "Skipped" };
    if (x.completion === "failed") return { mark: "failed", tone: "danger", short: "not delivered", text: `Ran, but its result wasn't delivered: ${x.delivery}` };
    if (x.completion === "unknown") return { mark: "", short: "ran", text: "Ran · whether it finished isn't known" };
    return { mark: "", short: "succeeded", text: `Succeeded · ${x.dur} s · ${x.tokens} tokens` };
  }
  function rowLine(r) {
    if (r.running) return [`Running since ${clock(r.running)}`, `running since ${clock(r.running)}`];
    if (!r.enabled) return [`Paused · ${wordsHtml(r.schedule)}`, `paused, ${wordsText(r.schedule)}`];
    const n = nextRun(r);
    const l = lastRun(r);
    const nextHtml = n === undefined ? "" : schedulerOff() ? ` · <span class="r-faint">Would be next ${esc(when(n, r.schedule.tz || VIEWER))}</span>` : ` · Next ${esc(when(n, r.schedule.tz || VIEWER))}`;
    const o = l && outcome(l);
    const lastHtml = l ? ` · Last ${esc(dayWord(l.at))}, ${o.tone ? `<span data-tone="${o.tone}">${o.short}</span>` : o.short}` : " · No runs yet";
    const spoken = `${wordsText(r.schedule)}${n === undefined ? "" : `, next run ${when(n, r.schedule.tz || VIEWER)}`}${l ? `, last run ${dayWord(l.at)} ${o.short}` : ", no runs yet"}`;
    return [`${wordsHtml(r.schedule)}${nextHtml}${lastHtml}`, spoken];
  }
  const rowMark = (r) => (r.running ? glyph("working") : lastRun(r) && outcome(lastRun(r)).mark === "failed" && r.enabled ? glyph("failed") : "");
  const checkinWords = (b) => {
    const c = checkins[b];
    if (!c || !c.every) return "No check-ins";
    return c.every === DAY ? "Checks in daily" : `Checks in ${everyWords(c.every).toLowerCase()}`;
  };

  // The rail ------------------------------------------------------------------------------------

  function renderRail() {
    const running = routines.find((r) => r.running);
    $("#bot-list").innerHTML = bots
      .map((b) => {
        // An isolated agent routine's latest run of the last 24 hours (Clawtrate's choice).
        const runRow = routines.filter((r) => !r.gone && r.bot === b.id && r.sessionTarget === "isolated" && r.payload.kind === "agentTurn" && r.runs.length && r.runs[0].at > NOW - DAY);
        const busy = running && running.bot === b.id;
        const line = busy ? `${glyph("working")}<span class="bot-preview">Running ${esc(running.name)}</span>` : `<span class="bot-preview">${esc(b.preview)}</span>`;
        const open = runRow.length > 0;
        const tasks = open
          ? `<ul class="task-list" aria-label="${b.name}'s tasks">` +
            runRow
              .map((r) => {
                const o = outcome(r.runs[0]);
                return `<li><button type="button" class="task" data-r="open-run-task" data-id="${r.id}" aria-label="${esc(`${r.name}, routine run, ${when(r.runs[0].at)}, ${o.short}`)}" data-testid="run-task">` +
                  `${icon("clock")}<span class="task-title">${esc(r.name)}</span><time class="task-time">${clock(r.runs[0].at)}</time>${o.mark === "failed" ? glyph("failed") : ""}</button></li>`;
              })
              .join("") +
            `</ul>`
          : "";
        return (
          `<li class="bot-group"${open ? ' data-open="true"' : ""}><button type="button" class="bot" data-bot-row="${b.id}" data-r="open-bot" data-id="${b.id}" aria-label="${esc(`${b.name}, ${busy ? `running ${running.name}` : b.preview}`)}" data-testid="bot">` +
          `<span class="avatar" data-bot="${b.id}"></span><span class="bot-text"><span class="bot-line"><span class="bot-name">${b.name}</span><time class="bot-time">${b.time}</time></span>` +
          `<span class="bot-line">${line}</span></span></button>${tasks}</li>`
        );
      })
      .join("");
    const rb = $("#routines-button");
    if (S.view === "convo") rb.removeAttribute("aria-current");
    else rb.setAttribute("aria-current", "page");
    rb.querySelector(".r-away-dot")?.remove();
    if (S.away) rb.insertAdjacentHTML("beforeend", `<span class="r-away-dot" aria-hidden="true"></span>`);
    rb.setAttribute("aria-label", S.away ? "Routines, needs your answer" : "Routines");
    CT.hydrate($("#bot-list"));
  }

  // The access bar ---------------------------------------------------------------------------------

  function accessBar() {
    if (isAdmin() && S.req !== "granted") return "";
    const lead = S.access === "read" ? "Read-only." : "Admin access needed.";
    const cmd = "openclaw devices approve 3f9a2c71";
    const rows = {
      "": [`${icon("eye")}<span class="shelf-text"><b>${lead}</b> Creating and changing routines needs admin access.</span>`, button("Request admin access", 'data-size="sm" data-r="request"', "primary")],
      asking: [`${glyph("sending")}<span class="shelf-text" aria-busy="true">Asking the gateway…</span>`, ""],
      requested: [`${glyph("waiting")}<span class="shelf-text"><b>Waiting for the gateway's owner.</b> Approve this request on the gateway's machine:</span>`, ""],
      denied: [`${glyph("stopped")}<span class="shelf-text"><b>The request was denied.</b> Nothing changed. This device keeps the access it had.</span>`, button("Request again", 'data-size="sm" data-r="request"')],
      expired: [`${glyph("stopped")}<span class="shelf-text"><b>The request expired</b> before it was approved.</span>`, button("Request again", 'data-size="sm" data-r="request"')],
      failed: [`${icon("warning")}<span class="shelf-text"><b>Couldn't send the request.</b> The gateway didn't answer.</span>`, button("Try again", 'data-size="sm" data-r="request"')],
      granted: [`${icon("check")}<span class="shelf-text"><b>Admin access granted.</b> You can change this now.</span>`, ""],
    };
    const [text, actions] = rows[S.req] || rows[""];
    return (
      `<footer class="composer r-access" data-run="read"><div class="composer-inner">` +
      `<section class="access-bar" role="region" aria-label="Access" data-state="${S.req || "read"}"${S.req === "failed" ? ' data-tone="danger"' : ""}>` +
      `<div class="access-row">${text}${actions}</div>` +
      (S.req === "requested"
        ? `<div class="command-line"><code>${cmd}</code></div><div class="access-row"><span class="access-id">Request <span class="mono">3f9a2c71</span>` +
          `<span class="access-wait">checking again in 4s</span></span><span class="spacer"></span>` +
          button("Check now", 'data-size="sm" data-r="access-check"') + button("Cancel request", 'data-size="sm" data-r="access-cancel"', "quiet") + `</div>`
        : "") +
      `</section></div></footer>`
    );
  }

  // The view's header ---------------------------------------------------------------------------------

  const SEG = [["list", "List"], ["day", "Day"], ["3day", "3 days"], ["week", "Week"]];
  const phone = () => CT.settings.width === "phone" || (P.get("chrome") === "0" && innerWidth < 688);
  function seg() {
    const opts = phone() ? SEG.slice(0, 2) : SEG;
    const cur = ["day", "3day", "week"].includes(S.view) ? S.view : "list";
    return `<div class="r-seg" role="radiogroup" aria-label="Show as">` +
      opts.map(([v, t]) => `<button type="button" role="radio" aria-checked="${v === cur}" tabindex="${v === cur ? 0 : -1}" data-r="seg" data-v="${v}">${t}</button>`).join("") + `</div>`;
  }
  // On the phone New routine is a round "+" button, so the title keeps its room.
  const newButton = (label) =>
    phone()
      ? `<button type="button" class="icon-button" data-r="new" aria-label="${esc(label)}" title="${esc(label)}">${icon("plus")}</button>`
      : button(label, 'data-size="sm" data-r="new"', "primary");
  const backButton = (label, action) =>
    `<button type="button" class="icon-button" data-r="${action}" aria-label="${label}">${icon("back")}</button>`;

  // The list --------------------------------------------------------------------------------------------

  const visibleRoutines = () => routines.filter((r) => !r.gone && (!S.bot || r.bot === S.bot));
  function botSelect() {
    return `<button type="button" class="b-select" data-r="bot-menu" aria-haspopup="menu" aria-expanded="false" aria-label="Bots: ${S.bot ? botName(S.bot) : "All bots"}">` +
      `<span>${S.bot ? botName(S.bot) : "All bots"}</span>${icon("chevron")}</button>`;
  }
  function row(r) {
    const [line, spoken] = rowLine(r);
    return (
      `<li data-routine="${r.id}"><div class="r-row" data-paused="${!r.enabled}" data-testid="routine-row">` +
      `<button type="button" class="r-row-main" data-r="open" data-id="${r.id}" aria-label="${esc(`${r.name}, ${botName(r.bot)}, ${spoken}`)}">` +
      `<span class="r-row-mark">${rowMark(r)}</span><span class="r-row-text"><span class="r-row-name" title="${esc(r.name)}">${esc(r.name)}</span>` +
      `<span class="r-row-line">${line}</span></span></button>` +
      (isAdmin() ? sw(r.enabled, `data-r="toggle" data-id="${r.id}"`, `${r.name} runs on schedule`) : "") +
      `</div>${S.rowError === r.id ? `<p class="r-row-error" role="alert">Couldn't pause: the gateway didn't answer.</p>` : ""}</li>`
    );
  }
  function checkinsBlock(b) {
    const c = checkins[b];
    const name = botName(b);
    let text;
    if (!c || !c.every) text = c ? `${name} doesn't check in on a schedule.` : `${name} doesn't check in. Without a setting of its own, only the gateway's default bot checks in.`;
    else if (c.every === DAY) text = `Once a day, ${name} looks for anything that needs you.`;
    else if (c.every === 30 * MIN) text = `Every 30 minutes, ${name} looks for anything that needs you, and stays quiet when nothing does.`;
    else text = `${everyWords(c.every)}, ${name} looks for anything that needs you, and stays quiet when nothing does.`;
    const next = c && c.every ? (schedulerOff() ? "The gateway's scheduler is off, so scheduled check-ins don't run." : `Next check-in ${clock(at(0, 10, 30))} · In ${name}'s main conversation`) : "";
    const zones = [...new Set(routines.filter((r) => r.bot === b && r.schedule.tz).map((r) => city(r.schedule.tz)))];
    return (
      `<section class="r-checkins" aria-labelledby="checkins-head" data-testid="checkins"><div class="r-checkins-head"><h3 id="checkins-head">Check-ins</h3>` +
      (isAdmin() ? button("Change", `data-size="sm" data-r="checkins" data-id="${b}"`) : "") + `</div>` +
      `<p data-testid="checkins-text">${esc(text)}</p>${next ? `<p class="r-faint">${esc(next)}</p>` : ""}` +
      (zones.length ? `<p class="r-faint" data-testid="zone-line">Routines' time zone: ${zones.length > 1 ? `Mixed: ${zones.join(", ")}` : zones[0]}</p>` : "") +
      `</section>`
    );
  }
  function awayCard() {
    if (!S.away) return "";
    const n = routines.filter((r) => r.enabled).length;
    return (
      `<section class="r-away" aria-labelledby="away-title" data-testid="away"><p id="away-title"><b>You've been away for a bit.</b> ${n} routines kept running while you were away. Keep them running?</p>` +
      `<div class="b-actions">${button("Keep them running", 'data-r="away-keep"', "primary")}` +
      (isAdmin() ? button("Pause them all", 'data-r="away-pause"') : "") +
      button("Keep running, don't ask again", 'data-r="away-never"', "quiet") + `</div>` +
      (isAdmin() ? "" : `<small>Pausing them needs admin access.</small>`) +
      `<small>If you don't answer, Clawtrate pauses them on Nov 25, the first time it is open with admin access on or after that day.</small></section>`
    );
  }
  function renderList() {
    const list = visibleRoutines();
    const head =
      `<header class="r-head">${phone() ? backButton("Back to bots", "to-bots") : ""}<h1 id="view-title">Routines</h1><span class="spacer"></span>${seg()}` +
      (isAdmin() ? newButton(S.bot ? `New routine for ${botName(S.bot)}` : "New routine") : "") + `</header>`;
    let body = awayCard();
    if (schedulerOff()) body += note(`<p><b>The gateway's scheduler is off.</b> Routines and check-ins don't run on their schedule. Run now still works.</p>`, "warn");
    body += `<div class="r-toolbar">${botSelect()}<span data-testid="count">${S.state === "loading" || S.state === "error" ? "" : `${list.length} routine${list.length === 1 ? "" : "s"}`}</span></div>`;
    if (S.bot) body += checkinsBlock(S.bot);
    if (S.state === "loading") {
      body += `<div class="r-group"><span class="skeleton" style="width:140px;height:14px"></span></div><ul class="r-rows" aria-busy="true" aria-label="Loading routines">` +
        [1, 2, 3].map(() => `<li><div class="r-row"><span class="skeleton" style="width:60%;height:14px"></span></div></li>`).join("") + `</ul>`;
    } else if (S.state === "error") {
      body += `<div class="work-empty" data-testid="error"><span class="empty-mark">${icon("warning")}</span><h4>Couldn't load routines.</h4><p>The gateway didn't answer in time.</p>${button("Try again", 'data-r="retry"')}</div>`;
    } else if (S.state === "empty" || list.length === 0) {
      body += S.bot && S.state !== "empty"
        ? `<p class="r-hint" data-testid="empty">${botName(S.bot)} has no routines.</p>${isAdmin() ? `<p>${button(`New routine for ${botName(S.bot)}`, 'data-r="new"')}</p>` : ""}`
        : `<div class="work-empty" data-testid="empty"><span class="empty-mark">${icon("clock")}</span><h4>No routines yet</h4><p>A routine runs one of your bots on a schedule: a morning summary, a weekly check.</p>` +
          (isAdmin() ? button("New routine", 'data-r="new"', "primary") : "") + `</div>`;
    } else {
      for (const b of bots) {
        const rs = list.filter((r) => r.bot === b.id).sort((x, y) => (x.enabled === y.enabled ? (nextRun(x) ?? 0) - (nextRun(y) ?? 0) : x.enabled ? -1 : 1));
        if (!rs.length) continue;
        body += `<div class="r-group"><span class="avatar" data-bot="${b.id}"></span><h2 id="g-${b.id}">${b.name}</h2><span class="r-hb">${checkinWords(b.id)}</span></div>` +
          `<ul class="r-rows" aria-labelledby="g-${b.id}" data-testid="group">${rs.map(row).join("")}</ul>`;
      }
    }
    return { head, body, r: "list" };
  }

  // The calendar ---------------------------------------------------------------------------------------

  function renderCalendar() {
    const days = S.view === "day" ? 1 : S.view === "3day" ? 3 : 7;
    const startP = parts(NOW, VIEWER);
    const dayStart = (i) => fromZoned(startP.y, startP.m, startP.d + i, 0, 0, VIEWER);
    const narrow = CT.settings.width === "800";
    const enabled = routines.filter((r) => r.enabled && (!S.bot || r.bot === S.bot));
    const frequent = enabled.filter((r) => perDay(r) > 4);
    const placed = enabled.filter((r) => perDay(r) <= 4);
    const hb = Object.entries(checkins).filter(([, c]) => c && c.every).map(([b, c]) => `${botName(b)} ${c.every === DAY ? "daily" : everyWords(c.every).toLowerCase()}`);
    let cols = "";
    let heads = "";
    let bands = "";
    for (let i = 0; i < days; i++) {
      const s = dayStart(i);
      const e = dayStart(i + 1);
      const p = parts(s, VIEWER);
      heads += `<div class="r-cal-dayhead" role="columnheader" data-today="${i === 0}">${i === 0 ? "Today" : WEEK[p.dow]}<small>${MONTHS[p.m - 1]} ${p.d}</small></div>`;
      bands += `<div class="r-cal-bands">${frequent.map((r) => `<div class="r-cal-band" title="${esc(`${everyWords(r.schedule.everyMs)} · ${botName(r.bot)}'s ${r.name}`)}">${esc(`${r.name} · ${everyWords(r.schedule.everyMs).toLowerCase()}`)}</div>`).join("")}</div>`;
      let chips = "";
      for (const r of placed) {
        const past = i === 0 ? r.runs.filter((x) => x.at >= s && x.at < NOW) : [];
        const future = occurrences(r.schedule, Math.max(s, NOW), e);
        for (const t of [...past.map((x) => x.at), ...future]) {
          const p2 = parts(t, VIEWER);
          const top = `calc(${p2.h + p2.min / 60} * var(--hour))`;
          const ran = past.find((x) => x.at === t);
          const o = ran && outcome(ran);
          const tip = `${r.name}, ${botName(r.bot)}, ${WEEK[p2.dow]} ${clock(t)}${ran ? `, ${o.short}` : ""}${r.schedule.kind === "cron" && readCron(r.schedule.expr)?.min === 0 && !ran ? ". May start up to 5 minutes later." : ""}`;
          chips += `<button type="button" class="r-occ" style="top:${top}" data-r="open" data-id="${r.id}" data-past="${!!ran}" data-outcome="${o?.mark === "failed" ? "failed" : ""}" aria-label="${esc(tip)}" title="${esc(tip)}" data-testid="occurrence">` +
            `<span class="avatar" data-bot="${r.bot}"></span><span>${esc(r.name)}</span></button>`;
        }
      }
      const nowLine = i === 0 ? `<span class="r-now" style="top:calc(${startP.h + startP.min / 60} * var(--hour))" aria-hidden="true"></span>` : "";
      cols += `<div class="r-cal-day" role="gridcell" aria-label="${i === 0 ? "Today" : WEEK[p.dow]}">${chips}${nowLine}</div>`;
    }
    const hours = Array.from({ length: 12 }, (_, k) => `<span style="top:calc(${k * 2} * var(--hour))">${k === 0 ? "" : hm(k * 2, 0).replace(":00", "")}</span>`).join("");
    const head =
      `<header class="r-head">${phone() ? backButton("Back to bots", "to-bots") : ""}<h1 id="view-title">Routines</h1><span class="spacer"></span>${seg()}` +
      (isAdmin() ? newButton("New routine") : "") + `</header>`;
    const body =
      `<div class="r-toolbar">${botSelect()}</div>` +
      `<div class="r-cal-bar"><button type="button" class="icon-button" aria-label="Previous">${icon("back")}</button><button type="button" class="icon-button" aria-label="Next">${icon("chevron")}</button>` +
      button("Today", 'data-size="sm"', "quiet") + `<span class="r-zone">Your time, New York</span></div>` +
      `<div class="r-cal-scroll"><div class="r-cal" role="grid" aria-label="Routines by day" style="--days:${days}" data-days="${days}" data-narrow="${narrow}" data-testid="calendar">` +
      `<div class="r-cal-checkins">Check-ins: ${esc(hb.join(", ") || "none")}</div>` +
      `<div class="r-cal-corner"></div>${heads}<div class="r-cal-corner"></div>${bands}<div class="r-cal-hours" aria-hidden="true">${hours}</div>${cols}</div></div>`;
    return { head, body, r: "calendar" };
  }

  // A routine's page ---------------------------------------------------------------------------------------

  function runRow(r, x, i) {
    const o = outcome(x);
    const how = x.running ? "Running…" : o.text;
    return `<li><button type="button" class="r-run" data-r="open-run" data-id="${r.id}" data-i="${i}" aria-label="${esc(`${when(x.at, VIEWER, true)}${x.manual ? ", started by hand" : ""}, ${how}`)}" data-testid="run-row">` +
      `<span class="r-row-mark">${x.running ? glyph("working") : o.mark ? glyph(o.mark) : ""}</span>` +
      `<span class="r-run-text"><span class="r-run-when">${esc(when(x.at, VIEWER, true))}${x.manual ? `<span class="r-faint"> · started by hand</span>` : ""}</span>` +
      `<span class="r-run-how">${o.tone && !x.running ? `<span data-tone="danger">${esc(how)}</span>` : esc(how)}</span></span>${icon("chevron")}</button></li>`;
  }
  function renderRoutine() {
    const r = r0();
    const tz = r.schedule.tz;
    const n = nextRun(r);
    const actions = isAdmin() && !S.deleted
      ? button(S.starting ? "Starting…" : r.enabled ? "Run now" : "Run once now", `data-size="sm" data-r="run-now" data-id="${r.id}"${S.starting ? " disabled" : ""}`) +
        `<span data-wide>${button(r.enabled ? "Pause" : "Resume", `data-size="sm" data-r="toggle" data-id="${r.id}"`)}${button("Edit", `data-size="sm" data-r="edit" data-id="${r.id}"`)}</span>` +
        `<button type="button" class="icon-button" data-r="more" data-id="${r.id}" aria-haspopup="menu" aria-expanded="false" aria-label="More for ${esc(r.name)}">${icon("more")}</button>`
      : "";
    const head =
      `<header class="r-head">${backButton(S.from === "calendar" ? "Back to the calendar" : "Back to routines", "back")}<div class="r-titles"><h1 id="view-title">${esc(r.name)}</h1>` +
      `<p><span class="avatar" data-bot="${r.bot}"></span>${botName(r.bot)}</p></div><span class="spacer"></span>${actions}</header>`;
    let state;
    if (S.deleted) state = "";
    else if (r.running) state = `${glyph("working")}<span>${r.enabled ? "Running since" : "Running once. It stays paused. Started"} ${clock(r.running)}</span>`;
    else if (!r.enabled) state = `<span>Paused. It won't run until resumed.</span>`;
    else if (lastRun(r) && outcome(lastRun(r)).mark === "failed") state = `${glyph("failed")}<span>The last run failed.</span>`;
    else state = `<span>Runs ${esc(wordsText(r.schedule)).replace(/^./, (c) => c.toLowerCase())}.</span>`;
    let body = S.deleted === "once"
      ? note(`<p><b>This routine ran once, and the gateway removed it.</b> Its run succeeded ${esc(when(lastRun(r).at))}. The gateway keeps nothing more of it, so once you leave this page it isn't shown again.</p><div class="b-actions">${button("Back to routines", 'data-r="back"')}</div>`)
      : S.deleted ? note(`<p><b>This routine was deleted.</b> It won't run again.</p><div class="b-actions">${button("Back to routines", 'data-r="back"')}</div>`, "warn") : "";
    body += `<p class="r-state" role="status" data-testid="state-line">${state}${S.already ? `<span class="r-already">It's already running.</span>` : ""}</p>`;
    // Instruction
    let instruction;
    if (r.payload.kind === "systemEvent") instruction = `<p class="r-hint">Posts a reminder in ${botName(r.bot)}'s main conversation:</p><p class="r-instruction">${esc(r.payload.text)}</p>`;
    else instruction = `<p class="r-instruction" data-testid="instruction">${esc(r.payload.message)}</p>`;
    body += `<section class="r-section"><h3>Instruction</h3>${instruction}</section>`;
    // When to run
    const c = r.schedule.kind === "cron" ? readCron(r.schedule.expr) : null;
    const schedCell = r.schedule.kind === "cron" && !plainCron(c) ? `<code class="r-mono">${esc(r.schedule.expr)}</code><small>in the gateway's cron format</small>` : wordsHtml(r.schedule, r.schedule.kind === "at");
    const nextCell = !r.enabled ? "None while paused" : n === undefined ? "None: it ran once and is done" :
      `${schedulerOff() ? '<span class="r-struck">' : ""}${esc(`${dayWord(n, tz || VIEWER, true)}, ${longDate(n, tz || VIEWER)}, ${clock(n, tz || VIEWER)}`)}${schedulerOff() ? "</span>" : ""}` +
      (tz && tz !== VIEWER ? `<small>${esc(clock(n))} your time</small>` : "");
    const fact = (k, v, id = "") => `<div${id ? ` data-fact="${id}"` : ""}><dt>${k}</dt><dd>${v}</dd></div>`;
    body += `<section class="r-section"><h3>When to run</h3><dl class="facts" data-testid="when">` +
      fact("Schedule", schedCell, "schedule") +
      (r.schedule.kind === "every" || r.schedule.kind === "at" ? "" : fact("Time zone", tz ? `${esc(city(tz))} <small>${esc(tz)}</small>` : "The gateway's own time zone", "zone")) +
      fact("Next run", nextCell, "next") +
      (r.trigger ? fact("Starts", `Only when its check passes<small><code class="r-mono">${esc(r.trigger)}</code></small>`, "starts") : "") +
      fact("Runs in", r.sessionTarget === "isolated" ? "A new conversation each time" : `${botName(r.bot)}'s main conversation`, "runs-in") +
      fact("Results", r.delivery === "none" ? "Kept with the run" : "Announced to the gateway's channels", "results") +
      fact("Triggers", "Its schedule only.<small>This gateway's webhooks start a bot directly, not a routine.</small>", "triggers") +
      `</dl>`;
    if (isAdmin() && P.get("hooks") === "on")
      body += `<details class="b-disclosure" data-testid="hooks"><summary>Gateway webhooks</summary><div class="b-disclosure-body"><dl class="facts">` +
        fact("POST to", `<code class="r-mono">/hooks/agent</code> ${copyButton("hook address", "/hooks/agent")}`) +
        fact("Key", "Kept on the gateway") + `</dl><p class="r-foot-note">These start a bot's turn directly. They can't start this routine.</p></div></details>`;
    body += `</section>`;
    // Runs
    const runs = r.running ? [{ at: r.running, running: true }, ...r.runs] : r.runs;
    body += `<section class="r-section" aria-labelledby="runs-head"><h3 id="runs-head">Runs</h3>`;
    if (S.state === "runs-error") body += `<p class="r-hint">Couldn't load runs. ${button("Try again", 'data-size="sm"')}</p>`;
    else if (!runs.length) body += `<p class="r-hint" data-testid="no-runs">${r.enabled && n !== undefined ? `No runs yet. The first is due ${esc(when(n, tz || VIEWER))}.` : "No runs yet."}</p>`;
    else body += `<ul class="r-rows" aria-labelledby="runs-head" data-testid="runs">${runs.slice(0, 20).map((x, i) => `${runRow(r, x, r.running ? i - 1 : i)}`).join("")}</ul>`;
    body += `<p class="r-foot-note">Clawtrate shows the 20 most recent runs. The gateway keeps 7 days of runs, and each run's conversation for 24 hours unless it is set to keep them longer.</p></section>`;
    return { head, body, r: "routine" };
  }

  // A run --------------------------------------------------------------------------------------------------

  function renderRun() {
    const r = r0();
    const i = S.run ?? 0;
    const x = i < 0 ? { at: r.running, running: true } : r.runs[i];
    const head =
      `<header class="r-head">${backButton("Back to the routine", "back-to-routine")}<div class="r-titles"><h1 id="view-title">${esc(`${r.name} · ${when(x.at, VIEWER, true)}`)}</h1>` +
      `<p><span class="avatar" data-bot="${r.bot}"></span>${botName(r.bot)}</p></div><span class="spacer"></span>${button("All runs", 'data-size="sm" data-r="back-to-routine"', "quiet")}</header>`;
    // A transcript is shown only when cron.history returned this run's messages. A run in a
    // shared conversation, or a job that is not an agent turn, has no conversation of its own.
    const where = r.payload.kind === "command" ? "command" : r.payload.kind !== "agentTurn" || r.sessionTarget !== "isolated" ? "main" : "";
    const rs = S.runstate || (x.running ? "running" : where || (x.history ? "" : "none"));
    const returned = () => `<p class="r-returned-head">What the run returned:</p><p data-testid="returned">${esc(x.summary || outcome(x).text)}</p>`;
    let body = "";
    if (rs === "loading") body = `<div class="r-convo" aria-busy="true"><span class="skeleton" style="display:block;width:70%;height:16px;margin:24px 0"></span><span class="skeleton" style="display:block;width:50%;height:16px"></span></div>`;
    else if (rs === "error") body = `<div class="work-empty" data-testid="run-error"><span class="empty-mark">${icon("warning")}</span><h4>Couldn't load this run.</h4><p>The gateway didn't answer in time.</p>${button("Try again")}</div>`;
    else {
      if (rs === "none")
        body += note(`<p><b>Clawtrate can't show this run's conversation.</b> The gateway returned none for it. It keeps a run's conversation for 24 hours unless it is set to keep them longer, so an older one may have been removed.</p>${returned()}`);
      else if (rs === "main")
        body += note(`<p><b>This run happened in ${botName(r.bot)}'s main conversation.</b> Its turn is there among the others; the gateway doesn't keep it apart.</p>${returned()}<div class="b-actions">${button(`Open ${botName(r.bot)}'s main conversation`, 'data-size="sm" data-r="open-bot"')}</div>`);
      else if (rs === "command") body += note(`<p><b>A command runs on the gateway, not a bot,</b> so this run has no conversation.</p>${returned()}`);
      else {
        // While it runs, the message shows only once cron.history returns it.
        if (x.history) body += `<div class="r-sched" data-testid="scheduled-message"><div class="r-sched-head">${icon("clock")}<span>Scheduled message, as the gateway recorded it</span></div><p>${esc(x.history.message)}</p></div>`;
        body += rs === "running"
          ? `<div class="turn" data-role="assistant"><details class="steps"><summary class="event-line">${glyph("working")} Reading notes ${icon("chevron")}</summary></details></div>`
          : `<div class="turn" data-role="assistant"><details class="steps"><summary class="event-line">Read 3 files ${icon("chevron")}</summary></details>` +
            `<div class="msg" data-role="assistant"><div class="bubble">${esc(x.history.reply)}</div></div></div>`;
      }
      const o = outcome(x);
      body += `<div class="r-run-foot" data-testid="run-foot">` +
        (rs === "running" ? `${glyph("working")} Running…` : `This run has finished. A run can't be answered; to change what it does, edit the routine.` +
          (isAdmin() && !S.deleted ? `<div class="b-actions">${button("Edit routine", `data-size="sm" data-r="edit" data-id="${r.id}"`)}</div>` : "") +
          `<span class="r-run-facts">${o.mark === "failed" ? esc(o.text) + " · " : ""}scripted/dev-1 · ${x.dur} s · ${x.inT} in, ${x.outT} out tokens</span>`) + `</div>`;
    }
    return { head, body: `<div class="r-convo">${body}</div>`, r: "run" };
  }

  // A task with check-ins in it: the conversation's side of section 13.

  function renderConvo() {
    const head = `<header class="r-head">${backButton("Back to bots", "to-bots")}<div class="r-titles"><h1 id="view-title">Heat pump vs. gas furnace</h1><p><span class="avatar" data-bot="juniper"></span>Juniper</p></div></header>`;
    const body =
      `<div class="r-convo transcript-inner" data-testid="convo">` +
      `<div class="turn" data-role="user"><div class="msg" data-role="user"><div class="bubble">What should I ask an installer before signing anything?</div></div></div>` +
      `<div class="turn" data-role="assistant"><div class="msg" data-role="assistant"><div class="bubble">Ask these five, and get the answers in writing.</div></div></div>` +
      `<div class="turn" data-role="assistant" data-testid="from-history"><p class="event-line">${icon("clock")} Juniper wrote this on its own · 6:00 AM</p><div class="msg" data-role="assistant"><div class="bubble">The installer's quote you saved expires on Friday.</div></div></div>` +
      `<div class="turn" data-role="assistant" data-testid="checkin"><p class="event-line">${icon("clock")} Checked in · 9:30 AM</p><div class="msg" data-role="assistant"><div class="bubble">The rebate form is due in three days and still needs the model number.</div></div></div>` +
      `<div class="turn" data-role="assistant" data-testid="created-card"><p class="event-line">${icon("clock")} Created routine <a class="r-link" data-r="open" data-id="digest" tabindex="0" role="link">Morning digest</a></p></div>` +
      `</div>`;
    return { head, body, r: "convo" };
  }

  // Paint ----------------------------------------------------------------------------------------------------

  function paint(focusSel) {
    const v = S.view;
    const out = v === "routine" ? renderRoutine() : v === "run" ? renderRun() : v === "convo" ? renderConvo() : ["day", "3day", "week"].includes(v) ? renderCalendar() : renderList();
    const el = $("#view");
    el.dataset.r = out.r;
    el.setAttribute("aria-label", out.r === "convo" ? "Conversation" : out.r === "run" ? "Routine run" : "Routines");
    el.innerHTML = `${out.head}<div class="r-body">${out.body}</div>${v === "convo" || v === "run" ? "" : accessBar()}`;
    CT.hydrate(el);
    renderRail();
    if (focusSel) $(focusSel)?.focus();
  }
  function go(view, extra = {}) {
    Object.assign(S, { view, already: false }, extra);
    $(".shell").dataset.view = "detail";
    paint(extra.focus || "#view-title");
    const t = $("#view-title");
    if (t && !extra.focus) {
      t.tabIndex = -1;
      t.focus();
    }
  }

  // Menus ------------------------------------------------------------------------------------------------------

  const menu = $("#r-menu");
  let menuOpener = null;
  function openMenu(opener, items, x, y) {
    menuOpener = opener;
    menu.innerHTML = items
      .map(([label, act, extra = ""]) => `<li role="none"><button type="button" class="menu-item" role="menuitem" data-r="${act}" ${extra}>${label}</button></li>`)
      .join("");
    menu.hidden = false;
    const rect = opener.getBoundingClientRect();
    menu.style.left = `${Math.min(x ?? rect.left, innerWidth - 248)}px`;
    menu.style.top = `${y ?? rect.bottom + 4}px`;
    opener.setAttribute?.("aria-expanded", "true");
    $(".menu-item", menu).focus();
  }
  function closeMenu(refocus = true) {
    if (menu.hidden) return;
    menu.hidden = true;
    menuOpener?.setAttribute?.("aria-expanded", "false");
    if (refocus) menuOpener?.focus();
  }
  const routineMenu = (r) =>
    isAdmin()
      ? [[r.enabled ? "Pause" : "Resume", "toggle", `data-id="${r.id}"`], [r.enabled ? "Run now" : "Run once now", "run-now", `data-id="${r.id}"`], ["Edit…", "edit", `data-id="${r.id}"`], ["Delete…", "delete", `data-id="${r.id}" data-tone="danger"`]]
      : [["Open", "open", `data-id="${r.id}"`]];

  // Actions ---------------------------------------------------------------------------------------------------------

  function toggle(id) {
    const r = routines.find((x) => x.id === id);
    if (P.get("pausefail") === "1" && r.enabled) {
      S.rowError = id;
      paint(`[data-r="toggle"][data-id="${id}"]`);
      return;
    }
    r.enabled = !r.enabled;
    S.rowError = null;
    announce(`${r.enabled ? "Resumed" : "Paused"} ${r.name}`);
    paint(`[data-r="toggle"][data-id="${id}"]`);
  }
  function runNow(id) {
    const r = routines.find((x) => x.id === id);
    if (r.running) {
      S.already = true;
      paint();
      setTimeout(() => {
        S.already = false;
        if (S.view === "routine") paint();
      }, 4000);
      return;
    }
    S.starting = S.view === "routine";
    paint(S.view === "routine" ? '[data-r="run-now"]' : null);
    setTimeout(() => {
      S.starting = false;
      r.running = NOW;
      announce(`Running ${r.name}`);
      paint(S.view === "routine" ? '[data-r="run-now"]' : null);
      setTimeout(() => {
        r.running = null;
        r.runs.unshift(run(0, 10, 12, { manual: true, dur: 2.4, tokens: 204, summary: DIGEST_SUMMARY, history: r.payload.kind === "agentTurn" ? recorded(r.payload.message, DIGEST_SUMMARY) : undefined }));
        announce(`${r.name} finished`);
        paint(S.view === "routine" ? '[data-r="run-now"]' : null);
      }, 1800);
    }, 500);
  }

  const confirmDialog = $("#confirm-dialog");
  function askDelete(id) {
    const r = routines.find((x) => x.id === id);
    const l = lastRun(r);
    confirmDialog.innerHTML =
      `<div class="b-confirm"><h2 id="confirm-title">Delete ${esc(r.name)}?</h2><p id="confirm-text">It won't run again, and Clawtrate can't show its runs afterwards.${l ? ` Its last run was ${esc(dayWord(l.at))} at ${esc(clock(l.at))}.` : ""}</p>` +
      `<div class="b-actions">${button("Cancel", 'data-r="confirm-cancel"', "quiet")}${button("Delete", `data-r="confirm-delete" data-id="${r.id}" data-tone="danger"`)}</div></div>`;
    lastFocus = document.activeElement;
    confirmDialog.showModal();
    $('[data-r="confirm-cancel"]', confirmDialog).focus();
  }

  // The editor ----------------------------------------------------------------------------------------------------

  const editDialog = $("#edit-dialog");
  let D = null;
  const ZONES = ["America/New_York", "Europe/London", "Europe/Paris", "Europe/Berlin", "Asia/Tokyo", "America/Los_Angeles"];
  // What decides the schedule in a draft: Save writes `schedule` only when this changed.
  const whenKey = (d) => JSON.stringify([d.kind, d.time, d.days, d.n, d.unit, d.date, d.tz, d.cron.trim()]);
  const two = (n) => String(n).padStart(2, "0");
  function draftFrom(r) {
    if (!r) {
      const bot = S.bot || "marlow";
      const zones = routines.filter((x) => x.bot === bot && x.schedule.tz).map((x) => x.schedule.tz);
      const d = { id: null, bot, name: "", instruction: "", kind: "weekdays", time: "08:00", days: [1], n: 30, unit: "minutes", date: "2026-11-20", tz: zones[0] || "auto", cron: "", runsIn: "isolated", results: "none", locked: false, updatedAtMs: null, errors: {}, status: "" };
      return Object.assign(d, { opened: whenKey(d) });
    }
    const s = r.schedule;
    const c = s.kind === "cron" ? readCron(s.expr) : null;
    const d = { id: r.id, bot: r.bot, name: r.name, instruction: r.payload.message || r.payload.text, kind: "weekdays", time: "08:00", days: [1], n: 30, unit: "minutes", date: "2026-11-20", tz: s.tz || "auto", cron: "", runsIn: r.sessionTarget, results: r.delivery, locked: false, updatedAtMs: r.updatedAtMs, errors: {}, status: "" };
    if (s.kind === "every") Object.assign(d, { kind: "every", n: s.everyMs % HOUR === 0 ? s.everyMs / HOUR : s.everyMs / MIN, unit: s.everyMs % HOUR === 0 ? "hours" : "minutes" });
    else if (s.kind === "at") {
      // The saved instant, read in the viewer's zone.
      const p = parts(atMs(s.at), VIEWER);
      Object.assign(d, { kind: "once", date: `${p.y}-${two(p.m)}-${two(p.d)}`, time: `${two(p.h)}:${two(p.min)}`, tz: "auto" });
    } else if (plainCron(c)) {
      d.time = `${String(c.h).padStart(2, "0")}:${String(c.min).padStart(2, "0")}`;
      d.kind = c.dows.length === 7 ? "daily" : c.dows.join() === "1,2,3,4,5" ? "weekdays" : "days";
      d.days = c.dows;
    } else d.locked = true;
    if (r.trigger) d.locked = true;
    // A reminder or a command keeps its payload: the form edits only an agent turn's message.
    if (r.payload.kind !== "agentTurn") Object.assign(d, { payload: r.payload, instruction: "" });
    d.opened = whenKey(d);
    return d;
  }
  function draftSchedule(d) {
    const [h, m] = d.time.split(":").map(Number);
    const tz = d.tz === "auto" ? VIEWER : d.tz;
    if (d.cron.trim()) return { kind: "cron", expr: d.cron.trim(), tz };
    if (d.kind === "every") return { kind: "every", everyMs: d.n * (d.unit === "hours" ? HOUR : MIN), anchorMs: 0 };
    if (d.kind === "once") {
      const [y, mo, da] = d.date.split("-").map(Number);
      return { kind: "at", at: isoWithOffset(fromZoned(y, mo, da, h, m, tz), tz) };
    }
    const dows = d.kind === "daily" ? "*" : d.kind === "weekdays" ? "1-5" : [...d.days].sort().join(",");
    return { kind: "cron", expr: `${m} ${h} * * ${dows}`, tz };
  }
  function previewText(d) {
    const s = draftSchedule(d);
    if (d.kind === "days" && !d.days.length) return "Choose at least one day to see when it runs.";
    const next = occurrences(s, NOW, NOW + 400 * DAY, 3);
    if (!next.length) return s.kind === "cron" ? `Runs as the gateway reads "${s.expr}".` : "It wouldn't run: that time has passed.";
    const tz = s.tz || VIEWER;
    const first = `${longDate(next[0], tz)}, ${clock(next[0], tz)}${tz !== VIEWER ? ` (${clock(next[0])} your time)` : ""}`;
    const rest = next.slice(1).map((t) => longDate(t, tz)).join(", ");
    const lead = typeof words(s) === "string" ? `Runs ${words(s, false).replace(/^./, (c) => c.toLowerCase())}${s.tz ? `, ${city(s.tz)} time` : ""}.` : `Runs as the gateway reads "${s.expr}".`;
    return `${lead} Next: ${first}${rest ? `, then ${rest}` : ""}.`;
  }
  // The smallest gap, in minutes, between two runs of a cron expression, read from
  // its seconds and minutes fields only: an hour field never brings runs closer.
  function cronGapMinutes(expr) {
    const f = expr.trim().split(/\s+/);
    if (f.length === 6 || f.length === 7) {
      if (!/^\d+$/.test(f[0])) return 0;
      f.shift();
    }
    const m = f[0] || "";
    if (/^\d+$/.test(m)) return 60;
    const step = m.match(/^(\*|\d+-\d+)\/(\d+)$/);
    if (step) return +step[2];
    if (m === "*" || /^\d+-\d+$/.test(m)) return 1;
    if (/^\d+(,\d+)+$/.test(m)) {
      const xs = m.split(",").map(Number).sort((a, b) => a - b);
      return Math.min(...xs.map((x, i) => (i ? x - xs[i - 1] : x + 60 - xs[xs.length - 1])));
    }
    return 60;
  }
  function validate(d) {
    const e = {};
    if (!d.name.trim()) e.name = "Give it a name.";
    if (!d.payload && !d.instruction.trim()) e.instruction = "Say what the bot should do.";
    if (!d.locked && (!d.id || whenKey(d) !== d.opened)) {
      if (d.kind === "every" && d.n * (d.unit === "hours" ? 60 : 1) < 5) e.when = "Routines run at least 5 minutes apart.";
      if (d.kind === "days" && !d.days.length) e.when = "Choose at least one day.";
      if (d.kind === "once" && atMs(draftSchedule(d).at) < NOW) e.when = "Pick a time in the future.";
      if (d.cron.trim() && cronGapMinutes(d.cron) < 5) e.cron = "Routines run at least 5 minutes apart.";
    }
    return e;
  }
  function field(id, label, control, error) {
    return `<div class="r-field"><label for="${id}">${label}</label>${control}${error ? `<p class="r-error" id="${id}-error">${esc(error)}</p>` : ""}</div>`;
  }
  const KINDS = [["daily", "Every day"], ["weekdays", "Weekdays"], ["days", "Some days of the week"], ["every", "Every few hours or minutes"], ["once", "Once"]];
  function renderEditor(focusSel) {
    const d = D;
    const r = d.id && routines.find((x) => x.id === d.id);
    const saving = d.status === "saving" || d.status === "checking";
    const dis = saving ? " disabled" : "";
    let notes = "";
    if (d.status === "refused") notes += note(`<p><b>The gateway didn't save this.</b> invalid cron.add params: CronPattern: invalid configuration format ('99 * * *'), exactly five, six, or seven space separated parts are required.</p>`, "danger");
    if (d.status === "conflict")
      notes += note(`<p><b>This routine was changed elsewhere</b> while you were editing.</p><div class="b-actions">${button("Show the new version", 'data-size="sm" data-r="conflict-show"')}${button("Save mine anyway", 'data-size="sm" data-r="conflict-save"', "quiet")}</div>`, "warn");
    if (d.status === "deleted")
      notes += note(`<p><b>This routine was deleted</b> while you were editing.</p><div class="b-actions">${button("Save as a new routine", 'data-size="sm" data-r="save-as-new"')}${button("Close", 'data-size="sm" data-r="edit-close"', "quiet")}</div>`, "warn");
    if (d.status === "noanswer") notes += note(`<p><b>The gateway didn't answer.</b> This may or may not have saved. Check what the gateway has before saving again.</p><div class="b-actions">${button("Check now", 'data-size="sm" data-r="check-now"')}</div>`, "warn");
    if (d.status === "checking") notes += note(`<p aria-busy="true">Checking what the gateway has…</p>`, "warn");
    // What the lookup found, said as found: it can't tell this save from the same change made elsewhere.
    if (d.status === "found") {
      const f = d.found;
      const again = `${button("Save again", 'data-size="sm" data-r="save"')}`;
      notes += note(
        f.kind === "same" ? `<p><b>${esc(r.name)} now reads as you typed it.</b> That may be your save, or the same change made elsewhere.</p><div class="b-actions">${button("Close", 'data-size="sm" data-r="edit-close"')}</div>`
          : f.kind === "differs" ? `<p><b>${esc(r.name)} doesn't read as you typed it.</b> The gateway has: ${esc(f.has)}.</p><div class="b-actions">${button("Check again", 'data-size="sm" data-r="check-now"')}${again}</div>`
          : f.kind === "match" ? `<p><b>The gateway has ${f.ids.length === 1 ? "a routine" : `${f.ids.length} routines`} for ${botName(d.bot)} named ${esc(d.name.trim())},</b> created ${esc(when(f.at))}. It may be the one you saved, or one made elsewhere.</p><div class="b-actions">${button("Open it", `data-size="sm" data-r="open-found" data-id="${f.ids[0]}"`)}${again}</div><p class="r-hint">Saving again makes another routine if that one is yours.</p>`
          : `<p><b>The gateway has no routine for ${botName(d.bot)} named ${esc(d.name.trim())}.</b> The save may still arrive.</p><div class="b-actions">${button("Check again", 'data-size="sm" data-r="check-now"')}${again}</div>`,
        "warn",
      );
    }
    const botField = d.id
      ? `<div class="r-field"><span class="r-label">Bot</span><p class="r-hint" style="margin:0">${botName(d.bot)}. To run it on another bot, make a new routine.</p></div>`
      : `<div class="r-field"><label for="e-bot">Bot</label><select class="input" id="e-bot" data-e="bot"${dis}>${bots.map((b) => `<option value="${b.id}"${b.id === d.bot ? " selected" : ""}>${b.name}</option>`).join("")}</select></div>`;
    const err = (k) => (d.errors[k] ? ` aria-invalid="true" aria-describedby="e-${k}-error"` : "");
    let whenField;
    if (d.locked) {
      whenField = `<div class="r-field"><span class="r-label">When</span><div class="r-locked" data-testid="locked"><code>${esc(r.schedule.expr || everyWords(r.schedule.everyMs))}</code>${r.schedule.tz ? `, ${esc(city(r.schedule.tz))}` : ""}<br />` +
        `This schedule was set on the gateway. You can rename the routine and change its instruction here; change its schedule on the gateway.</div></div>`;
    } else {
      const kinds = `<ul class="b-choices" role="radiogroup" aria-label="When" id="e-when"${err("when")}>` +
        KINDS.map(([k, t]) => `<li><button type="button" class="b-choice" role="radio" aria-checked="${d.kind === k && !d.cron}" tabindex="${d.kind === k ? 0 : -1}" data-e-kind="${k}"${dis}><span class="b-choice-text"><span class="b-choice-title">${t}</span></span>${icon("check", "icon b-tick")}</button></li>`).join("") + `</ul>`;
      let atField = "";
      if (["daily", "weekdays", "days"].includes(d.kind)) atField = `<div class="r-inline"><label for="e-time">At</label><input class="input" type="time" id="e-time" data-e="time" value="${d.time}"${dis} /></div>`;
      if (d.kind === "days")
        atField = `<div class="r-days" role="group" aria-label="Days">${[1, 2, 3, 4, 5, 6, 0].map((x) => `<button type="button" aria-pressed="${d.days.includes(x)}" data-e-day="${x}"${dis}>${WEEK[x]}</button>`).join("")}</div>` + atField;
      if (d.kind === "every")
        atField = `<div class="r-inline"><label for="e-n">Every</label><input class="input" type="number" min="1" id="e-n" data-e="n" value="${d.n}" style="width:88px"${err("when")}${dis} />` +
          `<select class="input" data-e="unit" aria-label="Unit"${dis}><option value="minutes"${d.unit === "minutes" ? " selected" : ""}>minutes</option><option value="hours"${d.unit === "hours" ? " selected" : ""}>hours</option></select></div>`;
      if (d.kind === "once") atField = `<div class="r-inline"><label for="e-date">On</label><input class="input" type="date" id="e-date" data-e="date" value="${d.date}"${dis} /><input class="input" type="time" aria-label="At" data-e="time" value="${d.time}"${dis} /></div>`;
      const zone = d.kind === "every" ? "" :
        `<div class="r-field"><label for="e-tz">Time zone</label><select class="input" id="e-tz" data-e="tz"${dis}><option value="auto"${d.tz === "auto" ? " selected" : ""}>Auto-detect (New York)</option>` +
        ZONES.map((z) => `<option value="${z}"${d.tz === z ? " selected" : ""}>${city(z)} (${z})</option>`).join("") + `</select>` +
        (d.tz === "auto" ? `<p class="r-hint">Writes this device's zone, America/New_York. It does not follow the device later.</p>` : "") + `</div>`;
      whenField = `<div class="r-field"><span class="r-label" id="e-when-label">When</span>${kinds}${atField}${d.errors.when ? `<p class="r-error" id="e-when-error">${esc(d.errors.when)}</p>` : ""}</div>${zone}` +
        `<p class="r-preview" aria-live="polite" data-testid="preview">${esc(previewText(d))}</p>`;
    }
    const more =
      `<details class="b-disclosure"${d.cron || d.errors.cron ? " open" : ""}><summary>More</summary><div class="b-disclosure-body r-dialog-more">` +
      (d.locked ? "" : field("e-cron", "Cron expression", `<input class="input r-mono" id="e-cron" data-e="cron" value="${esc(d.cron)}" placeholder="0 8 * * 1-5" autocomplete="off"${err("cron")}${dis} />`, d.errors.cron)) +
      `<div class="r-field"><label for="e-runs">Runs in</label><select class="input" id="e-runs" data-e="runsIn"${dis}><option value="isolated"${d.runsIn === "isolated" ? " selected" : ""}>A new conversation each time</option><option value="main"${d.runsIn === "main" ? " selected" : ""}>${botName(d.bot)}'s main conversation</option></select></div>` +
      `<div class="r-field"><label for="e-results">Results</label><select class="input" id="e-results" data-e="results"${dis}><option value="none"${d.results === "none" ? " selected" : ""}>Keep them with the run</option><option value="announce"${d.results === "announce" ? " selected" : ""}>Also announce to the gateway's channels</option></select></div>` +
      `</div></details>`;
    editDialog.innerHTML =
      `<header class="b-head"><h2 id="edit-title" tabindex="-1">${d.id ? "Edit routine" : "New routine"}</h2><button type="button" class="icon-button b-close" data-r="edit-close" aria-label="Close"${dis}>${icon("x")}</button></header>` +
      `<div class="b-body">${notes}${botField}` +
      field("e-name", "Name", `<input class="input" id="e-name" data-e="name" maxlength="80" autocomplete="off" value="${esc(d.name)}"${err("name")}${dis} />`, d.errors.name) +
      (d.payload
        ? `<div class="r-field"><span class="r-label">${d.payload.kind === "systemEvent" ? "Reminder" : "Command"}</span><div class="r-locked" data-testid="payload-locked">${esc(d.payload.text || d.payload.argv.join(" "))}<br />` +
          `This ${d.payload.kind === "systemEvent" ? "reminder's text" : "command"} was set on the gateway. You can rename the routine and change when it runs here; change ${d.payload.kind === "systemEvent" ? "its text" : "it"} on the gateway.</div></div>`
        : field("e-instr", "Instruction", `<textarea class="input" id="e-instr" data-e="instruction" placeholder="What should ${botName(d.bot)} do each time? For example: Summarise yesterday's notes and list anything I need to answer."${err("instruction")}${dis}>${esc(d.instruction)}</textarea>`, d.errors.instruction)) +
      whenField + more + (d.id ? "" : `<p class="r-hint">It runs first at its next time; creating it doesn't run it.</p>`) +
      `</div><footer class="b-foot"><div class="b-actions">${button("Cancel", `data-r="edit-close"${dis}`, "quiet")}${d.status === "found" ? "" : button(d.status === "saving" ? "Saving…" : "Save", `data-r="save"${dis}`, "primary")}</div></footer>`;
    if (!editDialog.open) {
      lastFocus = document.activeElement;
      editDialog.showModal();
    }
    (focusSel ? $(focusSel, editDialog) : null)?.focus() || (!focusSel && $("#edit-title", editDialog).focus());
  }
  function openEditor(id) {
    D = draftFrom(id && routines.find((x) => x.id === id));
    renderEditor();
  }
  function save() {
    D.errors = validate(D);
    const first = Object.keys(D.errors)[0];
    if (first) {
      renderEditor(first === "when" ? "#e-when [aria-checked='true'], #e-n" : `#e-${first === "instruction" ? "instr" : first}`);
      return;
    }
    const outcomeOf = P.get("editstate");
    const d = D;
    d.status = "saving";
    renderEditor('[data-r="save"]');
    setTimeout(() => {
      // An answer belongs to the draft that sent it, even if its dialog has closed since.
      if (D !== d) {
        if (!outcomeOf) {
          land(request(d));
          announce(`Saved ${d.name.trim()}`);
          paint();
        }
        return;
      }
      if (outcomeOf === "refused" || outcomeOf === "conflict" || outcomeOf === "noanswer") {
        // lookup=found: the unanswered save did reach the gateway.
        if (outcomeOf === "noanswer" && P.get("lookup") === "found") land(request(d));
        d.status = outcomeOf;
        renderEditor(outcomeOf === "noanswer" ? '[data-r="check-now"]' : '[data-r="save"]');
        return;
      }
      commit();
    }, 600);
  }
  // Check now: cron.get for an edit, cron.list for a new routine. It reports and never saves.
  function checkNow() {
    const d = D;
    d.status = "checking";
    renderEditor("#edit-title");
    setTimeout(() => {
      if (D !== d) return;
      const r = d.id && routines.find((x) => x.id === d.id);
      if (r) {
        const left = request(d).params.patch;
        d.found = Object.keys(left).length ? { kind: "differs", has: `${r.name}, ${wordsText(r.schedule)}` } : { kind: "same" };
      } else {
        const ids = routines.filter((x) => !x.gone && x.bot === d.bot && x.name === d.name.trim()).map((x) => x.id);
        d.found = ids.length ? { kind: "match", ids, at: routines.find((x) => x.id === ids[0]).createdAtMs } : { kind: "none" };
      }
      d.status = "found";
      renderEditor(".b-note .button");
      announce("Checked");
    }, 400);
  }
  // What Save sends: cron.add with every field, or cron.update with only what changed.
  function request(d) {
    const r = d.id && routines.find((x) => x.id === d.id);
    const payload = d.payload || { kind: "agentTurn", message: d.instruction.trim() };
    const all = { name: d.name.trim(), payload, sessionTarget: d.runsIn, delivery: d.results };
    if (!d.locked) all.schedule = draftSchedule(d);
    if (!r) return { method: "cron.add", params: { ...all, agentId: d.bot, wakeMode: "now" } };
    const patch = {};
    if (all.name !== r.name) patch.name = all.name;
    if (r.payload.kind === "agentTurn" && payload.message !== r.payload.message) patch.payload = payload;
    if (all.sessionTarget !== r.sessionTarget) patch.sessionTarget = all.sessionTarget;
    if (all.delivery !== r.delivery) patch.delivery = all.delivery;
    if (!d.locked && whenKey(d) !== d.opened) patch.schedule = all.schedule;
    return { method: "cron.update", params: { id: r.id, patch } };
  }
  const sent = [];
  // The gateway's side of a write: what a later cron.get or cron.list would return.
  function land(req) {
    sent.push(req);
    if (req.method === "cron.update") {
      Object.assign(routines.find((x) => x.id === req.params.id), req.params.patch, { updatedAtMs: NOW });
      return req.params.id;
    }
    const { agentId, wakeMode, ...fields } = req.params;
    const id = `r${routines.length + 1}`;
    routines.push({ id, bot: agentId, enabled: true, runs: [], updatedAtMs: NOW, createdAtMs: NOW, ...fields });
    return id;
  }
  function commit() {
    const d = D;
    const id = land(request(d));
    const created = !d.id;
    editDialog.close();
    D = null;
    announce(created ? "Routine created" : "Saved");
    go("routine", { routine: id, deleted: false });
  }

  // Check-ins ----------------------------------------------------------------------------------------------------------

  const ciDialog = $("#checkins-dialog");
  let C = null;
  const CI = [["off", "Off"], ["daily", "Daily"], ["asneeded", "As needed"], ["every", "Every…"]];
  const ciChoice = (c) => (!c ? "off" : !c.every ? "off" : c.every === DAY ? "daily" : c.every === 30 * MIN ? "asneeded" : "every");
  function renderCheckins(focusSel) {
    const name = botName(C.bot);
    const sub = {
      off: `${name} doesn't check in on a schedule.`,
      daily: `Once a day, ${name} looks for anything that needs you.`,
      asneeded: `Every 30 minutes, ${name} looks for anything that needs you, and stays quiet when nothing does. Most check-ins say nothing.`,
      every: `${name} looks for anything that needs you as often as you choose, and stays quiet when nothing does.`,
    };
    const defaultBots = Object.entries(checkins).filter(([, c]) => c && c.source === "default" && c.every).map(([b]) => b);
    let catchNote = "";
    if (defaultBots.length && (P.get("catch") === "1" || C.choice !== C.initial)) {
      catchNote = defaultBots.includes(C.bot)
        ? note(`<p>${name} checks in now through the gateway's default. Saving gives ${name} a setting of its own.</p>`)
        : note(`<p>${defaultBots.map(botName).join(" and ")} checks in now through the gateway's default. Saving also gives ${defaultBots.map(botName).join(" and ")} a setting of its own with the same cadence, so it keeps checking in.</p>`);
    }
    const promptNote = C.prompt.trim() && !/NO_REPLY/.test(C.prompt)
      ? `<p class="r-error" id="ci-prompt-note" data-testid="prompt-note">Without "If nothing needs attention, reply NO_REPLY", every check-in will post a message.</p>` : "";
    const saving = C.status === "saving";
    const dis = saving ? " disabled" : "";
    ciDialog.innerHTML =
      `<header class="b-head"><h2 id="checkins-title" tabindex="-1">${esc(name)}'s check-ins</h2><button type="button" class="icon-button b-close" data-r="ci-close" aria-label="Close"${dis}>${icon("x")}</button></header>` +
      `<div class="b-body"><ul class="b-choices" role="radiogroup" aria-label="Check-ins">` +
      CI.map(([k, t]) => `<li><button type="button" class="b-choice" role="radio" aria-checked="${C.choice === k}" tabindex="${C.choice === k ? 0 : -1}" data-ci="${k}"${saving ? " disabled" : ""}><span class="b-choice-text"><span class="b-choice-title">${t}</span><span class="b-choice-sub">${esc(sub[k])}</span></span>${icon("check", "icon b-tick")}</button></li>`).join("") +
      `</ul>` +
      (C.choice === "every" ? `<div class="r-inline"><label for="ci-every">Every</label><select class="input" id="ci-every" data-ci-every>${[["15m", "15 minutes"], ["1h", "1 hour"], ["2h", "2 hours"], ["4h", "4 hours"], ["8h", "8 hours"], ["12h", "12 hours"]].map(([v, t]) => `<option value="${v}"${C.every === v ? " selected" : ""}>${t}</option>`).join("")}</select></div>` : "") +
      (C.choice === "off" ? `<p class="r-hint" data-testid="off-note">${esc(name)} still reports when a command it started in the background finishes.</p>` : "") +
      `<details class="b-disclosure"${C.prompt ? " open" : ""}><summary>What to check</summary><div class="b-disclosure-body"><div class="r-field"><label for="ci-prompt">Prompt</label>` +
      `<textarea class="input" id="ci-prompt" data-ci-prompt placeholder="Follow the heartbeat monitor scratch context when provided. … If nothing needs attention, reply NO_REPLY."${promptNote ? ' aria-describedby="ci-prompt-note"' : ""}>${esc(C.prompt)}</textarea>` +
      `${promptNote}<p class="r-hint">Empty uses the gateway's own prompt.</p></div></div></details>${catchNote}</div>` +
      `<footer class="b-foot"><div class="b-actions">${button("Cancel", `data-r="ci-close"${dis}`, "quiet")}${button(saving ? "Saving…" : "Save", `data-r="ci-save"${saving ? " disabled" : ""}`, "primary")}</div></footer>`;
    if (!ciDialog.open) {
      lastFocus = document.activeElement;
      ciDialog.showModal();
    }
    (focusSel ? $(focusSel, ciDialog) : $("#checkins-title", ciDialog)).focus();
  }
  function openCheckins(bot) {
    const c = checkins[bot];
    const choice = ciChoice(c);
    C = { bot, choice, initial: choice, every: "2h", prompt: c?.prompt || "", status: "" };
    renderCheckins();
  }

  // Events ---------------------------------------------------------------------------------------------------------------

  document.addEventListener("click", (event) => {
    const copy = event.target.closest(".copy[data-copy]");
    if (copy) {
      const done = () => announce(`Copied ${copy.dataset.what}`);
      const refused = () => {
        const code = copy.previousElementSibling;
        if (code) getSelection().selectAllChildren(code);
        announce(`Selected. Press ⌘C to copy the ${copy.dataset.what}.`);
      };
      navigator.clipboard?.writeText(copy.dataset.copy).then(done, refused) ?? refused();
      return;
    }
    const t = event.target.closest("[data-r], [data-e-kind], [data-e-day], [data-ci]");
    if (!t) {
      if (!menu.contains(event.target)) closeMenu(false);
      return;
    }
    if (t.dataset.eKind) {
      D.kind = t.dataset.eKind;
      D.cron = "";
      D.errors = {};
      return renderEditor(`[data-e-kind="${D.kind}"]`);
    }
    if (t.dataset.eDay) {
      const x = +t.dataset.eDay;
      D.days = D.days.includes(x) ? D.days.filter((y) => y !== x) : [...D.days, x];
      return renderEditor(`[data-e-day="${x}"]`);
    }
    if (t.dataset.ci) {
      C.choice = t.dataset.ci;
      return renderCheckins(`[data-ci="${C.choice}"]`);
    }
    const id = t.dataset.id;
    const act = t.dataset.r;
    if (t.closest("#r-menu")) closeMenu(false);
    switch (act) {
      case "open-view":
        return go("list", { bot: "" });
      case "seg":
        return go(t.dataset.v, { focus: `[data-r="seg"][data-v="${t.dataset.v}"]` });
      case "open":
        return go("routine", { routine: id, from: ["day", "3day", "week"].includes(S.view) ? "calendar" : S.view === "convo" ? "convo" : "list", back: S.view, deleted: false });
      case "back":
        return go(S.back && S.back !== "routine" && S.back !== "run" ? S.back : "list", { deleted: false, focus: `[data-r="open"][data-id="${S.routine}"]` });
      case "open-run":
        return go("run", { run: +t.dataset.i, runstate: "" });
      case "open-run-task":
        return go("run", { routine: id, run: 0, runstate: "", back: "list" });
      case "back-to-routine":
        return go("routine", { focus: `[data-r="open-run"][data-i="${S.run}"]` });
      case "open-bot":
        return go("convo");
      case "to-bots":
        $(".shell").dataset.view = "list";
        return $("#routines-button").focus();
      case "toggle":
        return toggle(id);
      case "run-now":
        return runNow(id);
      case "more":
        return openMenu(t, routineMenu(routines.find((x) => x.id === id)));
      case "bot-menu":
        return openMenu(t, [["All bots", "pick-bot", 'data-id=""'], ...bots.map((b) => [b.name, "pick-bot", `data-id="${b.id}"`])]);
      case "pick-bot":
        return go("list", { bot: id, focus: '[data-r="bot-menu"]' });
      case "new":
        return openEditor(null);
      case "edit":
        return openEditor(id);
      case "delete":
        return askDelete(id);
      case "confirm-cancel":
        confirmDialog.close();
        return lastFocus?.focus();
      case "confirm-delete": {
        const r = routines.find((x) => x.id === id);
        routines = routines.filter((x) => x.id !== id);
        confirmDialog.close();
        announce(`Deleted ${r.name}`);
        return go("list", { focus: "#view-title" });
      }
      case "edit-close":
        editDialog.close();
        D = null;
        return lastFocus?.focus();
      case "save":
        return save();
      case "conflict-show": {
        const mine = D;
        D = draftFrom(routines.find((x) => x.id === mine.id));
        D.status = "";
        return renderEditor("#e-name");
      }
      case "conflict-save":
        D.status = "";
        return commit();
      case "check-now":
        return checkNow();
      case "open-found":
        editDialog.close();
        return go("routine", { routine: id, from: "list", back: "list", deleted: false });
      case "save-as-new":
        D.id = null;
        D.status = "";
        return commit();
      case "checkins":
        return openCheckins(id);
      case "ci-close":
        ciDialog.close();
        C = null;
        return lastFocus?.focus();
      case "ci-save": {
        const c0 = C;
        c0.status = "saving";
        renderCheckins('[data-r="ci-save"]');
        return setTimeout(() => {
          const every = { off: 0, daily: DAY, asneeded: 30 * MIN, every: { "15m": 15 * MIN, "1h": HOUR, "2h": 2 * HOUR, "4h": 4 * HOUR, "8h": 8 * HOUR, "12h": 12 * HOUR }[c0.every] }[c0.choice];
          for (const [, c] of Object.entries(checkins)) if (c && c.source === "default") c.source = "own";
          checkins[c0.bot] = { every, source: "own", prompt: c0.prompt };
          announce("Check-ins saved");
          // The answer is this draft's: a dialog opened since keeps its own.
          if (C !== c0) return paint();
          ciDialog.close();
          C = null;
          paint('[data-r="checkins"]');
        }, 600);
      }
      case "request":
        S.req = "asking";
        paint();
        announce("Asking the gateway");
        return setTimeout(() => {
          S.req = "requested";
          paint('[data-r="access-check"]');
          announce("Access requested");
        }, 600);
      case "access-check":
        S.access = "admin";
        S.req = "granted";
        announce("Admin access granted");
        paint('[data-r="access-check"]');
        return setTimeout(() => {
          S.req = "";
          paint();
        }, 4000);
      case "access-cancel":
        S.req = "";
        return paint('[data-r="request"]');
      case "away-keep":
      case "away-never":
        S.away = false;
        return paint("#view-title");
      case "away-pause":
        for (const r of routines) r.enabled = false;
        S.away = false;
        announce("Paused every routine");
        return paint("#view-title");
      case "retry":
        S.state = "";
        return paint();
    }
  });

  document.addEventListener("input", (event) => {
    const t = event.target;
    if (D && t.dataset.e) {
      D[t.dataset.e] = t.dataset.e === "n" ? Math.max(0, +t.value || 0) : t.value;
      if (t.dataset.e === "bot") return renderEditor(`[data-e="bot"]`);
      const p = $('[data-testid="preview"]', editDialog);
      if (p) p.textContent = previewText(D);
      if (["tz", "unit"].includes(t.dataset.e)) renderEditor(`[data-e="${t.dataset.e}"]`);
    }
    if (C && t.matches("[data-ci-prompt]")) {
      C.prompt = t.value;
      const had = !!$('[data-testid="prompt-note"]', ciDialog);
      const has = C.prompt.trim() && !/NO_REPLY/.test(C.prompt);
      if (had !== !!has) {
        renderCheckins("[data-ci-prompt]");
        const ta = $("[data-ci-prompt]", ciDialog);
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    }
    if (C && t.matches("[data-ci-every]")) C.every = t.value;
  });

  // Radio groups: one tab stop, arrows move and choose.
  document.addEventListener("keydown", (event) => {
    const t = event.target;
    if (!menu.hidden && event.key === "Escape") {
      event.preventDefault();
      return closeMenu();
    }
    if (!menu.hidden && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      const items = $$(".menu-item", menu);
      const i = items.indexOf(document.activeElement);
      items[(i + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
      return event.preventDefault();
    }
    const group = t.closest?.('[role="radiogroup"]');
    if (group && ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) {
      const items = $$('[role="radio"]', group);
      const i = items.indexOf(t);
      const j = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (i + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + items.length) % items.length;
      event.preventDefault();
      items[j].click();
      return;
    }
    const rowMain = t.closest?.(".r-row-main");
    if (rowMain && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
      event.preventDefault();
      openMenu(rowMain, routineMenu(routines.find((x) => x.id === rowMain.dataset.id)));
    }
  });
  document.addEventListener("contextmenu", (event) => {
    const rowMain = event.target.closest(".r-row-main");
    if (!rowMain) return;
    event.preventDefault();
    openMenu(rowMain, routineMenu(routines.find((x) => x.id === rowMain.dataset.id)), event.clientX, event.clientY);
  });
  // While a save is in flight its dialog stays open: Escape waits for the answer.
  const busy = () => ["saving", "checking"].includes(D?.status) || C?.status === "saving";
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && busy()) event.preventDefault();
  }, true);
  for (const dlg of [editDialog, ciDialog]) dlg.addEventListener("cancel", (event) => busy() && event.preventDefault());
  for (const dlg of [editDialog, ciDialog, confirmDialog])
    dlg.addEventListener("close", () => {
      if (dlg === editDialog) D = null;
      if (dlg === ciDialog) C = null;
    });

  // First paint, from the address ------------------------------------------------------------------------------------------

  const startView = P.get("transcript") === "checkin" ? "convo" : S.view === "checkins" ? "list" : S.view;
  S.view = startView;
  if (P.get("view") === "run" && S.run === null) S.run = 0;
  if (S.view === "routine" || S.view === "run") S.back = "list";
  paint();
  if (P.get("confirm") === "delete") askDelete(S.routine);
  if (S.edit === "new" || S.edit === "open" || S.editstate === "locked") {
    if (S.editstate === "locked") S.routine = "renewal";
    openEditor(S.edit === "new" ? null : S.routine);
    if (S.editstate === "invalid") {
      Object.assign(D, { kind: "every", n: 2, unit: "minutes" });
      D.errors = validate(D);
      renderEditor();
    } else if (["refused", "conflict", "deleted", "noanswer", "saving"].includes(S.editstate)) {
      D.status = S.editstate;
      renderEditor();
    }
  }
  if (P.get("dialog") === "open") openCheckins(S.bot || "juniper");
  // For the checks: what Save sent, as the gateway would receive it.
  window.routines = { sent, routine: (id) => routines.find((r) => r.id === id) };
  document.addEventListener("ct:settings", () => paint());
})();
