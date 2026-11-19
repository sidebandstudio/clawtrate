// Group chats, as docs/design/group-chats.md specifies them. No gateway and no
// network: a small local model plays what the gateway answers, with the
// answers the research recorded (docs/research/group-chats.md).
//
// A group is a record of two to six tasks, one per bot. Everything the column
// shows comes from one of those tasks; everything sent is one message per
// target task. The address picks a state; section 16 of the design lists them:
//   ?state=open|empty|running|partial|approval|question|other|readonly|offline|archived|taskgone|botgone|removed
//   ?open=new|details  ?pick=juniper,otto  ?fail=marlow|record|readback|full|noprefs|remove
//   ?compose=mention|otto|reply|quote  ?stopfail=otto  ?conflict=1|refused  ?confirm=member|group
//   ?bot=otto  (Otto's own task that is part of the group)

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
  });
  const ALL = ["juniper", "otto", "marlow", "pip", "extra1", "extra2", "extra3"];
  const nm = (id) => CT.bots[id].name;
  const ME = "Robin"; // the person's display name, from users.self
  const list = (names) =>
    names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const count = ["no", "one", "two", "three", "four", "five", "six"];
  const touch = () => document.documentElement.dataset.input === "touch";
  const announce = (text) => CT.announce(text);

  // The model ------------------------------------------------------------------------------

  const state0 = params.get("state") || "open";
  const fail = new Set((params.get("fail") || "").split(",").filter(Boolean));
  const m = {
    tier: state0 === "readonly" ? "read" : "write",
    device: state0 === "other" ? "other" : "this",
    offline: state0 === "offline",
    group: state0 === "removed" ? null : { id: "g1", name: "Weekend plans", members: ["juniper", "otto", "marlow"] },
    view: params.get("bot") ? { bot: params.get("bot") } : { group: "g1" },
    member: {}, // a member's state: archived, taskgone, botgone
    items: [],
    runs: {}, // bot -> { phrase, state, elapsed }
    stopping: false,
    stopfail: new Set((params.get("stopfail") || "").split(",").filter(Boolean)),
    draft: "",
    reply: null,
    mentionOpen: false,
    access: "read",
    stageNote: "",
    sends: 0,
  };
  if (state0 === "removed") {
    m.view = { removed: true };
    m.stageNote = "Removed Weekend plans. Its three tasks are in Juniper's, Otto's and Marlow's lists.";
  }
  if (["archived", "taskgone", "botgone"].includes(state0)) m.member.marlow = state0;
  // A copy refused because the task is archived: the group now knows the task is archived.
  if (state0 === "partial") m.member.marlow = "archived";

  const you = (text, copies, extra = {}) => ({ kind: "you", id: `y${++m.sends}`, text, copies, ...extra });
  const said = (bot, text) => ({ kind: "bot", bot, text, id: `b${++m.sends}` });
  const everyoneSent = (members) => Object.fromEntries(members.map((b) => [b, "sent"]));

  function history() {
    const g = m.group;
    if (!g || state0 === "empty") return [];
    const base = [
      you("Plan Saturday for us: the trail in the morning, errands after lunch.", everyoneSent(g.members)),
      said("marlow", "I'll draft a short note for the neighbours about borrowing the trailer."),
      said("juniper", "The forecast is clear until 2 PM, so start the trail by 8."),
      said("otto", "Done. The old cache folder is gone, so the media box has room for the trail photos."),
    ];
    if (state0 === "partial") {
      base.push(
        you("Can each of you add one thing to bring?", { juniper: "sent", otto: "sent", marlow: "failed" }, { open: true }),
        said("juniper", "Water and the paper map."),
        said("otto", "A charged battery pack."),
      );
    }
    if (state0 === "approval" || state0 === "other") {
      base.push(you("@Otto is the media box disk still filling up?", { otto: "sent" }));
      if (state0 === "approval") base.push({ kind: "approval", bot: "otto", id: "g-approval" });
    }
    if (state0 === "question") base.push(you("@Otto should I clear the scratch cache before Saturday?", { otto: "sent" }), { kind: "question", bot: "otto", id: "g-question" });
    if (state0 === "offline") base.push(you("Bring sunscreen too.", Object.fromEntries(g.members.map((b) => [b, "held"])), { held: true }));
    return base;
  }

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

  function groupLine() {
    if (m.device === "this" && m.tier === "write" && m.items.some((i) => i.kind === "approval" && !i.done))
      return { text: "Waiting for you: Otto, approve a command", tone: "waiting", badge: "waiting", state: "waiting for you" };
    if (m.tier === "write" && m.items.some((i) => i.kind === "question" && !i.done))
      return { text: "Waiting for you: Otto, a question", tone: "waiting", badge: "waiting", state: "waiting for you" };
    const working = Object.keys(m.runs);
    if (working.length) return { text: `${list(working.map(nm))} ${working.length > 1 ? "are" : "is"} working`, tone: "working", badge: "", state: "working" };
    const last = [...m.items].reverse().find((i) => i.kind === "you" || i.kind === "bot");
    if (!last) return { text: "No messages yet", tone: "", badge: "", state: "idle" };
    return { text: `${last.kind === "you" ? "You" : nm(last.bot)}: ${last.text}`, tone: "", badge: "", state: "idle" };
  }

  function renderRail() {
    const rows = [];
    const g = m.group;
    if (g) {
      const line = groupLine();
      const current = !!m.view.group;
      rows.push(
        `<li class="bot-group"><button type="button" class="bot" data-group="${g.id}" aria-current="${current}" aria-haspopup="menu"` +
          ` aria-label="${esc(`${g.name}, group of ${g.members.length}: ${list(g.members.map(nm))}, ${line.state}`)}">` +
          stack(g.members, line.badge) +
          `<span class="bot-text"><span class="bot-line"><span class="bot-name">${esc(g.name)}</span><time class="bot-time">${line.state === "idle" ? "5:41 PM" : "now"}</time></span>` +
          `<span class="bot-line"><span class="bot-preview" data-state="${line.tone}">${esc(line.text)}</span></span></span></button></li>`,
      );
    }
    for (const id of ["juniper", "otto", "marlow", "pip"]) {
      const open = m.view.bot === id;
      const inGroup = g && g.members.includes(id) && !(id === "marlow" && m.member.marlow === "botgone");
      if (id === "marlow" && m.member.marlow === "botgone") continue; // a deleted bot is not listed
      const tasks = open
        ? `<ul class="task-list" aria-label="${nm(id)}'s tasks">` +
          (inGroup
            ? `<li><button type="button" class="task" data-member-task="${id}" aria-current="true" aria-label="Plan Saturday for us, 5:41 PM, in the group ${esc(g.name)}">` +
              `<span class="task-title">Plan Saturday for us</span><time class="task-time">5:41 PM</time>${icon("helpers", "icon g-task-mark")}</button></li>`
            : "") +
          `<li><button type="button" class="task" data-elsewhere="task"><span class="task-title">Earlier tasks</span><time class="task-time">Mon</time></button></li></ul>`
        : "";
      rows.push(
        `<li class="bot-group"${open ? ' data-open="true"' : ""}><button type="button" class="bot" data-bot-row="${id}" aria-current="false" aria-label="${nm(id)}, idle">` +
          `<span class="avatar">${CT.character(id)}</span>` +
          `<span class="bot-text"><span class="bot-line"><span class="bot-name">${nm(id)}</span><time class="bot-time">${id === "pip" ? "Mon" : "5:41 PM"}</time></span>` +
          `<span class="bot-line"><span class="bot-preview">${esc(CT.bots[id].label)}</span></span></span></button>${tasks}</li>`,
      );
    }
    $("#bot-list").innerHTML = rows.join("");
    $("#new-button").hidden = m.tier === "read";
  }

  // The column ------------------------------------------------------------------------------

  const STATE_WORDS = {
    sending: (n) => `Sending to ${n}…`,
    sent: (n) => `Sent to ${n}`,
    steer: (n) => `Steer for ${n}`,
    held: (n) => `Held until you answer ${n}`,
    queued: (n) => `Queued for ${n}`,
    failed: (n) => `Couldn't send to ${n}`,
    notsent: (n) => `Not sent to ${n}`,
  };

  function wentLine(item) {
    if (item.held) return `<div class="g-went"><span class="msg-caption">Sends when reconnected</span></div>`;
    const order = ["sending", "sent", "steer", "held", "queued", "failed", "notsent"];
    const by = {};
    for (const [bot, st] of Object.entries(item.copies)) (by[st] ||= []).push(nm(bot));
    const parts = order.filter((s) => by[s]).map((s) => `<span${s === "failed" ? ' data-tone="danger"' : ""}>${STATE_WORDS[s](list(by[s]))}</span>`);
    const words = parts.join(" · ");
    const rows = Object.entries(item.copies)
      .map(([bot, st]) => {
        const name = nm(bot);
        const why =
          st === "failed"
            ? ` The gateway answered: Session … is archived. Restore it before starting new work.${m.member[bot] || m.tier === "read" ? "" : ` ${CT.linkButton(`Resend to ${name}`, { attrs: `data-resend="${item.id}:${bot}"` })}`}`
            : "";
        const word = { sending: "Sending…", sent: "Sent", steer: "Steer: joined its running turn", held: "Held until you answer it", queued: "Queued", failed: "Couldn't send.", notsent: "Not sent" }[st];
        return `<li><b>${name}</b>: ${word}${why}</li>`;
      })
      .join("");
    return (
      `<div class="g-went"><button type="button" data-went="${item.id}" aria-expanded="${!!item.open}">${words}</button>` +
      (item.open ? `<ul>${rows}</ul>` : "") +
      `</div>`
    );
  }

  const memberLine = (bot) => {
    const s = m.member[bot];
    const name = nm(bot);
    if (!s) return "";
    const text = {
      archived: `${name}'s task in this group is archived. Messages to everyone skip ${name}.`,
      taskgone: `${name}'s task in this group was deleted. Messages to everyone skip ${name}.`,
      botgone: `${name} was deleted, with its tasks. Messages to everyone skip ${name}.`,
      restoring: `Restoring ${name}'s task…`,
      starting: `Starting a new task for ${name}…`,
    }[s];
    const write = m.tier === "write";
    const actions = !write
      ? ""
      : s === "archived"
        ? CT.button(`Restore ${name}'s task`, `data-restore="${bot}"`) + CT.button(`Remove ${name}`, `data-remove-member="${bot}"`)
        : s === "taskgone"
          ? CT.button(`Start a new task for ${name}`, `data-newtask="${bot}"`) + CT.button(`Remove ${name}`, `data-remove-member="${bot}"`)
          : s === "botgone"
            ? CT.button(`Remove ${name}`, `data-remove-member="${bot}"`)
            : "";
    return `<div class="g-line" data-member-line="${bot}"${s === "restoring" || s === "starting" ? ' aria-busy="true"' : ""}><span>${esc(text)}</span>${actions}</div>`;
  };

  const questionPending = (bot) => m.items.some((i) => i.kind === "question" && i.bot === bot && !i.done);
  const sendable = () => m.group.members.filter((b) => !m.member[b]);

  function renderColumn() {
    const el = $("#transcript");
    const g = m.group;
    $(".conversation").classList.toggle("g-column", !!(g && m.view.group));
    if (m.view.removed || !g) {
      el.innerHTML = `<div class="transcript-inner"><p class="g-stage-note" role="status">${esc(m.stageNote || "No group is open.")}</p></div>`;
      return;
    }
    if (m.view.bot) return renderMemberTask(el);
    // An approval card the person has answered keeps what behaviors.js made of it.
    const kept = $("#g-approval");
    const approvalHtml = kept ? kept.outerHTML : null;
    const keptQuestion = $("#g-question");
    const questionHtml = keptQuestion ? keptQuestion.outerHTML : null;
    const names = list(g.members.map(nm));
    const first = `Each bot sees only what you send it. ${names} don't see each other's replies.`;
    const body = [];
    if (!m.items.length) {
      body.push(
        `<div class="g-empty">${stack(g.members)}<h1>${esc(g.name)}</h1><p>${esc(first)}</p><p>Write to everyone, or start with @ to choose who answers.</p></div>`,
      );
    } else {
      body.push(`<p class="g-first">${esc(first)}</p>`, CT.stamp("Today 5:36 PM"));
      m.items.forEach((item, i) => {
        const prev = m.items[i - 1];
        const next = m.items[i + 1];
        if (item.kind === "you") {
          body.push(
            `<div class="turn" data-role="user"${item.held ? ' data-waiting="true"' : ""}>` +
              `<div class="msg" data-role="user" aria-label="${esc(`You said: ${item.text}`)}"><div class="bubble">${esc(item.text)}</div></div>` +
              wentLine(item) +
              `</div>`,
          );
        } else if (item.kind === "bot") {
          const firstOfRun = !(prev && prev.kind !== "you" && prev.bot === item.bot);
          const lastOfRun = !(next && next.kind === "bot" && next.bot === item.bot);
          body.push(
            (firstOfRun ? `<p class="g-speaker" aria-hidden="true">${nm(item.bot)}</p>` : "") +
              `<div class="g-said" data-said="${item.id}"><span class="g-foot">${lastOfRun ? `<span class="avatar" aria-hidden="true">${CT.character(item.bot)}</span>` : ""}</span>` +
              `<div class="msg" data-role="assistant" aria-label="${esc(`${nm(item.bot)} said: ${item.text}`)}"><div class="bubble">${esc(item.text)}</div></div>` +
              (m.tier === "write"
                ? `<button type="button" class="icon-button" data-msg-menu="${item.id}" aria-haspopup="menu" aria-expanded="false" aria-label="More for ${nm(item.bot)}'s message">${icon("more")}</button>`
                : "") +
              `</div>`,
          );
        } else if (item.kind === "approval") {
          body.push(`<p class="g-speaker" aria-hidden="true">Otto</p>`);
          body.push(
            approvalHtml && !item.fresh
              ? approvalHtml
              : CT.approval({
                  id: "g-approval",
                  bot: "otto",
                  summary: "List the files in <b>Otto's workspace</b> on <b>media-box</b>.",
                  line: "List the files in Otto's workspace",
                  asker: { line: "In Otto's task in this group." },
                  full: { reason: "Otto wants to see what is using the space.", command: "ls", fields: [["Runs on", "media-box"], ["Folder", "~/workspace"], ["Asked by", "Otto"]] },
                  request: { command: "ls", cwd: "~/workspace", host: "media-box", agent: "Otto" },
                  raw: CT.samples.approvalRaw(),
                }),
          );
          item.fresh = false;
        } else if (item.kind === "question") {
          body.push(`<p class="g-speaker" aria-hidden="true">Otto</p>`);
          body.push(item.html || questionHtml || CT.question({ id: "g-question", bot: "otto", ...CT.samples.question, raw: CT.samples.questionRaw() }));
        } else if (item.kind === "note") {
          body.push(CT.turnNote({ lead: CT.glyph("stopped"), html: item.html }));
        }
      });
    }
    for (const bot of g.members) body.push(memberLine(bot));
    if (m.device === "other")
      body.push(
        `<div class="g-line" data-member-line="otto-wait"><span>Otto is waiting for an approval. It went to the device that sent this message; answer it there.</span></div>`,
      );
    // One status line per member that is working, in member order.
    const lines = g.members
      .filter((b) => m.runs[b])
      .map((b) => CT.statusLine({ bot: b, state: m.runs[b].state, phrase: m.runs[b].phrase, elapsed: m.runs[b].elapsed || "" }));
    if (m.device === "other") lines.push(CT.statusLine({ bot: "otto", state: "blocked", phrase: "Waiting for an answer", steps: false }));
    if (lines.length) body.push(`<div class="g-status">${lines.join("")}</div>`);
    el.innerHTML = `<div class="transcript-inner">${body.join("")}</div>`;
    el.scrollTop = el.scrollHeight;
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

  // The composer ------------------------------------------------------------------------------

  // The targets come from the text, or from the reply. Nothing else decides them.
  function targets() {
    const g = m.group;
    if (m.reply) return { bots: [m.reply.bot], everyone: false, reply: true };
    const named = new Set();
    let everyone = false;
    for (const match of m.draft.matchAll(/(^|\s)@(\w+)/g)) {
      const word = match[2].toLowerCase();
      if (word === "everyone") everyone = true;
      const bot = g.members.find((b) => nm(b).toLowerCase() === word);
      if (bot) named.add(bot);
    }
    if (everyone || !named.size) return { bots: sendable(), everyone: true, reply: false };
    return { bots: g.members.filter((b) => named.has(b)), everyone: false, reply: false };
  }

  const chip = (bot, extra = "") => `<span class="g-chip"${extra}><span class="avatar" aria-hidden="true">${CT.character(bot)}</span>${nm(bot)}</span>`;

  function toLine(t) {
    const skipped = m.group.members.filter((b) => m.member[b]);
    const why = { archived: "task archived", taskgone: "task deleted", botgone: "bot deleted", restoring: "task archived", starting: "task deleted" };
    return (
      `<div class="g-to" aria-label="${esc(toWords(t))}"><span>To</span>` +
      (t.everyone ? `<span class="g-chip" data-everyone>Everyone</span>` : t.bots.map((b) => chip(b)).join("")) +
      (t.reply ? `<span>(replying)</span>` : "") +
      (t.everyone ? skipped.map((b) => chip(b, ` data-skipped aria-label="${nm(b)}, skipped: ${why[m.member[b]]}"`)).join("") : "") +
      `</div>`
    );
  }
  const toWords = (t) => (t.everyone ? "To Everyone" : `To ${list(t.bots.map(nm))}${t.reply ? " (replying)" : ""}`);
  const sendWords = (t) => (t.everyone ? "Send to everyone" : `Send to ${list(t.bots.map(nm))}`);

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
    const t = targets();
    const running = Object.keys(m.runs).filter((b) => m.runs[b].state !== "waiting" || true);
    const shelf = [];
    if (m.items.some((i) => i.kind === "approval" && !i.done))
      shelf.push(CT.shelfRow({ tone: "warn", lead: CT.glyph("waiting"), text: "Otto needs your approval to run a command", actions: CT.button("Review", 'data-review="1"') }));
    if (questionPending("otto"))
      shelf.push(CT.shelfRow({ tone: "warn", lead: CT.glyph("waiting"), text: "Otto asked you a question. A message to Otto now is held until you answer.", actions: CT.button("Review", 'data-review-question="1"') }));
    if (m.stopNotice)
      shelf.push(
        CT.shelfRow({ tone: "danger", lead: icon("warning"), text: `<b>Couldn't stop ${nm(m.stopNotice)}.</b> <span>The gateway didn't answer in time.</span>`, actions: CT.button("Try again", `data-stop-again="${m.stopNotice}"`) }),
      );
    if (m.reply)
      shelf.push(
        `<div class="shelf-row g-replying"><span class="shelf-text"><b>Replying to ${nm(m.reply.bot)}</b> <span>${esc(m.reply.text)}</span></span>` +
          `<button type="button" class="icon-button" data-cancel-reply="1" aria-label="Cancel reply">${icon("x")}</button></div>`,
      );
    const empty = !m.draft.trim();
    const stopCount = running.length;
    slot.innerHTML =
      `<footer class="composer" data-run="${stopCount ? "running" : "idle"}"><div class="composer-inner">` +
      `<div class="composer-shelf">${shelf.join("")}</div>` +
      `<div class="composer-box">${toLine(t)}<div class="composer-row">` +
      `<button type="button" class="icon-button" data-elsewhere="attach" aria-label="Attach files" title="Attach files">${icon("plus")}</button>` +
      `<textarea class="composer-input" id="g-input" rows="1" aria-label="Message the group" placeholder="${m.offline ? "Offline. Messages send when you reconnect." : "Message the group"}">${esc(m.draft)}</textarea>` +
      (m.stopping ? `<span class="composer-status">Stopping…</span>` : "") +
      (stopCount && !m.stopping
        ? `<button type="button" class="icon-button stop-button" data-stop="1" aria-label="Stop ${stopCount} ${stopCount === 1 ? "bot" : "bots"}" title="Stop ${stopCount} ${stopCount === 1 ? "bot" : "bots"} (⌘.)"></button>`
        : "") +
      `<button type="button" class="icon-button send-button" data-send="1" aria-label="${sendWords(t)}" title="${sendWords(t)}"${empty || !t.bots.length ? " disabled" : ""}>${icon("arrow-up")}</button>` +
      `</div></div>` +
      (m.mentionOpen ? mentionMenu() : "") +
      `</div></footer>`;
  }

  function mentionMenu() {
    const items = [["everyone", "Everyone"], ...m.group.members.map((b) => [b, nm(b)])];
    return (
      `<ul class="menu g-mentions" role="menu" aria-label="Mention">` +
      items
        .map(
          ([id, label], i) =>
            `<li role="none"><button type="button" class="menu-item" role="menuitem" data-mention="${id}"${i === 0 ? ' data-first="1"' : ""}>` +
            (id === "everyone" ? "" : `<span class="avatar" aria-hidden="true">${CT.character(id)}</span>`) +
            `${label}</button></li>`,
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
  };

  function send() {
    const text = m.draft.trim();
    const t = targets();
    if (!text || !t.bots.length) return;
    const copies = {};
    for (const b of t.bots) copies[b] = m.offline ? "held" : "sending";
    const item = you(text, copies, m.offline ? { held: true } : {});
    m.items.push(item);
    m.draft = "";
    m.reply = null;
    m.mentionOpen = false;
    render();
    if (m.offline) return;
    // Each copy goes as a message sent now into that member's own task would.
    const held = t.bots.filter((b) => questionPending(b));
    const queued = t.bots.filter((b) => !held.includes(b) && m.stopping && m.runs[b]);
    for (const b of held) copies[b] = "held";
    for (const b of queued) copies[b] = "queued";
    render();
    const out = t.bots.filter((b) => !held.includes(b) && !queued.includes(b));
    if (!out.length) return;
    later(350, () => {
      for (const b of out) copies[b] = m.runs[b] ? "steer" : "sent";
      announce(`Sent to ${list(out.map(nm))}`);
      for (const b of out) if (!m.runs[b]) startRun(b, REPLIES[b] || "Noted.");
      render();
    });
  }

  function startRun(bot, reply, delay = 500 + 350 * m.group.members.indexOf(bot)) {
    m.runs[bot] = { state: "thinking", phrase: "Thinking", elapsed: "0:01" };
    announce(`${nm(bot)} is working`);
    later(delay, () => {
      if (!m.runs[bot] || m.runs[bot].hold) return;
      delete m.runs[bot];
      m.items.push(said(bot, reply));
      announce(`${nm(bot)} finished`);
      render();
    });
  }

  function stop(only) {
    const bots = only ? [only] : Object.keys(m.runs);
    m.stopping = true;
    m.stopNotice = null;
    for (const b of bots) m.runs[b] = { ...m.runs[b], state: "stopping", phrase: "Stopping…" };
    announce(`Stopping ${bots.length} ${bots.length === 1 ? "bot" : "bots"}`);
    render();
    later(600, () => {
      const stopped = [];
      for (const b of bots) {
        if (m.stopfail.has(b)) {
          m.stopfail.delete(b);
          m.runs[b] = { state: "working", phrase: "Reading backup-2026-11-15.log", elapsed: "0:14", hold: true };
          m.stopNotice = b;
        } else {
          delete m.runs[b];
          stopped.push(nm(b));
        }
      }
      m.stopping = false;
      for (const b of bots.filter((x) => !m.runs[x])) {
        for (const i of m.items) if (i.copies && ["held", "queued"].includes(i.copies[b])) i.copies[b] = "notsent";
        const q = m.items.find((i) => i.kind === "question" && i.bot === b && !i.done);
        if (q) {
          q.done = true;
          q.html = CT.questionAnswered({ id: "g-question", questions: [{ title: CT.samples.question.title, answers: [] }], state: "cancelled", raw: CT.samples.questionRaw({ dismissed: true }) });
        }
      }
      if (stopped.length) {
        m.items.push({ kind: "note", html: `<p><b>Stopped.</b> ${list(stopped)} stopped. Completed actions are not undone.</p>` });
        announce("Stopped");
      }
      if (m.stopNotice) announce(`Couldn't stop ${nm(m.stopNotice)}`);
      render();
    });
  }

  // Dialogs -----------------------------------------------------------------------------------

  const dialog = $("#g-dialog");
  let opener = null;
  const dlg = { kind: null };

  function openDialog(kind, from, extra = {}) {
    opener = from || document.activeElement;
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

  function drawDialog() {
    const k = dlg.kind;
    let html = "";
    if (k === "new") html = newGroupHtml();
    if (k === "details") html = detailsHtml();
    if (k === "add") html = addHtml();
    if (k === "confirm-member") {
      const name = nm(dlg.bot);
      html =
        head(`Remove ${name} from ${m.group.name}?`) +
        `<div class="b-body"><p>${name}'s task stays in ${name}'s list, with everything in it. ${name} won't get messages sent to this group. Anything ${name} is doing now keeps going.</p></div>` +
        `<div class="b-foot"><div class="b-actions"><button type="button" class="button" data-tone="danger" data-do-remove="${dlg.bot}" data-autofocus>Remove</button><button type="button" class="button" data-dclose="1">Cancel</button></div></div>`;
    }
    if (k === "confirm-group") {
      const names = m.group.members.map((b) => `${nm(b)}'s`);
      html =
        head(`Remove ${m.group.name}?`) +
        `<div class="b-body"><p>${list(names)} tasks stay in their lists, with everything in them. Only the group goes, on all your devices. Nothing running is stopped.</p>` +
        (dlg.error ? note("danger", `<b>Couldn't remove the group.</b> The gateway didn't answer in time.`) : "") +
        `</div><div class="b-foot"><div class="b-actions"><button type="button" class="button" data-tone="danger" data-do-remove-group="1" data-autofocus${dlg.busy ? " disabled" : ""}>${dlg.busy ? "Removing…" : dlg.error ? "Try again" : "Remove group"}</button><button type="button" class="button" data-dclose="1">Cancel</button></div></div>`;
    }
    dialog.innerHTML = `<div class="b-sheet">${html}</div>`;
    CT.hydrate(dialog);
  }

  // New group: choose, make each task, save the record, read it back.
  function newGroupHtml() {
    if (fail.has("noprefs"))
      return head("New group") + `<div class="b-body">${note("warn", "This connection can't keep preferences on the gateway, so it can't keep a group.")}</div><div class="b-foot"><div class="b-actions"><button type="button" class="button" data-dclose="1" data-autofocus>Close</button></div></div>`;
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
          `<div class="b-actions"><button type="button" class="button" data-variant="primary" data-retry-task="${failed.bot}" data-autofocus>Try ${nm(failed.bot)} again</button>` +
          (made.length >= 2 ? `<button type="button" class="button" data-without="${failed.bot}">Make it without ${nm(failed.bot)}</button>` : "") +
          `<button type="button" class="button" data-variant="quiet" data-cancel-new="1">Cancel</button></div>`;
      if (dlg.error === "record")
        tail =
          note("danger", `<b>Made tasks for ${list(made)}, but couldn't save the group.</b> The gateway didn't answer in time.`) +
          `<div class="b-actions"><button type="button" class="button" data-variant="primary" data-retry-record="1" data-autofocus>Try again</button><button type="button" class="button" data-variant="quiet" data-cancel-new="1">Cancel</button></div>`;
      if (dlg.error === "readback")
        tail = note("warn", "<b>Couldn't confirm the group was saved.</b>") + `<div class="b-actions"><button type="button" class="button" data-variant="primary" data-retry-readback="1" data-autofocus>Check again</button></div>`;
      if (dlg.error === "full")
        tail =
          note("danger", "The gateway keeps at most 128 preferences for you, and it has no room for another group. Remove a group to make one.") +
          `<div class="b-actions"><button type="button" class="button" data-cancel-new="1" data-autofocus>Cancel</button></div>`;
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
      `<div class="b-foot"><div class="b-actions"><span class="spacer"></span><button type="button" class="button" data-variant="primary" data-create="1"${n < 2 ? " disabled" : ""}>Create</button></div></div>`
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
        if (fail.delete("full")) {
          dlg.error = "full";
          return drawDialog();
        }
        if (fail.delete("record")) {
          dlg.error = "record";
          announce("Couldn't save the group");
          return drawDialog();
        }
        if (fail.delete("readback")) {
          dlg.error = "readback";
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

  function finish() {
    const members = dlg.making.filter((r) => r.bot !== "record" && r.done).map((r) => r.bot);
    m.group = { id: "g2", name: `${ME}, ${list(members.map(nm))}`, members };
    m.items = [];
    m.runs = {};
    m.member = {};
    m.view = { group: "g2" };
    closeDialog();
    render();
    announce("Made the group");
    $("#g-input")?.focus();
  }

  function detailsHtml() {
    const g = m.group;
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
        (dlg.refused ? note("danger", "<b>Couldn't save the name.</b> The gateway didn't answer in time.") : "");
    } else {
      name = `<div class="g-name-row"><h3>${esc(g.name)}</h3>${write ? `<button type="button" class="button" data-size="sm" data-rename="1">${phone ? "Edit" : "Rename"}</button>` : ""}</div>`;
    }
    const rows = g.members
      .map(
        (b) =>
          `<li><span class="avatar" aria-hidden="true">${CT.character(b)}</span><span class="g-name">${nm(b)}</span>` +
          (m.member[b] === "botgone" ? "" : CT.button(`Open ${nm(b)}'s task`, `data-open-task="${b}"`)) +
          (write && g.members.length > 2 ? CT.button("Remove", `data-remove-member="${b}" aria-label="Remove ${nm(b)}"`) : "") +
          `</li>`,
      )
      .join("");
    return (
      head("Group details") +
      `<div class="b-body">${name}<p class="g-section">Members</p><ul class="g-members">${rows}</ul>` +
      `<p class="g-hint">Each member has its own task with you. Opening it shows what that bot has seen.</p>` +
      (write && g.members.length < 6 ? `<p>${CT.button("Add a bot", 'data-add="1"')}</p>` : "") +
      `<p class="g-hint">Kept with your preferences on the gateway. Your other devices show this group.</p></div>` +
      (write ? `<div class="b-foot"><div class="b-actions"><button type="button" class="button" data-tone="danger" data-remove-group="1">Remove group…</button></div></div>` : "")
    );
  }

  function addHtml() {
    const others = ALL.filter((b) => !m.group.members.includes(b));
    if (dlg.adding)
      return head("Add a bot", true) + `<div class="b-body" aria-live="polite"><ul class="g-making"><li><span class="avatar" aria-hidden="true">${CT.character(dlg.adding)}</span>Making ${nm(dlg.adding)}'s task…</li></ul></div>`;
    return (
      head("Add a bot", true) +
      `<div class="b-body"><ul class="b-choices" role="group" aria-label="Bots">${others.map((b) => choice(b, dlg.add === b, false, "data-add-pick")).join("")}</ul></div>` +
      `<div class="b-foot"><div class="b-actions"><span class="spacer"></span><button type="button" class="button" data-variant="primary" data-do-add="1"${dlg.add ? "" : " disabled"}>Add</button></div></div>`
    );
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
    if ((el = on("[data-new-group]"))) {
      closeMenu(false);
      return openDialog("new", $("#new-button"), { picked: [], making: null, error: null });
    }
    if ((el = on("[data-elsewhere]"))) {
      closeMenu(false);
      return CT.toast?.("That is designed elsewhere; this page shows groups.");
    }
    if ((el = on(".bot[data-group]"))) {
      m.view = { group: m.group.id };
      $(".shell").dataset.view = "detail";
      render();
      return;
    }
    if ((el = on("[data-bot-row]"))) {
      const id = el.dataset.botRow;
      m.view = m.view.bot === id ? { group: m.group?.id } : { bot: id };
      if (!m.group || !m.group.members.includes(id)) m.view = { group: m.group?.id };
      render();
      return;
    }
    if (on("[data-open-group]")) {
      m.view = { group: m.group.id };
      return render();
    }
    if (on('[data-action="back"]')) return ($(".shell").dataset.view = "list");
    if ((el = on("#title-pill")) && el.dataset.action === "details") return openDialog("details", el, { renaming: false });

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
      render();
      return $("#g-input").focus();
    }
    if ((el = on("[data-quote]"))) {
      const item = m.items.find((i) => i.id === el.dataset.quote);
      closeMenu(false);
      m.draft = `> ${nm(item.bot)}: ${item.text.slice(0, 500)}\n` + m.draft;
      render();
      return $("#g-input").focus();
    }
    if (on("[data-cancel-reply]")) {
      m.reply = null;
      render();
      return $("#g-input").focus();
    }
    if ((el = on("[data-mention]"))) {
      const id = el.dataset.mention;
      m.draft = m.draft.replace(/@\w*$/, `@${id === "everyone" ? "everyone" : nm(id)} `);
      m.mentionOpen = false;
      render();
      const input = $("#g-input");
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }
    if (on("[data-send]")) return send();
    if (on("[data-stop]")) return stop();
    if ((el = on("[data-stop-again]"))) return stop(el.dataset.stopAgain);
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
        startRun(bot, "A tide table and the trailer key.");
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
    if ((el = on("[data-remove-member]"))) return openDialog("confirm-member", el, { bot: el.dataset.removeMember });
    if ((el = on("[data-do-remove]"))) {
      const bot = el.dataset.doRemove;
      m.group.members = m.group.members.filter((b) => b !== bot);
      delete m.member[bot];
      m.items = m.items.filter((i) => i.bot !== bot).map((i) => (i.copies && i.copies[bot] ? { ...i, copies: Object.fromEntries(Object.entries(i.copies).filter(([b]) => b !== bot)) } : i));
      closeDialog();
      render();
      announce(`Removed ${nm(bot)} from the group`);
      return;
    }
    if (on("[data-remove-group]")) return openDialog("confirm-group", $("#title-pill"), { busy: false, error: false });
    if (on("[data-do-remove-group]")) {
      dlg.busy = true;
      drawDialog();
      later(350, () => {
        if (fail.delete("remove")) {
          dlg.busy = false;
          dlg.error = true;
          return drawDialog();
        }
        const g = m.group;
        const n = g.members.length;
        m.stageNote = `Removed ${g.name}. Its ${count[n]} tasks are in ${list(g.members.map((b) => `${nm(b)}'s`))} lists.`;
        m.group = null;
        m.view = { removed: true };
        closeDialog();
        render();
        announce("Removed the group");
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
      const made = dlg.making.filter((r) => r.bot !== "record" && r.done).map((r) => `${nm(r.bot)}'s`);
      closeDialog();
      m.stageNote = `No group was made. ${list(made)} new tasks stay in their lists, empty.`;
      $("#g-stage")?.remove();
      $("#transcript").insertAdjacentHTML("afterbegin", `<p class="g-stage-note" id="g-stage" role="status">${esc(m.stageNote)}</p>`);
      return;
    }

    // Group details.
    if (on("[data-rename]")) {
      dlg.renaming = true;
      dlg.typed = m.group.name;
      return drawDialog(), $("#g-name").focus();
    }
    if (on("[data-cancel-name]")) {
      Object.assign(dlg, { renaming: false, conflict: false, refused: false, typed: null });
      return drawDialog();
    }
    if (on("[data-save-name]")) return saveName();
    if (on("[data-add]")) return openDialog("add", el, { add: null, adding: null });
    if ((el = on("[data-add-pick]"))) {
      dlg.add = el.dataset.addPick;
      drawDialog();
      return $(`[data-add-pick="${dlg.add}"]`, dialog).focus();
    }
    if (on("[data-do-add]")) {
      dlg.adding = dlg.add;
      drawDialog();
      later(400, () => {
        m.group.members.push(dlg.adding);
        announce(`Added ${nm(dlg.adding)}`);
        render();
        openDialog("details", opener, { renaming: false });
      });
      return;
    }
    if (on("[data-dback]")) return openDialog("details", opener, { renaming: false });
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
        m.group.name = "Saturday"; // what the record holds now, as read
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
      m.mentionOpen = /(^|\s)@\w*$/.test(m.draft);
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
    groupMenu(row, event.clientX, event.clientY);
  });
  menu.addEventListener("click", (event) => {
    if (event.target.closest("[data-menu-details]")) {
      closeMenu(false);
      openDialog("details", $("#title-pill"), { renaming: false });
    }
    if (event.target.closest("[data-menu-rename]")) {
      closeMenu(false);
      openDialog("details", $("#title-pill"), { renaming: true, typed: m.group.name });
    }
  });

  // An answered approval: the run goes on, and Otto replies.
  document.addEventListener("ct:decision", (event) => {
    const item = m.items.find((i) => i.kind === "approval");
    if (!item) return;
    const decision = event.detail.decision;
    later(decision === "always" ? 1000 : 50, () => {
      item.done = true;
      m.runs.otto = { state: "thinking", phrase: "Thinking", elapsed: "0:09" };
      render();
      later(500, () => {
        delete m.runs.otto;
        m.items.push(said("otto", decision === "deny" ? "Understood. I won't list the files; tell me if you want me to look another way." : "It's steady at 71%. Nothing new has been written since this morning."));
        render();
      });
    });
  });

  // An answered question: the held copies to Otto go into its run, which then replies.
  document.addEventListener("ct:question", () => {
    const q = m.items.find((i) => i.kind === "question" && !i.done);
    if (!q) return;
    q.done = true;
    q.html = $("#g-question")?.outerHTML;
    const released = m.items.filter((i) => i.copies && i.copies.otto === "held");
    for (const i of released) i.copies.otto = "steer";
    if (released.length) announce("Sent to Otto");
    m.runs.otto = { state: "thinking", phrase: "Thinking", elapsed: "0:31" };
    render();
    later(500, () => {
      delete m.runs.otto;
      m.items.push(said("otto", "Thanks. I'll keep the cache for a week and clear it next Monday."));
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
    for (const item of m.items.filter((i) => i.held)) {
      item.held = false;
      for (const b of Object.keys(item.copies)) item.copies[b] = "sent";
    }
    announce("Connected");
    render();
  });

  // Start --------------------------------------------------------------------------------------

  m.items = history();
  if (state0 === "running") {
    m.items.push(you("Check the trail closures and the media box before we go.", { juniper: "sent", otto: "sent" }));
    m.runs.juniper = { state: "working", phrase: "Searching the web for trail closures", elapsed: "0:08", hold: true };
    m.runs.otto = { state: "working", phrase: "Reading backup-2026-11-15.log", elapsed: "0:12", hold: true };
  }
  if (state0 === "question") m.runs.otto = { state: "waiting", phrase: "Waiting for you", elapsed: "0:30", hold: true };
  if (state0 === "approval") m.runs.otto = { state: "waiting", phrase: "Waiting for you", elapsed: "0:21", hold: true };
  render();

  const compose = params.get("compose");
  if (compose === "mention") {
    m.draft = "@";
    m.mentionOpen = true;
  }
  if (compose === "otto") m.draft = "@Otto how full is the media box now?";
  if (compose === "reply") m.reply = { bot: "juniper", text: "The forecast is clear until 2 PM, so start the trail by 8.", id: m.items[2]?.id };
  if (compose === "quote") m.draft = "> Juniper: The forecast is clear until 2 PM, so start the trail by 8.\n@Marlow can the note go out by Friday?";
  if (compose) renderComposer(), CT.hydrate(document);

  const open = params.get("open");
  const picks = (params.get("pick") || "").split(",").filter(Boolean);
  if (open === "new") openDialog("new", $("#new-button"), { picked: picks, making: null, error: null });
  if (open === "details") openDialog("details", $("#title-pill"), { renaming: params.get("rename") === "1", typed: m.group?.name });
  const confirm = params.get("confirm");
  if (confirm === "member") openDialog("confirm-member", $("#title-pill"), { bot: "marlow" });
  if (confirm === "group") openDialog("confirm-group", $("#title-pill"), { busy: false, error: false });
  if (params.get("view") === "list") $(".shell").dataset.view = "list";
})();
