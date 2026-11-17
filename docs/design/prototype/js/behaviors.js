// The behaviours the components need, shared by the gallery and the scripted
// conversation: the two views of a step, Raw, copy, the approval form, question
// cards, and their keyboard paths. Expanding uses the browser's own <details>.

(function () {
  const CT = window.CT;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const mod = (event) => event.metaKey || event.ctrlKey;

  // One polite live region for the whole conversation.
  let announcer = null;
  CT.announce = (text) => {
    if (!announcer) {
      announcer = document.createElement("div");
      announcer.id = "announcer";
      announcer.className = "visually-hidden";
      announcer.setAttribute("role", "status");
      announcer.setAttribute("aria-live", "polite");
      document.body.appendChild(announcer);
    }
    announcer.textContent = "";
    requestAnimationFrame(() => (announcer.textContent = text));
  };

  // Prototype only: says where a control leads when its destination is outside this design.
  let toastTimer = null;
  CT.toast = (text) => {
    let node = $("#proto-toast");
    if (!node) {
      node = document.createElement("div");
      node.id = "proto-toast";
      node.className = "proto-toast";
      document.body.appendChild(node);
    }
    node.textContent = text;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (node.hidden = true), 5000);
    CT.announce(text);
  };

  // Replace a node and keep keyboard focus: on the same kind of control when
  // there is one, otherwise on the replacement itself.
  CT.swap = (node, html) => {
    const active = document.activeElement;
    const had = node.contains(active);
    const key = had && (active.dataset.action || active.dataset.decision || active.tagName);
    node.insertAdjacentHTML("afterend", html);
    const next = node.nextElementSibling;
    node.remove();
    if (had) {
      const same = key && $(`[data-action="${key}"], [data-decision="${key}"]`, next);
      (same && !same.disabled ? same : $("summary", next) || next).focus({ preventScroll: true });
    }
    return next;
  };

  // Copy ------------------------------------------------------------------------------

  const sourceOf = (button) =>
    button.closest(".code-head")?.nextElementSibling ||
    button.closest(".command-line")?.querySelector("code") ||
    button.closest("dd")?.querySelector("span") ||
    button.closest(".access-id")?.querySelector(".mono");

  async function copy(button) {
    const source = sourceOf(button);
    const text = button.dataset.copy ?? source?.textContent ?? "";
    const what = button.dataset.what || "text";
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = false;
    }
    const icon = button.classList.contains("copy");
    if (ok) {
      button.dataset.copied = "true";
      if (icon) button.innerHTML = CT.icon("check");
      CT.announce(button.dataset.copyNote ? `Copied ${button.dataset.copyNote}` : `Copied ${what}`);
    } else {
      // Nothing claims success: the text is selected so the user can copy it.
      button.dataset.copied = "failed";
      if (icon) button.innerHTML = CT.icon("warning");
      if (source) {
        const range = document.createRange();
        range.selectNodeContents(source);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      CT.announce("Couldn't copy. The text is selected.");
    }
    setTimeout(() => {
      delete button.dataset.copied;
      if (icon) button.innerHTML = CT.icon("copy");
    }, 1400);
  }
  CT.copy = copy;

  // The two views of a step -----------------------------------------------------------

  function showView(button, focus = false) {
    const list = button.closest('[role="tablist"]');
    const body = button.closest(".step-body");
    $$('[role="tab"]', list).forEach((tab) => {
      const on = tab === button;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1; // one tab stop for the list
    });
    $$(":scope > [data-view]", body).forEach((panel) => (panel.hidden = panel.dataset.view !== button.dataset.viewButton));
    if (focus) button.focus();
  }

  // Raw on a card ---------------------------------------------------------------------

  function toggleRaw(button, open = button.getAttribute("aria-expanded") !== "true") {
    button.setAttribute("aria-expanded", String(open));
    document.getElementById(button.getAttribute("aria-controls")).hidden = !open;
  }

  // The approval's standing-allow form --------------------------------------------------

  function setForm(card, open) {
    const main = $('[data-row="main"]', card);
    const form = $(".standing", card);
    if (!form) return;
    main.hidden = open;
    form.hidden = !open;
    const opener = $('[data-action="standing-open"]', card);
    opener.setAttribute("aria-expanded", String(open));
    (open ? $("[data-decision]", form) : opener).focus();
  }

  // A routine's grant takes a lifetime in whole days, 1 to 3650; empty leaves the gateway's default.
  function setDays(form) {
    const input = $(".days input", form);
    const value = Number(input.value);
    const valid = input.value === "" || (Number.isInteger(value) && value >= 1 && value <= 3650);
    $(".days-error", form).hidden = valid;
    $('[data-decision="always"]', form).disabled = !valid;
  }

  // Approvals answered where nothing else is listening (the gallery). The scripted
  // run handles its own card and prevents this.
  function resolveApproval(card, decision) {
    const def = CT.defs[card.id] || {};
    const base = { id: card.id, bot: def.bot, line: def.line || card.dataset.line, when: "5:25 PM", full: def.full, open: true };
    if (decision === "next-time") {
      $(".standing", card).outerHTML = `<p class="request-foot">Rule saved for next time. Nothing was run.</p>`;
      $('[data-row="main"]', card)?.remove();
      CT.announce("Rule saved for next time");
      return;
    }
    if (decision === "always") {
      // Not marked resolved until the gateway answers that it applied the decision.
      const form = $(".standing", card);
      const days = $(".days input", form)?.value || "";
      form.outerHTML = CT.standing({ bot: def.bot, request: def.request, kind: def.kind, open: true, sent: "sending" });
      $(".standing [data-decision='deny']", card).focus();
      setTimeout(() => {
        if (!document.contains(card) || card.dataset.state !== "pending") return;
        CT.swap(card, CT.approvalResolved({ ...base, state: "always", saved: { kind: def.kind, request: def.request, days }, raw: CT.samples.approvalRaw("allow-always") }));
        CT.announce("Allowed, and saved");
      }, 900);
      return;
    }
    const state = decision === "once" ? "once" : "denied";
    CT.swap(card, CT.approvalResolved({ ...base, state, raw: CT.samples.approvalRaw(decision === "once" ? "allow-once" : "deny") }));
    CT.announce(state === "once" ? "Allowed once" : "Denied");
  }

  // "Check again", when no answer came: the client asks the gateway for the
  // request's state. Here the gateway answers that the earlier decision was applied.
  function checkDecision(card) {
    const def = CT.defs[card.id] || {};
    const button = $('[data-action="check-decision"]', card);
    button.disabled = true;
    button.textContent = "Checking…";
    setTimeout(() => {
      if (!document.contains(card)) return;
      CT.swap(
        card,
        CT.approvalResolved({
          id: card.id,
          bot: def.bot,
          line: def.line || card.dataset.line,
          when: "5:25 PM",
          full: def.full,
          open: true,
          state: "always",
          saved: { kind: def.kind, request: def.request },
          raw: CT.samples.approvalRaw("allow-always"),
        }),
      );
      CT.announce("The gateway had applied your decision: allowed, and saved");
    }, 700);
  }

  // Question cards --------------------------------------------------------------------

  const blocks = (card) => $$(".question", card);
  const chosen = (block) => $$('.option[aria-checked="true"]', block);
  const own = (block) => $(".own-answer input", block).value.trim();
  const answeredBlock = (block) => chosen(block).length > 0 || own(block) !== "";

  function refreshQuestion(card) {
    const list = blocks(card);
    const done = list.filter(answeredBlock).length;
    const send = $('[data-action="send-answers"]', card);
    if (send) {
      send.disabled = done !== list.length;
      $(".question-count", card).textContent =
        list.length > 1 ? `${done} of ${list.length} answered` : chosen(list[0]).length ? `${chosen(list[0]).length} chosen` : own(list[0]) ? "Your own answer" : "Nothing chosen yet";
    }
    const ownSend = $('[data-action="answer-own"]', card);
    if (ownSend) ownSend.disabled = !own(list[0]);
  }

  function pick(option) {
    const block = option.closest(".question");
    if (option.getAttribute("role") === "radio") {
      $$(".option", block).forEach((other) => {
        other.setAttribute("aria-checked", String(other === option));
        other.tabIndex = other === option ? 0 : -1;
      });
    } else {
      option.setAttribute("aria-checked", String(option.getAttribute("aria-checked") !== "true"));
    }
    $(".own-answer input", block).value = ""; // an option replaces a typed answer
    const card = option.closest(".request");
    refreshQuestion(card);
    // One question with one answer: choosing answers at once.
    if (!$('[data-action="send-answers"]', card)) resolveQuestion(card, "answered");
  }

  function resolveQuestion(card, state) {
    const def = CT.defs[card.id] || { questions: [] };
    const questions = blocks(card).map((block, i) => ({
      title: def.questions[i]?.title || $(".options", block).getAttribute("aria-label"),
      answers: own(block)
        ? [["", own(block)]]
        : chosen(block).map((option) => [option.dataset.letter, option.querySelector(":scope > span:nth-child(2)").firstChild.textContent]),
    }));
    const event = new CustomEvent("ct:question", { bubbles: true, detail: { card, state, questions } });
    const parent = card.parentElement;
    const next = CT.swap(
      card,
      CT.questionAnswered({
        id: card.id,
        questions,
        state,
        raw: CT.samples.questionRaw(state === "answered" ? { answers: questions.map((q) => q.answers.map(([, text]) => text)) } : { dismissed: true }),
      }),
    );
    next.focus({ preventScroll: true });
    CT.announce(state === "answered" ? "Answer sent" : "Question dismissed");
    parent.dispatchEvent(event);
  }
  CT.resolveQuestion = resolveQuestion;

  // Clicks ------------------------------------------------------------------------------

  let suppressClick = false; // set by a touch-and-hold, so the hold does not also toggle

  document.addEventListener(
    "click",
    (event) => {
      if (suppressClick) {
        suppressClick = false;
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );

  document.addEventListener("click", (event) => {
    const target = event.target;

    const viewButton = target.closest("[data-view-button]");
    if (viewButton) return showView(viewButton);

    const copyButton = target.closest('.copy, [data-action="copy-text"]');
    if (copyButton) {
      event.preventDefault();
      return copy(copyButton);
    }

    const action = target.closest("[data-action]")?.dataset.action;
    const actor = target.closest("[data-action]");

    // Long output: show the rest, and fold it again.
    if (action === "unclip") {
      const block = actor.closest(".code-more").previousElementSibling.matches(".code-truncated")
        ? actor.closest(".code-more").previousElementSibling.previousElementSibling
        : actor.closest(".code-more").previousElementSibling;
      const open = block.dataset.clipped === "true";
      block.dataset.clipped = String(!open);
      actor.setAttribute("aria-expanded", String(open));
      actor.textContent = open ? "Show fewer" : `Show all ${actor.dataset.lines} lines`;
      return;
    }

    if (action === "raw") return toggleRaw(actor);

    // Loading again, in the prototype, ends with what a gateway that kept nothing would say.
    if (action === "raw-retry" || action === "step-retry") {
      const holder = actor.closest(".raw-state");
      holder.removeAttribute("data-tone");
      holder.setAttribute("aria-busy", "true");
      holder.textContent = action === "raw-retry" ? "Loading what the gateway sent…" : "Loading this step…";
      setTimeout(() => {
        holder.removeAttribute("aria-busy");
        holder.textContent = "The gateway did not keep this event.";
      }, 700);
      return;
    }

    if (action === "standing-open" || action === "standing-close") return setForm(actor.closest(".request"), action === "standing-open");

    if (action === "check-decision") return checkDecision(actor.closest(".request"));

    const decision = target.closest("[data-decision]");
    if (decision) {
      const card = decision.closest(".request");
      const notice = new CustomEvent("ct:decision", { bubbles: true, cancelable: true, detail: { card, decision: decision.dataset.decision } });
      if (card.dispatchEvent(notice)) resolveApproval(card, decision.dataset.decision);
      return;
    }

    const option = target.closest(".option");
    if (option) return pick(option);
    if (action === "send-answers" || action === "answer-own") return resolveQuestion(actor.closest(".request"), "answered");
    if (action === "dismiss-question") return resolveQuestion(actor.closest(".request"), "dismissed");

    // The full exchange opens in place of the two rows, and folds back.
    if (action === "full-exchange") {
      const body = actor.closest(".messaged-body");
      const open = actor.getAttribute("aria-expanded") !== "true";
      actor.setAttribute("aria-expanded", String(open));
      $('[data-exchange="one"]', body).hidden = open;
      $('[data-exchange="all"]', body).hidden = !open;
      actor.firstChild.textContent = open ? "Show only this message" : "Show full exchange";
      return;
    }

    if (action === "show-card" || action === "show-approval") {
      const card = action === "show-card" ? document.getElementById(actor.dataset.card) : $('.request[data-kind="approval"][data-state="pending"]');
      if (!card) return CT.toast("In the app this scrolls to the card and focuses it.");
      card.scrollIntoView({ block: "center" });
      ($(":scope > summary", card) || card).focus({ preventScroll: true });
      return;
    }

    // A link from a tool result opens the system browser. The prototype stays on the page.
    if (action === "open-thread") {
      event.preventDefault();
      return CT.toast(`Opens ${actor.dataset.href} in your browser. Nothing is fetched before that; the prototype stays on this page.`);
    }

    if (action === "elsewhere") return CT.toast(actor.dataset.where || "That belongs to another part of the app.");
    // Outside the scripted run there is no connection to step up.
    if (action === "request-access" && !window.demo) {
      return CT.toast("Asks the gateway once for the tier that can send, stop and answer. The scripted run shows the request and its answer.");
    }
    if (action === "retry-turn") return CT.toast("Sends the same message again as a new run.");

    // Dismissing a failed turn folds it to a line that opens it again.
    if (action === "dismiss-error") {
      const card = actor.closest(".turn-error");
      card.hidden = true;
      card.insertAdjacentHTML(
        "afterend",
        `<button type="button" class="event-line" data-action="restore-error">${$(".turn-error-title", card).textContent}${CT.icon("chevron")}</button>`,
      );
      card.nextElementSibling.focus();
      return;
    }
    if (action === "restore-error") {
      const card = actor.previousElementSibling;
      card.hidden = false;
      actor.remove();
      $('[data-action="dismiss-error"]', card).focus();
    }
  });

  // Keys --------------------------------------------------------------------------------

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (!target.closest) return;

    // The Readable and Raw tabs: Left and Right move and select; Home and End go to the ends.
    if (target.matches('[role="tab"][data-view-button]') && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const tabs = $$('[role="tab"]', target.closest('[role="tablist"]'));
      const index = tabs.indexOf(target);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      return showView(tabs[next], true);
    }

    // Escape inside a Raw panel closes it and returns to its button.
    const panel = target.closest(".raw-panel");
    if (panel && event.key === "Escape") {
      const button = $(`[aria-controls="${panel.id}"]`);
      toggleRaw(button, false);
      event.stopPropagation();
      return button.focus();
    }

    const card = target.closest('.request[data-state="pending"]');
    if (!card) return;

    if (card.dataset.kind === "approval") {
      const form = $(".standing", card);
      const formOpen = form && !form.hidden;
      if (event.key === "Escape" && formOpen && !form.dataset.sent) {
        event.preventDefault();
        return setForm(card, false);
      }
      // Inside the card, ⌘↵ answers the card; it does not send the composer.
      if (mod(event) && event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        const button = formOpen ? $('.standing [data-decision="always"]', card) : $('[data-row="main"] [data-decision="once"]', card);
        return button?.click();
      }
      return;
    }

    // A question card.
    const block = target.closest(".question");
    const typing = target.matches("input");
    if (event.key === "Escape") {
      event.preventDefault();
      // The first Escape clears a typed answer; the next dismisses.
      if (typing && target.value) {
        target.value = "";
        return refreshQuestion(card);
      }
      return resolveQuestion(card, "dismissed");
    }
    if (mod(event) && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const send = $('[data-action="send-answers"]', card);
      if (send && !send.disabled) send.click();
      return;
    }
    if (typing) {
      if (event.key === "Enter" && target.value.trim() && !$('[data-action="send-answers"]', card)) {
        event.preventDefault();
        resolveQuestion(card, "answered");
      }
      return;
    }
    if (target.matches(".option") && block) {
      const options = $$(".option", block);
      const index = options.indexOf(target);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length];
        if (target.getAttribute("role") === "radio") {
          options.forEach((o) => (o.tabIndex = o === next ? 0 : -1));
        }
        return next.focus();
      }
      // An option's letter chooses it, only while focus is in that question's options.
      const byLetter = !mod(event) && !event.altKey && options.find((o) => o.dataset.letter === event.key.toUpperCase());
      if (byLetter) {
        event.preventDefault();
        byLetter.focus();
        pick(byLetter);
      }
    }
  });

  // Typing your own answer replaces the chosen options of that question.
  document.addEventListener("input", (event) => {
    const input = event.target;
    if (input.matches?.(".days input")) return setDays(input.closest(".standing"));
    if (!input.matches?.(".own-answer input")) return;
    const block = input.closest(".question");
    if (input.value) $$(".option", block).forEach((option) => option.setAttribute("aria-checked", "false"));
    refreshQuestion(input.closest(".request"));
  });

  // Touch and hold ---------------------------------------------------------------------
  // On touch, holding a step or a Messaged card offers what hover and right-click
  // offer on the desktop.

  let holdTimer = null;
  const holdTargets = ".step > summary, .messaged > summary";

  function closeSheet(focus) {
    $("#sheet-scrim")?.remove();
    $("#sheet")?.remove();
    focus?.focus();
  }
  CT.closeSheet = closeSheet;

  // items: [label, icon, fn]. The sheet is a menu at the foot of the screen.
  CT.openSheet = (items, opener, host = document.body) => {
    closeSheet();
    host.insertAdjacentHTML(
      "beforeend",
      `<div class="sheet-scrim" id="sheet-scrim"></div><div class="sheet" id="sheet"><ul class="menu" role="menu">` +
        items.map(([label, name], i) => `<li role="none"><button type="button" class="menu-item" role="menuitem" data-sheet="${i}">${CT.icon(name)}${label}</button></li>`).join("") +
        `</ul></div>`,
    );
    const sheet = $("#sheet");
    $(".menu-item", sheet).focus();
    sheet.addEventListener("click", (event) => {
      const item = event.target.closest("[data-sheet]");
      if (!item) return;
      closeSheet(opener);
      items[Number(item.dataset.sheet)][2]();
    });
    sheet.addEventListener("keydown", (event) => {
      const list = $$(".menu-item", sheet);
      const index = list.indexOf(document.activeElement);
      if (event.key === "Escape") closeSheet(opener);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        list[(index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length].focus();
      }
    });
    $("#sheet-scrim").addEventListener("click", () => closeSheet(opener));
  };

  const copyAs = (text, what) => () => {
    const button = document.createElement("button");
    button.dataset.copy = text;
    button.dataset.what = what;
    copy(button);
  };

  document.addEventListener("pointerdown", (event) => {
    if (document.documentElement.dataset.input !== "touch") return;
    const summary = event.target.closest(holdTargets);
    if (!summary) return;
    holdTimer = setTimeout(() => {
      suppressClick = true;
      const owner = summary.parentElement;
      const raw = $('.raw-panel, [data-view="raw"]', owner)?.innerText || "";
      const host = summary.closest(".app") || document.body;
      if (owner.classList.contains("step")) {
        const result = $('[data-view="readable"] .code-block, [data-view="readable"] .step-thought', owner)?.textContent || "";
        CT.openSheet([["Copy result", "copy", copyAs(result, "result")], ["Copy raw", "code", copyAs(raw, "raw")]], summary, host);
      } else {
        const sent = $(".exchange-text", owner)?.textContent || "";
        const t3 = owner.dataset.target === "t3code";
        CT.openSheet([[t3 ? "Copy sent text" : "Copy message", "copy", copyAs(sent, t3 ? "sent text" : "message")], ["Copy raw", "code", copyAs(raw, "raw")]], summary, host);
      }
    }, 500);
  });
  ["pointerup", "pointercancel", "pointermove"].forEach((type) =>
    document.addEventListener(type, (event) => {
      if (type === "pointermove" && Math.abs(event.movementX) + Math.abs(event.movementY) < 6) return;
      clearTimeout(holdTimer);
    }),
  );

  // A later T3 Code call's line leads to its thread's card, and back, by identity
  // (conversation.md, section 11.4): the thread's key and the call's id, never nearness.
  document.addEventListener("click", (event) => {
    const toThread = event.target.closest('[data-action="show-thread"]');
    const toLine = event.target.closest('[data-action="show-where"]');
    if (!toThread && !toLine) return;
    const scope = (toThread || toLine).closest(".spec-box, #transcript-inner") || document;
    if (toThread) {
      const card = [...scope.querySelectorAll(".messaged[data-thread]:not([data-line])")].find((c) => c.dataset.thread === toThread.dataset.thread);
      if (!card) return;
      card.open = true;
      const head = card.querySelector(`.t3-item[data-call="${CSS.escape(toThread.dataset.call)}"] .exchange-meta`) || card.querySelector(":scope > summary");
      head.scrollIntoView({ block: "nearest" });
      head.focus({ preventScroll: true });
    } else {
      const line = scope.querySelector(`.messaged[data-line][data-call="${CSS.escape(toLine.dataset.call)}"]`);
      if (!line) return;
      line.scrollIntoView({ block: "nearest" });
      line.querySelector(":scope > summary").focus({ preventScroll: true });
    }
  });
})();
