// A scripted run, played inside a copy of the shell.
//
// The script is a list of moments. Each waits a little, then changes the page
// the way a gateway event would. The waits stand in for the time between
// events; nothing in the interface itself waits. Play runs the script, Step
// advances one moment, and the approval and the question pause it until the
// viewer answers. Stop, steer, queue, hold and the menus work at any point.
//
//   ?tier=read      start on a read-only connection, with the access bar
//   ?stopfail=1     the first Stop request fails
//
// From the console or a test:  demo.runTo("approval"), demo.answer("once")

(function () {
  const CT = window.CT;
  const S = CT.samples;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const root = $("#root");
  const shell = $(".shell");
  const transcript = $("#transcript");
  const inner = $("#transcript-inner");
  const other = $("#transcript-other");
  const rail = $("#rail-list");
  const composerSlot = $("#composer-slot");
  const touch = () => document.documentElement.dataset.input === "touch";

  // State of the page --------------------------------------------------------------

  const state = {
    run: "idle", // idle, running, waiting, stopping
    phase: "idle", // the avatar state
    phrase: "",
    clock: 0, // simulated seconds since the page opened
    runStart: 0,
    steps: 0,
    failed: 0,
    pinned: true,
    text: "",
    mode: "steer", // what plain Enter does during a run: steer or queue
    menu: false,
    queued: [], // start the next run, in order
    held: [], // kept while a question is pending; released when the last one is settled
    unsent: [], // what was held or queued when Stop was confirmed: nothing starts by itself
    outbox: [], // written offline; the host sends them on reconnect
    files: [],
    notices: [],
    pending: [], // ids of pending cards, oldest first
    tier: CT.params.get("tier") === "read" ? "read" : "interactive",
    access: "read", // read, asking, requested, denied, expired
    view: "otto", // which task is on screen: otto, or marlow's receiving side
    marlow: { state: "idle", preview: "Tightened the intro and cut about 80 words.", time: "4:58 PM", unread: false },
    marlowCard: "",
    t3: "",
    newTasks: [],
    offline: false,
    stopFails: CT.params.get("stopfail") === "1",
    instant: false,
    speed: 1,
  };

  const clockTime = (offset = 0) => {
    const minutes = 24 + Math.floor((state.clock + offset) / 60);
    return `5:${String(minutes).padStart(2, "0")} PM`;
  };
  const elapsed = () => {
    const seconds = Math.max(0, Math.round(state.clock - state.runStart));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const duration = () => {
    const seconds = Math.max(1, Math.round(state.clock - state.runStart));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  };
  const canWrite = () => state.tier === "interactive";
  const pendingKind = () => (state.pending.includes("question") ? "question" : state.pending.length ? "approval" : "");
  const oldestPending = () => document.getElementById(state.pending[0]);

  // Following: a reader near the end stays at the end ---------------------------------

  const TOP_BAND = 104; // the header and the strip's band
  const nearBottom = () => transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 96;
  transcript.addEventListener("scroll", () => {
    state.pinned = nearBottom();
    renderJump();
  });

  // keep: something the reader just opened. Following never pushes its first line out of view.
  function follow(keep) {
    if (state.view !== "otto") return;
    if (!state.pinned && keep) {
      // Not following: what the reader opened is brought into view by the smallest
      // scroll that shows it, and never past its first line.
      const box = transcript.getBoundingClientRect();
      const rect = keep.getBoundingClientRect();
      const down = Math.min(rect.bottom - box.bottom + 12, rect.top - box.top - TOP_BAND);
      if (down > 0) transcript.scrollTop += down;
    }
    if (state.pinned) {
      let top = transcript.scrollHeight - transcript.clientHeight;
      if (keep) {
        const offset = keep.getBoundingClientRect().top - transcript.getBoundingClientRect().top + transcript.scrollTop;
        top = Math.min(top, offset - TOP_BAND);
      }
      transcript.scrollTop = top;
      state.pinned = nearBottom();
    }
    renderJump();
  }

  // The shelf or the composer changing height changes the view, not the reader's intent.
  new ResizeObserver(() => follow()).observe(transcript);
  // Opening something (a step, a card, the full request) keeps what the reader
  // opened in view. Only the reader's own action counts: a block that folds by
  // itself at the end of a run is an ordinary change.
  let opened = null;
  const noteOpened = (event) => {
    const summary = event.target.closest?.("summary");
    if (summary && (event.type === "click" || event.key === "Enter" || event.key === " ")) opened = summary.parentElement;
  };
  transcript.addEventListener("click", noteOpened, true);
  transcript.addEventListener("keydown", noteOpened, true);
  transcript.addEventListener(
    "toggle",
    (event) => {
      follow(event.target === opened && event.target.open ? opened : undefined);
      opened = null;
    },
    true,
  );

  // Jump to latest: a pending card first, then a live run, then new output. It
  // shows only while its destination is out of view.
  function renderJump() {
    const slot = $("#jump-slot");
    const box = transcript.getBoundingClientRect();
    const card = state.view === "otto" && oldestPending();
    if (card) {
      const rect = card.getBoundingClientRect();
      const above = rect.bottom < box.top + TOP_BAND;
      const below = rect.top > box.bottom - 40;
      slot.innerHTML = above || below ? CT.jump({ state: "needs-you", phrase: "Needs you", up: above }) : "";
      return;
    }
    slot.innerHTML =
      state.pinned || state.view !== "otto"
        ? ""
        : state.run !== "idle" && !state.offline
          ? CT.jump({ state: "live", bot: "otto", phrase: state.phrase || "Thinking", face: state.run === "stopping" ? "idle" : state.phase })
          : CT.jump({ state: "latest" });
  }

  // Rendering ------------------------------------------------------------------------

  function renderRail() {
    const lost = state.offline;
    $("#rail-new").hidden = !canWrite();
    const taskStatus = state.run === "waiting" ? "waiting" : state.run === "idle" ? (state.stopped ? "stopped" : "idle") : "running";
    const waitingText = pendingKind() === "question" ? "Waiting for you: a question" : "Waiting for you: approve a command";
    const live = state.run !== "idle";
    const ottoPreview = !live
      ? state.lastPreview || "Yes. It finished at 3:25 AM, but it took 71 minutes."
      : lost
        ? `Last seen: ${state.phrase || "Thinking"}`
        : state.run === "waiting" && state.pending.length
          ? waitingText
          : state.phrase || "Thinking";
    const marlow = lost && state.marlow.state === "working" ? { ...state.marlow, preview: `Last seen: ${state.marlow.preview}` } : state.marlow;
    rail.innerHTML =
      CT.botGroup({ bot: "juniper", state: "idle", preview: "Ask these five, and get the answers in writing.", time: "5:24 PM", count: 3, i: 1 }) +
      CT.botGroup({ bot: "marlow", ...marlow, count: 1, current: state.view === "marlow", i: 2, id: "rail-marlow" }) +
      CT.botGroup({
        bot: "otto",
        state: live && lost ? "blocked" : state.run === "idle" && state.stopped ? "stopped" : state.phase,
        preview: ottoPreview,
        time: live ? "now" : state.lastPreview ? clockTime() : "5:02 PM",
        open: true,
        count: 3 + state.newTasks.length,
        id: "rail-otto",
        tasks:
          state.newTasks.map((title) => CT.taskRow({ title, status: "running", time: "now" })).join("") +
          CT.taskRow({ title: "Weekly backup check", status: taskStatus, current: state.view === "otto", time: live ? "now" : state.lastPreview ? clockTime() : "5:02 PM", id: "task-backup" }) +
          CT.taskRow({ title: "Disk almost full on the media box", status: "idle", time: "Mon" }) +
          CT.taskRow({ title: "Certificate renewal warning", status: "idle", time: "Sun" }) +
          (canWrite() ? `<li><button type="button" class="task task-new" data-action="elsewhere" data-where="New task belongs to the shell. app.html shows it working.">${CT.icon("plus")}<span class="task-title">New task</span></button></li>` : ""),
      }) +
      CT.botGroup({ bot: "pip", state: "done", preview: "Here is the week, with Thursday kept clear.", time: "3:10 PM", unread: true, count: 4, i: 3 });
  }

  function renderComposer() {
    const active = document.activeElement;
    const hadFocus = active?.classList.contains("composer-input");
    const focusKey = composerSlot.contains(active) ? active.dataset.action : "";
    if (state.view === "marlow") {
      // The scripted run is in Otto's task; Marlow's composer is shown, not driven.
      composerSlot.innerHTML = CT.composer({ bot: "marlow", run: state.marlow.state === "working" ? "running" : "idle" });
      $(".composer", composerSlot).inert = true;
      return renderJump();
    }
    if (!canWrite()) {
      composerSlot.innerHTML = CT.accessBar({ bot: "otto", state: state.access, seconds: state.accessSeconds || 4 });
      if (focusKey) $(`[data-action="${focusKey}"]`, composerSlot)?.focus();
      return renderJump();
    }
    const row = (kind, text, index, actions) => CT.shelfRow({ lead: CT.glyph("queued"), text: `<b>${kind}</b> <span>${CT.esc(text)}</span>`, actions });
    let shelf =
      state.queued
        .map((text, index) =>
          row(
            "Queued",
            text,
            index,
            // Send now is not offered while the run is stopping or while a question is pending.
            ((state.run === "running" || state.run === "waiting") && pendingKind() !== "question" ? CT.button("Send now", `data-queue="send" data-index="${index}"`) : "") +
              CT.button("Cancel", `data-variant="quiet" data-queue="cancel" data-index="${index}"`),
          ),
        )
        .join("") +
      state.held
        .map((text, index) =>
          row("Held until you answer", text, index, CT.button("Edit", `data-held="edit" data-index="${index}"`) + CT.button("Cancel", `data-variant="quiet" data-held="cancel" data-index="${index}"`)),
        )
        .join("");
    shelf += state.unsent
      .map((text, index) =>
        CT.shelfRow({
          lead: CT.glyph("stopped"),
          text: `<b>Not sent</b> <span>${CT.esc(text)}</span>`,
          actions: CT.button("Send", `data-unsent="send" data-index="${index}"`) + CT.button("Remove", `data-variant="quiet" data-unsent="remove" data-index="${index}"`),
        }),
      )
      .join("");
    const kind = pendingKind();
    if (state.run === "waiting" && kind) {
      shelf += CT.shelfRow({
        tone: "warn",
        lead: CT.glyph("waiting"),
        text:
          kind === "question"
            ? state.text
              ? "<b>Otto asked a question.</b> <span>A message sent now is held until you answer.</span>"
              : "<b>Otto asked you a question</b>"
            : "<b>Otto needs your approval</b> <span>to run a command</span>",
        actions: CT.button("Review", 'data-action="review"'),
      });
    }
    shelf += state.notices
      .map((notice, index) =>
        CT.shelfRow({
          tone: "danger",
          lead: CT.icon("warning"),
          text: `<b>${notice.title}</b> <span>${notice.reason}</span>`,
          actions:
            CT.button("Try again", `data-notice="retry" data-index="${index}"`) +
            `<button type="button" class="icon-button" data-variant="quiet" data-notice="dismiss" data-index="${index}" aria-label="Dismiss this notice">${CT.icon("x")}</button>`,
        }),
      )
      .join("");
    composerSlot.innerHTML = CT.composer({
      bot: "otto",
      run: state.offline ? "offline" : state.run,
      pending: kind,
      text: state.text,
      shelf,
      menu: state.menu && !touch(),
      mode: state.mode,
      files: state.files,
    });
    renderJump();
    if (hadFocus) {
      const input = $(".composer-input");
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    } else if (focusKey) {
      $(`[data-action="${focusKey}"]`, composerSlot)?.focus();
    }
  }

  // The status line is always the last thing in the transcript while a run is active.
  function renderStatus(fresh = false) {
    $(".status-line", inner)?.remove();
    if (state.run === "idle") return;
    // While the connection is down nothing here moves: the app cannot see the run.
    const lost = state.offline
      ? { state: "blocked", phrase: `Reconnecting. Last seen ${(state.phrase || "thinking").replace(/^./, (c) => c.toLowerCase())}`, elapsed: "" }
      : null;
    // On a read-only connection a wait is known only as a wait.
    const unseen = !canWrite() && state.run === "waiting" ? { state: "thinking", badge: "blocked", phrase: "Waiting for an answer" } : null;
    inner.insertAdjacentHTML(
      "beforeend",
      CT.statusLine({
        bot: "otto",
        state: state.run === "stopping" ? "stopping" : state.phase,
        phrase: state.phrase || "Thinking",
        elapsed: elapsed(),
        fresh,
        steps: state.phase === "working",
        ...unseen,
        ...lost,
      }),
    );
  }

  let spoken = "";
  function setStatus(phase, phrase) {
    const fresh = phrase !== state.phrase;
    state.phase = phase;
    state.phrase = phrase;
    renderStatus(fresh);
    renderRail();
    renderJump();
    // The announcer speaks lifecycle changes, not every phrase.
    const say = { waiting: "Otto is waiting for you", working: "Otto is working", thinking: "Otto is working" }[phase];
    if (say && say !== spoken && !state.instant) CT.announce(say);
    spoken = say || spoken;
  }

  // Add to the transcript, above the status line.
  function add(html) {
    const status = $(".status-line", inner);
    const holder = document.createElement("div");
    holder.innerHTML = html;
    const nodes = [...holder.children];
    nodes.forEach((node) => (status ? inner.insertBefore(node, status) : inner.appendChild(node)));
    follow();
    return nodes[0];
  }

  // Steps ------------------------------------------------------------------------------

  // Action cards: one feed places them in order and folds actions of one kind in a
  // row (conversation.md, section 7). Whether a card, a fold or a row is open, and
  // in which view, is the viewer's, and the feed keeps it.
  const feed = CT.feed({ insert: (html) => add(html), follow: () => follow(), instant: () => state.instant });
  const C = S.calls;

  function startAction(call) {
    state.steps += 1;
    feed.start(call);
  }

  function updateAction(id, patch) {
    if (patch.status === "failed" && feed.get(id)?.status !== "failed") state.failed += 1;
    feed.update(id, patch);
  }

  // Anything shown between cards ends their column.
  const between = (html) => {
    feed.gap();
    return add(html);
  };

  // Streaming text: words arrive in small groups, as deltas would.
  async function stream(html, { md = true } = {}) {
    const node = add(CT.msg({ md, streaming: true, html: "" }));
    const bubble = $(".bubble", node);
    if (state.instant) {
      bubble.innerHTML = html;
    } else {
      const parts = html.split(/(?<=\s)/);
      for (let i = 0; i < parts.length; i += 3) {
        if (state.halted) break;
        bubble.innerHTML = parts.slice(0, i + 3).join("") + '<span class="stream-caret"></span>';
        follow();
        await sleep(55);
      }
      if (!state.halted) bubble.innerHTML = html;
    }
    if (state.halted) {
      node.insertAdjacentHTML("afterend", CT.caption("<span>Incomplete</span>"));
      bubble.querySelector(".stream-caret")?.remove();
    }
    bubble.removeAttribute("aria-busy");
    follow();
    return node;
  }

  // Messaged cards: one place sets a card's state and body.
  function setMarlow(cardState, open) {
    state.marlowCard = cardState;
    const card = $("#m-marlow");
    card.dataset.state = cardState;
    $(":scope > summary .state", card).outerHTML = CT.state(cardState);
    $(".messaged-body", card).innerHTML = S.marlowBody(cardState);
    if (open !== undefined) card.open = open;
    if (state.view === "marlow") renderOther();
  }

  function setT3(cardState, opts) {
    state.t3 = cardState;
    const card = $("#m-t3");
    card.dataset.state = cardState;
    $(":scope > summary .state", card).outerHTML = CT.state(cardState);
    $(".messaged-body", card).innerHTML = S.t3Body(cardState, opts);
  }

  // The script -------------------------------------------------------------------------

  const sleep = (ms) => (state.instant ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms / state.speed)));

  let resolveGate = null;
  let decision = null;

  const finalAllowed =
    "<h3>Found</h3><p>Last night's backup took 71 minutes because the transcode cache was included: 182 GB that is rebuilt on demand and never needed backing up. A normal week moves about 5 GB.</p>" +
    "<h3>Changed</h3><ul><li>Moved the cache to <code>/srv/scratch</code>, outside the backed-up folder.</li><li>Added the entry Marlow wrote to <code>notes/house-log.md</code>.</li></ul>" +
    "<h3>Left</h3><ul><li>The call to T3 Code for <code>weekly.sh</code> was made. I have not seen a result.</li><li>One log I looked for was missing; I found its archived copy instead.</li></ul>";

  const finalDenied =
    "<h3>Found</h3><p>Last night's backup took 71 minutes because the transcode cache was included: 182 GB that is rebuilt on demand and never needed backing up.</p>" +
    "<h3>Changed</h3><ul><li>Added the entry Marlow wrote to <code>notes/house-log.md</code>.</li></ul>" +
    "<h3>Left</h3><ul><li>I did not move the cache, since you said no. Tonight's run will be slow again unless the exclude lands first.</li><li>The call to T3 Code for <code>weekly.sh</code> was made. I have not seen a result.</li></ul>";

  // The answer to the approval, applied as soon as it is given: the card folds to
  // one line that says what the gateway confirmed, and the run goes on.
  function answered() {
      const map = { once: ["once", "allow-once"], always: ["always", "allow-always"], deny: ["denied", "deny"] };
      const [resolvedState, event] = map[decision];
      const next = CT.swap(
        $("#approval"),
        CT.approvalResolved({
          id: "approval",
          state: resolvedState,
          line: S.approval.line,
          when: clockTime(),
          saved: decision === "always" ? { kind: "command", request: S.approval.request } : undefined,
          full: S.approval.full,
          raw: S.approvalRaw(event),
        }),
      );
      if (document.activeElement === document.body) $("summary", next).focus({ preventScroll: true });
      state.pending = state.pending.filter((id) => id !== "approval");
      state.run = "running";
      if (decision === "deny") {
        updateAction("s-exec", { status: "denied", body: S.commandBody("denied") });
        setStatus("thinking", "Thinking");
      } else {
        updateAction("s-exec", { status: "running", body: S.commandBody("running") });
        setStatus("working", "Running mv");
      }
      renderComposer();
  }

  const script = [
    {
      label: "send",
      caption: "You send. The avatar and the word Thinking appear at once.",
      wait: 0,
      fn() {
        add(CT.msg({ role: "user", html: "Find out why it was slow, fix what is safe to fix, and write it up for the house log." }));
        state.run = "running";
        state.stopped = false;
        state.runStart = state.clock;
        setStatus("thinking", "Thinking");
        renderComposer();
      },
    },
    { label: "thinking", wait: 900, sim: 1, fn: () => setStatus("thinking", "Thinking") },
    {
      label: "progress",
      caption: "A short progress message streams in above the status line.",
      wait: 500,
      sim: 2,
      fn: () => stream("On it. Reading last night's backup log first.", { md: false }),
    },
    {
      label: "first-step",
      caption: "The first action starts. Its card appears at once, in plain words, and the status line says the same: Reading backup-2026-11-15.log.",
      wait: 300,
      fn() {
        startAction({ ...C.read, id: "s-read", status: "running", body: CT.stepBody({ state: "loading" }) });
        setStatus("working", "Reading backup-2026-11-15.log");
      },
    },
    {
      label: "read-done",
      wait: 700,
      sim: 1,
      fn() {
        updateAction("s-read", { status: "done", body: S.readBody() });
        setStatus("thinking", "Thinking");
      },
    },
    {
      label: "open-block",
      caption: "The viewer opens the card: what it read and what came back. Raw is its second tab.",
      wait: 600,
      fn() {
        $("#s-read").open = true;
        follow();
      },
    },
    {
      label: "thought",
      caption: "The bot's reasoning arrives. It has no card and its text is not shown: it will sit, folded, inside the card it leads to.",
      wait: 500,
      sim: 4,
      fn: () => (state.thought = { time: "4s", text: S.thoughtText }),
    },
    {
      label: "second-read",
      wait: 500,
      fn() {
        // A second read, with nothing shown between: the card becomes "Read 2 files".
        startAction({ ...C.readFail, id: "s-read2", status: "running", isError: false, text: "", thought: state.thought, body: CT.stepBody({ state: "loading" }) });
        setStatus("working", "Reading backup-2026-11-08.log");
      },
    },
    {
      label: "step-open",
      caption: "The open card became a fold, and its first row is still open. Nothing above it moves, and actions keep arriving below.",
      wait: 400,
      demo: true,
      fn() {
        $("#s-read").open = true;
        follow();
      },
    },
    {
      label: "read-failed",
      caption: "A tool error. The fold's line says 1 failed and names it, without opening anything.",
      wait: 600,
      sim: 1,
      fn() {
        updateAction("s-read2", { status: "failed", isError: true, text: C.readFail.text, body: S.failedBody() });
        setStatus("thinking", "Thinking");
      },
    },
    {
      label: "list",
      wait: 400,
      fn() {
        startAction({ ...C.list, id: "s-list", status: "running", body: CT.stepBody({ state: "loading" }) });
        setStatus("working", "Looking in archive");
      },
    },
    {
      label: "raw",
      caption: "The open row is switched to Raw: the exact call, result, timing and ids, each with its own copy button. A folder listing came between, so the next read is a card of its own.",
      wait: 400,
      sim: 1,
      demo: true,
      fn() {
        updateAction("s-list", { status: "done", text: "backup-2026-10-04.log.gz\nbackup-2026-10-11.log.gz\nbackup-2026-10-18.log.gz\nbackup-2026-10-25.log.gz\nbackup-2026-11-01.log.gz\nbackup-2026-11-08.log.gz\nprune-2026-10.log.gz\nprune-2026-11.log.gz\nREADME", body: S.listBody() });
        $('#s-read [data-view-button="raw"]')?.click();
        startAction({ ...C.read, id: "s-read3", args: { path: "logs/archive/backup-2026-11-08.log.gz" }, text: "", status: "running", body: CT.stepBody({ state: "loading" }) });
        setStatus("working", "Reading backup-2026-11-08.log.gz");
      },
    },
    {
      label: "read3-done",
      wait: 700,
      sim: 2,
      fn() {
        updateAction("s-read3", { status: "done", text: "02:14:02 backup: start profile=weekly\n02:14:02 backup: snapshot 2026-11-08\n02:14:07 scan: 6,204 files changed since parent\n02:36:44 transfer: done 4.9 GB in 22m 37s\n02:36:58 prune: kept 12 snapshots\n02:36:59 backup: finished ok", took: "1.1s", body: S.read3Body() });
        setStatus("thinking", "Thinking");
      },
    },
    {
      label: "step-close",
      wait: 700,
      sim: 3,
      demo: true,
      fn() {
        $("#s-read").open = false;
        follow();
      },
    },
    {
      label: "found",
      wait: 300,
      sim: 3,
      fn: () => (feed.gap(), stream("Found it. The transcode cache was swept into the backup. I am asking Marlow for the log entry and calling T3 Code about the script.", { md: false })),
    },
    {
      label: "message-sending",
      caption: "Otto starts a message to Marlow. Its card is the action card for the message, and the message appears nowhere else. The start is the first thing the gateway reports; it is not proof the call was made.",
      wait: 400,
      fn() {
        add(CT.messaged({ id: "m-marlow", target: "marlow", first: S.marlowFirst, state: "call-started", body: S.marlowBody("call-started") }));
        state.marlowCard = "call-started";
        state.steps += 1;
        setStatus("working", "Messaging Marlow");
      },
    },
    {
      label: "message-started",
      caption: "Still Call started. Nothing yet shows that Marlow received it, so the card does not say Sent.",
      wait: 500,
      fn() {
        setMarlow("call-started");
      },
    },
    {
      label: "message-working",
      caption: "The gateway says Marlow accepted it, and Marlow's own run shows it working. Opened, the card shows what was sent and Marlow's status on one row.",
      wait: 600,
      sim: 1,
      fn() {
        state.marlow = { state: "working", preview: "Reading the house log", time: "now", unread: false };
        setMarlow("working", true);
        setStatus("working", "Waiting for Marlow");
        follow();
      },
    },
    {
      label: "message-replied",
      caption: "The reply names this message, so it arrives in the same card.",
      wait: 2200,
      sim: 40,
      fn() {
        state.marlow = { state: "done", preview: "Nov 16. Last night's backup ran long: 71 minutes…", time: clockTime(), unread: true };
        setMarlow("replied");
        setStatus("thinking", "Thinking");
      },
    },
    {
      label: "message-close",
      wait: 1400,
      sim: 1,
      demo: true,
      fn() {
        $("#m-marlow").open = false;
        follow();
      },
    },
    {
      label: "t3-sending",
      caption: "Otto calls T3 Code. The card is drawn from Otto's own tool call, and joins the column under Marlow's.",
      wait: 300,
      fn() {
        add(CT.messaged({ id: "m-t3", target: "t3code", first: S.t3First, state: "call-started", body: S.t3Body("call-started") }));
        state.t3 = "call-started";
        state.steps += 1;
        setStatus("working", "Calling T3 Code");
      },
    },
    {
      label: "t3-started",
      wait: 400,
      fn() {
        setT3("call-started");
      },
    },
    {
      label: "t3-sent",
      caption: "The call returns. The card says Call made: the call returned, which does not show the work is finished.",
      wait: 800,
      sim: 1,
      fn() {
        setT3("call-made");
        setStatus("thinking", "Thinking");
      },
    },
    {
      label: "review",
      caption: "The gateway reviews the command before anyone is asked. The card carries the review: Reviewing mv.",
      wait: 600,
      fn() {
        startAction({ ...C.mv, id: "s-exec", status: "review", body: S.commandBody("review") });
        setStatus("working", "Reviewing a command");
      },
    },
    {
      label: "approval",
      caption: "The review did not approve the command, so the gateway asks you. The run waits; the rail, the status line and the composer all say so. Answer the card.",
      wait: 700,
      sim: 1,
      gate: "approval",
      then: answered,
      thenCaption: "Answered. The card folds to one line that says what the gateway confirmed, and the run goes on.",
      fn() {
        updateAction("s-exec", { status: "waiting", readOnly: !canWrite(), body: S.commandBody("waiting") });
        state.run = "waiting";
        if (canWrite()) {
          between(CT.approval({ id: "approval", ...S.approval }));
          state.pending.push("approval");
          setStatus("waiting", "Waiting for you");
        } else {
          // A read-only connection is not sent the request. It knows only that the run waits.
          between(
            `<div class="turn-note" id="unseen-wait">${CT.glyph("blocked")}<div><p><b>Otto is waiting for an approval or an answer.</b> This device can't see it on a read-only connection.</p>` +
              `<p>${CT.linkButton("Request access", { action: "request-access" })}</p></div></div>`,
          );
          setStatus("thinking", "Waiting for an answer");
        }
        renderComposer();
      },
    },
    {
      label: "command-done",
      caption: "The card, not the approval, says how the command ended: Ran mv.",
      wait: 900,
      sim: 1,
      fn() {
        if (decision !== "deny") updateAction("s-exec", { status: "done", text: "", details: { status: "completed", exitCode: 0 }, took: "1.2s", body: S.commandBody("done") });
        setStatus("thinking", "Thinking");
      },
    },
    {
      label: "question",
      caption: "Otto asks a question. Answer it on the card. A message typed in the composer now is held until you do.",
      wait: 600,
      sim: 2,
      gate: "question",
      skip: () => decision === "deny" || !canWrite(),
      fn() {
        between(CT.question({ id: "question", bot: "otto", ...S.question, raw: S.questionRaw() }));
        state.pending.push("question");
        state.run = "waiting";
        setStatus("waiting", "Waiting for you");
        renderComposer();
      },
    },
    {
      label: "write",
      wait: 300,
      sim: 1,
      fn() {
        startAction({ ...C.edit, id: "s-write", status: "running", body: CT.stepBody({ state: "loading" }) });
        setStatus("working", "Editing house-log.md");
      },
    },
    {
      label: "write-done",
      wait: 500,
      sim: 1,
      fn() {
        updateAction("s-write", { status: "done", body: S.writeBody() });
        setStatus("thinking", "Thinking");
      },
    },
    { label: "answer", caption: "The answer streams into its bubble.", wait: 300, sim: 6, fn: () => (feed.gap(), stream(decision === "deny" ? finalDenied : finalAllowed)) },
    {
      label: "finished",
      caption: "Finished. The status line leaves and the run line follows the run: how long it took and how many actions, with the failure counted. Nothing folds by itself.",
      wait: 300,
      fn: () => finish(),
    },
  ];

  // Ending a run -------------------------------------------------------------------------

  function finish(outcome) {
    state.run = "idle";
    state.outcome = outcome || `Worked for ${duration()}`;
    state.stopped = Boolean(outcome);
    state.lastPreview = outcome ? "Stopped. Completed steps are not undone." : "Found: the transcode cache was included in the backup.";
    // The run line follows everything the run put in the transcript (section 7.7).
    if (state.steps) {
      feed.gap();
      add(CT.runLine({ id: "run-line", label: state.outcome, actions: state.steps, failed: state.failed, model: "scripted/dev-1", effort: "low", run: "run_7f3a91c2" }));
    }
    const status = $(".status-line", inner);
    if (status && !state.instant && !document.documentElement.dataset.motion) {
      status.dataset.leaving = "true";
      status.addEventListener("animationend", () => status.remove(), { once: true });
    } else {
      status?.remove();
    }
    state.phase = "idle";
    state.phrase = "";
    state.mode = "steer"; // the mode chosen from the menu lasts for one run
    CT.announce(outcome ? "Stopped" : "Otto finished");
    // A run that ends by itself: what was held becomes queued, and queued messages
    // start in order. After a confirmed Stop nothing starts by itself.
    state.queued.push(...state.held.splice(0));
    const next = outcome ? null : state.queued.shift();
    if (next) add(CT.msg({ role: "user", html: CT.esc(next) }) + CT.caption("<span>Was queued. In the app this starts the next run.</span>"));
    renderRail();
    renderComposer();
    follow();
  }

  // Stop asks the gateway; the run is stopping until the gateway answers.
  async function stop() {
    if (state.run !== "running" && state.run !== "waiting") return;
    const before = { run: state.run, phase: state.phase, phrase: state.phrase };
    state.run = "stopping";
    setStatus("idle", "Stopping…");
    renderComposer();
    CT.announce("Stopping");
    caption("Stop pressed. The phrase reads Stopping… until the gateway answers.");
    await new Promise((resolve) => setTimeout(resolve, 600));

    // The request can fail. Then the run is still running, and the page says so.
    if (state.stopFails) {
      state.stopFails = false;
      state.run = before.run;
      state.notices.push({ title: "Couldn't stop Otto.", reason: "The gateway did not answer the stop request.", retry: stop });
      setStatus(before.phase, before.phrase);
      renderComposer();
      CT.announce("Couldn't stop Otto");
      return caption("The stop request failed. The run is still running; the notice offers to try again.");
    }

    state.halted = true;
    resolveGate?.();
    // Confirmed: pending cards close as Cancelled.
    const approval = $("#approval");
    if (approval?.dataset.state === "pending") {
      CT.swap(approval, CT.approvalResolved({ id: "approval", state: "cancelled", line: S.approval.line, when: clockTime(), full: S.approval.full, raw: S.approvalRaw() }));
    }
    const question = $("#question");
    if (question?.dataset.state === "pending") {
      CT.swap(question, CT.questionAnswered({ id: "question", questions: [{ title: S.question.title, answers: [] }], state: "cancelled", raw: S.questionRaw() }));
    }
    $("#unseen-wait")?.remove();
    state.pending = [];
    // Nothing starts by itself after a stop: held and queued messages stay on the shelf, unsent.
    state.unsent.push(...state.held.splice(0), ...state.queued.splice(0));
    // An action that was running or waiting when the stop was confirmed: Stopped.
    feed.all().filter((c) => ["running", "review", "waiting"].includes(c.status)).forEach((c) => updateAction(c.id, { status: "stopped" }));
    const marlowRunning = state.marlow.state === "working";
    const marlowUnsure = state.marlowCard === "call-started";
    if (marlowRunning) {
      state.marlow = { state: "stopped", preview: "Stopped.", time: clockTime(), unread: false };
      setMarlow("recipient-stopped");
    } else if (marlowUnsure) {
      setMarlow("unknown");
    }
    const t3Unsure = state.t3 === "call-started";
    if (t3Unsure) setT3("delivery-unknown");
    if (state.t3 === "call-made") setT3("call-made", { stopped: true });
    const nothingElse = !marlowRunning && !marlowUnsure && !t3Unsure && state.t3 !== "call-made";
    add(
      CT.turnNote({
        lead: CT.glyph("stopped"),
        html:
          `<p><b>Stopped.</b> Completed actions are not undone.</p><ul>` +
          (marlowRunning ? "<li>Stopped with it: Marlow's run for this message.</li>" : "") +
          (marlowUnsure ? "<li>The message to Marlow may or may not have been delivered.</li>" : "") +
          (state.t3 === "call-made" ? "<li>The call to T3 Code was made. Work handed to T3 Code may continue there.</li>" : "") +
          (t3Unsure ? "<li>The call to T3 Code may or may not have been made.</li>" : "") +
          (nothingElse ? "<li>Nothing else was running.</li>" : "") +
          `</ul>`,
      }),
    );
    finish(`Stopped after ${duration()}`);
    caption("Stopped. The note says what the gateway reported as stopped, and what may continue elsewhere.");
    setControls();
  }

  // The engine ---------------------------------------------------------------------------

  let index = 0;
  let playing = false;
  let resumeOnline = null;

  // The connection: one state drives the strip, the footer, the status line, the
  // composer, and whether anything on screen may look live.
  function setStrip(name, more) {
    const strip = $("#status-strip");
    strip.outerHTML = name ? CT.banner(name, 'id="status-strip"', more) : `<div class="status-strip" id="status-strip" role="status" hidden></div>`;
    $(".conversation").dataset.strip = String(Boolean(name));
    const dot = { reconnecting: "reconnecting", syncing: "connecting" }[name] || "connected";
    $$(".rail .status-dot").forEach((node) => (node.dataset.status = dot));
    $("#gateway-state").textContent = name === "reconnecting" ? "Reconnecting…" : name === "syncing" ? "Catching up" : "Connected";
  }

  // While the connection is lost, what stood for live work stops and is marked last seen.
  function applyLost(lost) {
    root.dataset.connection = lost ? "lost" : "live";
    feed.all().filter((c) => ["running", "review"].includes(c.status)).forEach((c) => feed.update(c.id, { lastSeen: lost }));
    $$(".messaged").forEach((card) => {
      const key = card.dataset.state;
      if (["call-started", "working"].includes(key)) $(":scope > summary .state", card).outerHTML = CT.state(key, lost);
    });
  }

  function disconnect() {
    if (state.offline) return;
    state.offline = true;
    setStrip("reconnecting");
    applyLost(true);
    renderStatus();
    renderRail();
    renderComposer();
    CT.announce("Reconnecting");
    caption("The connection drops. The shell stays as it was. Nothing that stood for live work moves, and each is marked as last seen.");
  }

  // Reconnecting: what was missed is fetched and merged in place, without
  // animation and without moving the reader. Nothing that was open folds.
  async function reconnect() {
    if (!state.offline) return;
    setStrip("syncing");
    await new Promise((resolve) => setTimeout(resolve, state.instant ? 0 : 700));
    state.offline = false;
    applyLost(false);
    let missed = 0;
    const live = state.instant;
    state.instant = true;
    while (missed < 3 && index < script.length && !script[index].gate && !resolveGate && state.run !== "idle") {
      const op = script[index];
      state.clock += op.sim || 0;
      index += 1;
      if (!op.demo && !(op.skip && op.skip())) {
        await op.fn();
        missed += 1;
      }
    }
    state.instant = live;
    // What was written offline is sent now, once.
    const outbox = state.outbox.splice(0);
    $$('.msg[data-pending="held"]', inner).forEach((node) => {
      node.removeAttribute("data-pending");
      node.nextElementSibling?.matches(".msg-caption") && node.nextElementSibling.remove();
      if (state.run !== "idle") node.insertAdjacentHTML("afterend", CT.caption("<span>Steer</span>"));
    });
    renderStatus();
    renderRail();
    renderComposer();
    setStrip("synced", missed ? `${missed} new in this task` : "");
    CT.announce(outbox.length ? "Connected. Your message was sent." : "Connected");
    setTimeout(() => {
      if (!state.offline && $("#status-strip .status-strip-text")?.textContent.startsWith("Synced")) setStrip("");
    }, 4000);
    caption("Reconnected. Missed events are merged in place; open steps and cards stay open.");
    resumeOnline?.();
    resumeOnline = null;
  }

  function caption(text) {
    const node = $("#run-caption");
    if (node && text) node.textContent = text;
  }

  async function advance() {
    const op = script[index];
    if (!op) return false;
    await sleep(op.wait);
    if (state.offline) await new Promise((resolve) => (resumeOnline = resolve)); // events do not arrive while offline
    if (state.halted) return false;
    state.clock += op.sim || 0;
    index += 1;
    if (op.skip && op.skip()) return true;
    await op.fn();
    if (op.caption) caption(op.caption);
    if (op.gate && !state.halted) {
      // The run waits here for the viewer, at the viewer's pace.
      const fast = state.instant;
      state.instant = false;
      const answer = new Promise((resolve) => (resolveGate = resolve));
      setControls();
      await answer;
      resolveGate = null;
      if (op.then && !state.halted) {
        state.clock += 8;
        op.then();
        caption(op.thenCaption);
      }
      state.instant = fast;
    }
    return !state.halted;
  }

  async function play(until) {
    if (playing) return;
    playing = true;
    setControls();
    while (index < script.length) {
      const label = script[index].label;
      if (!(await advance())) break;
      if (label === until) break;
    }
    playing = false;
    setControls();
  }

  function setControls() {
    const playButton = $("#run-play");
    if (!playButton) return;
    const done = index >= script.length || state.halted;
    playButton.disabled = playing || done;
    $("#run-step").disabled = playing || done;
    playButton.textContent = index === 0 ? "Play the run" : resolveGate ? "Waiting for your answer" : playing ? "Playing" : done ? "Finished" : "Continue";
    $("#run-owner").hidden = state.access !== "requested";
  }

  // Access: the read tier asks once for the tier that can send, stop and answer -----------

  let accessTimer = null;
  function requestAccess() {
    if (canWrite() || state.access === "asking" || state.access === "requested") return;
    state.access = "asking";
    renderComposer();
    setTimeout(() => {
      state.access = "requested";
      state.accessSeconds = 5;
      clearInterval(accessTimer);
      accessTimer = setInterval(() => {
        state.accessSeconds = state.accessSeconds > 1 ? state.accessSeconds - 1 : 5;
        const node = $(".access-wait");
        if (node) node.textContent = `checking again in ${state.accessSeconds}s`;
      }, 1000);
      renderComposer();
      setControls();
      CT.announce("Access requested");
      caption("Access requested. The gateway's owner approves it with the command shown. The bar's buttons stand in for the owner here.");
    }, 500);
  }

  // The owner's answer arrives. granted: the composer takes the bar's place and
  // what was pending appears, without taking focus from where it was.
  function settleAccess(result) {
    clearInterval(accessTimer);
    if (result !== "granted") {
      state.access = result;
      renderComposer();
      setControls();
      return CT.announce(result === "denied" ? "The request was denied" : "The request expired");
    }
    const inBar = composerSlot.contains(document.activeElement);
    state.tier = "interactive";
    state.access = "granted";
    renderRail();
    renderComposer();
    if (inBar) $(".composer-input").focus();
    setStrip("granted");
    CT.announce("You can now send, stop and answer");
    setTimeout(() => {
      if ($("#status-strip .status-strip-text")?.textContent.startsWith("Access granted")) setStrip("");
    }, 4000);
    // A request that was pending all along now arrives as a card.
    if ($("#unseen-wait") && resolveGate) {
      $("#unseen-wait").remove();
      add(CT.approval({ id: "approval", ...S.approval }));
      state.pending.push("approval");
      setStatus("waiting", "Waiting for you");
      renderComposer();
    } else {
      renderStatus();
    }
    setControls();
    caption("Access granted. The composer takes the bar's place, and what was pending appears as a card.");
  }

  // The recipient's task: where "Open in Marlow" goes, and how it comes back -------------

  let returnPoint = null;

  function renderOther() {
    const cardState = { working: "working", replied: "replied", "recipient-stopped": "stopped", "recipient-waiting": "waiting-you", "no-reply": "completed" }[state.marlowCard] || "working";
    other.innerHTML =
      CT.stamp(`Today ${clockTime()}`) +
      CT.messaged({ id: "from-otto", target: "otto", verb: "Message from", first: S.marlowFirst, state: cardState, open: true, body: S.receivingBody(cardState) }) +
      (cardState === "replied" ? CT.msg({ md: true, html: S.marlowReply }) : "") +
      (cardState === "working" ? CT.statusLine({ bot: "marlow", state: state.offline ? "blocked" : "working", phrase: state.offline ? "Reconnecting. Last seen reading the house log" : "Reading the house log", elapsed: state.offline ? "" : "0:12" }) : "");
  }

  function openRecipient(opener) {
    returnPoint = { scroll: transcript.scrollTop, opener };
    state.view = "marlow";
    inner.hidden = true;
    other.hidden = false;
    renderOther();
    $("#title-pill").innerHTML = `${CT.avatar("marlow")}<span class="title-pill-name">Marlow</span><span class="title-pill-task">Main</span>`;
    renderRail();
    renderComposer();
    transcript.scrollTop = 0;
    $("#from-otto > summary").focus({ preventScroll: true });
    caption("Marlow's task, at the card for this message. Open in Otto, or ⌘[, goes back to where you were.");
  }

  function openSender() {
    if (state.view !== "marlow") return;
    state.view = "otto";
    other.hidden = true;
    inner.hidden = false;
    $("#title-pill").innerHTML = `${CT.avatar("otto")}<span class="title-pill-name">Otto</span><span class="title-pill-task">Weekly backup check</span>`;
    renderRail();
    renderComposer();
    transcript.scrollTop = returnPoint ? returnPoint.scroll : transcript.scrollHeight;
    state.pinned = nearBottom();
    const back = $('#m-marlow [data-action="open-recipient"]');
    (back || $("#m-marlow > summary"))?.focus({ preventScroll: true });
    renderJump();
    caption("Back in Otto's task, at the same place, with the card still open.");
  }

  // Sending: one operation for every way of sending -----------------------------------------

  // how: "plain" (Enter or Send), "queue", "new-task", or "steer" (Send now on a queued row).
  function send(how = "plain", given) {
    const text = (given ?? state.text).trim();
    const problems = CT.attachmentProblems(state.files);
    if (!canWrite() || (!text && !state.files.length) || problems.any) return false; // the guard: nothing changes
    const active = state.run === "running" || state.run === "waiting";
    const clear = () => {
      if (given === undefined) {
        state.text = "";
        state.files = [];
      }
      state.menu = false;
    };
    const bubble = (captionText, pending = "") => {
      state.pinned = true;
      add(CT.msg({ role: "user", html: CT.esc(text || "(attachments)"), pending }) + (captionText ? CT.caption(`<span>${captionText}</span>`) : ""));
    };

    if (how === "new-task") {
      // A new task under the same bot runs the message; this task stays open.
      state.newTasks.unshift(text.length > 38 ? `${text.slice(0, 36)}…` : text);
      clear();
      renderRail();
      CT.announce("Started as a new task");
      caption("Started as a new task. It appears in the rail with the working mark; this task stays open.");
    } else if (state.offline) {
      // The host holds it and sends it once when the connection returns.
      state.outbox.push(text);
      clear();
      bubble("Sends when reconnected", "held");
    } else if (state.run === "stopping") {
      state.queued.push(text);
      clear();
      CT.announce("Queued");
    } else if (active && pendingKind() === "question") {
      // A pending question holds every outgoing message in this task, whichever way
      // it was sent. It is not the answer.
      state.held.push(text);
      clear();
      CT.announce("Held until you answer");
    } else if (active && (how === "queue" || (how === "plain" && state.mode === "queue"))) {
      state.queued.push(text);
      clear();
      CT.announce("Queued");
    } else if (active) {
      // A steer joins the run. Pending approvals stay pending.
      clear();
      bubble("Steer");
    } else {
      clear();
      bubble("The script has one run. In the app this starts the next.");
    }
    renderComposer();
    $(".composer-input")?.focus();
    return true;
  }

  // The ways to send, as a menu on the desktop and a sheet on touch.
  function openSendMenu(opener) {
    const active = state.run === "running" || state.run === "waiting";
    if (touch()) {
      const hold = pendingKind() === "question";
      const items = active
        ? [
            [hold ? "Hold until you answer" : "Steer this turn", "arrow-up", () => (hold ? send("plain") : setMode("steer"))],
            ["Queue after this turn", "queue", () => setMode("queue")],
            ["Start as new task", "new-task", () => send("new-task")],
          ]
        : [["Send", "arrow-up", () => send("plain")], ["Start as new task", "new-task", () => send("new-task")]];
      return CT.openSheet(items, opener, root);
    }
    state.menu = true;
    renderComposer();
    ($('.send-menu [aria-checked="true"]') || $(".send-menu .menu-item")).focus();
    menuOpener = opener?.dataset.action || "send";
  }
  let menuOpener = "send";

  function closeSendMenu(refocus = true) {
    if (!state.menu) return;
    state.menu = false;
    renderComposer();
    if (refocus) ($(`.composer [data-action="${menuOpener}"]`) || $(".send-button")).focus();
  }

  function setMode(mode) {
    state.mode = mode;
    state.menu = false;
    renderComposer();
    $(".composer-input")?.focus();
  }

  // Wiring -------------------------------------------------------------------------------

  // The approval card in the run: the answer goes to the script, not to the gallery's resolver.
  document.addEventListener("ct:decision", (event) => {
    const { card, decision: choice } = event.detail;
    if (card.id !== "approval" || card.dataset.state !== "pending" || !resolveGate) return;
    event.preventDefault();
    if (choice === "always") {
      // Not shown as saved until the gateway answers that it applied the decision.
      $(".standing", card).outerHTML = CT.standing({ bot: "otto", request: S.approval.request, open: true, sent: "sending" });
      $('.standing [data-decision="deny"]', card).focus();
      follow();
      return setTimeout(() => {
        if (!resolveGate) return;
        decision = "always";
        resolveGate();
      }, 800);
    }
    decision = choice;
    resolveGate();
  });

  // The last pending question is settled (answered, dismissed or expired): the run
  // goes on, and held messages are released in the order they were sent.
  document.addEventListener("ct:question", (event) => {
    if (event.detail.card.id !== "question") return;
    state.pending = state.pending.filter((id) => id !== "question");
    if (!state.pending.length && state.run === "waiting") state.run = "running";
    if (!state.pending.includes("question")) state.held.splice(0).forEach((text) => add(CT.msg({ role: "user", html: CT.esc(text) }) + CT.caption("<span>Steer</span>")));
    setStatus("thinking", "Thinking");
    renderComposer();
    resolveGate?.();
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    const actor = target.closest("[data-action]");
    const action = actor?.dataset.action;

    if (state.menu && !target.closest(".send-menu, [data-action='send-menu']")) closeSendMenu(false);

    if (action === "stop") stop();
    if (action === "jump") {
      const card = oldestPending();
      if (card) {
        card.scrollIntoView({ block: "center" });
        card.focus({ preventScroll: true });
      } else {
        state.pinned = true;
        transcript.scrollTop = transcript.scrollHeight;
      }
      renderJump();
    }
    if (action === "review") focusPending();
    if (action === "status") {
      // The running action's card comes into view, without opening it (section 7.8).
      const live = feed.all().find((c) => ["running", "review"].includes(c.status));
      const card = live && (feed.elementOf(live.id) || document.getElementById(live.id));
      if (card) {
        card.scrollIntoView({ block: "nearest" });
        card.querySelector("summary")?.focus({ preventScroll: true });
      }
    }
    if (action === "send-menu") {
      if (state.menu) closeSendMenu();
      else openSendMenu(actor);
    }
    if (action === "send") send("plain");
    if (action === "attach") {
      // The prototype adds sample files: an image within its limit, then a file over its own.
      const samples = [{ name: "disk-usage.png", size: 1.4, image: true }, { name: "logs.tar", size: 21, image: false }, { name: "scan.png", size: 8.2, image: true }];
      state.files.push(samples[state.files.length % samples.length]);
      renderComposer();
    }
    if (action === "remove-file") {
      state.files.splice(Number(actor.dataset.index), 1);
      renderComposer();
      $(".composer-input").focus();
    }
    if (action === "request-access") requestAccess();
    if (action === "access-check") caption("Checked. The request is still waiting for the gateway's owner.");
    if (action === "access-cancel") {
      clearInterval(accessTimer);
      state.access = "read";
      renderComposer();
      setControls();
    }
    if (action === "strip-action") reconnect().then(setNetButton);
    if (action === "open-recipient") openRecipient(actor);
    if (action === "open-sender") openSender();
    if (action === "back") shell.dataset.view = "list";

    const task = target.closest("#rail-list .task:not(.task-new), #rail-list .bot");
    if (task) {
      shell.dataset.view = "detail";
      if (state.view === "marlow" && task.closest("#rail-otto")) openSender();
      else if (state.view === "otto" && task.closest("#rail-marlow") && state.marlowCard) openRecipient($('#m-marlow [data-action="open-recipient"]'));
    }

    const mode = target.closest(".send-menu [data-mode]")?.dataset.mode;
    if (mode) {
      if (mode === "steer" || mode === "queue") setMode(mode);
      else {
        state.menu = false;
        send(mode === "new-task" ? "new-task" : "plain");
      }
    }

    const queue = target.closest("[data-queue]");
    if (queue) {
      const [text] = state.queued.splice(Number(queue.dataset.index), 1);
      if (queue.dataset.queue === "send") send("steer", text); // through the same operation
      else renderComposer();
    }
    const unsent = target.closest("[data-unsent]");
    if (unsent) {
      const [text] = state.unsent.splice(Number(unsent.dataset.index), 1);
      if (unsent.dataset.unsent === "send") send("plain", text);
      else renderComposer();
    }
    const held = target.closest("[data-held]");
    if (held) {
      const [text] = state.held.splice(Number(held.dataset.index), 1);
      if (held.dataset.held === "edit") state.text = text;
      renderComposer();
      $(".composer-input").focus();
    }
    const notice = target.closest("[data-notice]");
    if (notice) {
      const [item] = state.notices.splice(Number(notice.dataset.index), 1);
      renderComposer();
      if (notice.dataset.notice === "retry") item.retry();
    }

    // The standing-allow form opening changes the card's height: keep following.
    if (action === "standing-open" || action === "standing-close" || action === "raw") {
      const card = actor.closest(".card");
      const opened = action === "raw" ? document.getElementById(actor.getAttribute("aria-controls")) : $(".standing", card);
      requestAnimationFrame(() => follow(opened && !opened.hidden ? opened : card));
    }
  });

  function focusPending() {
    const card = oldestPending();
    if (!card) return;
    card.scrollIntoView({ block: "center" });
    ($('.option[tabindex="0"]', card) || card).focus({ preventScroll: true });
  }

  // The menu also opens from Send by right-click, and on touch by holding Send.
  document.addEventListener("contextmenu", (event) => {
    const button = event.target.closest(".send-button");
    if (!button || button.disabled) return;
    event.preventDefault();
    openSendMenu(button);
  });
  let holdSend = null;
  document.addEventListener("pointerdown", (event) => {
    const button = event.target.closest(".send-button");
    if (!button || button.disabled || !touch()) return;
    holdSend = setTimeout(() => {
      holdSend = "opened";
      openSendMenu(button);
    }, 500);
  });
  document.addEventListener("pointerup", () => {
    if (holdSend !== "opened") clearTimeout(holdSend);
  });
  document.addEventListener(
    "click",
    (event) => {
      if (holdSend === "opened" && event.target.closest(".send-button")) {
        event.stopPropagation(); // the hold opened the sheet; it does not also send
        event.preventDefault();
      }
      holdSend = null;
    },
    true,
  );

  document.addEventListener("input", (event) => {
    if (!event.target.classList.contains("composer-input")) return;
    const had = Boolean(state.text);
    state.text = event.target.value;
    if (had !== Boolean(state.text)) renderComposer();
  });

  document.addEventListener("keydown", (event) => {
    const mod = event.metaKey || event.ctrlKey;
    const inComposer = event.target.classList?.contains("composer-input");
    const inCard = event.target.closest?.('.request[data-state="pending"]');

    if (event.key === "Enter" && !event.isComposing) {
      if (mod && event.shiftKey) {
        event.preventDefault();
        return send("new-task");
      }
      if (inComposer && !event.shiftKey) {
        event.preventDefault();
        // ⌥↵ queues this one message and leaves the mode as it was.
        return send(event.altKey && state.run !== "idle" ? "queue" : "plain");
      }
      // ⌘↵ sends from anywhere, except inside a pending card, where it answers the card.
      if (mod && !inCard) {
        event.preventDefault();
        return send("plain");
      }
    }
    if (mod && event.key === ".") {
      event.preventDefault();
      return stop();
    }
    if (mod && event.key.toLowerCase() === "j") {
      event.preventDefault();
      return focusPending();
    }
    if (mod && event.key.toLowerCase() === "i") {
      event.preventDefault();
      return $(".composer-input")?.focus();
    }
    if ((mod && event.key === "[") || (event.altKey && event.key === "ArrowLeft")) {
      if (state.view === "marlow") {
        event.preventDefault();
        return openSender();
      }
    }
    // Send's menu from the keyboard.
    if (event.target.closest?.(".send-button") && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
      event.preventDefault();
      return openSendMenu(event.target);
    }
    if (state.menu) {
      const items = $$(".send-menu .menu-item");
      const at = items.indexOf(document.activeElement);
      if (event.key === "Escape") {
        event.preventDefault();
        return closeSendMenu();
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        return items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
      }
      if (event.key === "Tab") closeSendMenu(false);
    }
  });

  // While the run plays, the elapsed time ticks once a second.
  setInterval(() => {
    if (state.run === "idle" || state.instant || state.run === "stopping" || state.offline) return;
    state.clock += 1;
    const node = $(".status-elapsed", inner);
    if (node) node.textContent = elapsed();
  }, 1000);

  // First paint ----------------------------------------------------------------------------

  inner.innerHTML =
    CT.stamp("Today 5:02 PM") +
    CT.msg({ role: "user", html: "Did last night's backup finish?" }) +
    CT.actionCard({ ...C.list, id: "h-list", args: { path: "logs" }, body: CT.stepBody({ state: "loading" }) }) +
    CT.actionCard({ ...C.read, id: "h-read", body: S.readBody() }) +
    CT.msg({ html: "Yes. It finished at 3:25 AM, but it took 71 minutes. It usually takes about 23." }) +
    CT.runLine({ label: "Worked for 9s", actions: 2, model: "scripted/dev-1", effort: "", run: "run_5c20e8aa" }) +
    CT.stamp("Today 5:24 PM");
  root.dataset.connection = "live";
  renderRail();
  renderComposer();

  function setNetButton() {
    const button = $("#run-net");
    if (button) button.textContent = state.offline ? "Reconnect" : "Drop the connection";
  }

  // The run's controls live in the prototype's bar, which exists once the page has loaded.
  function mountControls() {
    const extra = $("#proto-extra");
    if (!extra) return;
    extra.innerHTML =
      `<span class="run-controls"><button type="button" id="run-play">Play the run</button>` +
      `<button type="button" id="run-step">Step</button><button type="button" id="run-net">Drop the connection</button>` +
      `<button type="button" id="run-tier">${state.tier === "read" ? "Start with full access" : "Start read-only"}</button>` +
      `<button type="button" id="run-reset">Restart</button>` +
      `<span id="run-owner" hidden>As the gateway's owner: <button type="button" data-owner="granted">Approve</button>` +
      `<button type="button" data-owner="denied">Deny</button><button type="button" data-owner="expired">Let it expire</button></span>` +
      `<span id="run-caption">A scripted run. Press Play, or Step to go one event at a time.</span></span>`;
    $("#run-play").addEventListener("click", () => play());
    $("#run-step").addEventListener("click", async () => {
      playing = true;
      setControls();
      await advance();
      playing = false;
      setControls();
    });
    $("#run-reset").addEventListener("click", () => location.reload());
    $("#run-tier").addEventListener("click", () => {
      const params = new URLSearchParams(location.search);
      if (state.tier === "read") params.delete("tier");
      else params.set("tier", "read");
      location.search = params.toString();
    });
    $("#run-net").addEventListener("click", async () => {
      if (state.offline) await reconnect();
      else disconnect();
      setNetButton();
    });
    $("#run-owner").addEventListener("click", (event) => {
      const result = event.target.closest("[data-owner]")?.dataset.owner;
      if (result) settleAccess(result);
    });
    setControls();
  }
  if ($("#proto-extra")) mountControls();
  else document.addEventListener("DOMContentLoaded", mountControls);

  // For tests and screenshots: run without waits up to a named moment.
  window.demo = {
    labels: script.map((op) => op.label),
    async runTo(label) {
      state.instant = true;
      const done = play(label).then(() => (state.instant = false));
      await Promise.race([
        done,
        new Promise((resolve) => {
          const timer = setInterval(() => {
            if (resolveGate) {
              clearInterval(timer);
              resolve();
            }
          }, 10);
          done.then(() => clearInterval(timer));
        }),
      ]);
    },
    answer(choice) {
      decision = choice;
      resolveGate?.();
    },
    play,
    stop,
    send,
    disconnect,
    reconnect,
    requestAccess,
    settleAccess,
    openRecipient,
    openSender,
    // The pending question expires without an answer.
    expireQuestion() {
      const card = $("#question");
      if (card?.dataset.state !== "pending") return;
      const parent = card.parentElement;
      CT.swap(card, CT.questionAnswered({ id: "question", questions: [{ title: S.question.title, answers: [] }], state: "expired", raw: S.questionRaw() }));
      parent.dispatchEvent(new CustomEvent("ct:question", { bubbles: true, detail: { card: { id: "question" }, state: "expired" } }));
    },
    state,
  };
})();
