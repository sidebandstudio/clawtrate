// Group chats, as docs/design/group-chats.md specifies them. No gateway and no
// network: a small local model plays what the gateway answers, with the
// answers the research recorded (docs/research/group-chats.md).
//
// Two halves. `gw` stands in for the gateway: each group's saved record, each
// member task's identity and history, and the journals of what was sent to it
// (record writes and reads, task writes, guarded sends, aborts), which the
// check reads. Each group's own client state (its column, its runs, what this
// connection knows of each member task) is kept on the group, and every result
// is applied to the group and task it came from, whichever group is open.
// The address picks a state; section 16 of the design lists them.

(function () {
  const CT = window.CT;
  const params = CT.params;
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const esc = CT.esc;
  const icon = (name, cls) => CT.icon(name, cls);
  const later = (ms, fn) => setTimeout(fn, ms);
  const clone = (x) => JSON.parse(JSON.stringify(x));

  // Three more bots, so that a group of six can be chosen, and a second bot called Otto.
  Object.assign(CT.bots, {
    extra1: { name: "Ottoline", label: "Errands" },
    extra2: { name: "Ivy May", label: "Garden" },
    extra3: { name: "Basil", label: "Kitchen" },
    extra4: { name: "Otto", label: "Garage" },
  });
  const ALL = ["juniper", "otto", "marlow", "pip", "extra1", "extra2", "extra3"];
  const nm = (id) => CT.bots[id].name;
  const ME = "Robin"; // the person's display name, from users.self
  const list = (names) =>
    names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const possessive = (names) => list(names.map((n) => `${n}'s`));
  const touch = () => document.documentElement.dataset.input === "touch";
  const announce = (text) => CT.announce(text);
  const time = (at) => (at >= 0 ? `5:${String(at).padStart(2, "0")} PM` : "Mon");
  const state0 = params.get("state") || "open";
  const fail = new Set((params.get("fail") || "").split(",").filter(Boolean));
  let ids = 0;
  const nid = (p) => `${p}${++ids}`;
  let clock = 1000; // the gateway's clock, in the fixture's own units
  const tick = (n = 1) => (clock += n);

  // The gateway ---------------------------------------------------------------------------

  const journal = (window.__groupJournal = { recordWrites: [], recordReads: 0, taskWrites: [], sends: [], aborts: [], targets: [] });
  const gw = {
    records: {}, // group id -> { name, members: [{ bot, sid }] }
    tasks: {}, // `${group}:${bot}` -> { sid, state: "ok" | "archived" | "gone" | "botgone", hasMore, log }
  };
  const taskOf = (gid, bot) => gw.tasks[`${gid}:${bot}`];
  const sidFor = (bot) => `s-${bot}-${++ids}`;

  // One read of a record: the saved value, null when absent, or "unreadable".
  function readRecord(gid) {
    journal.recordReads += 1;
    if (fail.delete("readonce")) return "unreadable";
    return gw.records[gid] ? clone(gw.records[gid]) : null;
  }
  // One compare-and-set write, and its answer.
  function writeRecord(gid, next, expected) {
    journal.recordWrites.push({ gid, next: clone(next) });
    const now = gw.records[gid] || null;
    if (JSON.stringify(now) !== JSON.stringify(expected)) return "conflict";
    if (fail.delete("refuse")) return "refused";
    if (fail.delete("timeout")) return "timeout"; // not applied, and no answer
    if (next === null) delete gw.records[gid];
    else gw.records[gid] = clone(next);
    if (fail.delete("lostread")) fail.add("readonce"); // applied, and the read that follows is lost
    return "ok";
  }
  const sameRecord = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Fixtures ------------------------------------------------------------------------------

  const groups = [];
  function addGroup(id, name, members, at) {
    const g = { id, name, members: members.map((bot) => ({ bot, sid: sidFor(bot) })), at, items: [], runs: {}, member: {}, notices: [] };
    gw.records[id] = { name, members: clone(g.members) };
    for (const x of g.members) gw.tasks[`${id}:${x.bot}`] = { sid: x.sid, state: "ok", hasMore: false, log: [] };
    groups.push(g);
    return g;
  }
  const memberBots = (g) => g.members.map((x) => x.bot);
  const who = (g, b) => (memberBots(g).filter((x) => nm(x) === nm(b)).length > 1 ? `${nm(b)} (${CT.bots[b].label})` : nm(b));

  const weekendMembers =
    state0 === "samename" ? ["juniper", "otto", "extra4", "extra1", "extra2"] : state0 === "five" ? ["juniper", "otto", "marlow", "pip", "extra1"] : ["juniper", "otto", "marlow"];
  const weekend = state0 === "removed" ? null : addGroup("g1", "Weekend plans", weekendMembers, 41);
  const dinner = addGroup("g2", "Dinner plans", ["pip", "juniper"], params.get("dinner") === "recent" ? 50 : 35);
  const bots = { juniper: 39, otto: 30, marlow: 25, pip: -1 };

  // A saved row of a member task's history, and a message this device sent this session.
  const saved = (bot, text, extra = {}) => ({ kind: "bot", id: nid("b"), task: bot, text, ts: tick(), seq: ++ids, ...extra });
  const savedYou = (text, bs, extra = {}) => ({ kind: "you", id: nid("y"), text, copies: Object.fromEntries(bs.map((b) => [b, "saved"])), ts: tick(), seq: ++ids, task: bs[0], ...extra });
  const localYou = (text, copies, extra = {}) => ({ kind: "you", id: nid("y"), text, copies, local: true, ts: tick(), seq: ++ids, task: Object.keys(copies)[0], ...extra });
  const note = (html) => ({ kind: "note", id: nid("n"), html, ts: tick(), seq: ++ids });

  // Runs: { id, bot, owner: "this" | "other", state, phrase, elapsed, phase, queued, hold, partial }.
  function addRun(g, bot, owner, state, phrase, elapsed, extra = {}) {
    const id = extra.id || nid("r");
    g.runs[id] = { id, bot, owner, state, phrase, elapsed, hold: true, ...extra };
    return g.runs[id];
  }
  // A card: one request, keyed by task, run and request id.
  function addCard(g, kind, bot, run, request, extra = {}) {
    const id = `g-${kind}-${request}`;
    g.items.push({ kind, id, task: bot, run, request, ts: tick(), seq: ++ids, ...extra });
    return id;
  }

  const QUESTIONS = {
    cache: CT.samples.question,
    route: { title: "Which route should I plan for Saturday?", options: [["Lake loop", "3 miles, mostly flat"], ["Ridge trail", "6 miles, one steep climb"], ["Town walk"]] },
    downloads: { title: "Should I also clear the downloads folder?", options: [["Yes", "It holds 12 GB of finished downloads"], ["No"]] },
  };

  const m = {
    tier: state0 === "readonly" ? "read" : "write",
    device: state0 === "other" ? "other" : "this",
    offline: state0 === "offline",
    group: weekend,
    view: params.get("bot") ? { bot: params.get("bot") } : weekend ? { group: "g1" } : { removed: true },
    draft: "",
    reply: null,
    bindings: [], // { occ, word, bot }: one list choice for one mention occurrence in this draft
    mentionOpen: false,
    access: "read",
    stageNote: state0 === "removed" ? "Removed Weekend plans. Juniper's, Otto's and Marlow's tasks stay in their lists." : "",
    follow: true,
    stopfail: new Set((params.get("stopfail") || "").split(",").filter(Boolean)),
  };

  function seedWeekend(g) {
    const ms = memberBots(g);
    if (state0 === "empty") return;
    const third = ms[2];
    g.items.push(savedYou("Plan Saturday for us: the trail in the morning, errands after lunch.", ms));
    g.items.push(
      saved(third, third === "marlow" ? "I'll draft a short note for the neighbours about borrowing the trailer.\n@Otto, can you print it?" : "The garage door is fixed, so the bikes can come out."),
      saved("juniper", "The forecast is clear until 2 PM, so start the trail by 8. The trail map is at https://maps.example/trail."),
      { kind: "tool", id: nid("t"), task: "otto", title: "Read backup-2026-11-15.log", ts: tick(), seq: ++ids },
      saved("otto", "Done. The old cache folder is gone, so the media box has room for the trail photos."),
    );
    taskOf(g.id, "otto").hasMore = true; // Otto's task has more than the page loaded
    if (state0 === "partial") {
      g.items.push(localYou("Can each of you add one thing to bring?", { juniper: "sent", otto: "sent", marlow: "failed" }, { open: true, why: { marlow: "Session … is archived. Restore it before starting new work." } }));
      g.items.push(saved("juniper", "Water and the paper map."), saved("otto", "A charged battery pack."));
    }
    if (state0 === "changed") g.items.push(localYou("Can each of you add one thing to bring?", { juniper: "sent", otto: "sent", marlow: "changed" }, { open: true }));
    if (state0 === "offline") g.items.push(localYou("Bring sunscreen too.", Object.fromEntries(ms.map((b) => [b, "held-offline"])), { held: true }));
    if (state0 === "tie") {
      // Three rows saved with one time: two in Otto's task, one in Juniper's. They arrive in another order.
      const t = tick();
      for (const r of [saved("otto", "Second note from Otto.", { ts: t, seq: 6 }), saved("juniper", "A note from Juniper.", { ts: t, seq: 3 }), saved("otto", "First note from Otto.", { ts: t, seq: 5 })]) g.items.push({ ...r, arriving: true });
    }
  }

  if (weekend) {
    seedWeekend(weekend);
    const mark = (bot, st) => {
      weekend.member[bot] = st;
      const t = taskOf("g1", bot);
      if (st === "archived") t.state = "archived";
      if (st === "taskgone") t.state = "gone";
      if (st === "botgone") t.state = "botgone";
      if (st === "changed-receipt" || st === "replaced") t.sid = sidFor(bot);
    };
    if (["archived", "taskgone", "botgone", "replaced"].includes(state0)) mark("marlow", state0);
    if (state0 === "changed") mark("marlow", "changed-receipt");
    if (state0 === "partial") mark("marlow", "archived");
    if (state0 === "running" || state0 === "twodevices") {
      weekend.items.push(localYou("Check the trail closures and the media box before we go.", { juniper: "sent", otto: "sent" }));
      addRun(weekend, "juniper", "this", "working", "Searching the web for trail closures", "0:08", { id: "r-juniper-5b70e1d4" });
      addRun(weekend, "otto", state0 === "twodevices" ? "other" : "this", "working", "Reading backup-2026-11-15.log", "0:12", { id: "r-otto-a36bfcc7" });
    }
    if (state0 === "queuedturn") {
      weekend.items.push(localYou("@Otto check the media box before we go.", { otto: "sent" }));
      addRun(weekend, "otto", "this", "working", "Reading backup-2026-11-15.log", "0:12", { id: "r-otto-a36bfcc7" });
      // A later turn from another device, which the gateway queued in Otto's task (its pendingInputs).
      addRun(weekend, "otto", "other", "idle", "Queued by the gateway", "", { id: "r-otto-4e49a294", queued: true, text: "@Otto also check the trail camera.", reply: "The trail camera has 40 new pictures; the card is half full." });
    }
    if (["approval", "both", "other", "readonly", "twoapprovals"].includes(state0)) {
      weekend.items.push(localYou("@Otto is the media box disk still filling up?", { otto: "sent" }));
      addRun(weekend, "otto", state0 === "other" ? "other" : "this", "waiting", "Waiting for you", "0:21", { id: "r-otto-a36bfcc7", phase: "waiting-approval" });
      // This connection receives the card only where it is the bound reviewer.
      if (state0 !== "other" && state0 !== "readonly") addCard(weekend, "approval", "otto", "a36bfcc7", "5e1d0c2a");
    }
    if (state0 === "twoapprovals") {
      weekend.items.push(localYou("@Marlow can you print the note?", { marlow: "sent" }));
      addRun(weekend, "marlow", "this", "waiting", "Waiting for you", "0:09", { id: "r-marlow-7d21e0aa", phase: "waiting-approval" });
      addCard(weekend, "approval", "marlow", "7d21e0aa", "9b44f1c3");
    }
    if (state0 === "both" || state0 === "other") {
      weekend.items.push(localYou("@Juniper which route for Saturday?", { juniper: "sent" }));
      addRun(weekend, "juniper", state0 === "other" ? "other" : "this", "waiting", "Waiting for you", "0:18", { id: "r-juniper-f9adc2f3" });
      addCard(weekend, "question", "juniper", "f9adc2f3", "ask_route", { q: "route" });
    }
    if (state0 === "question" || state0 === "twoquestions") {
      weekend.items.push(localYou("@Otto should I clear the scratch cache before Saturday?", { otto: "sent" }));
      addRun(weekend, "otto", "this", "waiting", "Waiting for you", "0:30", { id: "r-otto-c51e0a77" });
      addCard(weekend, "question", "otto", "c51e0a77", "ask_cache", { q: "cache" });
      if (state0 === "twoquestions") addCard(weekend, "question", "otto", "c51e0a77", "ask_downloads", { q: "downloads" });
    }
    if (state0 === "other" || state0 === "readonly") {
      // Another connection reads the column from the task histories: it has no local knowledge.
      for (const item of weekend.items) if (item.kind === "you" && item.local) item.local = false;
    }
    for (const item of weekend.items) if (item.kind === "you" && !item.local) for (const b of Object.keys(item.copies)) item.copies[b] = "saved";
  }
  dinner.items.push(savedYou("Dinner on Thursday: something quick with what's in the fridge.", ["pip", "juniper"]), saved("pip", "Pasta with the spinach and the last of the feta."), saved("juniper", "Twenty minutes, if the water is on first."));
  // Every member task keeps its own history: what was sent to it and what it said.
  for (const g of groups)
    for (const it of g.items) {
      if (it.kind === "bot") taskOf(g.id, it.task).log.push({ role: "assistant", text: it.text });
      if (it.kind === "you") for (const b of Object.keys(it.copies)) if (["saved", "sent", "steer"].includes(it.copies[b])) taskOf(g.id, b)?.log.push({ role: "user", text: it.text });
    }

  // Reading ------------------------------------------------------------------------------

  const readable = (g, bot) => {
    const t = taskOf(g.id, bot);
    return memberBots(g).includes(bot) && !!t && t.state !== "gone" && t.state !== "botgone";
  };
  const eligible = (g) => memberBots(g).filter((b) => !g.member[b]);
  const activeRuns = (g) => Object.values(g.runs).filter((r) => memberBots(g).includes(r.bot));
  const receivedCard = (g, item) => item.kind === "question" ? m.tier === "write" : m.tier === "write" && m.device === "this";
  const pendingCards = (g) => g.items.filter((i) => (i.kind === "approval" || i.kind === "question") && !i.done && memberBots(g).includes(i.task) && receivedCard(g, i));
  const questionPending = (g, bot) => g.items.some((i) => i.kind === "question" && i.task === bot && !i.done);

  // What the column shows: only rows of current, readable member tasks, saved messages only
  // where a current member's history holds a copy, and this device's own outbox.
  function visibleItems(g) {
    const order = (b) => memberBots(g).indexOf(b);
    const rows = g.items.filter((it) => {
      if (it.kind === "you") return it.local ? Object.keys(it.copies).some((b) => memberBots(g).includes(b) || it.removed?.includes(b)) : Object.keys(it.copies).some((b) => readable(g, b));
      if (it.kind === "note") return true;
      return readable(g, it.task);
    });
    const settled = rows.filter((r) => !r.arriving).sort((a, b) => a.ts - b.ts || order(a.task) - order(b.task) || a.seq - b.seq);
    return settled.concat(rows.filter((r) => r.arriving));
  }

  // The rail ----------------------------------------------------------------------------------

  const stack = (bs, badge = "") => {
    const shown = bs.length > 4 ? bs.slice(0, 3) : bs;
    const more = bs.length > 4 ? `<span class="g-more">+${bs.length - 3}</span>` : "";
    return (
      `<span class="g-stack" data-count="${Math.min(bs.length, 4)}" aria-hidden="true">` +
      shown.map((b) => `<span class="avatar">${CT.character(b)}</span>`).join("") +
      more +
      (badge ? CT.glyph(badge) : "") +
      `</span>`
    );
  };

  function groupLine(g) {
    const waiting = pendingCards(g);
    const whoWaits = [...new Set(waiting.map((c) => c.task))];
    if (whoWaits.length === 1)
      return { text: `Waiting for you: ${nm(whoWaits[0])}, ${waiting[0].kind === "approval" ? "approve a command" : "a question"}`, tone: "waiting", badge: "waiting", state: "waiting for you" };
    if (whoWaits.length > 1) return { text: `Waiting for you: ${list(whoWaits.map(nm))}`, tone: "waiting", badge: "waiting", state: "waiting for you" };
    const working = [...new Set(activeRuns(g).filter((r) => !r.queued).map((r) => r.bot))];
    if (working.length) return { text: `${list(working.map(nm))} ${working.length > 1 ? "are" : "is"} working`, tone: "working", badge: "", state: "working" };
    const last = [...visibleItems(g)].reverse().find((i) => i.kind === "you" || i.kind === "bot");
    if (!last) return { text: "No messages yet", tone: "", badge: "", state: "idle" };
    return { text: `${last.kind === "you" ? "You" : nm(last.task)}: ${last.text}`, tone: "", badge: "", state: "idle" };
  }

  function renderRail() {
    const rows = [];
    for (const g of groups) {
      const line = groupLine(g);
      rows.push({
        at: g.at,
        html:
          `<li class="bot-group"><button type="button" class="bot" data-group="${g.id}" aria-current="${m.view.group === g.id}" aria-haspopup="menu"` +
          ` aria-label="${esc(`${g.name}, group of ${g.members.length}: ${list(memberBots(g).map((b) => who(g, b)))}, ${line.state}`)}">` +
          stack(memberBots(g), line.badge) +
          `<span class="bot-text"><span class="bot-line"><span class="bot-name">${esc(g.name)}</span><time class="bot-time">${line.state === "idle" ? time(g.at) : "now"}</time></span>` +
          `<span class="bot-line"><span class="bot-preview" data-state="${line.tone}">${esc(line.text)}</span></span></span></button></li>`,
      });
    }
    for (const id of ["juniper", "otto", "marlow", "pip"]) {
      const t = gw.tasks[`g1:${id}`];
      if (t?.state === "botgone") continue; // a deleted bot is not listed
      const open = m.view.bot === id;
      const inGroup = weekend && groups.includes(weekend) && memberBots(weekend).includes(id);
      const tasks = open
        ? `<ul class="task-list" aria-label="${nm(id)}'s tasks">` +
          (t && t.state !== "gone"
            ? `<li><button type="button" class="task" data-member-task="${id}" aria-current="true" aria-label="${esc(`Plan Saturday for us, 5:41 PM${inGroup ? `, in the group ${weekend.name}` : ""}`)}">` +
              `<span class="task-title">Plan Saturday for us</span><time class="task-time">5:41 PM</time>${inGroup ? icon("helpers", "icon g-task-mark") : ""}</button></li>`
            : "") +
          `<li><button type="button" class="task" data-elsewhere="task"><span class="task-title">Earlier tasks</span><time class="task-time">Mon</time></button></li></ul>`
        : "";
      rows.push({
        at: bots[id],
        html:
          `<li class="bot-group"${open ? ' data-open="true"' : ""}><button type="button" class="bot" data-bot-row="${id}" aria-current="false" aria-label="${nm(id)}, idle">` +
          `<span class="avatar">${CT.character(id)}</span>` +
          `<span class="bot-text"><span class="bot-line"><span class="bot-name">${nm(id)}</span><time class="bot-time">${time(bots[id])}</time></span>` +
          `<span class="bot-line"><span class="bot-preview">${esc(CT.bots[id].label)}</span></span></span></button>${tasks}</li>`,
      });
    }
    $("#bot-list").innerHTML = rows.sort((a, b) => b.at - a.at).map((r) => r.html).join("");
    $("#new-button").hidden = m.tier === "read";
  }

  // Receipts ------------------------------------------------------------------------------

  const COPY = {
    sending: (n) => `Sending to ${n}…`,
    accepted: (n) => `Accepted by the gateway for ${n}`,
    sent: (n) => `Sent to ${n}`,
    steer: (n) => `Steer for ${n}`,
    gqueued: (n) => `Queued by the gateway for ${n}`,
    held: (n) => `Held until you answer ${n}`,
    queued: (n) => `Queued on this device for ${n}`,
    "held-offline": (n) => `Sends when reconnected to ${n}`,
    failed: (n) => `Couldn't send to ${n}`,
    changed: (n) => `Accepted in a new task for ${n}`,
    notsent: (n) => `Not sent to ${n}`,
  };
  const ROW = {
    sending: "Sending…",
    accepted: "Accepted by the gateway; not yet in its task.",
    sent: "Sent: in its task.",
    steer: "Steer: joined its running turn.",
    gqueued: "Queued by the gateway: listed as a pending input.",
    held: "Held on this device until you answer its question.",
    queued: "Queued on this device until its run stops.",
    "held-offline": "Held on this device until the connection returns.",
    failed: "Couldn't send.",
    changed: "The gateway accepted this copy in the new task.",
    notsent: "Not sent.",
  };
  const ORDER = Object.keys(COPY);
  const shownCopies = (g, item) => Object.entries(item.copies).filter(([bot]) => memberBots(g).includes(bot) || item.removed?.includes(bot));

  function wentWords(g, item) {
    if (item.held) return "Sends when reconnected";
    if (!item.local) {
      const found = Object.keys(item.copies).filter((b) => readable(g, b)).map((b) => who(g, b));
      return `In ${possessive(found)} task ${found.length > 1 ? "histories" : "history"}`;
    }
    const by = {};
    for (const [bot, st] of shownCopies(g, item)) (by[st] ||= []).push(who(g, bot));
    return ORDER.filter((s) => by[s]).map((s) => COPY[s](list(by[s]))).join(" · ");
  }

  function wentLine(g, item) {
    const words = wentWords(g, item);
    if (item.held || !item.local) return `<div class="g-went"><span class="msg-caption">${esc(words)}</span></div>`;
    const rows = shownCopies(g, item)
      .map(([bot, st]) => {
        const name = who(g, bot);
        let why = "";
        if (st === "failed") {
          why = ` The gateway answered: ${esc(item.why?.[bot] || "")}`;
          if (!g.member[bot] && m.tier === "write") why += ` ${CT.linkButton(`Resend to ${name}`, { attrs: `data-resend="${item.id}:${bot}"` })}`;
        }
        if (st === "notsent" && item.removed?.includes(bot)) why = ` ${esc(name)} is no longer in this group.`;
        if (st === "notsent" && item.whyNot?.[bot]) why = ` ${esc(item.whyNot[bot])}`;
        return `<li><b>${esc(name)}</b>: ${ROW[st]}${why}</li>`;
      })
      .join("");
    const by = {};
    for (const [bot, st] of shownCopies(g, item)) (by[st] ||= []).push(who(g, bot));
    const parts = ORDER.filter((s) => by[s]).map((s) => `<span${s === "failed" || s === "notsent" ? ' data-tone="danger"' : ""}>${esc(COPY[s](list(by[s])))}</span>`);
    return `<div class="g-went"><button type="button" data-went="${item.id}" aria-expanded="${!!item.open}">${parts.join(" · ")}</button>` + (item.open ? `<ul>${rows}</ul>` : "") + `</div>`;
  }

  // Member lines ------------------------------------------------------------------------

  const canRemoveMember = (g) => g.members.length > 2;
  function memberActions(g, bot, first) {
    if (m.tier !== "write") return "";
    // At two members every entry point offers the same choices: a replacement, or removing the group.
    const rest = canRemoveMember(g) ? CT.button(`Remove ${esc(nm(bot))}`, `data-remove-member="${bot}"`) : CT.button("Add a bot", 'data-add="1"') + CT.button("Remove group…", 'data-remove-group="1"');
    return (first || "") + rest;
  }
  function memberLine(g, bot) {
    const s = g.member[bot];
    const name = nm(bot);
    if (!s) return "";
    const text = {
      archived: `${name}'s task in this group is archived. Messages to everyone skip ${name}.`,
      taskgone: `${name}'s task in this group was deleted. Messages to everyone skip ${name}.`,
      botgone: `${name} was deleted, with its tasks. Messages to everyone skip ${name}.`,
      changed: `${name}'s task changed during the send. Messages to everyone skip ${name} until you choose.`,
      "changed-receipt": `${name}'s task changed during the send. The gateway accepted this copy in the new task. Messages to everyone skip ${name} until you choose.`,
      replaced: `${name}'s task was replaced: a new task is at its place. Messages to everyone skip ${name} until you choose.`,
      restoring: `Restoring ${name}'s task…`,
      starting: `Starting a new task for ${name}…`,
    }[s];
    const actions =
      s === "archived"
        ? memberActions(g, bot, CT.button(`Restore ${esc(name)}'s task`, `data-restore="${bot}"`))
        : s === "taskgone"
          ? memberActions(g, bot, CT.button(`Start a new task for ${esc(name)}`, `data-newtask="${bot}"`))
          : ["changed", "changed-receipt", "replaced"].includes(s)
            ? memberActions(g, bot, CT.button("Use the current task", `data-adopt="${bot}"`))
            : s === "botgone"
              ? memberActions(g, bot)
              : "";
    return `<div class="g-line" data-member-line="${bot}"${s === "restoring" || s === "starting" ? ' aria-busy="true"' : ""}><span>${esc(text)}</span>${actions}</div>`;
  }

  // The column ------------------------------------------------------------------------------

  const approvalFor = (bot) =>
    bot === "marlow"
      ? { summary: "Print the note on <b>the office printer</b>.", line: "Print the note", command: "lp note.txt" }
      : { summary: "List the files in <b>Otto's workspace</b> on <b>media-box</b>.", line: "List the files in Otto's workspace", command: "ls" };

  function cardHtml(item) {
    if (item.html) return item.html;
    const bot = item.task;
    if (item.kind === "approval") {
      const a = approvalFor(bot);
      return CT.approval({
        id: item.id,
        bot,
        summary: a.summary,
        line: a.line,
        asker: { line: `In ${nm(bot)}'s task in this group, run ${item.run}.` },
        full: { reason: `${nm(bot)} asked for this.`, command: a.command, fields: [["Runs on", "media-box"], ["Asked by", nm(bot)], ["Run", item.run]] },
        request: { command: a.command, cwd: "~/workspace", host: "media-box", agent: nm(bot) },
        raw: CT.samples.approvalRaw(),
      });
    }
    return `<p class="g-hint" data-card-label="${item.id}">In ${esc(nm(bot))}'s task in this group, run ${esc(item.run)}.</p>` + CT.question({ id: item.id, bot, ...QUESTIONS[item.q], raw: CT.samples.questionRaw() });
  }

  function renderColumn() {
    const el = $("#transcript");
    const g = m.group;
    $(".conversation").classList.toggle("g-column", !!(g && m.view.group));
    if (m.view.removed || !g) {
      el.innerHTML = `<div class="transcript-inner"><p class="g-stage-note" role="status">${esc(m.stageNote || "No group is open.")}</p></div>`;
      return;
    }
    if (m.view.bot) return renderMemberTask(el);
    // Keep the same visible text at the reading line, unless the reader follows the end.
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    const anchor = !m.follow && !atEnd ? readingAnchor(el) : null;
    for (const it of g.items)
      if ((it.kind === "approval" || it.kind === "question") && !it.html) {
        const live = $(`#${it.id}`);
        if (live && live.dataset.state && live.dataset.state !== "pending") it.html = (live.closest("[data-anchor]") ? live : live).outerHTML;
      }
    const first = "Clawtrate sends each bot a separate copy. It doesn't pass bot replies between tasks.";
    const items = visibleItems(g);
    const partial = memberBots(g).some((b) => readable(g, b) && taskOf(g.id, b).hasMore);
    const body = [];
    if (!items.length) {
      body.push(`<div class="g-empty">${stack(memberBots(g))}<h1>${esc(g.name)}</h1><p>${esc(first)}</p><p>Write to everyone, or start with @ to choose who answers.</p></div>`);
    } else {
      if (partial) body.push(`<p class="g-first" data-history="partial">Showing recent history for ${esc(list(memberBots(g).map((b) => who(g, b))))}</p>`);
      body.push(`<p class="g-first">${esc(first)}</p>`, CT.stamp("Today 5:36 PM"));
      items.forEach((item, i) => {
        const prev = items[i - 1];
        const next = items[i + 1];
        const speaker = (bot) => `<p class="g-speaker" aria-hidden="true">${esc(who(g, bot))}</p>`;
        if (item.kind === "you") {
          body.push(
            `<div class="turn" data-role="user" data-anchor="${item.id}"${item.held ? ' data-waiting="true"' : ""}>` +
              `<div class="msg" data-role="user" role="group" aria-label="${esc(`You said: ${item.text}${/[.!?]$/.test(item.text) ? "" : "."} ${wentWords(g, item)}.`)}"><div class="bubble">${esc(item.text)}</div></div>` +
              wentLine(g, item) +
              `</div>`,
          );
        } else if (item.kind === "bot") {
          const firstOfRun = !(prev && (prev.kind === "bot" || prev.kind === "tool") && prev.task === item.task);
          const lastOfRun = !(next && next.kind === "bot" && next.task === item.task);
          body.push(
            (firstOfRun ? speaker(item.task) : "") +
              `<div class="g-said" data-said="${item.id}" data-anchor="${item.id}"><span class="g-foot">${lastOfRun ? `<span class="avatar" aria-hidden="true">${CT.character(item.task)}</span>` : ""}</span>` +
              `<div class="msg" data-role="assistant" role="group" aria-label="${esc(`${who(g, item.task)} said: ${item.text}`)}"><div class="bubble">${esc(item.text)}</div></div>` +
              (m.tier === "write"
                ? `<button type="button" class="icon-button" data-msg-menu="${item.id}" aria-haspopup="menu" aria-expanded="false" aria-label="More for ${esc(who(g, item.task))}'s message">${icon("more")}</button>`
                : "") +
              `</div>`,
          );
        } else if (item.kind === "tool") {
          body.push((prev && (prev.kind === "bot" || prev.kind === "tool") && prev.task === item.task ? "" : speaker(item.task)) + `<ul class="g-steps" data-anchor="${item.id}">${CT.step({ id: item.id, kind: "read", status: "done", title: item.title })}</ul>`);
        } else if (item.kind === "approval" || item.kind === "question") {
          // A card this connection did not receive or read back is not drawn.
          if (!receivedCard(g, item)) return;
          body.push(speaker(item.task) + `<div data-anchor="${item.id}">${cardHtml(item)}</div>`);
        } else if (item.kind === "note") {
          body.push(`<div data-anchor="${item.id}">${CT.turnNote({ lead: CT.glyph("stopped"), html: item.html })}</div>`);
        }
      });
    }
    for (const b of memberBots(g)) body.push(memberLine(g, b));
    // A confirmed waiting-approval with no card on this connection.
    const runs = activeRuns(g).sort((a, b) => memberBots(g).indexOf(a.bot) - memberBots(g).indexOf(b.bot));
    const hasCard = (r) => g.items.some((i) => i.kind === "approval" && !i.done && r.id.endsWith(i.run) && receivedCard(g, i));
    const hidden = runs.filter((r) => r.phase === "waiting-approval" && !hasCard(r));
    for (const r of hidden) body.push(`<div class="g-line" data-member-line="${r.bot}-wait" data-run="${r.id}"><span>${nm(r.bot)} is waiting for approval. This connection has no approval card for this run.</span></div>`);
    const lines = runs.map(
      (r) =>
        `<div data-run="${r.id}">` +
        (hidden.includes(r)
          ? CT.statusLine({ bot: r.bot, state: "blocked", phrase: "Waiting for an answer", steps: false })
          : CT.statusLine({ bot: r.bot, state: r.state, phrase: r.phrase, elapsed: r.elapsed || "", steps: r.state === "working" })) +
        (r.partial ? `<div class="msg" data-role="assistant" data-streaming="${r.bot}"><div class="bubble" aria-busy="true">${esc(r.partial)}<span class="stream-caret"></span></div></div>` : "") +
        `</div>`,
    );
    if (lines.length) body.push(`<div class="g-status">${lines.join("")}</div>`);
    el.innerHTML = `<div class="transcript-inner">${body.join("")}</div>`;
    CT.hydrate(el);
    if (m.follow || atEnd) el.scrollTop = el.scrollHeight;
    else if (anchor) {
      const now = el.querySelector(`[data-anchor="${CSS.escape(anchor.id)}"]`);
      if (now) el.scrollTop += now.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.offset;
    }
    m.follow = false;
  }

  // The first block of text at or below the reading line, just under the column's top padding.
  function readingAnchor(el) {
    const inner = el.querySelector(".transcript-inner");
    if (!inner) return null;
    const line = el.getBoundingClientRect().top + parseFloat(getComputedStyle(inner).paddingTop);
    for (const node of el.querySelectorAll("[data-anchor]")) {
      const top = node.getBoundingClientRect().top;
      if (top >= line) return { id: node.dataset.anchor, offset: top - el.getBoundingClientRect().top };
    }
    return null;
  }

  function renderMemberTask(el) {
    const bot = m.view.bot;
    const t = taskOf("g1", bot);
    const inGroup = weekend && groups.includes(weekend) && memberBots(weekend).includes(bot);
    const log = t ? t.log : [];
    el.innerHTML =
      `<div class="transcript-inner"><h1 class="task-line">Plan Saturday for us</h1>` +
      (inGroup ? `<div class="g-line" data-member-line="part"><span>This task is part of ${esc(weekend.name)}. Only your messages to ${nm(bot)} are here.</span>${CT.button("Open the group", 'data-open-group="1"')}</div>` : "") +
      log.map((r) => (r.role === "user" ? `<div class="turn" data-role="user">${CT.msg({ role: "user", html: esc(r.text) })}</div>` : `<div class="turn" data-role="assistant">${CT.msg({ html: esc(r.text) })}</div>`)).join("") +
      `</div>`;
  }

  function renderHeader() {
    const pill = $("#title-pill");
    if (m.view.bot) {
      pill.hidden = false;
      pill.innerHTML = `<span class="avatar">${CT.character(m.view.bot)}</span><span class="title-pill-name">${nm(m.view.bot)}</span><span class="title-pill-task">Plan Saturday for us</span>`;
      pill.dataset.action = "none";
      pill.setAttribute("aria-label", `${nm(m.view.bot)}, Plan Saturday for us`);
      return;
    }
    pill.hidden = !m.group || !!m.view.removed;
    if (!m.group) return;
    pill.dataset.action = "details";
    pill.innerHTML = `${stack(memberBots(m.group))}<span class="title-pill-name">${esc(m.group.name)}</span>`;
    pill.setAttribute("aria-label", `${m.group.name}. Group details`);
  }

  // Who receives a message ----------------------------------------------------------------------

  // The mentions of the draft outside quoted lines, each with its occurrence number.
  function mentions(draft) {
    const out = [];
    let occ = 0;
    for (const line of draft.split("\n")) {
      if (/^\s*>/.test(line)) continue;
      for (const match of line.matchAll(/(^|[\s(["'])@([A-Za-z0-9_-]+)/g)) out.push({ occ: occ++, word: match[2].toLowerCase() });
    }
    return out;
  }
  // A binding holds while its occurrence still carries the word it was made for.
  function liveBindings() {
    const now = mentions(m.draft);
    m.bindings = m.bindings.filter((b) => now.some((x) => x.occ === b.occ && x.word === b.word));
    return m.bindings;
  }

  // One rule, used for the To line, Send's name and the sends alike (section 7).
  function resolve(g) {
    if (m.reply) {
      const blocked = m.reply.blocked || (g.member[m.reply.bot] ? `${nm(m.reply.bot)}'s task in this group can't take a reply now.` : "");
      return { bots: blocked ? [] : [m.reply.bot], everyone: false, reply: true, ambiguous: [], blocked };
    }
    const found = mentions(m.draft);
    const binds = liveBindings();
    const ms = memberBots(g);
    if (found.some((x) => x.word === "everyone")) return { bots: eligible(g), everyone: true, reply: false, ambiguous: [] };
    const named = [];
    const ambiguous = [];
    for (const x of found) {
      const bound = binds.find((b) => b.occ === x.occ);
      if (bound && ms.includes(bound.bot)) {
        named.push(bound.bot);
        continue;
      }
      const hits = ms.filter((b) => nm(b).toLowerCase() === x.word);
      if (hits.length === 1) named.push(hits[0]);
      if (hits.length > 1) ambiguous.push({ ...x, hits });
    }
    if (ambiguous.length) return { bots: [], everyone: false, reply: false, ambiguous };
    if (!named.length) return { bots: eligible(g), everyone: true, reply: false, ambiguous };
    return { bots: ms.filter((b) => named.includes(b) && !g.member[b]), named: ms.filter((b) => named.includes(b)), everyone: false, reply: false, ambiguous };
  }

  const chip = (g, bot, extra = "") => `<span class="g-chip"${extra}><span class="avatar" aria-hidden="true">${CT.character(bot)}</span>${esc(g ? who(g, bot) : nm(bot))}</span>`;
  const WHY = { archived: "task archived", taskgone: "task deleted", botgone: "bot deleted", changed: "task changed", "changed-receipt": "task changed", replaced: "task replaced", restoring: "task archived", starting: "task deleted" };
  const toWords = (g, t) =>
    t.blocked
      ? t.blocked
      : t.ambiguous.length
        ? `@${nm(t.ambiguous[0].hits[0])} matches ${t.ambiguous[0].hits.length} members. Choose one in the list.`
        : t.everyone
          ? "To Everyone"
          : t.bots.length
            ? `To ${list(t.bots.map((b) => who(g, b)))}${t.reply ? " (replying)" : ""}`
            : "To no one";
  const sendWords = (g, t) => (t.ambiguous.length || t.blocked ? "Send" : t.everyone ? "Send to everyone" : `Send to ${list(t.bots.map((b) => who(g, b)))}`);

  function toLine(g, t) {
    if (t.ambiguous.length || t.blocked) return `<div class="g-to" data-tone="warn" aria-label="${esc(toWords(g, t))}"><span>${esc(toWords(g, t))}</span></div>`;
    const skipped = (t.everyone ? memberBots(g) : t.named || []).filter((b) => g.member[b]);
    const n = t.bots.length;
    return (
      `<div class="g-to" aria-label="${esc(`${toWords(g, t)}. ${n} ${n === 1 ? "bot" : "bots"}. Each bot that answers uses its own tokens.`)}"><span>To</span>` +
      (t.everyone ? `<span class="g-chip" data-everyone>Everyone</span>` : t.bots.map((b) => chip(g, b)).join("")) +
      (t.reply ? `<span>(replying)</span>` : "") +
      skipped.map((b) => chip(g, b, ` data-skipped aria-label="${esc(nm(b))}, skipped: ${WHY[g.member[b]]}"`)).join("") +
      `<span class="g-cost">${n} ${n === 1 ? "bot" : "bots"} · Each bot that answers uses its own tokens</span>` +
      `</div>`
    );
  }

  function renderComposer() {
    const slot = $("#composer-slot");
    const g = m.group;
    if (!g || m.view.removed || m.view.bot) {
      slot.innerHTML = "";
      return;
    }
    if (m.tier === "read") {
      slot.innerHTML =
        m.access === "read"
          ? `<footer class="composer" data-run="read"><div class="composer-inner"><section class="access-bar" role="region" aria-label="Access" data-state="read">` +
            `<div class="access-row">${icon("eye")}<span class="shelf-text"><b>Read-only.</b> You can follow this group here. Approvals and questions aren't shown on this connection.</span>` +
            `<button type="button" class="button" data-size="sm" data-variant="primary" data-access="1">Request access</button></div></section></div></footer>`
          : CT.accessBar({ bot: "otto", state: m.access });
      return;
    }
    const t = resolve(g);
    const working = [...new Set(activeRuns(g).filter((r) => !r.queued).map((r) => r.bot))];
    const stopping = activeRuns(g).some((r) => r.state === "stopping");
    const shelf = [];
    for (const card of pendingCards(g))
      shelf.push(
        card.kind === "approval"
          ? CT.shelfRow({ tone: "warn", lead: CT.glyph("waiting"), text: `${nm(card.task)} needs your approval to run a command`, actions: CT.button("Review", `data-review="${card.id}"`) })
          : CT.shelfRow({ tone: "warn", lead: CT.glyph("waiting"), text: `${nm(card.task)} asked you a question. A message to ${nm(card.task)} now is held until you answer.`, actions: CT.button("Review", `data-review="${card.id}"`) }),
      );
    for (const n of g.notices) {
      if (n.kind === "refused") shelf.push(CT.shelfRow({ tone: "warn", lead: icon("warning"), text: `<b>Couldn't stop ${nm(n.bot)}'s run from this device.</b>` }));
      if (n.kind === "timeout") shelf.push(CT.shelfRow({ tone: "danger", lead: icon("warning"), text: `<b>No answer about ${nm(n.bot)}'s run.</b>`, actions: CT.button("Try again", `data-stop-again="${n.run}"`) }));
    }
    if (m.reply)
      shelf.push(
        `<div class="shelf-row g-replying"><span class="shelf-text"><b>Replying to ${esc(nm(m.reply.bot))}</b> <span>${esc(m.reply.preview || "")}</span></span>` +
          `<button type="button" class="icon-button" data-cancel-reply="1" aria-label="Cancel reply">${icon("x")}</button></div>`,
      );
    const empty = !m.draft.trim();
    const stoppable = working.filter((b) => !activeRuns(g).some((r) => r.bot === b && r.state === "stopping"));
    slot.innerHTML =
      `<footer class="composer" data-run="${working.length ? "running" : "idle"}"><div class="composer-inner">` +
      `<div class="composer-shelf">${shelf.join("")}</div>` +
      `<div class="composer-box">${toLine(g, t)}<div class="composer-row">` +
      `<textarea class="composer-input" id="g-input" rows="1" aria-label="Message the group" placeholder="${m.offline ? "Offline. Messages send when you reconnect." : "Message the group"}">${esc(m.draft)}</textarea>` +
      (stopping ? `<span class="composer-status">Stopping…</span>` : "") +
      (stoppable.length && !stopping
        ? `<button type="button" class="icon-button stop-button" data-stop="1" aria-label="Stop ${stoppable.length} ${stoppable.length === 1 ? "bot" : "bots"}" title="Stop (⌘.)"></button>`
        : "") +
      `<button type="button" class="icon-button send-button" data-send="1" aria-label="${esc(sendWords(g, t))}" title="${esc(sendWords(g, t))}"${empty || !t.bots.length ? " disabled" : ""}>${icon("arrow-up")}</button>` +
      `</div></div>` +
      (m.mentionOpen || t.ambiguous.length ? mentionMenu(g, t) : "") +
      `</div></footer>`;
  }

  function mentionMenu(g, t) {
    const typed = (m.draft.match(/@([\w-]*)$/) || [])[1]?.toLowerCase() || "";
    const items = t.ambiguous.length
      ? t.ambiguous[0].hits.map((b) => [b, who(g, b), `data-bind="${b}" data-occ="${t.ambiguous[0].occ}" data-word="${t.ambiguous[0].word}"`])
      : [["everyone", "Everyone", 'data-mention="everyone"'], ...memberBots(g).map((b) => [b, who(g, b), `data-mention="${b}"`])].filter(([, label]) => label.toLowerCase().startsWith(typed));
    return (
      `<ul class="menu g-mentions" role="menu" aria-label="${t.ambiguous.length ? "Choose who" : "Mention"}">` +
      items.map(([id, label, attr]) => `<li role="none"><button type="button" class="menu-item" role="menuitem" ${attr}>` + (id === "everyone" ? "" : `<span class="avatar" aria-hidden="true">${CT.character(id)}</span>`) + `${esc(label)}</button></li>`).join("") +
      `</ul>`
    );
  }

  function render() {
    renderRail();
    renderHeader();
    renderColumn();
    renderComposer();
    CT.hydrate(document);
  }
  // A result renders its column only when its group is the one on screen.
  const show = (g) => (g === m.group ? render() : renderRail());

  // Sending: one guarded path ------------------------------------------------------------------

  const REPLIES = {
    juniper: "Noted. I'll check the forecast again on Friday evening.",
    otto: "Will do. I'll keep an eye on the media box while you're out.",
    marlow: "Got it. I'll add it to the note for the neighbours.",
    extra4: "The bikes are by the garage door.",
    extra1: "I'll pick up the trailer key.",
    extra2: "The tomatoes need water before you go.",
    pip: "Noted.",
  };
  // How long each scripted reply takes, and where the gateway's saved time puts it:
  // Otto streams longest but its saved reply sorts first (research §2).
  const TIMING = { juniper: [600, 3], marlow: [900, 2], otto: [1300, 1], extra4: [700, 2], extra1: [650, 2], extra2: [800, 2], pip: [600, 1] };

  function send() {
    const g = m.group;
    const text = m.draft.trim();
    const t = resolve(g);
    if (!text || !t.bots.length) return;
    // A Reply whose task can no longer take it sends nothing.
    if (t.reply) {
      const task = taskOf(g.id, t.bots[0]);
      if (fail.delete("replygone") && task) task.state = "gone";
      if (!task || task.state !== "ok") {
        g.member[t.bots[0]] = "taskgone";
        m.reply.blocked = `${nm(t.bots[0])}'s task in this group was deleted, so it can't take this reply.`;
        render();
        return;
      }
    }
    journal.targets.push(t.bots.slice());
    const copies = {};
    for (const b of t.bots) {
      const stoppingRun = activeRuns(g).some((r) => r.bot === b && r.state === "stopping");
      if (m.offline) copies[b] = "held-offline";
      else if (stoppingRun) copies[b] = "queued"; // the stopping rule comes first (conversation.md §15)
      else if (questionPending(g, b)) copies[b] = "held";
      else copies[b] = "sending";
    }
    const item = localYou(text, copies, m.offline ? { held: true } : {});
    g.items.push(item);
    m.draft = "";
    m.reply = null;
    m.bindings = []; // sending clears every binding
    m.mentionOpen = false;
    m.follow = true;
    render();
    for (const b of t.bots.filter((x) => copies[x] === "sending")) dispatch(g, item, b);
  }

  // The one guarded send path: Send, Resend, a release after a question, a send on reconnect.
  function dispatch(g, item, bot) {
    const copies = item.copies;
    // Read the current members and describe the task first.
    const recorded = gw.records[g.id]?.members.find((x) => x.bot === bot);
    const task = taskOf(g.id, bot);
    if (!recorded || !memberBots(g).includes(bot)) {
      copies[bot] = "notsent";
      item.removed = [...(item.removed || []), bot];
      return show(g);
    }
    if (!task || task.state === "gone" || task.state === "botgone" || task.sid !== recorded.sid) {
      copies[bot] = "notsent";
      (item.whyNot ||= {})[bot] = `${nm(bot)}'s task no longer matches the group's record.`;
      g.member[bot] = task?.state === "botgone" ? "botgone" : !task || task.state === "gone" ? "taskgone" : "replaced";
      return show(g);
    }
    copies[bot] = "sending";
    item.announced = false;
    journal.sends.push({ copy: `cg:${g.id}:${item.id}:${bot}`, sessionKey: `${g.id}:${bot}`, sessionId: recorded.sid, expectedLeafEntryId: null, queueMode: undefined });
    show(g);
    later(300, () => {
      if (bot === "marlow" && fail.delete("vanish")) {
        // The guarded send is refused: the task went between the check and the send.
        task.state = "gone";
        copies[bot] = "failed";
        (item.why ||= {})[bot] = "active branch changed; review and retry";
        g.member[bot] = "taskgone"; // looked up again: nothing at the key
        announceWent(g, item);
        return show(g);
      }
      if (task.state === "archived") {
        copies[bot] = "failed";
        (item.why ||= {})[bot] = "Session … is archived. Restore it before starting new work.";
        g.member[bot] = "archived";
        announceWent(g, item);
        return show(g);
      }
      copies[bot] = "accepted";
      show(g);
      later(200, () => {
        if (bot === "marlow" && fail.delete("replacedafter")) {
          // A different session is at the key after admission, and nothing ties this copy to it.
          task.sid = sidFor(bot);
          g.member[bot] = "changed";
          return show(g);
        }
        if (bot === "marlow" && fail.delete("replacedreceipt")) {
          // The same run id is confirmed in the new session.
          task.sid = sidFor(bot);
          copies[bot] = "changed";
          g.member[bot] = "changed-receipt";
          return show(g);
        }
        const running = activeRuns(g).filter((r) => r.bot === bot && !r.queued);
        if (running.some((r) => r.owner === "other")) {
          copies[bot] = "gqueued"; // the task's pendingInputs names this copy's run
          const id = nid("r");
          g.runs[id] = { id, bot, owner: "this", queued: true, state: "idle", phrase: "Queued by the gateway", copyOf: item.id };
        } else if (running.some((r) => r.state === "working" || r.state === "thinking")) {
          copies[bot] = "steer"; // its row carries steerTargetRunId
        } else if (running.length) {
          // A run waiting on a card, or resuming from one: nothing yet says where the copy went.
          (running[0].pendingCopies ||= []).push(item.id);
        } else {
          copies[bot] = "sent"; // its row is in the task
        }
        task.log.push({ role: "user", text: item.text });
        announceWent(g, item);
        if (copies[bot] === "sent") startRun(g, bot, REPLIES[bot] || "Noted.", item.ts);
        show(g);
      });
    });
  }

  // One announcement per message, once no copy is still on its way: the where-it-went words.
  function announceWent(g, item) {
    if (item.announced || Object.values(item.copies).some((st) => st === "sending" || st === "accepted")) return;
    item.announced = true;
    announce(wentWords(g, item));
  }

  function startRun(g, bot, reply, sentTs, id = nid("r"), owner = "this") {
    const [delay, offset] = TIMING[bot] || [600, 1];
    const task = taskOf(g.id, bot);
    g.runs[id] = { id, bot, owner, state: "thinking", phrase: "Thinking", elapsed: "0:01" };
    announce(`${nm(bot)} is working`);
    later(200, () => {
      const r = g.runs[id] || task.detached?.[id];
      if (!r || r.hold || r.ended) return;
      r.partial = reply.slice(0, Math.ceil(reply.length / 2));
      show(g);
    });
    later(delay, () => finishRun(g, id, reply, sentTs + offset / 10, task));
    return id;
  }

  // A run's own terminal event. Its reply goes to its task; the group shows it only while
  // that task is a member.
  function finishRun(g, id, reply, ts, task) {
    const run = g.runs[id] || task.detached?.[id];
    if (!run || run.hold || run.ended) return;
    run.ended = "final";
    delete g.runs[id];
    if (task.detached) delete task.detached[id];
    task.log.push({ role: "assistant", text: reply });
    if (groups.includes(g) && memberBots(g).includes(run.bot)) {
      g.items.push(saved(run.bot, reply, { ts }));
      for (const copyId of run.pendingCopies || []) {
        const it = g.items.find((i) => i.id === copyId);
        if (it && it.copies[run.bot] === "accepted") it.copies[run.bot] = "sent";
      }
      announce(`${nm(run.bot)} finished`);
    }
    if (groups.includes(g)) show(g);
    else render();
  }

  // Stop --------------------------------------------------------------------------------------

  // Stop captures the member tasks and their active run ids when pressed, and asks the gateway
  // to stop each captured run by its id. The abort's reply and each run's own terminal evidence
  // are kept apart: only the latter names a run stopped.
  function stop(onlyRun) {
    const g = m.group;
    const captured = onlyRun ? [g.runs[onlyRun]].filter((r) => r && !r.queued && memberBots(g).includes(r.bot)) : activeRuns(g).filter((r) => !r.queued);
    if (!captured.length) return;
    g.notices = g.notices.filter((n) => !captured.some((r) => r.id === n.run));
    for (const r of captured) {
      r.saved = { state: r.state, phrase: r.phrase };
      Object.assign(r, { state: "stopping", phrase: "Stopping…" });
      journal.aborts.push({ sessionKey: `${g.id}:${r.bot}`, runId: r.id });
    }
    const count = new Set(captured.map((r) => r.bot)).size;
    announce(`Stopping ${count} ${count === 1 ? "bot" : "bots"}`);
    show(g);
    later(600, () => {
      const stopped = [];
      const finishedFirst = [];
      for (const r of captured) {
        if (r.ended === "final") {
          finishedFirst.push(r); // its own terminal event was final: it finished before Stop took effect
          continue;
        }
        if (!g.runs[r.id]) continue; // left the group meanwhile
        if (m.stopfail.delete(r.bot)) {
          Object.assign(r, r.saved);
          g.notices.push({ kind: "timeout", bot: r.bot, run: r.id });
          continue;
        }
        if (r.owner === "other") {
          Object.assign(r, r.saved); // its last confirmed live state stays
          g.notices.push({ kind: "refused", bot: r.bot, run: r.id });
          continue;
        }
        // Aborted: its own terminal event says so.
        r.ended = "aborted";
        delete g.runs[r.id];
        stopped.push(r);
        // Held and queued local copies go with the stopped run only.
        for (const it of g.items) if (it.copies && ["held", "queued"].includes(it.copies[r.bot])) it.copies[r.bot] = "notsent";
        // Each pending card of that run closes from its own outcome.
        for (const card of g.items.filter((i) => (i.kind === "approval" || i.kind === "question") && !i.done && i.task === r.bot && r.id.endsWith(i.run))) {
          card.done = true;
          card.html =
            card.kind === "approval"
              ? CT.approvalResolved({ id: card.id, bot: card.task, state: "cancelled", line: approvalFor(card.task).line, when: "5:44 PM", full: { reason: "", command: approvalFor(card.task).command, fields: [] }, raw: CT.samples.approvalRaw("deny") })
              : CT.questionAnswered({ id: card.id, questions: [{ title: QUESTIONS[card.q].title, answers: [] }], state: "cancelled", raw: CT.samples.questionRaw({ dismissed: true }) });
        }
        // A turn the gateway queued behind it was not stopped: it starts and has its own result.
        for (const q of Object.values(g.runs).filter((x) => x.bot === r.bot && x.queued)) {
          delete g.runs[q.id];
          if (q.owner === "other") g.items.push(savedYou(q.text, [r.bot]));
          const copyItem = g.items.find((i) => i.id === q.copyOf);
          if (copyItem) copyItem.copies[r.bot] = "sent";
          startRun(g, r.bot, q.reply || REPLIES[r.bot], tick(), q.id, q.owner);
        }
      }
      const byBot = {};
      for (const r of stopped) (byBot[r.bot] ||= []).push(r);
      const lines = [];
      const single = Object.entries(byBot).filter(([, rs]) => rs.length === 1).map(([b]) => nm(b));
      if (single.length) lines.push(`<p><b>Stopped.</b> ${possessive(single)} ${single.length > 1 ? "runs" : "run"} stopped. Completed actions are not undone.</p>`);
      for (const [b, rs] of Object.entries(byBot)) if (rs.length > 1) for (const r of rs) lines.push(`<p>${nm(b)} · Run ${esc(r.id.split("-").pop())} stopped</p>`);
      for (const r of finishedFirst) lines.push(`<p>${nm(r.bot)}: Finished before Stop took effect.</p>`);
      if (lines.length) g.items.push(note(lines.join("")));
      if (stopped.length) announce("Stopped");
      for (const n of g.notices) announce(n.kind === "refused" ? `Couldn't stop ${nm(n.bot)}'s run from this device` : `No answer about ${nm(n.bot)}'s run`);
      show(g);
    });
  }

  // Dialogs and changes to a group ---------------------------------------------------------

  const dialog = $("#g-dialog");
  let opener = null;
  const dlg = { kind: null };

  function openDialog(kind, from, extra = {}) {
    opener = from || document.activeElement;
    for (const k of Object.keys(dlg)) delete dlg[k];
    Object.assign(dlg, { kind, ...extra });
    drawDialog();
    dialog.dataset.kind = kind.startsWith("confirm") ? "confirm" : "";
    if (!dialog.open) dialog.showModal();
    ($("[data-autofocus]", dialog) || $("h2", dialog))?.focus();
  }
  function closeDialog() {
    if (dialog.open) dialog.close();
    dlg.kind = null;
    if (opener && document.contains(opener)) opener.focus();
  }
  dialog.addEventListener("close", () => (dlg.kind = null));
  // A write in progress stays visible until its answer.
  const inFlight = () => dlg.busy || (dlg.making && !dlg.error && !dlg.making.every((r) => r.done));
  dialog.addEventListener("cancel", (event) => {
    if (inFlight()) event.preventDefault();
  });

  const head = (title, back = false, close = true) =>
    `<header class="b-head">${back ? `<button type="button" class="icon-button b-back" data-dback="1" aria-label="Back">${icon("back")}</button>` : ""}` +
    `<h2 id="g-dialog-title" tabindex="-1">${esc(title)}</h2>` +
    (close ? `<button type="button" class="icon-button b-close" data-dclose="1" aria-label="Close">${icon("x")}</button>` : "") +
    `</header>`;
  const noteBox = (tone, html) => `<div class="b-note"${tone ? ` data-tone="${tone}"` : ""}>${icon(tone ? "warning" : "helpers")}<div><p>${html}</p></div></div>`;
  const choice = (bot, checked, disabled, attr, hidden = false) =>
    `<li${hidden ? " hidden" : ""}><button type="button" class="b-choice" role="checkbox" aria-checked="${checked}" ${attr}="${bot}"${disabled ? ' aria-disabled="true"' : ""}>` +
    `<span class="avatar" aria-hidden="true">${CT.character(bot)}</span><span class="b-choice-text"><span class="b-choice-title">${esc(nm(bot))}</span>` +
    `<span class="b-choice-sub">${disabled && !checked ? "A group has at most 6 bots." : esc(CT.bots[bot].label)}</span></span>${checked ? icon("check", "icon b-tick") : ""}</button></li>`;
  const actions = (...buttons) => `<div class="b-actions">${buttons.join("")}</div>`;
  const btn = (label, attr, variant = "") => `<button type="button" class="button"${variant ? ` data-variant="${variant}"` : ""} ${attr}>${label}</button>`;
  const recWords = (rec) => `Now saved: ${esc(rec.name)}, with ${esc(list(rec.members.map((x) => nm(x.bot))))}.`;

  // The read-back, compared with the requested record, says what is shown.
  function resultHtml() {
    const r = dlg.result;
    if (!r) return "";
    if (r.kind === "absent") return noteBox("warn", "This group is no longer saved.");
    if (r.kind === "unconfirmed") return noteBox("warn", "<b>Couldn't confirm the change.</b>");
    if (r.kind === "differs") return noteBox("warn", `${r.lead ? `<b>${esc(r.lead)}</b> ` : ""}${recWords(r.record)}`);
    if (r.kind === "same") return noteBox("", `${recWords(r.record)} Nothing was sent.`);
    return "";
  }

  // Apply a record read back to the client's group.
  function adopt(g, rec) {
    g.name = rec.name;
    const before = memberBots(g);
    g.members = clone(rec.members);
    for (const b of before) if (!memberBots(g).includes(b)) dropMember(g, b);
    for (const x of g.members) if (!gw.tasks[`${g.id}:${x.bot}`]) gw.tasks[`${g.id}:${x.bot}`] = { sid: x.sid, state: "ok", hasMore: false, log: [] };
  }

  // One change: a pre-read, the requested record from it, a compare-and-set write, a read-back.
  // `next(pre)` returns the requested record, or null to remove it.
  function change(g, next, done, opts = {}) {
    dlg.busy = true;
    dlg.result = null;
    dlg.onDone = done;
    drawDialog();
    later(300, () => {
      dlg.busy = false;
      const pre = readRecord(g.id);
      if (pre === "unreadable") {
        dlg.result = { kind: "unconfirmed" };
        return drawDialog();
      }
      if (pre === null) {
        dlg.result = { kind: "absent" };
        return absentGroup(g);
      }
      const wanted = next(pre);
      dlg.wanted = wanted;
      if (wanted !== null && sameRecord(wanted, pre)) {
        // The change is already there: show the current record and send nothing.
        dlg.result = { kind: "same", record: pre };
        adopt(g, pre);
        render();
        return drawDialog();
      }
      if (opts.competing) opts.competing(); // another writer, between the pre-read and the write
      const outcome = writeRecord(g.id, wanted, pre);
      readBack(g, outcome);
    });
  }
  function readBack(g, outcome) {
    const wanted = dlg.wanted;
    const rb = readRecord(g.id);
    if (rb === "unreadable") {
      dlg.result = { kind: "unconfirmed" };
      return drawDialog();
    }
    if (wanted === null ? rb === null : rb && sameRecord(rb, wanted)) {
      if (rb) adopt(g, rb);
      return dlg.onDone(rb);
    }
    if (rb === null) {
      dlg.result = { kind: "absent" };
      return absentGroup(g);
    }
    adopt(g, rb);
    dlg.result = { kind: "differs", record: rb, lead: outcome === "refused" ? "The gateway refused the change." : "" };
    render();
    drawDialog();
  }
  // Check again only reads.
  function checkAgain(g) {
    dlg.busy = true;
    drawDialog();
    later(250, () => {
      dlg.busy = false;
      readBack(g, "check");
    });
  }
  function absentGroup(g) {
    const present = memberBots(g).filter((b) => readable(g, b));
    if (groups.includes(g)) groups.splice(groups.indexOf(g), 1);
    if (m.group === g) {
      m.group = null;
      m.view = { removed: true };
      m.stageNote = `This group is no longer saved. ${possessive(present.map(nm))} ${present.length > 1 ? "tasks stay in their lists" : "task stays in its list"}.`;
    }
    render();
    drawDialog();
  }

  function drawDialog() {
    const k = dlg.kind;
    let html = "";
    if (k === "new") html = newGroupHtml();
    if (k === "details") html = detailsHtml();
    if (k === "add") html = addHtml();
    if (k === "confirm-member") html = confirmMemberHtml();
    if (k === "confirm-group") html = confirmGroupHtml();
    if (k === "confirm-adopt") html = confirmAdoptHtml();
    dialog.innerHTML = `<div class="b-sheet">${html}</div>`;
    CT.hydrate(dialog);
  }

  const dlgGroup = () => groups.find((x) => x.id === dlg.gid) || m.group;

  function confirmMemberHtml() {
    const g = dlgGroup();
    if (!g) return head("Remove a member") + `<div class="b-body">${resultHtml()}</div><div class="b-foot">${actions(btn("Close", 'data-dclose="1" data-autofocus'))}</div>`;
    const bot = dlg.bot;
    const name = nm(bot);
    const s = g.member[bot];
    const first = s === "botgone" ? `${name} was deleted, with its tasks.` : s === "taskgone" ? `${name}'s task is already gone.` : `${name}'s task is present.`;
    const stillMember = memberBots(g).includes(bot);
    const r = dlg.result;
    const twoLeft = !!r && stillMember && g.members.length <= 2;
    const buttons =
      r?.kind === "unconfirmed"
        ? [btn("Check again", 'data-check="1" data-autofocus', "primary"), btn("Cancel", 'data-dclose="1"')]
        : r?.kind === "absent" || (r && !stillMember)
          ? [btn("Close", 'data-dclose="1" data-autofocus')]
          : twoLeft
            ? [btn("Add a bot", 'data-add="1"'), `<button type="button" class="button" data-tone="danger" data-remove-group="1">Remove group…</button>`, btn("Cancel", 'data-dclose="1"')]
            : [
                `<button type="button" class="button" data-tone="danger" data-do-remove="${bot}" data-autofocus${dlg.busy ? " disabled" : ""}>${dlg.busy ? "Removing…" : r ? "Try again" : "Remove"}</button>`,
                btn("Cancel", 'data-dclose="1"'),
              ];
    return (
      head(`Remove ${name} from ${g.name}?`, false, !dlg.busy) +
      `<div class="b-body"><p>${esc(first)} Removing this group record keeps the tasks and their histories. Work the gateway already accepted can continue.</p>${resultHtml()}` +
      (twoLeft ? `<p class="g-hint">A group has at least two bots. To change one, add another bot first, or remove the group.</p>` : "") +
      `</div><div class="b-foot">${actions(...buttons)}</div>`
    );
  }

  const presentTasks = (g) => memberBots(g).filter((b) => !["taskgone", "botgone"].includes(g.member[b]));

  function confirmGroupHtml() {
    const g = dlgGroup();
    if (!g) return head("Remove the group") + `<div class="b-body">${resultHtml()}</div><div class="b-foot">${actions(btn("Close", 'data-dclose="1" data-autofocus'))}</div>`;
    const present = presentTasks(g);
    const gone = memberBots(g).filter((b) => !present.includes(b));
    const r = dlg.result;
    return (
      head(`Remove ${g.name}?`, false, !dlg.busy) +
      `<div class="b-body"><p>${esc(possessive(present.map(nm)))} ${present.length > 1 ? "tasks are" : "task is"} present.` +
      (gone.length ? ` ${esc(possessive(gone.map(nm)))} task is already gone.` : "") +
      ` Removing this group record keeps the tasks and their histories. Work the gateway already accepted can continue.</p>${resultHtml()}</div>` +
      `<div class="b-foot">${actions(
        r?.kind === "unconfirmed"
          ? btn("Check again", 'data-check="1" data-autofocus', "primary")
          : r?.kind === "absent"
            ? btn("Close", 'data-dclose="1" data-autofocus')
            : `<button type="button" class="button" data-tone="danger" data-do-remove-group="1" data-autofocus${dlg.busy ? " disabled" : ""}>${dlg.busy ? "Removing…" : r ? "Try again" : "Remove group"}</button>`,
        btn("Cancel", 'data-dclose="1"'),
      )}</div>`
    );
  }

  function confirmAdoptHtml() {
    const g = dlgGroup();
    const bot = dlg.bot;
    const read = dlg.history;
    return (
      head(`Use the current task for ${nm(bot)} in ${g ? g.name : "this group"}?`, false, !dlg.busy) +
      `<div class="b-body"${read ? "" : ' aria-busy="true"'}>` +
      (read
        ? `<p>The task now at ${esc(nm(bot))}'s place, as read now:</p><ul class="g-making">${read.length ? read.map((r) => `<li>${r.role === "user" ? "You" : esc(nm(bot))}: ${esc(r.text)}</li>`).join("") : "<li>No messages yet.</li>"}</ul>`
        : `<p class="g-hint">Reading ${esc(nm(bot))}'s current task…</p>`) +
      resultHtml() +
      `</div><div class="b-foot">${actions(
        dlg.result?.kind === "unconfirmed"
          ? btn("Check again", 'data-check="1"', "primary")
          : dlg.result?.kind === "absent" || dlg.result?.kind === "differs"
            ? btn("Close", 'data-dclose="1"')
            : btn("Use the current task", `data-do-adopt="1" data-autofocus${read && !dlg.busy ? "" : " disabled"}`, "primary"),
        btn("Cancel", 'data-dclose="1"'),
      )}</div>`
    );
  }

  // New group: choose, make each task, write the record as must-be-absent, read it back.
  function newGroupHtml() {
    if (fail.has("noprefs"))
      return head("New group") + `<div class="b-body">${noteBox("warn", "This connection can't keep preferences on the gateway, so it can't keep a group.")}</div><div class="b-foot">${actions(btn("Close", 'data-dclose="1" data-autofocus'))}</div>`;
    const picked = dlg.picked;
    if (dlg.making) {
      const rows = dlg.making
        .map((r) =>
          r.bot === "record"
            ? `<li${r.done ? " data-done" : ""}>${r.done ? icon("check") : CT.glyph("sending")}${r.done ? "Group saved" : "Saving the group…"}</li>`
            : `<li${r.done ? " data-done" : ""}><span class="avatar" aria-hidden="true">${CT.character(r.bot)}</span>${r.done ? `${esc(nm(r.bot))}'s task made` : r.failed ? `Couldn't make ${esc(nm(r.bot))}'s task` : `Making ${esc(nm(r.bot))}'s task…`}</li>`,
        )
        .join("");
      const made = dlg.making.filter((r) => r.bot !== "record" && r.done).map((r) => nm(r.bot));
      const failed = dlg.making.find((r) => r.failed);
      let tail = "";
      if (dlg.error === "task")
        tail =
          noteBox("danger", `<b>Made tasks for ${esc(list(made))}. Couldn't make one for ${esc(nm(failed.bot))}.</b> The gateway answered: Unknown agent id "${failed.bot}".`) +
          actions(
            btn(`Try ${esc(nm(failed.bot))} again`, `data-retry-task="${failed.bot}" data-autofocus`, "primary"),
            made.length >= 2 ? btn(`Make it without ${esc(nm(failed.bot))}`, `data-without="${failed.bot}"`) : "",
            btn("Cancel", 'data-cancel-new="absent"', "quiet"),
          );
      if (dlg.error === "record")
        tail = noteBox("danger", `<b>Made tasks for ${esc(list(made))}, but couldn't save the group.</b> The gateway didn't answer in time.`) + actions(btn("Try again", 'data-retry-record="1" data-autofocus', "primary"), btn("Cancel", 'data-cancel-new="absent"', "quiet"));
      if (dlg.error === "readback") tail = noteBox("warn", "<b>Couldn't confirm the group was saved.</b>") + actions(btn("Check again", 'data-check-new="1" data-autofocus', "primary"), btn("Cancel", 'data-cancel-new="uncertain"', "quiet"));
      if (dlg.error === "full") tail = noteBox("danger", "Your gateway preferences have no room for another group. Remove a saved preference and try again.") + actions(btn("Cancel", 'data-cancel-new="absent" data-autofocus'));
      return head("New group", false, !inFlight()) + `<div class="b-body" aria-live="polite"><ul class="g-making">${rows}</ul>${tail}</div>`;
    }
    const n = picked.length;
    const name = `${ME}, ${list(picked.map(nm))}`;
    const filter = (dlg.filter || "").toLowerCase();
    return (
      head("New group") +
      `<div class="b-body"><div class="g-picked">To: ${picked.map((b) => chip(null, b)).join("")}` +
      `<input class="g-filter" id="g-filter" aria-label="Find a bot" placeholder="Find a bot" value="${esc(dlg.filter || "")}" data-autofocus></div>` +
      `<ul class="b-choices" role="group" aria-label="Bots">${ALL.map((b) => choice(b, picked.includes(b), n >= 6 && !picked.includes(b), "data-pick", !!filter && !nm(b).toLowerCase().includes(filter))).join("")}</ul>` +
      (n < 2 ? `<p class="g-hint">Choose 2 to 6 bots.</p>` : `<p class="g-hint">Name: <b>${esc(name)}</b>. You can rename it later.</p>`) +
      `<div style="margin-top:12px">${noteBox("", "Clawtrate makes a new task with each bot and keeps the group with your preferences on the gateway, so your other devices show it.")}</div></div>` +
      `<div class="b-foot"><div class="b-actions"><span class="spacer"></span>${btn("Create", `data-create="1"${n < 2 ? " disabled" : ""}`, "primary")}</div></div>`
    );
  }

  function create() {
    dlg.making = dlg.picked.map((bot) => ({ bot })).concat([{ bot: "record" }]);
    dlg.gid = nid("g");
    announce("Making the group");
    drawDialog();
    makeNext();
  }

  function makeNext() {
    const next = dlg.making.find((r) => !r.done && !r.failed);
    if (!next) return;
    later(260, () => {
      if (dlg.kind !== "new") return;
      if (next.bot === "record") return saveNewRecord(next);
      if (fail.delete(next.bot)) {
        next.failed = true;
        dlg.error = "task";
        announce(`Couldn't make ${nm(next.bot)}'s task`);
        return drawDialog();
      }
      next.sid ||= sidFor(next.bot); // its sessions.create answered with this task
      journal.taskWrites.push({ kind: "create", bot: next.bot, sid: next.sid });
      next.done = true;
      drawDialog();
      makeNext();
    });
  }

  // The record of a new group: expected absent, then read back.
  function saveNewRecord(row) {
    const members = dlg.making.filter((r) => r.bot !== "record" && r.done).map((r) => ({ bot: r.bot, sid: r.sid }));
    const wanted = { name: `${ME}, ${list(members.map((x) => nm(x.bot)))}`, members };
    dlg.wanted = wanted;
    const pre = gw.records[dlg.gid] || null; // the pre-read: nothing there yet
    if (pre && sameRecord(pre, wanted)) {
      row.done = true;
      return finish(pre);
    }
    if (fail.delete("full")) {
      journal.recordWrites.push({ gid: dlg.gid, next: clone(wanted) });
      dlg.error = "full";
      return drawDialog();
    }
    if (fail.delete("record")) {
      journal.recordWrites.push({ gid: dlg.gid, next: clone(wanted) }); // refused; nothing saved
    } else {
      if (fail.delete("readback")) fail.add("lostread");
      writeRecord(dlg.gid, wanted, pre);
    }
    const rb = readRecord(dlg.gid);
    if (rb === "unreadable") {
      dlg.error = "readback";
      return drawDialog();
    }
    if (rb && sameRecord(rb, wanted)) {
      row.done = true;
      return finish(rb);
    }
    dlg.error = "record";
    announce("Couldn't save the group");
    drawDialog();
  }

  function finish(rec) {
    const g = { id: dlg.gid, name: rec.name, members: clone(rec.members), at: 59, items: [], runs: {}, member: {}, notices: [] };
    for (const x of g.members) gw.tasks[`${g.id}:${x.bot}`] = { sid: x.sid, state: "ok", hasMore: false, log: [] };
    groups.push(g);
    load(g);
    closeDialog();
    render();
    announce("Made the group");
    $("#g-input")?.focus();
  }

  function load(g) {
    m.group = g;
    m.view = { group: g.id };
    m.draft = "";
    m.reply = null;
    m.bindings = [];
    m.follow = true;
  }

  function detailsHtml() {
    const g = dlgGroup();
    if (!g) return head("Group details") + `<div class="b-body">${resultHtml()}</div>`;
    if (dlg.reading) return head("Group details") + `<div class="b-body" aria-busy="true"><p class="g-hint">Reading the group…</p></div>`;
    const write = m.tier === "write";
    const phone = touch();
    let name;
    if (dlg.renaming) {
      const typed = dlg.typed ?? g.name;
      name =
        `<div class="g-name-row"><input class="input" id="g-name" aria-label="Name" value="${esc(typed)}"${dlg.busy ? " disabled" : ""} data-autofocus>` +
        `<button type="button" class="button" data-variant="primary" data-save-name="1"${dlg.busy || !typed.trim() ? " disabled" : ""}>${dlg.busy ? "Saving…" : dlg.result ? "Save again" : phone ? "Done" : "Save"}</button>` +
        (dlg.busy ? "" : `<button type="button" class="button" data-variant="quiet" data-cancel-name="1">Cancel</button>`) +
        `</div>` +
        (!typed.trim() ? `<p class="g-hint">A group needs a name.</p>` : "");
    } else {
      name = `<div class="g-name-row"><h3>${esc(g.name)}</h3>${write ? `<button type="button" class="button" data-size="sm" data-rename="1">${phone ? "Edit" : "Rename"}</button>` : ""}</div>`;
    }
    const rows = memberBots(g)
      .map(
        (b) =>
          `<li><span class="avatar" aria-hidden="true">${CT.character(b)}</span><span class="g-name">${esc(who(g, b))}</span>` +
          (["botgone", "taskgone"].includes(g.member[b]) ? "" : CT.button(`Open ${esc(nm(b))}'s task`, `data-open-task="${b}"`)) +
          (write && canRemoveMember(g) ? CT.button("Remove", `data-remove-member="${b}" aria-label="Remove ${esc(nm(b))}"`) : "") +
          `</li>`,
      )
      .join("");
    const full = g.members.length >= 6;
    return (
      head("Group details") +
      `<div class="b-body">${name}${resultHtml()}${dlg.result?.kind === "unconfirmed" ? actions(btn("Check again", 'data-check="1"', "primary")) : ""}<p class="g-section">Members</p><ul class="g-members">${rows}</ul>` +
      `<p class="g-hint">Each member has its own task with you. Opening it shows your messages to that bot and its replies.</p>` +
      (write ? `<p>${CT.button("Add a bot", `data-add="1"${full ? " disabled" : ""}`)}</p>${full ? `<p class="g-hint">A group has at most 6 bots.</p>` : ""}` : "") +
      (write && !canRemoveMember(g) ? `<p class="g-hint">A group has at least two bots. To change one, add another bot first, or remove the group.</p>` : "") +
      `<p class="g-hint">Kept with your preferences on the gateway. Devices signed in to the same gateway profile show this group.</p></div>` +
      (write ? `<div class="b-foot"><div class="b-actions"><button type="button" class="button" data-tone="danger" data-remove-group="1">Remove group…</button></div></div>` : "")
    );
  }

  function addHtml() {
    const g = dlgGroup();
    const others = ALL.filter((b) => !memberBots(g).includes(b));
    const full = g.members.length >= 6;
    if (dlg.adding && !dlg.result && !dlg.busy && !dlg.sid)
      return head("Add a bot", true, false) + `<div class="b-body" aria-live="polite"><ul class="g-making"><li><span class="avatar" aria-hidden="true">${CT.character(dlg.adding)}</span>Making ${esc(nm(dlg.adding))}'s task…</li></ul></div>`;
    if (dlg.adding && dlg.busy)
      return head("Add a bot", true, false) + `<div class="b-body" aria-live="polite"><ul class="g-making"><li><span class="avatar" aria-hidden="true">${CT.character(dlg.adding)}</span>${esc(nm(dlg.adding))}'s task made. Saving the group…</li></ul></div>`;
    if (dlg.result)
      return (
        head("Add a bot", true) +
        `<div class="b-body" aria-live="polite">${noteBox("danger", `<b>${esc(nm(dlg.adding))}'s task was made. This group still has ${esc(list(memberBots(g).map(nm)))}.</b>`)}${dlg.result.kind === "differs" ? "" : resultHtml()}` +
        (full ? `<p class="g-hint">A group has at most 6 bots.</p>` : "") +
        `${actions(dlg.result.kind === "unconfirmed" ? btn("Check again", 'data-check="1"', "primary") : btn("Try again", `data-retry-add="1" data-autofocus${full ? " disabled" : ""}`, "primary"), btn("Cancel", 'data-dback="1"', "quiet"))}</div>`
      );
    return (
      head("Add a bot", true) +
      `<div class="b-body"><ul class="b-choices" role="group" aria-label="Bots">${others.map((b) => choice(b, dlg.add === b, full, "data-add-pick")).join("")}</ul></div>` +
      `<div class="b-foot"><div class="b-actions"><span class="spacer"></span>${btn("Add", `data-do-add="1"${dlg.add && !full ? "" : " disabled"}`, "primary")}</div></div>`
    );
  }

  function addMember() {
    const g = dlgGroup();
    const bot = dlg.adding;
    const sid = dlg.sid;
    change(
      g,
      (pre) => (pre.members.some((x) => x.bot === bot) || pre.members.length >= 6 ? pre : { ...pre, members: [...pre.members, { bot, sid }] }),
      () => {
        announce(`Added ${nm(bot)}`);
        render();
        openDetails(opener, { gid: g.id });
      },
      {
        competing: () => {
          if (fail.delete("competingadd")) gw.records[g.id].members.push({ bot: "extra3", sid: sidFor("extra3") });
          if (fail.delete("add")) fail.add("timeout"), fail.add("readonce");
        },
      },
    );
  }

  // Menus ---------------------------------------------------------------------------------------

  const menu = $("#rail-menu");
  let menuFrom = null;
  function openMenu(items, from, x, y) {
    menuFrom = from;
    menu.innerHTML = items.map(([label, attr, keys]) => `<li role="none"><button type="button" class="menu-item" role="menuitem" ${attr}>${label}${keys ? `<kbd>${keys}</kbd>` : ""}</button></li>`).join("");
    menu.hidden = false;
    const r = from.getBoundingClientRect();
    menu.style.left = `${x ?? r.left}px`;
    menu.style.top = `${y ?? r.bottom + 4}px`;
    from.setAttribute("aria-expanded", "true");
    $(".menu-item", menu).focus();
  }
  function closeMenu(refocus = true) {
    if (menu.hidden) return;
    menu.hidden = true;
    menuFrom?.setAttribute("aria-expanded", "false");
    if (refocus) menuFrom?.focus();
  }

  function openDetails(from, extra = {}) {
    openDialog("details", from, { reading: true, gid: extra.gid ?? m.group?.id, ...extra });
    later(150, () => {
      if (dlg.kind !== "details") return;
      // The pre-read: the record as the gateway has it now.
      const g = dlgGroup();
      const rec = g && readRecord(g.id);
      dlg.reading = false;
      if (rec && rec !== "unreadable") adopt(g, rec);
      drawDialog();
      ($("[data-autofocus]", dialog) || $("h2", dialog))?.focus();
    });
  }

  // A member leaves the record; its task, its history and its runs go on outside the group.
  function dropMember(g, bot) {
    delete g.member[bot];
    const task = taskOf(g.id, bot);
    for (const r of Object.values(g.runs))
      if (r.bot === bot) {
        delete g.runs[r.id];
        if (task) (task.detached ||= {})[r.id] = r; // its own task still gets its result
      }
    g.notices = g.notices.filter((n) => n.bot !== bot);
    g.items = g.items
      .filter((i) => i.kind === "you" || i.kind === "note" || i.task !== bot)
      .map((i) => {
        if (i.kind !== "you" || !i.copies[bot]) return i;
        // A copy still held on this device is not sent to a former member: its Not sent is shown.
        if (["held", "queued", "held-offline"].includes(i.copies[bot])) return { ...i, copies: { ...i.copies, [bot]: "notsent" }, removed: [...(i.removed || []), bot] };
        const copies = Object.fromEntries(Object.entries(i.copies).filter(([b]) => b !== bot));
        return { ...i, copies };
      })
      .filter((i) => i.kind !== "you" || Object.keys(i.copies).length > 0);
  }

  // Long press, on touch: the same menus as right-click.
  let holdTimer = null;
  let held = false;
  document.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch" && !touch()) return;
    const row = event.target.closest(".bot[data-group]");
    const said = event.target.closest(".g-said");
    if (!row && !said) return;
    holdTimer = setTimeout(() => {
      held = true;
      if (row) groupMenu(row, groups.find((x) => x.id === row.dataset.group));
      else {
        const b = $("[data-msg-menu]", said);
        if (b) msgMenu(b);
      }
    }, 500);
  });
  ["pointerup", "pointercancel"].forEach((type) => document.addEventListener(type, () => clearTimeout(holdTimer)));

  function msgMenu(el) {
    openMenu(
      [
        ["Reply", `data-reply="${el.dataset.msgMenu}"`],
        ["Quote", `data-quote="${el.dataset.msgMenu}"`],
      ],
      el,
    );
  }

  function groupMenu(from, g, x, y) {
    m.menuGid = g.id; // the menu acts on the row that opened it
    const items = m.tier === "write" ? [["Rename…", 'data-menu-rename="1"'], ["Group details", 'data-menu-details="1"'], ["Remove group…", 'data-menu-remove="1"']] : [["Group details", 'data-menu-details="1"']];
    openMenu(items, from, x, y);
  }

  // Events --------------------------------------------------------------------------------------

  // A long press is not also a click.
  document.addEventListener(
    "click",
    (event) => {
      if (!held) return;
      held = false;
      if (event.target.closest("#rail-menu")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );

  document.addEventListener("click", (event) => {
    const t = event.target;
    const on = (sel) => t.closest(sel);
    let el;
    if (!on("#rail-menu") && !on("[data-msg-menu]") && !on("#new-button")) closeMenu(false);
    const g = m.group;

    if ((el = on("#new-button"))) {
      return openMenu(
        [
          ["New task", 'data-elsewhere="new-task"', "⌘T"],
          ["New bot", 'data-elsewhere="new-bot"', "⌘N"],
          ["New group", 'data-new-group="1"', "⌘⇧N"],
        ],
        el,
      );
    }
    if (on("[data-new-group]")) {
      closeMenu(false);
      return openDialog("new", $("#new-button"), { picked: [], making: null, error: null });
    }
    if (on("[data-elsewhere]")) {
      closeMenu(false);
      return CT.toast?.("That is designed elsewhere; this page shows groups.");
    }
    if (on("[data-menu-details]") || on("[data-menu-rename]") || on("[data-menu-remove]")) {
      const target = groups.find((x) => x.id === m.menuGid);
      closeMenu(false);
      if (!target) return;
      if (on("[data-menu-remove]")) return openDialog("confirm-group", $("#title-pill"), { gid: target.id });
      return openDetails($("#title-pill"), { gid: target.id, renaming: !!on("[data-menu-rename]"), typed: target.name });
    }
    if ((el = on(".bot[data-group]"))) {
      const target = groups.find((x) => x.id === el.dataset.group);
      if (target !== m.group) load(target);
      m.view = { group: target.id };
      m.follow = true;
      $(".shell").dataset.view = "detail";
      return render();
    }
    if ((el = on("[data-bot-row]"))) {
      const id = el.dataset.botRow;
      m.view = m.view.bot === id ? (m.group ? { group: m.group.id } : { removed: true }) : { bot: id };
      $(".shell").dataset.view = "detail";
      return render();
    }
    if (on("[data-member-task]")) return;
    if (on("[data-open-group]")) {
      m.view = { group: m.group.id };
      m.follow = true;
      return render();
    }
    if (on('[data-action="back"]')) return ($(".shell").dataset.view = "list");
    if ((el = on("#title-pill")) && el.dataset.action === "details") return openDetails(el);

    if ((el = on("[data-msg-menu]"))) return msgMenu(el);
    if ((el = on("[data-reply]"))) {
      const item = g.items.find((i) => i.id === el.dataset.reply);
      closeMenu(false);
      // The preview is the gateway's read-back of the referenced message, when it has one.
      m.reply = { bot: item.task, id: item.id, preview: fail.delete("replypreview") ? "Original message unavailable." : item.text };
      renderComposer();
      CT.hydrate($("#composer-slot"));
      return $("#g-input").focus();
    }
    if ((el = on("[data-quote]"))) {
      const item = g.items.find((i) => i.id === el.dataset.quote);
      closeMenu(false);
      const quoted = `${nm(item.task)}: ${item.text.slice(0, 500)}`
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      m.draft = `${quoted}\n${m.draft}`;
      renderComposer();
      CT.hydrate($("#composer-slot"));
      const input = $("#g-input");
      input.focus();
      input.setSelectionRange(quoted.length + 1, quoted.length + 1);
      return;
    }
    if (on("[data-cancel-reply]")) {
      m.reply = null;
      renderComposer();
      return $("#g-input").focus();
    }
    if ((el = on("[data-mention]"))) {
      const id = el.dataset.mention;
      const label = id === "everyone" ? "everyone" : nm(id);
      m.draft = m.draft.replace(/@[\w-]*$/, `@${label} `);
      if (id !== "everyone") {
        // The choice binds this one occurrence to this bot.
        const found = mentions(m.draft);
        const occ = found.length ? found[found.length - 1].occ : 0;
        m.bindings = m.bindings.filter((b) => b.occ !== occ).concat([{ occ, word: label.split(" ")[0].toLowerCase(), bot: id }]);
      }
      m.mentionOpen = false;
      renderComposer();
      CT.hydrate($("#composer-slot"));
      const input = $("#g-input");
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }
    if ((el = on("[data-bind]"))) {
      const occ = Number(el.dataset.occ);
      m.bindings = m.bindings.filter((b) => b.occ !== occ).concat([{ occ, word: el.dataset.word, bot: el.dataset.bind }]);
      renderComposer();
      CT.hydrate($("#composer-slot"));
      return $("#g-input").focus();
    }
    if (on("[data-send]")) return send();
    if (on("[data-stop]")) return stop();
    if ((el = on("[data-stop-again]"))) {
      // Retried with the same id only while that run is active and its task a member.
      const run = g.runs[el.dataset.stopAgain];
      g.notices = g.notices.filter((n) => n.run !== el.dataset.stopAgain);
      if (!run || !memberBots(g).includes(run.bot)) return render();
      return stop(el.dataset.stopAgain);
    }
    if ((el = on("[data-review]"))) return ($(`#${el.dataset.review} .option`) || $(`#${el.dataset.review}`))?.focus();
    if ((el = on("[data-went]"))) {
      const item = g.items.find((i) => i.id === el.dataset.went);
      item.open = !item.open;
      render();
      return $(`[data-went="${item.id}"]`).focus();
    }
    if ((el = on("[data-resend]"))) {
      const [id, bot] = el.dataset.resend.split(":");
      return dispatch(g, g.items.find((i) => i.id === id), bot);
    }
    if ((el = on("[data-restore]"))) {
      const bot = el.dataset.restore;
      // Read the task, change it with sessions.patch, read it back.
      const task = taskOf(g.id, bot);
      g.member[bot] = "restoring";
      render();
      later(400, () => {
        if (task.state === "archived") {
          journal.taskWrites.push({ kind: "restore", bot, sid: task.sid });
          task.state = "ok";
        }
        if (task.state === "ok") {
          delete g.member[bot];
          announce(`Restored ${nm(bot)}'s task`);
        } else g.member[bot] = "archived";
        show(g);
      });
      return;
    }
    if ((el = on("[data-newtask]"))) {
      const bot = el.dataset.newtask;
      g.member[bot] = "starting";
      render();
      later(300, () => {
        const sid = sidFor(bot);
        journal.taskWrites.push({ kind: "create", bot, sid });
        gw.tasks[`${g.id}:${bot}`] = { sid, state: "ok", hasMore: false, log: [] };
        // The record names the new task only after a read-back says so; until then the old roster remains.
        const pre = readRecord(g.id);
        if (pre && pre !== "unreadable") {
          const wanted = { ...pre, members: pre.members.map((x) => (x.bot === bot ? { bot, sid } : x)) };
          writeRecord(g.id, wanted, pre);
          const rb = readRecord(g.id);
          if (rb && rb !== "unreadable" && sameRecord(rb, wanted)) {
            adopt(g, rb);
            delete g.member[bot];
            announce(`Started a new task for ${nm(bot)}`);
            return show(g);
          }
        }
        g.member[bot] = "taskgone";
        show(g);
      });
      return;
    }
    if ((el = on("[data-adopt]"))) {
      openDialog("confirm-adopt", el, { bot: el.dataset.adopt, gid: g.id });
      // Show the current task's history only from a read of it.
      later(200, () => {
        if (dlg.kind !== "confirm-adopt") return;
        dlg.history = clone(taskOf(g.id, dlg.bot).log);
        drawDialog();
      });
      return;
    }
    if (on("[data-do-adopt]")) {
      const target = dlgGroup();
      const bot = dlg.bot;
      const sid = taskOf(target.id, bot).sid;
      return change(
        target,
        (pre) => ({ ...pre, members: pre.members.map((x) => (x.bot === bot ? { bot, sid } : x)) }),
        () => {
          delete target.member[bot];
          for (const i of target.items) if (i.copies && i.copies[bot] === "changed") i.copies[bot] = "sent";
          closeDialog();
          render();
          announce(`Using the current task for ${nm(bot)}`);
        },
        {
          competing: () => {
            if (fail.delete("adoptconflict")) gw.records[target.id].members = gw.records[target.id].members.filter((x) => x.bot !== "otto");
          },
        },
      );
    }
    if ((el = on("[data-remove-member]"))) return openDialog("confirm-member", el, { bot: el.dataset.removeMember, gid: (dlgGroup() || g).id });
    if (on("[data-do-remove]")) {
      const target = dlgGroup();
      const bot = dlg.bot;
      return change(
        target,
        (pre) => ({ ...pre, members: pre.members.filter((x) => x.bot !== bot) }),
        () => {
          closeDialog();
          render();
          announce(`Removed ${nm(bot)} from the group`);
        },
        {
          competing: () => {
            if (fail.delete("memberconflict")) gw.records[target.id].members.push({ bot: "pip", sid: sidFor("pip") });
            if (fail.delete("competingremove")) gw.records[target.id].members = gw.records[target.id].members.filter((x) => x.bot !== "otto");
            if (fail.delete("unconfirmed")) fail.add("lostread");
          },
        },
      );
    }
    if (on("[data-check]")) return checkAgain(dlgGroup());
    if (on("[data-remove-group]")) return openDialog("confirm-group", $("#title-pill"), { gid: (dlgGroup() || g).id });
    if (on("[data-do-remove-group]")) {
      const target = dlgGroup();
      if (fail.delete("gone")) delete gw.records[target.id]; // another writer removed it first
      return change(
        target,
        () => null,
        () => {
          const present = presentTasks(target);
          groups.splice(groups.indexOf(target), 1);
          if (m.group === target) {
            m.group = null;
            m.view = { removed: true };
            m.stageNote = `Removed ${target.name}. ${possessive(present.map(nm))} ${present.length > 1 ? "tasks stay in their lists" : "task stays in its list"}.`;
          }
          closeDialog();
          render();
          announce("Removed the group");
        },
        {
          competing: () => {
            if (fail.delete("remove")) fail.add("timeout"), fail.add("readonce");
          },
        },
      );
    }
    if ((el = on("[data-open-task]"))) {
      const bot = el.dataset.openTask;
      closeDialog();
      m.view = { bot };
      return render();
    }

    // New group.
    if ((el = on("[data-pick]"))) {
      if (el.getAttribute("aria-disabled") === "true") return;
      const bot = el.dataset.pick;
      dlg.picked = dlg.picked.includes(bot) ? dlg.picked.filter((b) => b !== bot) : dlg.picked.concat(bot);
      drawDialog();
      return $(`[data-pick="${bot}"]`, dialog).focus();
    }
    if (on("[data-create]")) return create();
    if ((el = on("[data-retry-task]"))) {
      const row = dlg.making.find((r) => r.bot === el.dataset.retryTask);
      row.failed = false;
      dlg.error = null;
      drawDialog();
      return makeNext();
    }
    if ((el = on("[data-without]"))) {
      dlg.making = dlg.making.filter((r) => r.bot !== el.dataset.without);
      dlg.error = null;
      drawDialog();
      return makeNext();
    }
    if (on("[data-retry-record]")) {
      // A new pre-read, then the write with the tasks already made.
      dlg.error = null;
      drawDialog();
      return makeNext();
    }
    if (on("[data-check-new]")) {
      // Check again only reads.
      const rb = readRecord(dlg.gid);
      if (rb && rb !== "unreadable" && sameRecord(rb, dlg.wanted)) {
        dlg.making.find((r) => r.bot === "record").done = true;
        return finish(rb);
      }
      dlg.error = rb === null ? "record" : "readback";
      return drawDialog();
    }
    if ((el = on("[data-cancel-new]"))) {
      const made = dlg.making.filter((r) => r.bot !== "record" && r.done).map((r) => nm(r.bot));
      // "No group was made" only after a read confirms the record is absent.
      const confirmed = el.dataset.cancelNew === "absent" && readRecord(dlg.gid) === null;
      closeDialog();
      m.stageNote = confirmed ? `No group was made. ${possessive(made)} new tasks stay in their lists.` : `Couldn't confirm the group was saved. ${possessive(made)} new tasks stay in their lists.`;
      $("#g-stage")?.remove();
      $("#transcript").insertAdjacentHTML("afterbegin", `<p class="g-stage-note" id="g-stage" role="status">${esc(m.stageNote)}</p>`);
      return;
    }

    // Group details.
    if (on("[data-rename]")) {
      dlg.renaming = true;
      dlg.typed = dlgGroup().name;
      drawDialog();
      return $("#g-name").focus();
    }
    if (on("[data-cancel-name]")) {
      Object.assign(dlg, { renaming: false, result: null, typed: null });
      return drawDialog();
    }
    if (on("[data-save-name]")) return saveName();
    if ((el = on("[data-add]"))) {
      if (el.disabled) return;
      return openDialog("add", el, { add: null, adding: null, gid: (dlgGroup() || g).id });
    }
    if ((el = on("[data-add-pick]"))) {
      if (el.getAttribute("aria-disabled") === "true") return;
      dlg.add = el.dataset.addPick;
      drawDialog();
      return $(`[data-add-pick="${dlg.add}"]`, dialog).focus();
    }
    if (on("[data-do-add]")) {
      dlg.adding = dlg.add;
      drawDialog();
      later(300, () => {
        dlg.sid = sidFor(dlg.adding); // its sessions.create answered with this task
        journal.taskWrites.push({ kind: "create", bot: dlg.adding, sid: dlg.sid });
        addMember();
      });
      return;
    }
    if (on("[data-retry-add]")) {
      // The task made before is used again; only the record is written, after a new pre-read.
      dlg.result = null;
      return addMember();
    }
    if (on("[data-dback]")) return openDetails(opener, { gid: dlg.gid });
    if (on("[data-dclose]")) return closeDialog();

    if (on("[data-access]")) {
      m.access = "asking";
      renderComposer();
      later(500, () => {
        m.access = "requested";
        renderComposer();
        CT.hydrate(document);
      });
    }
  });

  function saveName() {
    const g = dlgGroup();
    const typed = ($("#g-name")?.value ?? "").trim();
    if (!typed) return;
    dlg.typed = typed;
    const c = params.get("conflict");
    change(
      g,
      (pre) => ({ ...pre, name: typed }),
      () => {
        Object.assign(dlg, { renaming: false, result: null, typed: null });
        render();
        drawDialog();
        announce("Saved the name");
        $("[data-rename]", dialog)?.focus();
      },
      {
        competing: () => {
          if (c === "1" && !dlg.conflicted) {
            dlg.conflicted = true;
            gw.records[g.id].name = "Saturday";
          }
          if (c === "refused" && !dlg.refused) {
            dlg.refused = true;
            fail.add("refuse");
          }
        },
      },
    );
  }

  document.addEventListener("input", (event) => {
    if (event.target.id === "g-input") {
      m.draft = event.target.value;
      const wasOpen = m.mentionOpen;
      m.mentionOpen = /(^|[\s(["'])@[\w-]*$/.test(m.draft);
      const caret = event.target.selectionStart;
      renderComposer();
      CT.hydrate($("#composer-slot"));
      const input = $("#g-input");
      input.focus();
      input.setSelectionRange(caret, caret);
      if (m.mentionOpen && !wasOpen) announce("Mention list open");
    }
    if (event.target.id === "g-name") {
      dlg.typed = event.target.value;
      const save = $("[data-save-name]", dialog);
      if (save) save.disabled = !event.target.value.trim();
    }
    if (event.target.id === "g-filter") {
      dlg.filter = event.target.value;
      const filter = dlg.filter.toLowerCase();
      for (const b of $$("[data-pick]", dialog)) b.closest("li").hidden = !!filter && !nm(b.dataset.pick).toLowerCase().includes(filter);
    }
  });

  // Back in the draft with the caret at its end.
  const focusDraft = () => {
    const input = $("#g-input");
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  };

  document.addEventListener("keydown", (event) => {
    if (event.target.id === "g-input") {
      if (m.mentionOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        return $(".g-mentions .menu-item")?.focus();
      }
      if (event.key === "Escape" && m.mentionOpen) {
        m.mentionOpen = false;
        renderComposer();
        return focusDraft();
      }
      if (event.key === "Escape" && m.reply && !m.draft) {
        m.reply = null;
        renderComposer();
        return $("#g-input").focus();
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        return send();
      }
    }
    if (event.target.closest?.("#rail-menu, .g-mentions")) {
      const items = $$(".menu-item", event.target.closest(".menu"));
      const i = items.indexOf(event.target);
      if (event.key === "ArrowDown") return event.preventDefault(), items[(i + 1) % items.length].focus();
      if (event.key === "ArrowUp") return event.preventDefault(), items[(i - 1 + items.length) % items.length].focus();
      if (event.key === "Escape") return event.target.closest("#rail-menu") ? closeMenu() : ((m.mentionOpen = false), renderComposer(), focusDraft());
    }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "n" && m.tier === "write") {
      event.preventDefault();
      openDialog("new", $("#new-button"), { picked: [], making: null, error: null });
    }
    const row = event.target.closest?.(".bot[data-group]");
    if (row && event.shiftKey && event.key === "F10") {
      event.preventDefault();
      groupMenu(row, groups.find((x) => x.id === row.dataset.group));
    }
  });

  document.addEventListener("contextmenu", (event) => {
    const row = event.target.closest(".bot[data-group]");
    if (!row) return;
    event.preventDefault();
    groupMenu(row, groups.find((x) => x.id === row.dataset.group), event.clientX, event.clientY);
  });

  // An answered approval: its own outcome settles the card, and the run goes on.
  document.addEventListener("ct:decision", (event) => {
    const g = groups.find((x) => x.items.some((i) => i.id === event.detail.card.id));
    if (!g) return;
    const item = g.items.find((i) => i.id === event.detail.card.id);
    const decision = event.detail.decision;
    later(decision === "always" ? 1000 : 50, () => {
      item.done = true;
      item.html = $(`#${item.id}`)?.outerHTML || item.html;
      const run = Object.values(g.runs).find((r) => r.id.endsWith(item.run));
      if (!run) return show(g);
      Object.assign(run, { state: "thinking", phrase: "Thinking", hold: false, phase: undefined });
      show(g);
      later(500, () =>
        finishRun(g, run.id, decision === "deny" ? "Understood. I won't list the files; tell me if you want me to look another way." : "It's steady at 71%. Nothing new has been written since this morning.", tick(), taskOf(g.id, run.bot)),
      );
    });
  });

  // An answered question, wherever its run began. Held copies to that bot are released only
  // when its last pending question is settled, through the one guarded send path.
  document.addEventListener("ct:question", (event) => {
    const g = groups.find((x) => x.items.some((i) => i.id === event.detail.card.id));
    if (!g) return;
    const q = g.items.find((i) => i.id === event.detail.card.id);
    q.done = true;
    q.html = $(`#${q.id}`)?.outerHTML;
    if (questionPending(g, q.task)) return show(g);
    const run = Object.values(g.runs).find((r) => r.bot === q.task);
    for (const it of g.items.filter((i) => i.copies && i.copies[q.task] === "held")) dispatch(g, it, q.task);
    show(g);
    later(600, () => {
      if (run) Object.assign(run, { state: "thinking", phrase: "Thinking", hold: false });
      show(g);
      if (run) later(500, () => finishRun(g, run.id, q.task === "juniper" ? "The lake loop, then. I'll plan for an 8 o'clock start." : "Thanks. I'll keep the cache for a week and clear it next Monday.", tick(), taskOf(g.id, q.task)));
    });
  });

  // The prototype bar: what the gateway or another device does.
  document.addEventListener("DOMContentLoaded", () => {
    const extra = $("#proto-extra");
    if (!extra) return;
    const buttons = [];
    if (m.offline) buttons.push('<button type="button" id="g-reconnect">Reconnect</button>');
    if (state0 === "readonly" || state0 === "other") buttons.push('<button type="button" id="g-phase">Approval answered elsewhere</button>');
    buttons.push('<button type="button" id="g-reload">Reload</button>');
    extra.innerHTML = `<span class="run-controls">${buttons.join("")}</span>`;
  });
  document.addEventListener("click", (event) => {
    const g = m.group;
    if (event.target.id === "g-reconnect") {
      m.offline = false;
      event.target.disabled = true;
      if (fail.delete("reconnectgone")) taskOf(g.id, "marlow").state = "gone"; // deleted while offline
      // Each held copy goes through the one guarded path, checked against the members now.
      for (const item of g.items.filter((i) => i.held)) {
        item.held = false;
        for (const b of Object.keys(item.copies)) dispatch(g, item, b);
      }
      announce("Connected");
      render();
    }
    if (event.target.id === "g-phase") {
      // The run's live phase ends: it no longer waits for approval.
      for (const r of Object.values(g.runs)) if (r.phase === "waiting-approval") Object.assign(r, { phase: undefined, state: "working", phrase: "Listing the workspace" });
      for (const i of g.items) if (i.kind === "approval") i.done = true;
      render();
    }
    if (event.target.id === "g-reload") {
      // A fresh read: only what the task histories hold. This device's local knowledge is gone.
      for (const x of groups) {
        x.items = x.items
          .filter((i) => i.kind !== "note")
          .map((i) => {
            if (i.kind !== "you" || !i.local) return { ...i, arriving: false };
            const kept = Object.entries(i.copies).filter(([, st]) => ["sent", "steer", "gqueued", "accepted", "changed"].includes(st));
            return kept.length ? { ...i, local: false, held: false, copies: Object.fromEntries(kept.map(([b]) => [b, "saved"])) } : null;
          })
          .filter(Boolean);
        x.notices = [];
      }
      render();
    }
  });

  // Start --------------------------------------------------------------------------------------

  render();

  const compose = params.get("compose");
  if (compose === "mention") {
    m.draft = "@";
    m.mentionOpen = true;
  }
  if (compose === "otto") m.draft = "@Otto how full is the media box now?";
  if (compose === "reply") {
    const j = weekend.items.find((i) => i.task === "juniper" && i.kind === "bot");
    m.reply = { bot: "juniper", id: j?.id, preview: fail.delete("replypreview") ? "Original message unavailable." : j?.text };
  }
  if (compose === "quote") m.draft = "> Marlow: I'll draft a short note for the neighbours about borrowing the trailer.\n> @Otto, can you print it?\n@Juniper is 8 still the right start?";
  if (compose === "ambiguous") m.draft = "@Otto are the bikes ready?";
  if (compose) renderComposer(), CT.hydrate(document);

  const open = params.get("open");
  const picks = (params.get("pick") || "").split(",").filter(Boolean);
  if (open === "new") openDialog("new", $("#new-button"), { picked: picks, making: null, error: null });
  if (open === "details") openDetails($("#title-pill"), { renaming: params.get("rename") === "1", typed: m.group?.name });
  const confirm = params.get("confirm");
  if (confirm === "member") openDialog("confirm-member", $("#title-pill"), { bot: "marlow", gid: "g1" });
  if (confirm === "group") openDialog("confirm-group", $("#title-pill"), { gid: "g1" });
  if (params.get("view") === "list") $(".shell").dataset.view = "list";
})();
