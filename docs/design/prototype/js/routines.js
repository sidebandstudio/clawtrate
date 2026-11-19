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

  // The gateway reads cron with croner 10.0.1 (`new Cron(expr, {timezone, catch: false})`),
  // so this follows croner's grammar: five, six (seconds first) or seven (then the year)
  // fields, names, ranges, `*/n` and `a-b/n` steps, `?`, `L`, `nW`, `n#k`, `nL`, a leading
  // `+` for day-of-month AND day-of-week, and the @ nicknames. It returns the firing
  // seconds, minutes and hours and a test for a day, or the reason it can't be read.
  const NICK = { "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *", "@weekly": "0 0 * * 0", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *" };
  const MON_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const cronCache = new Map();
  const cronSpec = (expr) => (cronCache.has(expr) ? cronCache.get(expr) : cronCache.set(expr, readCronSpec(expr)).get(expr));
  function readCronSpec(expr) {
    const raw = expr.trim();
    const f = (NICK[raw.toLowerCase()] ?? raw).split(/\s+/);
    if (f.length < 5 || f.length > 7) return { error: "it needs five, six or seven fields" };
    if (f.length === 5) f.unshift("0");
    if (f.length === 6) f.push("*");
    const [secF, minF, hourF, domF, monF, dowF0, yearF] = f;
    const and = dowF0.startsWith("+");
    const dowF = and ? dowF0.slice(1) : dowF0;
    const num = (t, names, offset, what) => {
      const i = names ? names.indexOf(t.toLowerCase()) : -1;
      if (i >= 0) return i + offset;
      if (!/^\d+$/.test(t)) throw `${what} "${t}" isn't a number`;
      return +t;
    };
    // One field: the values it lists, with `L`, `W` and `#` items kept apart for the day test.
    function field(text, lo, hi, what, names = null, offset = 0, extra = null) {
      const set = new Set();
      for (const item of text.split(",")) {
        if (extra && extra(item)) continue;
        const [base, step, more] = item.split("/");
        if (more !== undefined || base === "") throw `"${item}" isn't a ${what}`;
        if (step !== undefined && !/^\d+$/.test(step)) throw `the step in "${item}" isn't a number`;
        if (step !== undefined && (+step === 0 || +step > hi - lo + 1)) throw `the step in "${item}" is out of range`;
        let a, b;
        if (base === "*" || base === "?") [a, b] = [lo, hi];
        else if (base.includes("-")) {
          const ends = base.split("-");
          if (ends.length !== 2) throw `"${base}" isn't a range`;
          const [x, y] = ends;
          [a, b] = [num(x, names, offset, what), num(y, names, offset, what)];
          if (a > b) throw `"${base}" runs backwards`;
        } else {
          if (step !== undefined) throw `a step needs * or a range before it, not "${base}"`;
          a = b = num(base, names, offset, what);
        }
        if (a < lo || b > hi) throw `${what} ${a < lo ? a : b} is out of range`;
        for (let v = a; v <= b; v += step ? +step : 1) set.add(v);
      }
      return [...set].sort((x, y) => x - y);
    }
    try {
      const last = { L: false, LW: false, W: [] };
      const doms = field(domF, 1, 31, "day of the month", null, 0, (it) => {
        if (it === "L" || it === "LW") return (last[it] = true);
        const w = it.match(/^(\d+)W$/);
        if (w && +w[1] >= 1 && +w[1] <= 31) return last.W.push(+w[1]);
        return false;
      });
      const nth = [];
      const dows = field(dowF, 0, 7, "day of the week", DOW_NAMES, 0, (it) => {
        const m = it.match(/^([^#L]+)(#([1-5]|L)|L)$/i);
        if (!m) return false;
        const k = m[3] ? (m[3].toUpperCase() === "L" ? "L" : +m[3]) : "L";
        for (const v of field(m[1], 0, 7, "day of the week", DOW_NAMES)) nth.push([v % 7, k]);
        return true;
      }).map((v) => v % 7);
      const spec = {
        sec: field(secF, 0, 59, "second"),
        min: field(minF, 0, 59, "minute"),
        hour: field(hourF, 0, 23, "hour"),
        mon: field(monF, 1, 12, "month", MON_NAMES, 1),
        year: field(yearF, 1, 9999, "year"),
      };
      // croner marks a field as any only when it is written `*`: a `?` lists every value but
      // still counts as written, so `1 * ?` fires on the 1st OR any weekday, which is every day.
      const domAny = domF === "*";
      const dowAny = dowF === "*";
      const weekday = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      const nearestWeekday = (y, m, n, end) => {
        const w = weekday(y, m, n);
        if (w === 6) return n > 1 ? n - 1 : n + 2;
        if (w === 0) return n < end ? n + 1 : n - 2;
        return n;
      };
      spec.day = (y, m, d) => {
        if (!spec.mon.includes(m) || !spec.year.includes(y)) return false;
        const end = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const w = weekday(y, m, d);
        const domHit = doms.includes(d) || (last.L && d === end) || (last.LW && d === nearestWeekday(y, m, end, end)) || last.W.some((n) => n <= end && d === nearestWeekday(y, m, n, end));
        const dowHit = dows.includes(w) || nth.some(([v, k]) => v === w && (k === "L" ? d + 7 > end : Math.ceil(d / 7) === k));
        if (domAny && dowAny) return true;
        if (domAny) return dowHit;
        if (dowAny) return domHit;
        return and ? domHit && dowHit : domHit || dowHit;
      };
      // The firing times of one day, in seconds after midnight on the schedule's own clock.
      spec.times = spec.hour.flatMap((h) => spec.min.flatMap((mi) => spec.sec.map((s) => h * 3600 + mi * 60 + s)));
      return spec;
    } catch (why) {
      return { error: String(why) };
    }
  }
  // The window the floor, "never runs" and the preview all use (section 9): 2,922 calendar
  // days starting with today's date on the schedule's clock.
  const CRON_SCAN_DAYS = 2922;
  const horizon = (tz) => {
    const p = parts(NOW, tz);
    return fromZoned(p.y, p.m, p.d + CRON_SCAN_DAYS, 0, 0, tz);
  };
  // F-195: the shortest spacing, in seconds, between two consecutive firings on the
  // schedule's nominal wall clock. Within a day it is the closest two firing times; across
  // midnight it is the last time to the next day's first, when two consecutive dates in the
  // window both fire. Today counts whole, its elapsed times included.
  function cronSpacing(spec, tz) {
    const t = spec.times;
    let gap = Infinity;
    for (let i = 1; i < t.length; i++) gap = Math.min(gap, t[i] - t[i - 1]);
    const start = parts(NOW, tz);
    let prev = false;
    for (let i = 0; i < CRON_SCAN_DAYS; i++) {
      const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
      const hit = spec.day(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
      if (hit && prev) gap = Math.min(gap, t[0] + DAY / 1000 - t[t.length - 1]);
      prev = hit;
    }
    return gap;
  }
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
    if (s.kind === "on-exit" || s.kind === "stream") return { mono: [].concat(s.command).join(" "), zone: "" };
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
    const c = cronSpec(s.expr);
    const tz = s.tz || VIEWER;
    const start = parts(from - DAY, tz);
    const instants = new Set();
    for (let i = 0; i <= CRON_SCAN_DAYS && instants.size < max; i++) {
      const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
      const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
      const midnight = fromZoned(y, m, d, 0, 0, tz);
      if (midnight >= until) break;
      if (!c.day(y, m, d)) continue;
      const regular = fromZoned(y, m, d + 1, 0, 0, tz) - midnight === DAY;
      for (const sec of c.times) {
        const h = Math.floor(sec / 3600), mi = Math.floor(sec / 60) % 60;
        const t = fromZoned(y, m, d, h, mi, tz) + (sec % 60) * 1000;
        const p = parts(t, tz);
        // Croner uses the offset before the gap for a skipped wall time.
        const shift = Date.UTC(y, m - 1, d, h, mi) - Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
        if (regular && (t >= until || instants.size >= max)) break;
        const firing = t + Math.max(0, shift);
        if (firing >= from && firing < until) instants.add(firing);
      }
    }
    // The gateway schedules each instant once, even if two wall times map to it.
    return [...instants].sort((a, b) => a - b).slice(0, max);
  }
  // What Clawtrate can't expand is drawn only at the gateway's own next run (section 4).
  const computable = (r) => ["at", "every"].includes(r.schedule.kind) || (r.schedule.kind === "cron" && r.schedule.tz && !r.pacing && !cronSpec(r.schedule.expr).error);
  // The gateway's own `state.nextRunAtMs` when the job carries it; computed only for a fixture without it.
  function nextRun(r) {
    if (!r.enabled) return;
    if (r.state?.nextRunAtMs !== undefined) return r.state.nextRunAtMs;
    if (!computable(r)) return;
    const s = r.schedule;
    return occurrences(s, NOW + 1, s.kind === "cron" ? horizon(s.tz) : Infinity, 1)[0];
  }
  const perDay = (r) => (!computable(r) ? 1 : r.schedule.kind === "every" ? DAY / r.schedule.everyMs : r.schedule.kind === "cron" ? cronSpec(r.schedule.expr).times.length : 1);

  // Fixtures ------------------------------------------------------------------------------

  const bots = [
    { id: "juniper", name: "Juniper", preview: "Ask these five, and get the answers in writing.", time: "5:24 PM" },
    { id: "marlow", name: "Marlow", preview: "Tightened the intro and cut about 80 words.", time: "4:58 PM" },
    { id: "otto", name: "Otto", preview: "Done. The disk is now at 61%.", time: "5:36 PM" },
    { id: "pip", name: "Pip", preview: "Here is the week, with Thursday kept clear.", time: "3:10 PM" },
  ];
  const botName = (id) => bots.find((b) => b.id === id)?.name ?? id;

  // `runId` is the run's identity on the gateway (section 7); a fixture's is only unique.
  let runSeq = 0;
  const run = (daysAgo, h, min, extra = {}) => ({ runId: `run-${++runSeq}`, at: at(daysAgo, h, min), status: "ok", completion: "succeeded", dur: 2.6, tokens: 200, inT: 120, outT: 80, manual: false, ...extra });
  const PREAMBLE =
    "This is an unattended scheduled run. Nobody is present to clarify or approve, so complete the task with what you have. Your final reply is the deliverable — not a plan, an acknowledgement, or a request for input. If nothing needs doing, reply exactly NO_REPLY.";
  // A run's `history` is what cron.history returned for its runId: the first message as
  // the gateway recorded it, and the reply. Runs without it returned no messages.
  const recorded = (instruction, reply) => ({ message: `${instruction}\n\n${PREAMBLE}`, reply });
  const DIGEST_SUMMARY =
    "Three notes from yesterday. The draft for Sam is ready to send. Two emails need an answer today: the venue's question about numbers and the printer's quote.";
  let routineSeq = 0;
  let routines = [
    {
      id: "digest", bot: "marlow", name: "Morning digest", enabled: true,
      schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "America/New_York" },
      payload: { kind: "agentTurn", message: "Summarise the notes I added yesterday, and list anything I need to answer today." },
      sessionTarget: "isolated", delivery: { mode: "none" }, updatedAtMs: NOW - 3 * DAY,
      runs: [
        run(0, 8, 0, { sessionKey: "agent:marlow:cron:digest:run:run-1", summary: DIGEST_SUMMARY, history: recorded("Summarise the notes I added yesterday, and list anything I need to answer today.", DIGEST_SUMMARY) }),
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
      sessionTarget: "main", delivery: { mode: "announce" }, deleteAfterRun: true, updatedAtMs: NOW - DAY, runs: [],
    },
    {
      id: "backup", bot: "otto", name: "Nightly backup check", enabled: true,
      schedule: { kind: "cron", expr: "30 3 * * *", tz: "America/New_York" },
      payload: { kind: "agentTurn", message: "Check that last night's backup finished on every machine, and tell me only if one did not." },
      sessionTarget: "isolated", delivery: { mode: "none", failureDestination: { mode: "announce", channel: "last" } }, updatedAtMs: NOW - 9 * DAY,
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
      sessionTarget: "isolated", delivery: { mode: "none" }, updatedAtMs: NOW - 2 * DAY,
      runs: [run(0, 10, 0, { status: "skipped", completion: "unknown", dur: 0.2, tokens: 0 })],
    },
    {
      id: "renewal", bot: "otto", name: "Certificate renewal", enabled: true,
      schedule: { kind: "cron", expr: "0 9 1 * *", tz: "Europe/Berlin" },
      payload: { kind: "agentTurn", message: "Check the expiry of every certificate on the rack and renew any with less than 30 days left." },
      sessionTarget: "isolated", delivery: { mode: "none" }, updatedAtMs: NOW - 20 * DAY,
      runs: [run(17, 3, 0, { dur: 12.4, tokens: 1840 })],
    },
    {
      id: "standup", bot: "pip", name: "Plan the week", enabled: true,
      schedule: { kind: "cron", expr: "0 17 * * 0", tz: "Europe/London" },
      payload: { kind: "agentTurn", message: "Plan next week from my calendar. Keep Thursday afternoon clear." },
      sessionTarget: "isolated", delivery: { mode: "none" }, updatedAtMs: NOW - 4 * DAY,
      runs: [run(3, 12, 0, { dur: 8.1, tokens: 960 })],
    },
    {
      id: "cleanup", bot: "pip", name: "Inbox tidy-up", enabled: false,
      schedule: { kind: "cron", expr: "0 16 * * 5", tz: "America/New_York" },
      payload: { kind: "agentTurn", message: "Archive newsletters older than a week and list anything that still needs me." },
      sessionTarget: "isolated", delivery: { mode: "none" }, updatedAtMs: NOW - 12 * DAY, runs: [],
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
    // A read-only connection can't write users.prefs, so it can't keep the answer: no card.
    away: P.get("away") === "1" && P.get("access") !== "read",
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
  // runs=25: more runs than the page shows, newest first, every six hours.
  if (P.has("runs")) r0().runs = Array.from({ length: +P.get("runs") }, (_, k) => ({ ...run(0, 10, 0), at: at(0, 10, 0) - k * 6 * HOUR }));
  // A successful one-shot: the gateway sends finished, then removed, and keeps nothing of it.
  if (S.state === "ran-once") {
    r0().runs = [run(0, 9, 0, { sessionKey: "agent:marlow:main", summary: "Posted the reminder in Marlow's main conversation.", dur: 0.4, tokens: 0 })];
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
  // live=0: the check-in's reply was read from history, without its run seen live.
  const liveCheckin = P.get("live") !== "0";
  const schedulerOff = () => S.state === "scheduler-off";
  let lastFocus = null;

  function announce(text) {
    const live = $("#r-announce");
    live.textContent = "";
    setTimeout(() => (live.textContent = text), 30);
  }

  // Words for a routine ----------------------------------------------------------------------

  const lastRun = (r) => r.runs[0];
  // A run is known by its job and runId. One in progress has no runId yet (`started` gives
  // only runAtMs), so until its own `finished`, with the same runAtMs, it is known by that.
  const runKey = (x) => (x.running || !x.runId ? `at:${x.at}` : x.runId);
  const runOf = (r, key) => (r.running && key === `at:${r.running}` ? { at: r.running, running: true } : r.runs.find((x) => runKey(x) === key));
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
  // Said from the prompt in effect: empty is the gateway's own, which asks for NO_REPLY.
  // The gateway's default check-in prompt for every bot, read with admin: "" when unset, so the
  // built-in prompt applies; null when it couldn't be read (defaultprompt=custom or unreadable).
  const DEFAULT_PROMPT = P.get("defaultprompt") === "unreadable" ? null : P.get("defaultprompt") === "custom" ? "Report anything new in my inbox." : "";
  // Only the built-in prompt is known to ask for quiet. Any other prompt, or one Clawtrate
  // can't read, gets the cadence alone: its wording is never read for intent.
  function cadence(lead, name, prompt) {
    if (!isAdmin() || (!prompt.trim() && DEFAULT_PROMPT === null)) return `${lead}, ${name} checks in. Clawtrate can't read its prompt.`;
    if (!prompt.trim() && DEFAULT_PROMPT === "") return `${lead}, ${name} looks for anything that needs you. Its prompt asks it to stay quiet when nothing does.`;
    return `${lead}, ${name} checks in with ${prompt.trim() ? "a prompt of its own" : "the prompt the gateway sets for every bot"}.`;
  }
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
        // checkin=running: a run whose agent events carry isHeartbeat is in progress.
        const checking = P.get("checkin") === "running" && b.id === "juniper";
        const preview = S.view === "convo" && b.id === "juniper" ? `${liveCheckin ? "Checked in: " : ""}The rebate form is due in three days and still needs the model number.` : b.preview;
        const line = busy ? `${glyph("working")}<span class="bot-preview">Running ${esc(running.name)}</span>` : checking ? `${glyph("working")}<span class="bot-preview">Checking in</span>` : `<span class="bot-preview">${esc(preview)}</span>`;
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
          `<li class="bot-group"${open ? ' data-open="true"' : ""}><button type="button" class="bot" data-bot-row="${b.id}" data-r="open-bot" data-id="${b.id}" aria-label="${esc(`${b.name}, ${busy ? `running ${running.name}` : checking ? "checking in" : preview}`)}" data-testid="bot">` +
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
      `<span class="r-row-line" title="${esc(spoken[0].toUpperCase() + spoken.slice(1))}">${line}</span></span></button>` +
      (isAdmin() ? sw(r.enabled, `data-r="toggle" data-id="${r.id}"`, `${r.name} runs on schedule`) : "") +
      `</div>${S.rowError === r.id ? `<p class="r-row-error" role="alert">Couldn't pause: the gateway didn't answer.</p>` : ""}</li>`
    );
  }
  function checkinsBlock(b) {
    const c = checkins[b];
    const name = botName(b);
    let text;
    if (!c || !c.every) text = c ? `${name} doesn't check in on a schedule.` : `${name} doesn't check in. Without a setting of its own, only the gateway's default bot checks in.`;
    else text = cadence(c.every === DAY ? "Once a day" : everyWords(c.every), name, c.prompt);
    const next = c && c.every ? (schedulerOff() ? "The gateway's scheduler is off, so scheduled check-ins don't run." : `Next check-in ${clock(at(0, 10, 30))} · In ${name}'s main conversation`) : "";
    const zones = [...new Set(routines.filter((r) => r.bot === b && r.schedule.tz).map((r) => city(r.schedule.tz)))];
    return (
      `<section class="r-checkins" aria-labelledby="checkins-head" data-testid="checkins"><div class="r-checkins-head"><h3 id="checkins-head">Check-ins</h3>` +
      (isAdmin() ? button("Change", `data-size="sm" data-r="checkins" data-id="${b}"`) : "") + `</div>` +
      `<p data-testid="checkins-text">${esc(text)}</p>${next ? `<p class="r-faint">${esc(next)}</p>` : ""}` +
      (zones.length ? `<div class="r-zone-line"><p class="r-faint" data-testid="zone-line">Routines' time zone: ${Z?.bot === b && Z.pending ? "checking needed" : zones.length > 1 ? `Mixed: ${zones.join(", ")}` : zones[0]}</p>${isAdmin() ? button("Change…", `data-size="sm" data-r="zone" data-id="${b}"`, "quiet") : ""}</div>` : "") +
      `</section>`
    );
  }
  function awayCard() {
    if (!S.away) return "";
    const n = routines.filter((r) => r.enabled && !r.gone).length;
    return (
      `<section class="r-away" aria-labelledby="away-title" data-testid="away"><p id="away-title"><b>You've been away for a bit.</b> ${n} routines kept running while you were away. Keep them running?</p>` +
      `<div class="b-actions">${button("Keep them running", 'data-r="away-keep"', "primary")}` +
      (isAdmin() ? button("Pause them all", 'data-r="away-pause"') : "") +
      button("Keep running, don't ask again", 'data-r="away-never"', "quiet") + `</div>` +
      (isAdmin() ? "" : `<small>Pausing them needs admin access.</small>`) +
      `<small>If you don't answer, Clawtrate pauses them on Nov 25, the first time it is open with admin access on or after that day.</small>` +
      // prefs=none: users.prefs answered no_durable_identity, so the dates live on this device.
      (P.get("prefs") === "none" ? `<small data-testid="away-device">This gateway can't keep your answer for your other devices, so Clawtrate keeps it on this one; another device may ask again.</small>` : "") +
      `</section>`
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
    const off = S.calOffset || 0;
    const dayStart = (i) => fromZoned(startP.y, startP.m, startP.d + off + i, 0, 0, VIEWER);
    const narrow = CT.settings.width === "800";
    const mine = routines.filter((r) => !r.gone && (!S.bot || r.bot === S.bot));
    // The future is what is scheduled; the past is what ran, whatever the routine is now.
    const enabled = mine.filter((r) => r.enabled);
    const frequent = enabled.filter((r) => perDay(r) > 4);
    const placed = enabled.filter((r) => perDay(r) <= 4);
    const hb = Object.entries(checkins).filter(([, c]) => c && c.every).map(([b, c]) => `${botName(b)} ${c.every === DAY ? "daily" : everyWords(c.every).toLowerCase()}`);
    const dayName = (ms) => {
      const p = parts(ms, VIEWER);
      return `${dayIndex(ms, VIEWER) === dayIndex(NOW, VIEWER) ? "Today" : WEEK[p.dow]} ${MONTHS[p.m - 1]} ${p.d}`;
    };
    let cols = "";
    let heads = "";
    let bands = "";
    for (let i = 0; i < days; i++) {
      const s0 = dayStart(i);
      const e = dayStart(i + 1);
      const p = parts(s0, VIEWER);
      const today = dayIndex(s0, VIEWER) === dayIndex(NOW, VIEWER);
      heads += `<div class="r-cal-dayhead" aria-hidden="true" data-today="${today}">${today ? "Today" : WEEK[p.dow]}<small>${MONTHS[p.m - 1]} ${p.d}</small></div>`;
      bands += `<div class="r-cal-bands">${e > NOW ? frequent.map((r) => { const w = r.schedule.kind === "every" ? everyWords(r.schedule.everyMs).toLowerCase() : r.schedule.expr; return `<div class="r-cal-band" title="${esc(`${w} · ${botName(r.bot)}'s ${r.name}${r.trigger ? ", only when its check passes" : ""}`)}">${esc(`${r.name} · ${w}`)}</div>`; }).join("") : ""}</div>`;
      const items = [];
      for (const r of mine) for (const x of r.runs) if (x.at >= s0 && x.at < Math.min(e, NOW)) items.push({ r, t: x.at, ran: x });
      if (e > NOW)
        for (const r of placed) {
          if (computable(r)) for (const t of occurrences(r.schedule, Math.max(s0, NOW), e)) items.push({ r, t });
          else if (r.state?.nextRunAtMs >= Math.max(s0, NOW) && r.state.nextRunAtMs < e) items.push({ r, t: r.state.nextRunAtMs, nextOnly: true });
        }
      items.sort((x, y) => x.t - y.t);
      // Chips less than an hour apart would cover each other (a chip, or its 44 px hit area on
      // touch, is under an hour tall), so each such run of chips shares the row side by side.
      const lanes = [];
      for (const it of items) {
        const g = lanes.at(-1);
        if (g && it.t - g.at(-1).t < HOUR) g.push(it);
        else lanes.push([it]);
      }
      let chips = "";
      for (const g of lanes) for (const [k, { r, t, ran, nextOnly }] of g.entries()) {
        const p2 = parts(t, VIEWER);
        const o = ran && outcome(ran);
        const tip = `${r.name}, ${botName(r.bot)}, ${WEEK[p2.dow]} ${clock(t)}${ran ? `, ${o.short}` : ""}${nextOnly ? ", and later, as the gateway decides" : ""}${r.schedule.kind === "cron" && cronSpec(r.schedule.expr).min?.join() === "0" && !ran ? ". May start up to 5 minutes later." : ""}`;
        const side = g.length > 1 ? `;left:calc(4px + ${k} * (100% - 8px) / ${g.length});right:auto;width:calc((100% - 8px) / ${g.length} - 2px)` : "";
        chips += `<li style="top:calc(${p2.h + p2.min / 60} * var(--hour))${side}"><button type="button" class="r-occ" data-r="open" data-id="${r.id}" data-min="${p2.h * 60 + p2.min}" data-past="${!!ran}" data-outcome="${o?.mark === "failed" ? "failed" : ""}" aria-label="${esc(tip)}" title="${esc(tip)}" data-testid="occurrence">` +
          `<span class="avatar" data-bot="${r.bot}"></span><span>${esc(r.name)}</span></button></li>`;
      }
      const nowLine = today ? `<span class="r-now" style="top:calc(${startP.h + startP.min / 60} * var(--hour))" aria-hidden="true"></span>` : "";
      cols += `<div class="r-cal-day"><ul aria-label="${esc(dayName(s0))}" data-testid="cal-day">${chips || `<li class="visually-hidden">Nothing scheduled</li>`}</ul>${nowLine}</div>`;
    }
    const range = days === 1 ? dayName(dayStart(0)) : `${dayName(dayStart(0))} to ${dayName(dayStart(days - 1))}`;
    const hours = Array.from({ length: 12 }, (_, k) => `<span style="top:calc(${k * 2} * var(--hour))">${k === 0 ? "" : hm(k * 2, 0).replace(":00", "")}</span>`).join("");
    const head =
      `<header class="r-head">${phone() ? backButton("Back to bots", "to-bots") : ""}<h1 id="view-title">Routines</h1><span class="spacer"></span>${seg()}` +
      (isAdmin() ? newButton("New routine") : "") + `</header>`;
    const body =
      `<div class="r-toolbar">${botSelect()}</div>` +
      `<div class="r-cal-bar"><button type="button" class="icon-button" data-r="cal-move" data-v="-1" aria-label="Previous ${days === 1 ? "day" : `${days} days`}">${icon("back")}</button>` +
      `<button type="button" class="icon-button" data-r="cal-move" data-v="1" aria-label="Next ${days === 1 ? "day" : `${days} days`}">${icon("chevron")}</button>` +
      button("Today", `data-size="sm" data-r="cal-move" data-v="0"${off ? "" : ' aria-disabled="true"'}`, "quiet") +
      `<span class="r-cal-range" role="status" data-testid="cal-range">${esc(range)}</span><span class="r-zone">Your time, New York</span></div>` +
      `<div class="r-cal-scroll"><div class="r-cal" role="group" aria-label="Routines by day" style="--days:${days}" data-days="${days}" data-narrow="${narrow}" data-testid="calendar">` +
      `<div class="r-cal-checkins">Check-ins: ${esc(hb.join(", ") || "none")}</div>` +
      `<div class="r-cal-corner" aria-hidden="true"></div>${heads}<div class="r-cal-corner"></div>${bands}<div class="r-cal-hours" aria-hidden="true">${hours}</div>${cols}</div></div>`;
    return { head, body, r: "calendar" };
  }

  // A routine's page ---------------------------------------------------------------------------------------

  function runRow(r, x) {
    const o = outcome(x);
    const how = x.running ? "Running…" : o.text;
    return `<li><button type="button" class="r-run" data-r="open-run" data-id="${r.id}" data-run="${esc(runKey(x))}" data-at="${x.at}" aria-label="${esc(`${when(x.at, VIEWER, true)}${x.manual ? ", started by hand" : ""}, ${how}`)}" data-testid="run-row">` +
      `<span class="r-row-mark">${x.running ? glyph("working") : o.mark ? glyph(o.mark) : ""}</span>` +
      `<span class="r-run-text"><span class="r-run-when">${esc(when(x.at, VIEWER, true))}${x.manual ? `<span class="r-faint"> · started by hand</span>` : ""}</span>` +
      `<span class="r-run-how" title="${esc(how)}">${o.tone && !x.running ? `<span data-tone="danger">${esc(how)}</span>` : esc(how)}</span></span>${icon("chevron")}</button></li>`;
  }
  function renderRoutine() {
    const r = r0();
    const tz = r.schedule.tz;
    const n = nextRun(r);
    const actions = isAdmin() && !S.deleted
      ? button(S.starting ? "Starting…" : r.enabled ? "Run now" : "Run once now", `data-size="sm" data-r="run-now" data-id="${r.id}"${S.starting ? ' aria-disabled="true"' : ""}`) +
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
    body += `<p class="r-state" role="status" data-testid="state-line">${state}${S.already ? `<span class="r-already">It's already running.</span>` : ""}</p>` +
      (S.runError ? `<p class="r-row-error" role="alert" data-testid="run-error-line">Couldn't start a run: ${esc(S.runError)}</p>` : "");
    // Instruction
    let instruction;
    if (r.payload.kind === "systemEvent") instruction = `<p class="r-hint">Posts a reminder in ${botName(r.bot)}'s main conversation:</p><p class="r-instruction">${esc(r.payload.text)}</p>`;
    else instruction = `<p class="r-instruction" data-testid="instruction">${esc(r.payload.message)}</p>`;
    body += `<section class="r-section"><h3>Instruction</h3>${instruction}</section>`;
    // When to run
    const c = r.schedule.kind === "cron" ? readCron(r.schedule.expr) : null;
    const schedCell = r.schedule.kind === "cron" && !plainCron(c) ? `<code class="r-mono">${esc(r.schedule.expr)}</code><small>in the gateway's cron format</small>` : wordsHtml(r.schedule, r.schedule.kind === "at");
    const nextCell = !r.enabled ? "None while paused" : n === undefined ? (r.schedule.kind === "at" ? "None: it ran once and is done" : "The gateway hasn't reported a next run.") :
      `${schedulerOff() ? '<span class="r-struck">' : ""}${esc(`${dayWord(n, tz || VIEWER, true)}, ${longDate(n, tz || VIEWER)}, ${clock(n, tz || VIEWER)}`)}${schedulerOff() ? "</span>" : ""}` +
      (tz && tz !== VIEWER ? `<small>${esc(clock(n))} your time</small>` : "");
    const fact = (k, v, id = "") => `<div${id ? ` data-fact="${id}"` : ""}><dt>${k}</dt><dd>${v}</dd></div>`;
    body += `<section class="r-section"><h3>When to run</h3><dl class="facts" data-testid="when">` +
      fact("Schedule", schedCell, "schedule") +
      (r.schedule.kind === "every" || r.schedule.kind === "at" ? "" : fact("Time zone", tz ? `${esc(city(tz))} <small>${esc(tz)}</small>` : "The gateway's own time zone", "zone")) +
      fact("Next run", nextCell, "next") +
      (r.trigger ? fact("Starts", `Only when its check passes<small><code class="r-mono">${esc(r.trigger)}</code></small>`, "starts") : "") +
      fact("Runs in", r.sessionTarget === "isolated" ? "A new conversation each time" : `${botName(r.bot)}'s main conversation`, "runs-in") +
      fact("Results", r.delivery?.mode === "none" ? "Kept with the run" : r.delivery?.channel && r.delivery.channel !== "last" ? `Sent to ${esc(r.delivery.channel)}` : "Announced to the gateway's channels", "results") +
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
    if (S.state === "runs-error") body += `<p class="r-hint" data-testid="runs-error">Couldn't load runs. ${button("Try again", 'data-size="sm" data-r="runs-retry"')}</p>`;
    else if (S.state === "runs-loading") body += `<ul class="r-rows" aria-busy="true" aria-label="Loading runs" data-testid="runs-loading">${[1, 2, 3].map(() => `<li><div class="r-row"><span class="skeleton" style="width:50%;height:14px"></span></div></li>`).join("")}</ul>`;
    else if (!runs.length) body += `<p class="r-hint" data-testid="no-runs">${r.enabled && n !== undefined ? `No runs yet. The first is due ${esc(when(n, tz || VIEWER))}.` : "No runs yet."}</p>`;
    else body += `<ul class="r-rows" aria-labelledby="runs-head" data-testid="runs">${runs.slice(0, 20).map((x) => runRow(r, x)).join("")}</ul>`;
    body += `<p class="r-foot-note">Clawtrate shows the 20 most recent runs. The gateway keeps 7 days of runs, and each run's conversation for 24 hours unless it is set to keep them longer.</p></section>`;
    return { head, body, r: "routine" };
  }

  // A run --------------------------------------------------------------------------------------------------

  function renderRun() {
    const r = r0();
    const x = runOf(r, S.runKey);
    if (!x) {
      const head = `<header class="r-head">${backButton(`Back to ${esc(r.name)}, all runs`, "back-to-routine")}<div class="r-titles"><h1 id="view-title" title="${esc(r.name)}">${esc(r.name)}</h1><p><span class="avatar" data-bot="${r.bot}"></span>${botName(r.bot)}</p></div></header>`;
      return { head, body: `<div class="r-convo"><div class="work-empty" data-testid="run-missing"><span class="empty-mark">${icon("clock")}</span><h4>This run isn't available.</h4><p>The gateway doesn't list it among ${esc(r.name)}'s runs.</p>${button(`Back to ${esc(r.name)}`, 'data-r="back-to-routine"')}</div></div>`, r: "run" };
    }
    const head =
      `<header class="r-head">${backButton(`Back to ${esc(r.name)}, all runs`, "back-to-routine")}<div class="r-titles"><h1 id="view-title" title="${esc(r.name)}">${esc(r.name)}</h1>` +
      `<p data-testid="run-when"><span class="avatar" data-bot="${r.bot}"></span>${botName(r.bot)} · ${esc(when(x.at, VIEWER, true))}</p></div></header>`;
    // A transcript is shown only when cron.history returned this run's messages. A run in a
    // shared conversation, or a job that is not an agent turn, has no conversation of its own.
    const session = x.sharedSessionKey || (x.sessionKey && !x.sessionKey.includes(`:cron:${r.id}:run:`) ? x.sessionKey : "");
    const shared = session || r.payload.kind !== "agentTurn" || (!x.sessionKey && r.sessionTarget !== "isolated");
    const where = r.payload.kind === "command" ? "command" : shared ? "main" : "";
    const rs = S.runstate || (x.running ? "running" : where || (x.history ? "" : "none"));
    const returned = () => `<p class="r-returned-head">What the run returned:</p><p data-testid="returned">${esc(x.summary || outcome(x).text)}</p>`;
    let body = "";
    if (rs === "loading") body = `<div class="r-convo" aria-busy="true"><span class="skeleton" style="display:block;width:70%;height:16px;margin:24px 0"></span><span class="skeleton" style="display:block;width:50%;height:16px"></span></div>`;
    else if (rs === "error") body = `<div class="work-empty" data-testid="run-error"><span class="empty-mark">${icon("warning")}</span><h4>Couldn't load this run.</h4><p>The gateway didn't answer in time.</p>${button("Try again", 'data-r="run-retry"')}</div>`;
    else {
      if (rs === "none")
        body += note(`<p><b>Clawtrate can't show this run's conversation.</b> The gateway returned none for it. It keeps a run's conversation for 24 hours unless it is set to keep them longer, so an older one may have been removed.</p>${returned()}`);
      else if (rs === "main") {
        const main = `agent:${r.bot}:main`;
        const title = session === main ? `${botName(r.bot)}'s main conversation` : session ? `the shared conversation (${session})` : "a shared conversation";
        body += note(`<p><b>This run happened in ${esc(title)}.</b> Its turn is there among the others; the gateway doesn't keep it apart.</p>${returned()}${session ? `<div class="b-actions">${button(session === main ? `Open ${title}` : "Open conversation", `data-size="sm" data-r="open-bot" data-id="${r.bot}" data-session="${esc(session)}"`)}</div>` : ""}`);
      } else if (rs === "command") body += note(`<p><b>A command runs on the gateway, not a bot,</b> so this run has no conversation.</p>${returned()}`);
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
    if (S.session) {
      const bot = r0().bot;
      const title = S.session === `agent:${bot}:main` ? `${botName(bot)}'s main conversation` : S.session;
      return {
        head: `<header class="r-head">${backButton("Back to run", "back-to-run")}<div class="r-titles"><h1 id="view-title">${esc(title)}</h1></div></header>`,
        body: `<div class="r-convo"><p>Conversation history isn't included in this prototype.</p></div>`,
        r: "convo",
      };
    }
    const head = `<header class="r-head">${backButton("Back to bots", "to-bots")}<div class="r-titles"><h1 id="view-title">Heat pump vs. gas furnace</h1><p><span class="avatar" data-bot="juniper"></span>Juniper</p></div></header>`;
    const body =
      `<div class="r-convo transcript-inner" data-testid="convo">` +
      `<div class="turn" data-role="user"><div class="msg" data-role="user"><div class="bubble">What should I ask an installer before signing anything?</div></div></div>` +
      `<div class="turn" data-role="assistant"><div class="msg" data-role="assistant"><div class="bubble">Ask these five, and get the answers in writing.</div></div></div>` +
      // From history with no live record of its run: an ordinary reply, labelled nothing.
      `<div class="turn" data-role="assistant" data-testid="from-history"><div class="msg" data-role="assistant"><div class="bubble">The installer's quote you saved expires on Friday.</div></div></div>` +
      // "Checked in" only for a run whose agent events carried isHeartbeat while Clawtrate watched.
      `<div class="turn" data-role="assistant" data-testid="checkin">${liveCheckin ? `<p class="event-line">${icon("clock")} Checked in · 9:30 AM</p>` : ""}<div class="msg" data-role="assistant"><div class="bubble">The rebate form is due in three days and still needs the model number.</div></div></div>` +
      `<div class="turn" data-role="assistant" data-testid="created-card"><p class="event-line">${icon("clock")} Created routine <button type="button" class="r-link" data-r="open" data-id="digest">Morning digest</button></p></div>` +
      `<div class="turn" data-role="assistant" data-testid="changed-card"><p class="event-line">${icon("clock")} Changed routine <button type="button" class="r-link" data-r="open" data-id="backup">Nightly backup check</button></p></div>` +
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
    const f = focusSel && $(focusSel);
    if (f) {
      if (f.matches("h1, h3")) f.tabIndex = -1;
      f.focus();
    }
  }
  // Where focus is, as a selector that survives a repaint: a live event never moves it.
  function focusKey() {
    const a = document.activeElement;
    if (!a || !$("#root").contains(a) || a.closest("dialog, #r-menu")) return null;
    if (a.id) return `#${a.id}`;
    return ["data-r", "data-id", "data-run", "data-v"].filter((k) => a.hasAttribute(k)).map((k) => `[${k}="${a.getAttribute(k)}"]`).join("") || null;
  }
  const repaint = () => paint(focusKey());

  // The cron event (section 8), applied to the list as the engine would.
  const EDITED = ["name", "payload", "schedule", "sessionTarget", "delivery"];
  // A `finished` event's own top-level fields, as the gateway sends them; `runId` may be absent.
  // `history` and `manual` are the fixture's: what cron.history would return, and a Run now.
  const fromFinished = (ev) => ({
    runId: ev.runId, sessionKey: ev.sessionKey,
    sharedSessionKey: ev.job?.sessionTarget === "current" ? ev.job.sessionKey : undefined,
    at: ev.runAtMs, status: ev.status, completion: ev.completionStatus, error: ev.error, delivery: ev.deliveryError, summary: ev.summary,
    dur: (ev.durationMs ?? 0) / 1000, inT: ev.usage?.input_tokens ?? 0, outT: ev.usage?.output_tokens ?? 0, tokens: ev.usage?.total_tokens ?? 0, manual: !!ev.manual, history: ev.history,
  });
  function applyEvent(ev) {
    const r = routines.find((x) => x.id === (ev.job?.id ?? ev.jobId));
    const onScreen = r && ((["routine", "run"].includes(S.view) && S.routine === r.id) || D?.id === r.id);
    const inDialog = () => {
      const a = document.activeElement;
      return a && editDialog.contains(a) ? (a.id ? `#${a.id}` : `[data-r="${a.dataset.r}"]`) : "#edit-title";
    };
    if (ev.action === "added") routines.push({ runs: [], enabled: true, ...ev.job });
    else if (ev.action === "updated") {
      const edited = EDITED.some((k) => k in ev.job && JSON.stringify(ev.job[k]) !== JSON.stringify(r[k]));
      Object.assign(r, ev.job);
      // An attempt whose outcome isn't known yet stays pending until the person checks it;
      // a differing read can show a conflict after that check.
      const pendingSave = D?.id === r.id && ["saving", "noanswer", "checking"].includes(D.status);
      if (pendingSave && edited) D.elsewhere = true;
      else if (D?.id === r.id && edited) {
        D.status = "conflict";
        renderEditor(inDialog());
      }
      if (onScreen && edited && !pendingSave) announce(`${r.name} was changed elsewhere`);
    } else if (ev.action === "removed") {
      r.gone = true;
      // A one-shot removes itself after it succeeds (deleteAfterRun): finished, then removed.
      if (["routine", "run"].includes(S.view) && S.routine === r.id) S.deleted = r.deleteAfterRun && lastRun(r)?.status === "ok" ? "once" : true;
      if (D?.id === r.id) {
        D.status = "deleted";
        renderEditor(inDialog());
      }
      if (onScreen) announce(`${r.name} was deleted elsewhere`);
    } else if (ev.action === "started") {
      r.running = ev.runAtMs;
      if (onScreen) announce(`Running ${r.name}`);
    } else if (ev.action === "finished") {
      const x = fromFinished(ev);
      if (ev.nextRunAtMs !== undefined) r.state = { ...r.state, nextRunAtMs: ev.nextRunAtMs };
      if (r.running === x.at) {
        r.running = null;
        if (S.routine === r.id && S.runKey === `at:${x.at}`) S.runKey = runKey(x);
      }
      const i = r.runs.findIndex((y) => runKey(y) === runKey(x));
      if (i >= 0) r.runs[i] = x;
      else r.runs.splice(r.runs.filter((y) => y.at > x.at).length, 0, x);
      if (outcome(x).mark === "failed") announce(`${r.name} failed`);
      else if (onScreen) announce(`${r.name} finished`);
    }
    repaint();
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

  // Every change needs admin: the address reaches these too, so the guard is here, not only on the buttons.
  function toggle(id) {
    if (!isAdmin()) return;
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
    // Starting… keeps focus on the button, so it is aria-disabled rather than disabled.
    if (!isAdmin() || S.starting) return;
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
    S.runError = null;
    repaint();
    setTimeout(() => {
      S.starting = false;
      if (P.get("runfail") === "1") {
        S.runError = "the gateway didn't answer.";
        announce("Couldn't start a run");
        return repaint();
      }
      const runId = `manual:${id}:${NOW}:${++runSeq}`;
      applyEvent({ action: "started", jobId: id, runAtMs: NOW });
      setTimeout(() => {
        applyEvent({ action: "finished", jobId: id, runId, runAtMs: NOW, status: "ok", completionStatus: "succeeded", durationMs: 2400, usage: { input_tokens: 124, output_tokens: 80, total_tokens: 204 }, summary: DIGEST_SUMMARY, manual: true, history: r.payload.kind === "agentTurn" ? recorded(r.payload.message, DIGEST_SUMMARY) : undefined });
      }, 1800);
    }, 500);
  }

  const confirmDialog = $("#confirm-dialog");
  function askDelete(id) {
    if (!isAdmin()) return;
    const r = routines.find((x) => x.id === id);
    const l = lastRun(r);
    confirmDialog.innerHTML =
      `<div class="b-confirm"><h2 id="confirm-title">Delete ${esc(r.name)}?</h2><p id="confirm-text">It won't run again, and Clawtrate can't show its runs afterwards.${l ? ` Its last run was ${esc(dayWord(l.at))} at ${esc(clock(l.at))}.` : ""}</p>` +
      `<div class="b-actions">${button("Cancel", 'data-r="confirm-cancel"', "quiet")}${button("Delete", `data-r="confirm-delete" data-id="${r.id}" data-tone="danger"`)}</div></div>`;
    lastFocus = document.activeElement;
    confirmDialog.showModal();
    $('[data-r="confirm-cancel"]', confirmDialog).focus();
  }

  function finishDelete(r) {
    routines = routines.filter((x) => x !== r);
    confirmDialog.close();
    announce(`Deleted ${r.name}`);
    return go("list", { focus: "#view-title" });
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
      const d = { id: null, bot, name: "", instruction: "", kind: "weekdays", time: "08:00", days: [1], n: 30, unit: "minutes", date: "2026-11-20", tz: zones[0] || "auto", cron: "", runsIn: "isolated", results: "none", locked: false, updatedAtMs: null, errors: {}, status: "", simulate: P.get("editstate") || "" };
      return Object.assign(d, { opened: whenKey(d) });
    }
    const s = r.schedule;
    const c = s.kind === "cron" ? readCron(s.expr) : null;
    // A job without a delivery has the gateway's default for its kind, which announces.
    const results = r.delivery?.mode ?? "announce";
    const d = { id: r.id, bot: r.bot, name: r.name, instruction: r.payload.message || r.payload.text, kind: "weekdays", time: "08:00", days: [1], n: 30, unit: "minutes", date: "2026-11-20", tz: s.tz || "auto", cron: "", runsIn: r.sessionTarget, results, locked: false, updatedAtMs: r.updatedAtMs, errors: {}, status: "", simulate: P.get("editstate") || "" };
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
    // What the editor opened with: Save sends only what differs from it, and a copy of the
    // job's schedule and delivery for "Save as a new routine".
    d.base = { name: r.name, message: r.payload.message, mode: results };
    d.job = { schedule: r.schedule, delivery: r.delivery, trigger: r.trigger };
    return d;
  }
  // What keeps a draft's schedule from being built at all; checked before anything reads it.
  function unfinished(d) {
    if (d.locked || d.cron.trim()) return "";
    if (d.kind === "once" && (!d.date || !d.time)) return "Choose a date and a time.";
    if (["daily", "weekdays", "days"].includes(d.kind) && !d.time) return "Choose a time.";
    if (d.kind === "days" && !d.days.length) return "Choose at least one day.";
    return skipped(d);
  }
  // A Once whose wall time the clocks skip has no instant: it is refused, never moved to another time.
  function skipped(d) {
    if (d.kind !== "once" || !d.date || !d.time) return "";
    const [h, m] = d.time.split(":").map(Number);
    const [y, mo, da] = d.date.split("-").map(Number);
    const tz = d.tz === "auto" ? VIEWER : d.tz;
    const p = parts(fromZoned(y, mo, da, h, m, tz), tz);
    return p.h === h && p.min === m ? "" : `${hm(h, m)} doesn't happen on ${MONTHS[mo - 1]} ${da}, ${y} in ${city(tz)}: the clocks go forward past it. Pick another time.`;
  }
  function draftSchedule(d) {
    if (d.locked) return d.job.schedule;
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
    const missing = unfinished(d);
    if (missing) return skipped(d) || `${missing.replace(/\.$/, "")} to see when it runs.`;
    const s = draftSchedule(d);
    if (s.kind === "cron" && cronSpec(s.expr).error) return "The gateway can't read this cron expression.";
    const next = occurrences(s, NOW, s.kind === "cron" ? horizon(s.tz) : Infinity, 3);
    if (!next.length) return s.kind === "cron" ? `Runs as the gateway reads "${s.expr}", and not in the next eight years.` : "It wouldn't run: that time has passed.";
    const tz = s.tz || VIEWER;
    const first = `${longDate(next[0], tz)}, ${clock(next[0], tz)}${tz !== VIEWER ? ` (${clock(next[0])} your time)` : ""}`;
    const rest = next.slice(1).map((t) => longDate(t, tz)).join(", ");
    const lead = typeof words(s) === "string" ? `Runs ${words(s, false).replace(/^./, (c) => c.toLowerCase())}${s.tz ? `, ${city(s.tz)} time` : ""}.` : `Runs as the gateway reads "${s.expr}".`;
    return `${lead} Next: ${first}${rest ? `, then ${rest}` : ""}.`;
  }
  function validate(d) {
    const e = {};
    if (!d.name.trim()) e.name = "Give it a name.";
    if (!d.payload && !d.instruction.trim()) e.instruction = "Say what the bot should do.";
    if (!d.locked && (!d.id || whenKey(d) !== d.opened)) {
      const missing = unfinished(d);
      if (d.cron.trim()) {
        const s = draftSchedule(d);
        const c = cronSpec(s.expr);
        if (c.error) e.cron = `The gateway can't read this: ${c.error}.`;
        else if (!occurrences(s, NOW, horizon(s.tz), 1).length) e.cron = "This never runs in the next eight years.";
        else if (cronSpacing(c, s.tz) < 300) e.cron = "Routines run at least 5 minutes apart.";
      } else if (missing) e.when = missing;
      else if (d.kind === "every" && d.n * (d.unit === "hours" ? 60 : 1) < 5) e.when = "Routines run at least 5 minutes apart.";
      else if (d.kind === "once" && atMs(draftSchedule(d).at) < NOW) e.when = "Pick a time in the future.";
    }
    return e;
  }
  function field(id, label, control, error) {
    return `<div class="r-field"><label for="${id}">${label}</label>${control}${error ? `<p class="r-error" id="${id}-error">${esc(error)}</p>` : ""}</div>`;
  }
  // While a save's outcome is unknown, or the routine changed or went elsewhere, the only
  // ways to write are the note's own: Save again, Save mine anyway, Save as a new routine.
  const HELD = ["noanswer", "checking", "found", "conflict", "deleted"];
  const whenText = (d) => (d.locked ? wordsText(d.job.schedule) : unfinished(d) ? "Not finished" : wordsText(draftSchedule(d)));
  const KINDS = [["daily", "Every day"], ["weekdays", "Weekdays"], ["days", "Some days of the week"], ["every", "Every few hours or minutes"], ["once", "Once"]];
  function renderEditor(focusSel) {
    const d = D;
    const r = d.id && routines.find((x) => x.id === d.id);
    const saving = d.status === "saving" || d.status === "checking";
    const dis = saving ? " disabled" : "";
    let notes = "";
    if (d.status === "refused") notes += note(`<p><b>The gateway didn't save this.</b> invalid cron.add params: CronPattern: invalid configuration format ('99 * * *'), exactly five, six, or seven space separated parts are required.</p>`, "danger");
    if (d.status === "conflict") {
      d.conflictAt = r.updatedAtMs;
      notes += note(`<p><b>This routine was changed elsewhere</b> while you were editing.</p><div class="b-actions">${button("Show the new version", 'data-size="sm" data-r="conflict-show"')}${button("Save mine anyway", 'data-size="sm" data-r="conflict-save"', "quiet")}</div>`, "warn");
    }
    // After "Show the new version": what was typed, kept to copy from.
    if (d.mine)
      notes += `<details class="b-disclosure" data-testid="your-version"><summary>Your version</summary><div class="b-disclosure-body"><dl class="facts">` +
        [["Name", d.mine.name], [d.mine.payload ? "Reminder" : "Instruction", d.mine.instruction || d.mine.payload?.text || ""], ["When", whenText(d.mine)]].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("") +
        `</dl></div></details>`;
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
          : f.kind === "match" ? `<p><b>The gateway has ${f.ids.length === 1 ? "a routine" : `${f.ids.length} routines`} for ${botName(d.submitted.params.agentId)} named ${esc(d.submitted.params.name)},</b> created ${esc(when(f.at))}. It may be the one you saved, or one made elsewhere.</p><div class="b-actions">${button("Open it", `data-size="sm" data-r="open-found" data-id="${f.ids[0]}"`)}${again}</div><p class="r-hint">Saving again makes another routine if that one is yours.</p>`
          : `<p><b>The gateway has no routine for ${botName(d.submitted.params.agentId)} named ${esc(d.submitted.params.name)}.</b> The save may still arrive.</p><div class="b-actions">${button("Check again", 'data-size="sm" data-r="check-now"')}${again}</div>`,
        "warn",
      );
    }
    const botField = d.id
      ? `<div class="r-field"><span class="r-label">Bot</span><p class="r-hint" style="margin:0">${botName(d.bot)}. To run it on another bot, make a new routine.</p></div>`
      : `<div class="r-field"><label for="e-bot">Bot</label><select class="input" id="e-bot" data-e="bot"${dis}>${bots.map((b) => `<option value="${b.id}"${b.id === d.bot ? " selected" : ""}>${b.name}</option>`).join("")}</select></div>`;
    const err = (k) => (d.errors[k] ? ` aria-invalid="true" aria-describedby="e-${k}-error"` : "");
    let whenField;
    if (d.locked) {
      whenField = `<div class="r-field"><span class="r-label">When</span><div class="r-locked" data-testid="locked"><code>${esc(d.job.schedule.expr || everyWords(d.job.schedule.everyMs))}</code>${d.job.schedule.tz ? `, ${esc(city(d.job.schedule.tz))}` : ""}<br />` +
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
      `<div class="r-field"><span class="r-label">Runs in</span><p class="r-locked" id="e-runs">${d.runsIn === "isolated" ? "A new conversation each time" : d.runsIn === "main" ? `${botName(d.bot)}'s main conversation` : "The conversation it was made in"}</p></div>` +
      `<div class="r-field"><label for="e-results">Results</label><select class="input" id="e-results" data-e="results"${dis}><option value="none"${d.results === "none" ? " selected" : ""}>Keep them with the run</option><option value="announce"${d.results === "announce" ? " selected" : ""}>Also announce to the gateway's channels</option></select></div>` +
      `</div></details>`;
    editDialog.innerHTML =
      `<header class="b-head"><h2 id="edit-title" tabindex="-1">${d.id ? "Edit routine" : "New routine"}</h2><button type="button" class="icon-button b-close" data-r="edit-close" aria-label="Close"${dis}>${icon("x")}</button></header>` +
      `<div class="b-body">${notes}${botField}` +
      field("e-name", "Name", `<input class="input" id="e-name" data-e="name" maxlength="80" autocomplete="off" value="${esc(d.name)}"${err("name")}${dis} />`, d.errors.name) +
      (d.payload
        ? `<div class="r-field"><span class="r-label">${d.payload.kind === "systemEvent" ? "Reminder" : "Command"}</span><div class="r-locked" data-testid="payload-locked">${esc(d.payload.text ?? d.payload.script ?? d.payload.argv.join(" "))}<br />` +
          `This ${d.payload.kind === "systemEvent" ? "reminder's text" : "command"} was set on the gateway. You can rename the routine and change when it runs here; change ${d.payload.kind === "systemEvent" ? "its text" : "it"} on the gateway.</div></div>`
        : field("e-instr", "Instruction", `<textarea class="input" id="e-instr" data-e="instruction" placeholder="What should ${botName(d.bot)} do each time? For example: Summarise yesterday's notes and list anything I need to answer."${err("instruction")}${dis}>${esc(d.instruction)}</textarea>`, d.errors.instruction)) +
      whenField + more + (d.id ? "" : `<p class="r-hint">It runs first at its next time; creating it doesn't run it.</p>`) +
      `</div><footer class="b-foot">` +
      (d.status === "adminlost" && !isAdmin()
        ? `<section class="access-bar" role="region" aria-label="Access" data-testid="editor-access"><div class="access-row">${icon("eye")}<span class="shelf-text"><b>Admin access was lost.</b> Saving needs it again. What you typed is kept.</span>` +
          (S.req === "requested" ? `${glyph("waiting")}<span class="shelf-text">Waiting for the gateway's owner.</span>${button("Check now", 'data-size="sm" data-r="access-check"')}` : button("Request admin access", 'data-size="sm" data-r="request"', "primary")) + `</div></section>`
        : `<div class="b-actions">${button("Cancel", `data-r="edit-close"${dis}`, "quiet")}${HELD.includes(d.status) ? "" : button(d.status === "saving" ? "Saving…" : "Save", `data-r="save"${dis}`, "primary")}</div>`) +
      `</footer>`;
    if (!editDialog.open) {
      lastFocus = document.activeElement;
      editDialog.showModal();
    }
    (focusSel ? $(focusSel, editDialog) : null)?.focus() || (!focusSel && $("#edit-title", editDialog).focus());
  }
  function openEditor(id) {
    if (!isAdmin()) return;
    D = draftFrom(id && routines.find((x) => x.id === id));
    renderEditor();
  }
  // Every write from the editor comes here, Save again and the notes' own buttons included,
  // so each is validated and ends in one of the outcomes of section 9.
  function save(delay = 600, acknowledgedAt = D.updatedAtMs) {
    const d = D;
    d.updatedAtMs = acknowledgedAt;
    d.errors = validate(d);
    const first = Object.keys(d.errors)[0];
    if (first) {
      d.status = "";
      renderEditor(first === "when" ? "#e-when [aria-checked='true'], #e-n" : `#e-${first === "instruction" ? "instr" : first}`);
      return;
    }
    const current = d.id && routines.find((r) => r.id === d.id);
    if (current && current.updatedAtMs > acknowledgedAt) {
      d.status = "conflict";
      renderEditor('[data-r="conflict-show"]');
      return;
    }
    // The address's outcome is the first attempt's; a retry is answered as saved.
    d.attempts = (d.attempts || 0) + 1;
    const outcomeOf = d.attempts === 1 ? d.simulate : "";
    // What this attempt sends, kept with its draft: Check now compares the gateway with it.
    const submitted = request(d);
    d.submitted = submitted;
    dispatched.push(submitted);
    d.status = "saving";
    // Save is disabled while saving, so focus waits on the heading rather than falling to the page.
    renderEditor("#edit-title");
    setTimeout(() => {
      if (current?.gone) return;
      // An answer belongs to the draft that sent it, even if its dialog has closed since.
      if (D !== d) {
        if (!["adminlost", "refused", "conflict", "noanswer"].includes(outcomeOf)) {
          land(submitted);
          announce(`Saved ${d.name.trim()}`);
          paint();
        }
        return;
      }
      if (outcomeOf === "adminlost") {
        // The gateway refused with "missing scope: operator.admin": the tier dropped.
        S.access = "write";
        d.status = "adminlost";
        paint();
        renderEditor('[data-r="request"]');
        announce("Admin access was lost");
        return;
      }
      if (outcomeOf === "refused" || outcomeOf === "conflict" || outcomeOf === "noanswer") {
        // lookup=found: the unanswered save did reach the gateway.
        if (outcomeOf === "noanswer" && P.get("lookup") === "found") land(submitted);
        d.status = outcomeOf === "refused" && d.elsewhere ? "conflict" : outcomeOf;
        if (d.status !== "noanswer") d.elsewhere = false;
        renderEditor(outcomeOf === "noanswer" ? '[data-r="check-now"]' : outcomeOf === "conflict" ? '[data-r="conflict-show"]' : '[data-r="save"]');
        return;
      }
      const id = land(submitted);
      editDialog.close();
      D = null;
      announce(d.id ? "Saved" : "Routine created");
      go("routine", { routine: id, deleted: false });
    }, delay);
  }
  const sameSchedule = (a, b) =>
    a.kind === b.kind && (a.kind === "at" ? atMs(a.at) === atMs(b.at) : a.kind === "every" ? a.everyMs === b.everyMs : a.kind === "cron" ? a.expr.trim() === b.expr.trim() && (a.tz || "") === (b.tz || "") : JSON.stringify(a) === JSON.stringify(b));
  // A field of the job as cron.get returns it against the same field as this save sent it.
  const sameField = (k, has, sent) =>
    k === "schedule" ? sameSchedule(has, sent) : k === "delivery" ? (has?.mode ?? "announce") === sent.mode : JSON.stringify(has) === JSON.stringify(sent);
  // Check now: cron.get for an edit, cron.list for a new routine. It reports and never saves.
  function checkNow() {
    const d = D;
    d.status = "checking";
    renderEditor("#edit-title");
    setTimeout(() => {
      if (D !== d || d.status !== "checking") return;
      const r = d.id && routines.find((x) => x.id === d.id);
      if (r) {
        const patch = d.submitted.params.patch;
        const differs = Object.keys(patch).some((k) => !sameField(k, r[k], patch[k]));
        d.found = differs ? { kind: "differs", has: `${r.name}, ${wordsText(r.schedule)}` } : { kind: "same" };
      } else {
        const { agentId, name } = d.submitted.params;
        const ids = routines.filter((x) => !x.gone && x.bot === agentId && x.name === name).map((x) => x.id);
        d.found = ids.length ? { kind: "match", ids, at: routines.find((x) => x.id === ids[0]).createdAtMs } : { kind: "none" };
      }
      d.status = d.elsewhere && d.found.kind === "differs" ? "conflict" : "found";
      d.elsewhere = false;
      renderEditor(d.status === "conflict" ? '[data-r="conflict-show"]' : ".b-note .button");
      announce("Checked");
    }, 400);
  }
  // What Save sends: cron.add with every field, or cron.update with only what changed since
  // the editor opened. `delivery` is always an object; an update sends only its mode, which
  // the gateway merges into the job's delivery, keeping its other fields.
  function request(d) {
    const name = d.name.trim();
    const payload = d.payload || { kind: "agentTurn", message: d.instruction.trim() };
    const schedule = draftSchedule(d);
    if (!d.id) {
      const delivery = d.job && d.results === d.base.mode && d.job.delivery ? d.job.delivery : { mode: d.results };
      return { method: "cron.add", params: { name, agentId: d.bot, schedule, sessionTarget: d.runsIn, wakeMode: "now", payload, delivery, ...(d.job?.trigger ? { trigger: d.job.trigger } : {}) } };
    }
    const b = d.base;
    const patch = {};
    if (name !== b.name) patch.name = name;
    if (!d.payload && payload.message !== b.message) patch.payload = payload;
    if (d.results !== b.mode) patch.delivery = { mode: d.results };
    if (!d.locked && whenKey(d) !== d.opened) patch.schedule = schedule;
    return { method: "cron.update", params: { id: d.id, patch } };
  }
  // `dispatched` is every request put on the wire, answered or not; `sent` only the writes that landed.
  const dispatched = [];
  const sent = [];
  // The gateway's side of a write: what a later cron.get or cron.list would return.
  function land(req) {
    sent.push(req);
    if (req.method === "cron.update") {
      const r = routines.find((x) => x.id === req.params.id);
      const { delivery, ...rest } = req.params.patch;
      Object.assign(r, rest, { updatedAtMs: NOW });
      // The gateway computes the next run again for a new schedule.
      if (rest.schedule) r.state = { ...r.state, nextRunAtMs: undefined };
      if (delivery) r.delivery = { ...r.delivery, ...delivery };
      return req.params.id;
    }
    const { agentId, wakeMode, ...fields } = req.params;
    const id = `r${++routineSeq}`;
    routines.push({ id, bot: agentId, enabled: true, runs: [], updatedAtMs: NOW, createdAtMs: NOW, ...fields });
    return id;
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
      daily: cadence("Once a day", name, C.prompt),
      asneeded: cadence("Every 30 minutes", name, C.prompt),
      every: cadence("As often as you choose", name, C.prompt),
    };
    const defaultBots = Object.entries(checkins).filter(([, c]) => c && c.source === "default" && c.every).map(([b]) => b);
    let catchNote = "";
    if (defaultBots.length && (P.get("catch") === "1" || C.choice !== C.initial)) {
      catchNote = defaultBots.includes(C.bot)
        ? note(`<p>${name} checks in now through the gateway's default. Saving gives ${name} a setting of its own.</p>`)
        : note(`<p>${defaultBots.map(botName).join(" and ")} checks in now through the gateway's default. Saving also gives ${defaultBots.map(botName).join(" and ")} a setting of its own with the same cadence, so it keeps checking in.</p>`);
    }
    const promptNote = C.prompt.trim()
      ? `<p class="r-error" id="ci-prompt-note" data-testid="prompt-note">${DEFAULT_PROMPT === "" ? `This prompt replaces the gateway's own, which asks ${esc(name)} to reply NO_REPLY when nothing needs attention.` : "This prompt replaces the gateway's default for this bot."} Whether ${esc(name)} stays quiet depends on what this prompt asks.</p>` : "";
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
      `<textarea class="input" id="ci-prompt" data-ci-prompt placeholder="${DEFAULT_PROMPT === "" ? "Follow the heartbeat monitor scratch context when provided. … If nothing needs attention, reply NO_REPLY." : ""}"${promptNote ? ' aria-describedby="ci-prompt-note"' : ""}>${esc(C.prompt)}</textarea>` +
      `${promptNote}<p class="r-hint">Empty uses ${DEFAULT_PROMPT === "" ? "the gateway's own prompt" : "the prompt the gateway sets for every bot"}.</p></div></div></details>${catchNote}</div>` +
      `<footer class="b-foot"><div class="b-actions">${button("Cancel", `data-r="ci-close"${dis}`, "quiet")}${button(saving ? "Saving…" : "Save", `data-r="ci-save"${saving ? " disabled" : ""}`, "primary")}</div></footer>`;
    if (!ciDialog.open) {
      lastFocus = document.activeElement;
      ciDialog.showModal();
    }
    (focusSel ? $(focusSel, ciDialog) : $("#checkins-title", ciDialog)).focus();
  }
  function openCheckins(bot) {
    if (!isAdmin()) return;
    const c = checkins[bot];
    const choice = ciChoice(c);
    C = { bot, choice, initial: choice, every: "2h", prompt: c?.prompt || "", status: "" };
    renderCheckins();
  }

  // A bot's routines' time zone (F-196): one zone written to each routine that has one, one by one.

  const zoneDialog = $("#zone-dialog");
  let Z = null;
  function zonePlan(bot) {
    const rs = routines.filter((r) => !r.gone && r.bot === bot);
    const change = rs.filter((r) => r.schedule.kind === "cron" && r.schedule.tz && plainCron(readCron(r.schedule.expr)) && !r.trigger);
    const why = (r) => (r.schedule.kind === "cron" ? "its schedule was set on the gateway" : "it has no time zone");
    return { change, keep: rs.filter((r) => !change.includes(r)).map((r) => [r, why(r)]) };
  }
  function renderZone(focusSel) {
    const { change, keep } = Z.plan;
    const finished = Z.result && !Z.reconfirm;
    const saving = Z.status === "saving";
    const dis = saving || Z.pending ? " disabled" : "";
    zoneDialog.innerHTML =
      `<header class="b-head"><h2 id="zone-title" tabindex="-1">${esc(botName(Z.bot))}'s routines' time zone</h2><button type="button" class="icon-button b-close" data-r="zone-close" aria-label="Close"${dis}>${icon("x")}</button></header>` +
      `<div class="b-body">${Z.result ? `<div class="b-note" data-tone="warn" role="alert" data-testid="zone-result">${icon("warning")}<div><p>${esc(Z.result)}</p></div></div>` : ""}` +
      `<div class="r-field"><label for="z-tz">Time zone</label><select class="input" id="z-tz" data-z-tz${dis}><option value="auto"${Z.tz === "auto" ? " selected" : ""}>Auto-detect (New York)</option>` +
      ZONES.map((z) => `<option value="${z}"${Z.tz === z ? " selected" : ""}>${city(z)} (${z})</option>`).join("") + `</select></div>` +
      `<p>Changes ${change.length === 1 ? "this routine" : `these ${change.length} routines`}:</p><ul class="r-zone-list" data-testid="zone-change">${change.map((r) => `<li>${esc(r.name)} <span class="r-faint">(now ${esc(city(r.schedule.tz))})</span></li>`).join("")}</ul>` +
      (keep.length ? `<p class="r-hint">Left alone:</p><ul class="r-zone-list" data-testid="zone-keep">${keep.map(([r, why]) => `<li>${esc(r.name)} <span class="r-faint">(${why})</span></li>`).join("")}</ul>` : "") +
      `</div><footer class="b-foot"><div class="b-actions">${Z.pending ? button("Check now", 'data-r="zone-check"', "primary") : button(finished ? "Close" : "Cancel", `data-r="zone-close"${dis}`, "quiet")}${finished ? "" : button(saving ? "Changing…" : "Change", `data-r="zone-save"${dis}`, "primary")}</div></footer>`;
    if (!zoneDialog.open) {
      lastFocus = document.activeElement;
      zoneDialog.showModal();
    }
    $(focusSel || "#zone-title", zoneDialog).focus();
  }
  function openZone(bot) {
    if (!isAdmin()) return;
    Z = { bot, plan: zonePlan(bot), tz: "auto", status: "", result: "" };
    renderZone();
  }
  function saveZone() {
    const z = Z;
    z.status = "saving";
    renderZone('[data-r="zone-save"]');
    setTimeout(() => {
      const tz = z.tz === "auto" ? VIEWER : z.tz;
      z.done = [];
      const plan = zonePlan(z.bot);
      if (plan.change.length !== z.plan.change.length || plan.change.some((r, i) => r.id !== z.plan.change[i].id)) {
        z.plan = plan;
        z.status = "";
        z.reconfirm = true;
        z.result = "The list of routines changed. Review it and confirm again.";
        return renderZone('[data-r="zone-save"]');
      }
      z.reconfirm = false;
      for (const r of plan.change) {
        const schedule = { ...r.schedule, tz };
        const req = { method: "cron.update", params: { id: r.id, patch: { schedule } } };
        dispatched.push(req);
        if (P.get("tzfail") === r.id) {
          if (P.get("tzlookup") === "found") land(req);
          z.pending = { id: r.id, name: r.name, schedule };
        } else {
          land(req);
          z.done.push(r.name);
        }
      }
      checkZone();
    }, 500);
  }
  function checkZone() {
    const z = Z;
    const changed = () => z.done.length ? `Changed ${z.done.join(", ")}. ` : "";
    z.status = "";
    if (z.pending) {
      const { id, name, schedule } = z.pending;
      dispatched.push({ method: "cron.get", params: { id } });
      if (!z.checked && P.get("tzlookup") === "unavailable") {
        z.checked = true;
        z.result = `${changed()}Couldn't confirm the time zone of ${name}.`;
        paint();
        return renderZone('[data-r="zone-check"]');
      }
      z.pending = null;
      const current = routines.find((r) => r.id === id).schedule;
      if (current.kind !== schedule.kind || current.expr !== schedule.expr || current.tz !== schedule.tz) {
        const reported = current.tz && current.tz !== schedule.tz ? `${name} still has ${city(current.tz)}.` : `The gateway lists a different schedule for ${name}.`;
        z.result = `${changed()}${reported} The change may still arrive.`;
        paint();
        return renderZone('[data-r="zone-close"]');
      }
      z.done.push(name);
    }
    zoneDialog.close();
    announce(`Changed the time zone of ${z.done.length} routine${z.done.length === 1 ? "" : "s"}`);
    paint('[data-r="zone"]');
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
      case "cal-move":
        S.calOffset = t.dataset.v === "0" ? 0 : (S.calOffset || 0) + +t.dataset.v * (S.view === "day" ? 1 : S.view === "3day" ? 3 : 7);
        return paint(`[data-r="cal-move"][data-v="${t.dataset.v === "0" && S.calOffset === 0 ? "1" : t.dataset.v}"]`);
      case "seg":
        return go(t.dataset.v, { focus: `[data-r="seg"][data-v="${t.dataset.v}"]` });
      case "open":
        return go("routine", { routine: id, from: ["day", "3day", "week"].includes(S.view) ? "calendar" : S.view === "convo" ? "convo" : "list", back: S.view, deleted: false });
      case "back":
        return go(S.back && S.back !== "routine" && S.back !== "run" ? S.back : "list", { deleted: false, focus: `[data-r="open"][data-id="${S.routine}"]` });
      case "open-run":
        return go("run", { runKey: t.dataset.run, runstate: "" });
      case "open-run-task":
        return go("run", { routine: id, runKey: runKey(routines.find((x) => x.id === id).runs[0]), runstate: "", back: "list" });
      case "back-to-routine":
        return go("routine", { focus: `[data-r="open-run"][data-run="${S.runKey}"]` });
      case "open-bot":
        return go("convo", { session: t.dataset.session });
      case "back-to-run":
        return go("run", { session: "" });
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
        const req = { method: "cron.remove", params: { id } };
        dispatched.push(req);
        const unanswered = P.get("deletefail");
        if (unanswered !== "1") {
          sent.push(req);
          r.gone = true;
        }
        if (unanswered !== "1" && unanswered !== "landed") return finishDelete(r);
        confirmDialog.dataset.pending = id;
        $("#confirm-error", confirmDialog)?.remove();
        $(".b-actions", confirmDialog).outerHTML = `<p class="r-error" id="confirm-error" role="alert">The gateway didn't answer. This routine may have been deleted.</p><div class="b-actions">${button("Check now", `data-r="check-delete" data-id="${id}"`)}</div>`;
        $('[data-r="check-delete"]', confirmDialog).focus();
        return;
      }
      case "check-delete": {
        const r = routines.find((x) => x.id === id);
        delete confirmDialog.dataset.pending;
        if (r.gone) return finishDelete(r);
        $("#confirm-error", confirmDialog).textContent = "The gateway still lists this routine. The delete may still arrive.";
        $(".b-actions", confirmDialog).innerHTML = button("Cancel", 'data-r="confirm-cancel"', "quiet") +
          button("Delete", `data-r="confirm-delete" data-id="${id}" data-tone="danger"`);
        $('[data-r="confirm-cancel"]', confirmDialog).focus();
        return;
      }
      case "edit-close":
        editDialog.close();
        D = null;
        return lastFocus?.focus();
      case "save":
        return save();
      case "conflict-show": {
        const mine = D;
        D = Object.assign(draftFrom(routines.find((x) => x.id === mine.id)), { mine, attempts: mine.attempts });
        return renderEditor("#e-name");
      }
      case "conflict-save":
        return save(600, D.conflictAt);
      case "check-now":
        return checkNow();
      case "open-found":
        editDialog.close();
        return go("routine", { routine: id, from: "list", back: "list", deleted: false });
      case "save-as-new":
        D.id = null;
        return save();
      case "checkins":
        return openCheckins(id);
      case "zone":
        return openZone(id);
      case "zone-save":
        return saveZone();
      case "zone-check":
        return checkZone();
      case "zone-close":
        zoneDialog.close();
        return lastFocus?.focus();
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
          if (D) renderEditor("#edit-title");
          announce("Access requested");
        }, 600);
      case "access-check":
        S.access = "admin";
        S.req = "granted";
        announce("Admin access granted");
        paint('[data-r="access-check"]');
        if (D?.status === "adminlost") {
          D.status = "";
          renderEditor('[data-r="save"]');
        }
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
      // Try again reads again: loading, then what the read returns (here, the runs).
      case "runs-retry":
        S.state = "runs-loading";
        paint("#runs-head");
        announce("Loading runs");
        return setTimeout(() => {
          S.state = "";
          if (S.view === "routine") paint("#runs-head");
        }, 400);
      case "run-retry":
        S.runstate = "loading";
        paint("#view-title");
        announce("Loading the run");
        return setTimeout(() => {
          S.runstate = "";
          if (S.view === "run") paint("#view-title");
        }, 400);
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
      const has = !!C.prompt.trim();
      if (had !== !!has) {
        renderCheckins("[data-ci-prompt]");
        const ta = $("[data-ci-prompt]", ciDialog);
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    }
    if (C && t.matches("[data-ci-every]")) C.every = t.value;
    if (Z && t.matches("[data-z-tz]")) Z.tz = t.value;
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
    // In the calendar, Left and Right go to the closest chip in time on the nearest day that has one.
    if (t.matches?.(".r-occ") && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      const cols = $$('[data-testid="cal-day"]');
      const step = event.key === "ArrowRight" ? 1 : -1;
      for (let i = cols.indexOf(t.closest("ul")) + step; i >= 0 && i < cols.length; i += step) {
        const chips = $$(".r-occ", cols[i]);
        if (!chips.length) continue;
        const near = (c) => Math.abs(+c.dataset.min - +t.dataset.min);
        chips.reduce((a, c) => (near(c) < near(a) ? c : a)).focus();
        return;
      }
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
  const busy = () => ["saving", "checking"].includes(D?.status) || C?.status === "saving" || Z?.status === "saving" || !!Z?.pending;
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && busy()) event.preventDefault();
  }, true);
  confirmDialog.addEventListener("cancel", (event) => {
    if (confirmDialog.dataset.pending) event.preventDefault();
  });
  for (const dlg of [editDialog, ciDialog, zoneDialog]) dlg.addEventListener("cancel", (event) => busy() && event.preventDefault());
  for (const dlg of [editDialog, ciDialog, confirmDialog, zoneDialog])
    dlg.addEventListener("close", () => {
      if (dlg === editDialog) D = null;
      if (dlg === ciDialog) C = null;
      if (dlg === zoneDialog) Z = null;
    });

  // First paint, from the address ------------------------------------------------------------------------------------------

  const startView = P.get("transcript") === "checkin" ? "convo" : S.view === "checkins" ? "list" : S.view;
  S.view = startView;
  // The address names a run by its place in the list; from then on it is known by its key.
  if (S.view === "run") {
    const i = S.run ?? 0;
    const x = i < 0 ? r0().running && { at: r0().running, running: true } : r0().runs[i];
    S.runKey = x ? runKey(x) : "none";
  }
  if (S.view === "routine" || S.view === "run") S.back = "list";
  paint();
  if (P.get("confirm") === "delete") askDelete(S.routine);
  if (S.edit === "new" || S.edit === "open" || S.editstate === "locked") {
    if (S.editstate === "locked") S.routine = "renewal";
    openEditor(S.edit === "new" ? null : S.routine);
    if (D && S.editstate === "invalid") {
      Object.assign(D, { kind: "every", n: 2, unit: "minutes" });
      D.errors = validate(D);
      renderEditor();
    } else if (D && S.editstate === "saving") {
      // A save in flight; its wait ends as no answer, so the dialog never stays locked.
      if (!D.id) Object.assign(D, { name: "Evening wrap-up", instruction: "List what I finished today." });
      D.simulate = "noanswer";
      save(4000);
    } else if (D && ["refused", "conflict", "deleted", "noanswer"].includes(S.editstate)) {
      // The address's outcome stands for the first attempt, already made.
      Object.assign(D, { status: S.editstate, attempts: 1, submitted: request(D) });
      renderEditor();
    }
  }
  if (P.get("dialog") === "open") openCheckins(S.bot || "juniper");
  // For the checks: what Save sent, as the gateway would receive it, and the cron reader.
  window.routines = {
    sent, dispatched, routine: (id) => routines.find((r) => r.id === id), event: applyEvent,
    cron: (expr, tz = VIEWER) => {
      const c = cronSpec(expr);
      if (c.error) return { error: c.error };
      const next = occurrences({ kind: "cron", expr, tz }, NOW, horizon(tz), 3);
      return { gap: cronSpacing(c, tz), fires: next.length, next };
    },
  };
  document.addEventListener("ct:settings", () => paint());
})();
