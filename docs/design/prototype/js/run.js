// A scripted run, played inside a copy of the shell.
//
// The script is a list of moments. Each waits a little, then changes the page
// the way a gateway event would. The waits stand in for the time between
// events; nothing in the interface itself waits. Play runs the script, Step
// advances one moment, and the approval card pauses it until the viewer
// answers. Stop, steer and queue in the composer work at any point.
//
// From the console or a test:  demo.runTo("approval"), demo.answer("once")

(function () {
  const CT = window.CT;
  const S = CT.samples;
  const $ = (selector, root = document) => root.querySelector(selector);

  const shell = $(".shell");
  const transcript = $("#transcript");
  const inner = $("#transcript-inner");
  const rail = $("#rail-list");
  const composerSlot = $("#composer-slot");

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
    mode: "steer",
    menu: false,
    queued: [],
    marlow: { state: "idle", preview: "Tightened the intro and cut about 80 words.", time: "4:58 PM", mark: "" },
    t3Sent: false,
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

  // Scrolling: follow new output only when the reader is near the bottom -----------

  const nearBottom = () => transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
  transcript.addEventListener("scroll", () => {
    state.pinned = nearBottom();
    if (state.pinned) renderComposer();
  });

  function follow() {
    if (state.pinned) transcript.scrollTop = transcript.scrollHeight;
    else renderComposer();
  }

  // Rendering ------------------------------------------------------------------------

  function renderRail() {
    const taskStatus = state.run === "waiting" ? "waiting" : state.run === "idle" ? "idle" : "running";
    const ottoPreview =
      state.run === "waiting"
        ? "Waiting for you: approve a command"
        : state.run === "idle"
          ? state.lastPreview || "Yes. It finished at 3:25 AM, but it took 71 minutes."
          : state.phrase || "Thinking";
    rail.innerHTML =
      CT.botGroup({
        bot: "otto",
        state: state.phase,
        preview: ottoPreview,
        time: state.run === "idle" ? (state.lastPreview ? clockTime() : "5:02 PM") : "now",
        open: true,
        tasks:
          CT.taskRow({ title: "Weekly backup check", status: taskStatus, current: true }) +
          CT.taskRow({ title: "Disk almost full on the media box", status: "idle" }) +
          CT.taskRow({ title: "Certificate renewal warning", status: "idle" }) +
          `<li><button type="button" class="task task-new">${CT.icon("plus")}<span class="task-title">New task</span></button></li>`,
      }) +
      CT.botGroup({ bot: "juniper", state: "idle", preview: "Ask these five, and get the answers in writing.", time: "5:24 PM", i: 1 }) +
      CT.botGroup({ bot: "marlow", ...state.marlow, i: 2 }) +
      CT.botGroup({ bot: "pip", state: "idle", preview: "Here is the week, with Thursday kept clear.", time: "3:10 PM", mark: "unread", i: 3 });
  }

  function renderComposer() {
    const showJump = !state.pinned;
    const jump = showJump
      ? state.run === "waiting"
        ? CT.jump({ state: "needs-you", phrase: "Needs you" })
        : state.run === "running"
          ? CT.jump({ state: "live", bot: "otto", phrase: state.phrase || "Thinking" })
          : CT.jump({ state: "latest" })
      : "";
    let shelf = state.queued
      .map((text, index) =>
        CT.shelfRow({
          lead: CT.glyph("queued"),
          text: `<b>Queued</b> <span>${CT.esc(text)}</span>`,
          actions:
            (state.run === "stopping" ? "" : CT.button("Send now", `data-queue="send" data-index="${index}"`)) +
            CT.button("Cancel", `data-variant="quiet" data-queue="cancel" data-index="${index}"`),
        }),
      )
      .join("");
    if (state.run === "waiting") {
      shelf += CT.shelfRow({
        tone: "warn",
        lead: CT.glyph("waiting"),
        text: state.text
          ? "<b>Sending will close Otto's approval request</b>"
          : "<b>Otto needs your approval</b> <span>to run a command</span>",
        actions: CT.button("Review", 'data-action="review"'),
      });
    }
    const hadFocus = document.activeElement?.classList.contains("composer-input");
    composerSlot.innerHTML = CT.composer({ bot: "otto", run: state.run, text: state.text, shelf, jump, menu: state.menu, mode: state.mode });
    if (hadFocus) {
      const input = $(".composer-input");
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  // The status line is always the last thing in the transcript while a run is active.
  function renderStatus(fresh = false) {
    $(".status-line", inner)?.remove();
    if (state.run === "idle") return;
    inner.insertAdjacentHTML(
      "beforeend",
      CT.statusLine({
        bot: "otto",
        state: state.run === "stopping" ? "stopping" : state.phase,
        phrase: state.phrase,
        elapsed: state.phrase ? elapsed() : "",
        fresh,
      }),
    );
  }

  function setStatus(phase, phrase) {
    const fresh = phrase !== state.phrase;
    state.phase = phase;
    state.phrase = phrase;
    renderStatus(fresh);
    renderRail();
    if (!state.pinned) renderComposer();
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

  function activityLabel() {
    const head = $("#run-activity > summary");
    const running = state.run !== "idle";
    $(".activity-label", head).textContent = running ? "Working" : state.outcome || `Worked for ${duration()}`;
    $(".activity-count", head).textContent = `${state.steps} ${state.steps === 1 ? "step" : "steps"}`;
    const failed = $(".activity-failed", head);
    if (state.failed && !failed) {
      $(".chevron", head).insertAdjacentHTML("beforebegin", `<span aria-hidden="true">·</span><span class="activity-failed">${state.failed} failed</span>`);
    }
  }

  function addStep(def) {
    if (!$("#run-activity")) {
      add(CT.activity({ id: "run-activity", state: "running", label: "Working", count: "0 steps" }));
    }
    state.steps += 1;
    $("#run-activity .activity-steps").insertAdjacentHTML("beforeend", CT.step({ ...def, fresh: !state.instant }));
    activityLabel();
    follow();
  }

  // Update a step in place. Whether it is open, and which view it shows, are the
  // viewer's and are kept.
  function updateStep(id, def) {
    const old = document.getElementById(id);
    const open = old.open;
    const raw = old.querySelector('[data-view-button="raw"]')?.getAttribute("aria-selected") === "true";
    old.parentElement.outerHTML = CT.step({ id, ...def, open });
    if (raw) document.getElementById(id).querySelector('[data-view-button="raw"]')?.click();
    if (def.status === "failed") {
      state.failed += 1;
      $("#run-activity + .activity-failed-steps").insertAdjacentHTML("beforeend", CT.step({ ...def, id: `${id}-kept` }));
    }
    activityLabel();
    follow();
  }

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

  // The script -------------------------------------------------------------------------

  const sleep = (ms) => (state.instant ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms / state.speed)));

  let resolveGate = null;
  let decision = null;

  const finalAllowed =
    "<h3>Found</h3><p>Last night's backup took 71 minutes because the transcode cache was included: 182 GB that is rebuilt on demand and never needed backing up. A normal week moves about 5 GB.</p>" +
    "<h3>Changed</h3><ul><li>Moved the cache aside to <code>transcode-cache.old</code>. The disk is at 64%.</li><li>Added the entry Marlow wrote to <code>notes/house-log.md</code>.</li></ul>" +
    "<h3>Left</h3><ul><li>T3 Code has the fix for <code>weekly.sh</code>. I have not seen a result yet.</li><li>One log I looked for was missing; I found its archived copy instead.</li></ul>";

  const finalDenied =
    "<h3>Found</h3><p>Last night's backup took 71 minutes because the transcode cache was included: 182 GB that is rebuilt on demand and never needed backing up.</p>" +
    "<h3>Changed</h3><ul><li>Added the entry Marlow wrote to <code>notes/house-log.md</code>.</li></ul>" +
    "<h3>Left</h3><ul><li>I did not move the cache, since you said no. Tonight's run will be slow again unless the exclude lands first.</li><li>T3 Code has the fix for <code>weekly.sh</code>. I have not seen a result yet.</li></ul>";

  const script = [
    {
      label: "send",
      caption: "You send. The avatar appears at once.",
      wait: 0,
      fn() {
        add(CT.msg({ role: "user", html: "Find out why it was slow, fix what is safe to fix, and write it up for the house log." }));
        state.run = "running";
        state.runStart = state.clock;
        setStatus("thinking", "");
        renderComposer();
      },
    },
    { label: "thinking", caption: "No step has started within a second, so the phrase reads Thinking.", wait: 1000, sim: 1, fn: () => setStatus("thinking", "Thinking") },
    {
      label: "progress",
      caption: "A short progress message streams in above the status line.",
      wait: 500,
      sim: 2,
      fn: () => stream("On it. Reading last night's backup log first.", { md: false }),
    },
    {
      label: "first-step",
      caption: "The first step starts. One quiet line appears: Working · 1 step.",
      wait: 300,
      fn() {
        addStep({ id: "s-read", kind: "read", status: "running", title: "Reading backup-2026-11-15.log", statusText: "" });
        setStatus("working", "Reading backup-2026-11-15.log");
      },
    },
    {
      label: "read-done",
      wait: 700,
      sim: 1,
      fn() {
        updateStep("s-read", { kind: "read", title: "Read backup-2026-11-15.log", detail: "214 lines", statusText: "0.6s", body: S.readBody() });
        setStatus("thinking", "Thinking");
      },
    },
    {
      label: "open-block",
      caption: "The viewer opens the line. It becomes a card of steps.",
      wait: 600,
      fn() {
        $("#run-activity").open = true;
        follow();
      },
    },
    {
      label: "thought",
      caption: "The bot's reasoning arrives as a step of its own.",
      wait: 500,
      sim: 4,
      fn: () => addStep({ id: "s-thought", kind: "thought", title: "Thought", detail: "71 minutes instead of the usual 23. The transfer line is the odd one…", statusText: "4s", body: S.thoughtBody() }),
    },
    {
      label: "second-read",
      wait: 500,
      fn() {
        addStep({ id: "s-read2", kind: "read", status: "running", title: "Reading backup-2026-11-08.log", statusText: "" });
        setStatus("working", "Reading backup-2026-11-08.log");
      },
    },
    {
      label: "step-open",
      caption: "One step is opened mid-run. Nothing above it moves, and steps keep arriving below.",
      wait: 400,
      fn() {
        $("#s-read").open = true;
        follow();
      },
    },
    {
      label: "read-failed",
      caption: "A tool error becomes a failed step. The line now says 1 failed.",
      wait: 600,
      sim: 1,
      fn() {
        updateStep("s-read2", { kind: "read", status: "failed", title: "Couldn't read backup-2026-11-08.log", detail: "No such file", statusText: "Failed", body: S.failedBody() });
        setStatus("thinking", "Thinking");
      },
    },
    {
      label: "list",
      wait: 400,
      fn() {
        addStep({ id: "s-list", kind: "list", status: "running", title: "Looking through logs/archive", statusText: "" });
        setStatus("working", "Looking through logs/archive");
      },
    },
    {
      label: "raw",
      caption: "The open step is switched to Raw: the exact call, result, timing and ids.",
      wait: 400,
      sim: 1,
      fn() {
        updateStep("s-list", { kind: "list", title: "Looked through logs/archive", detail: "9 files", statusText: "0.2s" });
        $('#s-read [data-view-button="raw"]').click();
        addStep({ id: "s-read3", kind: "read", status: "running", title: "Reading backup-2026-11-08.log.gz", statusText: "" });
        setStatus("working", "Reading backup-2026-11-08.log.gz");
      },
    },
    {
      label: "read3-done",
      wait: 700,
      sim: 2,
      fn() {
        updateStep("s-read3", { kind: "read", title: "Read backup-2026-11-08.log.gz", detail: "198 lines", statusText: "1.1s" });
        addStep({ id: "s-thought2", kind: "thought", title: "Thought", detail: "Last week moved 4.9 GB. This week 187 GB, and 182 of it is the transcode cache.", statusText: "3s" });
        setStatus("thinking", "Thinking");
      },
    },
    {
      label: "step-close",
      wait: 700,
      sim: 3,
      fn() {
        $("#s-read").open = false;
        follow();
      },
    },
    {
      label: "found",
      wait: 300,
      sim: 3,
      fn: () => stream("Found it. The transcode cache was swept into the backup. I am asking Marlow for the log entry and sending the script fix to T3 Code.", { md: false }),
    },
    {
      label: "message-sending",
      caption: "Otto messages Marlow. A card appears in the conversation, and a step in the list.",
      wait: 400,
      fn() {
        add(CT.messaged({ id: "m-marlow", target: "marlow", first: "Write a two-line entry for the house log.", state: "sending", body: S.marlowBody("working") }));
        addStep({ id: "s-msg", kind: "message", status: "running", title: "Messaging Marlow", statusText: "" });
        setStatus("working", "Messaging Marlow");
      },
    },
    {
      label: "message-working",
      caption: "Marlow starts working. Opened, the card shows what was sent and Marlow's live status.",
      wait: 600,
      sim: 1,
      fn() {
        state.marlow = { state: "working", preview: "Reading the house log", time: "now", mark: "" };
        const card = $("#m-marlow");
        card.dataset.state = "working";
        $(".state", card).outerHTML = CT.state("working");
        card.open = true;
        setStatus("working", "Waiting for Marlow");
        follow();
      },
    },
    {
      label: "message-replied",
      caption: "The reply arrives in the same card.",
      wait: 2200,
      sim: 40,
      fn() {
        state.marlow = { state: "done", preview: "Nov 16. Last night's backup ran long: 71 minutes…", time: clockTime(), mark: "unread" };
        const card = $("#m-marlow");
        card.dataset.state = "replied";
        $(".state", card).outerHTML = CT.state("replied");
        $(".messaged-body", card).innerHTML = S.marlowBody("replied");
        updateStep("s-msg", { kind: "message", title: "Messaged Marlow", detail: "replied", statusText: "41s" });
        setStatus("thinking", "Thinking");
      },
    },
    {
      label: "message-close",
      wait: 1400,
      sim: 1,
      fn() {
        $("#m-marlow").open = false;
        follow();
      },
    },
    {
      label: "t3-sending",
      caption: "Otto hands the script fix to T3 Code. The card is drawn from Otto's own tool call.",
      wait: 300,
      fn() {
        add(CT.messaged({ id: "m-t3", target: "t3code", first: "In backup-scripts, add the cache to the exclude list in weekly.sh.", state: "sending", body: S.t3Body("sent") }));
        addStep({ id: "s-t3", kind: "agent", status: "running", title: "Messaging T3 Code", statusText: "" });
        setStatus("working", "Messaging T3 Code");
      },
    },
    {
      label: "t3-sent",
      caption: "The call returns: accepted. The card stays at Sent until a later tool event names it.",
      wait: 800,
      sim: 1,
      fn() {
        state.t3Sent = true;
        const card = $("#m-t3");
        card.dataset.state = "sent";
        $(".state", card).outerHTML = CT.state("sent");
        updateStep("s-t3", { kind: "agent", title: "Messaged T3 Code", detail: "accepted, thread 18", statusText: "0.8s" });
        setStatus("thinking", "Thinking");
      },
    },
    {
      label: "approval",
      caption: "Otto needs approval. The run waits; the rail, the status line and the composer all say so. Answer the card.",
      wait: 700,
      sim: 1,
      gate: true,
      fn() {
        addStep({ id: "s-exec", kind: "command", status: "waiting", title: "Wants to run mv", detail: "/srv/media/transcode-cache", statusText: "Waiting for you", body: S.commandBody(true) });
        add(CT.approval({ id: "approval", ...S.approval }));
        state.run = "waiting";
        setStatus("waiting", "Waiting for you");
        renderComposer();
      },
    },
    {
      label: "answered",
      caption: "Answered. The card folds to one line and the run goes on.",
      wait: 0,
      sim: 8,
      fn() {
        const outcomes = {
          once: ["once", "Otto ran this once. It will ask again next time."],
          always: ["always", "Otto ran this, and can run it again without asking."],
          deny: ["denied", "Otto won't do this, and won't ask again until you send another message."],
        };
        const [resolvedState, outcome] = outcomes[decision];
        $("#approval").outerHTML = CT.approvalResolved({
          id: "approval",
          state: resolvedState,
          line: "Move the transcode cache aside on media-box",
          when: clockTime(),
          outcome,
          rule:
            decision === "always"
              ? `<p class="request-rule"><code class="tool-name">/bin/mv, any arguments, on media-box</code><span>${state.standingScope || "Otto only"}</span>${CT.linkButton("Revoke")}</p>`
              : "",
          full: S.approval.full,
        });
        state.run = "running";
        if (decision === "deny") {
          updateStep("s-exec", { kind: "command", status: "skipped", title: "Didn't run mv", detail: "/srv/media/transcode-cache", statusText: "Denied" });
          setStatus("thinking", "Thinking");
        } else {
          updateStep("s-exec", { kind: "command", status: "running", title: "Running mv", detail: "/srv/media/transcode-cache", statusText: "", body: S.commandBody(true) });
          setStatus("working", "Running mv");
        }
        renderComposer();
      },
    },
    {
      label: "command-done",
      wait: 900,
      sim: 1,
      fn() {
        if (decision !== "deny") {
          updateStep("s-exec", { kind: "command", title: "Ran mv", detail: "exit 0", statusText: "1.2s", body: S.commandBody(false) });
        }
        addStep({ id: "s-write", kind: "write", status: "running", title: "Writing house-log.md", statusText: "" });
        setStatus("working", "Writing house-log.md");
      },
    },
    {
      label: "write-done",
      wait: 500,
      sim: 1,
      fn() {
        updateStep("s-write", { kind: "write", title: "Wrote house-log.md", detail: "+4 lines", statusText: "0.3s" });
        setStatus("thinking", "Thinking");
      },
    },
    { label: "answer", caption: "The answer streams into its bubble.", wait: 300, sim: 6, fn: () => stream(decision === "deny" ? finalDenied : finalAllowed) },
    {
      label: "finished",
      caption: "Finished. The status line leaves, the steps fold to one line, and the failed step stays in view.",
      wait: 300,
      fn: () => finish(),
    },
  ];

  // Ending a run -------------------------------------------------------------------------

  function finish(outcome) {
    state.run = "idle";
    state.outcome = outcome || `Worked for ${duration()}`;
    state.lastPreview = outcome ? "Stopped. Completed steps are not undone." : "Found: the transcode cache was included in the backup.";
    const block = $("#run-activity");
    if (block) {
      block.dataset.state = outcome ? "stopped" : "completed";
      activityLabel();
      // The steps fold when the run ends, unless the viewer is reading one.
      if (!block.querySelector(".step[open]") && !block.contains(document.activeElement)) block.open = false;
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
    // Queued messages start in order once the run has ended.
    const next = state.queued.shift();
    if (next) add(CT.msg({ role: "user", html: CT.esc(next) }) + CT.caption("<span>Was queued. In the app this starts the next run.</span>"));
    renderRail();
    renderComposer();
    follow();
  }

  async function stop() {
    if (state.run !== "running" && state.run !== "waiting") return;
    state.halted = true;
    resolveGate?.();
    // Pending cards close as Cancelled.
    if ($("#approval")?.dataset.state === "pending") {
      $("#approval").outerHTML = CT.approvalResolved({ id: "approval", state: "cancelled", line: "Move the transcode cache aside on media-box", when: clockTime(), outcome: "You stopped the run before answering. The command was not run.", full: S.approval.full });
    }
    state.run = "stopping";
    setStatus("idle", "Stopping…");
    renderComposer();
    caption("Stop pressed. The phrase reads Stopping… until the gateway confirms.");
    await new Promise((resolve) => setTimeout(resolve, 500));
    document.querySelectorAll('#run-activity .step[data-status="running"], #run-activity .step[data-status="waiting"]').forEach((step) => {
      step.dataset.status = "skipped";
      $(".step-status", step).textContent = "Stopped";
      $(".step-node", step).innerHTML = CT.icon("tool");
    });
    const marlowRunning = state.marlow.state === "working";
    if (marlowRunning) {
      state.marlow = { state: "idle", preview: "Stopped.", time: clockTime(), mark: "" };
      const card = $("#m-marlow");
      card.dataset.state = "recipient-stopped";
      $(".state", card).outerHTML = CT.state("recipient-stopped");
    }
    const sendingT3 = $("#m-t3")?.dataset.state === "sending";
    if (sendingT3) {
      $("#m-t3").dataset.state = "delivery-unknown";
      $("#m-t3 .state").outerHTML = CT.state("delivery-unknown");
    }
    const nothingElse = !marlowRunning && !state.t3Sent && !sendingT3;
    add(
      CT.turnNote({
        lead: CT.glyph("stopped"),
        html:
          `<p><b>Stopped after ${duration()}.</b> Completed steps are not undone.</p><ul>` +
          (marlowRunning ? "<li>Stopped with it: Marlow's run for this message.</li>" : "") +
          (state.t3Sent ? "<li>Work already sent to T3 Code continues there.</li>" : "") +
          (sendingT3 ? "<li>The message to T3 Code may or may not have been delivered.</li>" : "") +
          (nothingElse ? "<li>Nothing else was running.</li>" : "") +
          `</ul>`,
      }),
    );
    finish(`Stopped after ${duration()}`);
    caption("Stopped. A note says what was stopped and what continues elsewhere.");
    setControls();
  }

  // The engine ---------------------------------------------------------------------------

  let index = 0;
  let playing = false;

  function caption(text) {
    const node = $("#run-caption");
    if (node && text) node.textContent = text;
  }

  async function advance() {
    const op = script[index];
    if (!op) return false;
    await sleep(op.wait);
    if (state.halted) return false;
    state.clock += op.sim || 0;
    index += 1;
    await op.fn();
    if (op.caption) caption(op.caption);
    if (op.gate && !state.halted) {
      setControls();
      await new Promise((resolve) => (resolveGate = resolve));
      resolveGate = null;
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
  }

  // Wiring -------------------------------------------------------------------------------

  document.addEventListener("click", (event) => {
    const target = event.target;

    // The approval card: the three answers.
    const choice = target.closest("#approval [data-decision]");
    if (choice && resolveGate) {
      decision = choice.dataset.decision;
      state.standingScope = $('#approval [data-standing="scope"] [aria-checked="true"]')?.textContent;
      resolveGate();
      return;
    }

    const action = target.closest("[data-action]")?.dataset.action;
    if (action === "stop") stop();
    if (action === "jump") {
      state.pinned = true;
      transcript.scrollTop = transcript.scrollHeight;
      renderComposer();
    }
    if (action === "review") {
      const card = $("#approval");
      card.scrollIntoView({ block: "center" });
      card.focus();
    }
    if (action === "status") {
      const block = $("#run-activity");
      if (block) {
        block.open = true;
        (block.querySelector('.step[data-status="running"]') || block).scrollIntoView({ block: "nearest" });
      }
    }
    if (action === "send-menu") {
      state.menu = !state.menu;
      renderComposer();
    }
    if (action === "send") send();
    if (action === "back") shell.dataset.view = "list";
    if (target.closest(".task:not(.task-new), .bot")) shell.dataset.view = "detail";

    const mode = target.closest("[data-mode]")?.dataset.mode;
    if (mode) {
      state.menu = false;
      if (mode === "steer" || mode === "queue") state.mode = mode;
      renderComposer();
    }

    const queue = target.closest("[data-queue]");
    if (queue) {
      const [text] = state.queued.splice(Number(queue.dataset.index), 1);
      if (queue.dataset.queue === "send") add(CT.msg({ role: "user", html: CT.esc(text) }) + CT.caption("<span>Steer</span>"));
      renderComposer();
    }
  });

  function send() {
    const text = state.text.trim();
    if (!text) return;
    state.text = "";
    state.menu = false;
    state.pinned = true;
    if (state.run === "stopping" || ((state.run === "running" || state.run === "waiting") && state.mode === "queue")) {
      state.queued.push(text);
    } else if (state.run === "running" || state.run === "waiting") {
      add(CT.msg({ role: "user", html: CT.esc(text) }) + CT.caption("<span>Steer</span>"));
      // A steer closes an open approval card and the run goes on without it.
      if ($("#approval")?.dataset.state === "pending" && resolveGate) {
        $("#approval").outerHTML = CT.approvalResolved({ id: "approval", state: "closed-message", line: "Move the transcode cache aside on media-box", when: clockTime(), outcome: "Your message closed this request. The command was not run.", full: S.approval.full });
        decision = "deny";
        resolveGate();
      }
    } else {
      add(CT.msg({ role: "user", html: CT.esc(text) }) + CT.caption("<span>The script has one run. In the app this starts the next.</span>"));
    }
    renderComposer();
    $(".composer-input").focus();
  }

  document.addEventListener("input", (event) => {
    if (!event.target.classList.contains("composer-input")) return;
    const had = Boolean(state.text);
    state.text = event.target.value;
    if (had !== Boolean(state.text)) renderComposer();
  });

  document.addEventListener("keydown", (event) => {
    const inComposer = event.target.classList?.contains("composer-input");
    if (inComposer && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (event.altKey && state.run !== "idle") state.mode = "queue";
      send();
      if (event.altKey) state.mode = "steer";
    }
    if ((event.metaKey || event.ctrlKey) && event.key === ".") {
      event.preventDefault();
      stop();
    }
    if (event.key === "Escape" && state.menu) {
      state.menu = false;
      renderComposer();
    }
  });

  // While the run plays, the elapsed time ticks once a second.
  setInterval(() => {
    if (state.run === "idle" || state.instant || state.run === "stopping") return;
    state.clock += 1;
    const node = $(".status-elapsed", inner);
    if (node) node.textContent = elapsed();
  }, 1000);

  // First paint ----------------------------------------------------------------------------

  inner.innerHTML =
    CT.stamp("Today 5:02 PM") +
    CT.msg({ role: "user", html: "Did last night's backup finish?" }) +
    CT.activity({ state: "completed", label: "Worked for 9s", count: "2 steps", steps: CT.step({ kind: "list", title: "Looked through logs", detail: "31 files", statusText: "0.2s" }) + CT.step({ kind: "read", title: "Read backup-2026-11-15.log", detail: "214 lines", statusText: "0.6s" }) }) +
    CT.msg({ html: "Yes. It finished at 3:25 AM, but it took 71 minutes. It usually takes about 23." }) +
    CT.stamp("Today 5:24 PM");
  renderRail();
  renderComposer();

  const extra = $("#proto-extra");
  if (extra) {
    extra.innerHTML =
      `<span class="run-controls"><button type="button" id="run-play">Play the run</button>` +
      `<button type="button" id="run-step">Step</button><button type="button" id="run-reset">Restart</button>` +
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
  }

  // For tests and screenshots: run without waits up to a named moment.
  window.demo = {
    labels: script.map((op) => op.label),
    async runTo(label) {
      state.instant = true;
      await play(label);
      state.instant = false;
    },
    answer(choice) {
      decision = choice;
      resolveGate?.();
    },
    stop,
    state,
  };
})();
