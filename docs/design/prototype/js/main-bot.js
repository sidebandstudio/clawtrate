// The Main Bot's first run, the autonomy choice and bots that set themselves
// up: docs/design/main-bot-onboarding.md. Prototype code, not product code.
//
// One view at a time, from the address:
//   view      setup | first | rename | create | proposal | agents
//   at        start | greeted | saving | done
//   card      unconfirmed | stale | declined
//   opening   ambiguous: the first message's delivery couldn't be confirmed
//   existing  1: an existing Main Bot
//   plugin    missing: the first run before the plugin is added
//   grant     0: Juniper isn't a manager yet (create)
//   step      add | added   (agents)
//
// No bot writes anything here. A bot's change is a proposal: Review and save
// opens the person's own editor filled with it. That save (or the first run's
// Save) asks a stand-in gateway, which answers after a delay. The rail, the
// title pill and the hero change only on that answer.

(function () {
  const { CT } = window;
  const p = CT.params;
  const root = document.getElementById("mb-root");
  const live = document.getElementById("mb-live");

  const state = {
    view: p.get("view") || "setup",
    autonomy: null,
    at: p.get("at"),
    card: p.get("card"),
    existing: p.get("existing") === "1",
    plugin: p.get("plugin") === "missing" ? "missing" : "present",
    grant: p.get("grant") !== "0",
    opening: p.get("opening"),
    step: p.get("step"),
    sheet: false,
    alsoMain: false,
  };
  const AUTONOMY = { "hands-off": "Hands-off", ask: "Ask before acting" };

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const say = (text) => {
    live.textContent = "";
    setTimeout(() => (live.textContent = text), 30);
  };
  // A name as the gateway stores it: whitespace collapsed and trimmed (R26).
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const storedAs = (raw) => (norm(raw) && norm(raw) !== raw ? `Saved as “${norm(raw)}”` : "");
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
    const pick = (field, list) => list[fnv(`clawtrate-name\u0000${key}\u0000${field}`) % list.length];
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
    newBots: null, // the new-bot default the autonomy step writes
    answer(ms, fn) {
      return new Promise((resolve) => setTimeout(() => resolve(fn()), reduced() ? 0 : ms));
    },
  };
  function seedBots() {
    const fresh = (state.view === "setup" || state.view === "first") && !state.existing;
    const main = fresh
      ? { id: "main", name: "main", main: true, autonomy: null, role: "", avatar: null }
      : { id: "main", name: "Juniper", main: true, autonomy: "ask", role: "", avatar: "claw" };
    gateway.bots = fresh
      ? [main]
      : [
          main,
          { id: "pip", name: "Pip", preview: "Saturday errands route" },
          { id: "otto", name: "Otto", preview: "Weekly backup check" },
          { id: "marlow", name: "Marlow", preview: "Neighborhood newsletter intro" },
        ];
  }
  const botById = (id) => gateway.bots.find((b) => b.id === id);

  // ---- rendering --------------------------------------------------------------

  let chat = null;
  let composer = { value: "" };
  const proposals = [];
  const openProposals = () => proposals.filter((x) => x.state === "open").length;

  function rail(selected) {
    const rows = gateway.bots
      .map((b) => {
        const sel = b.id === selected ? ' aria-current="true"' : "";
        const label = b.main ? `${b.name}, Main Bot` : b.name;
        return (
          `<li><button type="button" class="mb-row${b.fresh ? " is-fresh" : ""}" data-bot="${b.id}"${sel} aria-label="${esc(label)}">` +
          `${claw(b.name, 40, { star: b.main })}<span class="mb-row-text"><strong class="mb-name" data-testid="rail-name-${b.id}">${esc(b.name)}</strong>` +
          `<span class="mb-preview">${esc(b.preview || (b.main ? "Your Main Bot" : ""))}</span></span></button></li>`
        );
      })
      .join("");
    const count = proposals.length
      ? `<span class="mb-gw-prop">Proposals <span class="mb-count" data-testid="proposals-count">${openProposals()}</span></span>`
      : "";
    return (
      `<nav class="mb-rail" aria-label="Bots"><div class="mb-rail-top"><span class="mb-brand">Clawtrate</span>` +
      `<button type="button" class="mb-round" aria-label="New">+</button></div><ul class="mb-list">${rows}</ul>` +
      `<div class="mb-rail-foot"><button type="button" class="mb-gw"><span class="mb-dot"></span><span><strong>Home gateway</strong><span>Connected</span></span>${count}</button></div></nav>`
    );
  }

  function header(bot) {
    const b = botById(bot);
    const back = phone() ? `<button type="button" class="mb-round mb-back" aria-label="Back to bots">‹</button>` : "";
    const strip =
      state.view === "proposal"
        ? `<p class="mb-strip" data-testid="channel-note">This conversation also receives direct messages from your connected chat apps.</p>`
        : "";
    return (
      `<header class="mb-head">${back}<button type="button" class="mb-pill" data-testid="title-pill" data-picture="${b.avatar ? "claw" : "none"}" aria-label="${esc(b.main ? `${b.name}, Main Bot` : b.name)}">` +
      `${claw(b.name, 22, { star: b.main })}<span class="mb-pill-name" data-testid="title-name">${esc(b.name)}</span></button></header>${strip}`
    );
  }

  function item(it) {
    switch (it.kind) {
      case "user":
        return (
          `<div class="mb-msg is-user"><p class="mb-bubble">${esc(it.text)}</p>` +
          (it.caption ? `<p class="mb-caption" data-testid="opening-caption">${esc(it.caption)}</p>` : "") +
          `</div>`
        );
      case "bot":
        return `<div class="mb-msg is-bot">${claw(botById(chat.bot).name, 18)}<p class="mb-bubble">${esc(it.text)}</p></div>`;
      case "status":
        return `<p class="mb-status" role="status"><span class="mb-dots" aria-hidden="true"><i></i><i></i><i></i></span>${esc(it.text)}</p>`;
      case "line":
        return (
          `<p class="mb-line" data-testid="${it.testid || "event-line"}">${esc(it.text)}` +
          (it.action ? ` <button type="button" class="mb-link" data-act="${it.act || ""}">${esc(it.action)}</button>` : "") +
          `</p>`
        );
      case "chips":
        return `<div class="mb-chips">${it.chips.map((c) => `<button type="button" class="mb-chip" data-fill="${esc(c)}">${esc(c)}</button>`).join("")}</div>`;
      case "guided":
        return guided(it);
      case "card":
        return card(it);
      default:
        return "";
    }
  }

  function card(c) {
    const head = `<div class="mb-card-head">${claw(c.who || botById(chat.bot).name, 18)}<strong>${esc(c.title)}</strong></div>`;
    const rows = (c.rows || [])
      .map(([k, v, extra]) => `<div class="mb-card-row"><span>${esc(k)}</span><span>${v}${extra ? ` ${extra}` : ""}</span></div>`)
      .join("");
    const marks = (c.marks || []).map((m) => `<span class="mb-mark">${esc(m)}</span>`).join("");
    const note = c.note ? `<p class="mb-card-note" data-tone="${c.tone || ""}">${esc(c.note)}</p>` : "";
    const from = c.from ? `<p class="mb-card-from">${esc(c.from)}</p>` : "";
    const actions = (c.actions || [])
      .map(([label, act, variant]) => `<button type="button" class="mb-btn" data-variant="${variant || "quiet"}" data-act="${act}">${esc(label)}</button>`)
      .join("");
    return (
      `<article class="mb-card" data-kind="${c.cardKind}" data-id="${c.id || ""}" data-testid="card-${c.cardKind}" aria-label="${esc(c.title)}">${head}` +
      (marks ? `<div class="mb-marks">${marks}</div>` : "") +
      `${rows}${from}${note}` +
      (actions ? `<div class="mb-card-actions">${actions}</div>` : "") +
      `<p class="mb-card-state" role="status">${c.stateText ? esc(c.stateText) : ""}</p></article>`
    );
  }

  const diff = (minus, plus) =>
    `<span class="mb-diff">${minus.map((l) => `<span data-sign="-">− ${esc(l)}</span>`).join("")}${plus
      .map((l) => `<span data-sign="+">+ ${esc(l)}</span>`)
      .join("")}</span>`;

  // The first run's guided card: Clawtrate's own, not the model's.
  function guided(g) {
    const read = '<span class="mb-read">read back</span>';
    if (g.done) {
      return (
        `<article class="mb-card mb-guided" data-kind="saved" data-testid="guided-saved" aria-label="Saved">` +
        `<div class="mb-card-head">${claw(g.name, 18)}<strong>Saved</strong></div>` +
        `<div class="mb-card-row"><span>Name</span><span><strong data-testid="saved-name">${esc(g.name)}</strong> ${read}</span></div>` +
        `<div class="mb-card-row"><span>Role</span><span><span data-testid="saved-role">${g.role ? esc(g.role) : "None"}</span> ${read}</span></div>` +
        `</article>`
      );
    }
    const missing = state.plugin === "missing";
    const busy = g.saving ? " disabled" : "";
    return (
      `<form class="mb-card mb-guided" data-kind="guided" data-testid="guided" aria-label="Name your Main Bot">` +
      `<div class="mb-card-head"><strong>Name your Main Bot</strong></div>` +
      `<label class="mb-field"><span>Name</span><input id="g-name" maxlength="64" value="${esc(g.name || "")}" placeholder="For example, Maple"${busy}/></label>` +
      `<p class="mb-hint" data-testid="stored-as">${esc(storedAs(g.name || ""))}</p>` +
      `<label class="mb-field"><span>How should it help?</span><textarea id="g-role" maxlength="500" rows="2" placeholder="For example, plan meals and keep my week on track"${busy}>${esc(g.role || "")}</textarea></label>` +
      (g.proposed
        ? `<p class="mb-hint" data-testid="proposed-note">${esc(botById("main").name)} suggested these from your message. Nothing is saved until you press Save.</p>`
        : "") +
      `<p class="mb-hint">${missing ? "Saves this name and role yourself, in Clawtrate." : "Saves this name and role. Clawtrate shows them once the gateway confirms."}</p>` +
      (g.problem ? `<p class="mb-card-note" data-tone="warn" data-testid="guided-problem">${esc(g.problem)}</p>` : "") +
      `<div class="mb-card-actions"><button type="submit" class="mb-btn" data-variant="primary"${busy}>${g.saving ? "Saving…" : missing ? "Save in Clawtrate" : "Save"}</button></div>` +
      `<p class="mb-card-state" role="status">${g.saving ? "Saving…" : ""}</p></form>`
    );
  }

  function renderChat() {
    const b = botById(chat.bot);
    const focus = document.activeElement?.id;
    const pane =
      `<section class="mb-conv" aria-label="Conversation">${header(chat.bot)}` +
      `<div class="mb-transcript" data-testid="transcript"><div class="mb-transcript-inner">${chat.items.map(item).join("")}</div></div>` +
      `<form class="mb-composer" data-testid="composer"><label class="visually-hidden" for="mb-input">Message</label>` +
      `<textarea id="mb-input" rows="1" placeholder="Message ${esc(b.name)}">${esc(composer.value)}</textarea>` +
      `<button type="submit" class="mb-send" aria-label="Send" ${composer.value ? "" : "disabled"}>↑</button></form></section>`;
    root.innerHTML = `<div class="mb-shell" data-phone="${phone()}">${phone() ? "" : rail(chat.bot)}${pane}</div>${editorHtml()}`;
    const t = root.querySelector(".mb-transcript");
    t.scrollTop = t.scrollHeight;
    if (focus && document.getElementById(focus)) document.getElementById(focus).focus();
  }

  // ---- view: the autonomy step ------------------------------------------------

  function renderSetup() {
    const existing = state.existing
      ? `<p class="mb-setup-now" data-testid="existing-line">Juniper has its own command settings: Ask before acting.</p>`
      : "";
    const also = state.existing
      ? `<label class="mb-switch" data-testid="also-main"><input type="checkbox"${state.alsoMain ? " checked" : ""}/><span>Also use this for Juniper</span></label>`
      : "";
    const choice = (id, title, line) => {
      const checked = state.autonomy === id;
      const tab = checked || (!state.autonomy && id === "hands-off") ? 0 : -1;
      return (
        `<button type="button" class="mb-choice" role="radio" aria-checked="${checked}" data-choose="${id}" tabindex="${tab}">` +
        `<span class="mb-choice-mark" aria-hidden="true"></span><span><strong>${title}</strong><span>${line}</span></span></button>`
      );
    };
    root.innerHTML =
      `<div class="mb-setup"><div class="mb-setup-card"${state.sheet ? " inert" : ""}>` +
      `<p class="mb-setup-done"><span aria-hidden="true">✓</span> Connected to OpenClaw on this Mac</p>` +
      `<h1 id="mb-setup-title">How should bots run commands?</h1>${existing}` +
      `<div class="mb-choices" role="radiogroup" aria-labelledby="mb-setup-title" data-testid="autonomy">` +
      choice("hands-off", "Hands-off", "Run commands without routine approvals, where this computer allows it.") +
      choice("ask", "Ask before acting", "Ask when a host command doesn't match an existing rule.") +
      `</div>${also}` +
      `<p class="mb-setup-later" data-testid="settings-line">Either way, a bot asks you before it changes its own or another bot's settings, and you confirm each change with one click.</p>` +
      `<p class="mb-setup-later" data-testid="limits-line">Clawtrate's limits cover changes made through Clawtrate. A command a bot runs can still change things on the computer running OpenClaw.</p>` +
      `<button type="button" class="mb-link" data-act="sheet" data-testid="what-this-means">What this means</button></div>` +
      (state.sheet ? sheet() : "") +
      `</div>`;
  }

  function sheet() {
    return (
      `<div class="mb-scrim" data-act="sheet-close"></div><div class="mb-sheet" role="dialog" aria-modal="true" aria-labelledby="mb-sheet-title" data-testid="sheet">` +
      `<h2 id="mb-sheet-title">What this means</h2><ul>` +
      `<li><strong>Hands-off</strong> runs a bot's commands without stopping for approval, as the computer's own user, where that computer's rules allow it. A command can change files and OpenClaw's own settings.</li>` +
      `<li><strong>Ask before acting</strong> runs commands that match a rule already allowed on that computer, including rules you didn't add yourself, such as its safe commands. Anything else waits for you, unless this computer's or the task's own rules decide first. If nobody answers in 30 minutes, the computer's own fallback decides; by default it refuses.</li>` +
      `<li>Stopping a run stops what comes next. It doesn't undo a command that already ran.</li>` +
      `<li>Each computer can be stricter than this choice. Clawtrate shows what each bot can actually do, or says when it can't tell.</li>` +
      `</ul><button type="button" class="mb-btn" data-variant="primary" data-act="sheet-close">Done</button></div>`
    );
  }

  // ---- view: the first run ------------------------------------------------------

  const FIRST = {
    opening: "Hi! I just set up Clawtrate. What should I call you, and how can you help me?",
    greeting: "Hi! I'm your new assistant on this gateway, and I just came online. What would you like to call me, and what should I help you with most?",
    name: "Maple",
    role: "Plan meals and keep my week on track.",
  };
  let guidedCard = null;

  async function playFirst() {
    if (state.existing) {
      const main = botById("main");
      chat.items.push({ kind: "line", text: `${main.name} is your Main Bot.`, testid: "existing-main" });
      if (gateway.newBots)
        chat.items.push({
          kind: "line",
          text: `New bots: ${AUTONOMY[gateway.newBots]}. ${main.name}: ${AUTONOMY[main.autonomy]}.`,
          testid: "autonomy-line",
        });
      chat.items.push({ kind: "chips", chips: ["Ask Juniper to change itself", "Make a new bot"] });
      return renderChat();
    }
    chat.items.push({ kind: "user", text: FIRST.opening, caption: "Sent for you when setup finished." });
    const writing = { kind: "status", text: "main is writing…" };
    chat.items.push(writing);
    renderChat();
    if (state.at === "start") return;
    await gateway.answer(1200, () => {});
    chat.items = chat.items.filter((item) => item !== writing);
    if (state.opening === "ambiguous") {
      chat.items.push({
        kind: "card",
        cardKind: "opening",
        id: "opening",
        who: "main",
        title: "Clawtrate couldn't confirm the first message reached main",
        note: "Nothing is sent again by itself.",
        actions: [["Send it again", "resend", "primary"], ["Leave it", "leave"]],
      });
      return renderChat();
    }
    await greet();
  }

  async function greet() {
    chat.items.push({ kind: "bot", text: FIRST.greeting });
    guidedCard = { kind: "guided" };
    chat.items.push(guidedCard);
    if (state.plugin === "missing")
      chat.items.push({
        kind: "line",
        text: "Clawtrate's bot tools aren't on your gateway yet, so bots can't ask to change their settings.",
        testid: "plugin-missing",
      });
    renderChat();
    if (state.at === "greeted" || (!state.at && !state.card)) return;
    guidedCard.name = FIRST.name;
    guidedCard.role = FIRST.role;
    await saveFirst();
  }

  async function saveFirst() {
    const b = botById("main");
    const name = norm(guidedCard.name);
    const role = (guidedCard.role || "").trim();
    if (!name) {
      guidedCard.problem = "Give your Main Bot a name first.";
      renderChat();
      root.querySelector("#g-name").focus();
      return;
    }
    guidedCard.problem = "";
    guidedCard.saving = true;
    renderChat();
    if (state.at === "saving") return;
    const outcome = await gateway.answer(1100, () => {
      if (state.card === "unconfirmed") return { status: "unconfirmed" };
      if (state.card === "stale") return { status: "stale" };
      b.name = name;
      b.role = role;
      return { status: "saved", name: b.name, role: b.role, avatar: b.avatar };
    });
    guidedCard.saving = false;
    if (outcome.status === "unconfirmed") {
      guidedCard.problem = "Clawtrate couldn't confirm whether this changed. It will show the name once the gateway does.";
      renderChat();
      return;
    }
    if (outcome.status === "stale") {
      guidedCard.problem = "The name changed somewhere else since this card was shown, so nothing was saved.";
      renderChat();
      return;
    }
    // The saved card and what follows show what the stand-in read back.
    const saved = outcome.name;
    Object.assign(guidedCard, { done: true, name: saved, role: outcome.role });
    if (state.plugin !== "missing" && !outcome.avatar)
      chat.items.push({
        kind: "card",
        cardKind: "picture-offer",
        id: "picture",
        who: saved,
        title: `Use ${saved}'s Claw as its picture?`,
        rows: [["Picture", `${claw(saved, 32)} ${esc(saved)}'s Claw`]],
        note: `Sets ${saved}'s picture to this Claw. If someone sets a picture elsewhere at the same moment, this replaces it.`,
        actions: [[`Use ${saved}'s Claw`, "use-claw", "primary"], ["Not now", "picture-no"]],
      });
    chat.items.push({ kind: "user", text: outcome.role ? `Call yourself ${saved}. ${outcome.role}` : `Call yourself ${saved}.` });
    chat.items.push({ kind: "bot", text: `I'm ${saved} now. Where would you like to start?` });
    renderChat();
    say(`Renamed to ${saved}`);
  }

  // ---- proposals: shared ----------------------------------------------------
  // On OpenClaw 2026.10.6 the plugin applies no stored request (section 6 of
  // the design): Review and save opens the person's own editor, or New bot,
  // filled with the proposed values, and saving there is the person's edit.

  const GATED = "Clawtrate can't apply this for you on this gateway. Review and save opens your editor with these values.";
  let editor = null;

  function addProposal(c) {
    const prop = { id: c.id, state: "open", card: c };
    proposals.push(prop);
    chat.items.push(c);
    return prop;
  }

  function editorHtml() {
    if (!editor) return "";
    const { prop } = editor;
    const fields = prop.card.editor.fields
      .map(
        ([label, value, multi], i) =>
          `<label class="mb-field"><span>${esc(label)}</span>` +
          (multi
            ? `<textarea id="ed-${i}" rows="3">${esc(value)}</textarea>`
            : `<input id="ed-${i}" value="${esc(value)}"/>`) +
          `</label>`,
      )
      .join("");
    const stale = editor.stale
      ? `<p class="mb-card-note" data-tone="warn" data-testid="editor-stale">${esc(prop.card.editor.stale)}</p>`
      : "";
    return (
      `<div class="mb-scrim"></div><div class="mb-dialog" role="dialog" aria-modal="true" aria-labelledby="mb-ed-title" data-testid="editor">` +
      `<h2 id="mb-ed-title">${esc(prop.card.editor.title)}</h2>` +
      `<p class="mb-hint">${esc(prop.card.editor.lede)}</p>${stale}${fields}` +
      `<div class="mb-dialog-actions"><button type="button" class="mb-btn" data-variant="quiet" data-act="editor-cancel">Cancel</button>` +
      `<button type="button" class="mb-btn" data-variant="primary" data-act="editor-save">${esc(prop.card.editor.save)}</button></div></div>`
    );
  }

  function review(id) {
    const prop = proposals.find((x) => x.id === id);
    if (!prop || prop.state !== "open") return;
    editor = { prop, stale: state.card === "stale" && prop.card.staleable };
    renderChat();
    root.querySelector('[data-testid="editor"] input, [data-testid="editor"] textarea')?.focus();
  }

  async function editorSave() {
    const { prop } = editor;
    editor = null;
    const c = prop.card;
    prop.state = "saving";
    c.actions = [];
    c.stateText = "Saving…";
    c.cardKind = "saving";
    renderChat();
    await gateway.answer(1000, () => c.effect());
    prop.state = "saved";
    Object.assign(c, {
      stateText: "",
      cardKind: "saved",
      title: c.doneTitle,
      marks: [],
      from: "",
      note: c.savedNote,
      rows: c.doneRows,
      actions: c.ownRename && !c.ownRename.done ? [[c.ownRename.label, "own-rename"]] : [],
    });
    renderChat();
    say(c.title);
  }

  function decline(id) {
    const prop = proposals.find((x) => x.id === id);
    if (!prop || prop.state !== "open") return;
    prop.state = "declined";
    const note = prop.card.ownRename?.done ? "Only the instructions were declined." : "Nothing changed.";
    Object.assign(prop.card, { cardKind: "declined", title: prop.card.declinedTitle, actions: [], note, marks: [] });
    renderChat();
  }

  const read = '<span class="mb-read">read back</span>';
  const byYou = (where) => `<span class="mb-read">by you, in ${where}</span>`;

  // ---- view: a bot asks to rename itself --------------------------------------

  async function playRename() {
    chat.items.push({ kind: "user", text: "Plan my Saturday errands." });
    chat.items.push({ kind: "bot", text: "Here's the route: hardware store, then the library, then groceries on the way home." });
    chat.items.push({ kind: "user", text: "Can you go by Scout from now on, and keep your answers shorter?" });
    addProposal({
      kind: "card",
      cardKind: "proposal",
      id: "scout",
      staleable: true,
      title: "Pip asks to rename itself Scout",
      rows: [
        ["Name", "Pip → <strong>Scout</strong>", '<span class="mb-read">yours to make</span>'],
        ["Instructions", diff([], ["Keep answers short; use a list when it helps."])],
      ],
      from: "Proposed by Pip, in this chat.",
      note: GATED,
      ownRename: { bot: "pip", to: "Scout", label: "Rename Pip to Scout" },
      actions: [["Review and save", "review", "primary"], ["Rename Pip to Scout", "own-rename"], ["Not now", "decline"]],
      editor: {
        title: "Pip's instructions",
        lede: "Your instructions editor, with Pip's proposed change added. Clawtrate read Pip's instructions again when this opened.",
        stale: "Pip's instructions changed since Pip asked. This starts from what they say now, with Pip's change added.",
        save: "Save",
        fields: [["AGENTS.md", "Plan errands and trips.\nKeep answers short; use a list when it helps.", true]],
      },
      doneTitle: "Pip's instructions changed",
      doneRows: [["Instructions", "updated", read]],
      savedNote: "Saved by you in Pip's instructions.",
      declinedTitle: "Kept Pip's instructions",
      effect: () => "saved",
    });
    chat.items.push({ kind: "bot", text: "I've asked to go by Scout and keep answers short. Review and save it when you're ready." });
    renderChat();
    if (state.card === "declined") return decline("scout");
    if (state.card === "stale") return review("scout");
    if (state.at === "done") {
      review("scout");
      await editorSave();
    }
  }

  // ---- view: creating a bot by chat ---------------------------------------------

  async function playCreate() {
    chat.items.push({ kind: "user", text: "Make me a bot that tracks my running training. Call it Stride, and have it run hands-off." });
    if (!state.grant) {
      chat.items.push({
        kind: "card",
        cardKind: "grant",
        id: "grant",
        title: "Juniper can't ask to change other bots",
        note: "Being your Main Bot doesn't include this. You can allow Juniper to ask to create bots and change other bots; you still confirm each request.",
        actions: [["Allow", "grant", "primary"], ["Not now", "grant-no"]],
      });
      renderChat();
      return;
    }
    proposeCreate();
    renderChat();
    if (state.at === "done") {
      review("stride");
      await editorSave();
    }
  }

  function proposeCreate() {
    const gatedRow = '<span class="mb-read" data-gated="1">gated: by you, in New bot</span>';
    addProposal({
      kind: "card",
      cardKind: "proposal",
      id: "stride",
      title: "Juniper asks to create Stride",
      marks: ["More freedom than your usual choice"],
      rows: [
        ["Name", `${claw("Stride", 18)} <strong>Stride</strong> (id stride, new)`],
        ["Account and model", "OpenAI · Personal, the same as Juniper's"],
        ["Autonomy", "<strong>Hands-off</strong> (your usual choice: Ask before acting)", gatedRow],
        ["Role", "Tracks your running training and plans the week's runs.", gatedRow],
        ["Routine", "Weekly run plan, Sundays at 6 PM", gatedRow],
      ],
      from: "Proposed by Juniper, in this chat.",
      note: "Clawtrate can't create this for you on this gateway: after the bot is made, its settings, role and routine would be written to it with no check that it's still the same bot. Review and save opens New bot with these values.",
      actions: [["Review and save", "review", "primary"], ["Not now", "decline"]],
      editor: {
        title: "New bot",
        lede: "New bot, filled with Juniper's proposal. You create the bot here, as you would any new bot.",
        save: "Create",
        fields: [
          ["Name", "Stride"],
          ["Account and model", "OpenAI · Personal"],
          ["Autonomy", "Hands-off"],
          ["Role", "Tracks your running training and plans the week's runs.", true],
          ["Routine", "Weekly run plan, Sundays at 6 PM"],
        ],
      },
      doneTitle: "Created Stride",
      doneRows: [
        ["Name", "<strong>Stride</strong>, id stride", byYou("New bot")],
        ["Autonomy", "Hands-off", byYou("New bot")],
        ["Role and routine", "saved", byYou("New bot")],
      ],
      savedNote: "Created by you in New bot.",
      declinedTitle: "Didn't create Stride",
      effect: () => {
        gateway.bots.splice(1, 0, { id: "stride", name: "Stride", preview: "New bot", fresh: true });
        return "saved";
      },
    });
    chat.items.push({ kind: "bot", text: "I've drafted Stride for you. Review it and create it when it looks right." });
  }

  // ---- view: proposals of other origins ---------------------------------------

  function playProposal() {
    addProposal({
      kind: "card",
      cardKind: "proposal",
      id: "junebug",
      title: "Juniper asks to rename itself Junebug",
      rows: [["Name", "Juniper → <strong>Junebug</strong>", '<span class="mb-read">yours to make</span>']],
      from: "Clawtrate couldn't confirm where this request came from.",
      note: "Clawtrate can't apply a name from a request on this gateway. You can rename Juniper yourself.",
      ownRename: { bot: "main", to: "Junebug", label: "Rename Juniper to Junebug" },
      actions: [["Rename Juniper to Junebug", "own-rename", "primary"], ["Not now", "decline"]],
      declinedTitle: "Kept Juniper's name",
    });
    addProposal({
      kind: "card",
      cardKind: "proposal",
      id: "otto-instructions",
      title: "Juniper asks to change Otto's instructions",
      marks: ["Another bot's instructions"],
      rows: [["AGENTS.md", diff(["Check backups every Monday."], ["Check backups every Monday and Thursday.", "Tell Juniper when one fails."])]],
      from: "Proposed by Juniper.",
      note: GATED,
      actions: [["Review and save", "review", "primary"], ["Not now", "decline"]],
      editor: {
        title: "Otto's instructions",
        lede: "Your instructions editor, with Juniper's proposed change. Clawtrate read Otto's instructions again when this opened.",
        save: "Save",
        fields: [["AGENTS.md", "Check backups every Monday and Thursday.\nTell Juniper when one fails.", true]],
      },
      doneTitle: "Otto's instructions changed",
      doneRows: [["AGENTS.md", "updated", read]],
      savedNote: "Saved by you in Otto's instructions.",
      declinedTitle: "Kept Otto's instructions",
      effect: () => "saved",
    });
    addProposal({
      kind: "card",
      cardKind: "proposal",
      id: "pip-freedom",
      who: "Pip",
      title: "Pip asks to run hands-off",
      marks: ["More freedom"],
      rows: [["Autonomy", "Ask before acting → <strong>Hands-off</strong>"]],
      from: "Proposed by Pip.",
      note: GATED,
      actions: [["Review and save", "review", "primary"], ["Not now", "decline"]],
      editor: {
        title: "Pip's autonomy",
        lede: "Pip's Autonomy setting, with Pip's proposed choice. This gives Pip more freedom.",
        save: "Save",
        fields: [["Autonomy", "Hands-off"]],
      },
      doneTitle: "Pip runs hands-off",
      doneRows: [["Autonomy", "Hands-off", read]],
      savedNote: "Saved by you in Pip's settings.",
      declinedTitle: "Pip keeps asking before acting",
      effect: () => "saved",
    });
    renderChat();
  }

  // ---- view: agents with access -----------------------------------------------

  function renderAgents() {
    const nav = ["General", "Bots", "Accounts", "Permissions", "Agents with access", "Gateway"]
      .map((n) => `<li><a href="#" ${n === "Agents with access" ? 'aria-current="page"' : ""}>${n}</a></li>`)
      .join("");
    const grant = (name, scope, bots, when) =>
      `<li class="mb-grant"><div><strong>${name}</strong><span>${scope} · ${bots}</span><span>${when}</span></div>` +
      `<div class="mb-grant-actions"><button type="button" class="mb-btn" data-variant="quiet">See its activity</button>` +
      `<button type="button" class="mb-btn" data-variant="danger-quiet" data-act="remove">Remove access</button></div></li>`;
    const added = state.step === "added";
    const list =
      grant("Claude Code", "Suggest changes", "All bots, including later ones", "Added Nov 22 · Expires in 28 days · Last used 2 minutes ago") +
      (added ? grant("Codex", "See bots", "Pip and Otto", "Added just now · Expires in 30 days · Not used yet") : "");
    root.innerHTML =
      `<div class="mb-settings"><nav class="mb-settings-nav" aria-label="Settings"><h2>Settings</h2><ul>${nav}</ul></nav>` +
      `<section class="mb-settings-body" aria-labelledby="mb-agents-title"><h1 id="mb-agents-title">Agents with access</h1>` +
      `<p class="mb-lede">Coding agents on this Mac that you allow can see your bots and suggest changes through Clawtrate, while Clawtrate is open. You confirm every change. Your gateway's credentials never leave it.</p>` +
      `<ul class="mb-grants" data-testid="grants">${list}</ul>` +
      `<button type="button" class="mb-btn" data-variant="primary" data-act="add">Add an agent</button>` +
      (state.step === "add" ? addDialog() : "") +
      (added ? addedNote() : "") +
      `</section></div>`;
  }

  function addDialog() {
    const radio = (id, title, line, checked) =>
      `<label class="mb-radio"><input type="radio" name="scope" value="${id}" ${checked ? "checked" : ""}/><span><strong>${title}</strong><span>${line}</span></span></label>`;
    return (
      `<div class="mb-scrim"></div><div class="mb-dialog" role="dialog" aria-modal="true" aria-labelledby="mb-add-title" data-testid="add-agent">` +
      `<h2 id="mb-add-title">Add an agent</h2><label class="mb-field"><span>Name</span><input value="Codex"/></label>` +
      `<fieldset><legend>What it may do</legend>` +
      radio("see", "See bots", "List bots and read their settings and routines.", true) +
      radio("suggest", "Suggest changes", "Also ask for changes, which you confirm in Clawtrate.", false) +
      `</fieldset><label class="mb-switch"><input type="checkbox"/><span>Include bots' instructions</span></label>` +
      `<p class="mb-hint" data-testid="instructions-hint">Without it, the agent gets no instructions, no instruction changes and no routine prompts, and can't suggest them.</p>` +
      `<fieldset><legend>Which bots</legend><label class="mb-radio"><input type="radio" name="bots"/><span><strong>All bots</strong></span></label>` +
      `<label class="mb-radio"><input type="radio" name="bots" checked/><span><strong>Chosen bots</strong><span>Pip, Otto</span></span></label>` +
      `<label class="mb-switch"><input type="checkbox" disabled/><span>Include bots you add later</span></label></fieldset>` +
      `<label class="mb-field"><span>Expires</span><select><option>In 30 days</option><option>In 7 days</option><option>In 90 days</option></select></label>` +
      `<p class="mb-hint" data-testid="grant-limit">Anything that can read this agent's secret can do what you allow here. Programs running as you on this Mac can read your agent's settings, so give agents the least they need.</p>` +
      `<p class="mb-hint">It never gets credentials, devices, the gateway's settings, completions, or a way to delete bots or message them.</p>` +
      `<div class="mb-dialog-actions"><button type="button" class="mb-btn" data-variant="quiet">Cancel</button><button type="button" class="mb-btn" data-variant="primary" data-act="added">Add</button></div></div>`
    );
  }

  function addedNote() {
    return (
      `<div class="mb-added" data-testid="added-config"><h2>Paste this into Codex's MCP settings</h2>` +
      `<p>The secret is shown once. Clawtrate keeps only a digest of it.</p>` +
      `<pre class="mb-code">{\n  "mcpServers": {\n    "clawtrate": {\n      "command": "/Applications/Clawtrate.app/Contents/MacOS/clawtrate-mcp",\n      "env": { "CLAWTRATE_GRANT": "ctg_••••••••••••" }\n    }\n  }\n}</pre>` +
      `<button type="button" class="mb-btn" data-variant="quiet">Copy</button></div>`
    );
  }

  // ---- events -------------------------------------------------------------------

  function closeSheet() {
    state.sheet = false;
    renderSetup();
    root.querySelector('[data-act="sheet"]').focus();
  }

  root.addEventListener("click", async (event) => {
    const t = event.target.closest("[data-choose],[data-act],[data-fill]");
    if (!t) return;
    if (t.dataset.choose) {
      const choice = t.dataset.choose;
      state.autonomy = choice;
      // Setup always writes the new-bot default. A Main Bot never set up is
      // newly managed and takes the choice; an existing one only with the opt-in.
      gateway.newBots = choice;
      if (!state.existing || state.alsoMain) botById("main").autonomy = choice;
      say(AUTONOMY[choice]);
      state.view = "first";
      state.at = null;
      start();
      return;
    }
    if (t.dataset.fill) {
      composer.value = t.dataset.fill;
      return renderChat();
    }
    const act = t.dataset.act;
    const id = t.closest("article")?.dataset.id;
    if (act === "sheet") {
      state.sheet = true;
      renderSetup();
      root.querySelector(".mb-sheet button").focus();
    } else if (act === "sheet-close") {
      closeSheet();
    } else if (act === "review") {
      review(id);
    } else if (act === "editor-save") {
      await editorSave();
    } else if (act === "editor-cancel") {
      editor = null;
      renderChat();
    } else if (act === "decline") {
      decline(id);
    } else if (act === "grant") {
      const c = chat.items.find((i) => i.id === "grant");
      Object.assign(c, { cardKind: "granted", title: "Juniper can now ask to change other bots", note: "", actions: [] });
      state.grant = true;
      proposeCreate();
      renderChat();
    } else if (act === "grant-no") {
      const c = chat.items.find((i) => i.id === "grant");
      Object.assign(c, { cardKind: "declined", actions: [], note: "Not now. Juniper can't ask to create bots." });
      renderChat();
    } else if (act === "own-rename") {
      const prop = proposals.find((x) => x.id === id);
      const card = prop.card;
      const own = card.ownRename;
      const otherActions = card.actions.filter((action) => action[1] !== "own-rename");
      const bot = botById(own.bot);
      const oldName = bot.name;
      card.stateText = "Renaming…";
      card.actions = [];
      renderChat();
      const name = await gateway.answer(800, () => (bot.name = own.to));
      own.done = true;
      card.stateText = "";
      if (!card.editor) {
        prop.state = "saved";
        Object.assign(card, {
          cardKind: "renamed",
          title: `Renamed ${oldName} to ${name}`,
          rows: [["Name", esc(name), read]],
          note: "",
        });
      } else if (prop.state === "open") {
        card.title = `${name} asks to change its instructions`;
        card.rows = card.rows.filter(([label]) => label !== "Name");
        card.declinedTitle = `Kept ${name}'s instructions`;
        card.actions = otherActions;
      }
      chat.items.push({ kind: "line", text: `You renamed it ${name}. Read back.`, testid: "own-rename-line" });
      renderChat();
      say(`Renamed to ${name}`);
    } else if (act === "use-claw") {
      const c = chat.items.find((i) => i.id === id);
      c.actions = [];
      c.stateText = "Saving…";
      renderChat();
      const read = await gateway.answer(700, () => {
        const b = botById("main");
        b.avatar = "claw";
        return { name: b.name, avatar: b.avatar };
      });
      Object.assign(c, {
        stateText: "",
        cardKind: "applied",
        title: `${read.name}'s picture is its Claw`,
        note: "",
        rows: [["Picture", `${claw(read.name, 32)} read back`]],
      });
      renderChat();
    } else if (act === "picture-no") {
      const c = chat.items.find((i) => i.id === id);
      Object.assign(c, { actions: [], cardKind: "declined", note: "Not now. Nothing changed." });
      renderChat();
    } else if (act === "resend") {
      const c = chat.items.find((i) => i.id === "opening");
      Object.assign(c, { cardKind: "resent", title: "Sent the first message again", note: "", actions: [] });
      await greet();
    } else if (act === "leave") {
      const c = chat.items.find((i) => i.id === "opening");
      Object.assign(c, { cardKind: "left", note: "Left as it is. You can write to main yourself.", actions: [] });
      renderChat();
    } else if (act === "add") {
      state.step = "add";
      renderAgents();
    } else if (act === "added") {
      state.step = "added";
      renderAgents();
    }
  });

  root.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.target.matches(".mb-composer")) {
      const text = composer.value.trim();
      if (!text) return;
      composer.value = "";
      chat.items.push({ kind: "user", text });
      if (guidedCard && !guidedCard.done && !guidedCard.saving) {
        // With the plugin, the bot proposes the values and they fill the card;
        // without it, nothing fills the card for the person.
        const m = /call\s+(?:yourself|you)\s+([\p{L}][\p{L}\p{N} '-]{0,63}?)(?:[.,!]\s*|$)([\s\S]*)/iu.exec(text);
        if (m && state.plugin !== "missing") {
          guidedCard.name = norm(m[1]);
          if (m[2].trim()) guidedCard.role = m[2].trim().slice(0, 500);
          guidedCard.proposed = true;
          chat.items.push({ kind: "bot", text: "Thanks! I've put that in the card. Change anything you like, then press Save." });
        } else {
          const save = state.plugin === "missing" ? "Save in Clawtrate" : "Save";
          chat.items.push({ kind: "bot", text: `Thanks! Put that in the card, then press ${save}.` });
        }
      }
      renderChat();
      root.querySelector("#mb-input")?.focus();
      return;
    }
    if (event.target.matches(".mb-guided")) {
      guidedCard.name = root.querySelector("#g-name").value;
      guidedCard.role = root.querySelector("#g-role").value;
      state.at = "done";
      await saveFirst();
    }
  });
  root.addEventListener("input", (event) => {
    if (event.target.id === "mb-input") {
      composer.value = event.target.value;
      const send = root.querySelector(".mb-send");
      if (send) send.disabled = !composer.value;
    }
    if (guidedCard && event.target.id === "g-name") {
      guidedCard.name = event.target.value;
      root.querySelector('[data-testid="stored-as"]').textContent = storedAs(event.target.value);
    }
    if (event.target.closest?.('[data-testid="also-main"]')) state.alsoMain = event.target.checked;
    if (guidedCard && event.target.id === "g-role") guidedCard.role = event.target.value;
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && editor) {
      editor = null;
      renderChat();
      return;
    }
    if (event.key === "Escape" && state.sheet) closeSheet();
    if (event.key === "Tab" && state.sheet) {
      // The setup behind the sheet is inert; Tab and Shift+Tab cycle inside it.
      const all = [...root.querySelectorAll(".mb-sheet button")];
      const at = all.indexOf(document.activeElement);
      all[(at + (event.shiftKey ? all.length - 1 : 1)) % all.length].focus();
      event.preventDefault();
    }
    const radio = event.target.closest?.(".mb-choice");
    if (radio && ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"].includes(event.key)) {
      const all = [...root.querySelectorAll(".mb-choice")];
      const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : all.length - 1;
      const next = all[(all.indexOf(radio) + step) % all.length];
      all.forEach((r) => (r.tabIndex = r === next ? 0 : -1));
      next.focus();
      event.preventDefault();
    }
  });

  // ---- start ----------------------------------------------------------------

  function start() {
    proposals.length = 0;
    guidedCard = null;
    composer = { value: "" };
    chat = { bot: state.view === "rename" ? "pip" : "main", items: [] };
    if (state.view === "setup") return renderSetup();
    if (state.view === "agents") return renderAgents();
    if (state.view === "first") return playFirst();
    if (state.view === "rename") return playRename();
    if (state.view === "create") return playCreate();
    if (state.view === "proposal") return playProposal();
  }

  document.addEventListener("ct:settings", () => {
    if (state.view === "setup") renderSetup();
    else if (state.view === "agents") renderAgents();
    else if (chat) renderChat();
  });
  seedBots();
  start();
})();
