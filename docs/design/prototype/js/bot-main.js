// A bot's row opens its main conversation: docs/design/bot-opens-main.md.
// Prototype code, not product code.
//
// One state at a time, from the address:
//   side   wide | narrow | rail     the sidebar's width (#792's three widths)
//   bot    juniper | marlow | otto | pip   the open bot (default marlow)
//   task   a task's id: that task is open; absent: the bot's main conversation
//   menu   tasks: the header's Tasks menu open (only where the sidebar can't list them)
//   pane   list | conversation      at phone width, which of the two is shown
//
// The bots, their tasks and every line are made up. Clicking works: a bot's row
// opens its main conversation, the fold shows or hides its tasks, a task's row
// opens it, and in the rail the Tasks button lists the open bot's tasks.

(function () {
  const { CT } = window;
  const C = window.ClawtrateCreatures;
  const p = CT.params;
  const root = document.getElementById("bm-root");
  const live = document.getElementById("bm-live");

  const BOTS = [
    {
      id: "juniper",
      name: "Juniper",
      choice: { family: "clawling", body: "tall", eyes: "splayed", claws: "fiddler", color: "green" },
      main: true,
      tasks: [
        { id: "heat", title: "Heat pump vs. gas furnace", state: null },
        { id: "coffee", title: "Caffeine cutoff time", state: null },
      ],
    },
    {
      id: "marlow",
      name: "Marlow",
      choice: { family: "shellfolk", shell: "spiral", color: "blue" },
      main: true,
      tasks: [
        { id: "trail", title: "Trail apps compared", state: "working", by: true },
        { id: "club", title: "Book club questions", state: "waiting", by: true },
        { id: "intro", title: "Newsletter intro, tightened", state: null, unread: true },
      ],
    },
    {
      id: "otto",
      name: "Otto",
      choice: { family: "lantern", body: "round", lure: "hook", eyes: "two", color: "sky" },
      main: true,
      tasks: [{ id: "logs", title: "Rotate the logs on every machine in the rack", state: "working" }],
    },
    {
      id: "pip",
      name: "Pip",
      choice: { family: "clawling", body: "round", eyes: "pair", claws: "big", color: "orchid" },
      // No main conversation on the gateway yet: opening Pip shows an empty one.
      main: false,
      tasks: [],
    },
  ];
  const STATE_WORDS = { working: "Working", waiting: "Waiting for you", done: "Done" };

  const state = {
    side: ["wide", "narrow", "rail"].includes(p.get("side")) ? p.get("side") : "wide",
    bot: BOTS.some((b) => b.id === p.get("bot")) ? p.get("bot") : "marlow",
    task: p.get("task"),
    menu: p.get("menu") === "tasks",
    pane: p.get("pane") === "list" ? "list" : "conversation",
    // Bots whose tasks are unfolded without being open, and the open bot folded by hand.
    held: new Set(),
    folded: new Set(),
  };

  const esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  const say = (text) => {
    live.textContent = "";
    setTimeout(() => (live.textContent = text), 30);
  };
  const bot = (id) => BOTS.find((b) => b.id === id);
  const open = () => bot(state.bot);
  const openTask = () => open().tasks.find((t) => t.id === state.task) ?? null;

  // ---- the creatures, as avatars.js draws them, still -----------------------
  let clips = 0;
  function shape(s, clip) {
    const attrs = [];
    if (s.fill) attrs.push(`fill="${s.fill}"`);
    if (s.stroke) attrs.push(`stroke="${s.stroke}"`);
    if (s.strokeWidth !== undefined) attrs.push(`stroke-width="${s.strokeWidth}"`);
    if (s.round) attrs.push('stroke-linecap="round" stroke-linejoin="round"');
    if (s.opacity !== undefined) attrs.push(`opacity="${s.opacity}"`);
    if (s.transform) attrs.push(`transform="${s.transform}"`);
    if (s.clip) attrs.push(`clip-path="url(#${clip}-${s.clip})"`);
    if (s.rotate && s.origin)
      attrs.push(`style="transform-box:view-box;transform-origin:${s.origin[0]}px ${s.origin[1]}px;rotate:${s.rotate}deg"`);
    const a = attrs.join(" ");
    switch (s.kind) {
      case "path":
        return `<path ${a} d="${s.d}"/>`;
      case "circle":
        return `<circle ${a} cx="${s.cx}" cy="${s.cy}" r="${s.r}"/>`;
      case "ellipse":
        return `<ellipse ${a} cx="${s.cx}" cy="${s.cy}" rx="${s.rx}" ry="${s.ry}"/>`;
      case "rect":
        return `<rect ${a} x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}"${s.rx !== undefined ? ` rx="${s.rx}"` : ""}/>`;
      default:
        return `<g ${a}>${s.children.map((child) => shape(child, clip)).join("")}</g>`;
    }
  }
  function avatar(b, size) {
    const scene = C.avatarScene(b.choice, "idle", C.avatarVariation(b.id));
    const clip = `bm${++clips}`;
    const defs = Object.entries(C.AVATAR_EYE_CLIP)
      .map(([name, r]) => `<clipPath id="${clip}-${name}"><circle r="${r}"/></clipPath>`)
      .join("");
    const svg =
      `<svg viewBox="0 0 40 40" aria-hidden="true"><defs>${defs}</defs>` +
      `<g transform="translate(${scene.shift[0]} ${scene.shift[1]}) translate(20 20) scale(${scene.fit}) translate(-20 -20)">${shape(scene.root, clip)}</g></svg>`;
    return `<span class="bm-avatar"${size ? ` data-size="${size}"` : ""}>${svg}</span>`;
  }

  const ICON = {
    search: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="9" cy="9" r="5.5"/><path d="M13.2 13.2 17 17"/></svg>',
    plus: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M10 4v12M4 10h12"/></svg>',
    gear: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="2.6"/><path d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M4.9 15.1l1.4-1.4M13.7 6.3l1.4-1.4"/></svg>',
    chevron: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 3.5 4.5 4.5L6 12.5"/></svg>',
    back: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 4.5 7 10l5.5 5.5"/></svg>',
    panel: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="14" height="12" rx="2.5"/><path d="M12.5 4v12"/></svg>',
    list: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M7 6h9M7 10h9M7 14h9"/><circle cx="4" cy="6" r=".6" fill="currentColor"/><circle cx="4" cy="10" r=".6" fill="currentColor"/><circle cx="4" cy="14" r=".6" fill="currentColor"/></svg>',
  };

  // ---- what a bot's row says --------------------------------------------------
  const urgent = (b) =>
    b.tasks.some((t) => t.state === "waiting") ? "waiting" : b.tasks.some((t) => t.state === "working") ? "working" : null;
  // The rail only where the frame is wider than a phone: a phone's list is always full width.
  const railed = () => state.side === "rail" && document.documentElement.dataset.width !== "phone";
  const isOpen = (b) =>
    b.tasks.length > 0 && (state.held.has(b.id) || (b.id === state.bot && !state.folded.has(b.id)));
  // Whether the sidebar shows the bot's task rows: unfolded, and not in the rail.
  const shown = (b) => isOpen(b) && !railed();
  // The row's dot: its main conversation unread, or an unread task whose row isn't shown (the
  // task on screen aside).
  const rowUnread = (b) =>
    !shown(b) && b.tasks.some((t) => t.unread && !(b.id === state.bot && t.id === state.task));
  function botName(b) {
    const s = urgent(b);
    const n = b.tasks.length;
    return (
      b.name +
      (s ? `, ${s === "waiting" ? "waiting for you" : "working"}` : "") +
      (n ? `, ${n} ${n === 1 ? "task" : "tasks"}` : "") +
      (rowUnread(b) ? ", unread" : "")
    );
  }

  function sidebar() {
    const rows = BOTS.map((b) => {
      const opened = isOpen(b);
      const current = b.id === state.bot && !state.task;
      const s = urgent(b);
      const tasks = b.tasks.length
        ? `<ul class="bm-tasks" id="bm-tasks-${b.id}" aria-label="${esc(b.name)}'s tasks"${opened ? "" : " hidden"}>${b.tasks
            .map((t) => {
              const here = b.id === state.bot && t.id === state.task;
              return (
                `<li><button type="button" class="bm-task" data-bot="${b.id}" data-task="${t.id}"` +
                `${here ? ' aria-current="page"' : ""} aria-label="${esc(t.title)}${t.state ? `, ${STATE_WORDS[t.state].toLowerCase()}` : ""}${t.unread ? ", unread" : ""}" title="${esc(t.title)}">` +
                `<span class="bm-task-title">${esc(t.title)}</span>` +
                (t.state ? `<span class="bm-task-state" data-state="${t.state}">${STATE_WORDS[t.state]}</span>` : "") +
                (t.unread && !here ? '<span class="bm-dot" aria-hidden="true"></span>' : "") +
                "</button></li>"
              );
            })
            .join("")}</ul>`
        : "";
      return (
        `<li class="bm-group"${opened ? " data-open" : ""}>` +
        `<div class="bm-row"><button type="button" class="bm-bot" data-bot="${b.id}"` +
        `${current ? ' aria-current="page"' : ""}` +
        `${rowUnread(b) ? " data-unread" : ""} aria-label="${esc(botName(b))}" title="${esc(b.name)}">` +
        `<span class="bm-avatar-wrap">${avatar(b)}${s ? `<span class="bm-mark" data-state="${s}" aria-hidden="true"></span>` : ""}</span>` +
        `<span class="bm-name">${esc(b.name)}</span>` +
        (rowUnread(b) ? '<span class="bm-dot" aria-hidden="true"></span>' : "") +
        "</button>" +
        (b.tasks.length
          ? `<button type="button" class="bm-fold" data-fold="${b.id}" aria-expanded="${opened}" aria-controls="bm-tasks-${b.id}" aria-label="${opened ? "Hide" : "Show"} ${esc(b.name)}'s tasks">${ICON.chevron}</button>`
          : "") +
        `</div>${tasks}</li>`
      );
    }).join("");
    return (
      '<nav class="bm-side" aria-label="Bots">' +
      `<div class="bm-side-top"><button type="button" class="bm-icon" aria-label="Search">${ICON.search}</button>` +
      `<button type="button" class="bm-icon" aria-label="New">${ICON.plus}</button></div>` +
      `<ul class="bm-list" aria-label="Bots">${rows}</ul>` +
      '<div class="bm-side-foot"><span class="bm-gw"><strong>Home gateway</strong>Connected</span>' +
      `<span class="bm-foot-buttons">` +
      (state.side === "rail"
        ? `<button type="button" class="bm-icon" aria-label="Search">${ICON.search}</button><button type="button" class="bm-icon" aria-label="New">${ICON.plus}</button>`
        : "") +
      `<button type="button" class="bm-icon" aria-label="Settings">${ICON.gear}</button></span></div>` +
      "</nav>"
    );
  }

  // ---- the conversation -------------------------------------------------------
  function header() {
    const b = open();
    const t = openTask();
    const rail = railed();
    const tasksButton =
      rail && b.tasks.length
        ? `<button type="button" class="bm-tasks-button" data-action="tasks" aria-haspopup="menu" aria-expanded="${state.menu}" aria-label="${esc(b.name)}'s tasks, ${b.tasks.length}">${ICON.list}${b.tasks.length}</button>`
        : "";
    const menu =
      rail && state.menu
        ? `<ul class="bm-menu" role="menu" aria-label="${esc(b.name)}'s tasks">` +
          `<li role="none"><button type="button" class="bm-menu-item" role="menuitemradio" aria-checked="${!t}" data-bot="${b.id}">${esc(b.name)}</button></li>` +
          '<li class="bm-menu-rule" role="separator"></li>' +
          b.tasks
            .map(
              (x) =>
                `<li role="none"><button type="button" class="bm-menu-item" role="menuitemradio" aria-checked="${x.id === state.task}" data-bot="${b.id}" data-task="${x.id}"><span class="bm-task-title">${esc(x.title)}</span>${x.state ? `<span class="bm-task-state" data-state="${x.state}">${STATE_WORDS[x.state]}</span>` : ""}</button></li>`,
            )
            .join("") +
          '<li class="bm-menu-rule" role="separator"></li>' +
          `<li role="none"><button type="button" class="bm-menu-item" role="menuitem">New task<span class="bm-task-state" style="margin-left:auto">⌘T</span></button></li></ul>`
        : "";
    return (
      '<header class="bm-head">' +
      `<button type="button" class="bm-icon bm-back" data-action="back" aria-label="Back to bots">${ICON.back}</button>` +
      `<button type="button" class="bm-pill" aria-label="${esc(t ? `${b.name}, ${t.title}. Show details.` : `${b.name}. Show details.`)}">` +
      `${avatar(b, "pill")}<span class="bm-pill-name">${esc(b.name)}</span>` +
      (t ? `<span class="bm-pill-task">${esc(t.title)}</span>` : "") +
      "</button>" +
      `<span class="bm-head-end">${tasksButton}<button type="button" class="bm-icon" aria-label="Show work panel">${ICON.panel}</button></span>` +
      menu +
      "</header>"
    );
  }

  const person = (text) => `<p class="bm-msg" data-from="person">${esc(text)}</p>`;
  const said = (text) => `<p class="bm-msg" data-from="bot">${esc(text)}</p>`;
  function card(b, t, brief) {
    return (
      `<div class="bm-card" role="group" aria-label="Started a task: ${esc(t.title)}, ${STATE_WORDS[t.state ?? "done"].toLowerCase()}">` +
      `${avatar(b, "card")}<span class="bm-card-kind">Started a task</span>` +
      `<span class="bm-card-state" data-state="${t.state ?? "done"}">${STATE_WORDS[t.state ?? "done"]}</span>` +
      `<span class="bm-card-title">${esc(t.title)}</span><span class="bm-card-brief">${esc(brief)}</span>` +
      `<button type="button" class="bm-card-open" data-bot="${b.id}" data-task="${t.id}">Open</button></div>`
    );
  }

  function transcript() {
    const b = open();
    const t = openTask();
    if (!b.main && !t) {
      return (
        `<div class="bm-empty">${avatar(b)}<h1 tabindex="-1">Nothing here yet</h1>` +
        `<p>Ask ${esc(b.name)} anything, or to put work in a task.</p></div>`
      );
    }
    let body;
    if (t) {
      const from = t.by
        ? `<p class="bm-started-line">${esc(b.name)} started this task from its main conversation · <button type="button" class="bm-link" data-bot="${b.id}">Open</button></p>`
        : "";
      body =
        `<h1 class="bm-heading" tabindex="-1">${esc(t.title)}</h1>${from}` +
        (t.id === "trail"
          ? person("Compare the three trail apps we talked about: offline maps, price, and how they handle a dead battery.") +
            said("Looking at offline maps first. Two of the three keep maps on the phone; one needs a download per region.")
          : said("Here is where this task stands."));
    } else if (b.id === "marlow") {
      const [trail, club] = b.tasks;
      body =
        `<h1 class="bm-heading visually-hidden" tabindex="-1">${esc(b.name)}</h1>` +
        '<p class="bm-quiet">Yesterday</p>' +
        person("Tighten the intro of the newsletter draft.") +
        said("Done: cut about 80 words and moved the date to the first line.") +
        '<p class="bm-quiet">Today</p>' +
        person("Put the book club questions in a task, and compare the trail apps in another one. Tell me when they need me.") +
        said("Started both. I'll tell you here when one is done or needs you.") +
        card(b, club, "Ten questions for chapters 4 to 6, none with yes-or-no answers.") +
        card(b, trail, "Compare three trail apps: offline maps, price, battery.") +
        said("The book club task is waiting for you to choose between two question sets.");
    } else {
      body =
        `<h1 class="bm-heading visually-hidden" tabindex="-1">${esc(b.name)}</h1>` +
        person("What's on for today?") +
        said("Nothing urgent. The furnace quotes are in their task, and I can start another one whenever you like.");
    }
    return `<div class="bm-transcript">${body}</div>`;
  }

  function main() {
    const b = open();
    return (
      `<section class="bm-main" aria-label="Conversation">${header()}` +
      `<div class="bm-scroll">${transcript()}</div>` +
      `<div class="bm-composer" aria-hidden="true">Message ${esc(b.name)}</div></section>`
    );
  }

  function draw() {
    // At phone width the list is the whole screen, as at full width, whatever the side says.
    root.dataset.side = railed() || state.side !== "rail" ? state.side : "wide";
    root.dataset.pane = state.pane;
    root.innerHTML = sidebar() + main();
  }

  function openBot(id, taskId = null) {
    state.bot = id;
    state.task = taskId;
    state.menu = false;
    state.folded.delete(id);
    state.pane = "conversation";
    draw();
    const b = bot(id);
    const t = taskId ? b.tasks.find((x) => x.id === taskId) : null;
    say(t ? `${b.name}, ${t.title}` : `${b.name}, main conversation`);
    root.querySelector(".bm-main h1")?.focus();
  }

  root.addEventListener("click", (event) => {
    const el = event.target.closest("button");
    if (!el) return;
    if (el.dataset.fold) {
      const b = bot(el.dataset.fold);
      if (isOpen(b)) {
        state.held.delete(b.id);
        if (b.id === state.bot) state.folded.add(b.id);
      } else {
        state.held.add(b.id);
        state.folded.delete(b.id);
      }
      draw();
      return;
    }
    if (el.dataset.action === "tasks") {
      state.menu = !state.menu;
      draw();
      if (state.menu) root.querySelector(".bm-menu-item")?.focus();
      return;
    }
    if (el.dataset.action === "back") {
      state.pane = "list";
      draw();
      root.querySelector('.bm-bot[aria-current="page"], .bm-task[aria-current="page"]')?.focus();
      return;
    }
    if (el.dataset.bot) openBot(el.dataset.bot, el.dataset.task ?? null);
  });

  // Right and Left on a bot's row show and hide its tasks, as its fold does; Left on a task goes to its bot.
  root.addEventListener("keydown", (event) => {
    const row = event.target.closest?.(".bm-bot, .bm-task");
    if (!row) return;
    const b = bot(row.dataset.bot);
    if (event.key === "ArrowRight" && row.classList.contains("bm-bot") && b.tasks.length && !isOpen(b)) {
      event.preventDefault();
      state.held.add(b.id);
      state.folded.delete(b.id);
      draw();
      root.querySelector(`.bm-bot[data-bot="${b.id}"]`)?.focus();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.classList.contains("bm-task") || !isOpen(b)) {
        root.querySelector(`.bm-bot[data-bot="${b.id}"]`)?.focus();
        return;
      }
      state.held.delete(b.id);
      if (b.id === state.bot) state.folded.add(b.id);
      draw();
      root.querySelector(`.bm-bot[data-bot="${b.id}"]`)?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      // Only rows on screen: a folded bot's or the rail's task rows are hidden and can't take focus.
      const rows = [...root.querySelectorAll(".bm-bot, .bm-task")].filter((each) => each.checkVisibility());
      const at = rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1);
      rows[Math.max(0, Math.min(rows.length - 1, at))]?.focus();
    }
  });

  document.addEventListener("ct:settings", draw);
  draw();
})();
