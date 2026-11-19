// The rest of a bot's life (docs/design/bots-lifecycle.md), on top of bots.js
// and bot-settings.js: the primary bot, the picture editor, the name and label
// in place, instructions, a role change in the conversation, duplicate, export,
// import and delete. Every gateway answer here is a local fixture; each state
// says only what its fixture "read back".
//
// More address parameters, on top of bots.html's:
//   lc=intro|choose|picture|duplicate|export|import|delete   a dialog to open
//   primary=<id>        the primary bot Clawtrate has stored for this person
//   prefs=device        the gateway keeps no preferences for this connection
//   primfail=1          saving the primary bot fails
//   ptab=bot|generate|upload   the picture editor's tab
//   imagetool=1|unknown the gateway offers the bot its image tool, or the bot has no task to ask about
//   upload=crop|toolarge|notimage   the Upload tab with a file chosen
//   picfail=1|dropped   the gateway refuses the picture, or takes it and its list shows none
//   edit=name|label     the hero's name or label open for editing
//   namefail=1          the gateway refuses the rename
//   bview=instructions  the Instructions page (instr=conflict: the file changed meanwhile)
//   rolechange=1        Juniper's open task shows a change to its instructions
//   rolediff=nocopy|toolarge  ... with no earlier copy, or one too large to keep; undo=conflict: the undo is refused
//   delbot=<id>         the bot the Delete or Duplicate dialog is for (default: the open bot)
//   shared=1            Pip's workspace folder is also Juniper's
//   files=1             Delete's folder option ticked
//   delread=loading|failed   reading what the bot has
//   delresult=partial|refused|uncertain   how the delete ends
//   dupacct=own         the bot's account is kept by it alone
//   dup=partial|refused the copy is made but its instructions are not copied, or the gateway refuses to make it
//   onlybot=1           the gateway has one bot

(function () {
  const CT = window.CT;
  const app = window.app;
  const D = CT.botsData;
  const params = CT.params;
  const p = (name) => params.get(name);
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name, cls) => CT.icon(name, cls);
  const { button, note, copy, glyph, announce, isAdmin, adminBar } = D;
  const B = D.B;
  const dialog = $("#lc-dialog");
  const botOf = (id) => app.bots.find((b) => b.id === id);
  const nameOf = (id) => botOf(id)?.name || id;

  // The gateway's side, as the fixtures have it ----------------------------------------------------

  const GATEWAY_DEFAULT = "juniper"; // agents.list defaultId
  if (p("onlybot")) app.bots.splice(0, app.bots.length, ...app.bots.filter((b) => b.id === (app.model.selectedBot || "otto")));
  const L = {
    primary: p("primary") || null, // what users.prefs holds for this person; null: nothing stored
    deviceOnly: p("prefs") === "device",
    dialog: null,
    opener: null,
  };
  const primaryId = () => (L.primary && botOf(L.primary) ? L.primary : botOf(GATEWAY_DEFAULT) ? GATEWAY_DEFAULT : app.bots[0]?.id);
  // What a delete or a copy reads at that moment: each bot's workspace folder,
  // its tasks, its routines, its channel routes, its memory files.
  const FACTS = {
    juniper: { folder: "workspace-juniper", files: 31, memory: "MEMORY.md and 5 notes", tasks: 6, routines: [], routes: 0, own: [] },
    marlow: { folder: "workspace-marlow", files: 18, memory: "MEMORY.md and 2 notes", tasks: 4, routines: ["Friday newsletter"], routes: 0, own: [] },
    otto: { folder: "workspace-otto", files: 44, memory: "MEMORY.md and 3 notes", tasks: 14, routines: ["Nightly disk check", "Monday backups"], routes: 1, own: [] },
    pip: { folder: "workspace-pip", files: 23, memory: "MEMORY.md and 3 notes", tasks: 4, routines: ["Weekly plan", "Sunday reminder"], routes: 0, own: ["Pip's key"] },
  };
  if (p("shared")) FACTS.pip.folder = FACTS.juniper.folder;
  const sharers = (id) => app.bots.filter((b) => b.id !== id && FACTS[b.id] && FACTS[id] && FACTS[b.id].folder === FACTS[id].folder).map((b) => b.name);
  const INSTR = {
    juniper: { agents: "# Juniper\n\nYou research questions for the household.\nCite every source you use.\nKeep answers under 300 words.\n", soul: "Curious, careful, plain-spoken.\n", at: "Nov 17, 5:38 PM" },
  };
  const instr = (id) => (INSTR[id] ??= { agents: `# ${nameOf(id)}\n\nYou help with ${(botOf(id)?.label || "everyday tasks").toLowerCase()}.\n`, soul: "Calm and brief.\n", at: "Nov 16, 9:12 AM" });
  const lines = (text) => text.replace(/\n$/, "").split("\n").length;

  // The primary bot's star, in the rail and on a pinned tile ---------------------------------------

  CT.railStar = (b) => (b.id === primaryId() ? `<span class="lc-star" role="img" aria-label="Primary bot" title="Primary bot">${starSvg}</span>` : "");
  const starSvg = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.3l1.38 2.8 3.09.45-2.24 2.18.53 3.08L6 8.35 3.24 9.8l.53-3.08L1.53 4.55l3.09-.45z" fill="currentColor"/></svg>`;
  const refreshRail = () => app.openTask(app.model.selectedBot, app.model.selectedTask);

  // A bot's menu: Duplicate, Export and Delete, or Replace for the primary bot.
  CT.railMenuExtra = (b, item) => {
    if (!isAdmin() && B.access !== "write") return "";
    const primary = b.id === primaryId();
    return (
      `<li class="menu-rule" role="separator"></li>` +
      (isAdmin() ? item("Rename", `data-lc="rename-rail" data-lc-bot="${b.id}"`) : "") +
      (isAdmin() ? item("Duplicate…", `data-lc="open-duplicate" data-lc-bot="${b.id}"`) : "") +
      item("Export…", `data-lc="open-export" data-lc-bot="${b.id}"`) +
      (primary
        ? item("Replace with different bot", `data-lc="open-choose" data-lc-bot="${b.id}"`)
        : (B.access === "write" || isAdmin() ? item("Make primary bot", `data-lc="make-primary" data-lc-bot="${b.id}"`) : "") +
          (isAdmin() ? item("Delete…", `data-lc="open-delete" data-lc-bot="${b.id}"`, "", "danger") : ""))
    );
  };

  // The dialog --------------------------------------------------------------------------------------

  const head = (title, backTo) =>
    `<header class="b-head">${backTo ? `<button type="button" class="icon-button b-back" data-lc="${backTo}" aria-label="Back">${icon("back")}</button>` : ""}` +
    `<h2 id="lc-title" tabindex="-1">${title}</h2><button type="button" class="icon-button b-close" data-lc="close" aria-label="Close">${icon("x")}</button></header>`;
  const sheet = (title, body, foot, backTo) => `<div class="b-sheet">${head(title, backTo)}<div class="b-body">${body}</div>${foot ? `<footer class="b-foot">${foot}</footer>` : ""}</div>`;

  function openDialog(kind, opener, extra = {}) {
    L.dialog = { kind, ...extra };
    L.opener = opener || document.activeElement;
    paint(true);
    if (!dialog.open) dialog.showModal();
  }
  function closeDialog() {
    if (dialog.open) dialog.close();
    L.dialog = null;
    const o = L.opener;
    L.opener = null;
    if (o && document.contains(o)) o.focus();
  }
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    if (L.dialog?.busy) return;
    closeDialog();
  });

  function paint(focus) {
    const d = L.dialog;
    if (!d) return;
    dialog.dataset.kind = d.kind === "delete" ? "lc-delete" : "lc";
    const view = VIEWS[d.kind](d);
    dialog.innerHTML = view;
    CT.hydrate(dialog);
    if (focus) requestAnimationFrame(() => ($("[data-lc-focus]", dialog) || $("#lc-title", dialog))?.focus());
  }

  const VIEWS = {};

  // The primary bot (section 3) ---------------------------------------------------------------------

  const keptLine = () =>
    L.deviceOnly
      ? `<p class="b-hint" data-lc-kept>This device only: this connection has no profile on the gateway to keep it in, so your other devices won't show it.</p>`
      : `<p class="b-hint" data-lc-kept>Kept for you on this gateway, so your other devices show the same star. Other people who use this gateway choose their own.</p>`;

  VIEWS.intro = () =>
    sheet(
      "Introducing the primary bot",
      `<span class="lc-intro-art" aria-hidden="true"><span class="avatar" data-bot="${primaryId()}"></span><span class="lc-star">${starSvg}</span></span>` +
        `<p class="b-lead">Your primary bot comes first in your list, with a star, and it's the bot Clawtrate offers when you share something into the app.</p>` +
        `<p class="b-lead">Choosing one changes nothing on the gateway. ${esc(nameOf(GATEWAY_DEFAULT))} has the star until you choose: it's the gateway's default bot.</p>` +
        keptLine(),
      button("Use an existing bot", 'data-lc="open-choose" data-lc-focus data-size="lg"', "primary") +
        (isAdmin() ? button("Create primary bot", 'data-lc="create-primary" data-size="lg"') : "") +
        button("Not now", 'data-lc="intro-later" data-size="lg"', "quiet") +
        (B.access === "read" ? writeBar() : ""),
    );

  const writeBar = () =>
    `<section class="access-bar" role="region" aria-label="Access" data-state="none"><div class="access-row">${icon("eye")}<span class="shelf-text"><b>Read-only.</b> Choosing a primary bot needs the interactive tier: it saves a preference for you on the gateway.</span>${button("Request access", 'data-b="request-write" data-size="sm"', "primary")}</div></section>`;

  VIEWS.choose = (d) => {
    const q = (d.query || "").toLowerCase();
    const current = primaryId();
    const pick = d.pick || current;
    const rows = app.bots
      .filter((b) => !q || b.name.toLowerCase().includes(q) || (b.label || "").toLowerCase().includes(q))
      .map(
        (b) =>
          `<li><button type="button" class="b-choice" role="radio" aria-checked="${b.id === pick}" tabindex="${b.id === pick ? 0 : -1}" data-lc-pick="${b.id}"${B.access === "read" ? ' aria-disabled="true"' : ""}>` +
          `<span class="avatar" data-bot="${b.id}"></span><span class="b-choice-text"><span class="b-choice-title">${esc(b.name)}${b.label ? ` <span class="b-faint">· ${esc(b.label)}</span>` : ""}</span>` +
          `<span class="b-choice-sub">${[b.id === current ? "Your primary bot" : "", b.id === GATEWAY_DEFAULT ? "The gateway's default bot" : ""].filter(Boolean).join(" · ") || "&nbsp;"}</span></span>${icon("check", "icon b-tick")}</button></li>`,
      )
      .join("");
    const busy = d.status === "saving";
    return sheet(
      "Choose a primary bot",
      `<label class="visually-hidden" for="lc-search">Search bots</label><input class="input lc-search" id="lc-search" placeholder="Search" autocomplete="off" value="${esc(d.query || "")}" data-lc-focus />` +
        `<ul class="b-choices lc-bots" role="radiogroup" aria-label="Bots">${rows || `<li class="b-hint">No bot matches.</li>`}</ul>` +
        (d.status === "failed"
          ? note(`<p><b>Couldn't save your choice.</b> The gateway didn't answer. Your primary bot is still ${esc(nameOf(current))}.</p>`, "danger")
          : d.status === "conflict"
            ? note(`<p><b>Another of your devices chose ${esc(nameOf(d.theirs))} a moment ago.</b> That's what the gateway has now. Confirm to choose ${esc(nameOf(pick))} instead.</p>`, "warn")
            : "") +
        keptLine() +
        `<p class="b-hint">The gateway's own default bot stays ${esc(nameOf(GATEWAY_DEFAULT))}. Clawtrate doesn't change it: the gateway uses it for messages no route claims.</p>`,
      B.access === "read"
        ? writeBar()
        : button(busy ? "Saving…" : d.status === "failed" ? "Try again" : "Confirm", `data-lc="confirm-primary" data-size="lg"${pick === current && d.status !== "conflict" ? " disabled" : ""}${busy ? ' aria-busy="true" disabled' : ""}`, "primary"),
      d.from === "intro" ? "back-intro" : "",
    );
  };

  function savePrimary(id) {
    const d = L.dialog;
    d.status = "saving";
    paint();
    setTimeout(() => {
      if (p("primfail") && !d.retried) {
        d.status = "failed";
        d.retried = true;
        paint();
        $('[data-lc="confirm-primary"]', dialog)?.focus();
        announce("Couldn't save your choice");
        return;
      }
      if (p("primconflict") && !d.conflicted) {
        d.status = "conflict";
        d.conflicted = true;
        d.theirs = "marlow";
        L.primary = "marlow";
        refreshRail();
        paint();
        return;
      }
      // users.prefs.set, then users.prefs.get: the star moves only on what was read back.
      L.primary = id;
      closeDialog();
      refreshRail();
      announce(`${nameOf(id)} is your primary bot${L.deviceOnly ? " on this device" : ""}`);
    }, 500);
  }

  // The picture editor (section 4) ------------------------------------------------------------------

  const BODIES = ["pebble", "block", "arch", "bloom", "disc", "hex", "drop", "gem"];
  const COLORS = ["#58c26f", "#5b8dff", "#ff8552", "#a98bff", "#f6bd3b", "#ff6f9c", "#45bdf5", "#a5d955"];
  const COLOR_NAMES = ["Green", "Blue", "Orange", "Violet", "Yellow", "Pink", "Sky", "Lime"];
  const PHOTO = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='%23f6bd3b'/><stop offset='1' stop-color='%23ff8552'/></linearGradient></defs><rect width='120' height='120' fill='url(%23g)'/><circle cx='84' cy='34' r='14' fill='%23fff4d6'/><path d='M0 92 L34 58 L62 86 L82 70 L120 100 L120 120 L0 120Z' fill='%23a5502a'/></svg>\")";

  VIEWS.picture = (d) => {
    const id = d.bot;
    const tab = d.tab;
    const tabs = [
      ["bot", "Bot"],
      ["generate", "Generate"],
      ["upload", "Upload"],
    ]
      .map(([t, label]) => `<button type="button" class="tab" role="tab" aria-selected="${t === tab}" tabindex="${t === tab ? 0 : -1}" data-lc-tab="${t}">${label}</button>`)
      .join("");
    let body = "";
    let foot = "";
    const saving = d.status === "saving";
    const refused =
      d.status === "refused"
        ? note(`<p><b>The gateway didn't save the picture:</b> it refused the change. ${esc(nameOf(id))}'s picture is unchanged.</p>`, "danger")
        : d.status === "dropped"
          ? note(`<p><b>The gateway took the picture but doesn't show it.</b> Its list of bots returns no picture for ${esc(nameOf(id))} now, so no device will show this one.</p>`, "danger")
          : "";
    if (tab === "bot") {
      const art = d.body && d.color ? (CT.botArt.__lc = { body: d.body, color: d.color, tilt: 0, look: [0.6, 0] }) && CT.character("__lc") : `<span class="avatar" data-bot="${id}"></span>`;
      body =
        `<span class="b-preview" role="img" aria-label="${esc(nameOf(id))}'s picture">${art}</span>` +
        `<p class="b-hint lc-center">The gateway keeps ${esc(nameOf(id))}'s picture, not the shape and colour it was drawn from. Pick both to draw a new one.</p>` +
        `<p class="b-label" id="lc-shape-label">Shape</p><div class="b-shapes" role="radiogroup" aria-labelledby="lc-shape-label">` +
        BODIES.map((body, i) => {
          CT.botArt.__lcs = { body, color: d.color || "#9aa0a6", tilt: 0, look: [0.6, 0] };
          const on = body === d.body;
          return `<button type="button" class="b-shape" role="radio" aria-checked="${on}" tabindex="${on || (!d.body && i === 0) ? 0 : -1}" aria-label="${body}" data-lc-body="${body}">${CT.character("__lcs")}</button>`;
        }).join("") +
        `</div><p class="b-label" id="lc-color-label">Colour</p><div class="b-colors" role="radiogroup" aria-labelledby="lc-color-label">` +
        COLORS.map((c, i) => `<button type="button" class="b-color" role="radio" aria-checked="${c === d.color}" tabindex="${c === d.color || (!d.color && i === 0) ? 0 : -1}" aria-label="${COLOR_NAMES[i]}" style="--swatch:${c}" data-lc-color="${c}"></button>`).join("") +
        `</div>` +
        refused;
      foot = button(saving ? "Saving…" : "Set picture", `data-lc="set-picture" data-size="lg"${d.body && d.color && !saving ? "" : " disabled"}${saving ? ' aria-busy="true"' : ""}`, "primary");
    } else if (tab === "generate") {
      body = p("imagetool") === "unknown"
        ? `<div class="b-result"><span class="empty-mark">${icon("image")}</span><h3>Not known yet</h3><p>The gateway says which tools ${esc(nameOf(id))} is offered for one of its tasks, and ${esc(nameOf(id))} has none yet. Start a task, then look here again.</p></div>`
        : p("imagetool")
        ? `<div class="b-result"><span class="empty-mark">${icon("image")}</span><h3>Generating a picture isn't available in this version</h3><p>The gateway offers ${esc(nameOf(id))} an image tool, but Clawtrate can't use it here yet. You can ask ${esc(nameOf(id))} for a picture in a task, then upload it.</p></div>`
        : `<div class="b-result"><span class="empty-mark">${icon("image")}</span><h3>Image generation isn't available on this gateway</h3><p>The gateway doesn't offer ${esc(nameOf(id))} its image tool: “Denied by tools.deny”, in the gateway's own words.</p></div>`;
      foot = button("Generate", 'data-size="lg" disabled', "primary");
    } else {
      const up = d.upload;
      if (up === "crop" || up === "set")
        body =
          `<div class="lc-crop" role="img" aria-label="The chosen image, with the square that becomes the picture"><span class="lc-crop-photo" style="background-image:${esc(PHOTO)}"></span><span class="lc-crop-ring"></span></div>` +
          `<label class="lc-zoom"><span>Zoom</span><input type="range" min="100" max="300" value="140" data-lc-zoom /></label>` +
          `<p class="b-hint lc-center">trail-sunrise.jpg · 4.2 MB. Drag to move it in the circle. Clawtrate saves the circle's square at 128 by 128 pixels.</p>` +
          refused;
      else
        body =
          `<div class="lc-drop" data-lc-drop><span class="empty-mark">${icon("image")}</span><p>Drop an image here</p>${button("Browse files", 'data-lc="browse" data-size="sm" data-lc-focus')}<p class="b-hint">PNG, JPEG, WebP or GIF, under 25 MB.</p></div>` +
          (up === "toolarge" ? note(`<p><b>That image is 31.4 MB.</b> Choose one under 25 MB. ${esc(nameOf(id))}'s picture is unchanged.</p>`, "warn") : "") +
          (up === "notimage" ? note(`<p><b>notes.pdf isn't an image.</b> Choose a PNG, JPEG, WebP or GIF file.</p>`, "warn") : "");
      foot = button(saving ? "Saving…" : "Set picture", `data-lc="set-picture" data-size="lg"${up === "crop" && !saving ? "" : " disabled"}${saving ? ' aria-busy="true"' : ""}`, "primary");
    }
    return sheet(`${esc(nameOf(id))}'s picture`, `<div class="tabs lc-tabs" role="tablist" aria-label="Picture">${tabs}</div><div role="tabpanel" class="lc-tabpanel" aria-label="${tab}">${body}</div>`, isAdmin() ? foot : adminBar(`Changing ${esc(nameOf(id))}'s picture needs admin access.`));
  };

  function setPicture() {
    const d = L.dialog;
    d.status = "saving";
    d.busy = true;
    paint();
    setTimeout(() => {
      d.busy = false;
      if (p("picfail") && !d.retried) {
        d.retried = true;
        d.status = p("picfail") === "dropped" ? "dropped" : "refused";
        paint();
        announce(d.status === "dropped" ? "The gateway doesn't show the picture" : "The gateway didn't save the picture");
        return;
      }
      // agents.update {avatar}, then agents.list: the hero shows what the list returns.
      if (d.tab === "bot") CT.botArt[d.bot] = { body: d.body, color: d.color, tilt: 0, look: [0.6, 0] };
      else L.photo[d.bot] = true;
      closeDialog();
      refreshRail();
      decorateHero();
      $('[data-lc="open-picture"]', hero)?.focus();
      announce("Picture saved");
    }, 500);
  }
  L.photo = {};

  // The hero: the picture, the name and the label in place (section 4) ------------------------------

  const hero = $("#work-hero");
  const E = { field: p("edit") || null, value: null, status: null, error: null };
  function decorateHero() {
    const id = app.model.selectedBot;
    const b = botOf(id);
    const key = `${id}:${b.name}:${b.label}:${E.field}:${E.status}:${E.error}:${isAdmin()}:${Boolean(L.photo[id])}`;
    // The app redraws the hero on its own; redecorate whenever its markup isn't ours.
    if (!b || (hero.dataset.lc === key && hero.querySelector("[data-lc-hero]"))) return;
    hero.dataset.lc = key;
    const admin = isAdmin();
    const pic = `<span class="avatar" data-bot="${id}"${L.photo[id] ? ` style="background-image:${esc(PHOTO)}" data-photo="true"` : ""}></span>`;
    const nameEdit = E.field === "name";
    const labelEdit = E.field === "label";
    // On the phone the label is called "Title" (F-271).
    const phone = p("width") === "phone" || matchMedia("(max-width: 687px)").matches;
    const labelWord = phone ? "Title" : "Label";
    hero.innerHTML =
      `<span data-lc-hero hidden></span>` +
      (admin ? `<button type="button" class="lc-hero-pic" data-lc="open-picture" aria-label="Change ${esc(b.name)}'s picture">${pic}<span class="lc-pic-badge" aria-hidden="true">${icon("image")}</span></button>` : pic) +
      (nameEdit
        ? `<input class="lc-inline lc-inline-name" data-lc-inline="name" aria-label="Name" value="${esc(E.value ?? b.name)}" maxlength="40"${E.status === "saving" ? ' aria-busy="true" readonly' : ""} />`
        : admin
          ? `<h2><button type="button" class="lc-inline-button" data-lc="edit-name" aria-label="${esc(b.name)}. Rename">${esc(b.name)}</button></h2>`
          : `<h2>${esc(b.name)}</h2>`) +
      (labelEdit
        ? `<input class="lc-inline lc-inline-label" data-lc-inline="label" aria-label="${labelWord}" placeholder="Add a ${labelWord.toLowerCase()}" value="${esc(E.value ?? b.label ?? "")}" maxlength="24"${E.status === "saving" ? ' aria-busy="true" readonly' : ""} />`
        : admin
          ? `<p><button type="button" class="lc-inline-button" data-lc="edit-label" aria-label="${b.label ? `${labelWord}: ${esc(b.label)}. Change` : `Add a ${labelWord.toLowerCase()}`}">${b.label ? esc(b.label) : `<span class="b-faint">Add a ${labelWord.toLowerCase()}</span>`}</button></p>`
          : b.label
            ? `<p>${esc(b.label)}</p>`
            : "") +
      (E.status === "saving" ? `<p class="b-hint lc-hero-line" role="status">Saving…</p>` : "") +
      (E.error ? `<p class="b-hint lc-hero-line" data-tone="danger" role="alert">${E.error}</p>` : "");
    CT.hydrate(hero);
    if (nameEdit || labelEdit) {
      const input = $("[data-lc-inline]", hero);
      if (E.status !== "saving") requestAnimationFrame(() => (input.focus(), input.select()));
    }
  }
  new MutationObserver(() => decorateHero()).observe(hero, { childList: true });

  function startEdit(field) {
    if (!isAdmin()) return;
    E.field = field;
    E.value = null;
    E.status = null;
    E.error = null;
    hero.dataset.lc = "";
    decorateHero();
  }
  function stopEdit(refocus) {
    const field = E.field;
    E.field = null;
    E.status = null;
    E.value = null;
    hero.dataset.lc = "";
    decorateHero();
    if (refocus) $(`[data-lc="edit-${field}"]`, hero)?.focus();
  }
  function saveEdit(value) {
    const id = app.model.selectedBot;
    const b = botOf(id);
    const field = E.field;
    const text = value.trim().replace(/\s+/g, " ");
    if (field === "name" && !text) {
      E.error = "A bot needs a name.";
      E.value = value;
      hero.dataset.lc = "";
      return decorateHero();
    }
    if ((field === "name" ? b.name : b.label || "") === text) return stopEdit(true);
    E.status = "saving";
    E.value = value;
    E.error = null;
    hero.dataset.lc = "";
    decorateHero();
    setTimeout(() => {
      if (field === "name" && p("namefail") && !E.retried) {
        E.retried = true;
        E.status = null;
        E.error = `Couldn't rename: the gateway refused it. The name is still ${esc(b.name)}.`;
        hero.dataset.lc = "";
        decorateHero();
        announce("Couldn't rename");
        return;
      }
      // agents.update {name} or config.patch identity.theme, then agents.list: what it returns is shown.
      if (field === "name") b.name = text;
      else b.label = text;
      E.error = null;
      refreshRail();
      stopEdit(true);
      announce(field === "name" ? `Renamed to ${text}` : text ? "Label saved" : "Label removed");
    }, 450);
  }
  hero.addEventListener("keydown", (e) => {
    const input = e.target.closest("[data-lc-inline]");
    if (!input || E.status === "saving") return;
    if (e.key === "Enter") {
      e.preventDefault();
      saveEdit(input.value);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      E.error = null;
      stopEdit(true);
    }
  });
  hero.addEventListener("focusout", (e) => {
    const input = e.target.closest("[data-lc-inline]");
    if (!input || E.status === "saving" || E.error) return;
    setTimeout(() => {
      if (E.field && !hero.contains(document.activeElement)) saveEdit(input.value);
    }, 0);
  });

  // Renaming in the rail: a double-click on the name, or Rename in the bot's menu (F-026).
  let railEdit = null;
  function renameInRail(id) {
    if (!isAdmin()) return;
    const row = $(`#bot-list .bot[data-bot="${id}"]`);
    const span = row && $(".bot-name", row);
    if (!span) return;
    railEdit = id;
    const input = document.createElement("input");
    input.className = "lc-inline lc-rail-input";
    input.value = nameOf(id);
    input.setAttribute("aria-label", "Name");
    input.maxLength = 40;
    span.replaceWith(input);
    input.focus();
    input.select();
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        const text = input.value.trim().replace(/\s+/g, " ");
        if (!text) return (input.setAttribute("aria-invalid", "true"), announce("A bot needs a name."));
        input.readOnly = true;
        input.setAttribute("aria-busy", "true");
        setTimeout(() => {
          botOf(id).name = text;
          railEdit = null;
          refreshRail();
          $(`#bot-list .bot[data-bot="${id}"]`)?.focus();
          announce(`Renamed to ${text}`);
        }, 400);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        railEdit = null;
        refreshRail();
        $(`#bot-list .bot[data-bot="${id}"]`)?.focus();
      }
    });
  }
  // The prototype's rail redraws its rows on the first click, so the browser
  // sees no double-click; two clicks on one name within 450 ms are one here.
  let lastNameClick = null;
  document.addEventListener(
    "click",
    (e) => {
      const name = e.target.closest("#bot-list .bot .bot-name");
      if (!name) return;
      const id = name.closest(".bot").dataset.bot;
      const now = Date.now();
      if (lastNameClick && lastNameClick.id === id && now - lastNameClick.t < 450) {
        lastNameClick = null;
        setTimeout(() => renameInRail(id), 30);
      } else lastNameClick = { id, t: now };
    },
    true,
  );
  document.addEventListener("dblclick", (e) => {
    const name = e.target.closest("#bot-list .bot .bot-name");
    // After the app's own redraw for the clicks that made the double-click.
    if (name && !railEdit) {
      const id = name.closest(".bot").dataset.bot;
      setTimeout(() => !railEdit && renameInRail(id), 30);
    }
  });

  // The Settings tab: About, and a Manage group at the foot (sections 6 to 9) -----------------------

  CT.botsAboutRows = (id, row) => {
    const i = instr(id);
    // bots.md section 8's Description row stays as that document places it.
    return row("Description", `<span class="b-faint">None</span>`) + row("Instructions", `AGENTS.md, ${lines(i.agents)} lines · SOUL.md, ${lines(i.soul)} ${lines(i.soul) === 1 ? "line" : "lines"}`, `data-bs="instructions" aria-label="Instructions: AGENTS.md and SOUL.md. Open."`);
  };
  CT.botsSettingsTail = (id) => {
    const primary = id === primaryId();
    const only = app.bots.length === 1;
    const name = esc(nameOf(id));
    return (
      `<h3 class="b-tabgroup">Manage</h3><dl class="facts lc-manage">` +
      `<div><dt>Primary bot</dt><dd>${primary ? `Yes${L.primary ? "" : ", as the gateway's default"}` : "No"}</dd></div>` +
      `</dl><div class="lc-manage-actions">` +
      (B.access === "read" ? "" : primary ? button("Replace with different bot", 'data-lc="open-choose" data-size="sm"') : button("Make primary bot", `data-lc="make-primary" data-lc-bot="${id}" data-size="sm"`)) +
      (isAdmin() ? button("Duplicate…", `data-lc="open-duplicate" data-lc-bot="${id}" data-size="sm"`) : "") +
      button("Export…", `data-lc="open-export" data-lc-bot="${id}" data-size="sm"`) +
      (isAdmin() ? button(`Delete ${name}…`, `data-lc="open-delete" data-lc-bot="${id}" data-size="sm" data-tone="danger"${primary || only ? " disabled" : ""}`, "quiet") : "") +
      `</div>` +
      (isAdmin() && only ? `<p class="b-hint">${name} is the gateway's only bot, and the gateway doesn't delete its only bot.</p>` : isAdmin() && primary ? `<p class="b-hint">${name} is your primary bot. Choose another primary bot before deleting it.</p>` : "")
    );
  };

  // The Instructions page (section 6).
  const I = { mode: p("instr") === "conflict" ? "conflict" : null, draft: null, status: null, savedAt: null };
  if (I.mode === "conflict") I.draft = { agents: instr("juniper").agents.replace("Keep answers under 300 words.", "Keep answers under 200 words."), soul: instr("juniper").soul };
  CT.botsPageViews = Object.assign(CT.botsPageViews || {}, {
    instructions: (id) => {
      const i = instr(id);
      const name = esc(nameOf(id));
      const admin = isAdmin();
      const draft = I.draft || i;
      const changed = I.draft && (I.draft.agents !== i.agents || I.draft.soul !== i.soul);
      const theirs = I.mode === "conflict" ? i.agents.replace("Cite every source you use.", "Cite every source you use, with its date.") : null;
      const field = (key, title, file, help) =>
        `<h4 class="b-group"><label for="lc-${key}">${title}</label> <span class="b-faint">· ${file}</span></h4>` +
        (admin
          ? `<textarea class="input lc-text" id="lc-${key}" data-lc-instr="${key}" rows="${key === "agents" ? 9 : 3}" spellcheck="true">${esc(draft[key])}</textarea>`
          : `<pre class="lc-text lc-text-read" id="lc-${key}" tabindex="0">${esc(i[key])}</pre>`) +
        `<p class="b-hint">${help}</p>`;
      return (
        `<div class="b-subhead"><button type="button" class="icon-button" data-variant="quiet" data-bs="main" aria-label="Back to settings">${icon("back")}</button><h3 tabindex="-1" data-bs-focus>Instructions</h3></div>` +
        `<p class="b-hint lc-first">${name} reads these two files at the start of each new task. A task already open keeps the copy it started with. Changed ${esc(i.at)}.</p>` +
        (I.mode === "conflict"
          ? note(
              `<p><b>${name}'s instructions changed on the gateway while you were editing.</b> Your text is kept here. The gateway now has:</p><pre class="lc-theirs">${esc(theirs)}</pre>` +
                `<div class="b-actions">${button("Save mine over it", 'data-lc="instr-mine" data-size="sm"')}${button("Use the gateway's", 'data-lc="instr-theirs" data-size="sm"', "quiet")}</div>`,
              "warn",
            )
          : "") +
        field("agents", "Instructions", "AGENTS.md", "How it works: rules, priorities, what to do and not do.") +
        field("soul", "Personality", "SOUL.md", "Its tone and manner.") +
        `<p class="b-hint">Past 20,000 characters the gateway loads the start and the end of a file and leaves out the middle. Memory is separate: what ${name} remembers is under Memory, and these files don't change it.</p>` +
        (admin
          ? `<div class="b-actions lc-instr-actions">${I.status === "saved" ? `<span class="b-hint lc-saved" role="status">${icon("check")}Saved ${I.savedAt}. The gateway has this text now.</span>` : ""}${I.status === "failed" ? `<span class="b-hint" data-tone="danger" role="alert">Couldn't save: the gateway didn't answer. Your text is kept here.</span>` : ""}<span class="spacer"></span>` +
            button(I.status === "saving" ? "Saving…" : "Save", `data-lc="instr-save" data-size="sm"${changed && I.status !== "saving" && I.mode !== "conflict" ? "" : " disabled"}${I.status === "saving" ? ' aria-busy="true"' : ""}`, "primary") +
            `</div>`
          : "")
      );
    },
  });
  CT.botsPageNeeds = Object.assign(CT.botsPageNeeds || {}, { instructions: (name) => `Changing ${name}'s instructions needs admin access.` });

  function saveInstructions(over) {
    const id = app.model.selectedBot;
    I.status = "saving";
    I.mode = null;
    CT.botsRender();
    setTimeout(() => {
      if (p("instrfail") && !I.retried) {
        I.retried = true;
        I.status = "failed";
        CT.botsRender();
        return;
      }
      // agents.files.set with the hash read, then agents.files.get: "Saved" only when the hashes match.
      Object.assign(instr(id), I.draft, { at: "Nov 19, 5:44 PM" });
      I.draft = null;
      I.status = "saved";
      I.savedAt = "5:44 PM";
      CT.botsRender();
      announce(over ? "Saved over the gateway's copy" : "Instructions saved");
    }, 450);
  }
  document.addEventListener("input", (e) => {
    const area = e.target.closest("[data-lc-instr]");
    if (area) {
      const id = app.model.selectedBot;
      I.draft = I.draft || { ...instr(id) };
      I.draft[area.dataset.lcInstr] = area.value;
      if (I.status === "saved" || I.status === "failed") I.status = null;
      const save = $('[data-lc="instr-save"]');
      const i = instr(id);
      if (save) save.disabled = I.mode === "conflict" || (I.draft.agents === i.agents && I.draft.soul === i.soul);
    }
    if (e.target.id === "lc-search") {
      L.dialog.query = e.target.value;
      paint();
      const s = $("#lc-search", dialog);
      s.focus();
      s.setSelectionRange(s.value.length, s.value.length);
    }
  });

  // A role change from the conversation (section 7) -----------------------------------------------

  const R = { state: p("rolechange") ? "new" : null, nocopy: p("rolediff") === "nocopy", toolarge: p("rolediff") === "toolarge" };
  if (R.state) {
    const j = botOf("juniper");
    const t = j.tasks.find((x) => x.id === (p("task") || "j1")) || j.tasks[0];
    t.html =
      `<div class="stamp">Today 5:41 PM</div>` +
      `<div class="turn" data-role="user" data-testid="transcript-turn"><div class="msg" data-role="user"><div class="bubble">From now on keep your answers under 200 words.</div></div></div>` +
      `<div class="turn" data-role="assistant" data-testid="transcript-turn"><div class="msg" data-role="assistant"><div class="bubble md">Done. I've changed my instructions to keep answers under 200 words.</div></div></div>` +
      `<div id="lc-role" data-testid="role-line"></div>`;
    t.fresh = false;
  }
  const DIFF = { removed: "Keep answers under 300 words.", added: "Keep answers under 200 words." };
  function roleLine() {
    const slot = $("#lc-role");
    if (!slot || slot.dataset.state === `${R.state}:${isAdmin()}:${R.open}`) return;
    slot.dataset.state = `${R.state}:${isAdmin()}:${R.open}`;
    const head = `Juniper changed its instructions`;
    let body;
    if (R.toolarge)
      body = `<p class="b-p">Juniper wrote to AGENTS.md in this run. Clawtrate keeps an earlier copy only of a file up to 65,536 characters, and this one is longer, so it can't show the change or undo it.</p><div class="b-actions">${button("Open instructions", 'data-lc="open-instructions" data-size="sm"')}</div>`;
    else if (R.nocopy)
      body = `<p class="b-p">Juniper wrote to AGENTS.md in this run. Clawtrate has no earlier copy of the file to compare, so it can't show the change or undo it.</p><div class="b-actions">${button("Open instructions", 'data-lc="open-instructions" data-size="sm"')}</div>`;
    else {
      const diff =
        `<p class="code-label">AGENTS.md, since Clawtrate read it at 5:38 PM</p>` +
        `<pre class="lc-diff" aria-label="Changes"><span data-op="ctx">You research questions for the household.</span><span data-op="ctx">Cite every source you use.</span><span data-op="del"><span class="visually-hidden">Removed: </span>${esc(DIFF.removed)}</span><span data-op="add"><span class="visually-hidden">Added: </span>${esc(DIFF.added)}</span></pre>`;
      const actions =
        R.state === "new"
          ? isAdmin()
            ? `<div class="b-actions">${button("Accept", 'data-lc="role-keep" data-size="sm"')}${button("Undo", 'data-lc="role-undo" data-size="sm"')}<span class="spacer"></span><span class="b-hint">The change is already saved on the gateway.</span></div>`
            : `<div class="b-actions">${button("Accept", 'data-lc="role-keep" data-size="sm"')}<span class="spacer"></span><span class="b-hint">The change is already saved on the gateway. Undoing it needs admin access.</span></div>`
          : R.state === "undoing"
            ? `<p class="b-wait" role="status"><span class="status-dot" data-status="connecting"></span>Undoing…</p>`
            : R.state === "kept"
              ? `<p class="b-p" role="status">Accepted. The change was already on the gateway, so nothing was written.</p>`
              : R.state === "undone"
                ? `<p class="b-p" role="status">Undone. AGENTS.md on the gateway is back to Clawtrate's copy from 5:38 PM.</p>`
                : `<p class="b-p" role="alert">Nothing was undone: AGENTS.md changed again after this run. Open the instructions to see what it has now.</p><div class="b-actions">${button("Open instructions", 'data-lc="open-instructions" data-size="sm"')}</div>`;
      body = diff + actions;
    }
    const tail = R.state === "kept" ? " · accepted" : R.state === "undone" ? " · undone" : "";
    slot.innerHTML = `<details class="event-details"${R.open ? " open" : ""}><summary class="event-line">${head}${tail}${icon("chevron", "icon chevron")}</summary><div class="card event-body">${body}</div></details>`;
    CT.hydrate(slot);
  }
  new MutationObserver(() => roleLine()).observe($("#transcript"), { childList: true, subtree: false });
  document.addEventListener("toggle", (e) => {
    if (e.target.closest?.("#lc-role")) R.open = e.target.open;
  }, true);

  // Duplicate (section 8) ---------------------------------------------------------------------------

  VIEWS.duplicate = (d) => {
    const id = d.bot;
    const name = esc(nameOf(id));
    const f = FACTS[id];
    const own = p("dupacct") === "own";
    const b = D.binding[id] || {};
    const a = D.acct(own ? "anthropic:pip" : b.account);
    if (d.status === "working" || d.status === "done" || d.status === "partial") return stepsView(d);
    const item = (key, title, sub, disabled) =>
      `<label class="b-check lc-item"><input type="checkbox" data-lc-copy="${key}"${d.copy[key] ? " checked" : ""}${disabled ? " disabled" : ""} /><span class="lc-item-text"><span>${title}</span><span class="b-hint">${sub}</span></span></label>`;
    const shared = D.shared().filter((x) => x.provider !== "anthropic" || true);
    return sheet(
      `Duplicate ${name}`,
      `<label class="b-label" for="lc-dup-name">Name of the copy</label><input class="input lc-dup-name" id="lc-dup-name" value="${esc(d.name)}" data-lc-dupname data-lc-focus maxlength="40" />` +
        (d.refused ? note(`<p><b>The gateway didn't make the copy:</b> “agent "${esc(d.refused)}" already exists”. Nothing was made.</p>`, "danger") : "") +
        `<h4 class="b-group">Copied to it</h4>` +
        item("look", "Picture and label", "The picture the gateway has for it, and its label.") +
        item(
          "model",
          own ? "Model and effort, on an account you choose" : "Model, account and effort",
          own ? `${esc(a.label)} is kept by ${name} alone, so the copy can't use it.` : `${esc(D.acctName(a))}, ${esc(b.model || "")}, effort ${esc(b.effort || "")}.`,
        ) +
        (own && d.copy.model
          ? `<div class="b-choices lc-accounts" role="radiogroup" aria-label="Account for the copy">${shared
              .map((x) => `<button type="button" class="b-choice" role="radio" aria-checked="${d.acct === x.id}" tabindex="${d.acct === x.id || (!d.acct && x === shared[0]) ? 0 : -1}" data-lc-acct="${x.id}"><span class="b-choice-text"><span class="b-choice-title">${esc(D.acctTitle(x))}</span></span>${icon("check", "icon b-tick")}</button>`)
              .join("")}</div>`
          : "") +
        item("instr", "Instructions and personality", "AGENTS.md and SOUL.md, as they are now.") +
        item("tools", "Tool permissions and skills", "What it may do with its tools, and which skills it has.") +
        `<h4 class="b-group">Not copied</h4><ul class="lc-list">` +
        `<li>Its memory: ${esc(f.memory)}, and About you (USER.md)</li>` +
        `<li>Its ${f.tasks} tasks and their history</li>` +
        (f.routines.length ? `<li>Its ${f.routines.length === 1 ? "routine" : `${f.routines.length} routines`}: ${esc(f.routines.join(", "))}. A copy would run ${f.routines.length === 1 ? "it" : "them"} twice.</li>` : "") +
        `<li>The other files in its workspace folder</li>` +
        (f.routes ? `<li>Its channel route: messages keep going to ${name}</li>` : "") +
        (f.own.length || own ? `<li>Its own sign-ins (${esc((f.own.length ? f.own : ["Pip's key"]).join(", "))}), which only ${name} can use</li>` : "") +
        `<li>Approvals saved for its commands, and rules kept by Clawtrate's rules plugin</li></ul>` +
        `<p class="b-hint">The copy is a new bot with its own workspace folder. Nothing links it to ${name} afterwards: changing one doesn't change the other.</p>`,
      isAdmin()
        ? button("Duplicate", `data-lc="dup-go" data-size="lg"${d.name.trim() && (!own || !d.copy.model || d.acct) ? "" : " disabled"}`, "primary")
        : adminBar(`Duplicating ${name} needs admin access.`),
    );
  };

  function runDuplicate(retry) {
    const d = L.dialog;
    const refuse = d.kind === "import" ? p("impresult") === "taken" : p("dup") === "refused";
    if (!retry && refuse && !d.refusedOnce) {
      d.refusedOnce = true;
      d.refused = `${d.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      d.status = "sending";
      paint();
      setTimeout(() => {
        d.status = null;
        paint(true);
        announce(d.kind === "import" ? "The gateway didn't make the bot" : "The gateway didn't make the copy");
      }, 300);
      return;
    }
    d.refused = null;
    d.status = "working";
    d.busy = true;
    const total = 2 + ["look", "model", "instr", "tools"].filter((k) => d.copy[k]).length;
    d.at = retry ? total - 1 : 0;
    paint(true);
    const tick = () => {
      d.at += 1;
      if (d.at >= total) {
        d.busy = false;
        d.status = (d.kind === "import" ? p("impresult") : p("dup")) === "partial" && !retry && d.copy.instr ? "partial" : "done";
        if (!retry) {
          let nid = d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "copy";
          while (botOf(nid)) nid += "-2";
          d.newId = nid;
          CT.botArt[nid] = d.kind === "import" ? CT.botArt.__wren : d.copy.look ? CT.botArt[d.bot] || { body: "drop", color: "#ff6f9c", tilt: 0, look: [0.6, 0] } : { body: "pebble", color: "#9aa0a6", tilt: 0, look: [0.6, 0] };
          D.binding[nid] = d.kind === "import" ? { account: null, mode: "gateway", model: "gpt-5.5", effort: "Medium", locked: false } : { ...(D.binding[d.bot] || {}), ...(d.acct ? { account: d.acct } : {}), locked: false };
          FACTS[nid] = { folder: `workspace-${nid}`, files: 4, memory: "no memory yet", tasks: 0, routines: [], routes: 0, own: [] };
          app.bots.push({ id: nid, name: d.name.trim(), label: d.kind === "import" ? "Garden" : d.copy.look ? botOf(d.bot).label : "", tasks: [{ id: `${nid}-1`, title: "Main", at: 3000, when: "now", preview: "No messages yet.", unread: false, status: "idle", html: "", fresh: true }] });
          refreshRail();
        }
        paint(true);
        announce(d.status === "done" ? `${d.name.trim()} is ready` : `${d.name.trim()} was made, without its instructions`);
        if (d.kind === "import" && d.status === "done") INSTR[d.newId] = { agents: WREN().agents, soul: WREN().soul, at: "Nov 19, 5:46 PM" };
        return;
      }
      paint();
      setTimeout(tick, 220);
    };
    setTimeout(tick, 220);
  }

  // Export and import (section 9) ---------------------------------------------------------------------

  const cmdBlock = (text, what) => `<div class="command-line lc-command"><code>${CT.botsCmd(text)}</code>${copy(what, text)}</div>`;
  // How the gateway's list says each bot was made (agents.list createdVia): from a
  // package ("claw"), by the create method ("operator"), or no record.
  const VIA = { marlow: "claw", pip: "operator" };
  const NEVER = [
    "Memory and About you (MEMORY.md, notes, USER.md)",
    "Tasks and their transcripts",
    "Routines",
    "Any account, sign-in or secret",
    "Approvals and rules",
    "Channel routes",
    "Other files in the workspace folder",
  ];
  const neverList = () => `<ul class="lc-list">${NEVER.map((x) => `<li>${x}</li>`).join("")}</ul>`;
  const wayTabs = (d, words) =>
    `<div class="tabs lc-tabs" role="tablist" aria-label="Which way">${words
      .map(([t, label]) => `<button type="button" class="tab" role="tab" aria-selected="${t === d.way}" tabindex="${t === d.way ? 0 : -1}" data-lc-way="${t}">${label}</button>`)
      .join("")}</div>`;
  const fileName = (name) => `${name.replace(/[^A-Za-z0-9 _-]+/g, "").trim() || "bot"}.clawtrate-bot.json`;

  VIEWS.export = (d) => {
    const id = d.bot;
    const name = esc(nameOf(id));
    const tabs = wayTabs(d, [
      ["file", "Clawtrate file"],
      ["package", "Gateway package"],
    ]);
    if (d.way === "file") {
      const f = fileName(nameOf(id));
      const what =
        `<h3 class="lc-way-title">A Clawtrate file</h3>` +
        `<p class="b-hint lc-first">Clawtrate's own format: a JSON file this app writes and reads. The gateway doesn't know it, and other apps may not.</p>` +
        `<h4 class="b-group">It holds</h4><ul class="lc-list"><li>${name}'s picture and label</li><li>Its model and effort, by name</li><li>Its instructions and personality, AGENTS.md and SOUL.md, in full</li><li>Its tool permissions and skills</li></ul>` +
        `<h4 class="b-group">It never holds</h4>${neverList()}` +
        note(`<p><b>The file holds ${name}'s instructions in full</b>, and they may hold private text. Share it only with people who may read them.</p>`, "warn");
      if (d.exp === "saving") return sheet(`Export ${name}`, tabs + `<p class="b-wait" role="status"><span class="status-dot" data-status="connecting"></span>Reading ${name} from the gateway…</p>`, "");
      if (d.exp === "saved")
        return sheet(
          `Export ${name}`,
          tabs + `<div class="b-result"><span class="empty-mark">${icon("check")}</span><h3 tabindex="-1" data-lc-focus>Saved ${esc(f)}</h3><p>In Downloads on this computer, 16 KB. Nothing was sent anywhere.</p></div>`,
          button("Done", 'data-lc="close" data-size="lg"'),
        );
      if (d.exp === "readfail")
        return sheet(`Export ${name}`, tabs + what + note(`<p><b>Couldn't read ${name}'s instructions.</b> The gateway didn't answer. Nothing was saved.</p>`, "danger"), button("Try again", 'data-lc="export-file" data-size="lg" data-lc-focus', "primary"));
      if (d.exp === "toolarge")
        return sheet(`Export ${name}`, tabs + what + note(`<p><b>${name}'s file would be 5.4 MB.</b> A Clawtrate bot file holds at most 5 MB, so it wasn't saved. Its instructions are the large part.</p>`, "danger"), button("Close", 'data-lc="close" data-size="lg"'));
      return sheet(`Export ${name}`, tabs + what + `<p class="b-hint">You choose where to save it on this computer; it's named ${esc(f)}. Nothing is sent anywhere.</p>`, button("Export file…", 'data-lc="export-file" data-size="lg" data-lc-focus', "primary"));
    }
    const via = VIA[id];
    const exp = `OPENCLAW_EXPERIMENTAL_CLAWS=1 openclaw claws export ${id} --out ./${id}-claw`;
    const check = `OPENCLAW_EXPERIMENTAL_CLAWS=1 openclaw claws migrate ${id} --dry-run`;
    const body =
      `<h3 class="lc-way-title">The gateway's package</h3>` +
      (via === "claw"
        ? `<p class="b-lead">${name} was installed from a package, so the gateway can export it again with its own command line. Clawtrate can't make a package itself. On the gateway's machine:</p>` +
          cmdBlock(exp, "export command") +
          `<h4 class="b-group">The package holds</h4><ul class="lc-list"><li>${name}'s name, and the settings and files its package manages</li></ul>` +
          `<h4 class="b-group">It doesn't hold</h4><ul class="lc-list"><li>Its memory, its tasks and their transcripts</li><li>Sign-ins and keys</li><li>Its channel routes</li></ul>`
        : via === "operator"
          ? `<div class="b-result"><span class="empty-mark">${icon("warning")}</span><h3>The gateway can't export ${name}</h3><p>The gateway exports only bots installed from a package. ${name} was made with the gateway's create method, which gives it settings a package can't hold. A Clawtrate file can hold it.</p></div>`
          : `<div class="b-result"><span class="empty-mark">${icon("warning")}</span><h3>${name} isn't in a package</h3><p>The gateway exports only bots installed from a package. The gateway's owner can check whether the gateway would put ${name} in one, without changing anything:</p></div>` +
            cmdBlock(check, "check command") +
            `<p class="b-hint">If it can, the same command without <code>--dry-run</code> asks before it does; then the export command works.</p>`) +
      `<p class="b-hint">Packages are an experimental part of the gateway, switched on by the first word of each command; their format may change.</p>`;
    return sheet(`Export ${name}`, tabs + body, button("Done", 'data-lc="close" data-size="lg"'));
  };

  // The file a person chose, as the fixtures have it: Wren, from another gateway.
  const WREN = () => {
    const odd = p("imp") === "unavailable";
    return {
      name: "Wren",
      label: "Garden",
      model: odd ? "globex/atlas-2" : "openai/gpt-5.5",
      effort: "Medium",
      agents: "# Wren\n\nYou keep the garden calendar.\nAsk before ordering seeds.\nNever water on a rain day.\n",
      soul: "Patient and practical.\n",
      settings: [
        ["Model", odd ? "globex/atlas-2" : "openai/gpt-5.5", !odd],
        ["Effort", "Medium", odd ? "with-model" : true],
        ["Tools never allowed", "Run commands (exec)", true],
        ...(odd ? [["Tools also allowed", "Use the browser (browser)", false]] : []),
        ["Skills", "weather", true],
        ...(odd ? [["Skills", "trail-maps", false]] : []),
      ],
    };
  };
  CT.botArt.__wren = { body: "bloom", color: "#a5d955", tilt: 0, look: [0.6, 0] };

  VIEWS.import = (d) => {
    const tabs = wayTabs(d, [
      ["file", "Clawtrate file"],
      ["package", "Gateway package"],
    ]);
    if (d.way === "package") {
      const look = "OPENCLAW_EXPERIMENTAL_CLAWS=1 openclaw claws add ./pip-claw --dry-run";
      const add = "OPENCLAW_EXPERIMENTAL_CLAWS=1 openclaw claws add ./pip-claw --yes --plan-integrity <digest>";
      return sheet(
        "Import a bot",
        tabs +
          `<h3 class="lc-way-title">The gateway's package</h3>` +
          `<p class="b-lead">The gateway adds a bot from a package with its own command line. Clawtrate can't read a package or add one itself. On the gateway's machine:</p>` +
          `<ol class="b-steps lc-steps-cmd"><li><div><p>See what the package would create, without changing anything. The gateway lists the bot, its folder, every action and what it would need:</p>${cmdBlock(look, "review command")}</div></li>` +
          `<li><div><p>Add it, with the digest the first command printed. The gateway refuses if anything changed since:</p>${cmdBlock(add, "add command")}</div></li></ol>` +
          `<p class="b-hint">The new bot appears in your list when the gateway lists it. Packages are an experimental part of the gateway; their format may change.</p>`,
        button("Done", 'data-lc="close" data-size="lg"'),
      );
    }
    if (d.status === "working" || d.status === "done" || d.status === "partial") return stepsView(d);
    if (d.stage === "reading") return sheet("Import a bot", tabs + `<p class="b-wait" role="status"><span class="status-dot" data-status="connecting"></span>Reading wren.clawtrate-bot.json…</p>`, "");
    if (d.stage === "refused") {
      const why = {
        version: "<b>Clawtrate can't read this file.</b> Its format version is 3, and this version of Clawtrate reads version 1. Nothing was read as a bot.",
        size: "<b>Clawtrate can't read this file.</b> It is 6.2 MB, and a Clawtrate bot file holds at most 5 MB. Nothing was read as a bot.",
        type: "<b>Clawtrate can't read this file.</b> Its label is a number, not text. Nothing was read as a bot.",
      }[p("imp")];
      return sheet("Import a bot", tabs + note(`<p>${why}</p>`, "danger"), button("Choose another file…", 'data-lc="import-choose" data-size="lg" data-lc-focus', "primary"));
    }
    if (d.stage === "review") {
      const w = WREN();
      const left = w.settings.filter(([, , ok]) => ok === false);
      const writes = w.settings.filter(([, , ok]) => ok === true);
      const word = (ok) => (ok === true ? "Will be written" : ok === "with-model" ? "Left out with the model" : "Not available here, left out");
      const row = ([k, v, ok]) => `<li data-state="${ok === true ? "write" : "left"}"><span>${k}: ${esc(v)}</span><span class="lc-step-word">${word(ok)}</span></li>`;
      return sheet(
        "Add Wren?",
        tabs +
          `<span class="b-preview" role="img" aria-label="Wren's picture">${CT.character("__wren")}</span>` +
          `<label class="b-label" for="lc-imp-name">Name</label><input class="input lc-dup-name" id="lc-imp-name" value="${esc(d.name)}" data-lc-impname maxlength="40" />` +
          (d.refused ? note(`<p><b>The gateway didn't make the bot:</b> “agent "${esc(d.refused)}" already exists”. Nothing was made.</p>`, "danger") : "") +
          `<p class="b-hint lc-center">Label: ${esc(w.label)} · from wren.clawtrate-bot.json, written by Clawtrate 0.4.0</p>` +
          note(`<p>This file is someone's text. Clawtrate shows it here and doesn't run it; nothing is created until Add Bot.</p>`) +
          `<details class="lc-review" data-lc-row="agents"><summary>Instructions · AGENTS.md <span class="b-faint">· ${lines(w.agents)} lines, in full</span></summary><pre class="lc-theirs">${esc(w.agents)}</pre></details>` +
          `<details class="lc-review" data-lc-row="soul"><summary>Personality · SOUL.md <span class="b-faint">· ${lines(w.soul)} line, in full</span></summary><pre class="lc-theirs">${esc(w.soul)}</pre></details>` +
          `<details class="lc-review" data-lc-row="settings"><summary>Settings <span class="b-faint">· ${writes.length} to write${left.length ? `, ${left.length} not available here` : ""}</span></summary><ul class="lc-result lc-settings">${w.settings.map(row).join("")}</ul>` +
          (left.some(([k]) => k === "Model") ? `<p class="b-hint">With its model left out, Wren uses the gateway's default model until you choose one, and its effort is left out with it.</p>` : "") +
          `</details>` +
          `<details class="lc-review" data-lc-row="never"><summary>Not created <span class="b-faint">· a Clawtrate file never carries these</span></summary>${neverList()}</details>`,
        isAdmin() ? button("Add Bot", `data-lc="import-add" data-size="lg"${d.name.trim() ? "" : " disabled"}`, "primary") : adminBar("Adding a bot needs admin access."),
      );
    }
    return sheet(
      "Import a bot",
      tabs +
        `<h3 class="lc-way-title">A Clawtrate file</h3>` +
        `<p class="b-lead">Choose a file another Clawtrate exported. You'll see everything it would create before anything is.</p>` +
        `<div class="lc-drop" data-lc-drop><span class="empty-mark">${icon("file")}</span><p>Drop a .clawtrate-bot.json file here</p>${button("Choose file…", 'data-lc="import-choose" data-size="sm" data-lc-focus')}<p class="b-hint">At most 5 MB.</p></div>`,
      "",
    );
  };

  // Duplicate's steps, shared with Import: the same writes, each read back.
  function stepsView(d) {
    const from = d.kind === "import" ? null : esc(nameOf(d.bot));
    const steps = [
      ["made", `Made ${esc(d.name)}`],
      ["look", "Picture and label"],
      ["model", d.kind === "import" ? "Model and effort" : "Model, account and effort"],
      ["instr", "Instructions and personality"],
      ["tools", "Tool permissions and skills"],
      ["read", `Read back ${esc(d.name)} from the gateway`],
    ].filter(([k]) => k === "made" || k === "read" || d.copy[k]);
    const at = d.at ?? 0;
    const row = ([k, label], i) => {
      const failed = d.status === "partial" && k === "instr";
      const state = failed ? "failed" : i < at || d.status !== "working" ? "done" : i === at ? "running" : "queued";
      const word = { done: "Done", running: "Working", queued: "Waiting", failed: d.kind === "import" ? "Not written" : "Not copied" }[state];
      return `<li data-state="${state}">${glyph(state === "done" ? "done" : state === "failed" ? "failed" : state === "running" ? "sending" : "queued")}<span>${label}</span><span class="lc-step-word">${word}</span></li>`;
    };
    const list = `<ol class="lc-steps" aria-label="Progress">${steps.map(row).join("")}</ol>`;
    if (d.status === "working") return sheet(d.kind === "import" ? `Adding ${esc(d.name)}` : `Duplicating ${from}`, list, "");
    if (d.status === "done")
      return sheet(
        `${esc(d.name)} is ready`,
        list +
          (d.kind === "import"
            ? `<p class="b-hint">Read back from the gateway: ${esc(d.name)} is listed with what the review said would be written. It's a new bot with its own workspace folder.</p>`
            : `<p class="b-hint">Read back from the gateway: ${esc(d.name)} is listed with what's ticked above. It's a new bot with its own workspace folder; nothing links it to ${from}.</p>`),
        button(`Open ${esc(d.name)}`, 'data-lc="dup-open" data-size="lg" data-lc-focus', "primary"),
      );
    return sheet(
      d.kind === "import" ? `${esc(d.name)} was made, without its instructions` : `${esc(d.name)} was made, without ${from}'s instructions`,
      list + note(`<p><b>Its instructions weren't ${d.kind === "import" ? "written" : "copied"}:</b> the gateway didn't answer. ${esc(d.name)} has the gateway's starting AGENTS.md and SOUL.md.</p>`, "danger"),
      button("Try again", 'data-lc="dup-retry" data-size="lg" data-lc-focus', "primary") + button("Leave it as it is", 'data-lc="dup-open" data-size="lg"', "quiet"),
    );
  }

  // Delete (section 10) ---------------------------------------------------------------------------------

  VIEWS.delete = (d) => {
    const id = d.bot;
    // Named as it was when the dialog opened: afterwards the list no longer has it.
    const name = esc((d.botName ??= nameOf(id)));
    const f = FACTS[id];
    const share = sharers(id);
    if (d.read === "loading")
      return sheet(`Delete ${name}?`, `<p class="b-wait" role="status"><span class="status-dot" data-status="connecting"></span>Reading what ${name} has on the gateway…</p>`, button("Cancel", 'data-lc="close" data-size="lg"', "quiet"));
    if (d.read === "failed")
      return sheet(
        `Delete ${name}?`,
        note(`<p><b>Couldn't read what ${name} has.</b> The gateway didn't answer. Clawtrate doesn't delete a bot without saying what goes.</p>`, "danger"),
        button("Try again", 'data-lc="del-reread" data-size="lg" data-lc-focus', "primary") + button("Cancel", 'data-lc="close" data-size="lg"', "quiet"),
      );
    if (d.status === "deleting") return sheet(`Deleting ${name}`, `<p class="b-wait" role="status"><span class="status-dot" data-status="connecting"></span>Deleting ${name}…</p>`, "");
    if (d.status === "refused")
      return sheet(
        `The gateway didn't delete ${name}`,
        note(`<p>The gateway answered: “Agent "${id}" owns inherited credentials through agents.defaults.authInheritance.agentId and cannot be deleted.” Nothing was removed.</p>`, "danger") +
          `<p class="b-hint">Other bots use sign-ins kept in ${name}'s folder. The gateway's owner moves them first, on the gateway's machine.</p>`,
        button("Close", 'data-lc="close" data-size="lg" data-lc-focus'),
      );
    if (d.status === "done" || d.status === "partial" || d.status === "uncertain") {
      const ok = (t) => `<li data-state="done">${glyph("done")}<span>${t}</span></li>`;
      const bad = (t) => `<li data-state="failed">${glyph("failed")}<span>${t}</span></li>`;
      const unknown = (t) => `<li data-state="unknown">${glyph("queued")}<span>${t}</span></li>`;
      let rows = ok(`No longer in the gateway's list of bots`) + ok(`No tasks of ${name}'s listed`) + (f.routines.length ? ok(`No routines of ${name}'s`) : "");
      if (d.status === "uncertain") rows += unknown(`What happened to its folders: the gateway's answer was lost`);
      else if (!d.files) rows += ok(`Its folders stay on the gateway's machine, as asked`);
      else if (d.status === "partial") rows += ok(`Its own folder and its tasks' transcripts moved to the Trash`) + bad(`${esc(f.folder)} wasn't moved: permission denied. It's still on the gateway's machine.`);
      else rows += ok(share.length ? `Its own folder and its tasks' transcripts moved to the Trash; ${esc(f.folder)} stays for ${esc(share.join(", "))}` : `Its workspace folder, its own folder and its tasks' transcripts moved to the Trash`);
      const trashLine = d.files && d.status !== "uncertain" ? `<p class="b-hint">What was moved to the Trash on the gateway's machine can be restored from there until it's emptied.</p>` : "";
      const title = d.status === "done" ? `${name} was deleted` : d.status === "partial" ? `${name} was deleted, but one folder is still there` : `${name} is no longer listed`;
      return sheet(
        title,
        `<p class="b-hint lc-first">Read back from the gateway just now:</p><ul class="lc-result" aria-label="What the gateway has now">${rows}</ul>` +
          trashLine +
          (d.status === "uncertain" ? `<p class="b-hint">Trying again finishes the same delete: the gateway keeps a record of it until it's complete.</p>` : "") +
          (d.status === "partial" ? `<p class="b-hint">Trying again moves what's left. The gateway keeps a record of the delete until it's complete.</p>` : ""),
        d.status === "done"
          ? button("Close", 'data-lc="close" data-size="lg" data-lc-focus')
          : button("Try again", 'data-lc="del-retry" data-size="lg" data-lc-focus', "primary") + button(d.status === "partial" ? "Leave it" : "Close", 'data-lc="close" data-size="lg"', "quiet"),
      );
    }
    const workspaceLine = share.length
      ? `<li data-state="stays"><span>Its workspace folder, ${esc(f.folder)}, stays: also used by ${esc(share.join(" and "))}.</span></li>`
      : `<li><span>Its workspace folder, ${esc(f.folder)}: ${f.files} files, its memory among them (${esc(f.memory)})</span></li>`;
    return sheet(
      `Delete ${name}?`,
      `<h4 class="b-group">Removed from the gateway</h4><ul class="lc-list">` +
        `<li>${name}'s settings${f.routes ? `, and its channel route: messages on it go to the gateway's default bot` : ""}</li>` +
        `<li>Its ${f.tasks} tasks, from every task list</li>` +
        (f.routines.length ? `<li>Its ${f.routines.length === 1 ? "routine" : `${f.routines.length} routines`}: ${esc(f.routines.join(", "))}</li>` : "") +
        `<li>Approvals saved for its commands</li></ul>` +
        `<label class="b-check lc-files"><input type="checkbox" data-lc-files${d.files ? " checked" : ""} /><span>Also move ${name}'s folders to the Trash on the gateway's machine</span></label>` +
        `<p class="b-hint lc-files-hint">They can be restored from that Trash, on the gateway's machine, until it's emptied.</p>` +
        `<ul class="lc-list lc-folders" data-on="${Boolean(d.files)}">${workspaceLine}<li><span>Its own folder${f.own.length ? `, with the sign-ins only ${name} uses (${esc(f.own.join(", "))})` : ""}</span></li><li><span>Its tasks' transcripts</span></li></ul>` +
        `<h4 class="b-group">Stays</h4><ul class="lc-list">` +
        (d.files ? "" : `<li>All three folders above, where they are now</li>`) +
        `<li>Accounts other bots use, and shared memory</li><li>What ${name} said in other bots' tasks</li><li>Anything in the Trash, until it's emptied there</li></ul>` +
        `<p class="b-hint">This can't be undone from Clawtrate.</p>`,
      button("Cancel", 'data-lc="close" data-size="lg" data-lc-focus', "quiet") + button(`Delete ${name}`, 'data-lc="del-go" data-size="lg" data-tone="danger"'),
    );
  };

  function runDelete(retry) {
    const d = L.dialog;
    d.status = "deleting";
    d.busy = true;
    paint(true);
    setTimeout(() => {
      d.busy = false;
      const want = p("delresult");
      if (!retry && want === "refused") d.status = "refused";
      else if (!retry && want === "uncertain") d.status = "uncertain";
      else if (!retry && want === "partial" && d.files) d.status = "partial";
      else d.status = "done";
      if (d.status !== "refused" && botOf(d.bot)) {
        const i = app.bots.findIndex((b) => b.id === d.bot);
        app.bots.splice(i, 1);
        if (L.primary === d.bot) L.primary = null;
        if (app.model.selectedBot === d.bot) app.selectBot(app.bots[0].id);
        else refreshRail();
      }
      paint(true);
      announce(d.status === "done" ? `${d.botName} was deleted` : d.status === "refused" ? "The gateway didn't delete it" : d.status === "partial" ? "Deleted, with one folder left" : "No longer listed");
    }, 600);
  }

  // Wiring -----------------------------------------------------------------------------------------------

  const closeRailMenu = () => {
    const menu = $("#rail-menu");
    if (!menu.hidden) menu.hidden = true;
  };
  document.addEventListener("click", (event) => {
    const t = event.target;
    const pick = t.closest("[data-lc-pick]");
    if (pick && L.dialog?.kind === "choose") {
      if (B.access === "read") return;
      L.dialog.pick = pick.dataset.lcPick;
      if (L.dialog.status === "failed") L.dialog.status = null;
      paint();
      $(`[data-lc-pick="${L.dialog.pick}"]`, dialog)?.focus();
      return;
    }
    const way = t.closest("[data-lc-way]");
    if (way) {
      L.dialog.way = way.dataset.lcWay;
      paint();
      $(`[data-lc-way="${L.dialog.way}"]`, dialog).focus();
      return;
    }
    const tab = t.closest("[data-lc-tab]");
    if (tab) {
      L.dialog.tab = tab.dataset.lcTab;
      L.dialog.status = null;
      paint();
      $(`[data-lc-tab="${L.dialog.tab}"]`, dialog).focus();
      return;
    }
    const body = t.closest("[data-lc-body]");
    if (body) {
      L.dialog.body = body.dataset.lcBody;
      paint();
      $(`[data-lc-body="${L.dialog.body}"]`, dialog).focus();
      return;
    }
    const color = t.closest("[data-lc-color]");
    if (color) {
      L.dialog.color = color.dataset.lcColor;
      paint();
      $(`[data-lc-color="${L.dialog.color}"]`, dialog).focus();
      return;
    }
    const acctPick = t.closest("[data-lc-acct]");
    if (acctPick) {
      L.dialog.acct = acctPick.dataset.lcAcct;
      paint();
      $(`[data-lc-acct="${L.dialog.acct}"]`, dialog).focus();
      return;
    }
    const el = t.closest("[data-lc]");
    if (!el || el.disabled) return;
    const action = el.dataset.lc;
    const bot = el.dataset.lcBot || p("delbot") || app.model.selectedBot;
    if (el.closest("#rail-menu")) closeRailMenu();
    switch (action) {
      case "close":
        return closeDialog();
      case "open-choose":
        return L.dialog?.kind === "intro" ? ((L.dialog = { kind: "choose", from: "intro" }), paint(true)) : openDialog("choose", el.closest("#rail-menu") ? $(`#bot-list .bot[data-bot="${bot}"]`) : el);
      case "back-intro":
        L.dialog = { kind: "intro" };
        return paint(true);
      case "intro-later":
        // users.prefs: {bot: null}, "keep the gateway's default", so the dialog doesn't come back.
        L.primary = null;
        closeDialog();
        return announce(`${nameOf(GATEWAY_DEFAULT)} keeps the star, as the gateway's default bot`);
      case "create-primary":
        L.createPrimary = app.bots.length;
        closeDialog();
        return D.openCreate($("#new-button"));
      case "make-primary":
        if (B.access === "read") return;
        L.dialog = { kind: "choose", pick: bot };
        L.opener = el.closest("#rail-menu") ? $(`#bot-list .bot[data-bot="${bot}"]`) : el;
        return savePrimary(bot);
      case "confirm-primary":
        return savePrimary(L.dialog.pick || primaryId());
      case "open-picture":
        return openDialog("picture", el, { bot: app.model.selectedBot, tab: p("ptab") || "bot", upload: p("upload") || null });
      case "browse":
        L.dialog.upload = "crop";
        paint();
        return $('[data-lc="set-picture"]', dialog)?.focus();
      case "set-picture":
        return setPicture();
      case "edit-name":
        return startEdit("name");
      case "edit-label":
        return startEdit("label");
      case "rename-rail":
        return setTimeout(() => renameInRail(bot), 0);
      case "instr-save":
        return saveInstructions(false);
      case "instr-mine":
        return saveInstructions(true);
      case "instr-theirs":
        I.mode = null;
        I.draft = null;
        Object.assign(instr(app.model.selectedBot), { agents: instr(app.model.selectedBot).agents.replace("Cite every source you use.", "Cite every source you use, with its date.") });
        CT.botsRender();
        return announce("Showing the gateway's copy");
      case "open-instructions":
        return CT.botsOpenSettings("juniper", "instructions");
      case "role-keep":
        R.state = "kept";
        roleLine();
        return announce("Accepted");
      case "role-undo":
        R.state = "undoing";
        roleLine();
        return setTimeout(() => {
          // agents.files.set {content: Clawtrate's copy, expectedHash: the file's hash now}, then agents.files.get.
          R.state = p("undo") === "conflict" ? "conflict" : "undone";
          roleLine();
          announce(R.state === "undone" ? "Undone" : "Nothing was undone");
        }, 450);
      case "open-duplicate":
        return openDialog("duplicate", el.closest("#rail-menu") ? $(`#bot-list .bot[data-bot="${bot}"]`) : el, { bot, name: `${nameOf(bot)} copy`, copy: { look: true, model: true, instr: true, tools: true }, acct: null });
      case "dup-go":
        return runDuplicate(false);
      case "dup-retry":
        return runDuplicate(true);
      case "dup-open": {
        const nid = L.dialog.newId;
        closeDialog();
        return app.selectBot(nid);
      }
      case "open-export":
        return openDialog("export", el.closest("#rail-menu") ? $(`#bot-list .bot[data-bot="${bot}"]`) : el, { bot, way: "file", exp: null });
      case "open-import":
        return openDialog("import", $("#new-button"), { kind: "import", way: "file", stage: null, name: "Wren", copy: { look: true, model: true, instr: true, tools: true } });
      case "open-delete":
        return openDialog("delete", el.closest("#rail-menu") ? $(`#bot-list .bot[data-bot="${bot}"]`) : el, { bot, files: Boolean(p("files")), read: p("delread") || null });
      case "export-file":
        L.dialog.exp = "saving";
        paint();
        return setTimeout(() => {
          // agents.list, config.get and agents.files.get, then the host's save dialog.
          L.dialog.exp = p("exp") === "readfail" && !L.dialog.retried ? ((L.dialog.retried = true), "readfail") : p("exp") === "toolarge" ? "toolarge" : "saved";
          paint(true);
          announce(L.dialog.exp === "saved" ? `Saved ${fileName(nameOf(L.dialog.bot))}` : L.dialog.exp === "readfail" ? "Nothing was saved" : "Too large to save");
        }, 450);
      case "import-choose":
        L.dialog.stage = "reading";
        L.dialog.refused = null;
        paint();
        return setTimeout(() => {
          L.dialog.stage = ["version", "size", "type"].includes(p("imp")) && !L.dialog.triedOther ? ((L.dialog.triedOther = true), "refused") : "review";
          paint(true);
          announce(L.dialog.stage === "review" ? "Showing what the file would create" : "Clawtrate can't read this file");
        }, 400);
      case "import-add":
        return runDuplicate(false);
      case "del-reread":
        L.dialog.read = null;
        return paint(true);
      case "del-go":
        return runDelete(false);
      case "del-retry":
        return runDelete(true);
    }
  });
  document.addEventListener("change", (e) => {
    const c = e.target.closest("[data-lc-copy]");
    if (c) {
      L.dialog.copy[c.dataset.lcCopy] = c.checked;
      paint();
      $(`[data-lc-copy="${c.dataset.lcCopy}"]`, dialog)?.focus();
    }
    if (e.target.closest("[data-lc-files]")) {
      L.dialog.files = e.target.checked;
      paint();
      $("[data-lc-files]", dialog)?.focus();
    }
  });
  dialog.addEventListener("input", (e) => {
    if (e.target.closest("[data-lc-impname]")) {
      L.dialog.name = e.target.value;
      const go = $('[data-lc="import-add"]', dialog);
      if (go) go.disabled = !e.target.value.trim();
    }
    if (e.target.closest("[data-lc-dupname]")) {
      L.dialog.name = e.target.value;
      const go = $('[data-lc="dup-go"]', dialog);
      if (go) go.disabled = !e.target.value.trim();
    }
  });
  // Arrow keys in the dialog's radio groups and tabs: one tab stop, arrows move and choose.
  dialog.addEventListener("keydown", (e) => {
    const r = e.target.closest('[role="radio"], [role="tab"]');
    if (!r || !["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const group = [...r.parentElement.closest('[role="radiogroup"], [role="tablist"]').querySelectorAll('[role="radio"], [role="tab"]')];
    const i = group.indexOf(r);
    const n = e.key === "Home" ? 0 : e.key === "End" ? group.length - 1 : (i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1) + group.length) % group.length;
    e.preventDefault();
    group[n].click();
  });
  // A bot made from "Create primary bot" becomes the primary bot once the gateway lists it.
  $("#create-dialog").addEventListener("close", () => {
    if (L.createPrimary === undefined) return;
    const made = app.bots.length > L.createPrimary ? app.bots.at(-1).id : null;
    delete L.createPrimary;
    if (made) {
      L.dialog = { kind: "choose", pick: made };
      L.opener = null;
      savePrimary(made);
    }
  });
  // "Import a bot…" in the "+" menu.
  new MutationObserver(() => {
    const menu = $("#rail-menu");
    if (menu.hidden || $('[data-lc="open-import"]', menu) || !$('[data-action="new-bot"]', menu)) return;
    $('[data-action="new-bot"]', menu).closest("li").insertAdjacentHTML("afterend", `<li role="none"><button type="button" class="menu-item" role="menuitem" data-lc="open-import">Import a bot…</button></li>`);
  }).observe($("#rail-menu"), { attributes: true, attributeFilter: ["hidden"] });

  // First paint: a dialog from the address.
  refreshRail();
  decorateHero();
  roleLine();
  const start = p("lc");
  if (start === "intro") openDialog("intro", $("#bot-list .bot"));
  if (start === "choose") openDialog("choose", $("#bot-list .bot"));
  if (start === "picture") openDialog("picture", $(".lc-hero-pic") || hero, { bot: app.model.selectedBot, tab: p("ptab") || "bot", upload: p("upload") || null });
  if (start === "duplicate") openDialog("duplicate", null, { bot: p("delbot") || app.model.selectedBot, name: `${nameOf(p("delbot") || app.model.selectedBot)} copy`, copy: { look: true, model: true, instr: true, tools: true }, acct: null });
  if (start === "export") openDialog("export", null, { bot: p("delbot") || app.model.selectedBot, way: p("way") || "file", exp: null });
  if (start === "import") openDialog("import", $("#new-button"), { kind: "import", way: p("way") || "file", stage: p("imp") ? "reading" : null, name: "Wren", copy: { look: true, model: true, instr: true, tools: true } });
  if (start === "import" && p("imp")) setTimeout(() => { L.dialog.stage = ["version", "size", "type"].includes(p("imp")) ? ((L.dialog.triedOther = true), "refused") : "review"; paint(); }, 0);
  if (start === "delete") openDialog("delete", null, { bot: p("delbot") || app.model.selectedBot, files: Boolean(p("files")), read: p("delread") || null });
})();
