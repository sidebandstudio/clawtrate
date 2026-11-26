// The Main Bot's first run, as a conversation: docs/design/main-bot-onboarding.md.
// Prototype code, not product code.
//
// One first run at a time, from the address:
//   at        start | greeted | named | task | done   (played to that point)
//   account   none: no model account yet, so the sign-ins come first
//   name      bot: the bot names itself without the person typing the name
//   slow      1: the hello doesn't come
//   opening   unconfirmed: the first message couldn't be confirmed after its resend
//             failed: the gateway couldn't run the first message and didn't say why (#686's line)
//             model: the account couldn't run the bot's model, so the next one it lists is used
//             nomodel: the account runs none of its listed models (#686's line, no Try again)
//             taken: someone else wrote first under the first message's key
//   device    limited: a device without full control while the first run's questions are open
//   from      juniper: the Main Bot started from what another bot knows
//   existing  1: a Main Bot already made, on another device
//   plugin    missing: the Main Bot's menu without Clawtrate's bot tools
//
// The bot's lines are a fixture: one way a real model might follow Clawtrate's
// brief. The app's own lines are Clawtrate's. Nothing here asks the person to
// approve anything: what the app does is shown, with Undo. The rail, the title
// pill and the composer change only on the stand-in gateway's read-back.

(function () {
  const { CT } = window;
  const p = CT.params;
  const root = document.getElementById("mb-root");
  const live = document.getElementById("mb-live");

  const state = {
    at: p.get("at"),
    account: p.get("account") === "none" ? "none" : "ok",
    selfName: p.get("name") === "bot",
    slow: p.get("slow") === "1",
    opening: p.get("opening"),
    // Only while the first run's questions are open; a Main Bot already made has none.
    limited: p.get("device") === "limited" && p.get("existing") !== "1",
    fromKept: p.get("from") === "juniper",
    from: p.get("from") === "juniper",
    existing: p.get("existing") === "1",
    plugin: p.get("plugin") === "missing" ? "missing" : "present",
    mainMenu: false,
    briefOpen: false,
  };
  const MAIN = "clawtrate-main-bot";
  const START_NAME = "Clawtrate Main Bot";

  const esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  const say = (text) => {
    live.textContent = "";
    setTimeout(() => (live.textContent = text), 30);
  };
  // A name as the gateway stores it: whitespace collapsed and trimmed (R26).
  const norm = (s) =>
    String(s || "")
      .replace(/\s+/g, " ")
      .trim();
  const reduced = () => document.documentElement.dataset.motion === "reduce";
  const phone = () => document.documentElement.dataset.width === "phone";

  // ---- a stand-in Claw, drawn from the name -------------------------------
  // Not #300's creatures (they are not on main): a body, two eyes on stalks
  // and two claws, hashed from the name as #302's name Claw does.

  const COLORS = {
    green: "#3fb67b",
    blue: "#4a7cf0",
    orchid: "#c05fd0",
    violet: "#7b61e8",
    yellow: "#e2b93b",
    pink: "#e86aa3",
    sky: "#3eaee0",
    lime: "#8cc63f",
  };
  const fnv = (text) => {
    let h = 0x811c9dc5;
    for (const ch of text) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  };
  function clawChoice(name) {
    const key = name.trim().normalize("NFC").toLowerCase();
    const pick = (field, list) =>
      list[fnv(`clawtrate-name\u0000${key}\u0000${field}`) % list.length];
    return {
      color: pick("color", Object.keys(COLORS)),
      body: pick("body", ["dome", "tall", "wide", "round"]),
      eyes: pick("eyes", ["pair", "splayed", "short"]),
    };
  }
  function claw(name, size, opts = {}) {
    const c = clawChoice(name);
    const fill = COLORS[c.color];
    const body = {
      dome: '<path d="M14 46c0-12 8-22 18-22s18 10 18 22v2H14z"/>',
      tall: '<rect x="19" y="20" width="26" height="30" rx="12"/>',
      wide: '<rect x="11" y="28" width="42" height="21" rx="10"/>',
      round: '<circle cx="32" cy="37" r="14"/>',
    }[c.body];
    const spread = { pair: 7, splayed: 11, short: 6 }[c.eyes];
    const top = c.eyes === "short" ? 17 : 12;
    const eye = (dx) =>
      `<path d="M${32 + dx * 0.5} 26 L${32 + dx} ${top + 4}" stroke="${fill}" stroke-width="3" stroke-linecap="round"/>` +
      `<circle cx="${32 + dx}" cy="${top}" r="5" fill="#fff"/><circle cx="${32 + dx + 0.8}" cy="${top + 0.6}" r="2.2" fill="#15161a"/>`;
    const clawPath = (x, flip) =>
      `<path transform="translate(${x} 38) scale(${flip} 1)" d="M0 0c-6-1-9 3-8 7 3-2 5-2 7 0-3 1-4 4-3 6 5 0 8-5 4-13z" fill="${fill}"/>`;
    const star = opts.star
      ? `<span class="mb-star" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M8 1.6l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.2l-3.9 2.2.9-4.3-3.3-3 4.4-.5z"/></svg></span>`
      : "";
    return (
      `<span class="mb-avatar" style="--size:${size}px" aria-hidden="true">` +
      `<svg viewBox="0 0 64 64"><g fill="${fill}">${body}</g>${clawPath(14, 1)}${clawPath(50, -1)}${eye(-spread)}${eye(spread)}` +
      `<path d="M28 41q4 3 8 0" stroke="#15161a" stroke-width="2" fill="none" stroke-linecap="round"/></svg>${star}</span>`
    );
  }

  // ---- the stand-in gateway -------------------------------------------------

  const gateway = {
    bots: [],
    // A check can hold the stand-in's answer (window.mbHold) to see the state
    // before the read-back, then release it.
    answer(ms, fn) {
      return new Promise((resolve) => {
        const go = () => (window.mbHold ? setTimeout(go, 20) : resolve(fn()));
        setTimeout(go, reduced() ? 0 : ms);
      });
    },
  };
  // The Main Bot is a bot Clawtrate made (id MAIN), never the gateway's own
  // bot. The gateway's own bot (`own`) stays on the gateway and out of the rail
  // once another bot exists (#490). Pip, Otto and Marlow stay as they were.
  function seedBots() {
    const main = state.existing
      ? { id: MAIN, name: "Juniper", main: true }
      : { id: MAIN, name: START_NAME, main: true };
    gateway.bots = [
      { id: "main", name: "main", own: true, preview: "Channel messages" },
      main,
      { id: "pip", name: "Pip", preview: "Saturday errands route" },
      { id: "otto", name: "Otto", preview: "Weekly backup check" },
      { id: "marlow", name: "Marlow", preview: "Neighborhood newsletter intro" },
    ];
  }
  const botById = (id) => gateway.bots.find((b) => b.id === id);
  const mainBot = () => botById(MAIN);
  const shown = () => {
    const others = gateway.bots.filter((b) => !b.own);
    return others.length ? others : gateway.bots;
  };
  // The name before, kept so Undo works after a restart and on the person's
  // other devices (users.prefs in the design). Here: in memory.
  let kept = null;

  // ---- rendering --------------------------------------------------------------

  let items = [];
  let composer = { value: "" };
  let task = null; // { title, state: "Working" | "Done" }
  let tour = { active: false, step: "name" }; // name | naming | help | task | over
  let waitingForName = []; // what the person wrote while the name was being taken

  function rail() {
    const m = shown().find((b) => b.main);
    const sub = task
      ? `<button type="button" class="mb-task-row" data-testid="rail-task"${task.open ? ' aria-current="true"' : ""} aria-label="${esc(`${task.title}, ${task.state}, a task of ${m.name}`)}">` +
        `<span class="mb-task-title">${esc(task.title)}</span><span class="mb-task-state" data-state="${task.state === "Done" ? "done" : "working"}">${esc(task.state)}</span></button>`
      : "";
    const tile = m
      ? `<div class="mb-tile-wrap"><button type="button" class="mb-tile" data-bot="${m.id}" data-testid="main-tile"${task?.open ? "" : ' aria-current="true"'} aria-label="${esc(`${m.name}, Main Bot`)}">` +
        `${claw(m.name, 56, { star: true })}<strong class="mb-name" data-testid="rail-name-${m.id}" title="${esc(m.name)}">${esc(m.name)}</strong></button>` +
        `<button type="button" class="mb-tile-more" data-act="main-menu" aria-expanded="${state.mainMenu}" aria-label="${esc(`${m.name} options`)}">⋯</button>${mainMenu()}</div>${sub}`
      : "";
    const rows = shown()
      .filter((b) => !b.main)
      .map(
        (b) =>
          `<li><button type="button" class="mb-row" data-bot="${b.id}" aria-label="${esc(b.name)}">` +
          `${claw(b.name, 40)}<span class="mb-row-text"><strong class="mb-name" data-testid="rail-name-${b.id}">${esc(b.name)}</strong>` +
          `<span class="mb-preview">${esc(b.preview || "")}</span></span></button></li>`,
      )
      .join("");
    return (
      `<nav class="mb-rail" aria-label="Bots"><div class="mb-rail-top"><span class="mb-brand">Clawtrate</span>` +
      `<button type="button" class="mb-round" aria-label="New">+</button></div>${tile}<ul class="mb-list">${rows}</ul>` +
      `<div class="mb-rail-foot"><button type="button" class="mb-gw"><span class="mb-dot"></span><span><strong>Home gateway</strong><span>Connected</span></span></button></div></nav>`
    );
  }

  // The Main Bot's menu. Changing which bot is the Main Bot needs the plugin's
  // gateway-wide record (section 4); without the plugin it isn't offered.
  function mainMenu() {
    if (!state.mainMenu) return "";
    const body =
      state.plugin === "missing"
        ? `<p class="mb-hint" data-testid="main-menu-note">Changing the Main Bot needs Clawtrate's bot tools on your gateway.</p>`
        : `<button type="button" class="mb-menu-item" role="menuitem" data-act="replace-main">Replace with different bot</button>`;
    return `<div class="mb-menu" role="${state.plugin === "missing" ? "group" : "menu"}" data-testid="main-menu" aria-label="Main Bot options">${body}</div>`;
  }

  function header() {
    const b = mainBot();
    const back = phone()
      ? `<button type="button" class="mb-round mb-back" aria-label="Back to bots">‹</button>`
      : "";
    return (
      `<header class="mb-head">${back}<button type="button" class="mb-pill" data-testid="title-pill" aria-label="${esc(`${b.name}, Main Bot`)}">` +
      `${claw(b.name, 22, { star: true })}<span class="mb-pill-name" data-testid="title-name">${esc(b.name)}</span></button></header>`
    );
  }

  // Pull request 4's brief, word for word as the design publishes it (section 3).
  const BRIEF = [
    "[Clawtrate] Clawtrate made you a moment ago as this person's Main Bot, and this is your first conversation. They haven't written yet, so say hello first.",
    "Lead, one short message and one question at a time:\n" +
      '1. Ask what they\'d like to call you. When they answer, write that name on the "- Name:" line of your IDENTITY.md and change nothing else there. Clawtrate shows it at once.\n' +
      "2. Ask what they'd like help with. Before you look anything up, add one short note of what they said at the end of your USER.md, and leave the rest of the file as it is.\n" +
      "3. Show them how you work in Clawtrate: start one task with sessions_spawn and visible: true, with a short label and a full brief, that makes something small and useful for what they said they want help with and saves it as a file. Tell them in a sentence that you started it, that they can watch it under your name in the sidebar, and that they can stop or archive it there. When its result comes back, hand them the file with a MEDIA: line.\n" +
      "4. Then tell them they can ask you anything, or ask you to start something in its own task.",
    "If they want to skip, or ask for something else at any point, stop the tour and help with that. Don't ask them to set anything up, and don't mention this message.",
  ].join("\n\n");

  function item(it) {
    switch (it.kind) {
      case "quiet":
        return (
          `<div class="mb-quiet" data-testid="brief-line"><p>Clawtrate started this conversation · ` +
          `<button type="button" class="mb-link" data-act="brief" aria-expanded="${state.briefOpen}" aria-controls="mb-brief">${state.briefOpen ? "Hide" : "Show"}</button></p>` +
          `<p class="mb-brief" id="mb-brief" data-testid="brief-text"${state.briefOpen ? "" : " hidden"}>${esc(BRIEF)}</p></div>`
        );
      case "user":
        return `<div class="mb-msg is-user"><p class="mb-bubble">${esc(it.text)}</p></div>`;
      case "bot":
        return `<div class="mb-msg is-bot">${claw(mainBot().name, 18)}<p class="mb-bubble">${esc(it.text)}</p></div>`;
      case "status":
        return `<p class="mb-status" role="status"><span class="mb-dots" aria-hidden="true"><i></i><i></i><i></i></span>${esc(it.text)}</p>`;
      case "line": {
        const acts = (it.actions || [])
          .map(
            ([label, act]) =>
              ` · <button type="button" class="mb-link" data-act="${act}">${esc(label)}</button>`,
          )
          .join("");
        const words = typeof it.text === "function" ? it.text() : it.text;
        return `<p class="mb-line" data-testid="${it.testid || "app-line"}">${esc(words)}${acts}</p>`;
      }
      case "app":
        return app(it);
      case "task":
        return (
          `<article class="mb-card" data-kind="task" data-testid="card-task" aria-label="${esc(`Started a task: ${task.title}`)}">` +
          `<div class="mb-card-head">${claw(mainBot().name, 18)}<strong>Started a task</strong></div>` +
          `<div class="mb-card-row"><span>Task</span><span><strong>${esc(task.title)}</strong></span></div>` +
          `<div class="mb-card-row"><span>Brief</span><span>A starter checklist for the week, saved as a file.</span></div>` +
          `<p class="mb-card-state" data-testid="task-state">${esc(task.state)}</p>` +
          `<div class="mb-card-actions"><button type="button" class="mb-btn" data-variant="quiet" data-act="open-task">Open task</button></div></article>`
        );
      case "file":
        return (
          `<article class="mb-card" data-kind="file" data-testid="card-file" aria-label="week-checklist.md, a file from ${esc(mainBot().name)}">` +
          `<div class="mb-file"><span class="mb-file-icon" aria-hidden="true">▤</span><span><strong>week-checklist.md</strong><span>Markdown · 2 KB</span></span></div>` +
          `<div class="mb-card-actions"><button type="button" class="mb-btn" data-variant="quiet" data-act="save-file">${it.saved ? "Saved" : "Save"}</button></div></article>`
        );
      default:
        return "";
    }
  }

  // Clawtrate's own messages in the conversation: never the bot's words.
  function app(it) {
    const buttons = (it.buttons || [])
      .map(
        ([label, act, variant]) =>
          `<button type="button" class="mb-btn" data-variant="${variant || "quiet"}" data-act="${act}">${esc(label)}</button>`,
      )
      .join("");
    return (
      `<section class="mb-app" data-testid="${it.testid}" aria-label="From Clawtrate"><p class="mb-app-from">Clawtrate</p>` +
      `<p>${esc(it.text)}</p>${it.note ? `<p class="mb-hint">${esc(it.note)}</p>` : ""}` +
      (buttons ? `<div class="mb-app-actions">${buttons}</div>` : "") +
      `</section>`
    );
  }

  // On a phone the task opens in place of the conversation, with a way back.
  function taskView() {
    const b = mainBot();
    return (
      `<section class="mb-conv" data-testid="task-view" aria-label="${esc(task.title)}"><header class="mb-head">` +
      `<button type="button" class="mb-round mb-back" data-act="close-task" aria-label="${esc(`Back to ${b.name}`)}">‹</button>` +
      `<span class="mb-pill-name">${esc(task.title)}</span></header><div class="mb-transcript"><div class="mb-transcript-inner">` +
      `<p class="mb-line">${esc(`${b.name} started this task from Main`)}</p>` +
      `<p class="mb-line" data-testid="task-view-state">${esc(task.state)}</p></div></div></section>`
    );
  }

  function render() {
    const focus = document.activeElement?.id;
    const focusAct = document.activeElement?.dataset?.act;
    const b = mainBot();
    const skip =
      tour.active && !state.limited
        ? `<div class="mb-skip-wrap"><button type="button" class="mb-chip" data-act="skip" data-testid="skip">Skip the tour</button></div>`
        : "";
    const pane =
      phone() && task?.open
        ? taskView()
        : `<section class="mb-conv" aria-label="Conversation">${header()}` +
      `<div class="mb-transcript" data-testid="transcript"><div class="mb-transcript-inner">${items.map(item).join("")}</div></div>${skip}` +
      (state.limited
        ? `<p class="mb-line mb-limited" data-testid="limited-line">You can write to your Main Bot here once it's set up.</p></section>`
        : `<form class="mb-composer" data-testid="composer"><label class="visually-hidden" for="mb-input">Message</label>` +
          `<textarea id="mb-input" rows="1" placeholder="Message ${esc(b.name)}">${esc(composer.value)}</textarea>` +
          `<button type="submit" class="mb-send" aria-label="Send" ${composer.value ? "" : "disabled"}>↑</button></form></section>`);
    root.innerHTML = `<div class="mb-shell" data-phone="${phone()}">${phone() ? "" : rail()}${pane}</div>`;
    const t = root.querySelector(".mb-transcript");
    t.scrollTop = t.scrollHeight;
    if (focus && document.getElementById(focus)) document.getElementById(focus).focus();
    else if (focusAct) root.querySelector(`[data-act="${focusAct}"]`)?.focus();
  }

  // ---- the first run ----------------------------------------------------------

  const wait = (ms) => gateway.answer(ms, () => {});
  async function botSays(text, ms = 700) {
    const writing = { kind: "status", text: `${mainBot().name} is writing…` };
    items.push(writing);
    render();
    await wait(ms);
    items = items.filter((x) => x !== writing);
    items.push({ kind: "bot", text });
    render();
  }

  async function play() {
    if (state.existing) {
      items.push({ kind: "bot", text: "Morning! Your backup finished at 6:10." });
      return render();
    }
    if (state.account === "none") {
      items.push({
        kind: "app",
        testid: "account-step",
        text: "Before your Main Bot can talk, it needs an account with a model provider. Sign in with one you already have.",
        note: "Your gateway keeps the sign-in; Clawtrate never sees your password.",
        buttons: [
          ["ChatGPT in the browser", "sign-in", "primary"],
          ["GitHub Copilot", "sign-in"],
          ["OpenRouter", "sign-in"],
          ["Use an API key", "sign-in"],
        ],
      });
      return render();
    }
    await opening();
  }

  async function opening() {
    // A first row under the opening's key with other words is someone else's
    // message, drawn as what it is; only the published brief is the quiet line.
    if (state.opening === "taken") items.push({ kind: "user", text: "Hey, are you there?" });
    else items.push({ kind: "quiet" });
    if (state.from)
      items.push({
        kind: "line",
        testid: "from-line",
        text: () =>
          `${mainBot().name} started from what Juniper knows: its memory, what it knows about you. 2 skills stay with Juniper`,
        actions: [
          ["See what", "see-what"],
          ["Undo", "undo-from"],
        ],
      });
    render();
    if (state.opening === "unconfirmed") {
      items.push({
        kind: "line",
        testid: "opening-line",
        text: "Clawtrate couldn't confirm your Main Bot got its first message. You can write to it yourself.",
      });
      return render();
    }
    if (state.opening === "taken") {
      items.push({
        kind: "line",
        testid: "opening-line",
        text: "Someone else wrote first in this conversation, so Clawtrate didn't send its first message.",
      });
      return render();
    }
    if (state.opening === "failed") {
      items.push({
        kind: "line",
        testid: "failed-line",
        text: "The gateway couldn't run this message. The gateway didn't say why.",
        actions: [["Try again", "try-again"]],
      });
      return render();
    }
    // The account can't run the bot's model: never sent again on it; the next
    // model the account lists is set, said where the failure shows, and tried once.
    if (state.opening === "model" || state.opening === "nomodel")
      items.push({
        kind: "line",
        testid: "model-line",
        text: "Your account couldn't run GPT-5.5 Pro, so your Main Bot now uses GPT-5.5.",
      });
    if (state.opening === "nomodel") {
      items.push({
        kind: "line",
        testid: "failed-line",
        text: `The gateway couldn't run this message. ${mainBot().name} is set to a model that needs a provider API key, but the account it uses is a sign-in. Choose a model that works with that sign-in, or add an API key.`,
        actions: [
          ["Change model", "change-model"],
          ["Change account", "change-account"],
        ],
      });
      return render();
    }
    if (state.slow) {
      items.push({ kind: "status", text: `${mainBot().name} is writing…` });
      items.push({
        kind: "line",
        testid: "slow-line",
        text: "Your Main Bot hasn't answered yet.",
        actions: [["Stop", "stop"]],
      });
      return render();
    }
    await hello();
  }

  async function hello() {
    tour = { active: true, step: "name" };
    const text = state.fromKept
      ? "Hi Sam! I'm your new bot in Clawtrate, and I've picked up what Juniper knew about you. First things first: what would you like to call me?"
      : "Hi! I'm your new bot in Clawtrate. First things first: what would you like to call me?";
    await botSays(text, 900);
    if (state.at === "start") return;
    await fastForward();
  }

  // Plays the person's answers up to the point the address asks for.
  async function fastForward() {
    const order = ["greeted", "named", "task", "done"];
    const upTo = order.indexOf(state.at);
    // A Skip pressed meanwhile ends the tour: no scripted answer is posted after it.
    if (upTo < 1 || !tour.active) return;
    await answer(state.selfName ? "You pick one!" : "Maple");
    if (upTo < 2 || !tour.active) return;
    await answer("Keeping my week organised, and some coding.", upTo < 3);
  }

  // What the stand-in bot does with each answer, by the tour's step.
  async function answer(text, holdTask = false) {
    items.push({ kind: "user", text });
    render();
    return reply(text, holdTask);
  }

  async function reply(text, holdTask = false) {
    const step = tour.step;
    if (!tour.active || step === "over")
      return botSays("Happy to help. What would you like to do?");
    // Asking to skip, in any words, ends the tour wherever it is.
    if (/\bskip\b|\bno tour\b/i.test(text)) return endTour("Sure, no tour. I'm here whenever you need me.");
    // A second message while the name is being taken waits for it.
    if (step === "naming") return void waitingForName.push(text);
    if (step === "name") {
      tour.step = "naming";
      // The bot writes its own name line. Clawtrate checks, silently, whether
      // the name is in what the person typed: that decides only the line's words.
      const typed = !/\byou (pick|choose)\b/i.test(text);
      const name = typed ? norm(text.split("\n")[0]).slice(0, 40) : "Scout";
      return takeName(name, typed);
    }
    // The bot doesn't wait for a yes: it starts the task and says so.
    if (step === "help") return startTask(holdTask);
    return botSays("I'm on it.");
  }

  async function takeName(name, typed) {
    const before = mainBot().name;
    items.push({ kind: "status", text: `${before} is writing…` });
    render();
    const read = await gateway.answer(900, () => {
      mainBot().name = name;
      return { name: mainBot().name };
    });
    items = items.filter((x) => x.kind !== "status");
    kept = { before, after: read.name };
    items.push({
      kind: "line",
      testid: "named-line",
      text: typed ? `Renamed to ${read.name}` : `${before} renamed itself to ${read.name}`,
      actions: [["Undo", "undo-name"]],
    });
    say(typed ? `Renamed to ${read.name}` : `${before} renamed itself to ${read.name}`);
    render();
    // Skipped while the name was being taken: the name stays, the tour doesn't
    // go on, and what the person wrote meanwhile is still answered.
    if (tour.active && tour.step === "naming") {
      tour.step = "help";
      await botSays(
        `${read.name} it is. What would you like a hand with? Anything from your week to your code.`,
      );
    }
    const waiting = waitingForName;
    waitingForName = [];
    for (const text of waiting) await reply(text);
  }

  async function startTask(hold) {
    tour.step = "task";
    await botSays(
      "Got it, I'll remember that. To show you how I work here, I've started a task that puts a starter checklist for your week together while we keep talking. You can watch it under my name in the sidebar, and stop or archive it there if you don't want it.",
    );
    task = { title: "Week checklist", state: "Working" };
    items.push({ kind: "task" });
    render();
    say(`Started a task: ${task.title}`);
    if (hold) return;
    await wait(1200);
    task.state = "Done";
    items.push({
      kind: "bot",
      text: "It's done. Here's the checklist. You'll find the task under my name whenever you want it.",
    });
    items.push({ kind: "file" });
    render();
    // The task's result and file come whatever happened; the wrap-up only while the tour runs.
    if (!tour.active) return;
    await endTour(
      "That's the tour. Ask me anything, or ask me to start something in its own task.",
    );
  }

  async function endTour(text) {
    tour = { active: false, step: "over" };
    await botSays(text);
  }

  // ---- events ---------------------------------------------------------------

  root.addEventListener("click", async (event) => {
    const t = event.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    if (act === "main-menu") {
      state.mainMenu = !state.mainMenu;
      render();
      return root.querySelector('[data-act="main-menu"]')?.focus();
    }
    if (act === "brief") {
      state.briefOpen = !state.briefOpen;
      render();
      return root.querySelector('[data-act="brief"]')?.focus();
    }
    if (act === "sign-in") {
      const card = items.find((x) => x.testid === "account-step");
      Object.assign(card, {
        text: "Signing in… Finish on the page that opened.",
        buttons: [],
        note: "",
      });
      render();
      await wait(900);
      // The stand-in's default model is a provider none of these buttons signs
      // in to, so the Main Bot's model follows the account (bots.md §4, §11).
      const provider = {
        "ChatGPT in the browser": "OpenAI",
        "GitHub Copilot": "GitHub Copilot",
        OpenRouter: "OpenRouter",
        "Use an API key": "OpenAI",
      }[t.textContent];
      const how = t.textContent === "Use an API key" ? "an API key" : t.textContent;
      Object.assign(card, { text: `Signed in with ${how}.`, note: "" });
      items.push({
        kind: "line",
        testid: "model-line",
        text: `${mainBot().name} now runs on ${provider}, from the next run.`,
      });
      state.account = "ok";
      render();
      return opening();
    }
    if (act === "skip") {
      items.push({ kind: "user", text: "Let's skip the tour for now." });
      say("Tour skipped");
      return endTour("Sure, no tour. I'm here whenever you need me.");
    }
    if (act === "undo-name") {
      const line = t.closest("[data-testid='named-line']");
      if (!kept || kept.undoing || mainBot().name !== kept.after) return;
      const record = kept;
      record.undoing = true;
      const read = await gateway.answer(700, () => {
        mainBot().name = record.before;
        return { name: mainBot().name };
      });
      const it = items.find((x) => x.testid === "named-line" && x.actions?.length);
      Object.assign(it, { text: `Back to ${read.name}`, actions: [] });
      kept = null;
      render();
      say(`Back to ${read.name}`);
      return line;
    }
    if (act === "undo-from") {
      const it = items.find((x) => x.testid === "from-line");
      Object.assign(it, {
        text: "Removed what came from Juniper. Juniper keeps all of it.",
        actions: [],
      });
      state.fromKept = false;
      render();
      return say("Removed what came from Juniper");
    }
    if (act === "see-what") {
      const it = items.find((x) => x.testid === "from-line");
      it.text = () =>
        `${mainBot().name} started from what Juniper knows: 23 things it keeps in mind and how you like to be helped. 1 line read like an instruction, so it wasn't brought. The skills Disk check and Weekly plan stay with Juniper`;
      it.actions = [["Undo", "undo-from"]];
      return render();
    }
    if (act === "try-again") {
      // The person's own press: the first message goes again as a new attempt.
      items = items.filter((x) => x.testid !== "failed-line");
      state.opening = null;
      return hello();
    }
    if (act === "stop") {
      items = items.filter((x) => x.kind !== "status");
      const it = items.find((x) => x.testid === "slow-line");
      Object.assign(it, { text: "Stopped. You can write to your Main Bot yourself.", actions: [] });
      return render();
    }
    if (act === "open-task") {
      // The product opens the task beside the conversation (F-587); here the
      // task's row in the sidebar is marked as the one open.
      task.open = true;
      render();
      if (phone()) root.querySelector('[data-act="close-task"]')?.focus();
      return say(`Opened ${task.title}`);
    }
    if (act === "close-task") {
      task.open = false;
      render();
      return root.querySelector('[data-act="open-task"]')?.focus();
    }
    if (act === "change-model" || act === "change-account") {
      // The product opens the bot's Model or Account setting (#686).
      return say(act === "change-model" ? "Opened Model" : "Opened Account");
    }
    if (act === "save-file") {
      const it = items.find((x) => x.kind === "file");
      it.saved = true;
      render();
      return say("Saved week-checklist.md");
    }
  });

  root.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!event.target.matches(".mb-composer")) return;
    const text = composer.value.trim();
    if (!text) return;
    composer.value = "";
    await answer(text);
    root.querySelector("#mb-input")?.focus();
  });
  root.addEventListener("input", (event) => {
    if (event.target.id === "mb-input") {
      composer.value = event.target.value;
      const send = root.querySelector(".mb-send");
      if (send) send.disabled = !composer.value;
    }
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.mainMenu) {
      state.mainMenu = false;
      render();
      root.querySelector('[data-act="main-menu"]')?.focus();
    }
  });

  document.addEventListener("ct:settings", () => render());
  seedBots();
  play();
})();
