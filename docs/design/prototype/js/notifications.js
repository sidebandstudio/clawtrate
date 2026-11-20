// notifications.html: docs/design/notifications.md. When a notification is
// shown, what it says, what a click opens, and the settings that decide it.
// The host's decision (section 3) is one function, `decide`; opening (section
// 5) is `open`; quiet hours (section 6) are `quietInterval`. Every bot, task,
// figure and reply is a local fixture. A notification is drawn as a labelled
// picture: the system draws the real one.
//
// Address parameters (section 15 of the design lists them):
//   open=settings|bot|details   event=<kind>   device=sender|other|read|admin
//   focus=<bot>  quiet=1  quietset=1  os=mac|windows|linux  platform=none
//   master/names/budgetsw=0|1   bot=otto=off   task=on|off   tasks=full   botsfull=1
//   click=gone|unlisted|botgone|itemgone|offline|othergw|stale
//   conn=down   budgetend=<outcome>
//   prefs=reading|readfail|device|conflict|savefail|unknown|elsewhere
//   access=read   req=asking|requested|denied|expired|failed   failed=1

(function () {
  const CT = window.CT;
  const params = CT.params;
  const p = (name) => params.get(name);
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name, cls) => CT.icon(name, cls);
  const glyph = (state) => CT.glyph(state);
  const LOGO = "../../../packages/ui/src/assets/logo-mark.png";

  // Fixtures ---------------------------------------------------------------------------------------

  const task = (id, title, when, ask, reply, extra = {}) => ({ id, title, when, ask, reply, wait: null, status: "idle", unread: false, ...extra });
  const BOTS = [
    { id: "juniper", name: "Juniper", label: "Research", tasks: [task("j1", "Heat pump vs. gas furnace", "5:24 PM", "Compare a heat pump with a gas furnace for this house.", "Here's the comparison, with ten-year running costs.")] },
    { id: "marlow", name: "Marlow", label: "Writing", tasks: [task("m1", "Notes for Pip", "4:58 PM", null, "Noted. I'll fold it into the plan.", { from: "pip" })] },
    {
      id: "otto",
      name: "Otto",
      label: "Operations",
      tasks: [
        task("o1", "Disk almost full on the media box", "5:36 PM", "Free up space on the media box.", "The transcode cache is the largest folder."),
        task("o3", "Weekly backup check", "2:14 PM", "Did last night's backup finish?", "Yes. Last night's backup finished at 3:25 AM, and the copy checked out."),
        task("o4", "Certificate renewal warning", "Mon", "Is the certificate warning urgent?", "A little. Renewal normally happens with 30 days left."),
        task("o5", "Router firmware", "Mon", "Is the router firmware current?", "The router is two releases behind."),
      ],
    },
    { id: "pip", name: "Pip", label: "Planning", tasks: [task("p1", "Plan the week", "3:10 PM", "Plan my week. Keep Thursday clear.", "Here is the week, with Thursday kept clear.")] },
  ];
  const bot = (id) => BOTS.find((b) => b.id === id);
  const findTask = (id) => {
    for (const b of BOTS) for (const t of b.tasks) if (t.id === id) return { b, t };
    return null;
  };

  // The gateway measures a preference as the UTF-8 bytes of its JSON (section 9).
  const LIMIT = 4096;
  const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
  // Long task keys, as the gateway accepts them, filling the overrides almost to the limit (tasks=full).
  function filler() {
    const out = {};
    for (let i = 0; ; i += 1) {
      const key = `agent:otto:dashboard:${String(i).padStart(4, "0")}-${"a".repeat(104)}`;
      const next = { ...out, [key]: i % 2 ? "on" : "off" };
      if (bytes({ o4: "off", ...next }) > LIMIT - 60) return out;
      Object.assign(out, { [key]: next[key] });
    }
  }

  // One canonical key for a task, used both for the byte check and for the stored map.
  const taskKey = (id) => `agent:${findTask(id)?.b.id ?? "otto"}:dashboard:${id}-3f9a2c71-4b0e-4d7a-9a51-6c0f2e1d8b44`;
  // Other bots switched off, filling the shared value to 5 bytes under the limit (botsfull=1),
  // with quiet hours never saved, so turning a bot off or saving quiet hours would not fit.
  function botsFiller() {
    const out = {};
    const size = (extra) => bytes({ version: 1, bots: { ...out, ...extra } });
    for (let i = 0; size({ [`bot-${i}-${"x".repeat(40)}`]: false }) <= LIMIT - 60; i += 1) out[`bot-${i}-${"x".repeat(40)}`] = false;
    for (let n = 160; n > 0; n -= 1) {
      const key = `pad-${"y".repeat(n)}`;
      if (size({ [key]: false }) <= LIMIT - 5) {
        out[key] = false;
        break;
      }
    }
    return out;
  }

  // The events of the prototype's bar, and what each carries (section 3).
  const EVENTS = {
    finished: { label: "Otto finishes", bot: "otto", task: "o3", kind: "finished", run: "r-o3-1" },
    yielded: { label: "Otto ends without a visible reply", bot: "otto", task: "o3", kind: "yielded", run: "r-o3-2" },
    failed: { label: "Otto's run fails", bot: "otto", task: "o5", kind: "failed", run: "r-o5-1" },
    stopped: { label: "Otto's run is stopped", bot: "otto", task: "o3", kind: "stopped", run: "r-o3-3" },
    approval: { label: "Otto asks to run a command", bot: "otto", task: "o1", kind: "approval", approval: "exec", run: "r-o1-1", command: "du -sh /var/lib/transcode-cache" },
    generic: { label: "Otto asks for a plugin's approval", bot: "otto", task: "o3", kind: "approval", approval: "plugin", run: "r-o3-4" },
    question: { label: "Juniper asks a question", bot: "juniper", task: "j1", kind: "question", run: "r-j1-1", question: "Which matters more to you: running cost or upfront price?" },
    unsupported: { label: "Juniper asks something this app can't answer", bot: "juniper", task: "j1", kind: "question", unsupported: true, run: "r-j1-2" },
    marlow: { label: "Marlow asks, for Pip's message", bot: "marlow", task: "m1", kind: "question", run: "r-m1-1", question: "Should the plan keep Saturday morning free?", via: "pip" },
    routinetask: { label: "A routine fails in Otto's task", bot: "otto", task: "o5", kind: "failed", run: "r-o5-routine", routine: "task" },
    routineisolated: { label: "An isolated routine of Otto's ends", bot: "otto", task: null, kind: "routine", run: "r-cron-1" },
    budget: { label: "Otto passes 80% of its weekly budget", bot: "otto", task: "o1", kind: "budget", budget: "bot:otto", period: "2026-11-16", percent: 82 },
    budget2: { label: "Juniper passes 80% of its daily budget", bot: "juniper", task: "j1", kind: "budget", budget: "bot:juniper", period: "2026-11-19", percent: 85 },
    budget100: { label: "Otto's budget is first counted at 104%", bot: "otto", task: "o1", kind: "budget", budget: "bot:otto", period: "2026-11-16", percent: 104 },
  };

  // State --------------------------------------------------------------------------------------------

  const S = {
    os: ["mac", "windows", "linux"].includes(p("os")) ? p("os") : "mac",
    none: p("platform") === "none", // this build cannot show notifications (section 10)
    device: ["sender", "other", "read", "admin"].includes(p("device")) ? p("device") : "sender",
    master: p("master") !== "0",
    names: p("names") !== "0",
    budgetsw: p("budgetsw") !== "0",
    bots: { juniper: true, marlow: true, otto: p("bot") !== "otto=off", pip: true },
    botsFull: p("botsfull") === "1",
    tasks: {},
    extraOff: {},
    quiet: {
      enabled: p("quiet") === "1" || p("quietset") === "1",
      from: p("qfrom") || "22:00",
      to: p("qto") || "07:00",
      // The saved zone, and the date tonight's interval starts on (quietzone=ny&quietdate=…).
      zone: p("quietzone") === "ny" ? "America/New_York" : "Europe/Lisbon",
      date: p("quietdate") || "2026-11-19",
      saved: p("botsfull") !== "1",
    },
    quietNow: p("quiet") === "1",
    focus: p("focus") || null, // the bot on screen in a focused window
    click: p("click") || "", // what the host finds at a click
    conn: p("conn") === "down" ? "down" : "up",
    budgetEnd: p("budgetend") || "still", // the fresh figure read when quiet hours end
    prefs: p("prefs") || "ok", // reading, readfail, device, conflict, savefail, unknown, elsewhere
    unconfirmed: false, // a save whose outcome could not be confirmed
    access: p("access") === "read" ? "read" : "write",
    req: p("req") || "none", // the access bar's request
    granted: false,
    failedAt: p("failed") === "1" ? "5:41 PM" : null,
    sel: { bot: "otto", task: "o1" },
    panel: false,
    tab: "details",
    bview: "main",
    view: "detail",
    strip: null,
    pics: [], // pictures shown, in the order they were posted
    held: [], // waits held during quiet hours, by task and card
    budgetHolds: {}, // budget warnings held, one per budget id and period start
    warned: new Set(), // budget warnings attempted, by budget and period start (kept across restarts)
    budgetPercent: { "bot:otto": 82, "bot:juniper": 85 }, // the current count, for the click's destination
    budgetRemoved: {}, // budgets removed after their warning was posted
    runs: new Set(), // runs already notified as finished or failed
    why: "", // what the host decided when nothing was shown
    saving: null,
    error: {},
    conflictNote: false,
    timeError: false,
    taskRoom: false,
    resolved: new Set(), // waits answered or ended
    pendingCards: {}, // pending cards this device received, by task: { ev, confirmed }
    relist: p("relist") || "same", // what the pending lists return on the next reconnect
    sectionOpen: "notifications",
    settingsPane: "section",
  };
  if (["conflict", "savefail", "unknown"].includes(S.prefs)) S.prefsFail = S.prefs; // the next write ends that way
  S.tasks = Object.assign({ [taskKey("o4")]: "off" }, p("task") ? { [taskKey("o3")]: p("task") } : {}, p("tasks") === "full" ? filler() : {});
  if (S.botsFull) S.extraOff = botsFiller();
  const ownOf = (id) => S.tasks[taskKey(id)];
  const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  /** The exact `clawtrate.notifications` value a write would send. */
  function sharedValue(bots, quiet) {
    const off = Object.fromEntries(Object.entries(bots).filter(([, on]) => !on).map(([id]) => [id, false]));
    return {
      version: 1,
      bots: { ...S.extraOff, ...off },
      ...(quiet.saved ? { quiet: { enabled: quiet.enabled, startMinute: minutesOf(quiet.from), endMinute: minutesOf(quiet.to), timeZone: quiet.zone } } : {}),
    };
  }
  const sharedReadable = () => S.prefs !== "reading" && S.prefs !== "readfail";
  const canChangeShared = () => S.access !== "read" && sharedReadable() && !S.unconfirmed;

  // What this device holds that is a credential, for the scrub of a bot's name (section 4).
  // The connection's bootstrap token (if still held), its device token, and a sign-in's value
  // (typed with surrounding spaces) with a form derived from it. All fictitious.
  const HELD_SECRETS = ["boot-sample-token-0000", "dev-sample-token-1111", "  signin-sample-key-2222  ", "code-sample-3333"];
  const NAME_CHARS = 40;
  /** The native title: the bot's name, without the credentials this device holds, cut to 40 characters; or "Clawtrate". */
  function nativeTitle(name) {
    if (!S.names) return "Clawtrate";
    let out = name;
    // The same replacement as withoutSecret: the value as held, then its trimmed spelling, longest first.
    for (const secret of [...HELD_SECRETS].sort((a, b) => b.length - a.length)) {
      out = out.split(secret).join("…");
      const trimmed = secret.trim();
      if (trimmed && trimmed !== secret) out = out.split(trimmed).join("…");
    }
    const chars = [...out];
    return chars.length <= NAME_CHARS ? out : `${chars.slice(0, NAME_CHARS - 1).join("")}…`;
  }
  // Opaque local identifiers for the native notification and its group (section 4).
  let nextId = 1;
  const groupIds = {};
  const groupOf = (botId) => (groupIds[botId] ??= `g${Object.keys(groupIds).length + 1}`);

  // The host's decision (section 3) ------------------------------------------------------------------

  const eff = (ev) => {
    const own = ownOf(ev.task);
    if (own === "on") return true;
    if (own === "off") return false;
    return S.bots[ev.bot];
  };
  /** Whether this device has the pending record: a question on every interactive device; an approval on the sender, an admin or reviewer device. */
  const hasRecord = (ev) => (ev.kind === "question" ? S.device !== "read" : S.device === "sender" || S.device === "admin");
  const budgetKey = (ev) => `${ev.budget}:${ev.period}`;

  /** Returns { show: picture } or { hold: why } or { none: why }, by the design's order. */
  function decide(ev, { release = false } = {}) {
    const b = bot(ev.bot);
    if (S.none) return { none: "This copy of Clawtrate can't show notifications here. The rail and the badge show it." };
    if (!S.master) return { none: "Show notifications is off on this computer." };
    if (S.conn === "down") return { none: "The connection is down: this device receives nothing until it reconnects." };
    if (!sharedReadable() || S.unconfirmed) return { none: "Your settings aren't confirmed from the gateway, so no notification about a bot is shown." };
    if (ev.kind === "stopped") return { none: "A stopped run isn't notified: someone chose to stop it." };
    if (ev.kind === "yielded") return { none: "A run that ended without a visible reply isn't notified." };
    if (ev.kind === "routine") return { none: "Isolated routines and cron completion events do not notify here." };
    if ((ev.kind === "finished" || ev.kind === "failed") && S.runs.has(ev.run)) return { none: "This run was already notified." };
    if (ev.kind === "question" && !hasRecord(ev)) return { none: "A read-only device receives nothing that says a question waits." };
    if (ev.kind === "budget") {
      if (!S.budgetsw) return { none: "Budget warnings are off on this computer." };
      if (S.warned.has(budgetKey(ev))) return { none: "This budget was already warned about in this period." };
      if (!release && ev.percent >= 100) return { none: "A count first observed at 100% or more posts nothing: the note above the composer is the warning." };
    } else if (!eff(ev)) {
      return { none: ownOf(ev.task) === "off" ? `This task's notifications are off.` : `Notifications for ${b.name} are off.` };
    }
    if (S.focus) {
      if (S.os === "linux") return { none: "Clawtrate's window is focused. On Linux nothing is shown then." };
      if (S.focus === ev.bot) return { none: `${b.name} is on screen in the focused window.` };
    }
    if (S.quietNow) {
      if (ev.kind === "budget") return { hold: `Held until ${quietEnd()}: ${b.name}'s budget warning. It needs a fresh figure for this period then.` };
      if (ev.kind === "approval" && !hasRecord(ev)) return { none: "Quiet hours: a wait this device has no request for isn't held. It can't be confirmed later." };
      if (ev.kind === "approval" || ev.kind === "question") return { hold: `Held until ${quietEnd()}: ${b.name} is waiting for you.` };
      return { none: "Quiet hours: this is never shown later. The rail and the task hold it." };
    }
    return { show: picture(ev) };
  }

  // What a notification says (section 4): a fixed sentence for the kind, never gateway text.
  function words(ev) {
    const n = S.names;
    if (ev.kind === "finished") return n ? "Finished." : "A bot finished.";
    if (ev.kind === "failed") return n ? "Its run failed." : "A bot's run failed.";
    if (ev.kind === "approval") {
      if (!hasRecord(ev)) return "A run is waiting for approval. This device doesn't have the approval request.";
      if (ev.approval === "exec") return n ? "Wants to run a command." : "A bot wants to run a command.";
      return n ? "Needs your approval." : "A bot needs your approval.";
    }
    if (ev.kind === "question" && ev.unsupported) return n ? "Asked something this app can't answer yet." : "A bot asked something this app can't answer yet.";
    if (ev.kind === "question") return n ? "Asked you a question." : "A bot asked you a question.";
    if (ev.kind === "budget") return n ? "Reached 80% of its budget. Shown only: nothing was stopped." : "A bot reached 80% of its budget. Shown only: nothing was stopped.";
    return "";
  }
  function picture(ev) {
    return { id: `n${nextId++}`, group: groupOf(ev.bot), ev, title: nativeTitle(bot(ev.bot).name), body: words(ev) };
  }
  // One per task, apart from a budget warning, which has its own slot (sections 3 and 11).
  const slotOf = (pic) => (pic.ev.kind === "budget" ? budgetKey(pic.ev) : pic.ev.task);

  function post(pic) {
    const ev = pic.ev;
    if (ev.kind === "finished" || ev.kind === "failed") S.runs.add(ev.run);
    if (ev.kind === "budget") S.warned.add(budgetKey(ev));
    S.pics = [...S.pics.filter((x) => slotOf(x) !== slotOf(pic)), pic];
    // A later shown callback clears the note about a failed post (section 7).
    S.failedAt = null;
  }

  function fire(name) {
    const ev = EVENTS[name];
    if (!ev) return;
    if (ev.task) S.resolved.delete(`${ev.task}:${ev.kind}`);
    if (S.conn === "up") markRail(ev);
    // A pending card this device received and can see: kept as confirmed until a list says otherwise.
    if (S.conn === "up" && (ev.kind === "approval" || ev.kind === "question") && hasRecord(ev)) S.pendingCards[ev.task] = { ev, confirmed: true };
    const outcome = decide(ev);
    if (outcome.show) {
      post(outcome.show);
      S.why = "";
    } else if (outcome.hold) {
      if (ev.kind === "budget") S.budgetHolds[budgetKey(ev)] = ev;
      else S.held = [...S.held.filter((x) => x.task !== ev.task), ev];
      S.why = outcome.hold;
    } else S.why = `No notification. ${outcome.none}`;
    renderLayer();
    renderRail();
    if ($("#settings-dialog").open) renderSettings();
  }

  // The rail goes on updating, notifications or not (section 6).
  function markRail(ev) {
    if (!ev.task) return;
    // A device marks only what it received: a read-only device gets no question at all.
    if (ev.kind === "question" && !hasRecord(ev)) return;
    const { t } = findTask(ev.task);
    if (ev.kind === "approval" || ev.kind === "question") t.wait = ev.kind === "question" ? "question" : hasRecord(ev) ? "approval" : "phase";
    if (ev.kind === "finished") t.unread = true;
    if (ev.kind === "failed") t.status = "failed";
  }

  // When quiet hours end: each held wait needs a fresh pending record this device can see, and each
  // held budget warning a confirmed limit and one count for the same budget and period (sections 6, 11).
  const BUDGETS = {
    "bot:otto": { period: "weekly", zone: "Europe/Lisbon", limit: 2_000_000 },
    "bot:juniper": { period: "daily", zone: "Europe/Lisbon", limit: 500_000 },
  };
  // What the preference read and the awaited count return at the end, by fixture and budget.
  // Release is Thursday 2026-11-19 unless the fixture is "friday".
  function releaseRead(fixture, id) {
    const b = BUDGETS[id];
    const friday = fixture === "friday";
    const startDate = b.period === "weekly" ? (fixture === "rollover" ? "2026-11-23" : "2026-11-16") : friday ? "2026-11-20" : "2026-11-19";
    const base = { prefs: "ok", present: true, limit: b.limit, period: b.period, zone: b.zone, startDate, used: Math.round(b.limit * 0.86), counting: false, error: null };
    if (fixture === "raised") return { ...base, limit: Math.round(b.limit * 1.05), used: Math.round(b.limit * 0.855) };
    if (fixture === "over100") return { ...base, used: Math.round(b.limit * 1.04) };
    if (fixture === "below") return { ...base, limit: b.limit * 1.5, used: Math.round(b.limit * 0.855) };
    if (fixture === "refreshing") return { ...base, used: 0, counting: true };
    if (fixture === "readfail") return { ...base, error: "The usage read failed." }; // the earlier figure retained
    if (fixture === "prefsfail") return { ...base, prefs: "failed" };
    if (fixture === "removed") return { ...base, present: false };
    return base;
  }
  const BUDGET_END_FIXTURES = ["still", "raised", "over100", "below", "refreshing", "readfail", "prefsfail", "rollover", "removed", "friday"];
  /** The first-table-row predicates of section 11, on the confirmed limit and the one count. */
  function budgetRelease(hold) {
    const r = releaseRead(S.budgetEnd, hold.budget);
    const b = BUDGETS[hold.budget];
    if (r.prefs !== "ok") return { why: "the budgets preference couldn't be read" };
    if (!r.present) return { why: "the budget was removed" };
    if (r.period !== b.period || r.zone !== b.zone || r.startDate !== hold.period) return { why: "the period rolled over" };
    if (r.error) return { why: "the count has an error, though it kept the earlier figure" };
    if (typeof r.used !== "number" || r.counting) return { why: "the gateway was still counting, so the figure is unknown" };
    const percent = Math.floor((r.used / r.limit) * 100);
    if (percent < 80) return { why: "the count is under 80% of the confirmed limit" };
    return { post: true, percent };
  }
  function quietEnds() {
    S.quietNow = false;
    if (S.conn === "down") {
      S.held = [];
      S.budgetHolds = {};
      S.why = "Quiet hours ended while the connection was down. The holds were dropped; your tasks show what waits.";
      return refresh();
    }
    const shown = [];
    for (const ev of S.held) {
      if (S.resolved.has(`${ev.task}:${ev.kind}`) || !hasRecord(ev)) continue;
      const outcome = decide(ev);
      if (outcome.show) shown.push(outcome.show);
    }
    // Every eligible wait is attempted before any eligible budget warning, in separate slots.
    const dropped = [];
    for (const hold of Object.values(S.budgetHolds)) {
      const r = budgetRelease(hold);
      if (!r.post) {
        dropped.push(`${bot(hold.bot).name}'s budget warning was dropped: ${r.why}.`);
        continue;
      }
      S.budgetPercent[hold.budget] = r.percent;
      const outcome = decide(hold, { release: true });
      if (outcome.show) shown.push(outcome.show);
    }
    S.held = [];
    S.budgetHolds = {};
    shown.forEach(post);
    const budgetWhy = dropped.join(" ");
    S.why = shown.length ? budgetWhy : `Quiet hours ended. Nothing still waiting, so nothing was shown.${budgetWhy ? ` ${budgetWhy}` : ""}`;
    refresh();
  }
  function wakeAfterEnd() {
    S.quietNow = false;
    S.held = [];
    S.budgetHolds = {};
    S.why = "Woke after quiet hours ended. Nothing from while it slept is replayed, and the holds were dropped.";
    refresh();
  }
  function answeredElsewhere() {
    for (const ev of S.held) {
      delete S.pendingCards[ev.task];
      S.resolved.add(`${ev.task}:${ev.kind}`);
      findTask(ev.task).t.wait = null;
    }
    S.why = "The wait was answered on another device.";
    refresh();
  }
  // Disconnect: phase-only waits are cleared and their notifications withdrawn (section 3).
  function dropConnection() {
    S.conn = "down";
    for (const b of BOTS) for (const t of b.tasks) if (t.wait === "phase") t.wait = null;
    S.pics = S.pics.filter((pic) => !(pic.ev.kind === "approval" && !hasRecord(pic.ev)));
    S.held = S.held.filter((ev) => hasRecord(ev));
    for (const card of Object.values(S.pendingCards)) card.confirmed = false; // unconfirmed while down
    S.why = "Disconnected. Waits this device has no request for were cleared, and their notifications withdrawn.";
    setStrip({ tone: "warn", text: "Reconnecting in 4s", more: "showing saved messages" });
    refresh();
  }
  // Reconnect: the rail, the reloaded transcripts and visible pending cards update; nothing is posted.
  // A successful pending list confirms only the requests it includes; a failed one confirms nothing.
  function reconnect(list = S.relist) {
    S.conn = "up";
    findTask("o3").t.unread = true; // a reply missed while down shows as unread
    S.why = "Reconnected. Missed events can appear in your tasks; no notification is posted for them.";
    if (list !== "failed") {
      const listed = new Set(Object.keys(S.pendingCards).filter((task) => !(list === "omit" && S.pendingCards[task].ev.kind === "approval")));
      if (list === "missedq") listed.add("j1");
      for (const task of Object.keys(S.pendingCards)) {
        if (listed.has(task)) continue;
        // Omitted by a successful list: its notification is withdrawn and its mark cleared.
        S.pics = S.pics.filter((pic) => pic.ev.task !== task);
        findTask(task).t.wait = null;
        S.pendingCards[task].confirmed = false;
        S.pendingCards[task].gone = true;
      }
      for (const task of listed) {
        const ev = S.pendingCards[task]?.ev || EVENTS.question;
        S.pendingCards[task] = { ev, confirmed: true };
        findTask(task).t.wait = ev.kind === "question" ? "question" : "approval";
      }
    }
    setStrip(null);
    render();
    refresh();
    if (S.opened && S.pendingCards[S.opened.task]?.gone) setStrip({ tone: "warn", text: "Clawtrate couldn't find that item in this task." });
  }
  function refresh() {
    renderLayer();
    renderRail();
    if ($("#settings-dialog").open) renderSettings();
  }

  // Quiet hours across a clock change (section 6) -----------------------------------------------------

  const fmt = (zone) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const localOf = (ms, zone) => {
    const parts = Object.fromEntries(fmt(zone).formatToParts(ms).map((x) => [x.type, x.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  };
  const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  /** The instants a wall time on a date has in a zone: none (skipped), one, or two (repeated). */
  function instants(date, hhmm, zone) {
    const wall = `${date} ${hhmm}`;
    const base = Date.parse(`${date}T${hhmm}:00Z`);
    const found = [];
    for (let k = -56; k <= 56; k += 1) {
      const ms = base - k * 15 * 60000;
      if (localOf(ms, zone) === wall) found.push(ms);
    }
    return found.sort((a, b) => a - b);
  }
  /** The first instant whose wall time in the zone is at or after the given one: a skipped time's first valid time after the jump. */
  function firstAfter(date, hhmm, zone) {
    const wall = `${date} ${hhmm}`;
    const base = Date.parse(`${date}T${hhmm}:00Z`) - 15 * 3600000;
    for (let ms = base; ms < base + 30 * 3600000; ms += 60000) if (localOf(ms, zone) >= wall) return ms;
    return null;
  }
  /** One interval per start date in the saved zone: a repeated start is its first occurrence, a repeated end its last, a skipped one the first valid time after. */
  function quietInterval(startDate, from, to, zone) {
    const endDate = to > from ? startDate : addDays(startDate, 1);
    const s = instants(startDate, from, zone);
    const e = instants(endDate, to, zone);
    return {
      start: s.length ? s[0] : firstAfter(startDate, from, zone),
      end: e.length ? e[e.length - 1] : firstAfter(endDate, to, zone),
    };
  }

  /**
   * The continuous quiet interval that starts on a date: the start is included and the end excluded;
   * an interval whose endpoints coincide is empty; intervals that touch or overlap are one, and
   * "Quiet until" and release use its final end.
   */
  function continuousInterval(startDate, from, to, zone) {
    const first = quietInterval(startDate, from, to, zone);
    if (first.start >= first.end) return { ...first, empty: true };
    let { start, end } = first;
    for (let d = addDays(startDate, 1), n = 0; n < 7; d = addDays(d, 1), n += 1) {
      const next = quietInterval(d, from, to, zone);
      if (next.start >= next.end || next.start > end) break;
      end = Math.max(end, next.end);
    }
    return { start, end, empty: false };
  }
  const ZONE_NAMES = { "Europe/Lisbon": "Lisbon", "America/New_York": "New York" };
  /** The resolved end of tonight's continuous interval, as the saved zone's clock reads it. */
  const quietEnd = () => {
    const q = S.quiet;
    const { end } = continuousInterval(q.date, q.from, q.to, q.zone);
    return `${localOf(end, q.zone).slice(11)}, ${ZONE_NAMES[q.zone]} time`;
  };

  // Opening (section 5) -------------------------------------------------------------------------------

  function open(pic) {
    S.why = "";
    const ev = pic.ev;
    setStrip(null);
    // The record is cleared only once the window has received its target (below).
    const done = () => (S.pics = S.pics.filter((x) => x !== pic));
    if (S.click === "stale") {
      done();
      S.why = "Clawtrate came forward as it was. It has no record of that notification, so nothing opened.";
      return renderLayer();
    }
    if (S.click === "othergw") {
      done();
      setStrip({ tone: "warn", text: "That notification came from Studio gateway. Clawtrate is using Home gateway now.", action: "Your gateways" });
      return renderLayer();
    }
    if (S.click === "botgone") {
      done();
      setStrip({ tone: "warn", text: "Clawtrate couldn't open that bot on this gateway." });
      return renderLayer();
    }
    // A connected click reads the task by its key, even when the rail lists it (the fixture's by-key
    // answer: unlisted returns the session, gone returns null, refused fails).
    const byKey = S.conn === "down" ? "cached" : S.click === "gone" ? "null" : S.click === "refused" ? "failed" : "session";
    if (byKey === "null" || byKey === "failed") {
      S.sel = { bot: ev.bot, task: null };
      S.view = "detail";
      setStrip({ tone: "warn", text: "Clawtrate couldn't find that task on this gateway." });
      done();
      renderLayer();
      render();
      return requestAnimationFrame(() => $(`.bot[data-bot="${ev.bot}"]`)?.focus());
    }
    S.sel = { bot: ev.bot, task: ev.task };
    S.view = "detail";
    S.opened = S.click === "itemgone" ? null : ev;
    if (ev.kind === "budget" && S.budgetRemoved[ev.budget]) setStrip({ tone: "warn", text: "Clawtrate couldn't find that item in this task." });
    if (S.click === "itemgone") {
      // The confirmed task no longer has the card: nothing of it is drawn as pending.
      delete S.pendingCards[ev.task];
      findTask(ev.task).t.wait = null;
      setStrip({ tone: "warn", text: "Clawtrate couldn't find that item in this task." });
    }
    if (S.conn === "down") setStrip({ tone: "warn", text: "Reconnecting in 4s", more: "showing saved messages" });
    if (ev.kind === "finished") findTask(ev.task).t.unread = false;
    render();
    requestAnimationFrame(() => {
      const target = $("#n-target") || $("#transcript");
      target.scrollIntoView({ block: "center" });
      target.focus();
      done();
      renderLayer();
    });
  }

  function setStrip(strip) {
    S.strip = strip;
    const el = $("#status-strip");
    el.hidden = !strip;
    $(".conversation").dataset.strip = String(Boolean(strip));
    const down = S.conn === "down";
    $("#gateway-dot").dataset.status = down ? "reconnecting" : "connected";
    $("#gateway-state").textContent = down ? "Reconnecting…" : "Connected";
    if (!strip) return;
    el.dataset.tone = strip.tone;
    el.innerHTML =
      `<span class="status-dot"></span><span class="status-strip-text">${esc(strip.text)}${strip.more ? `<span>· ${esc(strip.more)}</span>` : ""}</span>` +
      (strip.action ? `<button type="button" data-n="gateways">${strip.action}</button>` : "");
  }

  // The pictures ------------------------------------------------------------------------------------

  function renderLayer() {
    const layer = $("#n-layer");
    const pics = S.pics
      .map(
        (pic) =>
          `<div class="n-pic" data-testid="n-pic" data-kind="${pic.ev.kind}" data-bot="${pic.ev.bot}" data-native-id="${pic.id}" data-native-group="${pic.group}">` +
          `<p class="n-pic-label">Picture of a system notification</p>` +
          `<button type="button" class="n-pic-body" data-n-open="${esc(pic.id)}" aria-label="${esc(`${pic.title}. ${pic.body} Open.`)}">` +
          `<span class="n-pic-app"><img src="${LOGO}" alt="" width="16" height="16" />Clawtrate<span class="n-pic-when">now</span></span>` +
          `<span class="n-pic-title">${esc(pic.title)}</span><span class="n-pic-text">${esc(pic.body)}</span>` +
          `</button><button type="button" class="icon-button n-pic-close" data-n-close="${esc(pic.id)}" aria-label="Close the picture">${icon("x")}</button></div>`,
      )
      .join("");
    const why = S.why ? `<p class="n-why" data-testid="n-why" role="status"><span>Prototype: the host decided</span>${esc(S.why)}</p>` : "";
    layer.innerHTML = pics + why;
    CT.hydrate(layer);
  }

  // The shell -----------------------------------------------------------------------------------------

  const shell = $(".shell");

  function waitWords(t) {
    if (!t.wait) return "";
    if (t.wait === "question") return "Waiting for you: a question";
    if (t.wait === "approval") return "Waiting for you: approve a command";
    return "Waiting for an approval";
  }

  function renderRail() {
    const el = $("#bot-list");
    el.innerHTML = BOTS.map((b) => {
      const open = b.id === S.sel.bot;
      const waiting = b.tasks.find((t) => t.wait);
      const latest = b.tasks[0];
      const preview = waiting ? waitWords(waiting) : latest.reply;
      const unread = b.tasks.some((t) => t.unread);
      const failed = b.tasks.some((t) => t.status === "failed");
      return (
        `<li class="bot-group"${open ? ' data-open="true"' : ""}>` +
        `<button type="button" class="bot" data-bot="${b.id}" aria-current="${open && !S.sel.task}" aria-expanded="${open}" data-testid="bot">` +
        `<span class="avatar" data-bot="${b.id}"></span>` +
        `<span class="bot-text"><span class="bot-line"><span class="bot-name">${b.name}</span><time class="bot-time">${latest.when}</time></span>` +
        `<span class="bot-line">${waiting ? glyph("waiting") : failed ? glyph("failed") : ""}<span class="bot-preview"${waiting ? ' data-tone="warn"' : ""}>${esc(preview)}</span>${unread ? '<span class="unread-dot"></span>' : ""}</span></span></button>` +
        (open
          ? `<ul class="task-list" aria-label="${b.name}'s tasks" data-testid="task-list">` +
            b.tasks
              .filter((t) => !t.hidden)
              .map((t) => {
                const current = S.sel.task === t.id;
                const mark = t.wait ? glyph("waiting") : t.status === "failed" ? glyph("failed") : t.unread && !current ? '<span class="unread-dot" aria-hidden="true"></span>' : "";
                return `<li><button type="button" class="task" data-bot="${b.id}" data-task="${t.id}" aria-current="${current}" data-testid="task"><span class="task-title">${esc(t.title)}</span><time class="task-time">${t.when}</time>${mark}</button></li>`;
              })
              .join("") +
            `</ul>`
          : "") +
        `</li>`
      );
    }).join("");
    CT.hydrate(el);
  }

  function header() {
    const b = bot(S.sel.bot);
    const t = S.sel.task && findTask(S.sel.task).t;
    $("#title-pill").innerHTML = `<span class="avatar" data-bot="${b.id}"></span><span class="title-pill-name">${b.name}</span>${t ? `<span class="title-pill-task">${esc(t.title)}</span>` : ""}`;
    CT.hydrate($("#title-pill"));
  }

  const turn = (role, html) => `<div class="turn" data-role="${role}">${html}</div>`;
  const user = (text) => turn("user", CT.msg({ role: "user", html: esc(text) }));
  // A cached card's answers stay disabled until the gateway confirms the request (sections 3 and 5):
  // while the connection is down, and after a reconnect whose list did not confirm it.
  const OFFLINE_LINE = `<p class="request-ended" data-testid="offline-line">Clawtrate is reconnecting. You can answer once the gateway confirms this request is still open.</p>`;
  const UNCONFIRMED_LINE = `<p class="request-ended" data-testid="offline-line">Clawtrate couldn't confirm this request is still open. Its answers stay off until it can.</p>`;
  function offlineCard(html) {
    const card = S.pendingCards[S.sel.task];
    const down = S.conn === "down";
    if (!down && (!card || card.confirmed)) return html;
    const OFFLINE_LINE_NOW = down ? OFFLINE_LINE : UNCONFIRMED_LINE;
    return html
      .replace(/<button type="button" class="(button|option|icon-button)"/g, '<button type="button" disabled class="$1"')
      .replace(/<input type="text"/g, "<input disabled type=\"text\"")
      .replace('<div class="card-actions">', `${OFFLINE_LINE_NOW}<div class="card-actions">`);
  }

  function transcript() {
    const b = bot(S.sel.bot);
    const el = $("#transcript");
    if (!S.sel.task) {
      el.innerHTML =
        `<div class="empty"><div><span class="avatar" data-bot="${b.id}"></span><h1>Pick a task</h1><p>Choose one of ${b.name}'s tasks${S.access === "read" ? " to read the conversation" : ", or start a new one"}.</p></div></div>`;
      return CT.hydrate(el);
    }
    const { t } = findTask(S.sel.task);
    const pending = S.pendingCards[t.id];
    const ev = S.opened && S.opened.task === t.id ? S.opened : pending ? pending.ev : null;
    let body = `<div class="stamp">Today ${t.when}</div>`;
    if (t.from) body += `<p class="event-line" data-side="center">A message from ${bot(t.from).name}</p>`;
    if (t.ask) body += user(t.ask);
    if (ev?.kind === "approval") {
      if (hasRecord(ev)) {
        const exec = ev.approval === "exec";
        body += turn(
          "assistant",
          offlineCard(
            CT.approval({
              id: "n-target",
              bot: "otto",
              what: exec ? "run a command" : "use the notes plugin",
              summary: exec ? `List the size of each folder under <b>/var/lib</b> on the <b>media box</b>.` : `Read the notes the plugin keeps for this task.`,
              full: exec
                ? { reason: "To find what fills the disk.", command: ev.command, fields: [["Runs on", "media-box"], ["Folder", "/var/lib"], ["Asked by", "Otto"]] }
                : { reason: "To check the renewal date.", command: "notes.read", fields: [["Plugin", "notes"], ["Asked by", "Otto"]] },
              request: exec ? { command: ev.command, cwd: "/var/lib", host: "media-box", agentId: "otto" } : null,
              decisions: exec ? ["once", "always", "deny"] : ["once", "deny"],
              raw: { events: [["approval requested, as the gateway sends it", '{ "id": "6af68f8a-…", "status": "pending" }']], ids: [["Approval", "6af68f8a"]] },
            }),
          ),
        );
        body += CT.statusLine({ bot: "otto", state: "waiting", phrase: "Waiting for you", elapsed: "0:12", badge: "waiting" });
      } else {
        const words =
          S.device === "read"
            ? `<p><b>Otto is waiting for an approval or an answer.</b> This device can't see it on a read-only connection.</p><p>${CT.linkButton("Request access")}</p>`
            : `<p><b>A run is waiting for approval.</b> This device doesn't have the approval request.</p>`;
        body += `<div class="turn-note" id="n-target" tabindex="-1" data-testid="unseen-wait">${glyph("blocked")}<div>${words}</div></div>`;
        body += CT.statusLine({ bot: "otto", state: "thinking", badge: "blocked", phrase: "Waiting for an answer", elapsed: "0:12" });
      }
    } else if (ev?.kind === "question") {
      if (t.from) body += `<p class="request-asker n-asker">Marlow is working on a message from Pip.</p>`;
      body += ev.unsupported
        ? turn("assistant", CT.questionReadOnly({ id: "n-target", bot: ev.bot, questions: [{ question: "Pick a supplier and attach the signed quote.", options: ["Supplier A", "Supplier B"], why: "It asks for a file, which this app can't send yet." }], raw: { events: [["question.requested", "{}"]], ids: [["Question", "ask_7d1e"]] } }))
        : turn(
            "assistant",
            offlineCard(
              CT.question({
                id: "n-target",
                bot: ev.bot,
                title: ev.question,
                options: ev.bot === "marlow" ? [["Yes, keep it free"], ["No, it can be used"]] : [["Running cost", "Over ten years"], ["Upfront price", "What I pay this year"]],
                raw: { events: [["question.requested, as the gateway sends it", '{ "id": "ask_ebb5ae55…", "status": "pending" }']], ids: [["Question", "ask_ebb5ae55"]] },
              }),
            ),
          );
    } else if (ev?.kind === "failed") {
      body += CT.turnError({ title: "Otto couldn't finish this turn", reason: "The model request failed. Nothing ran.", retry: S.access !== "read" && S.device !== "read" }).replace('class="card turn-error"', 'class="card turn-error" id="n-target" tabindex="-1"');
    } else if (ev?.kind === "budget") {
      body += turn("assistant", CT.msg({ html: `<p>${esc(t.reply)}</p>` }));
      // The current count decides the destination: the line at 80-99%, the note above the composer at 100% or more.
      const b = bot(ev.bot);
      const budget = BUDGETS[ev.budget];
      const percent = S.budgetPercent[ev.budget];
      const kind = budget.period === "weekly" ? "weekly" : "daily";
      const million = (n) => `${(n / 1e6).toFixed(2).replace(/\.?0+$/, "")}M`;
      if (S.budgetRemoved[ev.budget]) {
        // Neither the line nor the note: the click says the item is missing.
      } else if (percent >= 100)
        body += `<div class="b-note n-budget-note" id="n-target" tabindex="-1" data-testid="budget-note">${icon("warning")}<div><p>${b.name} has reached its ${kind} warning budget. Runs continue when this warning appears: nothing stops ${b.name}, here or in other apps, channels or routines.</p></div></div>`;
      else
        body += `<div class="event-line" data-side="center" id="n-target" tabindex="-1" data-testid="budget-line">${b.name} has used ${percent}% of its ${kind} budget: ${million((budget.limit * percent) / 100)} of ${million(budget.limit)} tokens.</div>`;
    } else {
      body += turn("assistant", CT.msg({ html: `<p>${esc(t.reply)}</p>`, id: ev?.kind === "finished" ? "n-target" : "" }).replace('id="n-target"', 'id="n-target" tabindex="-1"'));
    }
    el.innerHTML = `<div class="transcript-inner"><h1 class="task-line">${esc(t.title)}</h1>${body}</div>`;
    CT.hydrate(el);
  }

  function render() {
    shell.dataset.view = S.view;
    shell.dataset.panel = S.panel ? "open" : "closed";
    const button = $("#panel-button");
    button.setAttribute("aria-pressed", String(S.panel));
    button.setAttribute("aria-label", S.panel ? "Hide work panel" : "Show work panel");
    renderRail();
    header();
    transcript();
    renderPanel();
  }

  // The Work pane: Details (section 9) and the bot's Settings tab (section 8) -----------------------------

  const say = (where, text) => {
    const live = where === "pane" ? $("#pane-live") : $("#settings-live");
    if (live) {
      live.textContent = "";
      requestAnimationFrame(() => (live.textContent = text));
    }
  };
  const sw = (on, attrs, label, describedBy) =>
    `<button type="button" class="b-switch" role="switch" aria-checked="${on}" aria-label="${esc(label)}"${describedBy ? ` aria-describedby="${describedBy}"` : ""} ${attrs}></button>`;
  const switchRow = (id, title, sub, on, attrs, label) =>
    `<div class="b-row n-row" data-row="${id}"><span class="b-row-main"><span>${title}</span><small id="n-sub-${id}">${sub}</small></span>${sw(on, attrs, label, `n-sub-${id}`)}</div>`;
  const note = (html, tone = "") => `<div class="b-note"${tone ? ` data-tone="${tone}"` : ""}>${icon(tone ? "warning" : "approval")}<div>${html}</div></div>`;
  // The access bar of conversation.md section 3, in all its states (section 2).
  function accessBar(need) {
    const row = (state, lead, text, action = "", tone = "") =>
      `<section class="access-bar" role="region" aria-label="Access" data-state="${state}"${tone ? ` data-tone="${tone}"` : ""} data-testid="access-bar"><div class="access-row">${lead}<span class="shelf-text">${text}</span>${action}</div>`;
    const button = (label, n) => `<button type="button" class="button" data-variant="primary" data-size="sm" data-n="${n}">${label}</button>`;
    if (S.req === "asking") return row("asking", glyph("sending"), `<span aria-busy="true">Asking the gateway…</span>`) + `</section>`;
    if (S.req === "requested")
      return (
        row("requested", glyph("waiting"), "<b>Waiting for the gateway's owner.</b> Approve this request on the gateway's machine:") +
        `<div class="command-line"><code>openclaw devices approve 7c41d09e</code></div>` +
        `<div class="access-row"><span class="shelf-text">This changes by itself as soon as the owner approves or denies the request, or it expires.</span></div></section>`
      );
    if (S.req === "denied") return row("denied", glyph("stopped"), "<b>The request was denied.</b> Nothing changed. This device can still read.", button("Request again", "request")) + `</section>`;
    if (S.req === "expired") return row("expired", glyph("stopped"), "<b>The request expired</b> before it was approved.", button("Request again", "request")) + `</section>`;
    if (S.req === "failed") return row("failed", icon("warning"), "<b>Couldn't send the request.</b> The gateway did not answer.", button("Try again", "request"), "danger") + `</section>`;
    return row("none", icon("eye"), `<b>Read-only.</b> ${need}`, button("Request access", "request")) + `</section>`;
  }
  function askAccess() {
    S.req = "asking";
    renderAll();
    setTimeout(() => {
      S.req = "requested";
      renderAll();
    }, 300);
  }
  // The owner's answer to the request (the prototype's bar, or the check).
  function resolveReq(answer) {
    if (answer === "granted") {
      S.req = "none";
      S.access = "write";
      S.granted = true;
      renderAll();
      say("settings", "Access granted");
      return;
    }
    S.req = answer;
    renderAll();
  }
  const renderAll = () => {
    if ($("#settings-dialog").open) renderSettings();
    renderPanel();
  };
  const NEED = "Changing quiet hours and your bots' notifications needs more access.";

  const taskValue = (taskId, botId) => {
    const own = ownOf(taskId);
    if (own === "on") return "On";
    if (own === "off") return "Off";
    return `Same as ${bot(botId).name} (${S.bots[botId] ? "on" : "off"})`;
  };
  const botValue = (id) => (S.none ? "Not shown on this computer" : !S.master ? "Off on this computer" : S.bots[id] ? "On" : "Off");
  // Where a saved setting is kept, in the words bots-lifecycle.md uses (section 2).
  const KEPT_DEVICE = "Kept on this computer.";
  const keptShared = () =>
    S.prefs === "device"
      ? "Kept on this computer: this connection has no profile on the gateway to keep it in, so your other devices won't show it."
      : "Kept for you on this gateway, so your other devices show the same.";
  const kept = (id, words) => `<p class="b-hint n-kept" data-testid="kept-${id}">${words}</p>`;
  // A build that cannot show notifications; with only local settings, nothing "applies on your other devices".
  const NONE_HERE = (what) =>
    S.prefs === "device" ? "This copy of Clawtrate can't show notifications on this computer." : `This copy of Clawtrate can't show notifications. ${what} applies on your other devices.`;
  const savingLine = (key, idle) => (S.saving === key ? "Saving…" : S.error[key] || idle);
  const UNCONFIRMED_NOTE = `<p>Couldn't confirm your notification settings with the gateway. Until Clawtrate reads them again, it shows no notifications about your bots.</p><div class="b-actions"><button type="button" class="button" data-size="sm" data-n="check-again">Check again</button></div>`;

  function renderPanel() {
    const b = bot(S.sel.bot);
    const t = S.sel.task && findTask(S.sel.task).t;
    $("#work-hero").innerHTML = `<span class="avatar" data-bot="${b.id}"></span><h2>${b.name}</h2><p>${b.label}</p>`;
    CT.hydrate($("#work-hero"));
    const shared = canChangeShared();
    $("#panel-details").innerHTML = t
      ? `<p class="work-task">${esc(t.title)}</p>` +
        `<dl class="facts"><div><dt>Model</dt><dd>scripted/dev-1</dd></div><div><dt>Runs on</dt><dd>Gateway host</dd></div><div><dt>Last activity</dt><dd>Today, ${t.when}</dd></div></dl>` +
        `<h3 class="b-tabgroup">Notifications</h3>` +
        `<div class="n-select-row" data-testid="task-setting"><span class="n-select-label" id="n-task-label">This task</span>` +
        `<button type="button" class="b-select n-select" data-n="task-menu" aria-haspopup="menu" aria-expanded="false" aria-labelledby="n-task-label n-task-value"${shared && S.saving !== "task" ? "" : " disabled"}>` +
        `<span id="n-task-value">${S.saving === "task" ? "Saving…" : esc(taskValue(t.id, b.id))}</span>${icon("chevron")}</button></div>` +
        (S.error.task ? `<p class="b-field-error" data-testid="task-error">${S.error.task}</p>` : "") +
        (S.taskRoom ? `<p class="b-field-error" data-testid="task-room">There's no room for another task setting. Set a task back to "Same as bot" first. <button type="button" class="link-button" data-n="bot-page">${b.name}'s notifications</button></p>` : "") +
        (S.unconfirmed ? note(UNCONFIRMED_NOTE, "warn") : "") +
        kept("task", keptShared()) +
        `<p class="b-hint">${S.none ? NONE_HERE("This setting") : `On or Off wins over ${b.name}'s switch. This computer's switch, focus and quiet hours still apply.`}</p>` +
        (S.access === "read" ? `<div class="b-panel-foot">${accessBar(NEED)}</div>` : "")
      : `<p class="work-note">No task is open. Pick one of ${b.name}'s tasks to see its details.</p>`;
    $("#panel-settings").innerHTML = S.bview === "notifications" ? botPage(b) : botFrame(b);
    CT.hydrate($("#panel-details"));
    CT.hydrate($("#panel-settings"));
    setTab(S.tab);
  }

  function setTab(name, focus = false) {
    S.tab = name;
    $$("[data-tab]").forEach((tab) => {
      const on = tab.dataset.tab === name;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    });
    $$('.work-sections > [role="tabpanel"]').forEach((el) => (el.hidden = el.id !== `panel-${name}`));
  }

  // bots.md section 8's frame, with its one new row. The other rows are outlines here.
  function botFrame(b) {
    const row = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
    return (
      `<h3 class="b-tabgroup">About</h3><dl class="facts">${row("Description", '<span class="b-faint">None</span>')}${row("Instructions", "From AGENTS.md, 42 lines")}</dl>` +
      `<h3 class="b-tabgroup">Model</h3><dl class="facts">${row("Account", "OpenAI · Work")}</dl>` +
      `<h3 class="b-tabgroup">Tools</h3><dl class="facts">${row("Permissions", "Ask before running commands")}</dl>` +
      `<h3 class="b-tabgroup">Notifications</h3><dl class="facts"><div><button type="button" class="b-open" data-n="bot-page" data-testid="bot-notifications-row" aria-label="Notifications: ${esc(botValue(b.id))}. Open."><span>Notifications</span><span class="b-open-value">${esc(botValue(b.id))}</span>${icon("chevron")}</button></div></dl>` +
      `<h3 class="b-tabgroup">Runs on</h3><dl class="facts">${row("Machine", "Gateway host")}</dl>`
    );
  }

  function botPage(b) {
    const shared = canChangeShared();
    const own = b.tasks.filter((t) => ownOf(t.id));
    let html =
      `<div class="b-subhead"><button type="button" class="icon-button" data-variant="quiet" data-n="bot-back" aria-label="Back to settings">${icon("back")}</button><h3 tabindex="-1" data-n-focus>Notifications</h3></div>`;
    if (S.none) html += note(`<p>${NONE_HERE("This switch")}</p>`);
    else if (!S.master) html += note(`<p>Notifications are off on this computer.</p><div class="b-actions"><button type="button" class="link-button" data-n="settings">Settings</button></div>`);
    if (S.quietNow) html += note(`<p>${quietUntil()}</p>`);
    if (S.prefs === "reading") return html + `<div aria-busy="true" class="n-reading"><div class="skeleton" style="height:58px;width:100%"></div></div><p class="b-hint">Reading your settings from the gateway…</p>`;
    if (S.prefs === "readfail") return html + note(`<p>Couldn't read your notification settings from the gateway. Until Clawtrate can, it shows no notifications about your bots.</p><div class="b-actions"><button type="button" class="button" data-size="sm" data-n="retry-read">Try again</button></div>`, "danger");
    if (S.unconfirmed) html += note(UNCONFIRMED_NOTE, "warn");
    if (S.conflictNote) html += note(`<p>Changed on another of your devices a moment ago. This is what's set now.</p>`, "warn");
    html +=
      `<dl class="facts">` +
      switchRow(`bot-${b.id}`, `Notify me about ${b.name}`, savingLine(`bot-${b.id}`, `When ${b.name} finishes or waits for you.`), S.bots[b.id], `data-n-bot="${b.id}"${shared && S.saving !== `bot-${b.id}` ? "" : " disabled"}`, `${b.name}'s notifications`) +
      `</dl>` +
      kept("bot", keptShared()) +
      `<h4 class="b-group">Tasks with their own setting</h4>` +
      (own.length
        ? `<dl class="facts">${own.map((t) => `<div><dt>${esc(t.title)}</dt><dd>${ownOf(t.id) === "on" ? "On" : "Off"}</dd></div>`).join("")}</dl>`
        : `<p class="b-hint">No task has its own setting. Choose one in the task's Details.</p>`);
    if (S.access === "read") html += `<div class="b-panel-foot">${accessBar(NEED)}</div>`;
    return html;
  }

  // The task's menu (section 9).
  function openTaskMenu(button) {
    const t = findTask(S.sel.task).t;
    const b = bot(S.sel.bot);
    const current = ownOf(t.id) || "same";
    const items = [["same", `Same as ${b.name} (${S.bots[b.id] ? "on" : "off"})`], ["on", "On"], ["off", "Off"]];
    const menu = $("#n-menu");
    menu.innerHTML = items
      .map(([v, label]) => `<li role="none"><button type="button" class="menu-item" role="menuitemradio" aria-checked="${v === current}" data-n-task="${v}">${esc(label)}<span class="glyph" data-state="check"></span></button></li>`)
      .join("");
    const rect = button.getBoundingClientRect();
    const root = $("#root").getBoundingClientRect();
    menu.style.left = `${Math.max(8, rect.left - root.left)}px`;
    menu.style.top = `${rect.bottom - root.top + 4}px`;
    menu.style.minWidth = `${rect.width}px`;
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    menu.opener = button;
    $$("[data-n-task]", menu)[items.findIndex(([v]) => v === current)].focus();
  }
  function closeMenu(refocus = true) {
    const menu = $("#n-menu");
    if (menu.hidden) return;
    menu.hidden = true;
    menu.opener?.setAttribute("aria-expanded", "false");
    if (refocus) menu.opener?.focus();
  }

  // Saving your settings: written with a compare-and-set, then read back (section 2). Three outcomes
  // are told apart: confirmed, refused with the value read back, and unknown.
  let readSeq = 0;
  function saveShared(key, apply, lastRead, doneWords, where) {
    S.saving = key;
    delete S.error[key];
    S.conflictNote = false;
    repaint(where);
    const seq = ++readSeq;
    setTimeout(() => {
      if (seq !== readSeq) return; // an older read never overwrites a newer one
      S.saving = null;
      if (S.prefsFail === "savefail") {
        S.prefsFail = null;
        S.error[key] = `The gateway refused the change. ${lastRead.replace("were last read as", "are")}`;
        say(where, "The gateway refused the change");
      } else if (S.prefsFail === "unknown") {
        S.prefsFail = null;
        S.unconfirmed = true;
        S.pendingApply = apply;
        S.error[key] = `Couldn't confirm the change. ${lastRead}`;
        say(where, "Couldn't confirm the change");
      } else if (S.prefsFail === "conflict") {
        S.prefsFail = null;
        // Another device turned Pip off a moment before; that is what is read back.
        S.bots.pip = false;
        S.conflictNote = true;
        say(where, "Changed on another of your devices");
      } else {
        apply();
        repaint(where);
        say(where, doneWords());
        return;
      }
      repaint(where);
    }, 500);
  }
  function checkAgain() {
    // A fresh read shows the change had landed.
    S.unconfirmed = false;
    S.pendingApply?.();
    S.pendingApply = null;
    S.error = {};
    renderAll();
    renderRail();
    say(S.tab === "details" && S.panel ? "pane" : "settings", "Read from the gateway");
  }
  function repaint(where) {
    if (where === "pane") renderPanel();
    else renderSettings();
    renderRail();
  }

  function chooseTask(value) {
    const t = findTask(S.sel.task).t;
    const b = bot(S.sel.bot);
    closeMenu(false);
    S.taskRoom = false;
    // The exact proposed value is measured before the write; removing an entry cannot hit the limit.
    const next = { ...S.tasks };
    if (value === "same") delete next[taskKey(t.id)];
    else next[taskKey(t.id)] = value;
    if (value !== "same" && bytes(next) > LIMIT) {
      S.lastRefused = { value: next, bytes: bytes(next), before: bytes(S.tasks) };
      S.taskRoom = true;
      renderPanel();
      return $('[data-n="task-menu"]').focus();
    }
    const before = taskValue(t.id, b.id);
    saveShared(
      "task",
      () => {
        if (value === "same") delete S.tasks[taskKey(t.id)];
        else S.tasks[taskKey(t.id)] = value;
      },
      `This task was last read as ${before}.`,
      () => `This task: ${taskValue(t.id, b.id)}`,
      "pane",
    );
    requestAnimationFrame(() => $('[data-n="task-menu"]')?.focus());
  }

  // Settings, Notifications (section 7) -----------------------------------------------------------------

  const SECTIONS = [
    ["gateway", "Gateway", "packages/ui/src/Settings.tsx, setup.md"],
    ["gateways", "Your gateways", "settings.md, in review"],
    ["accounts", "Accounts", "bots.md §7"],
    ["integrations", "Integrations", "bots.md §15"],
    ["permissions", "Permissions", "controls.md §7"],
    ["memory", "Memory", "controls.md §13"],
    ["usage", "Usage", "controls.md §16"],
    ["machines", "Machines", "controls.md §15"],
    ["appearance", "Appearance", "settings.md, in review"],
    ["notifications", "Notifications", ""],
    ["system", "System", "settings.md, in review"],
    ["updates", "Updates", "settings.md, in review"],
  ];
  const AFTER = "Clawtrate can notify you after quiet hours if the item is still waiting and your settings allow it.";
  const heldCount = () => S.held.length + Object.keys(S.budgetHolds).length;
  // "Quiet until" comes from tonight's interval in the saved zone (section 6).
  const quietUntil = () => `Quiet until ${quietEnd()}.${heldCount() ? ` ${heldCount() === 1 ? "1 item is" : `${heldCount()} items are`} held. ${AFTER}` : ""}`;
  const RECEIVED = "Clawtrate shows desktop notifications for events it receives while running and connected. Missed events can appear in your tasks when it reconnects.";
  const SYSTEM_NOTE = {
    mac: `${RECEIVED} It shows them also with its window closed. It can't see whether macOS allows them or whether a Focus is on.`,
    windows: `${RECEIVED} Closing its window quits it. It can't see whether Windows allows them or whether Do Not Disturb is on.`,
    linux: `${RECEIVED} None is shown while its window is focused.`,
  };

  function openSettings(opener) {
    S.settingsOpener = opener || document.activeElement;
    S.sectionOpen = "notifications";
    S.settingsPane = "section";
    renderSettings();
    const dialog = $("#settings-dialog");
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => $("#b-section-title")?.focus());
  }

  function renderSettings() {
    const dialog = $("#settings-dialog");
    const active = document.activeElement;
    const activeKey = active && dialog.contains(active) ? active.dataset.n || active.dataset.nSet || active.dataset.nBot || active.id : null;
    const nav =
      `<nav class="b-nav" aria-label="Settings"><div class="b-nav-head"><h2 id="settings-title">Settings</h2>${closeButton()}</div>` +
      SECTIONS.map(([id, label]) => `<button type="button" class="b-nav-item" data-n-section="${id}"${id === S.sectionOpen ? ' aria-current="page"' : ""}>${label}${icon("chevron")}</button>`).join("") +
      `</nav>`;
    const section = S.sectionOpen === "notifications" ? notificationsSection() : otherSection();
    // The live region stays put across repaints, so what it announces is not lost.
    if (!$("#settings-live", dialog)) dialog.innerHTML = `<div class="n-settings-body" id="settings-body"></div><p class="visually-hidden" id="settings-live" aria-live="polite"></p>`;
    const holder = $("#settings-body", dialog);
    const scroll = $(".b-section-body", holder)?.scrollTop || 0;
    holder.innerHTML =
      `<div class="b-settings" data-pane="${S.settingsPane}">${nav}<section class="b-section" aria-labelledby="b-section-title">${closeButton()}` +
      `<header class="b-section-head"><button type="button" class="icon-button b-back" data-variant="quiet" data-n="to-nav" data-b="to-nav" aria-label="Back to settings">${icon("back")}</button><h3 id="b-section-title" tabindex="-1">${section.title}</h3></header>` +
      `<div class="b-section-body">${section.body}</div>${section.foot ? `<footer class="b-section-foot">${section.foot}</footer>` : ""}</section></div>`;
    const body = $(".b-section-body", holder);
    if (body) body.scrollTop = scroll;
    CT.hydrate(holder);
    if (activeKey) {
      const again = $(`[data-n="${activeKey}"], [data-n-set="${activeKey}"], [data-n-bot="${activeKey}"], #${CSS.escape(activeKey)}`, dialog);
      again?.focus();
    }
  }
  const closeButton = () => `<button type="button" class="icon-button b-close" data-variant="quiet" data-n="settings-close" aria-label="Close settings">${icon("x")}</button>`;
  function otherSection() {
    const [, label, where] = SECTIONS.find(([id]) => id === S.sectionOpen);
    return { title: label, body: `<p class="b-hint">This section is designed in ${where}. This page draws only Notifications.</p>` };
  }

  function notificationsSection() {
    const shared = canChangeShared();
    const dis = (key) => (shared && S.saving !== key ? "" : " disabled");
    let body = "";
    if (S.failedAt)
      body += note(
        `<p data-testid="failed-note">Clawtrate couldn't post a notification at ${S.failedAt}. Check your system's notification settings.</p><div class="b-actions"><button type="button" class="link-button" data-n="dismiss-failed">Dismiss</button></div>`,
        "warn",
      );
    if (S.granted) body += `<p class="b-hint" data-testid="granted">Access granted. You can change these now.</p>`;
    if (S.none)
      body +=
        `<h4 class="b-group">This computer</h4>` +
        note(
          `<p data-testid="none-note">This copy of Clawtrate can't show notifications on ${S.os === "windows" ? "Windows" : "macOS"}. What your bots finish or wait on shows in the rail and on ${S.os === "windows" ? "the taskbar button" : "the dock's badge"}.</p>` +
            (S.prefs === "device" ? "" : `<p>Quiet hours and your bots' switches below apply on your other devices.</p>`),
        );
    else {
      body +=
        `<h4 class="b-group">This computer</h4><dl class="facts">` +
        switchRow("master", "Show notifications", savingLine("master", S.master ? "When a bot finishes or waits for you." : "No notifications on this computer. Your other devices keep theirs."), S.master, `data-n-set="master"${S.saving === "master" ? " disabled" : ""}`, "Show notifications") +
        switchRow(
          "names",
          "Show bot names in notifications",
          savingLine("names", S.names ? "A bot's name can appear on a locked screen and can stay in your system's notification list." : `New notifications say "Clawtrate" and the kind of event. Previously posted names can stay in your system's notification list.`),
          S.names,
          `data-n-set="names"${S.saving === "names" ? " disabled" : ""}`,
          "Show bot names in notifications",
        ) +
        switchRow("budgetsw", "Budget warnings", savingLine("budgetsw", "When a bot has used 80% of a budget."), S.budgetsw, `data-n-set="budgetsw"${S.saving === "budgetsw" ? " disabled" : ""}`, "Budget warnings") +
        `</dl>` +
        kept("device", KEPT_DEVICE) +
        `<p class="b-hint" data-testid="system-note">${SYSTEM_NOTE[S.os]}</p>`;
    }
    if (S.unconfirmed) body += note(UNCONFIRMED_NOTE, "warn");
    if (S.conflictNote) body += note(`<p>Changed on another of your devices a moment ago. This is what's set now.</p>`, "warn");
    body += `<h4 class="b-group">Quiet hours</h4>`;
    if (S.prefs === "reading") body += `<div aria-busy="true" class="n-reading"><div class="skeleton" style="height:58px;width:100%"></div><div class="skeleton" style="height:120px;width:100%"></div></div><p class="b-hint" data-testid="reading">Reading your settings from the gateway…</p>`;
    else if (S.prefs === "readfail")
      body += note(`<p>Couldn't read your notification settings from the gateway. Until Clawtrate can, it shows no notifications about your bots.</p><div class="b-actions"><button type="button" class="button" data-size="sm" data-n="retry-read">Try again</button></div>`, "danger");
    else {
      body +=
        `<dl class="facts">` +
        switchRow("quiet", "Quiet hours", savingLine("quiet", `Clawtrate posts no new notifications during quiet hours. ${AFTER}`), S.quiet.enabled, `data-n-set="quiet"${dis("quiet")}`, "Quiet hours") +
        `</dl>`;
      if (S.quiet.enabled) {
        const elsewhere = S.prefs === "elsewhere";
        body +=
          `<div class="n-times" data-testid="quiet-times">` +
          `<label class="n-time"><small>From</small><input type="time" value="${S.quiet.from}" data-n-time="from" aria-label="Quiet hours from"${shared ? "" : " disabled"}${S.timeError ? ' aria-invalid="true" aria-describedby="n-time-error"' : ""} /></label>` +
          `<label class="n-time"><small>To</small><input type="time" value="${S.quiet.to}" data-n-time="to" aria-label="Quiet hours to"${shared ? "" : " disabled"}${S.timeError ? ' aria-invalid="true" aria-describedby="n-time-error"' : ""} /></label></div>` +
          (S.timeError ? `<p class="b-field-error" id="n-time-error" data-testid="time-error">Start and end can't be the same time.</p>` : "") +
          `<p class="b-hint" data-testid="zone-line">${
            elsewhere
              ? `${S.quiet.from} to ${S.quiet.to}, Lisbon time, where they were set. Tonight that's ${tonightHere()} here. Saving here sets them in Berlin time.`
              : `${S.quiet.from} to ${S.quiet.to}, Lisbon time. Set on this computer.`
          }</p>` +
          (S.quietNow ? `<p class="n-now" data-testid="quiet-now">${quietUntil()}</p>` : "");
      }
      body += kept("quiet", keptShared());
      body +=
        `<h4 class="b-group">Your bots</h4><dl class="facts">` +
        BOTS.map((b) => {
          const own = b.tasks.filter((t) => ownOf(t.id) && ownOf(t.id) !== (S.bots[b.id] ? "on" : "off")).length;
          const line = `${S.bots[b.id] ? "On" : "Off"}${own ? ` · ${own} task${own === 1 ? "" : "s"} ${S.bots[b.id] ? "off" : "on"}` : ""}`;
          return switchRow(`bot-${b.id}`, `<span class="n-botname"><span class="avatar" data-bot="${b.id}"></span>${b.name}</span>`, savingLine(`bot-${b.id}`, line), S.bots[b.id], `data-n-bot="${b.id}"${dis(`bot-${b.id}`)}`, `${b.name}'s notifications`);
        }).join("") +
        `</dl>` +

        kept("bots", keptShared());
    }
    const foot = S.access === "read" ? accessBar(NEED) : "";
    return { title: "Notifications", body, foot };
  }
  // Tonight's interval, converted from the saved zone (Lisbon) to this device's (Berlin).
  function tonightHere() {
    const { start, end } = continuousInterval(S.quiet.date, S.quiet.from, S.quiet.to, S.quiet.zone);
    const here = (ms) => localOf(ms, "Europe/Berlin").slice(11);
    return `${here(start)} to ${here(end)}`;
  }

  function toggleDevice(key) {
    const names = { master: "Notifications on this computer are", budgetsw: "Budget warnings are" };
    S.saving = key;
    renderSettings();
    setTimeout(() => {
      S.saving = null;
      S[key] = !S[key];
      renderSettings();
      renderPanel();
      say("settings", key === "names" ? (S.names ? "Bot names are shown in notifications" : "Bot names are hidden in notifications") : `${names[key]} ${S[key] ? "on" : "off"}`);
    }, 300);
  }

  const lastReadOf = (on) => (on ? "On" : "Off");
  const QUIET_ROOM = "There's no room to save quiet hours. Turn a bot's notifications back on first.";
  /** Measures the exact proposed shared value; on no room keeps the previous values and says so beneath the control. */
  function roomFor(key, proposed, words, where) {
    const size = bytes(proposed);
    if (size <= LIMIT) return true;
    S.lastRefused = { value: proposed, bytes: size, before: bytes(sharedValue(S.bots, S.quiet)) };
    S.error[key] = words;
    repaint(where);
    return false;
  }
  function toggleQuiet() {
    const next = !S.quiet.enabled;
    if (!roomFor("quiet", sharedValue(S.bots, { ...S.quiet, enabled: next, saved: true }), QUIET_ROOM, "settings")) return;
    saveShared("quiet", () => Object.assign(S.quiet, { enabled: next, saved: true }), `Quiet hours were last read as ${lastReadOf(S.quiet.enabled)}.`, () => (S.quiet.enabled ? `Quiet hours are on, ${S.quiet.from} to ${S.quiet.to}` : "Quiet hours are off"), "settings");
  }

  function toggleBot(id, where) {
    const b = bot(id);
    const next = !S.bots[id];
    // Turning a bot off adds an entry; the exact proposed value is measured first. Turning one on removes it.
    if (!next && !roomFor(`bot-${id}`, sharedValue({ ...S.bots, [id]: false }, S.quiet), "There's no room to save this switch with your quiet hours. Turn another bot back on first.", where)) return;
    saveShared(`bot-${id}`, () => (S.bots[id] = next), `${b.name}'s notifications were last read as ${lastReadOf(S.bots[id])}.`, () => `${b.name}'s notifications are ${S.bots[id] ? "on" : "off"}`, where);
  }

  function setTime(which, value) {
    const other = which === "from" ? S.quiet.to : S.quiet.from;
    if (value === other) {
      S.timeError = true;
      renderSettings();
      return;
    }
    S.timeError = false;
    if (!roomFor("quiet", sharedValue(S.bots, { ...S.quiet, [which]: value, saved: true }), QUIET_ROOM, "settings")) return;
    saveShared("quiet", () => Object.assign(S.quiet, { [which]: value, saved: true }), `Quiet hours were last read as ${S.quiet.from} to ${S.quiet.to}.`, () => `Quiet hours are on, ${S.quiet.from} to ${S.quiet.to}`, "settings");
  }

  // The prototype's bar -----------------------------------------------------------------------------------

  function bar() {
    const extra = $("#proto-extra");
    if (!extra) return;
    const opt = (v, l, cur) => `<option value="${v}"${v === cur ? " selected" : ""}>${l}</option>`;
    extra.innerHTML =
      `<span class="run-controls n-bar">` +
      `<label>This device <select data-bar="device">${opt("sender", "sent the message", S.device)}${opt("other", "another device", S.device)}${opt("read", "read-only", S.device)}${opt("admin", "admin or reviewer", S.device)}</select></label>` +
      `<label>Event <select data-bar="event">${Object.entries(EVENTS).map(([k, e]) => opt(k, e.label, "finished")).join("")}</select></label>` +
      `<button type="button" data-bar="fire">Happens</button>` +
      `<label>Focus <select data-bar="focus">${opt("", "none", S.focus || "")}${opt("otto", "Otto on screen", S.focus || "")}${opt("pip", "Pip on screen", S.focus || "")}</select></label>` +
      `<button type="button" data-bar="quiet" aria-pressed="${S.quietNow}">Quiet hours now</button>` +
      `<button type="button" data-bar="answered">Answered elsewhere</button>` +
      `<label>Budget at the end <select data-bar="budgetend">${BUDGET_END_FIXTURES.map((k) => opt(k, k, S.budgetEnd)).join("")}</select></label>` +
      `<button type="button" data-bar="quietend">Quiet hours end</button>` +
      `<button type="button" data-bar="wake">Wake after the end</button>` +
      `<button type="button" data-bar="drop">Drop connection</button>` +
      `<button type="button" data-bar="reconnect">Reconnect</button>` +
      `<label>At the click <select data-bar="click">${opt("", "all well", S.click)}${opt("unlisted", "not in the rail, found", S.click)}${opt("gone", "not found", S.click)}${opt("refused", "read refused", S.click)}${opt("botgone", "bot gone", S.click)}${opt("itemgone", "item gone", S.click)}${opt("offline", "connection down", S.click)}${opt("othergw", "another gateway", S.click)}${opt("stale", "no record", S.click)}</select></label>` +
      `<label>Owner <select data-bar="req">${opt("", "—", "")}${opt("granted", "approves", "")}${opt("denied", "denies", "")}${opt("expired", "lets it expire", "")}${opt("failed", "request fails", "")}</select></label>` +
      `<button type="button" data-bar="settings">Settings</button>` +
      `</span>`;
    extra.addEventListener("change", (event) => {
      const el = event.target;
      if (el.dataset.bar === "device") (S.device = el.value), render();
      if (el.dataset.bar === "focus") S.focus = el.value || null;
      if (el.dataset.bar === "click") S.click = el.value;
      if (el.dataset.bar === "budgetend") S.budgetEnd = el.value;
      if (el.dataset.bar === "req" && el.value) resolveReq(el.value);
    });
    extra.addEventListener("click", (event) => {
      const el = event.target.closest("[data-bar]");
      if (!el) return;
      if (el.dataset.bar === "fire") fire($('[data-bar="event"]', extra).value);
      if (el.dataset.bar === "quiet") {
        S.quietNow = !S.quietNow;
        if (S.quietNow) S.quiet.enabled = true;
        el.setAttribute("aria-pressed", String(S.quietNow));
      }
      if (el.dataset.bar === "quietend") quietEnds();
      if (el.dataset.bar === "wake") wakeAfterEnd();
      if (el.dataset.bar === "answered") answeredElsewhere();
      if (el.dataset.bar === "drop") dropConnection();
      if (el.dataset.bar === "reconnect") reconnect();
      if (el.dataset.bar === "settings") openSettings(el);
    });
  }

  // Events ----------------------------------------------------------------------------------------------

  document.addEventListener("click", (event) => {
    const t = event.target;
    const openPic = t.closest("[data-n-open]");
    if (openPic) return open(S.pics.find((x) => x.id === openPic.dataset.nOpen));
    const closePic = t.closest("[data-n-close]");
    if (closePic) {
      S.pics = S.pics.filter((x) => x.id !== closePic.dataset.nClose);
      return renderLayer();
    }
    if (!t.closest("#n-menu") && !t.closest('[data-n="task-menu"]')) closeMenu(false);
    const botRow = t.closest(".bot[data-bot]");
    if (botRow) {
      S.sel = { bot: botRow.dataset.bot, task: S.sel.bot === botRow.dataset.bot ? S.sel.task : null };
      S.bview = "main";
      return render();
    }
    const taskRow = t.closest(".task[data-task]");
    if (taskRow) {
      S.sel = { bot: taskRow.dataset.bot, task: taskRow.dataset.task };
      S.opened = null;
      findTask(taskRow.dataset.task).t.unread = false;
      // Opening a task withdraws its notification (section 3).
      S.pics = S.pics.filter((x) => x.ev.task !== taskRow.dataset.task);
      renderLayer();
      return render();
    }
    const tab = t.closest("[data-tab]");
    if (tab) return setTab(tab.dataset.tab, true);
    const section = t.closest("[data-n-section]");
    if (section) {
      S.sectionOpen = section.dataset.nSection;
      S.settingsPane = "section";
      renderSettings();
      return $("#b-section-title")?.focus();
    }
    const setBtn = t.closest("[data-n-set]");
    if (setBtn && !setBtn.disabled) return setBtn.dataset.nSet === "quiet" ? toggleQuiet() : toggleDevice(setBtn.dataset.nSet);
    const botSw = t.closest("[data-n-bot]");
    if (botSw && !botSw.disabled) return toggleBot(botSw.dataset.nBot, botSw.closest("#settings-dialog") ? "settings" : "pane");
    const taskChoice = t.closest("[data-n-task]");
    if (taskChoice) return chooseTask(taskChoice.dataset.nTask);
    const n = t.closest("[data-n]")?.dataset.n;
    if (!n) return;
    if (n === "settings") return openSettings(t.closest("[data-n]"));
    if (n === "settings-close") {
      $("#settings-dialog").close();
      return S.settingsOpener?.focus();
    }
    if (n === "to-nav") {
      S.settingsPane = "nav";
      renderSettings();
      return $(`[data-n-section="${S.sectionOpen}"]`)?.focus();
    }
    if (n === "panel") {
      S.panel = !S.panel;
      return render();
    }
    if (n === "panel-close") {
      S.panel = false;
      return render();
    }
    if (n === "back") {
      S.view = "list";
      return render();
    }
    if (n === "bot-page") {
      S.panel = true;
      S.tab = "settings";
      S.bview = "notifications";
      render();
      return requestAnimationFrame(() => $("[data-n-focus]")?.focus());
    }
    if (n === "bot-back") {
      S.bview = "main";
      renderPanel();
      return $('[data-n="bot-page"]')?.focus();
    }
    if (n === "task-menu") return $("#n-menu").hidden ? openTaskMenu(t.closest("[data-n]")) : closeMenu();
    if (n === "request") return askAccess();
    if (n === "check-again") return checkAgain();
    if (n === "dismiss-failed") {
      S.failedAt = null;
      return renderSettings();
    }
    if (n === "retry-read") {
      S.prefs = "ok";
      renderSettings();
      return renderPanel();
    }
    if (n === "gateways") {
      openSettings(t);
      S.sectionOpen = "gateways";
      return renderSettings();
    }
  });

  document.addEventListener("change", (event) => {
    const el = event.target.closest("[data-n-time]");
    if (el) setTime(el.dataset.nTime, el.value);
  });

  document.addEventListener("keydown", (event) => {
    const menu = $("#n-menu");
    if (!menu.hidden) {
      const items = $$("[data-n-task]", menu);
      const i = items.indexOf(document.activeElement);
      if (event.key === "ArrowDown") items[(i + 1) % items.length].focus(), event.preventDefault();
      if (event.key === "ArrowUp") items[(i - 1 + items.length) % items.length].focus(), event.preventDefault();
      if (event.key === "Escape") closeMenu(), event.preventDefault();
    }
    if ((event.metaKey || event.ctrlKey) && event.key === ",") {
      event.preventDefault();
      openSettings();
    }
  });

  // First paint -----------------------------------------------------------------------------------------

  const first = p("open");
  if (S.focus) S.sel = { bot: S.focus, task: bot(S.focus).tasks[0].id };
  if (S.conn === "down") setStrip({ tone: "warn", text: "Reconnecting in 4s", more: "showing saved messages" });
  render();
  renderLayer();
  // The prototype's bar is filled at DOMContentLoaded by prototype.js, whose listener comes first.
  document.addEventListener("DOMContentLoaded", bar);
  // click=unlisted|gone|refused: the target task is not in the rail's list (a filtered or partial list).
  if (["unlisted", "gone", "refused"].includes(S.click) && EVENTS[p("event")]?.task) findTask(EVENTS[p("event")].task).t.hidden = true;
  if (p("event")) fire(p("event"));
  // click=offline: the notification is shown while connected, then the connection drops.
  if (S.click === "offline") dropConnection();
  if (first === "settings") openSettings();
  if (first === "bot") {
    S.panel = true;
    S.tab = "settings";
    S.bview = "notifications";
    render();
  }
  if (first === "details") {
    S.sel = { bot: "otto", task: "o3" };
    S.panel = true;
    S.tab = "details";
    render();
  }
  window.notif = { S, fire, decide, open, quietEnds, wakeAfterEnd, answeredElsewhere, dropConnection, reconnect, quietInterval, continuousInterval, nativeTitle, sharedValue, resolveReq, bytes, LIMIT };
})();
