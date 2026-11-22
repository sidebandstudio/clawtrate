// The autonomy step and the Main Bot's first run:
// docs/design/main-bot-onboarding.md, sections 2 to 4. Prototype code, not
// product code.
//
// One view at a time, from the address:
//   view      setup | first
//   at        start | greeted | saving | done
//   card      unconfirmed | stale
//   opening   ambiguous: the first message's delivery couldn't be confirmed
//   existing  1: an existing Main Bot
//   plugin    missing: the first run before the plugin is added
//
// The first run's Save is the person's own edit. It asks a stand-in gateway,
// which answers after a delay; the rail, the title pill and the hero change
// only on that answer.

(function () {
  const { CT } = window;
  const p = CT.params;
  const root = document.getElementById("mb-root");
  const live = document.getElementById("mb-live");

  const state = {
    view: p.get("view") === "first" ? "first" : "setup",
    autonomy: null,
    at: p.get("at"),
    card: p.get("card"),
    existing: p.get("existing") === "1",
    plugin: p.get("plugin") === "missing" ? "missing" : "present",
    opening: p.get("opening"),
    sheet: false,
  };

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const say = (text) => {
    live.textContent = "";
    setTimeout(() => (live.textContent = text), 30);
  };
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
    answer(ms, fn) {
      return new Promise((resolve) => setTimeout(() => resolve(fn()), reduced() ? 0 : ms));
    },
  };
  function seedBots() {
    const fresh = state.view === "first" && !state.existing;
    const main = { id: "main", name: fresh ? "main" : "Juniper", main: true };
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
    return (
      `<nav class="mb-rail" aria-label="Bots"><div class="mb-rail-top"><span class="mb-brand">Clawtrate</span>` +
      `<button type="button" class="mb-round" aria-label="New">+</button></div><ul class="mb-list">${rows}</ul>` +
      `<div class="mb-rail-foot"><button type="button" class="mb-gw"><span class="mb-dot"></span><span><strong>Home gateway</strong><span>Connected</span></span></button></div></nav>`
    );
  }

  function header(bot) {
    const b = botById(bot);
    const back = phone() ? `<button type="button" class="mb-round mb-back" aria-label="Back to bots">‹</button>` : "";
    return (
      `<header class="mb-head">${back}<button type="button" class="mb-pill" data-testid="title-pill" aria-label="${esc(b.main ? `${b.name}, Main Bot` : b.name)}">` +
      `${claw(b.name, 22, { star: b.main })}<span class="mb-pill-name" data-testid="title-name">${esc(b.name)}</span></button></header>`
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
    const note = c.note ? `<p class="mb-card-note" data-tone="${c.tone || ""}">${esc(c.note)}</p>` : "";
    const from = c.from ? `<p class="mb-card-from">${esc(c.from)}</p>` : "";
    const actions = (c.actions || [])
      .map(([label, act, variant]) => `<button type="button" class="mb-btn" data-variant="${variant || "quiet"}" data-act="${act}">${esc(label)}</button>`)
      .join("");
    return (
      `<article class="mb-card" data-kind="${c.cardKind}" data-id="${c.id || ""}" data-testid="card-${c.cardKind}" aria-label="${esc(c.title)}">${head}` +
      `${rows}${from}${note}` +
      (actions ? `<div class="mb-card-actions">${actions}</div>` : "") +
      `<p class="mb-card-state" role="status">${c.stateText ? esc(c.stateText) : ""}</p></article>`
    );
  }

  // The first run's guided card: Clawtrate's own, not the model's.
  function guided(g) {
    const read = '<span class="mb-read">read back</span>';
    if (g.done) {
      return (
        `<article class="mb-card mb-guided" data-kind="saved" data-testid="guided-saved" aria-label="Saved">` +
        `<div class="mb-card-head">${claw(g.name, 18)}<strong>Saved</strong></div>` +
        `<div class="mb-card-row"><span>Name</span><span><strong>${esc(g.name)}</strong> ${read}</span></div>` +
        `<div class="mb-card-row"><span>Role</span><span>saved ${read}</span></div>` +
        `</article>`
      );
    }
    const missing = state.plugin === "missing";
    const busy = g.saving ? " disabled" : "";
    return (
      `<form class="mb-card mb-guided" data-kind="guided" data-testid="guided" aria-label="Name your Main Bot">` +
      `<div class="mb-card-head"><strong>Name your Main Bot</strong></div>` +
      `<label class="mb-field"><span>Name</span><input id="g-name" maxlength="64" value="${esc(g.name || "")}" placeholder="For example, Maple"${busy}/></label>` +
      `<label class="mb-field"><span>How should it help?</span><textarea id="g-role" maxlength="500" rows="2" placeholder="For example, plan meals and keep my week on track"${busy}>${esc(g.role || "")}</textarea></label>` +
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
    root.innerHTML = `<div class="mb-shell" data-phone="${phone()}">${phone() ? "" : rail(chat.bot)}${pane}</div>`;
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
      ? `<label class="mb-switch" data-testid="also-main"><input type="checkbox"/><span>Also use this for Juniper</span></label>`
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
      `<div class="mb-setup"><div class="mb-setup-card">` +
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
    reply: "I'm Maple now. I'll plan meals with you and keep your week on track. Want to start with this week's dinners?",
  };
  let guidedCard = null;

  async function playFirst() {
    if (state.existing) {
      chat.items.push({ kind: "line", text: "Juniper is your Main Bot.", testid: "existing-main" });
      chat.items.push({ kind: "chips", chips: ["Ask Juniper to change itself", "Make a new bot"] });
      return renderChat();
    }
    chat.items.push({ kind: "user", text: FIRST.opening, caption: "Sent for you when setup finished." });
    chat.items.push({ kind: "status", text: "main is writing…" });
    renderChat();
    if (state.at === "start") return;
    await gateway.answer(1200, () => {});
    chat.items.pop();
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
    const name = guidedCard.name.trim();
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
      if (state.card === "unconfirmed") return "unconfirmed";
      if (state.card === "stale") return "stale";
      b.name = name;
      return "saved";
    });
    guidedCard.saving = false;
    if (outcome === "unconfirmed") {
      guidedCard.problem = "Clawtrate couldn't confirm whether this changed. It will show the name once the gateway does.";
      renderChat();
      return;
    }
    if (outcome === "stale") {
      guidedCard.problem = "The name changed somewhere else since this card was shown, so nothing was saved.";
      renderChat();
      return;
    }
    Object.assign(guidedCard, { done: true, name });
    if (state.plugin !== "missing")
      chat.items.push({
        kind: "card",
        cardKind: "picture-offer",
        id: "picture",
        who: name,
        title: `Use ${name}'s Claw as its picture?`,
        rows: [["Picture", `${claw(name, 32)} ${esc(name)}'s Claw`]],
        note: `Sets ${name}'s picture to this Claw. If someone sets a picture elsewhere at the same moment, this replaces it.`,
        actions: [[`Use ${name}'s Claw`, "use-claw", "primary"], ["Not now", "picture-no"]],
      });
    chat.items.push({ kind: "user", text: `Call yourself ${name}. ${role}` });
    chat.items.push({ kind: "bot", text: FIRST.reply.replace("Maple", name) });
    renderChat();
    say(`Renamed to ${name}`);
  }

  // ---- events -------------------------------------------------------------------

  root.addEventListener("click", async (event) => {
    const t = event.target.closest("[data-choose],[data-act],[data-fill]");
    if (!t) return;
    if (t.dataset.choose) {
      state.autonomy = t.dataset.choose;
      say(t.dataset.choose === "ask" ? "Ask before acting" : "Hands-off");
      state.view = "first";
      state.at = null;
      state.existing = false;
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
      state.sheet = false;
      renderSetup();
      root.querySelector('[data-act="sheet"]').focus();
    } else if (act === "use-claw" || act === "picture-no") {
      const c = chat.items.find((i) => i.id === id);
      const yes = act === "use-claw";
      if (yes) {
        c.actions = [];
        c.stateText = "Saving…";
        renderChat();
        await gateway.answer(700, () => {});
      }
      Object.assign(c, {
        stateText: "",
        actions: [],
        cardKind: yes ? "applied" : "declined",
        title: yes ? `${c.who}'s picture is its Claw` : c.title,
        note: yes ? "" : "Not now. Nothing changed.",
        rows: yes ? [["Picture", `${claw(c.who, 32)} read back`]] : c.rows,
      });
      renderChat();
    } else if (act === "resend") {
      const c = chat.items.find((i) => i.id === "opening");
      Object.assign(c, { cardKind: "resent", title: "Sent the first message again", note: "", actions: [] });
      await greet();
    } else if (act === "leave") {
      const c = chat.items.find((i) => i.id === "opening");
      Object.assign(c, { cardKind: "left", note: "Left as it is. You can write to main yourself.", actions: [] });
      renderChat();
    }
  });

  root.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.target.matches(".mb-composer")) {
      const text = composer.value.trim();
      if (!text) return;
      composer.value = "";
      chat.items.push({ kind: "user", text });
      if (guidedCard && !guidedCard.done) {
        const m = /call (?:yourself|you) ([\p{L}][\p{L}\p{N} '-]{0,63}?)(?:[.,!]|$)/iu.exec(text);
        if (m) guidedCard.name = m[1];
        chat.items.push({ kind: "bot", text: "Thanks! I've put that in the card. Change anything you like, then press Save." });
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
    if (guidedCard && event.target.id === "g-name") guidedCard.name = event.target.value;
    if (guidedCard && event.target.id === "g-role") guidedCard.role = event.target.value;
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.sheet) {
      state.sheet = false;
      renderSetup();
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
    seedBots();
    guidedCard = null;
    composer = { value: "" };
    chat = { bot: "main", items: [] };
    if (state.view === "setup") return renderSetup();
    return playFirst();
  }

  document.addEventListener("ct:settings", () => {
    if (state.view === "setup") renderSetup();
    else if (chat) renderChat();
  });
  start();
})();
