// The rest of a bot's life (docs/design/bots-lifecycle.md), on top of bots.js
// and bot-settings.js: the primary bot, the picture editor, the name and label
// in place, instructions, a file tool naming the instructions in the conversation, duplicate, export,
// import and delete. Every gateway answer here is a local fixture; each state
// says only what its fixture "read back".
//
// More address parameters, on top of bots.html's:
//   lc=intro|choose|picture|duplicate|export|import|delete   a dialog to open
//   primary=<id>        the primary bot Clawtrate has stored for this person
//   prefs=device        the gateway keeps no preferences for this connection
//   primfail=1          saving the primary bot fails
//   ptab=bot|generate|upload   the picture editor's tab
//   imagetool=1|unknown|unlisted|unavailable|unreadable  offered; no task to ask about; not listed; listed as unavailable; the inventory unreadable
//   platform=desktop|web|iphone   where the app runs (apart from the frame's width); pictures=checked: the desktop's two checks passed
//   outside=1|http|scheme|baddata Marlow's picture is at an https address, or one the rule refuses
//   outside=1|http      Marlow's picture is at an https (or http) address
//   upload=crop|toolarge|notimage   the Upload tab with a file chosen
//   picfail=1|dropped   the gateway refuses the picture, or takes it and its list shows none
//   edit=name|label     the hero's name or label open for editing
//   namefail=1          the gateway refuses the rename
//   bview=instructions  the Instructions page (instr=conflict: the file changed meanwhile)
//   rolechange=1        Juniper's open task shows a file tool named AGENTS.md, and its modification time
//   delbot=<id>         the bot the Delete or Duplicate dialog is for (default: the open bot)
//   shared=1            Pip's workspace folder is also Juniper's
//   files=1             Delete's folder option ticked
//   delread=loading|failed   reading what the bot has
//   delresult=partial|multi|purge|readfail|refused|uncertain   how the delete ends
//   delreplaced=1       the bot is replaced (same id, another creation record) before Delete
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
  // Each bot's creation record (agents.list createdAt); null where the gateway keeps none (nocreated=<id>).
  const CREATED = { juniper: 1763000000000, marlow: 1763100000000, otto: 1763200000000, pip: 1763300000000 };
  if (p("nocreated")) CREATED[p("nocreated")] = null;
  const L = {
    primary: p("primary") || null, // what users.prefs holds for this profile: {bot, createdAt}; null: nothing stored
    deviceOnly: p("prefs") === "device",
    dialog: null,
    opener: null,
  };
  // Bots whose picture is at an outside address (agents.list identity.avatarUrl).
  // Under the remote-content rule the character is drawn until the person allows
  // that bot's picture at that exact address, on this device; only https can be.
  const OUTSIDE = {};
  if (p("outside") === "1") OUTSIDE.marlow = "https://pictures.example/marlow.png";
  if (p("outside") === "http") OUTSIDE.marlow = "http://pictures.example/marlow.png";
  if (p("outside") === "scheme") OUTSIDE.marlow = "ftp://pictures.example/marlow.png";
  if (p("outside") === "baddata") OUTSIDE.marlow = "data:image/svg+xml;base64,PHN2Zy8+";
  L.outsidePicture = (id) => OUTSIDE[id] || null;
  // Only the desktop can hold the choice (decisions.md): the web preview and the iPhone never load one.
  // The platform is its own fixture, apart from the frame's width: desktop (the default), web or iphone.
  // Only the desktop can hold the choice, and only once both of its checks pass (pictures=checked).
  const PLATFORM = p("platform") || "desktop";
  const loadsOutside = () => PLATFORM === "desktop" && p("pictures") === "checked";
  L.allowed = {}; // bot id -> the exact address allowed on this device
  const pictureShown = (id) => (OUTSIDE[id] ? L.allowed[id] === OUTSIDE[id] : false);
  // Draw an allowed outside picture wherever the bot's avatar appears; the rest stay the character.
  function paintAllowed(root = document) {
    for (const id of Object.keys(OUTSIDE))
      $$(`.avatar[data-bot="${id}"]`, root).forEach((el) => {
        if (pictureShown(id)) {
          el.dataset.photo = "true";
          el.style.backgroundImage = PHOTO_OUTSIDE;
        }
      });
  }
  // A stored choice applies only to a listed bot with its id and the same, non-null
  // creation record. A bot made later under that id, or one with no record, is not it.
  L.primaryCreated = L.primary ? (CREATED[L.primary] ?? null) : null;
  if (p("primary") === "reused") (L.primary = "pip"), (L.primaryCreated = CREATED.pip - 86400000);
  const storedValid = () => Boolean(L.primary && botOf(L.primary) && CREATED[L.primary] != null && L.primaryCreated === CREATED[L.primary]);
  const unmatched = () => Boolean(L.primary) && !storedValid();
  const primaryId = () => (storedValid() ? L.primary : botOf(GATEWAY_DEFAULT) ? GATEWAY_DEFAULT : app.bots[0]?.id);
  // The primary bot comes first in its rail group, pinned or not; the others keep their order.
  CT.railOrder = (list) => {
    const id = primaryId();
    const at = list.findIndex((b) => b.id === id);
    return at > 0 ? [list[at], ...list.slice(0, at), ...list.slice(at + 1)] : list;
  };
  // What a delete or a copy reads at that moment: each bot's workspace folder,
  // its tasks, its routines, its channel routes, its memory files.
  const FACTS = {
    juniper: { folder: "workspace-juniper", files: 31, memory: "MEMORY.md and 5 notes", tasks: 6, routines: [], routes: 0, own: [] },
    marlow: { folder: "workspace-marlow", files: 18, memory: "MEMORY.md and 2 notes", tasks: 4, routines: ["Friday newsletter"], routes: 0, own: [] },
    otto: { folder: "workspace-otto", files: 44, memory: "MEMORY.md and 3 notes", tasks: 14, routines: ["Nightly disk check", "Monday backups"], routes: 1, own: [] },
    pip: { folder: "workspace-pip", files: 23, memory: "MEMORY.md and 3 notes", tasks: 4, routines: ["Weekly plan", "Sunday reminder"], routes: 0, own: ["Pip's key"] },
  };
  if (p("shared")) FACTS.pip.folder = FACTS.juniper.folder;
  // A delete compares each bot's creation record (CREATED, above) with the preview's.
  // Every gateway write the prototype sends, for the checks: [method, bot].
  L.calls = [];
  CT.lifecycleCalls = () => L.calls.slice();
  const sharers = (id) => app.bots.filter((b) => b.id !== id && FACTS[b.id] && FACTS[id] && FACTS[b.id].folder === FACTS[id].folder).map((b) => b.name);
  const INSTR = {
    juniper: { agents: "# Juniper\n\nYou research questions for the household.\nCite every source you use.\nKeep answers under 300 words.\n", soul: "Curious, careful, plain-spoken.\n", at: "Nov 17, 5:38 PM" },
  };
  const instr = (id) => (INSTR[id] ??= { agents: `# ${nameOf(id)}\n\nYou help with ${(botOf(id)?.label || "everyday tasks").toLowerCase()}.\n`, soul: "Calm and brief.\n", at: "Nov 16, 9:12 AM" });
  const lines = (text) => text.replace(/\n$/, "").split("\n").length;

  // The primary bot's star, in the rail and on a pinned tile ---------------------------------------

  CT.railStar = (b) => (b.id === primaryId() ? `<span class="lc-star" role="img" aria-label="Primary bot" title="Primary bot">${starSvg}</span>` : "");
  const starSvg = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.3l1.38 2.8 3.09.45-2.24 2.18.53 3.08L6 8.35 3.24 9.8l.53-3.08L1.53 4.55l3.09-.45z" fill="currentColor"/></svg>`;
  const refreshRail = () => (app.openTask(app.model.selectedBot, app.model.selectedTask), paintAllowed());

  // A bot's menu: Duplicate, Export and Delete, or Replace for the primary bot.
  CT.railMenuExtra = (b, item) => {
    // Export only reads, so a read-only connection has it too.
    if (!isAdmin() && B.access !== "write") return `<li class="menu-rule" role="separator"></li>` + item("Export…", `data-lc="open-export" data-lc-bot="${b.id}"`);
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
    // A confirmation that removes something is an alertdialog, named by its title and described by its first list.
    if (d.kind === "delete" && !d.read && !d.status) dialog.setAttribute("role", "alertdialog");
    else dialog.removeAttribute("role");
    const view = VIEWS[d.kind](d);
    dialog.innerHTML = view;
    CT.hydrate(dialog);
    paintAllowed(dialog);
    if (focus) requestAnimationFrame(() => ($("[data-lc-focus]", dialog) || $("#lc-title", dialog))?.focus());
  }

  const VIEWS = {};

  // The primary bot (section 3) ---------------------------------------------------------------------

  const keptLine = () =>
    L.deviceOnly
      ? `<p class="b-hint" data-lc-kept>This device only: this connection has no profile on the gateway to keep it in, so your other devices won't show it.</p>`
      : `<p class="b-hint" data-lc-kept>This saves a Clawtrate preference for the current gateway profile. Devices using that profile see the same choice. Clawtrate's preference leaves the gateway's routing settings as they are.</p>`;

  VIEWS.intro = () =>
    sheet(
      "Introducing the primary bot",
      `<span class="lc-intro-art" aria-hidden="true"><span class="avatar" data-bot="${primaryId()}"></span><span class="lc-star">${starSvg}</span></span>` +
        `<p class="b-lead">Your primary bot has a star and comes first in its part of your list: first among your pins if you pinned it, otherwise first after them. It's the bot Clawtrate offers when you share something into the app.</p>` +
        `<p class="b-lead">${esc(nameOf(GATEWAY_DEFAULT))} has the star until you choose: it's the gateway's default bot.</p>` +
        keptLine(),
      button("Use an existing bot", 'data-lc="open-choose" data-lc-focus data-size="lg"', "primary") +
        (isAdmin() ? button("Create primary bot", 'data-lc="create-primary" data-size="lg"') : "") +
        button("Not now", 'data-lc="intro-later" data-size="lg"', "quiet") +
        (B.access === "read" ? writeBar() : ""),
    );

  const writeBar = () =>
    `<section class="access-bar" role="region" aria-label="Access" data-state="none"><div class="access-row">${icon("eye")}<span class="shelf-text"><b>Read-only.</b> Choosing a primary bot needs the interactive tier: it saves a preference on the gateway.</span>${button("Request access", 'data-b="request-write" data-size="sm"', "primary")}</div></section>`;

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
    // A bot the gateway keeps no creation record for can't be kept as the primary bot.
    const noRecord = pick !== current && CREATED[pick] == null;
    return sheet(
      "Choose a primary bot",
      `<label class="visually-hidden" for="lc-search">Search bots</label><input class="input lc-search" id="lc-search" placeholder="Search" autocomplete="off" value="${esc(d.query || "")}" data-lc-focus />` +
        `<ul class="b-choices lc-bots" role="radiogroup" aria-label="Bots">${rows || `<li class="b-hint">No bot matches.</li>`}</ul>` +
        (d.status === "unconfirmed"
          ? `<p class="b-wait" role="status"><span class="status-dot" data-status="connecting"></span>Couldn't confirm your choice. Reading it again…</p>`
          : d.status === "noread"
            ? note(`<p><b>Couldn't confirm your choice.</b> Check again only reads the saved choice.</p>`, "danger")
          : d.status === "failed"
            ? note(`<p>The gateway still has ${esc(nameOf(current))} as primary.</p>`, "danger")
          : d.status === "conflict"
            ? note(`<p>The gateway now has ${esc(nameOf(d.theirs))} as primary. Confirm to choose ${esc(nameOf(pick))}.</p>`, "warn")
            : "") +
        (noRecord ? note(`<p data-lc-norecord>The gateway provides no creation record for this bot, so Clawtrate can't keep it as your primary bot.</p>`, "warn") : "") +
        (unmatched() ? note(`<p>Clawtrate couldn't match your saved choice to a bot in the gateway's current list.</p>`, "warn") : "") +
        keptLine() +
        `<p class="b-hint">The gateway's own default bot stays ${esc(nameOf(GATEWAY_DEFAULT))}. Clawtrate doesn't change it: the gateway uses it for messages no route claims.</p>`,
      B.access === "read"
        ? writeBar()
        : button(busy ? "Saving…" : d.status === "failed" ? "Try again" : d.status === "noread" ? "Check again" : "Confirm", `data-lc="confirm-primary" data-size="lg"${(pick === current && d.status !== "conflict" && d.status !== "failed" && d.status !== "noread") || d.status === "unconfirmed" || noRecord ? " disabled" : ""}${busy ? ' aria-busy="true" disabled' : ""}`, "primary"),
      d.from === "intro" ? "back-intro" : "",
    );
  };

  function savePrimary(id) {
    const d = L.dialog;
    d.status = "saving";
    paint();
    // users.prefs.set with expectedEntries: the entry the chooser read. Then users.prefs.get.
    L.calls.push(["users.prefs.set", id, { expectedEntries: { "clawtrate.primary": L.primary ? { bot: L.primary, createdAt: L.primaryCreated } : null } }]);
    setTimeout(() => {
      // users.prefs.set, then users.prefs.get: the star moves only on what was read back.
      const lost = p("primfail") && !d.retried;
      if (lost) {
        d.retried = true;
        d.status = "unconfirmed";
        paint();
        announce("Couldn't confirm your choice");
        // The fresh users.prefs.get decides: the new choice (it landed), the old one, or no answer.
        return setTimeout(() => {
          if (p("primfail") === "landed") return applyPrimary(id);
          d.status = p("primfail") === "noread" ? "noread" : "failed";
          paint();
          $('[data-lc="confirm-primary"]', dialog)?.focus();
        }, 500);
      }
      if (p("primconflict") && !d.conflicted) {
        d.status = "conflict";
        d.conflicted = true;
        d.theirs = "marlow";
        L.primary = "marlow";
        L.primaryCreated = CREATED.marlow;
        refreshRail();
        paint();
        return;
      }
      applyPrimary(id);
    }, 500);
  }
  function applyPrimary(id) {
    L.primary = id;
    L.primaryCreated = CREATED[id];
    closeDialog();
    refreshRail();
    announce(`${nameOf(id)} is your primary bot${L.deviceOnly ? " on this device" : ""}`);
  }

  // The picture editor (section 4) ------------------------------------------------------------------

  const BODIES = ["pebble", "block", "arch", "bloom", "disc", "hex", "drop", "gem"];
  const COLORS = ["#58c26f", "#5b8dff", "#ff8552", "#a98bff", "#f6bd3b", "#ff6f9c", "#45bdf5", "#a5d955"];
  const COLOR_NAMES = ["Green", "Blue", "Orange", "Violet", "Yellow", "Pink", "Sky", "Lime"];
  const PHOTO = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='%23f6bd3b'/><stop offset='1' stop-color='%23ff8552'/></linearGradient></defs><rect width='120' height='120' fill='url(%23g)'/><circle cx='84' cy='34' r='14' fill='%23fff4d6'/><path d='M0 92 L34 58 L62 86 L82 70 L120 100 L120 120 L0 120Z' fill='%23a5502a'/></svg>\")";

  const PHOTO_OUTSIDE = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'><rect width='120' height='120' fill='%23ff8552'/><circle cx='60' cy='48' r='22' fill='%23fff1e8'/><rect x='24' y='78' width='72' height='42' rx='20' fill='%23fff1e8'/></svg>\")";
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
      const who = esc(nameOf(id));
      const g = {
        excluded: ["Image generation isn't available on this gateway", `The gateway doesn't offer ${who} its image tool: “Denied by tools.deny”, in the gateway's own words.`],
        unavailable: ["Image generation isn't available on this gateway", `The gateway lists its image tool for ${who} as unavailable.`],
        unlisted: ["Image generation isn't available on this gateway", `The gateway doesn't list an image tool for ${who}'s task.`],
        unknown: ["Not known yet", `The gateway says which tools ${who} is offered for one of its tasks, and ${who} has none yet. Start a task, then look here again.`],
        unreadable: ["Couldn't read the tools", `Clawtrate couldn't read which tools the gateway offers ${who}.`],
        offered: ["Generating a picture isn't available in this version", `The gateway lists an image tool for ${who}, which doesn't say a provider is ready, and a picture would come back in ${who}'s task, not to this screen. You can ask ${who} for a picture in a task, then upload it.`],
      }[{ 1: "offered", unknown: "unknown", unlisted: "unlisted", unreadable: "unreadable", unavailable: "unavailable" }[p("imagetool")] || "excluded"];
      body = `<div class="b-result"><span class="empty-mark">${icon("image")}</span><h3>${g[0]}</h3><p>${g[1]}</p></div>`;
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
          (p("width") === "phone" || matchMedia("(max-width: 687px)").matches
            ? `<div class="lc-drop lc-drop-phone" data-lc-drop><span class="empty-mark">${icon("image")}</span>${button("Choose from Photos", 'data-lc="browse" data-size="sm" data-lc-focus')}${button("Take Photo", 'data-lc="browse" data-size="sm"')}<p class="b-hint">PNG, JPEG, WebP or GIF, under 25 MB.</p></div>`
            : `<div class="lc-drop" data-lc-drop><span class="empty-mark">${icon("image")}</span><p>Drop an image here</p>${button("Browse files", 'data-lc="browse" data-size="sm" data-lc-focus')}<p class="b-hint">PNG, JPEG, WebP or GIF, under 25 MB.</p></div>`) +
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
    const key = `${id}:${b.name}:${b.label}:${E.field}:${E.status}:${E.error}:${isAdmin()}:${Boolean(L.photo[id])}:${pictureShown(id)}`;
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
      (OUTSIDE[id] && !pictureShown(id)
        ? OUTSIDE[id].startsWith("https://")
          ? loadsOutside()
            ? `<div class="lc-outside" data-lc-outside><p>${esc(b.name)}'s picture is at <span class="mono lc-address">${esc(OUTSIDE[id])}</span>. Loading it lets whoever runs that address see this device's network address and the time of each request.</p>${button("Load picture", 'data-lc="allow-picture" data-size="sm"')}</div>`
            : `<div class="lc-outside" data-lc-outside><p>${esc(b.name)}'s picture is at <span class="mono lc-address">${esc(OUTSIDE[id])}</span>. This app doesn't load pictures from other addresses.</p></div>`
          : `<div class="lc-outside" data-lc-outside><p>Clawtrate can't load this picture address.</p></div>`
        : "") +
      (E.status === "saving" ? `<p class="b-hint lc-hero-line" role="status">Saving…</p>` : "") +
      (E.error ? `<p class="b-hint lc-hero-line" data-tone="danger" role="alert">${E.error}</p>` : "");
    CT.hydrate(hero);
    paintAllowed(hero);
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
    const reusedNote = unmatched() && primary ? `<p class="b-hint" data-lc-reused>Clawtrate couldn't match your saved choice to a bot in the gateway's current list.</p>` : "";
    const name = esc(nameOf(id));
    return (
      `<h3 class="b-tabgroup">Manage</h3><dl class="facts lc-manage">` +
      `<div><dt>Primary bot</dt><dd>${primary ? `Yes${storedValid() ? "" : ", as the gateway's default"}` : "No"}</dd></div>` +
      `</dl>` + reusedNote + `<div class="lc-manage-actions">` +
      (B.access === "read" ? "" : primary ? button("Replace with different bot", 'data-lc="open-choose" data-size="sm"') : button("Make primary bot", `data-lc="make-primary" data-lc-bot="${id}" data-size="sm"`)) +
      (isAdmin() ? button("Duplicate…", `data-lc="open-duplicate" data-lc-bot="${id}" data-size="sm"`) : "") +
      button("Export…", `data-lc="open-export" data-lc-bot="${id}" data-size="sm"`) +
      (isAdmin() ? button(`Delete ${name}…`, `data-lc="open-delete" data-lc-bot="${id}" data-size="sm" data-tone="danger"${primary || only ? " disabled" : ""}`, "quiet") : "") +
      `</div>` +
      (isAdmin() && only ? `<p class="b-hint">${name} is the gateway's only bot, and the gateway doesn't delete its only bot.</p>` : isAdmin() && primary ? `<p class="b-hint">${name} is your primary bot. Choose another primary bot before deleting it.</p>` : "")
    );
  };

  // The Instructions page (section 6).
  // Each changed file is written on its own, with the hash it was read with, and
  // read back on its own: one row per file. Drafts, hashes and outcomes are kept
  // per bot: switching bots never shows or saves another bot's draft.
  const I = { by: {} };
  const IS = (id) => (I.by[id] ??= { draft: null, status: null, rows: null, savedAt: null, theirs: {}, sent: {} });
  if (p("instr") === "conflict" || p("instr") === "conflict2") IS("juniper").draft = { agents: instr("juniper").agents.replace("Keep answers under 300 words.", "Keep answers under 200 words."), soul: "Curious, careful, brief.\n" };
  const FILES = { agents: "AGENTS.md", soul: "SOUL.md" };
  // What another writer puts in SOUL.md on the gateway, and, with instr=conflict2, a second change after that.
  const theirsSoul = "Curious, careful, plain-spoken. Never guess.\n";
  const newerSoul = "Curious, careful, plain-spoken. Never guess. Cite sources.\n";
  const hashOf = (t) => "sha256:" + [...t].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, "0");
  // The gateway's copy of a file, as the fixture has it (another writer may have changed it).
  const gatewayText = (id, k) => (I.by[id]?.gw?.[k] ?? instr(id)[k]);
  CT.botsPageViews = Object.assign(CT.botsPageViews || {}, {
    instructions: (id) => {
      const i = instr(id);
      const st = IS(id);
      const name = esc(nameOf(id));
      const admin = isAdmin();
      const draft = st.draft || i;
      const changed = st.draft && (st.draft.agents !== i.agents || st.draft.soul !== i.soul);
      const field = (key, title, file, help) => {
        const word = st.rows?.[key];
        return (
          `<h4 class="b-group"><label for="lc-${key}">${title}</label> <span class="b-faint">· ${file}</span></h4>` +
          (admin
            ? `<textarea class="input lc-text" id="lc-${key}" data-lc-instr="${key}" rows="${key === "agents" ? 9 : 3}" spellcheck="true">${esc(draft[key])}</textarea>`
            : `<pre class="lc-text lc-text-read" id="lc-${key}" tabindex="0">${esc(i[key])}</pre>`) +
          (word ? `<p class="lc-file-row" data-state="${word === "Written" ? "done" : "failed"}" data-lc-file-row="${key}" role="status">${glyph(word === "Written" ? "done" : "failed")}${file}: ${word}${word === "Written" ? `, read back at ${st.savedAt}` : ""}</p>` : "") +
          (word === "Changed on the gateway"
            ? note(
                `<p><b>${file} changed on the gateway ${st.again?.[key] ? "again" : "while you were editing"}.</b> Your text is kept here. The gateway now has:</p><pre class="lc-theirs" data-lc-theirs="${key}" data-lc-hash="${hashOf(st.theirs[key])}">${esc(st.theirs[key])}</pre>` +
                  `<div class="b-actions">${button("Save mine over it", `data-lc="instr-mine" data-lc-file="${key}" data-size="sm"`)}${button("Use the gateway's", `data-lc="instr-theirs" data-lc-file="${key}" data-size="sm"`, "quiet")}</div>`,
                "warn",
              )
            : "") +
          (word === "Couldn't check"
            ? `<p class="b-hint">Clawtrate couldn't read ${file} back: the gateway didn't answer. Your text is kept here. Check again only reads it.</p><div class="b-actions">${button("Check again", `data-lc="instr-check" data-lc-file="${key}" data-size="sm"`)}</div>`
            : "") +
          `<p class="b-hint">${help}</p>`
        );
      };
      return (
        `<div class="b-subhead"><button type="button" class="icon-button" data-variant="quiet" data-bs="main" aria-label="Back to settings">${icon("back")}</button><h3 tabindex="-1" data-bs-focus>Instructions</h3></div>` +
        `<p class="b-hint lc-first">${name}'s instructions and personality, as the gateway has them. The gateway controls when it loads these files and how much of them it includes. Changed ${esc(i.at)}.</p>` +
        field("agents", "Instructions", "AGENTS.md", "How it works: rules, priorities, what to do and not do.") +
        field("soul", "Personality", "SOUL.md", "Its tone and manner.") +
        `<p class="b-hint">Memory is separate: what ${name} remembers is under Memory, and these files don't change it.</p>` +
        (admin
          ? `<div class="b-actions lc-instr-actions"><span class="spacer"></span>` +
            button(st.status === "saving" ? "Saving…" : "Save", `data-lc="instr-save" data-size="sm"${changed && st.status !== "saving" ? "" : " disabled"}${st.status === "saving" ? ' aria-busy="true"' : ""}`, "primary") +
            `</div>`
          : "")
      );
    },
  });
  CT.botsPageNeeds = Object.assign(CT.botsPageNeeds || {}, { instructions: (name) => `Changing ${name}'s instructions needs admin access.` });

  const fileWord = (word) => (word === "Couldn't check" ? "couldn't check" : "changed on the gateway");
  // Save: each changed file of the bot it was pressed for, from a copy of that bot's draft.
  function saveInstructions(id) {
    const st = IS(id);
    const i = instr(id);
    const draft = { ...st.draft };
    const keys = Object.keys(FILES).filter((k) => draft[k] !== i[k]);
    st.status = "saving";
    CT.botsRender();
    setTimeout(() => {
      st.rows = { ...(st.rows || {}) };
      st.savedAt = "5:44 PM";
      for (const k of keys) {
        // agents.files.set with the hash the file was read with, then agents.files.get.
        L.calls.push(["agents.files.set", id, k, hashOf(i[k])]);
        let word = "Written";
        if ((p("instr") === "conflict" || p("instr") === "conflict2") && id === "juniper" && k === "soul" && !st.theirs.soul) {
          word = "Changed on the gateway";
          st.gw = { ...(st.gw || {}), soul: theirsSoul };
          st.theirs.soul = theirsSoul;
        }
        if (p("instrfail") && k === "agents" && !st.failedOnce) {
          // The write landed; its read-back got no answer.
          st.failedOnce = true;
          word = "Couldn't check";
          st.sent[k] = draft[k];
        }
        st.rows[k] = word;
        if (word === "Written") i[k] = draft[k];
      }
      i.at = "Nov 19, 5:44 PM";
      if (Object.keys(FILES).every((k) => st.draft[k] === i[k])) st.draft = null;
      st.status = null;
      CT.botsRender();
      const bad = keys.filter((k) => st.rows[k] !== "Written");
      announce(bad.length ? bad.map((k) => `${FILES[k]}: ${fileWord(st.rows[k])}`).join(". ") : "Instructions saved");
    }, 450);
  }
  // Save mine over it: that one file, with the hash of the gateway text shown. A newer text is shown, and asked about again.
  function saveMine(id, k) {
    const st = IS(id);
    const shown = st.theirs[k];
    st.status = "saving";
    CT.botsRender();
    setTimeout(() => {
      L.calls.push(["agents.files.set", id, k, hashOf(shown)]);
      if (p("instr") === "conflict2" && !st.again?.[k]) {
        st.gw[k] = newerSoul;
        st.theirs[k] = newerSoul;
        st.again = { ...(st.again || {}), [k]: true };
        st.status = null;
        CT.botsRender();
        return announce(`${FILES[k]} changed on the gateway again`);
      }
      instr(id)[k] = st.draft[k];
      st.rows[k] = "Written";
      if (Object.keys(FILES).every((x) => st.draft[x] === instr(id)[x])) st.draft = null;
      st.status = null;
      CT.botsRender();
      announce(`${FILES[k]} saved over the gateway's copy`);
    }, 450);
  }
  // Check again: reads the file; writes nothing.
  function checkInstruction(id, k) {
    const st = IS(id);
    setTimeout(() => {
      const i = instr(id);
      if (st.sent[k] !== undefined) i[k] = st.sent[k];
      st.rows[k] = i[k] === st.sent[k] ? "Written" : st.rows[k];
      if (st.draft && Object.keys(FILES).every((x) => st.draft[x] === i[x])) st.draft = null;
      CT.botsRender();
      announce(`${FILES[k]}: ${st.rows[k] === "Written" ? "read back" : "couldn't check"}`);
    }, 300);
  }
  document.addEventListener("input", (e) => {
    const area = e.target.closest("[data-lc-instr]");
    if (area) {
      const id = app.model.selectedBot;
      const st = IS(id);
      st.draft = st.draft || { ...instr(id) };
      st.draft[area.dataset.lcInstr] = area.value;
      const save = $('[data-lc="instr-save"]');
      const i = instr(id);
      if (save) save.disabled = st.draft.agents === i.agents && st.draft.soul === i.soul;
    }
    if (e.target.id === "lc-search") {
      L.dialog.query = e.target.value;
      paint();
      const s = $("#lc-search", dialog);
      s.focus();
      s.setSelectionRange(s.value.length, s.value.length);
    }
  });

  // A write to the instructions, in the conversation (section 7) ----------------------------------
  // Drawn only when the call's path, read as the Work pane reads it, is the bot's
  // own AGENTS.md or SOUL.md in the task's folder that is the bot's workspace, the
  // call ended without an error, and agents.files.get reports a modification time
  // within the run. It names no writer: the read reports a time, not who made it.
  // rolemtime=outside: the time falls outside the run, so there is no line;
  // rolewriter=second: another connection wrote it in the same window, which reads the same.

  const R = { on: Boolean(p("rolechange")), open: false };
  if (R.on) {
    const j = botOf("juniper");
    const t = j.tasks.find((x) => x.id === (p("task") || "j1")) || j.tasks[0];
    t.html =
      `<div class="stamp">Today 5:41 PM</div>` +
      `<div class="turn" data-role="user" data-testid="transcript-turn"><div class="msg" data-role="user"><div class="bubble">From now on keep your answers under 200 words.</div></div></div>` +
      (p("rolemtime") === "outside" ? "" : `<div id="lc-role" data-testid="role-line"></div>`);
    t.fresh = false;
  }
  function roleLine() {
    const slot = $("#lc-role");
    if (!slot || slot.dataset.drawn === String(R.open)) return;
    slot.dataset.drawn = String(R.open);
    slot.innerHTML =
      `<details class="event-details"${R.open ? " open" : ""}><summary class="event-line">AGENTS.md · modification time 5:41 PM${icon("chevron", "icon chevron")}</summary>` +
      `<div class="card event-body"><p class="b-p">A file tool named AGENTS.md. The gateway reports a modification at 5:41 PM. It doesn't report who made it.</p>` +
      `<div class="b-actions">${button("Open instructions", 'data-lc="open-instructions" data-size="sm"')}</div></div></details>`;
    CT.hydrate(slot);
  }
  new MutationObserver(() => roleLine()).observe($("#transcript"), { childList: true, subtree: false });
  document.addEventListener("toggle", (e) => {
    if (e.target.closest?.("#lc-role")) R.open = e.target.open;
  }, true);

  // Duplicate (section 8) ---------------------------------------------------------------------------

  // The writes of a copy or an import, each with its own read-back row. Every row
  // says what the gateway returned when read: Written, Still has <value>,
  // Changed on the gateway, Couldn't check, or, for a file the source lacks,
  // No source file. The new bot's own values (d.g) change only where a write
  // landed, and the rows are worked out from them.
  const NEW_BOT = { picture: "its drawn character", label: "", model: "openai/gpt-5.5", fallbacks: "inherited", effort: "Medium", tools: "the gateway's defaults", skills: "the gateway's defaults" };
  const START_WORDS = { picture: "its drawn character", label: "no label", model: "the gateway's default, openai/gpt-5.5", fallbacks: "the gateway's list", effort: "the gateway's default, Medium", tools: "the gateway's defaults", skills: "the gateway's defaults", agents: "its starting file", soul: "its starting file" };
  const OTHER_AGENTS = "# Wren\n\nAnother device's text.\n";
  function writeRows(d) {
    const b = D.binding[d.bot] || {};
    const a = D.acct(d.acct && d.acct !== D.GATEWAY ? d.acct : b.account);
    const src = d.kind === "import" ? WREN() : { label: botOf(d.bot)?.label || "", model: d.acct === D.GATEWAY ? `${a?.provider || "openai"}/${b.model}` : `${a?.provider || "openai"}/${b.model}@${a ? D.acctName(a) : "gateway"}`, effort: b.effort, agents: instr(d.bot).agents, soul: p("dup") === "nosource" ? null : instr(d.bot).soul };
    const rows = [];
    const add = (key, label, want) => rows.push({ key, label, want });
    if (d.copy.look) add("picture", "Picture", "the source picture"), add("label", "Label", src.label);
    if (d.copy.model) {
      add("model", d.kind === "import" ? "Model" : "Model and account", src.model);
      add("fallbacks", "Fallback list: none", "none");
      add("effort", "Effort", src.effort);
    }
    if (d.copy.instr) add("agents", "AGENTS.md", src.agents), add("soul", "SOUL.md", src.soul);
    if (d.kind !== "import" && d.copy.tools) add("tools", "Tool permissions", "the source's"), add("skills", "Skills", "the source's");
    return rows;
  }
  const startOf = (key) => NEW_BOT[key] ?? START_WORDS[key];
  // What each row reads back, from the new bot's values and whether its read answered.
  function outcome(d, r) {
    if (r.want === null) return "No source file. Left the new bot's starting file";
    if (d.unread?.[r.key]) return "Couldn't check";
    const v = d.g[r.key];
    if (v === r.want) return "Written";
    if (v === startOf(r.key)) return `Still has ${START_WORDS[r.key]}`;
    return "Changed on the gateway";
  }
  const settled = (word) => word === "Written" || word.startsWith("No source file");
  // Try again: identified rows whose current value is still the observed starting value.
  const retryable = (d, rows) => rows.filter((r) => outcome(d, r).startsWith("Still has"));
  // The new bot as the rows say: only what read back is the bot's.
  function applyBacking(d) {
    const nid = d.newId;
    if (!nid || !botOf(nid)) return;
    const src = D.binding[d.bot] || {};
    const modelLanded = d.g.model && d.g.model !== NEW_BOT.model;
    D.binding[nid] = modelLanded && d.kind !== "import"
      ? { ...src, ...(d.acct && d.acct !== D.GATEWAY ? { account: d.acct } : d.acct === D.GATEWAY ? { account: null, mode: "gateway" } : {}), effort: d.g.effort, locked: false }
      : { account: null, mode: "gateway", model: modelLanded ? d.g.model.split("/")[1] : "gpt-5.5", effort: d.g.effort, locked: false };
    botOf(nid).label = d.g.label || "";
    INSTR[nid] = { agents: d.g.agents ?? `# ${d.name.trim()}\n\nA new bot.\n`, soul: d.g.soul ?? "Calm and brief.\n", at: "Nov 19, 5:46 PM" };
  }
  function stepsView(d) {
    const rows = writeRows(d);
    const at = d.at ?? 0;
    const made = `<li data-state="${at > 0 || d.status !== "working" ? "done" : "running"}">${glyph(at > 0 || d.status !== "working" ? "done" : "sending")}<span>Made ${esc(d.name)}</span><span class="lc-step-word">${at > 0 || d.status !== "working" ? "Listed" : "Writing"}</span></li>`;
    const show = (v) => esc(v == null ? "nothing" : String(v).length > 60 ? String(v).replace(/\s+/g, " ").trim() : String(v));
    const row = (r, i) => {
      // While it works, a row already sent has no read-back yet.
      if (d.status === "working" && i + 1 < at) return `<li data-state="queued">${glyph("queued")}<span>${r.label}</span><span class="lc-step-word">Sent</span></li>`;
      if (d.status === "working" && i + 1 >= at) return `<li data-state="${i + 1 === at ? "running" : "queued"}">${glyph(i + 1 === at ? "sending" : "queued")}<span>${r.label}</span><span class="lc-step-word">${i + 1 === at ? "Writing" : "Waiting"}</span></li>`;
      const word = outcome(d, r);
      const ok = settled(word);
      return (
        `<li data-state="${ok ? "done" : "failed"}" data-lc-row-key="${r.key}">${glyph(ok ? "done" : "failed")}<span>${r.label}</span><span class="lc-step-word">${esc(word)}</span></li>` +
        (word === "Changed on the gateway"
          ? `<li class="lc-step-detail"><details class="lc-review" data-lc-change="${r.key}"><summary>Review change</summary><p class="b-hint">The gateway has:</p><pre class="lc-theirs">${show(d.g[r.key])}</pre><p class="b-hint">You asked for:</p><pre class="lc-theirs">${show(r.want)}</pre></details></li>`
          : "")
      );
    };
    if (d.status === "lostcreate")
      return sheet(
        d.kind === "import" ? `Adding ${esc(d.name)}` : `Duplicating ${esc(nameOf(d.bot))}`,
        d.roster === "none"
          ? note(`<p>Couldn't check whether ${esc(d.name)} was created.</p>`, "warn")
          : note(`<p>Couldn't confirm creation. The gateway lists a bot called ${esc(d.name)}. Open it to review it.</p>`, "warn"),
        d.roster === "none"
          ? button("Check again", 'data-lc="dup-check-create" data-size="lg" data-lc-focus', "primary") + button("Close", 'data-lc="close" data-size="lg"', "quiet")
          : button(`Open ${esc(d.name)}`, 'data-lc="dup-open" data-size="lg" data-lc-focus', "primary") + button("Close", 'data-lc="close" data-size="lg"', "quiet"),
      );
    const list = `<p class="b-hint lc-first">Each row is what the gateway returned when Clawtrate read it back.</p><ol class="lc-steps" aria-label="What was written">${made}${rows.map(row).join("")}</ol>`;
    const from = d.kind === "import" ? null : esc(nameOf(d.bot));
    if (d.status === "working") return sheet(d.kind === "import" ? `Adding ${esc(d.name)}` : `Duplicating ${from}`, list, "");
    const missing = rows.filter((r) => !settled(outcome(d, r)));
    if (!missing.length)
      return sheet(
        "New bot with the selected settings",
        `<p class="b-lead">${esc(d.name)} is listed, with each setting below read back.</p>` +
          list +
          `<p class="b-hint">What its tools, skills and models do can still differ from ${d.kind === "import" ? "the bot the file came from" : from}: the gateway decides, with its own defaults.</p>`,
        button(`Open ${esc(d.name)}`, 'data-lc="dup-open" data-size="lg" data-lc-focus', "primary"),
      );
    const canRetry = retryable(d, rows).length > 0;
    const unread = rows.some((r) => outcome(d, r) === "Couldn't check");
    return sheet(
      "Some settings still need attention",
      `<p class="b-lead">${esc(d.name)} is listed. ${missing.length === 1 ? "One setting doesn't" : `${missing.length} settings don't`} read back as chosen.</p>` +
        list +
        `<p class="b-hint">${unread ? "Check again only reads the rows that couldn't be checked. " : ""}${canRetry ? "Try again writes only the rows that still have their starting value, after reading that they still do. " : ""}A row changed on the gateway keeps the other writer's value. Leave it as it is keeps ${esc(d.name)} as the rows say.</p>`,
      (unread ? button("Check again", `data-lc="dup-check" data-size="lg"${canRetry ? "" : " data-lc-focus"}`, canRetry ? "" : "primary") : "") +
        (canRetry ? button("Try again", 'data-lc="dup-retry" data-size="lg" data-lc-focus', "primary") : "") +
        button("Leave it as it is", 'data-lc="dup-open" data-size="lg"', "quiet"),
    );
  }

  VIEWS.duplicate = (d) => {
    const id = d.bot;
    const name = esc(nameOf(id));
    const f = FACTS[id];
    const own = p("dupacct") === "own";
    const b = D.binding[id] || {};
    const a = D.acct(own ? "anthropic:pip" : b.account);
    if (d.status === "working" || d.status === "done" || d.status === "lostcreate") return stepsView(d);
    const item = (key, title, sub, disabled) =>
      `<label class="b-check lc-item"><input type="checkbox" data-lc-copy="${key}"${d.copy[key] ? " checked" : ""}${disabled ? " disabled" : ""} /><span class="lc-item-text"><span>${title}</span><span class="b-hint">${sub}</span></span></label>`;
    const shared = D.shared();
    const choices = [...shared.map((x) => [x.id, D.acctTitle(x)]), [D.GATEWAY, "Let the gateway choose"]];
    return sheet(
      `Duplicate ${name}`,
      `<label class="b-label" for="lc-dup-name">Name of the copy</label><input class="input lc-dup-name" id="lc-dup-name" value="${esc(d.name)}" data-lc-dupname data-lc-focus maxlength="40" />` +
        (d.refused ? note(`<p><b>The gateway didn't make the copy:</b> “agent "${esc(d.refused)}" already exists”. Nothing was made.</p>`, "danger") : "") +
        `<h4 class="b-group">Copied to it</h4>` +
        item("look", "Picture and label", "The picture the gateway has for it, and its label.") +
        item(
          "model",
          own ? "Model and effort, on an account you choose" : "Model, account and effort",
          own ? `${esc(a.label)} is kept by ${name} alone, so the copy can't use it.` : `${esc(D.acctName(a))}, ${esc(b.model || "")}, effort ${esc(b.effort || "")}. Written as New bot writes it: the model with its account, then an empty fallback list.`,
        ) +
        (own && d.copy.model
          ? `<div class="b-choices lc-accounts" role="radiogroup" aria-label="Account for the copy">${choices
              .map(([cid, title], i) => `<button type="button" class="b-choice" role="radio" aria-checked="${d.acct === cid}" tabindex="${d.acct === cid || (!d.acct && i === 0) ? 0 : -1}" data-lc-acct="${cid}"><span class="b-choice-text"><span class="b-choice-title">${esc(title)}</span>${cid === D.GATEWAY ? `<span class="b-choice-sub">The copy gets ${esc(b.model || "the model")} with no account: the gateway picks one of the provider's accounts for each run.</span>` : ""}</span>${icon("check", "icon b-tick")}</button>`)
              .join("")}</div>`
          : "") +
        (!d.copy.model ? `<p class="b-hint lc-indent">Without it the copy uses the gateway's default model, openai/gpt-5.5, and its default effort.</p>` : "") +
        item("instr", "Instructions and personality", "AGENTS.md and SOUL.md, as they are now. A file the source doesn't have leaves the copy's starting file.") +
        item("tools", "Tool permissions and skills", "What it may do with its tools, and which skills it has.") +
        `<h4 class="b-group">Not copied</h4><ul class="lc-list">` +
        `<li>Its memory: ${esc(f.memory)}, and About you (USER.md)</li>` +
        `<li>Its tasks and their history</li>` +
        (f.routines.length ? `<li>Its routines: ${esc(f.routines.join(", "))}. A copy would run them twice.</li>` : "") +
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

  function runDuplicate() {
    const d = L.dialog;
    const want = d.kind === "import" ? p("impresult") : p("dup");
    const refuse = want === "taken" || want === "refused";
    if (refuse && !d.refusedOnce) {
      d.refusedOnce = true;
      d.refused = `${d.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      paint();
      setTimeout(() => {
        paint(true);
        announce(d.kind === "import" ? "The gateway didn't make the bot" : "The gateway didn't make the copy");
      }, 300);
      return;
    }
    d.refused = null;
    const rows = writeRows(d);
    d.status = "working";
    d.busy = true;
    d.at = 0;
    paint(true);
    L.calls.push(["agents.create", d.name.trim()]);
    // The create got no answer: the list is read, and nothing more is written.
    if (want === "lostcreate" || want === "lostcreate-noroster") {
      return setTimeout(() => {
        d.busy = false;
        d.status = "lostcreate";
        d.roster = want === "lostcreate" ? "listed" : "none";
        if (d.roster === "listed") listNewBot(d);
        paint(true);
        announce(d.roster === "listed" ? "Couldn't confirm creation" : `Couldn't check whether ${d.name.trim()} was created`);
      }, 400);
    }
    const tick = () => {
      d.at += 1;
      if (d.at > rows.length) {
        d.busy = false;
        d.status = "done";
        listNewBot(d);
        // What each write left on the new bot, as the fixture has it.
        d.g = {};
        d.unread = {};
        for (const r of rows) {
          if (r.want === null) continue;
          L.calls.push([["agents", "soul"].includes(r.key) ? "agents.files.set" : "config.patch", r.key]);
          d.g[r.key] = r.want;
          if (want === "partial") {
            if (r.key === "effort") d.g.effort = NEW_BOT.effort;
            if (r.key === "soul") d.unread.soul = true;
            if (r.key === "agents" && d.kind === "import") d.g.agents = OTHER_AGENTS;
          }
        }
        for (const k of ["picture", "label", "model", "fallbacks", "effort", "agents", "soul"]) if (!(k in d.g)) d.g[k] = k === "agents" || k === "soul" ? null : NEW_BOT[k];
        applyBacking(d);
        refreshRail();
        paint(true);
        const missing = rows.filter((r) => !settled(outcome(d, r)));
        const unread = rows.filter((r) => outcome(d, r) === "Couldn't check").map((r) => `${r.label}: couldn't check`);
        announce(missing.length ? ["Some settings still need attention", ...unread].join(". ") : "New bot with the selected settings");
        return;
      }
      paint();
      setTimeout(tick, 160);
    };
    setTimeout(tick, 160);
  }
  function listNewBot(d) {
    let nid = d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "copy";
    while (botOf(nid)) nid += "-2";
    d.newId = nid;
    CT.botArt[nid] = d.kind === "import" ? CT.botArt.__wren : d.copy.look ? CT.botArt[d.bot] || { body: "drop", color: "#ff6f9c", tilt: 0, look: [0.6, 0] } : { body: "pebble", color: "#9aa0a6", tilt: 0, look: [0.6, 0] };
    D.binding[nid] = { account: null, mode: "gateway", model: "gpt-5.5", effort: NEW_BOT.effort, locked: false };
    FACTS[nid] = { folder: `workspace-${nid}`, files: 4, memory: "no memory yet", tasks: 0, routines: [], routes: 0, own: [] };
    CREATED[nid] = Date.now();
    app.bots.push({ id: nid, name: d.name.trim(), label: "", tasks: [{ id: `${nid}-1`, title: "Main", at: 3000, when: "now", preview: "No messages yet.", unread: false, status: "idle", html: "", fresh: true }] });
    INSTR[nid] = { agents: `# ${d.name.trim()}\n\nA new bot.\n`, soul: "Calm and brief.\n", at: "Nov 19, 5:46 PM" };
    refreshRail();
  }
  // Check again: reads only the rows that couldn't be checked. Here each read answers.
  function checkRows(d) {
    setTimeout(() => {
      d.unread = {};
      applyBacking(d);
      paint(true);
      const rows = writeRows(d);
      announce(rows.every((r) => settled(outcome(d, r))) ? "New bot with the selected settings" : "Read again");
    }, 300);
  }
  // Try again: config.get first; a row whose value is no longer its starting value is not written.
  function retryRows(d) {
    const rows = retryable(d, writeRows(d));
    setTimeout(() => {
      if (p("second")) d.g.effort = "High"; // another device set it meanwhile
      for (const r of rows) {
        if (d.g[r.key] !== startOf(r.key)) continue;
        L.calls.push([["agents", "soul"].includes(r.key) ? "agents.files.set" : "config.patch", r.key, "baseHash"]);
        d.g[r.key] = r.want;
      }
      applyBacking(d);
      paint(true);
      const all = writeRows(d);
      announce(all.every((r) => settled(outcome(d, r))) ? "New bot with the selected settings" : "Some settings still need attention");
    }, 300);
  }

  // Export and import: a Clawtrate file (section 9) -----------------------------------------------------

  const NEVER = [
    "Tool permissions and skills",
    "Memory and About you (MEMORY.md, notes, USER.md)",
    "Tasks and their transcripts",
    "Routines",
    "Approvals and rules",
    "Channel routes",
    "Other files in the workspace folder",
  ];
  const neverList = () => `<ul class="lc-list">${NEVER.map((x) => `<li>${x}</li>`).join("")}</ul>`;
  // The name the host reports for a confirmed save: the person may change it in the save dialog.
  const HOST_NAME = "Pip backup.clawtrate-bot.json";
  const EXPORT_WORDS = {
    saved: (size) => [`Saved ${HOST_NAME}, ${size}`, ""],
    web: () => ["Download requested", "Your browser decides where the file goes and whether it keeps it."],
    cancelled: () => ["Not saved", "You closed the save dialog. Nothing was written."],
    unchanged: () => ["Couldn't save", "The disk is full. The selected file still contains its previous bytes."],
    absent: () => ["Couldn't save", "The disk is full. The selected file isn't there."],
    "saved-anyway": (size) => [`Export saved, ${size}`, "The save reported an error, but the selected file contains the export."],
    unknown: () => ["Couldn't save", "The disk is full. Clawtrate couldn't tell what the selected file holds now."],
  };
  // The candidate, read and checked before the review (agents.list, config.get, agents.files.get).
  // Export file hands over the bytes built from it, and never reads the gateway again.
  function readCandidate(id) {
    const b = D.binding[id] || {};
    const a = D.acct(b.account);
    const i = instr(id);
    const outside = Boolean(L.outsidePicture(id));
    return {
      name: nameOf(id),
      label: botOf(id)?.label || null,
      outside,
      picture: outside ? null : `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHL${id}`,
      model: `${a ? a.provider : "openai"}/${b.model || "gpt-5.5"}`,
      account: a ? D.acctName(a) : "none",
      effort: b.effort || "Medium",
      agents: i.agents,
      soul: i.soul,
    };
  }
  const exportBytes = (c, files) => {
    const instructions = {};
    if (files.agents) instructions["AGENTS.md"] = c.agents;
    if (files.soul) instructions["SOUL.md"] = c.soul;
    const bot = { name: c.name, label: c.label, picture: c.picture, model: c.model, effort: c.effort };
    if (files.agents || files.soul) bot.instructions = instructions;
    return JSON.stringify({ format: "clawtrate.bot", formatVersion: 1, writtenBy: "Clawtrate 0.4.0", bot }, null, 2);
  };
  const sizeOf = (bytes) => `${Math.max(1, Math.ceil(new Blob([bytes]).size / 1024))} KB`;
  // For the checks: what was handed to the host, and an edit made on the gateway meanwhile.
  CT.lifecycleHandoff = () => L.handoff || null;
  CT.lifecycleEditSource = (id, file, text) => (instr(id)[file] = text);
  CT.lifecycleInstr = (id) => ({ ...instr(id) });
  function readExport(d) {
    d.read = "loading";
    paint();
    setTimeout(() => {
      if (L.dialog !== d) return;
      if (p("exp") === "readfail" && !d.readFailed) {
        d.readFailed = true;
        d.read = "failed";
        paint(true);
        return announce("Couldn't read AGENTS.md");
      }
      const before = d.candidate && exportBytes(d.candidate, d.files);
      d.candidate = readCandidate(d.bot);
      d.read = null;
      d.reloaded = Boolean(before);
      d.changed = Boolean(before) && before !== exportBytes(d.candidate, d.files);
      paint(true);
      if (before) announce(d.changed ? "Reloaded: the bot changed on the gateway" : "Reloaded: nothing changed");
    }, 300);
  }

  VIEWS.export = (d) => {
    const id = d.bot;
    const name = esc(nameOf(id));
    if (d.read === "loading") return sheet(`Export ${name}`, `<p class="b-wait" role="status"><span class="status-dot" data-status="connecting"></span>Reading ${name} from the gateway…</p>`, "");
    if (d.read === "failed")
      return sheet(
        `Export ${name}`,
        note(`<p>Couldn't read AGENTS.md. Try again.</p>`, "warn"),
        button("Try again", 'data-lc="export-reread" data-size="lg" data-lc-focus', "primary") + button("Close", 'data-lc="close" data-size="lg"', "quiet"),
      );
    if (d.exp === "saving") return sheet(`Export ${name}`, `<p class="b-wait" role="status"><span class="status-dot" data-status="connecting"></span>Waiting for the save dialog…</p>`, "");
    if (d.exp && EXPORT_WORDS[d.exp]) {
      const [title, text] = EXPORT_WORDS[d.exp](sizeOf(d.bytes));
      const ok = d.exp === "saved" || d.exp === "web" || d.exp === "saved-anyway";
      return sheet(
        `Export ${name}`,
        `<div class="b-result"><span class="empty-mark"${ok ? "" : ' data-tone="warn"'}>${icon(ok ? "check" : "warning")}</span><h3 tabindex="-1" data-lc-focus>${title}</h3>${text ? `<p>${text}</p>` : ""}</div>`,
        ok ? button("Done", 'data-lc="close" data-size="lg"') : button("Try again", 'data-lc="export-file" data-size="lg"', "primary") + button("Close", 'data-lc="close" data-size="lg"', "quiet"),
      );
    }
    const c = d.candidate;
    const val = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
    const fileRow = (key, file, text) =>
      `<label class="b-check lc-item"><input type="checkbox" data-lc-expfile="${key}"${d.files?.[key] ? " checked" : ""} /><span class="lc-item-text"><span>${file} <span class="b-faint">· ${lines(text)} ${lines(text) === 1 ? "line" : "lines"}</span></span></span></label>` +
      (d.files?.[key] ? `<pre class="lc-theirs lc-exp-text">${esc(text)}</pre>` : "");
    return sheet(
      `Export ${name}`,
      (d.changed ? note(`<p>The bot changed on the gateway since this was read. Review the new values before saving.</p>`, "warn") : "") +
        `<p class="b-hint lc-first">A Clawtrate file: this app's own JSON format, for another Clawtrate to read. The gateway doesn't know it.</p>` +
        `<h4 class="b-group">The file will hold exactly this</h4>` +
        `<dl class="facts lc-exp-values">` +
        val("Name", esc(c.name)) +
        val("Label", esc(c.label || "None")) +
        val(
          "Picture",
          c.outside
            ? `<span class="b-faint">Left out: it's an outside address</span>`
            : `<span class="lc-exp-pic"><span class="avatar" data-bot="${id}" role="img" aria-label="The picture as the file will hold it"></span>PNG, 128 by 128</span>`,
        ) +
        val("Model", `${esc(c.model)} <span class="b-faint">· its account, ${esc(c.account)}, left out</span>`) +
        val("Effort", esc(c.effort)) +
        `</dl>` +
        `<h4 class="b-group">Instructions, if you choose them</h4>` +
        fileRow("agents", "AGENTS.md", c.agents) +
        fileRow("soul", "SOUL.md", c.soul) +
        note(`<p>The file leaves out account bindings and sign-in stores. The fields you export can contain private text, credentials or paths. Review them before saving.</p>`, "warn") +
        `<h4 class="b-group">Never in a Clawtrate file</h4>${neverList()}`,
      button("Export file…", 'data-lc="export-file" data-size="lg" data-lc-focus', "primary") + button("Reload from gateway", 'data-lc="export-reload" data-size="lg"', "quiet"),
    );
  };

  // The file a person chose, as the fixtures have it: Wren, from another gateway.
  const WREN = () => {
    const odd = p("imp") === "unavailable";
    return {
      name: "Wren",
      label: "Garden",
      writtenBy: "Clawtrate 0.4.0",
      model: odd ? "globex/atlas-2" : "openai/gpt-5.5",
      effort: "High",
      agents: "# Wren\n\nYou keep the garden calendar.\nAsk before ordering seeds.\nNever water on a rain day.\n",
      soul: "Patient and practical.\n",
      settings: [
        ["Model", odd ? "globex/atlas-2" : "openai/gpt-5.5", !odd],
        ["Effort", "High", odd ? "with-model" : true],
      ],
    };
  };
  CT.botArt.__wren = { body: "bloom", color: "#a5d955", tilt: 0, look: [0.6, 0] };
  const REFUSALS = {
    version: "Its format version is 3, and this version of Clawtrate reads version 1.",
    size: "It is 6.2 MB, and a Clawtrate bot file holds at most 5 MB.",
    type: "Its label is a number, not text.",
    field: "It has a field Clawtrate doesn't read: “tools”.",
    account: "Its model names an account, “openai/gpt-5.5@work”. A Clawtrate file names models without accounts.",
    picture: "Its picture isn't a PNG, JPEG, WebP or GIF image that decodes.",
  };

  VIEWS.import = (d) => {
    if (d.status === "working" || d.status === "done" || d.status === "lostcreate") return stepsView(d);
    if (d.stage === "reading") return sheet("Import a bot", `<p class="b-wait" role="status"><span class="status-dot" data-status="connecting"></span>Reading wren.clawtrate-bot.json…</p>`, "");
    if (d.stage === "refused")
      return sheet(
        "Import a bot",
        note(`<p><b>Clawtrate can't read this file.</b> ${REFUSALS[p("imp")]} Nothing in it was used.</p>`, "danger"),
        button("Choose another file…", 'data-lc="import-choose" data-size="lg" data-lc-focus', "primary"),
      );
    if (d.stage === "review") {
      const w = WREN();
      const left = w.settings.filter(([, , ok]) => ok === false);
      const writes = w.settings.filter(([, , ok]) => ok === true);
      const word = (ok) => (ok === true ? "Will be written" : ok === "with-model" ? "Left out with the model" : "Not available here, left out");
      const row = ([k, v, ok]) => `<li data-state="${ok === true ? "write" : "left"}"><span>${k}: ${esc(v)}</span><span class="lc-step-word">${word(ok)}</span></li>`;
      return sheet(
        "Add Wren?",
        `<span class="b-preview" role="img" aria-label="The file's picture">${CT.character("__wren")}</span>` +
          `<label class="b-label" for="lc-imp-name">Name</label><input class="input lc-dup-name" id="lc-imp-name" value="${esc(d.name)}" data-lc-impname maxlength="40" />` +
          (d.refused ? note(`<p><b>The gateway didn't make the bot:</b> “agent "${esc(d.refused)}" already exists”. Nothing was made.</p>`, "danger") : "") +
          `<p class="b-hint lc-center">Label: ${esc(w.label)} · wren.clawtrate-bot.json. The file says it was written by ${esc(w.writtenBy)}.</p>` +
          note(`<p>These files will become instructions the new bot may follow when it runs. Read them first: Clawtrate shows them and doesn't run them, and nothing is created until Add Bot.</p>`) +
          `<details class="lc-review" data-lc-row="agents"><summary>Instructions · AGENTS.md <span class="b-faint">· ${lines(w.agents)} lines, in full</span></summary><pre class="lc-theirs">${esc(w.agents)}</pre></details>` +
          `<details class="lc-review" data-lc-row="soul"><summary>Personality · SOUL.md <span class="b-faint">· ${lines(w.soul)} line, in full</span></summary><pre class="lc-theirs">${esc(w.soul)}</pre></details>` +
          `<details class="lc-review" data-lc-row="settings"><summary>Settings <span class="b-faint">· ${writes.length ? `${writes.length + 1} to write` : "nothing to write"}${left.length ? `, ${left.length} not available here` : ""}</span></summary><ul class="lc-result lc-settings">${w.settings.map(row).join("")}${left.length ? "" : `<li data-state="write"><span>Fallback list: none</span><span class="lc-step-word">Will be written</span></li>`}</ul>` +
          (left.length ? `<p class="b-hint">With its model left out, Wren uses the gateway's default model, openai/gpt-5.5, until you choose one, and its effort is left out with it.</p>` : "") +
          `</details>` +
          `<details class="lc-review" data-lc-row="never"><summary>Not created <span class="b-faint">· a Clawtrate file never carries these</span></summary>${neverList()}<p class="b-hint">Nor any account binding or sign-in store: the new bot gets its account the way New bot gives one.</p></details>`,
        isAdmin() ? button("Add Bot", `data-lc="import-add" data-size="lg"${d.name.trim() ? "" : " disabled"}`, "primary") : adminBar("Adding a bot needs admin access. You can read the whole file here first."),
      );
    }
    return sheet(
      "Import a bot",
      `<p class="b-lead">Choose a Clawtrate file. You'll see everything it would create before anything is.</p>` +
        `<div class="lc-drop" data-lc-drop><span class="empty-mark">${icon("file")}</span><p>Drop a .clawtrate-bot.json file here</p>${button("Choose file…", 'data-lc="import-choose" data-size="sm" data-lc-focus')}<p class="b-hint">At most 5 MB. Reading it changes nothing on the gateway.</p></div>`,
      "",
    );
  };

  // Delete (section 10) ---------------------------------------------------------------------------------

  const CHANGED_WORDS = "The bot you reviewed has changed. Open Delete from its current bot page to review it again.";
  VIEWS.delete = (d) => {
    const id = d.bot;
    // Named as it was when the dialog opened: afterwards the list no longer has it.
    const name = esc((d.botName ??= nameOf(id)));
    const f = FACTS[id];
    const share = sharers(id);
    const tasks = d.tasks ?? f.tasks;
    if (d.read === "loading")
      return sheet(`Delete ${name}?`, `<p class="b-wait" role="status"><span class="status-dot" data-status="connecting"></span>Reading what ${name} has on the gateway…</p>`, button("Cancel", 'data-lc="close" data-size="lg"', "quiet"));
    if (d.read === "failed")
      return sheet(
        `Delete ${name}?`,
        note(`<p><b>Couldn't read what ${name} has.</b> The gateway didn't answer. Clawtrate doesn't delete a bot without saying what goes.</p>`, "danger"),
        button("Try again", 'data-lc="del-reread" data-size="lg" data-lc-focus', "primary") + button("Cancel", 'data-lc="close" data-size="lg"', "quiet"),
      );
    if (d.status === "deleting" || d.status === "checking")
      return sheet(d.status === "checking" ? (d.reads ? deleteTitle(d, name) : `Delete ${name}?`) : `Deleting ${name}`, `<p class="b-wait" role="status"><span class="status-dot" data-status="connecting"></span>${d.status === "checking" ? `Reading what ${name} has again…` : `Deleting ${name}…`}</p>`, "");
    if (d.status === "replaced") return sheet(`Delete ${name}?`, note(`<p>${CHANGED_WORDS}</p>`, "warn"), button("Close", 'data-lc="close" data-size="lg" data-lc-focus'));
    if (d.status) return resultView(d, name, f, share);
    const workspaceLine = share.length
      ? `<li data-state="stays"><span>Its workspace folder, ${esc(f.folder)}, stays: also used by ${esc(share.join(" and "))}.</span></li>`
      : `<li><span>The gateway will try to move this workspace, ${esc(f.folder)}, including its files and memory. It keeps folders still used by another bot.</span></li>`;
    return sheet(
      `Delete ${name}?`,
      (d.changed ? note(`<p><b>What ${name} has changed since this opened:</b> it now has ${tasks} tasks. Check what goes, then delete again.</p>`, "warn") : "") +
        `<h4 class="b-group">The gateway will try to remove</h4><ul class="lc-list">` +
        `<li>${name}'s settings</li>` +
        (f.routes ? `<li>Removes this channel route: Telegram, account home</li>` : "") +
        `<li>${tasks} tasks listed for ${name}</li>` +
        (f.routines.length ? `<li>Its ${f.routines.length === 1 ? "routine" : `${f.routines.length} routines`}: ${esc(f.routines.join(", "))}</li>` : "") +
        `<li>Approvals saved for its commands</li></ul>` +
        `<label class="b-check lc-files"><input type="checkbox" data-lc-files${d.files ? " checked" : ""} /><span>Also move ${name}'s folders to the Trash on the gateway's machine</span></label>` +
        `<p class="b-hint lc-files-hint">They can be restored from that Trash, on the gateway's machine, until it's emptied.</p>` +
        `<ul class="lc-list lc-folders" data-on="${Boolean(d.files)}">${workspaceLine}<li><span>Its own folder. May include local sign-ins and other bot data.</span></li><li><span>Its tasks' transcripts</span></li></ul>` +
        `<p class="b-hint">The gateway checks, while it deletes, which folders another bot still uses.</p>` +
        `<h4 class="b-group">Stays</h4><ul class="lc-list">` +
        (d.files ? "" : `<li>Its folders: with the box unticked, none is asked for the Trash. The gateway may archive its tasks' transcripts.</li>`) +
        `<li>What ${name} said in other bots' tasks</li></ul>` +
        `<p class="b-hint">This can't be undone from Clawtrate. Before deleting, Clawtrate reads all of this again.</p>`,
      button("Cancel", 'data-lc="close" data-size="lg" data-lc-focus', "quiet") + button(`Delete ${name}`, 'data-lc="del-go" data-size="lg" data-tone="danger"'),
    );
  };

  // After a delete. The gateway's answer (or its absence) and each read are kept apart: a row says
  // only what its own read said, and a path only what the answer reported for it.
  const READ_ROWS = [
    ["bots", "Bot list", "bots"],
    ["settings", "Settings and channel routes", "settings"],
    ["routines", "Routines", "routines"],
    ["tasks", "Tasks", "tasks"],
  ];
  // What the fixture's gateway answers to agents.delete, as `delresult` sets it; null: no answer came.
  function deleteReply(d, f) {
    const want = p("delresult");
    if (want === "uncertain") return null;
    if (want === "refused") return { refused: `Agent "${d.bot}" owns inherited credentials through agents.defaults.authInheritance.agentId and cannot be deleted.` };
    const reply = { removed: [], failed: [], purgeFailed: want === "purge" };
    if (!d.files || reply.purgeFailed) return reply;
    const own = `agents/${d.bot}/agent`;
    const sessions = `agents/${d.bot}/sessions`;
    if (want === "multi") reply.failed.push([f.folder, "permission denied"], [own, "resource busy"]);
    else if (want === "partial") reply.failed.push([f.folder, "permission denied"]);
    else if (!sharers(d.bot).length) reply.removed.push([f.folder, "trash"]);
    if (want !== "multi") reply.removed.push([own, "trash"]);
    reply.removed.push([sessions, "trash"], [`${own}/openclaw-agent.sqlite-journal`, "missing"]);
    return reply;
  }
  // What each read returns after the delete: "absent" (read to its end, nothing of the bot's),
  // "listed" (still there) or "failed" (no answer, or not read to its end).
  function deleteReads(d) {
    const want = p("delresult");
    const all = (v) => ({ bots: v, settings: v, routines: v, tasks: v });
    if (want === "refused") return all("listed");
    if (want === "uncertain") return d.checked ? all("absent") : all("failed");
    if (want === "purge") return { ...all("absent"), tasks: "listed" };
    if (want === "readfail") return d.checked ? all("absent") : { ...all("absent"), routines: "failed" };
    return all("absent");
  }
  const deleteTitle = (d, name) => (d.reads.bots === "absent" ? `${name} was deleted` : `Delete result for ${name}`);
  const deleteNeedsCheck = (d) => !d.reply || d.reply.purgeFailed || d.reply.failed?.length || Object.values(d.reads).includes("failed");

  function resultView(d, name, f, share) {
    const mark = (state) => glyph(state === "done" ? "done" : state === "failed" ? "failed" : "queued");
    const reads = READ_ROWS.map(([key, label, items]) => {
      const r = d.reads[key];
      const [state, words] = r === "absent" ? ["done", `No matching ${items} listed`] : r === "listed" ? ["failed", "Still listed"] : ["unknown", `Couldn't check ${items}`];
      return `<li data-state="${state}" data-lc-read="${key}">${mark(state)}<span>${label}: ${words}</span></li>`;
    }).join("");
    const reply = d.reply;
    const path = (pth, words, state) => `<li data-state="${state}" data-lc-path="${pth}">${mark(state)}<span><span class="mono">${pth}</span>: ${words}</span></li>`;
    let paths = "";
    if (!d.files)
      paths =
        `<p class="b-hint" data-lc-nofolders>No folders requested for Trash.${d.reads.tasks === "absent" ? " No active tasks are listed. The gateway may archive their transcripts." : ""}</p>`;
    else if (!reply?.refused) {
      // Every path the confirmation named, then any other the answer reported.
      const named = [f.folder, `agents/${d.bot}/agent`, `agents/${d.bot}/sessions`];
      const removed = new Map(reply?.removed || []);
      const failed = new Map(reply?.failed || []);
      const line = (pth) =>
        removed.get(pth) === "trash"
          ? path(pth, "Gateway reported moving this to Trash", "done")
          : removed.get(pth) === "missing"
            ? path(pth, "Gateway reported this path was already gone", "done")
            : failed.has(pth)
              ? path(pth, `Gateway couldn't move this: ${failed.get(pth)}`, "failed")
              : path(pth, `The gateway didn't confirm what happened to this path${pth === f.folder && share.length ? `. ${esc(share.join(" and "))} still lists it as its workspace.` : ""}`, "unknown") ;
      const extra = [...removed.keys(), ...failed.keys()].filter((x) => !named.includes(x));
      paths =
        `<h4 class="b-group">${reply ? "Folders, as the gateway's answer reported them" : "Folders"}</h4><ul class="lc-result" aria-label="Folders">${[...named, ...extra].map(line).join("")}</ul>` +
        ([...removed.values()].includes("trash") ? `<p class="b-hint">What was moved to the Trash on the gateway's machine can be restored from there until it's emptied.</p>` : "");
    }
    const head =
      (reply?.refused
        ? note(`<p><b>The gateway refused the request.</b> “${esc(reply.refused)}”</p>`, "danger") +
          `<p class="b-hint">Other bots use sign-ins kept in ${name}'s folder. The gateway's owner moves them first, on the gateway's machine.</p>`
        : "") +
      (!reply
        ? `<p class="b-hint lc-first">Clawtrate didn't get the delete result. You asked to ${d.files ? "move the folders to the Trash" : "leave the folders in place"}. Check again reads the gateway.</p>`
        : "") +
      (reply?.purgeFailed ? `<p class="b-hint" data-lc-purge>The gateway reported a task-store cleanup failure and skipped moving folders on this attempt.</p>` : "") +
      (d.checked ? `<p class="b-hint">Read again just now.</p>` : "");
    // No retry of a delete: a request carries only an id, which may name a bot made since.
    const actions = deleteNeedsCheck(d)
      ? button("Check again", 'data-lc="del-check" data-size="lg" data-lc-focus', "primary") + button("Close", 'data-lc="close" data-size="lg"', "quiet")
      : button("Close", 'data-lc="close" data-size="lg" data-lc-focus');
    return sheet(deleteTitle(d, name), head + `<p class="b-hint lc-first">Read back from the gateway just now:</p><ul class="lc-result" aria-label="What the gateway has now">${reads}</ul>` + paths, actions);
  }
  // The live region says what the title says, and what came back in place of an answer.
  const deleteAnnouncement = (d) => (d.reply?.refused ? "The gateway refused the request" : !d.reply ? "Clawtrate didn't get the delete result" : deleteTitle(d, d.botName));
  // The rail follows the bot list's read, not the answer.
  function followRoster(d) {
    if (d.reads.bots !== "absent" || !botOf(d.bot)) return;
    const i = app.bots.findIndex((b) => b.id === d.bot);
    app.bots.splice(i, 1);
    if (L.primary === d.bot) L.primary = null;
    if (app.model.selectedBot === d.bot) app.selectBot(app.bots[0].id);
    else refreshRail();
  }

  function runDelete() {
    const d = L.dialog;
    // The bot was replaced after the preview: the same id, another creation record. Nothing is sent.
    if (p("delreplaced") && !d.replacedShown) {
      d.status = "checking";
      paint();
      return setTimeout(() => {
        d.replacedShown = true;
        CREATED[d.bot] += 1;
        d.status = "replaced";
        paint(true);
        announce(CHANGED_WORDS);
      }, 400);
    }
    // The preview is read again before anything is sent; a change asks again.
    if (p("delchanged") && !d.changed) {
      d.status = "checking";
      paint();
      return setTimeout(() => {
        d.status = null;
        d.changed = true;
        d.tasks = FACTS[d.bot].tasks + 1;
        paint(true);
        announce(`What ${d.botName} has changed. Check it, then delete again.`);
      }, 400);
    }
    d.status = "deleting";
    d.busy = true;
    L.calls.push(["agents.delete", d.bot]);
    paint(true);
    setTimeout(() => {
      d.busy = false;
      d.reply = deleteReply(d, FACTS[d.bot]);
      d.reads = deleteReads(d);
      d.status = "result";
      followRoster(d);
      paint(true);
      announce(deleteAnnouncement(d));
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
      if (L.dialog.status === "failed" || L.dialog.status === "noread") L.dialog.status = null;
      paint();
      $(`[data-lc-pick="${L.dialog.pick}"]`, dialog)?.focus();
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
        // Read tier: closes for this app session and writes nothing. Write tier: users.prefs
        // {bot: null}, "keep the gateway's default", read back, so the dialog doesn't come back.
        if (B.access !== "read") L.calls.push(["users.prefs.set", null]), (L.primary = null);
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
        if (L.dialog.status === "noread") {
          // Check again reads the preference; it writes nothing. Here the read shows the choice landed.
          L.dialog.status = "unconfirmed";
          paint();
          return setTimeout(() => applyPrimary(L.dialog.pick), 500);
        }
        return savePrimary(L.dialog.pick || primaryId());
      case "open-picture":
        return openDialog("picture", el, { bot: app.model.selectedBot, tab: p("ptab") || "bot", upload: p("upload") || null });
      case "browse":
        L.dialog.upload = "crop";
        paint();
        return $('[data-lc="set-picture"]', dialog)?.focus();
      case "set-picture":
        return setPicture();
      case "allow-picture": {
        // Kept on this device, per gateway, bot and exact address; nothing is written to the gateway.
        const id = app.model.selectedBot;
        L.allowed[id] = OUTSIDE[id];
        hero.dataset.lc = "";
        decorateHero();
        paintAllowed();
        $('[data-lc="open-picture"]', hero)?.focus();
        return announce(`Loading ${nameOf(id)}'s picture`);
      }
      case "edit-name":
        return startEdit("name");
      case "edit-label":
        return startEdit("label");
      case "rename-rail":
        return setTimeout(() => renameInRail(bot), 0);
      case "instr-save":
        return saveInstructions(app.model.selectedBot);
      case "instr-mine":
        return saveMine(app.model.selectedBot, el.dataset.lcFile);
      case "instr-check":
        return checkInstruction(app.model.selectedBot, el.dataset.lcFile);
      case "instr-theirs": {
        const id = app.model.selectedBot;
        const st = IS(id);
        const k = el.dataset.lcFile;
        instr(id)[k] = st.theirs[k];
        if (st.draft) st.draft[k] = st.theirs[k];
        delete st.rows[k];
        if (st.draft && Object.keys(FILES).every((x) => st.draft[x] === instr(id)[x])) st.draft = null;
        CT.botsRender();
        return announce("Showing the gateway's copy");
      }
      case "open-instructions":
        return CT.botsOpenSettings("juniper", "instructions");
      case "open-duplicate":
        return openDialog("duplicate", el.closest("#rail-menu") ? $(`#bot-list .bot[data-bot="${bot}"]`) : el, { bot, name: `${nameOf(bot)} copy`, copy: { look: true, model: true, instr: true, tools: true }, acct: null });
      case "dup-go":
        return runDuplicate();
      case "dup-retry":
        return retryRows(L.dialog);
      case "dup-check":
        return checkRows(L.dialog);
      case "dup-check-create": {
        // Reads the bot list; writes nothing. Here it answers, listing a bot of that name.
        const d = L.dialog;
        return setTimeout(() => {
          d.roster = "listed";
          listNewBot(d);
          paint(true);
          announce("Couldn't confirm creation");
        }, 300);
      }
      case "dup-open": {
        const nid = L.dialog.newId;
        closeDialog();
        return app.selectBot(nid);
      }
      case "open-export":
        openDialog("export", el.closest("#rail-menu") ? $(`#bot-list .bot[data-bot="${bot}"]`) : el, { bot, exp: null, files: {}, read: "loading" });
        return readExport(L.dialog);
      case "open-import":
        // From the gateway menu too, which every tier has; the "+" menu is absent at the read tier.
        if (!$("#gateway-menu").hidden) {
          $("#gateway-menu").hidden = true;
          $$('[data-action="gateway-menu"]').forEach((x) => x.setAttribute("aria-expanded", "false"));
        }
        return openDialog("import", $("#new-button"), { kind: "import", stage: null, name: "Wren", copy: { look: true, model: true, instr: true } });
      case "open-delete":
        return openDialog("delete", el.closest("#rail-menu") ? $(`#bot-list .bot[data-bot="${bot}"]`) : el, { bot, files: Boolean(p("files")), read: p("delread") || null });
      case "export-file": {
        // The bytes the review showed go to the host as they are; nothing is read again.
        const d = L.dialog;
        d.bytes ??= exportBytes(d.candidate, d.files);
        L.handoff = d.bytes;
        d.exp = "saving";
        paint();
        return setTimeout(() => {
          const want = p("exp");
          d.exp = want && EXPORT_WORDS[want] && !d.retried ? ((d.retried = !["saved", "web", "saved-anyway"].includes(want)), want) : "saved";
          paint(true);
          announce(EXPORT_WORDS[d.exp](sizeOf(d.bytes))[0]);
        }, 300);
      }
      case "export-reload":
        return readExport(L.dialog);
      case "export-reread":
        return readExport(L.dialog);
      case "import-choose":
        L.dialog.stage = "reading";
        L.dialog.refused = null;
        paint();
        return setTimeout(() => {
          L.dialog.stage = Object.keys(REFUSALS).includes(p("imp")) && !L.dialog.triedOther ? ((L.dialog.triedOther = true), "refused") : "review";
          paint(true);
          announce(L.dialog.stage === "review" ? "Showing what the file would create" : "Clawtrate can't read this file");
        }, 400);
      case "import-add":
        // A model this gateway doesn't offer is left out, and its effort and fallback list with it.
        L.dialog.copy.model = p("imp") !== "unavailable";
        return runDuplicate();
      case "del-reread":
        L.dialog.read = null;
        return paint(true);
      case "del-go":
        return runDelete();
      case "del-check": {
        // Reads the lists again. The answer, or its absence, stays as it was.
        const d = L.dialog;
        d.status = "checking";
        paint();
        return setTimeout(() => {
          d.status = "result";
          d.checked = true;
          d.reads = deleteReads(d);
          followRoster(d);
          paint(true);
          announce(`Read again. ${deleteTitle(d, d.botName)}`);
        }, 400);
      }
    }
  });
  document.addEventListener("change", (e) => {
    const c = e.target.closest("[data-lc-copy]");
    if (c) {
      L.dialog.copy[c.dataset.lcCopy] = c.checked;
      paint();
      $(`[data-lc-copy="${c.dataset.lcCopy}"]`, dialog)?.focus();
    }
    const ef = e.target.closest("[data-lc-expfile]");
    if (ef) {
      L.dialog.files[ef.dataset.lcExpfile] = ef.checked;
      L.dialog.bytes = null;
      paint();
      $(`[data-lc-expfile="${ef.dataset.lcExpfile}"]`, dialog)?.focus();
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
      // agents.create records the bot's creation, which agents.list then reports.
      CREATED[made] ??= Date.now();
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

  new MutationObserver(() => paintAllowed($("#bot-list"))).observe($("#bot-list"), { childList: true });
  // First paint: a dialog from the address.
  refreshRail();
  decorateHero();
  roleLine();
  const start = p("lc");
  if (start === "intro") openDialog("intro", $("#bot-list .bot"));
  if (start === "choose") openDialog("choose", $("#bot-list .bot"));
  if (start === "picture") openDialog("picture", $(".lc-hero-pic") || hero, { bot: app.model.selectedBot, tab: p("ptab") || "bot", upload: p("upload") || null });
  if (start === "duplicate") openDialog("duplicate", null, { bot: p("delbot") || app.model.selectedBot, name: `${nameOf(p("delbot") || app.model.selectedBot)} copy`, copy: { look: true, model: true, instr: true, tools: true }, acct: null });
  if (start === "export") openDialog("export", null, { bot: p("delbot") || app.model.selectedBot, exp: null, files: {}, read: "loading" }), readExport(L.dialog);
  if (start === "import") openDialog("import", $("#new-button"), { kind: "import", stage: p("imp") ? "reading" : null, name: "Wren", copy: { look: true, model: true, instr: true } });
  if (start === "import" && p("imp")) setTimeout(() => { L.dialog.stage = Object.keys(REFUSALS).includes(p("imp")) ? ((L.dialog.triedOther = true), "refused") : "review"; paint(); }, 0);
  if (start === "delete") openDialog("delete", null, { bot: p("delbot") || app.model.selectedBot, files: Boolean(p("files")), read: p("delread") || null });
})();
