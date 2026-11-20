// A task's model and effort (docs/design/conversation.md, section 25): the
// model chip in the conversation's header, its menu, the Model group in the
// task's Details, the event line a change posts, and the turn's record.
//
// More address parameters, on top of bots.js:
//   tmodel=held|saving|refused|loading|failed|unreported   the chip's state
//   tmodel=unlisted|nolevels   the task on a model the list lacks, or gives with no levels
//   record=open                                            Otto's last run line, opened
//   tchange=0                                              no event line in Otto's task
// `access=read` (bots.js) shows the read-only form.

(function () {
  const CT = window.CT;
  const app = window.app;
  const params = CT.params;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const icon = (name, cls) => CT.icon(name, cls);
  const esc = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const MODELS = [
    { id: "dev-1", levels: ["off", "minimal", "low", "medium", "high", "ultra"], def: "low" },
    { id: "dev-2", levels: ["off", "minimal", "low", "medium", "high", "ultra"], def: "low" },
    { id: "dev-lite", levels: ["off", "ultra"], def: "off" },
    { id: "dev-old", levels: [], def: null, unavailable: true },
  ];
  const PROVIDER = "acme";
  const word = (level) => (level ? level[0].toUpperCase() + level.slice(1) : "Not reported");
  const levelsOf = (id) => MODELS.find((m) => m.id === id)?.levels ?? [];
  // What is known of the shown model's levels (25.2): "Not offered" only for a model listed with none.
  const known = (id) => {
    if (S.state === "loading") return "loading";
    if (S.state === "failed") return "failed";
    const m = MODELS.find((each) => each.id === id);
    return !m ? "unlisted" : m.levels.length ? "levels" : "none";
  };
  const effortWord = (id, level) => (!level && known(id) === "none" ? "Not offered" : word(level));
  const why = (id) =>
    ({
      loading: "Loading the models…",
      failed: "Couldn't load the models: The gateway did not answer in time.",
      unlisted: `${PROVIDER}/${id} isn't in the gateway's list of models, so its effort levels aren't known.`,
    })[known(id)] ?? null;
  const follow = (model, was) => {
    const m = MODELS.find((each) => each.id === model);
    if (!m || m.levels.length === 0) return null;
    return m.levels.includes(was) ? was : m.def;
  };

  const S = {
    state: params.get("tmodel") || "set",
    saved: { model: "dev-1", effort: "low" },
    held: null,
    shown: params.get("tmodel") === "refused" ? "Couldn't change the effort: thinkingLevel \"high\" is not supported for acme/dev-lite (use off|ultra)." : null,
    lines: params.get("tchange") === "0" ? [] : [{ text: "Model changed to acme/dev-2 · from the next turn", title: "Last read acme/dev-1 · Low. Changed at 5:34 PM on this device." }],
    runModel: "acme/dev-2",
  };
  if (S.state === "held") S.held = { model: "dev-2", effort: "high" };
  if (S.state === "saving") S.held = { model: "dev-2", effort: "low" };
  if (S.state === "refused")
    S.lines.push({ refused: true, text: "Couldn't change the effort to High: thinkingLevel \"high\" is not supported for acme/dev-lite (use off|ultra)", title: "dev-lite doesn't offer High. Changed at 5:40 PM on this device." });
  if (S.state === "refused") S.saved = { model: "dev-lite", effort: "off" };
  if (S.state === "loading" || S.state === "failed") S.saved = { model: "dev-lite", effort: "ultra" };
  if (S.state === "unlisted") S.saved = { model: "dev-gone", effort: "ultra" };
  if (S.state === "nolevels") S.saved = { model: "dev-old", effort: null };

  const readOnly = () => params.get("access") === "read" || app.model.access === "read";
  const otto = () => app.model.selectedBot === "otto" && app.model.selectedTask === "o1";
  const shown = () => S.held ?? S.saved;
  const name = () => (S.state === "unreported" ? "Model not reported" : shown().model);
  const label = () => {
    const v = shown();
    if (S.state === "unreported") return "Model for this task: not reported.";
    const effort = v.effort ? `${word(v.effort)} effort` : known(v.model) === "none" ? "effort not offered" : "effort not reported";
    const base = `Model for this task: ${PROVIDER}/${v.model}, ${effort}.`;
    return base + (S.state === "held" ? " Held until this turn ends." : "") + (S.state === "saving" ? " Saving." : "") + (readOnly() ? "" : " Change.");
  };
  const announce = (text) => {
    const node = $("#b-announce");
    if (node) node.textContent = text;
  };

  // The chip -----------------------------------------------------------------------------------
  function chip() {
    const side = $(".conversation-header .header-side");
    $("#t-chip")?.remove();
    if (!otto() || S.state === "unreported") return;
    const v = shown();
    const inner =
      (S.state === "held" ? icon("clock", "icon t-held") : "") +
      `<span class="t-chip-model">${esc(name())}</span>` +
      (S.state === "unreported" ? "" : `<span class="t-chip-dot" aria-hidden="true">·</span><span class="t-chip-effort">${effortWord(v.model, v.effort)}</span>`);
    const el = readOnly()
      ? Object.assign(document.createElement("p"), { innerHTML: inner })
      : Object.assign(document.createElement("button"), { type: "button", innerHTML: inner + icon("chevron", "icon t-chev") });
    el.id = "t-chip";
    el.className = "t-chip";
    el.title = label();
    el.setAttribute("aria-label", label());
    if (readOnly()) el.setAttribute("role", "note");
    else {
      el.setAttribute("aria-haspopup", "menu");
      el.setAttribute("aria-expanded", "false");
      if (S.state === "saving") el.setAttribute("aria-busy", "true");
    }
    side.append(el);
  }

  // The menu -----------------------------------------------------------------------------------
  let menu = null;
  function openMenu() {
    closeMenu(false);
    const button = $("#t-chip");
    const v = shown();
    const item = (group, value, text, checked, disabled = false, note = "") =>
      `<li role="none"><button type="button" class="menu-item" role="menuitemradio" aria-checked="${checked}" data-t-${group}="${value}"${disabled ? ' aria-disabled="true" disabled' : ""}>${text}${note ? `<span class="t-note">${note}</span>` : ""}<span class="glyph" data-state="check"></span></button></li>`;
    const loading = S.state === "loading";
    const failed = S.state === "failed";
    const levels = levelsOf(v.model);
    menu = document.createElement("ul");
    menu.className = "menu t-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Model and effort for this task");
    menu.innerHTML = loading
      ? `<li class="t-menu-wait" role="presentation" aria-busy="true">Loading models…</li>`
      : failed
        ? `<li class="t-menu-wait" role="presentation">Couldn't load the models. <button type="button" class="button" data-size="sm" data-t-retry role="menuitem">Try again</button></li>`
        : `<li role="none"><ul role="group" aria-label="Model" class="t-group"><li class="menu-label" role="presentation">Model</li>` +
          MODELS.map((m) => item("model", m.id, m.id, m.id === v.model, m.unavailable, m.unavailable ? "Not available" : "")).join("") +
          `</ul></li><li class="menu-rule" role="separator"></li>` +
          (known(v.model) === "unlisted"
            ? `<li class="t-menu-wait" role="presentation">Effort: ${esc(why(v.model))}</li>`
            : `<li role="none"><ul role="group" aria-label="Effort" class="t-group"><li class="menu-label" role="presentation">Effort</li>` +
              (levels.length ? levels.map((l) => item("effort", l, word(l), l === v.effort)).join("") : item("effort", "", "Not offered", false, true)) +
              `</ul></li>`) +
          `<li class="menu-rule" role="separator"></li>` +
          `<li class="t-menu-foot" role="presentation">For this task. Otto's own model is in its settings.</li>`;
    $(".conversation").append(menu);
    const r = button.getBoundingClientRect();
    const host = $(".conversation").getBoundingClientRect();
    menu.style.left = `${r.left - host.left}px`;
    menu.style.top = `${r.bottom - host.top + 6}px`;
    button.setAttribute("aria-expanded", "true");
    ($('[aria-checked="true"]', menu) || $(".menu-item:not([disabled])", menu) || $("[data-t-retry]", menu))?.focus();
  }
  function closeMenu(refocus) {
    if (!menu) return false;
    menu.remove();
    menu = null;
    const button = $("#t-chip");
    button?.setAttribute("aria-expanded", "false");
    if (refocus) button?.focus();
    return true;
  }
  function choose(next) {
    const running = params.get("running") === "1";
    const was = shown();
    const change = { model: next.model ?? was.model, effort: next.model ? follow(next.model, was.effort) : next.effort };
    closeMenu(true);
    if (running) {
      S.held = change;
      S.state = "held";
      announce("Held until this turn ends");
    } else {
      const parts = [];
      if (change.model !== S.saved.model) parts.push(`Model changed to ${PROVIDER}/${change.model}`);
      if (change.effort !== S.saved.effort) parts.push(parts.length ? `effort to ${word(change.effort)}` : `Effort changed to ${word(change.effort)}`);
      if (parts.length) S.lines.push({ text: `${parts.join(", ")} · from the next turn`, title: `Last read ${PROVIDER}/${S.saved.model} · ${word(S.saved.effort)}. Changed at 5:44 PM on this device.` });
      S.saved = change;
      S.held = null;
      S.state = "set";
      announce(next.model ? "Model changed for this task" : "Effort changed for this task");
    }
    draw();
    $("#t-chip")?.focus();
  }

  // The Details group ------------------------------------------------------------------------------
  function details() {
    const panel = $("#panel-details");
    $("#t-details", panel)?.remove();
    if (!otto() || !panel || S.state === "unreported") return;
    const v = shown();
    const line =
      S.state === "held"
        ? `Held until Otto's turn ends. Clawtrate will then try to save it. <button type="button" class="button" data-variant="quiet" data-size="sm" data-t-keep>Keep ${S.saved.model}</button>`
        : S.state === "saving"
          ? "Saving…"
          : S.shown
            ? `<span class="t-refused">${esc(S.shown)}</span>`
            : why(v.model)
              ? esc(why(v.model)) + (known(v.model) === "failed" ? ` <button type="button" class="button" data-variant="quiet" data-size="sm" data-t-retry>Try again</button>` : "")
              : "For this task. Otto's own model is in Settings.";
    const fixed = what => what === "effort" && known(v.model) !== "levels";
    const select = (what, value) =>
      `<button type="button" class="b-select" data-t-select="${what}" aria-haspopup="menu" aria-expanded="false" aria-label="${what === "model" ? "Model" : "Effort"} for this task: ${esc(value)}"${fixed(what) ? " disabled" : ""}>` +
      `<span class="b-select-label">${what === "model" ? "Model" : "Effort"}</span><span class="b-select-value">${esc(value)}</span>${icon("chevron", "icon b-select-chev")}</button>`;
    const body = readOnly()
      ? `<dl class="facts"><div><dt>Model</dt><dd>${esc(S.state === "unreported" ? "Not reported" : `${PROVIDER}/${v.model}`)}</dd></div><div><dt>Effort</dt><dd>${effortWord(v.model, v.effort)}</dd></div></dl>`
      : `<div class="b-pair">${select("model", name())}${select("effort", effortWord(v.model, v.effort))}</div><p class="b-hint" id="t-details-line">${line}</p>`;
    const section = document.createElement("section");
    section.id = "t-details";
    section.className = "work-section";
    section.innerHTML = `<h3>Model</h3>${body}`;
    $(".facts", panel)?.after(section);
    CT.hydrate?.(section);
  }

  // The event lines and the run's record -------------------------------------------------------------------
  function transcript() {
    const inner = $("#transcript .transcript-inner");
    if (!inner) return;
    $$(".t-event, #t-run", inner).forEach((n) => n.remove());
    if (!otto()) return;
    const run = document.createElement("details");
    run.id = "t-run";
    run.className = "t-run run-line";
    // The run line states no model and no effort for the turn (25.5): only its id.
    run.innerHTML =
      `<summary class="event-line" aria-label="Worked for 48s · 2 actions">Worked for 48s · 2 actions ${icon("chevron", "icon chevron")}</summary>` +
      `<p class="run-record"><span>Run</span><span class="mono">run-7c41d09e</span></p>`;
    if (params.get("record") === "open") run.open = true;
    inner.append(run);
    for (const line of S.lines) {
      const p = document.createElement("p");
      p.className = "event-line t-event";
      p.dataset.side = "center";
      p.title = line.title;
      p.setAttribute("aria-label", `${line.text}. ${line.title}`);
      if (line.refused) p.dataset.tone = "warn";
      p.innerHTML = (line.refused ? icon("warning", "icon") : "") + esc(line.text);
      inner.append(p);
    }
    CT.hydrate?.(inner);
  }

  // Drawing changes what the observer below watches; its own changes are not news.
  let observer = null;
  function draw() {
    observer?.disconnect();
    const focusChip = document.activeElement?.id === "t-chip";
    chip();
    details();
    transcript();
    if (focusChip) $("#t-chip")?.focus();
    observer?.takeRecords();
    watch();
  }

  // Wiring ---------------------------------------------------------------------------------------------
  document.addEventListener("click", (event) => {
    const target = event.target.closest("#t-chip, [data-t-model], [data-t-effort], [data-t-keep], [data-t-raw], [data-t-select], [data-t-retry]");
    if (!target) {
      if (menu && !event.target.closest(".t-menu")) closeMenu(false);
      return;
    }
    if (target.id === "t-chip") {
      if (readOnly()) return;
      menu ? closeMenu(true) : openMenu();
    } else if (target.dataset.tModel !== undefined) choose({ model: target.dataset.tModel });
    else if (target.dataset.tEffort !== undefined) choose({ effort: target.dataset.tEffort });
    else if (target.dataset.tKeep !== undefined) {
      S.held = null;
      S.state = "set";
      announce(`Keeping ${S.saved.model}`);
      draw();
    } else if (target.dataset.tRaw !== undefined) {
      const raw = target.closest("details").querySelector(".t-raw");
      raw.hidden = !raw.hidden;
      target.setAttribute("aria-expanded", String(!raw.hidden));
    } else if (target.dataset.tSelect !== undefined) {
      openMenu();
    } else if (target.dataset.tRetry !== undefined) {
      S.state = "set";
      openMenu();
    }
  });
  document.addEventListener(
    "keydown",
    (event) => {
      const chipFocused = document.activeElement?.id === "t-chip";
      if (chipFocused && !menu && ["Enter", " ", "ArrowDown"].includes(event.key) && !readOnly()) {
        event.preventDefault();
        event.stopPropagation();
        openMenu();
        return;
      }
      if (!menu) return;
      const items = $$(".menu-item:not([disabled]), [data-t-retry]", menu);
      const at = items.indexOf(document.activeElement);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
        next?.focus();
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        (event.key === "Home" ? items[0] : items[items.length - 1])?.focus();
      } else if (event.key === "Tab") closeMenu(false);
    },
    true,
  );

  // The app re-renders its header, transcript and Work pane; the pieces are drawn again after it.
  observer = new MutationObserver(() => draw());
  function watch() {
    for (const el of [$("#title-pill"), $("#transcript"), $("#panel-details")]) if (el) observer?.observe(el, { childList: true });
  }
  draw();
  CT.taskModel = { state: S, draw };
})();
