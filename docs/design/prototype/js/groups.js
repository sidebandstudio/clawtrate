// Group chats, as docs/design/group-chats.md specifies them. No gateway and no
// network: a small local model plays what the gateway answers, with the
// answers the research recorded (docs/research/group-chats.md).
//
// A group is a record of two to six tasks, one per bot. Everything the column
// shows comes from one of those tasks; everything sent is one message per
// chosen task. The address picks a state; section 16 of the design lists them.

(function () {
  const CT = window.CT;
  const params = CT.params;
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const esc = CT.esc;
  const icon = (name, cls) => CT.icon(name, cls);
  const later = (ms, fn) => setTimeout(fn, ms);

  // Three more bots, so that a group of six can be chosen. Names are invented.
  Object.assign(CT.bots, {
    extra1: { name: "Wren", label: "Errands" },
    extra2: { name: "Ivy", label: "Garden" },
    extra3: { name: "Basil", label: "Kitchen" },
    extra4: { name: "Otto", label: "Garage" }, // a second bot with Otto's name, for the ambiguous mention
  });
  const ALL = ["juniper", "otto", "marlow", "pip", "extra1", "extra2", "extra3"];
  const nm = (id) => CT.bots[id].name;
  const nmFull = (id, group) => (group.filter((b) => nm(b) === nm(id)).length > 1 ? `${nm(id)} (${CT.bots[id].label})` : nm(id));
  const ME = "Robin"; // the person's display name, from users.self
  const list = (names) =>
    names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const touch = () => document.documentElement.dataset.input === "touch";
  const announce = (text) => CT.announce(text);
  const time = (at) => (at >= 0 ? `5:${String(at).padStart(2, "0")} PM` : "Mon");

  // The model ------------------------------------------------------------------------------

  const state0 = params.get("state") || "open";
  const fail = new Set((params.get("fail") || "").split(",").filter(Boolean));
  let clock = 1000; // the gateway's clock, in the fixture's own units
  const tick = (n = 1) => (clock += n);
  let ids = 0;
  const nid = (p) => `${p}${++ids}`;

  const weekend = { id: "g1", name: "Weekend plans", members: state0 === "samename" ? ["juniper", "otto", "extra4"] : ["juniper", "otto", "marlow"], at: 41 };
  const dinner = { id: "g2", name: "Dinner plans", members: ["pip", "juniper"], at: params.get("dinner") === "recent" ? 50 : 35 };
  const m = {
    tier: state0 === "readonly" ? "read" : "write",
    device: state0 === "other" ? "other" : "this",
    offline: state0 === "offline",
    groups: state0 === "removed" ? [dinner] : [weekend, dinner],
    group: state0 === "removed" ? null : weekend,
    view: params.get("bot") ? { bot: params.get("bot") } : state0 === "removed" ? { removed: true } : { group: "g1" },
    member: {}, // a member's state: archived, taskgone, botgone, changed, restoring, starting
    items: [],
    runs: {}, // run id -> { id, bot, owner: "this" | "other", state, phrase, elapsed, queued, hold, partial }
    stopping: new Set(), // bots whose Stop is out
    notices: [], // { kind: "refused" | "timeout", bot, run }
    stopfail: new Set((params.get("stopfail") || "").split(",").filter(Boolean)),
    draft: "",
    reply: null,
    bind: {}, // a name two members share -> the member chosen for it
    mentionOpen: false,
    access: "read",
    stageNote: state0 === "removed" ? "Removed Weekend plans. Juniper's, Otto's and Marlow's tasks stay in their lists." : "",
    follow: true,
  };
  const bots = { juniper: 39, otto: 30, marlow: 25, pip: -1 };
  if (["archived", "taskgone", "botgone", "changed", "replaced"].includes(state0)) m.member.marlow = state0;
  // A copy refused because the task is archived: the group now knows the task is archived.
  if (state0 === "partial") m.member.marlow = "archived";

  const you = (text, copies, extra = {}) => ({ kind: "you", id: nid("y"), text, copies, ts: tick(), ...extra });
  const said = (bot, text, ts = tick()) => ({ kind: "bot", bot, text, id: nid("b"), ts });
  const all = (members, st) => Object.fromEntries(members.map((b) => [b, st]));

  function history() {
    const g = m.group;
    if (!g || state0 === "empty") return [];
    const ms = g.members;
    const base = [
      you("Plan Saturday for us: the trail in the morning, errands after lunch.", all(ms, "sent")),
      said(ms[2], ms[2] === "marlow" ? "I'll draft a short note for the neighbours about borrowing the trailer. @Otto, can you print it?" : "The garage door is fixed, so the bikes can come out."),
      said("juniper", "The forecast is clear until 2 PM, so start the trail by 8."),
      said("otto", "Done. The old cache folder is gone, so the media box has room for the trail photos."),
    ];
    if (state0 === "partial") {
      base.push(you("Can each of you add one thing to bring?", { juniper: "sent", otto: "sent", marlow: "failed" }, { open: true, why: { marlow: "Session … is archived. Restore it before starting new work." } }));
      base.push(said("juniper", "Water and the paper map."), said("otto", "A charged battery pack."));
    }
    if (state0 === "changed") base.push(you("Can each of you add one thing to bring?", { juniper: "sent", otto: "sent", marlow: "changed" }, { open: true }));
    if (["approval", "other", "both"].includes(state0)) base.push(you("@Otto is the media box disk still filling up?", { otto: "sent" }));
    if (["approval", "both", "other"].includes(state0)) base.push({ kind: "approval", bot: "otto", id: "g-approval", run: "a36bfcc7", ts: tick() });
    if (state0 === "both" || state0 === "other") base.push(you("@Juniper which route for Saturday?", { juniper: "sent" }), { kind: "question", bot: "juniper", id: "g-question", run: "f9adc2f3", ts: tick() });
    if (state0 === "question") base.push(you("@Otto should I clear the scratch cache before Saturday?", { otto: "sent" }), { kind: "question", bot: "otto", id: "g-question", run: "c51e0a77", ts: tick() });
    if (state0 === "offline") base.push(you("Bring sunscreen too.", all(ms, "held-offline"), { held: true }));
    return base;
  }

  dinner.items = [
    you("Dinner on Thursday: something quick with what's in the fridge.", { pip: "sent", juniper: "sent" }),
    said("pip", "Pasta with the spinach and the last of the feta."),
    said("juniper", "Twenty minutes, if the water is on first."),
  ];
  dinner.runs = {};
  dinner.member = {};

  // The rail ----------------------------------------------------------------------------------

  // new: the combined avatar.
  const stack = (members, badge = "") => {
    const shown = members.length > 4 ? members.slice(0, 3) : members;
    const more = members.length > 4 ? `<span class="g-more">+${members.length - 3}</span>` : "";
    return (
      `<span class="g-stack" data-count="${Math.min(members.length, 4)}" aria-hidden="true">` +
      shown.map((b) => `<span class="avatar">${CT.character(b)}</span>`).join("") +
      more +
      (badge ? CT.glyph(badge) : "") +
      `</span>`
    );
  };

  const pendingCards = (items) => items.filter((i) => (i.kind === "approval" || i.kind === "question") && !i.done);
  const runsOf = (g) => (g === m.group ? m.runs : g.runs || {});
  const itemsOf = (g) => (g === m.group ? m.items : g.items || []);

  function groupLine(g) {
    // A card this connection did not receive does not count as waiting for you here.
    const waiting = m.tier === "write" ? pendingCards(itemsOf(g)).filter((c) => m.device === "this" || c.kind === "question") : [];
    const who = [...new Set(waiting.map((c) => c.bot))];
    if (who.length === 1)
      return { text: `Waiting for you: ${nm(who[0])}, ${waiting[0].kind === "approval" ? "approve a command" : "a question"}`, tone: "waiting", badge: "waiting", state: "waiting for you" };
    if (who.length > 1) return { text: `Waiting for you: ${list(who.map(nm))}`, tone: "waiting", badge: "waiting", state: "waiting for you" };
    const working = [...new Set(Object.values(runsOf(g)).filter((r) => g.members.includes(r.bot) && !r.queued).map((r) => r.bot))];
    if (working.length) return { text: `${list(working.map(nm))} ${working.length > 1 ? "are" : "is"} working`, tone: "working", badge: "", state: "working" };
    const last = [...itemsOf(g)].reverse().find((i) => i.kind === "you" || i.kind === "bot");
    if (!last) return { text: "No messages yet", tone: "", badge: "", state: "idle" };
    return { text: `${last.kind === "you" ? "You" : nm(last.bot)}: ${last.text}`, tone: "", badge: "", state: "idle" };
  }

  function renderRail() {
    const rows = [];
    for (const g of m.groups) {
      const line = groupLine(g);
      rows.push({
        at: g.at,
        html:
          `<li class="bot-group"><button type="button" class="bot" data-group="${g.id}" aria-current="${m.view.group === g.id}" aria-haspopup="menu"` +
          ` aria-label="${esc(`${g.name}, group of ${g.members.length}: ${list(g.members.map((b) => nmFull(b, g.members)))}, ${line.state}`)}">` +
          stack(g.members, line.badge) +
          `<span class="bot-text"><span class="bot-line"><span class="bot-name">${esc(g.name)}</span><time class="bot-time">${line.state === "idle" ? time(g.at) : "now"}</time></span>` +
          `<span class="bot-line"><span class="bot-preview" data-state="${line.tone}">${esc(line.text)}</span></span></span></button></li>`,
      });
    }
    for (const id of ["juniper", "otto", "marlow", "pip"]) {
      if (id === "marlow" && m.member.marlow === "botgone") continue; // a deleted bot is not listed
      const g = m.group;
      const open = m.view.bot === id;
      const inGroup = g && g.members.includes(id);
      const tasks = open
        ? `<ul class="task-list" aria-label="${nm(id)}'s tasks">` +
          (inGroup
            ? `<li><button type="button" class="task" data-member-task="${id}" aria-current="true" aria-label="Plan Saturday for us, 5:41 PM, in the group ${esc(g.name)}">` +
              `<span class="task-title">Plan Saturday for us</span><time class="task-time">5:41 PM</time>${icon("helpers", "icon g-task-mark")}</button></li>`
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
    // Bots and groups in one list, by recent activity.
    $("#bot-list").innerHTML = rows.sort((a, b) => b.at - a.at).map((r) => r.html).join("");
    $("#new-button").hidden = m.tier === "read";
  }

  // The column ------------------------------------------------------------------------------

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
    gqueued: "Queued by the gateway behind the turn now running.",
    held: "Held on this device until you answer its question.",
    queued: "Queued on this device until its run stops.",
    "held-offline": "Held on this device until the connection returns.",
    failed: "Couldn't send.",
    changed: "The gateway accepted it in a new task at this task's place.",
    notsent: "Not sent.",
  };
  const ORDER = Object.keys(COPY);
  const possessive = (names) => list(names.map((n) => `${n}'s`));
  const who = (b) => nmFull(b, m.group ? m.group.members : [b]); // a name two members share carries the bot's label

  // The words of the where-it-went line. A device that did not send the message
  // knows only the copies it found in the task histories.
  function wentWords(item) {
    if (item.held) return "Sends when reconnected";
    if (m.device === "other" || item.foreign) {
      const found = Object.entries(item.copies).filter(([, st]) => ["sent", "steer", "accepted", "gqueued", "changed"].includes(st)).map(([b]) => who(b));
      return `In ${possessive(found)} task ${found.length > 1 ? "histories" : "history"}`;
    }
    const by = {};
    for (const [bot, st] of Object.entries(item.copies)) (by[st] ||= []).push(who(bot));
    return ORDER.filter((s) => by[s]).map((s) => COPY[s](list(by[s]))).join(" · ");
  }

  function wentLine(item) {
    const words = wentWords(item);
    if (item.held) return `<div class="g-went"><span class="msg-caption">${words}</span></div>`;
    if (m.device === "other" || item.foreign) return `<div class="g-went"><span class="msg-caption">${esc(words)}</span></div>`;
    const by = {};
    for (const [bot, st] of Object.entries(item.copies)) (by[st] ||= []).push(who(bot));
    const parts = ORDER.filter((s) => by[s]).map((s) => `<span${s === "failed" || s === "notsent" ? ' data-tone="danger"' : ""}>${COPY[s](list(by[s]))}</span>`);
    const rows = Object.entries(item.copies)
      .map(([bot, st]) => {
        const name = nm(bot);
        let why = "";
        if (st === "failed") {
          why = ` The gateway answered: ${esc(item.why?.[bot] || "")}`;
          if (!m.member[bot] && m.tier === "write") why += ` ${CT.linkButton(`Resend to ${name}`, { attrs: `data-resend="${item.id}:${bot}"` })}`;
        }
        if (st === "notsent" && item.removed?.includes(bot)) why = ` ${name} is no longer in this group.`;
        return `<li><b>${name}</b>: ${ROW[st]}${why}</li>`;
      })
      .join("");
    return (
      `<div class="g-went"><button type="button" data-went="${item.id}" aria-expanded="${!!item.open}">${parts.join(" · ")}</button>` +
      (item.open ? `<ul>${rows}</ul>` : "") +
      `</div>`
    );
  }

  const canRemoveMember = () => m.group.members.length > 2;
  function memberActions(bot, first) {
    const name = nm(bot);
    if (m.tier !== "write") return "";
    // At two members every entry point offers the same choices: a replacement, or removing the group.
    const rest = canRemoveMember() ? CT.button(`Remove ${name}`, `data-remove-member="${bot}"`) : CT.button("Add a bot", 'data-add="1"') + CT.button("Remove group…", 'data-remove-group="1"');
    return (first || "") + rest;
  }

  const memberLine = (bot) => {
    const s = m.member[bot];
    const name = nm(bot);
    if (!s) return "";
    const text = {
      archived: `${name}'s task in this group is archived. Messages to everyone skip ${name}.`,
      taskgone: `${name}'s task in this group was deleted. Messages to everyone skip ${name}.`,
      botgone: `${name} was deleted, with its tasks. Messages to everyone skip ${name}.`,
      changed: `${name}'s task changed during the send. The gateway accepted a copy in a new task. Messages to everyone skip ${name} until you choose.`,
      replaced: `${name}'s task was replaced: a new task is at its place. Messages to everyone skip ${name} until you choose.`,
      restoring: `Restoring ${name}'s task…`,
      starting: `Starting a new task for ${name}…`,
    }[s];
    const actions =
      s === "archived"
        ? memberActions(bot, CT.button(`Restore ${name}'s task`, `data-restore="${bot}"`))
        : s === "taskgone"
          ? memberActions(bot, CT.button(`Start a new task for ${name}`, `data-newtask="${bot}"`))
          : s === "changed" || s === "replaced"
            ? memberActions(bot, CT.button("Use the new task", `data-adopt="${bot}"`))
            : s === "botgone"
              ? memberActions(bot)
              : "";
    return `<div class="g-line" data-member-line="${bot}"${s === "restoring" || s === "starting" ? ' aria-busy="true"' : ""}><span>${esc(text)}</span>${actions}</div>`;
  };

  // The question each fixture bot asks; Juniper's is the route question the research's run asked.
  const QUESTIONS = {
    otto: CT.samples.question,
    juniper: { title: "Which route should I plan for Saturday?", options: [["Lake loop", "3 miles, mostly flat"], ["Ridge trail", "6 miles, one steep climb"], ["Town walk"]] },
  };
  const questionPending = (bot) => m.items.some((i) => i.kind === "question" && i.bot === bot && !i.done);
  const sendable = () => m.group.members.filter((b) => !m.member[b]);
  const activeRuns = () => Object.values(m.runs).filter((r) => m.group.members.includes(r.bot));

  function sortItems() {
    const order = (b) => m.group.members.indexOf(b);
    m.items.sort((a, b) => a.ts - b.ts || order(a.bot) - order(b.bot));
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
    // The reading position: kept, unless the reader was at the end or just sent.
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    const top = el.scrollTop;
    // A card the person has answered keeps what behaviors.js made of it.
    const keep = {};
    for (const id of ["g-approval", "g-question"]) keep[id] = $(`#${id}`)?.outerHTML;
    const first = "Clawtrate sends each bot a separate copy. It doesn't pass bot replies between tasks.";
    const body = [];
    if (!m.items.length) {
      body.push(`<div class="g-empty">${stack(g.members)}<h1>${esc(g.name)}</h1><p>${esc(first)}</p><p>Write to everyone, or start with @ to choose who answers.</p></div>`);
    } else {
      body.push(`<p class="g-first">${esc(first)}</p>`, CT.stamp("Today 5:36 PM"));
      m.items.forEach((item, i) => {
        const prev = m.items[i - 1];
        const next = m.items[i + 1];
        if (item.kind === "you") {
          body.push(
            `<div class="turn" data-role="user"${item.held ? ' data-waiting="true"' : ""}>` +
              `<div class="msg" data-role="user" role="group" aria-label="${esc(`You said: ${item.text}${/[.!?]$/.test(item.text) ? "" : "."} ${wentWords(item)}.`)}"><div class="bubble">${esc(item.text)}</div></div>` +
              wentLine(item) +
              `</div>`,
          );
        } else if (item.kind === "bot") {
          const firstOfRun = !(prev && prev.kind !== "you" && prev.bot === item.bot);
          const lastOfRun = !(next && next.kind === "bot" && next.bot === item.bot);
          body.push(
            (firstOfRun ? `<p class="g-speaker" aria-hidden="true">${esc(who(item.bot))}</p>` : "") +
              `<div class="g-said" data-said="${item.id}"><span class="g-foot">${lastOfRun ? `<span class="avatar" aria-hidden="true">${CT.character(item.bot)}</span>` : ""}</span>` +
              `<div class="msg" data-role="assistant" role="group" aria-label="${esc(`${who(item.bot)} said: ${item.text}`)}"><div class="bubble">${esc(item.text)}</div></div>` +
              (m.tier === "write"
                ? `<button type="button" class="icon-button" data-msg-menu="${item.id}" aria-haspopup="menu" aria-expanded="false" aria-label="More for ${nm(item.bot)}'s message">${icon("more")}</button>`
                : "") +
              `</div>`,
          );
        } else if (item.kind === "approval") {
          if (m.device === "other") return; // this connection did not receive it
          body.push(`<p class="g-speaker" aria-hidden="true">${nm(item.bot)}</p>`);
          body.push(
            keep["g-approval"] ||
              CT.approval({
                id: "g-approval",
                bot: item.bot,
                summary: "List the files in <b>Otto's workspace</b> on <b>media-box</b>.",
                line: "List the files in Otto's workspace",
                asker: { line: `In Otto's task in this group, run ${item.run}.` },
                full: { reason: "Otto wants to see what is using the space.", command: "ls", fields: [["Runs on", "media-box"], ["Folder", "~/workspace"], ["Asked by", "Otto"], ["Run", item.run]] },
                request: { command: "ls", cwd: "~/workspace", host: "media-box", agent: "Otto" },
                raw: CT.samples.approvalRaw(),
              }),
          );
        } else if (item.kind === "question") {
          body.push(`<p class="g-speaker" aria-hidden="true">${nm(item.bot)}</p>`);
          body.push(item.html || keep["g-question"] || CT.question({ id: "g-question", bot: item.bot, ...QUESTIONS[item.bot], raw: CT.samples.questionRaw() }));
        } else if (item.kind === "note") {
          body.push(CT.turnNote({ lead: CT.glyph("stopped"), html: item.html }));
        }
      });
    }
    for (const bot of g.members) body.push(memberLine(bot));
    // A wait this connection has no card for: said without claiming where the card went.
    const hidden = m.device === "other" ? m.items.filter((i) => i.kind === "approval" && !i.done) : [];
    for (const card of hidden)
      body.push(`<div class="g-line" data-member-line="${card.bot}-wait"><span>${nm(card.bot)} is waiting for approval. This connection has no approval card for this run.</span></div>`);
    // One status line per run still active, in member order; a reply that streams sits under its line.
    const runs = activeRuns().sort((a, b) => g.members.indexOf(a.bot) - g.members.indexOf(b.bot));
    const lines = runs.map(
      (r) =>
        CT.statusLine({ bot: r.bot, state: r.state, phrase: r.phrase, elapsed: r.elapsed || "", steps: r.state === "working" }) +
        (r.partial ? `<div class="msg" data-role="assistant" data-streaming="${r.bot}"><div class="bubble" aria-busy="true">${esc(r.partial)}<span class="stream-caret"></span></div></div>` : ""),
    );
    for (const card of hidden) lines.push(CT.statusLine({ bot: card.bot, state: "blocked", phrase: "Waiting for an answer", steps: false }));
    if (lines.length) body.push(`<div class="g-status">${lines.join("")}</div>`);
    el.innerHTML = `<div class="transcript-inner">${body.join("")}</div>`;
    CT.hydrate(el);
    if (m.follow || atEnd) el.scrollTop = el.scrollHeight;
    else el.scrollTop = top;
    m.follow = false;
  }

  function renderMemberTask(el) {
    const bot = m.view.bot;
    const name = nm(bot);
    const mine = m.items.filter((i) => (i.kind === "you" && i.copies[bot]) || (i.kind === "bot" && i.bot === bot));
    el.innerHTML =
      `<div class="transcript-inner"><h1 class="task-line">Plan Saturday for us</h1>` +
      `<div class="g-line" data-member-line="part"><span>This task is part of ${esc(m.group.name)}. Only your messages to ${name} are here.</span>${CT.button("Open the group", 'data-open-group="1"')}</div>` +
      mine
        .map((i) =>
          i.kind === "you"
            ? `<div class="turn" data-role="user">${CT.msg({ role: "user", html: esc(i.text) })}</div>`
            : `<div class="turn" data-role="assistant">${CT.msg({ html: esc(i.text) })}</div>`,
        )
        .join("") +
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
    pill.innerHTML = `${stack(m.group.members)}<span class="title-pill-name">${esc(m.group.name)}</span>`;
    pill.setAttribute("aria-label", `${m.group.name}. Group details`);
  }

  // Who receives a message ----------------------------------------------------------------------

  // One rule, used for the To line, Send's name and the sends alike:
  //  1. a Reply goes to the bot replied to, and nothing in the text changes that;
  //  2. otherwise mentions are read from the text outside quoted lines (a line starting with ">"):
  //     "@" at the start or after a space or an opening mark, then a member's name, ending at the
  //     end of the text, a space or punctuation other than "-" and "_";
  //  3. "@everyone", or no mention of a member, means every eligible member;
  //  4. otherwise the members named, among the eligible ones;
  //  5. a name two members share needs a choice before anything is sent.
  function resolve() {
    const g = m.group;
    if (m.reply) return { bots: [m.reply.bot], everyone: false, reply: true, ambiguous: [] };
    const text = m.draft
      .split("\n")
      .filter((line) => !/^\s*>/.test(line))
      .join("\n");
    const named = [];
    const ambiguous = [];
    let everyone = false;
    for (const match of text.matchAll(/(^|[\s(["'])@([A-Za-z0-9_-]+)/g)) {
      const word = match[2].toLowerCase();
      if (word === "everyone") everyone = true;
      const hits = g.members.filter((b) => nm(b).toLowerCase() === word);
      if (hits.length === 1) named.push(hits[0]);
      if (hits.length > 1) {
        if (hits.includes(m.bind[word])) named.push(m.bind[word]);
        else ambiguous.push({ word, hits });
      }
    }
    if (ambiguous.length) return { bots: [], everyone: false, reply: false, ambiguous };
    if (everyone || !named.length) return { bots: sendable(), everyone: true, reply: false, ambiguous };
    return { bots: g.members.filter((b) => named.includes(b) && !m.member[b]), named: g.members.filter((b) => named.includes(b)), everyone: false, reply: false, ambiguous };
  }

  const chip = (bot, extra = "") => `<span class="g-chip"${extra}><span class="avatar" aria-hidden="true">${CT.character(bot)}</span>${esc(nmFull(bot, m.group.members))}</span>`;
  const WHY = { archived: "task archived", taskgone: "task deleted", botgone: "bot deleted", changed: "task changed", replaced: "task replaced", restoring: "task archived", starting: "task deleted" };
  const toWords = (t) =>
    t.ambiguous.length
      ? `@${nm(t.ambiguous[0].hits[0])} matches ${t.ambiguous[0].hits.length} members. Choose one in the list.`
      : t.everyone
        ? "To Everyone"
        : `To ${list(t.bots.map((b) => nmFull(b, m.group.members)))}${t.reply ? " (replying)" : ""}`;
  const sendWords = (t) => (t.ambiguous.length ? "Send" : t.everyone ? "Send to everyone" : `Send to ${list(t.bots.map((b) => nmFull(b, m.group.members)))}`);

  function toLine(t) {
    if (t.ambiguous.length) return `<div class="g-to" data-tone="warn" aria-label="${esc(toWords(t))}"><span>${esc(toWords(t))}</span></div>`;
    const skipped = (t.everyone ? m.group.members : t.named || []).filter((b) => m.member[b]);
    const n = t.bots.length;
    return (
      `<div class="g-to" aria-label="${esc(`${toWords(t)}. ${n} ${n === 1 ? "bot" : "bots"}. Each bot that answers uses its own tokens.`)}"><span>To</span>` +
      (t.everyone ? `<span class="g-chip" data-everyone>Everyone</span>` : t.bots.map((b) => chip(b)).join("")) +
      (t.reply ? `<span>(replying)</span>` : "") +
      skipped.map((b) => chip(b, ` data-skipped aria-label="${nm(b)}, skipped: ${WHY[m.member[b]]}"`)).join("") +
      `<span class="g-cost">${n} ${n === 1 ? "bot" : "bots"} · Each bot that answers uses its own tokens</span>` +
      `</div>`
    );
  }

  function renderComposer() {
    const slot = $("#composer-slot");
    if (!m.group || m.view.removed || m.view.bot) {
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
    const t = resolve();
    const working = [...new Set(activeRuns().filter((r) => !r.queued).map((r) => r.bot))];
    const shelf = [];
    for (const card of m.device === "this" ? pendingCards(m.items) : pendingCards(m.items).filter((c) => c.kind === "question")) {
      shelf.push(
        card.kind === "approval"
          ? CT.shelfRow({ tone: "warn", lead: CT.glyph("waiting"), text: `${nm(card.bot)} needs your approval to run a command`, actions: CT.button("Review", 'data-review="1"') })
          : CT.shelfRow({ tone: "warn", lead: CT.glyph("waiting"), text: `${nm(card.bot)} asked you a question. A message to ${nm(card.bot)} now is held until you answer.`, actions: CT.button("Review", 'data-review-question="1"') }),
      );
    }
    for (const n of m.notices) {
      if (n.kind === "refused")
        shelf.push(CT.shelfRow({ tone: "warn", lead: icon("warning"), text: `<b>Couldn't stop ${nm(n.bot)}'s run from this device.</b> <span>It is still working.</span>` }));
      if (n.kind === "timeout")
        shelf.push(CT.shelfRow({ tone: "danger", lead: icon("warning"), text: `<b>No answer about ${nm(n.bot)}'s run.</b> <span>It may still be working.</span>`, actions: CT.button("Try again", `data-stop-again="${n.run}"`) }));
    }
    if (m.reply)
      shelf.push(
        `<div class="shelf-row g-replying"><span class="shelf-text"><b>Replying to ${nm(m.reply.bot)}</b> <span>${esc(m.reply.text)}</span></span>` +
          `<button type="button" class="icon-button" data-cancel-reply="1" aria-label="Cancel reply">${icon("x")}</button></div>`,
      );
    const empty = !m.draft.trim();
    const stoppable = working.filter((b) => !m.stopping.has(b));
    slot.innerHTML =
      `<footer class="composer" data-run="${working.length ? "running" : "idle"}"><div class="composer-inner">` +
      `<div class="composer-shelf">${shelf.join("")}</div>` +
      `<div class="composer-box">${toLine(t)}<div class="composer-row">` +
      `<textarea class="composer-input" id="g-input" rows="1" aria-label="Message the group" placeholder="${m.offline ? "Offline. Messages send when you reconnect." : "Message the group"}">${esc(m.draft)}</textarea>` +
      (m.stopping.size ? `<span class="composer-status">Stopping…</span>` : "") +
      (stoppable.length && !m.stopping.size
        ? `<button type="button" class="icon-button stop-button" data-stop="1" aria-label="Stop ${stoppable.length} ${stoppable.length === 1 ? "bot" : "bots"}" title="Stop (⌘.)"></button>`
        : "") +
      `<button type="button" class="icon-button send-button" data-send="1" aria-label="${esc(sendWords(t))}" title="${esc(sendWords(t))}"${empty || !t.bots.length ? " disabled" : ""}>${icon("arrow-up")}</button>` +
      `</div></div>` +
      (m.mentionOpen || t.ambiguous.length ? mentionMenu(t) : "") +
      `</div></footer>`;
  }

  function mentionMenu(t) {
    const items = t.ambiguous.length
      ? t.ambiguous[0].hits.map((b) => [b, nmFull(b, m.group.members), `data-bind="${b}" data-word="${t.ambiguous[0].word}"`])
      : [["everyone", "Everyone", 'data-mention="everyone"'], ...m.group.members.map((b) => [b, nmFull(b, m.group.members), `data-mention="${b}"`])];
    return (
      `<ul class="menu g-mentions" role="menu" aria-label="${t.ambiguous.length ? "Choose who" : "Mention"}">` +
      items
        .map(
          ([id, label, attr]) =>
            `<li role="none"><button type="button" class="menu-item" role="menuitem" ${attr}>` +
            (id === "everyone" ? "" : `<span class="avatar" aria-hidden="true">${CT.character(id)}</span>`) +
            `${esc(label)}</button></li>`,
        )
        .join("") +
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

  // Sending -----------------------------------------------------------------------------------

  const REPLIES = {
    juniper: "Noted. I'll check the forecast again on Friday evening.",
    otto: "Will do. I'll keep an eye on the media box while you're out.",
    marlow: "Got it. I'll add it to the note for the neighbours.",
    extra4: "The bikes are by the garage door.",
    pip: "Noted.",
  };
  // How long each scripted reply takes, and where the gateway's saved time puts it:
  // Otto streams longest but its saved reply sorts first (research §2).
  const TIMING = { juniper: [600, 3], marlow: [900, 2], otto: [1300, 1], extra4: [700, 2], pip: [600, 1] };

  function send() {
    const text = m.draft.trim();
    const t = resolve();
    if (!text || !t.bots.length) return;
    const copies = {};
    for (const b of t.bots) {
      if (m.offline) copies[b] = "held-offline";
      else if (m.stopping.has(b)) copies[b] = "queued"; // the stopping rule comes first (conversation.md §15)
      else if (questionPending(b)) copies[b] = "held";
      else copies[b] = "sending";
    }
    const item = you(text, copies, m.offline ? { held: true } : {});
    m.items.push(item);
    m.draft = "";
    m.reply = null;
    m.mentionOpen = false;
    m.follow = true;
    render();
    const out = t.bots.filter((b) => copies[b] === "sending");
    if (!out.length) return;
    later(300, () => {
      for (const b of out) {
        if (fail.has("vanish") && b === "marlow") {
          // The guarded send is refused: the task went between the check and the send.
          fail.delete("vanish");
          copies[b] = "failed";
          (item.why ||= {})[b] = "active branch changed; review and retry";
          m.member[b] = "taskgone"; // read back: nothing at the key
          continue;
        }
        copies[b] = "accepted";
      }
      render();
      later(200, () => {
        for (const b of out.filter((x) => copies[x] === "accepted")) {
          const running = activeRuns().filter((r) => r.bot === b);
          if (running.some((r) => r.owner === "other" && !r.queued)) {
            copies[b] = "gqueued";
            const id = nid("r");
            m.runs[id] = { id, bot: b, owner: "this", queued: true, state: "idle", phrase: "Queued by the gateway" };
          } else if (running.length) copies[b] = "steer";
          else {
            copies[b] = "sent";
            startRun(b, REPLIES[b] || "Noted.", item.ts);
          }
        }
        announce(`Sent to ${list(out.filter((x) => ["sent", "steer", "gqueued"].includes(copies[x])).map(nm))}`);
        render();
      });
    });
  }

  function startRun(bot, reply, sentTs, id = nid("r"), owner = "this") {
    const [delay, offset] = TIMING[bot] || [600, 1];
    m.runs[id] = { id, bot, owner, state: "thinking", phrase: "Thinking", elapsed: "0:01" };
    announce(`${nm(bot)} is working`);
    later(200, () => {
      if (!m.runs[id] || m.runs[id].hold) return;
      m.runs[id].partial = reply.slice(0, Math.ceil(reply.length / 2));
      render();
    });
    later(delay, () => {
      if (!m.runs[id] || m.runs[id].hold) return;
      delete m.runs[id];
      // The reply takes its place by the gateway's saved time, not by when it finished.
      m.items.push(said(bot, reply, sentTs + offset / 10));
      sortItems();
      announce(`${nm(bot)} finished`);
      render();
    });
    return id;
  }

  // Stop asks the gateway to stop eligible runs in each working member's task: one
  // chat.abort per task. It names each run the answer confirms, says a refusal as one,
  // and leaves every run still active on screen until its own result.
  function stop(onlyRun) {
    const targets = onlyRun ? [m.runs[onlyRun]?.bot].filter(Boolean) : [...new Set(activeRuns().filter((r) => !r.queued).map((r) => r.bot))];
    if (!targets.length) return;
    m.notices = m.notices.filter((n) => !targets.includes(n.bot));
    for (const b of targets) m.stopping.add(b);
    const before = activeRuns().filter((r) => targets.includes(r.bot) && !r.queued);
    for (const r of before) r.saved = { state: r.state, phrase: r.phrase };
    for (const r of before) Object.assign(r, { state: "stopping", phrase: "Stopping…" });
    announce(`Stopping ${targets.length} ${targets.length === 1 ? "bot" : "bots"}`);
    render();
    later(600, () => {
      const stopped = [];
      for (const b of targets) {
        m.stopping.delete(b);
        const mine = before.filter((r) => r.bot === b && r.owner === "this");
        const theirs = before.filter((r) => r.bot === b && r.owner === "other");
        if (m.stopfail.delete(b)) {
          for (const r of [...mine, ...theirs]) Object.assign(r, r.saved);
          m.notices.push({ kind: "timeout", bot: b, run: (mine[0] || theirs[0]).id });
          continue;
        }
        for (const r of mine) delete m.runs[r.id];
        if (mine.length) stopped.push(b);
        for (const r of theirs) Object.assign(r, r.saved); // still live: this device may not stop it
        if (!mine.length && theirs.length) m.notices.push({ kind: "refused", bot: b });
        if (mine.length) {
          // Held and queued copies are cancelled for this member's stopped run only.
          for (const i of m.items) if (i.copies && ["held", "queued"].includes(i.copies[b])) i.copies[b] = "notsent";
          const q = m.items.find((i) => i.kind === "question" && i.bot === b && !i.done);
          if (q) {
            q.done = true;
            q.html = CT.questionAnswered({ id: "g-question", questions: [{ title: QUESTIONS[b].title, answers: [] }], state: "cancelled", raw: CT.samples.questionRaw({ dismissed: true }) });
          }
          // A turn the gateway queued in the same task was not stopped: it starts now and shows its own result.
          for (const q2 of Object.values(m.runs).filter((r) => r.bot === b && r.queued)) {
            delete m.runs[q2.id];
            if (q2.owner === "other") m.items.push(you(q2.text, { [b]: "sent" }, { foreign: true }));
            startRun(b, q2.reply || REPLIES[b], tick(), q2.id, q2.owner);
          }
        }
      }
      if (stopped.length) {
        m.items.push({ kind: "note", ts: tick(), html: `<p><b>Stopped.</b> ${possessive(stopped.map(nm))} ${stopped.length > 1 ? "runs" : "run"} stopped. Completed actions are not undone.</p>` });
        announce("Stopped");
      }
      for (const n of m.notices) announce(n.kind === "refused" ? `Couldn't stop ${nm(n.bot)}'s run from this device` : `No answer about ${nm(n.bot)}'s run`);
      render();
    });
  }

  // Dialogs -----------------------------------------------------------------------------------

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

  const head = (title, back = false) =>
    `<header class="b-head">${back ? `<button type="button" class="icon-button b-back" data-dback="1" aria-label="Back">${icon("back")}</button>` : ""}` +
    `<h2 id="g-dialog-title" tabindex="-1">${esc(title)}</h2>` +
    `<button type="button" class="icon-button b-close" data-dclose="1" aria-label="Close">${icon("x")}</button></header>`;
  const note = (tone, html) => `<div class="b-note"${tone ? ` data-tone="${tone}"` : ""}>${icon(tone ? "warning" : "helpers")}<div><p>${html}</p></div></div>`;
  const choice = (bot, checked, disabled, attr) =>
    `<li><button type="button" class="b-choice" role="checkbox" aria-checked="${checked}" ${attr}="${bot}"${disabled ? ' aria-disabled="true"' : ""}>` +
    `<span class="avatar" aria-hidden="true">${CT.character(bot)}</span><span class="b-choice-text"><span class="b-choice-title">${nm(bot)}</span>` +
    `<span class="b-choice-sub">${disabled && !checked ? "A group has at most 6 bots." : CT.bots[bot].label}</span></span>${checked ? icon("check", "icon b-tick") : ""}</button></li>`;
  const actions = (...buttons) => `<div class="b-actions">${buttons.join("")}</div>`;
  const btn = (label, attr, variant = "") => `<button type="button" class="button"${variant ? ` data-variant="${variant}"` : ""} ${attr}>${label}</button>`;

  function drawDialog() {
    const k = dlg.kind;
    let html = "";
    if (k === "new") html = newGroupHtml();
    if (k === "details") html = detailsHtml();
    if (k === "add") html = addHtml();
    if (k === "confirm-member") html = confirmMemberHtml();
    if (k === "confirm-group") html = confirmGroupHtml();
    if (k === "confirm-adopt") {
      const name = nm(dlg.bot);
      html =
        head(`Use ${name}'s new task in ${m.group.name}?`) +
        `<div class="b-body"><p>${m.member[dlg.bot] === "replaced" ? "The new task holds only what was sent to it since it was made." : "The new task holds only the copy the gateway just accepted."} ${name}'s earlier messages in this group were in the task that was deleted.</p></div>` +
        `<div class="b-foot">${actions(btn("Use the new task", 'data-do-adopt="1" data-autofocus', "primary"), btn("Cancel", 'data-dclose="1"'))}</div>`;
    }
    dialog.innerHTML = `<div class="b-sheet">${html}</div>`;
    CT.hydrate(dialog);
  }

  // A change to the group: the record is read before, written by compare-and-set and read after.
  // `result` is what the read-back shows when the write failed, timed out or met a change.
  function changeResult() {
    if (dlg.result === "conflict") return note("warn", `This group changed on another device. It now has ${esc(list(m.group.members.map(nm)))}.`);
    if (dlg.result === "unconfirmed") return note("warn", "<b>Couldn't confirm the change.</b>");
    if (dlg.result === "kept") return note("", `${esc(m.group.name)} is still saved, with ${esc(list(m.group.members.map(nm)))}.`);
    return "";
  }

  function confirmMemberHtml() {
    const bot = dlg.bot;
    const name = nm(bot);
    const s = m.member[bot];
    const what =
      s === "botgone"
        ? `${name} was deleted, with its tasks. Clawtrate skips ${name} in future group sends.`
        : s === "taskgone"
          ? `${name}'s task in this group was deleted. Clawtrate skips ${name} in future group sends.`
          : `${name}'s task and its history stay in ${name}'s list. Clawtrate skips ${name} in future group sends. Work the gateway already accepted can continue.`;
    return (
      head(`Remove ${name} from ${m.group.name}?`) +
      `<div class="b-body"><p>${what}</p>${changeResult()}</div>` +
      `<div class="b-foot">${actions(
        dlg.result === "unconfirmed"
          ? btn("Check again", 'data-check-member="1" data-autofocus', "primary")
          : `<button type="button" class="button" data-tone="danger" data-do-remove="${bot}" data-autofocus${dlg.busy ? " disabled" : ""}>${dlg.busy ? "Removing…" : dlg.result === "conflict" ? "Remove anyway" : "Remove"}</button>`,
        btn("Cancel", 'data-dclose="1"'),
      )}</div>`
    );
  }

  function presentTasks() {
    return m.group.members.filter((b) => !["taskgone", "botgone"].includes(m.member[b]));
  }

  function confirmGroupHtml() {
    const present = presentTasks();
    const gone = m.group.members.filter((b) => !present.includes(b));
    return (
      head(`Remove ${m.group.name}?`) +
      `<div class="b-body"><p>${esc(possessive(present.map(nm)))} ${present.length > 1 ? "tasks stay" : "task stays"} in ${present.length > 1 ? "their lists" : "its list"}, with everything in ${present.length > 1 ? "them" : "it"}.` +
      (gone.length ? ` ${esc(possessive(gone.map(nm)))} task is already gone.` : "") +
      ` Only the group goes, on all your devices. Nothing running is stopped.</p>${changeResult()}</div>` +
      `<div class="b-foot">${actions(
        dlg.result === "unconfirmed"
          ? btn("Check again", 'data-check-group="1" data-autofocus', "primary")
          : `<button type="button" class="button" data-tone="danger" data-do-remove-group="1" data-autofocus${dlg.busy ? " disabled" : ""}>${dlg.busy ? "Removing…" : "Remove group"}</button>`,
        btn("Cancel", 'data-dclose="1"'),
      )}</div>`
    );
  }

  // New group: choose, make each task, save the record, read it back.
  function newGroupHtml() {
    if (fail.has("noprefs"))
      return head("New group") + `<div class="b-body">${note("warn", "This connection can't keep preferences on the gateway, so it can't keep a group.")}</div><div class="b-foot">${actions(btn("Close", 'data-dclose="1" data-autofocus'))}</div>`;
    const picked = dlg.picked;
    if (dlg.making) {
      const rows = dlg.making
        .map((r) =>
          r.bot === "record"
            ? `<li${r.done ? " data-done" : ""}>${r.done ? icon("check") : CT.glyph("sending")}${r.done ? "Group saved" : "Saving the group…"}</li>`
            : `<li${r.done ? " data-done" : ""}><span class="avatar" aria-hidden="true">${CT.character(r.bot)}</span>${r.done ? `${nm(r.bot)}'s task made` : r.failed ? `Couldn't make ${nm(r.bot)}'s task` : `Making ${nm(r.bot)}'s task…`}</li>`,
        )
        .join("");
      const made = dlg.making.filter((r) => r.bot !== "record" && r.done).map((r) => nm(r.bot));
      const failed = dlg.making.find((r) => r.failed);
      let tail = "";
      if (dlg.error === "task")
        tail =
          note("danger", `<b>Made tasks for ${list(made)}. Couldn't make one for ${nm(failed.bot)}.</b> The gateway answered: Unknown agent id "${failed.bot}".`) +
          actions(
            btn(`Try ${nm(failed.bot)} again`, `data-retry-task="${failed.bot}" data-autofocus`, "primary"),
            made.length >= 2 ? btn(`Make it without ${nm(failed.bot)}`, `data-without="${failed.bot}"`) : "",
            btn("Cancel", 'data-cancel-new="1"', "quiet"),
          );
      if (dlg.error === "record")
        tail =
          note("danger", `<b>Made tasks for ${list(made)}, but couldn't save the group.</b> The gateway didn't answer in time.`) +
          actions(btn("Try again", 'data-retry-record="1" data-autofocus', "primary"), btn("Cancel", 'data-cancel-new="1"', "quiet"));
      if (dlg.error === "readback") tail = note("warn", "<b>Couldn't confirm the group was saved.</b>") + actions(btn("Check again", 'data-retry-readback="1" data-autofocus', "primary"));
      if (dlg.error === "full")
        tail = note("danger", "The gateway keeps at most 128 preferences for you, and it has no room for another group. Remove a group to make one.") + actions(btn("Cancel", 'data-cancel-new="1" data-autofocus'));
      return head("New group") + `<div class="b-body" aria-live="polite"><ul class="g-making">${rows}</ul>${tail}</div>`;
    }
    const n = picked.length;
    const name = `${ME}, ${list(picked.map(nm))}`;
    return (
      head("New group") +
      `<div class="b-body"><div class="g-picked" aria-label="To">To: ${picked.map((b) => chip(b)).join("")}</div>` +
      `<ul class="b-choices" role="group" aria-label="Bots">${ALL.map((b) => choice(b, picked.includes(b), n >= 6 && !picked.includes(b), "data-pick")).join("")}</ul>` +
      (n < 2 ? `<p class="g-hint">Choose 2 to 6 bots.</p>` : `<p class="g-hint">Name: <b>${esc(name)}</b>. You can rename it later.</p>`) +
      `<div style="margin-top:12px">${note("", "Clawtrate makes a new task with each bot and keeps the group with your preferences on the gateway, so your other devices show it.")}</div></div>` +
      `<div class="b-foot"><div class="b-actions"><span class="spacer"></span>${btn("Create", `data-create="1"${n < 2 ? " disabled" : ""}`, "primary")}</div></div>`
    );
  }

  function create() {
    dlg.making = dlg.picked.map((bot) => ({ bot })).concat([{ bot: "record" }]);
    announce("Making the group");
    drawDialog();
    makeNext();
  }

  function makeNext() {
    const next = dlg.making.find((r) => !r.done && !r.failed);
    if (!next) return;
    later(260, () => {
      if (dlg.kind !== "new") return;
      if (next.bot === "record") {
        for (const f of ["full", "record", "readback"])
          if (fail.delete(f)) {
            dlg.error = f;
            if (f === "record") announce("Couldn't save the group");
            return drawDialog();
          }
        next.done = true;
        return finish();
      }
      if (fail.delete(next.bot)) {
        next.failed = true;
        dlg.error = "task";
        announce(`Couldn't make ${nm(next.bot)}'s task`);
        return drawDialog();
      }
      next.done = true;
      drawDialog();
      makeNext();
    });
  }

  function stash() {
    if (!m.group) return;
    Object.assign(m.group, { items: m.items, runs: m.runs, member: m.member });
  }
  function load(g) {
    stash();
    m.group = g;
    m.items = g.items || [];
    m.runs = g.runs || {};
    m.member = g.member || {};
    m.view = { group: g.id };
    m.draft = "";
    m.reply = null;
    m.notices = [];
    m.follow = true;
  }

  function finish() {
    const members = dlg.making.filter((r) => r.bot !== "record" && r.done).map((r) => r.bot);
    const g = { id: nid("g"), name: `${ME}, ${list(members.map(nm))}`, members, at: 59, items: [], runs: {}, member: {} };
    m.groups.push(g);
    load(g);
    closeDialog();
    render();
    announce("Made the group");
    $("#g-input")?.focus();
  }

  function detailsHtml() {
    const g = m.group;
    if (dlg.reading) return head("Group details") + `<div class="b-body" aria-busy="true"><p class="g-hint">Reading the group…</p></div>`;
    const write = m.tier === "write";
    const phone = touch();
    let name;
    if (dlg.renaming) {
      name =
        `<div class="g-name-row"><input class="input" id="g-name" aria-label="Name" value="${esc(dlg.typed ?? g.name)}"${dlg.saving ? " disabled" : ""} data-autofocus>` +
        `<button type="button" class="button" data-variant="primary" data-save-name="1"${dlg.saving || !(dlg.typed ?? g.name).trim() ? " disabled" : ""}>${dlg.saving ? "Saving…" : dlg.conflict ? "Save again" : phone ? "Done" : "Save"}</button>` +
        (dlg.saving ? "" : `<button type="button" class="button" data-variant="quiet" data-cancel-name="1">Cancel</button>`) +
        `</div>` +
        (!(dlg.typed ?? g.name).trim() ? `<p class="g-hint">A group needs a name.</p>` : "") +
        (dlg.conflict ? note("warn", `This group changed on another device. It's now called ${esc(g.name)}.`) : "") +
        (dlg.refused ? note("danger", `<b>Couldn't save the name.</b> The gateway didn't answer in time. It is still called ${esc(g.name)}.`) : "");
    } else {
      name = `<div class="g-name-row"><h3>${esc(g.name)}</h3>${write ? `<button type="button" class="button" data-size="sm" data-rename="1">${phone ? "Edit" : "Rename"}</button>` : ""}</div>`;
    }
    const rows = g.members
      .map(
        (b) =>
          `<li><span class="avatar" aria-hidden="true">${CT.character(b)}</span><span class="g-name">${esc(nmFull(b, g.members))}</span>` +
          (["botgone", "taskgone"].includes(m.member[b]) ? "" : CT.button(`Open ${nm(b)}'s task`, `data-open-task="${b}"`)) +
          (write && canRemoveMember() ? CT.button("Remove", `data-remove-member="${b}" aria-label="Remove ${nm(b)}"`) : "") +
          `</li>`,
      )
      .join("");
    return (
      head("Group details") +
      `<div class="b-body">${name}<p class="g-section">Members</p><ul class="g-members">${rows}</ul>` +
      `<p class="g-hint">Each member has its own task with you. Opening it shows your messages to that bot and its replies.</p>` +
      (write && g.members.length < 6 ? `<p>${CT.button("Add a bot", 'data-add="1"')}</p>` : "") +
      (write && !canRemoveMember() ? `<p class="g-hint">A group has at least two bots. To change one, add another bot first, or remove the group.</p>` : "") +
      `<p class="g-hint">Kept with your preferences on the gateway. Your other devices show this group.</p></div>` +
      (write ? `<div class="b-foot"><div class="b-actions"><button type="button" class="button" data-tone="danger" data-remove-group="1">Remove group…</button></div></div>` : "")
    );
  }

  function addHtml() {
    const others = ALL.filter((b) => !m.group.members.includes(b));
    if (dlg.adding && !dlg.addError)
      return head("Add a bot", true) + `<div class="b-body" aria-live="polite"><ul class="g-making"><li><span class="avatar" aria-hidden="true">${CT.character(dlg.adding)}</span>${dlg.made ? `${nm(dlg.adding)}'s task made. Saving the group…` : `Making ${nm(dlg.adding)}'s task…`}</li></ul></div>`;
    if (dlg.addError)
      return (
        head("Add a bot", true) +
        `<div class="b-body" aria-live="polite">${note("danger", `<b>${nm(dlg.adding)}'s task was made. This group still has ${esc(list(m.group.members.map(nm)))}.</b> The gateway didn't answer in time.`)}` +
        `${actions(btn("Try again", 'data-retry-add="1" data-autofocus', "primary"), btn("Cancel", 'data-dback="1"', "quiet"))}</div>`
      );
    return (
      head("Add a bot", true) +
      `<div class="b-body"><ul class="b-choices" role="group" aria-label="Bots">${others.map((b) => choice(b, dlg.add === b, false, "data-add-pick")).join("")}</ul></div>` +
      `<div class="b-foot"><div class="b-actions"><span class="spacer"></span>${btn("Add", `data-do-add="1"${dlg.add ? "" : " disabled"}`, "primary")}</div></div>`
    );
  }

  function saveRecordAdd() {
    later(300, () => {
      if (fail.delete("add")) {
        dlg.addError = true;
        return drawDialog();
      }
      m.group.members.push(dlg.adding);
      announce(`Added ${nm(dlg.adding)}`);
      render();
      openDialog("details", opener);
    });
  }

  // Menus ---------------------------------------------------------------------------------------

  const menu = $("#rail-menu");
  let menuFrom = null;
  function openMenu(items, from, x, y) {
    menuFrom = from;
    menu.innerHTML = items
      .map(([label, attr, keys]) => `<li role="none"><button type="button" class="menu-item" role="menuitem" ${attr}>${label}${keys ? `<kbd>${keys}</kbd>` : ""}</button></li>`)
      .join("");
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
    openDialog("details", from, { reading: true, ...extra });
    later(150, () => {
      if (dlg.kind !== "details") return;
      dlg.reading = false;
      drawDialog();
      ($("[data-autofocus]", dialog) || $("h2", dialog))?.focus();
    });
  }

  // Events --------------------------------------------------------------------------------------

  document.addEventListener("click", (event) => {
    const t = event.target;
    const on = (sel) => t.closest(sel);
    let el;
    if (!on("#rail-menu") && !on("[data-msg-menu]") && !on("#new-button") && !on(".bot[data-group]")) closeMenu(false);

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
    if ((el = on(".bot[data-group]"))) {
      const g = m.groups.find((x) => x.id === el.dataset.group);
      if (g !== m.group) load(g);
      m.view = { group: g.id };
      m.follow = true;
      $(".shell").dataset.view = "detail";
      return render();
    }
    if ((el = on("[data-bot-row]"))) {
      const id = el.dataset.botRow;
      m.view = m.view.bot === id || !m.group || !m.group.members.includes(id) ? { group: m.group?.id } : { bot: id };
      return render();
    }
    if (on("[data-open-group]")) {
      m.view = { group: m.group.id };
      m.follow = true;
      return render();
    }
    if (on('[data-action="back"]')) return ($(".shell").dataset.view = "list");
    if ((el = on("#title-pill")) && el.dataset.action === "details") return openDetails(el);

    // The message's menu: Reply and Quote.
    if ((el = on("[data-msg-menu]"))) {
      const item = m.items.find((i) => i.id === el.dataset.msgMenu);
      return openMenu(
        [
          ["Reply", `data-reply="${item.id}"`],
          ["Quote", `data-quote="${item.id}"`],
        ],
        el,
      );
    }
    if ((el = on("[data-reply]"))) {
      const item = m.items.find((i) => i.id === el.dataset.reply);
      closeMenu(false);
      m.reply = { bot: item.bot, text: item.text, id: item.id };
      renderComposer();
      CT.hydrate($("#composer-slot"));
      return $("#g-input").focus();
    }
    if ((el = on("[data-quote]"))) {
      const item = m.items.find((i) => i.id === el.dataset.quote);
      closeMenu(false);
      m.draft = `> ${nm(item.bot)}: ${item.text.slice(0, 500)}\n` + m.draft;
      renderComposer();
      CT.hydrate($("#composer-slot"));
      const input = $("#g-input");
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }
    if (on("[data-cancel-reply]")) {
      m.reply = null;
      renderComposer();
      return $("#g-input").focus();
    }
    if ((el = on("[data-mention]"))) {
      const id = el.dataset.mention;
      m.draft = m.draft.replace(/@[\w-]*$/, `@${id === "everyone" ? "everyone" : nm(id)} `);
      if (id !== "everyone") m.bind[nm(id).toLowerCase()] = id;
      m.mentionOpen = false;
      renderComposer();
      CT.hydrate($("#composer-slot"));
      const input = $("#g-input");
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }
    if ((el = on("[data-bind]"))) {
      m.bind[el.dataset.word] = el.dataset.bind;
      renderComposer();
      CT.hydrate($("#composer-slot"));
      return $("#g-input").focus();
    }
    if (on("[data-send]")) return send();
    if (on("[data-stop]")) return stop();
    if ((el = on("[data-stop-again]"))) {
      // Retried only while the same run is still active.
      if (!m.runs[el.dataset.stopAgain]) {
        m.notices = m.notices.filter((n) => n.run !== el.dataset.stopAgain);
        return render();
      }
      return stop(el.dataset.stopAgain);
    }
    if (on("[data-review]")) return $("#g-approval")?.focus();
    if (on("[data-review-question]")) return $("#g-question .option")?.focus();
    if ((el = on("[data-went]"))) {
      const item = m.items.find((i) => i.id === el.dataset.went);
      item.open = !item.open;
      render();
      return $(`[data-went="${item.id}"]`).focus();
    }
    if ((el = on("[data-resend]"))) {
      const [id, bot] = el.dataset.resend.split(":");
      const item = m.items.find((i) => i.id === id);
      item.copies[bot] = "sending";
      render();
      later(300, () => {
        item.copies[bot] = "sent";
        announce(`Sent to ${nm(bot)}`);
        startRun(bot, "A tide table and the trailer key.", tick());
        render();
      });
      return;
    }
    if ((el = on("[data-restore]"))) {
      const bot = el.dataset.restore;
      m.member[bot] = "restoring";
      render();
      later(400, () => {
        delete m.member[bot];
        announce(`Restored ${nm(bot)}'s task`);
        render();
      });
      return;
    }
    if ((el = on("[data-newtask]"))) {
      const bot = el.dataset.newtask;
      m.member[bot] = "starting";
      render();
      later(400, () => {
        delete m.member[bot];
        announce(`Started a new task for ${nm(bot)}`);
        render();
      });
      return;
    }
    if ((el = on("[data-adopt]"))) return openDialog("confirm-adopt", el, { bot: el.dataset.adopt });
    if (on("[data-do-adopt]")) {
      const bot = dlg.bot;
      delete m.member[bot];
      for (const i of m.items) if (i.copies && i.copies[bot] === "changed") i.copies[bot] = "sent";
      closeDialog();
      render();
      announce(`Using ${nm(bot)}'s new task`);
      return;
    }
    if ((el = on("[data-remove-member]"))) return openDialog("confirm-member", el, { bot: el.dataset.removeMember });
    if ((el = on("[data-do-remove]")) || on("[data-check-member]")) {
      const bot = dlg.bot;
      const checking = !!on("[data-check-member]");
      dlg.busy = true;
      dlg.result = null;
      drawDialog();
      later(300, () => {
        dlg.busy = false;
        if (!checking && fail.delete("memberconflict")) {
          // The read-back shows a record another device changed: nothing of this edit was saved.
          if (!m.group.members.includes("pip")) m.group.members.push("pip");
          dlg.result = "conflict";
          render();
          return drawDialog();
        }
        if (!checking && fail.delete("unconfirmed")) {
          dlg.result = "unconfirmed";
          return drawDialog();
        }
        removeMember(bot);
        closeDialog();
        render();
        announce(`Removed ${nm(bot)} from the group`);
      });
      return;
    }
    if (on("[data-remove-group]")) return openDialog("confirm-group", $("#title-pill"), {});
    if (on("[data-do-remove-group]") || on("[data-check-group]")) {
      const checking = !!on("[data-check-group]");
      dlg.busy = true;
      dlg.result = null;
      drawDialog();
      later(350, () => {
        dlg.busy = false;
        if (checking) {
          // Read back: the record is still there, so nothing was removed.
          dlg.result = "kept";
          return drawDialog();
        }
        if (fail.delete("remove")) {
          dlg.result = "unconfirmed";
          return drawDialog();
        }
        const g = m.group;
        const already = fail.delete("gone");
        const present = presentTasks();
        m.stageNote = already
          ? `${g.name} was already removed on another device. ${possessive(present.map(nm))} ${present.length > 1 ? "tasks stay in their lists" : "task stays in its list"}.`
          : `Removed ${g.name}. ${possessive(present.map(nm))} ${present.length > 1 ? "tasks stay in their lists" : "task stays in its list"}.`;
        m.groups = m.groups.filter((x) => x !== g);
        m.group = null;
        m.view = { removed: true };
        closeDialog();
        render();
        announce(already ? "The group was already removed" : "Removed the group");
      });
      return;
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
    if (on("[data-retry-record]") || on("[data-retry-readback]")) {
      dlg.error = null;
      drawDialog();
      return makeNext();
    }
    if (on("[data-cancel-new]")) {
      const made = dlg.making.filter((r) => r.bot !== "record" && r.done).map((r) => nm(r.bot));
      closeDialog();
      m.stageNote = `No group was made. ${possessive(made)} new tasks stay in their lists.`;
      $("#g-stage")?.remove();
      $("#transcript").insertAdjacentHTML("afterbegin", `<p class="g-stage-note" id="g-stage" role="status">${esc(m.stageNote)}</p>`);
      return;
    }

    // Group details.
    if (on("[data-rename]")) {
      dlg.renaming = true;
      dlg.typed = m.group.name;
      drawDialog();
      return $("#g-name").focus();
    }
    if (on("[data-cancel-name]")) {
      Object.assign(dlg, { renaming: false, conflict: false, refused: false, typed: null });
      return drawDialog();
    }
    if (on("[data-save-name]")) return saveName();
    if (on("[data-add]")) return openDialog("add", on("[data-add]"), { add: null, adding: null });
    if ((el = on("[data-add-pick]"))) {
      dlg.add = el.dataset.addPick;
      drawDialog();
      return $(`[data-add-pick="${dlg.add}"]`, dialog).focus();
    }
    if (on("[data-do-add]")) {
      dlg.adding = dlg.add;
      drawDialog();
      later(300, () => {
        dlg.made = true; // its sessions.create returned a key
        drawDialog();
        saveRecordAdd();
      });
      return;
    }
    if (on("[data-retry-add]")) {
      // The task made before is used again; only the record is written.
      dlg.addError = false;
      drawDialog();
      return saveRecordAdd();
    }
    if (on("[data-dback]")) return openDetails(opener);
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

  // A member leaves the record; its task and its runs go on, outside the group.
  function removeMember(bot) {
    m.group.members = m.group.members.filter((b) => b !== bot);
    delete m.member[bot];
    for (const r of Object.values(m.runs)) if (r.bot === bot) delete m.runs[r.id];
    m.notices = m.notices.filter((n) => n.bot !== bot);
    m.items = m.items
      .filter((i) => i.bot !== bot)
      .map((i) => {
        if (!i.copies || !i.copies[bot]) return i;
        // A copy still held on this device is not sent to a former member.
        if (["held", "queued", "held-offline"].includes(i.copies[bot])) return { ...i, copies: { ...i.copies, [bot]: "notsent" }, removed: [...(i.removed || []), bot] };
        return { ...i, copies: Object.fromEntries(Object.entries(i.copies).filter(([b]) => b !== bot)) };
      });
  }

  function saveName() {
    const typed = ($("#g-name")?.value ?? "").trim();
    if (!typed) return;
    dlg.typed = typed;
    dlg.saving = true;
    drawDialog();
    later(350, () => {
      dlg.saving = false;
      const c = params.get("conflict");
      if (c === "1" && !dlg.conflict) {
        dlg.conflict = true;
        m.group.name = "Saturday"; // what the record holds now, as read back
        render();
        drawDialog();
        return;
      }
      if (c === "refused" && !dlg.refused) {
        dlg.refused = true;
        drawDialog();
        return;
      }
      m.group.name = typed;
      Object.assign(dlg, { renaming: false, conflict: false, refused: false, typed: null });
      render();
      drawDialog();
      announce("Saved the name");
      $("[data-rename]", dialog)?.focus();
    });
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
  });

  document.addEventListener("keydown", (event) => {
    if (event.target.id === "g-input") {
      if (m.mentionOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        return $(".g-mentions .menu-item")?.focus();
      }
      if (event.key === "Escape" && m.mentionOpen) {
        m.mentionOpen = false;
        renderComposer();
        return $("#g-input").focus();
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
      if (event.key === "Escape") return event.target.closest("#rail-menu") ? closeMenu() : ((m.mentionOpen = false), renderComposer(), $("#g-input").focus());
    }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "n" && m.tier === "write") {
      event.preventDefault();
      openDialog("new", $("#new-button"), { picked: [], making: null, error: null });
    }
    if (event.target.closest?.(".bot[data-group]") && event.shiftKey && event.key === "F10") groupMenu(event.target.closest(".bot"));
  });

  function groupMenu(from, x, y) {
    const items = m.tier === "write" ? [["Rename…", 'data-menu-rename="1"'], ["Group details", 'data-menu-details="1"'], ["Remove group…", 'data-remove-group="1"']] : [["Group details", 'data-menu-details="1"']];
    openMenu(items, from, x, y);
  }
  document.addEventListener("contextmenu", (event) => {
    const row = event.target.closest(".bot[data-group]");
    if (!row) return;
    event.preventDefault();
    const g = m.groups.find((x) => x.id === row.dataset.group);
    if (g !== m.group) {
      load(g);
      render();
    }
    groupMenu($(`.bot[data-group="${g.id}"]`), event.clientX, event.clientY);
  });
  menu.addEventListener("click", (event) => {
    if (event.target.closest("[data-menu-details]")) {
      closeMenu(false);
      openDetails($("#title-pill"));
    }
    if (event.target.closest("[data-menu-rename]")) {
      closeMenu(false);
      openDetails($("#title-pill"), { renaming: true, typed: m.group.name });
    }
  });

  // An answered approval: the run goes on, and Otto replies.
  document.addEventListener("ct:decision", (event) => {
    const item = m.items.find((i) => i.kind === "approval" && !i.done);
    if (!item) return;
    const decision = event.detail.decision;
    later(decision === "always" ? 1000 : 50, () => {
      item.done = true;
      const run = Object.values(m.runs).find((r) => r.bot === item.bot);
      if (run) Object.assign(run, { state: "thinking", phrase: "Thinking", hold: false });
      render();
      later(500, () => {
        if (run) delete m.runs[run.id];
        m.items.push(said(item.bot, decision === "deny" ? "Understood. I won't list the files; tell me if you want me to look another way." : "It's steady at 71%. Nothing new has been written since this morning."));
        render();
      });
    });
  });

  // An answered question, wherever its run began: held copies to that bot go into its run, which then replies.
  document.addEventListener("ct:question", (event) => {
    const q = m.items.find((i) => i.kind === "question" && !i.done && i.id === event.detail.card.id);
    if (!q) return;
    q.done = true;
    q.html = $(`#${q.id}`)?.outerHTML;
    const released = m.items.filter((i) => i.copies && i.copies[q.bot] === "held");
    for (const i of released) i.copies[q.bot] = "steer";
    if (released.length) announce(`Sent to ${nm(q.bot)}`);
    const run = Object.values(m.runs).find((r) => r.bot === q.bot);
    if (run) Object.assign(run, { state: "thinking", phrase: "Thinking", hold: false });
    render();
    later(500, () => {
      if (run) delete m.runs[run.id];
      m.items.push(said(q.bot, q.bot === "juniper" ? "The lake loop, then. I'll plan for an 8 o'clock start." : "Thanks. I'll keep the cache for a week and clear it next Monday."));
      render();
    });
  });

  // The prototype bar: what the gateway or another device does.
  document.addEventListener("DOMContentLoaded", () => {
    const extra = $("#proto-extra");
    if (extra && m.offline) extra.innerHTML = `<span class="run-controls"><button type="button" id="g-reconnect">Reconnect</button></span>`;
  });
  document.addEventListener("click", (event) => {
    if (event.target.id !== "g-reconnect") return;
    m.offline = false;
    event.target.disabled = true;
    // Held copies are checked against the members now in the record before they go.
    for (const item of m.items.filter((i) => i.held)) {
      item.held = false;
      for (const b of Object.keys(item.copies)) item.copies[b] = m.group.members.includes(b) ? "sent" : "notsent";
    }
    announce("Connected");
    render();
  });

  // Start --------------------------------------------------------------------------------------

  m.items = history();
  const run = (bot, owner, state, phrase, elapsed, extra = {}) => {
    const id = nid("r");
    m.runs[id] = { id, bot, owner, state, phrase, elapsed, hold: true, ...extra };
  };
  if (state0 === "running" || state0 === "twodevices") {
    m.items.push(you("Check the trail closures and the media box before we go.", { juniper: "sent", otto: "sent" }));
    run("juniper", "this", "working", "Searching the web for trail closures", "0:08");
    // In twodevices, Otto's run was started from another device: this device may not stop it.
    run("otto", state0 === "twodevices" ? "other" : "this", "working", "Reading backup-2026-11-15.log", "0:12");
  }
  if (state0 === "queuedturn") {
    m.items.push(you("@Otto check the media box before we go.", { otto: "sent" }));
    run("otto", "this", "working", "Reading backup-2026-11-15.log", "0:12");
    // A later turn from another device, which the gateway queued in Otto's task (its pendingInputs).
    run("otto", "other", "idle", "Queued by the gateway", "", { queued: true, text: "@Otto also check the trail camera.", reply: "The trail camera has 40 new pictures; the card is half full." });
  }
  if (state0 === "question") run("otto", "this", "waiting", "Waiting for you", "0:30");
  if (state0 === "approval" || state0 === "both") run("otto", "this", "waiting", "Waiting for you", "0:21");
  if (state0 === "both") run("juniper", "this", "waiting", "Waiting for you", "0:18");
  if (state0 === "other") run("juniper", "other", "waiting", "Waiting for you", "0:18"); // its question is shown here
  sortItems();
  render();

  const compose = params.get("compose");
  if (compose === "mention") {
    m.draft = "@";
    m.mentionOpen = true;
  }
  if (compose === "otto") m.draft = "@Otto how full is the media box now?";
  if (compose === "reply") m.reply = { bot: "juniper", text: "The forecast is clear until 2 PM, so start the trail by 8.", id: m.items.find((i) => i.bot === "juniper")?.id };
  if (compose === "quote") m.draft = "> Marlow: I'll draft a short note for the neighbours about borrowing the trailer. @Otto, can you print it?\n@Juniper is 8 still the right start?";
  if (compose === "ambiguous") m.draft = "@Otto are the bikes ready?";
  if (compose) renderComposer(), CT.hydrate(document);

  const open = params.get("open");
  const picks = (params.get("pick") || "").split(",").filter(Boolean);
  if (open === "new") openDialog("new", $("#new-button"), { picked: picks, making: null, error: null });
  if (open === "details") openDetails($("#title-pill"), { renaming: params.get("rename") === "1", typed: m.group?.name });
  const confirm = params.get("confirm");
  if (confirm === "member") openDialog("confirm-member", $("#title-pill"), { bot: "marlow" });
  if (confirm === "group") openDialog("confirm-group", $("#title-pill"), {});
  if (params.get("view") === "list") $(".shell").dataset.view = "list";
})();
