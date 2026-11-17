// The three runs that test the action cards (conversation.md, section 7):
//
//   short    a short run with two actions
//   long     a long run with forty actions of mixed kinds, which must stay calm
//   thought  a run with reasoning and a text reply and no action
//
// Each scene is a list of events, in the order a gateway would send them. The
// gallery draws each scene's end; conversation.html?scene=<name> plays it inside
// the shell, with the status line, and ?scene=<name>&at=end draws its end at once.
// From a test:  scenes.runTo("end"), scenes.state

(function () {
  const CT = window.CT;
  const S = CT.samples;
  const esc = CT.esc;

  let n = 0;
  const id = () => `call_9c${String(++n).padStart(2, "0")}`;
  const mk = (name, args, more = {}) => ({ id: id(), name, args, took: "0.4s", ...more });
  const ex = (command, text, took = "0.8s", exitCode = 0) =>
    mk("exec", { command, workdir: "~/house", host: "study-mac" }, { commandBearing: true, text, took, details: { status: "completed", exitCode, exitSignal: null, exitReason: "exit", durationMs: 800, aggregated: "", noOutputTimedOut: false, cwd: "~/house" } });
  const diff = (path, added) => [`--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", ...added.map((l) => `+${l}`)].join("\n");
  const ed = (path, added) => mk("edit", { path, edits: [{ oldText: "", newText: added.join("\n") }] }, { text: `Edited ${path}.`, details: { changed: true, diff: diff(path, added), firstChangedLine: 1, patch: "" }, took: "0.2s" });
  const page = (url, title) => mk("web_fetch", { url, extractMode: "text" }, { text: `${title}\n\n…`, details: { title }, took: "1.1s" });
  const br = (args, page, took = "0.6s") => mk("browser", args, { page, text: "ok", took });

  // A scene: { title, user, events, end }. Events:
  //   { bubble }            the bot's text: a progress message, or text beside a tool call
  //   { start: call, thought? }  a call starts; `thought` is the reasoning that led to it
  //   { end: id, ...patch } its result
  //   { thought: {time,text} }   reasoning that led to the reply, with no action after it
  //   { reply }             the reply
  //   { card: html }        any other card (a Messaged card), which also ends a column
  //   { run: {...} }        the run ends: the run line, when it had actions

  const scenes = {};

  // A short run with two actions ---------------------------------------------------------
  {
    const read = mk("read", { path: "logs/backup-2026-11-15.log" }, { text: S.log, took: "0.6s" });
    const tail = ex("tail -n 2 logs/backup-2026-11-15.log", "03:25:03 backup: finished ok\n03:25:03 backup: next run 2026-11-17 02:14", "0.1s");
    scenes.short = {
      title: "A short run with two actions",
      user: "Is last night's backup log there, and did it finish?",
      events: [
        { start: read, phrase: "Reading backup-2026-11-15.log" },
        { end: read.id, status: "done" },
        { start: tail, phrase: "Running tail" },
        { end: tail.id, status: "done" },
        { reply: "<p>Yes. The log is there, and the backup finished at 3:25 AM. The next run is tonight at 2:14.</p>" },
        { run: { label: "Worked for 4s", actions: 2, failed: 0 } },
      ],
    };
  }

  // A long run with forty actions of mixed kinds ------------------------------------------
  {
    const e = [];
    const go = (c, phrase, more = {}) => {
      e.push({ start: c, phrase, ...more });
      e.push({ end: c.id, status: c.status || "done" });
    };
    e.push({ bubble: "On it. Checking what we already know about the house first." });
    go(mk("memory_search", { query: "loft insulation" }, { text: "memory/2026-09-14.md: Loft insulation is 100 mm; the surveyor said 270 mm.", details: { count: 1 }, took: "0.3s" }), 'Searching memory for "loft insulation"');
    go(mk("memory_search", { query: "heating bills" }, { text: "memory/2026-03-02.md: Gas last winter: about 14,800 kWh.", details: { count: 1 }, took: "0.3s" }), 'Searching memory for "heating bills"');
    go(mk("read", { path: "house/floor-plan.md" }, { text: "Ground floor 52 m²\nFirst floor 48 m²\nLoft (unconverted)", took: "0.2s" }), "Reading floor-plan.md");
    go(mk("read", { path: "house/energy-bills-2025.csv" }, { text: "month,kwh\njan,2410\nfeb,2105\nmar,1820", took: "0.2s" }), "Reading energy-bills-2025.csv");
    go(mk("read", { path: "house/epc-2019.pdf" }, { status: "failed", isError: true, text: "ENOENT: no such file or directory, open 'house/epc-2019.pdf'", took: "0.1s" }), "Reading epc-2019.pdf");
    go(mk("read", { path: "house/epc-2023.pdf" }, { text: "Energy rating: D (61)\nMain heating: gas boiler, radiators", took: "0.4s" }), "Reading epc-2023.pdf");
    go(mk("ls", { path: "house/quotes" }, { text: "boiler-2024.pdf\nwindows-2023.pdf", took: "0.1s" }), "Looking in quotes");
    go(mk("progress_card", { plan: [{ step: "What fits the house", status: "pending" }, { step: "What it costs after the rebate", status: "pending" }, { step: "Book a survey if it is worth it", status: "pending" }] }, { text: "Saved the plan.", details: { revision: 1, steps: {} }, took: "0.1s" }), "Making a plan");
    e.push({ bubble: "The house loses most heat through the loft. Now what the market says about cold, damp winters." });
    go(mk("web_search", { query: "air source heat pump cold damp climate", count: 5 }, { text: "5 results.", details: { kind: "web_search_results", results: [1, 2, 3, 4, 5].map((i) => ({ title: `Result ${i}`, url: `https://energy.example.org/r${i}` })) }, took: "1.9s" }), 'Searching the web for "air source heat pump cold damp climate"');
    go(mk("web_search", { query: "heat pump sizing 100 m2 house", count: 5 }, { text: "5 results.", details: { kind: "web_search_results", results: [1, 2, 3, 4, 5].map((i) => ({ title: `Result ${i}`, url: `https://sizing.example.com/r${i}` })) }, took: "1.6s" }), 'Searching the web for "heat pump sizing 100 m2 house"');
    go(mk("web_search", { query: "heat pump rebate 2026", count: 5 }, { text: "3 results.", details: { kind: "web_search_results", results: [1, 2, 3].map((i) => ({ title: `Result ${i}`, url: `https://grants.example.org/r${i}` })) }, took: "1.4s" }), 'Searching the web for "heat pump rebate 2026"');
    go(page("https://energy.example.org/cold-climate", "Heat pumps below freezing"), "Opening energy.example.org");
    go(page("https://sizing.example.com/guide", "Sizing a heat pump"), "Opening sizing.example.com");
    go(page("https://grants.example.org/2026", "Rebates for 2026"), "Opening grants.example.org");
    go(page("https://grants.example.org/apply", "How to apply"), "Opening grants.example.org");
    go(page("https://forum.example.net/t/damp-winters", "Damp winters and defrost cycles"), "Opening forum.example.net");
    go(mk("x_search", { query: "heat pump rebate 2026 wait times" }, { text: "Posts mention a six-week wait for the rebate.", took: "3.1s" }), 'Searching posts on X for "heat pump rebate 2026 wait times"');
    e.push({ bubble: "Prices next. The installer's site only quotes through its form, so I am using the browser." });
    go(br({ action: "open", targetUrl: "https://installer.example/quote" }, "installer.example", "1.3s"), "Opening installer.example");
    go(br({ action: "act", request: { kind: "type", ref: "e4", element: "Postcode", text: "AB1 2CD" } }, "installer.example"), 'Typing into "Postcode"');
    go(br({ action: "act", request: { kind: "click", ref: "e9", text: "Semi-detached" } }, "installer.example"), 'Clicking "Semi-detached"');
    go(br({ action: "act", request: { kind: "type", ref: "e12", element: "Floor area", text: "100" } }, "installer.example"), 'Typing into "Floor area"');
    go(br({ action: "act", request: { kind: "click", ref: "e15", text: "8 kW" } }, "installer.example"), 'Clicking "8 kW"');
    go(br({ action: "act", request: { kind: "click", ref: "e21", text: "Get my quote" } }, "installer.example", "2.4s"), 'Clicking "Get my quote"');
    go(br({ action: "snapshot" }, "installer.example"), "Reading the page");
    go(br({ action: "screenshot" }, "installer.example"), "Taking a screenshot");
    go(br({ action: "act", request: { kind: "click", ref: "e30", text: "Save quote" } }, "installer.example"), 'Clicking "Save quote"');
    go(mk("progress_card", { plan: [{ step: "What fits the house", status: "done" }, { step: "What it costs after the rebate", status: "pending" }, { step: "Book a survey if it is worth it", status: "pending" }] }, { update: true, text: "Saved the plan.", details: { revision: 2, steps: {} }, took: "0.1s" }), "Updating the plan");
    go(ex("python3 estimate.py --unit 8kw --loft 100", "Annual heat demand: 11,900 kWh", "0.9s"), "Running python3");
    go(ex("python3 estimate.py --unit 8kw --loft 270", "Annual heat demand: 9,400 kWh", "0.9s"), "Running python3");
    go(ex("python3 running-cost.py --scop 3.1 --kwh 9400", "Running cost: about £710 a year", "0.4s"), "Running python3");
    go(ex("python3 running-cost.py --gas --kwh 14800", "Running cost: about £960 a year", "0.4s"), "Running python3");
    go(ex("python3 payback.py --price 9800 --rebate 7500 --saving 250", "Payback: 9.2 years", "0.3s"), "Running python3");
    go(ed("house/heat-pump.md", ["## Fit", "An 8 kW unit, once the loft is brought to 270 mm."]), "Editing heat-pump.md");
    go(ed("house/heat-pump.md", ["## Cost", "£9,800 quoted, £2,300 after the rebate."]), "Editing heat-pump.md");
    go(ed("house/costs.csv", ["heat-pump,2300", "loft-insulation,650"]), "Editing costs.csv");
    go(mk("write", { path: "memory/2026-11-17.md", content: "Heat pump: worth it once the loft is insulated; survey booked for Dec 2." }, { text: "Wrote 1 line.", details: { changed: true, created: true, diff: diff("memory/2026-11-17.md", ["Heat pump: worth it once the loft is insulated."]) }, took: "0.1s" }), "Saving to memory");
    e.push({
      card: CT.messaged({ target: "marlow", first: "Turn the heat pump notes into a one-page summary for Dana.", state: "replied", body: S.marlowBody("replied") }),
      phrase: "Messaging Marlow",
      count: 1,
    });
    go(mk("automations", { action: "add", job: { name: "Rebate deadline", schedule: { kind: "cron", expr: "0 9 * * 1" }, payload: { message: "Remind me of the rebate deadline." } } }, { text: "Created.", took: "0.2s" }), "Creating routine Rebate deadline");
    go(mk("progress_card", { plan: [{ step: "What fits the house", status: "done" }, { step: "What it costs after the rebate", status: "done" }, { step: "Book a survey if it is worth it", status: "done" }] }, { update: true, text: "Saved the plan.", details: { revision: 3, steps: {} }, took: "0.1s" }), "Updating the plan");
    go(mk("message", { action: "send", channel: "Telegram", to: "Dana", message: "Heat pump survey booked for Dec 2. Summary in the house folder." }, { status: "made", text: "ok", took: "0.6s" }), "Sending a message on Telegram");
    e.push({
      reply:
        "<p><strong>Worth it, once the loft is insulated.</strong> An 8 kW unit fits. After the 2026 rebate it costs about £2,300 and saves about £250 a year, so it pays back in roughly nine years.</p>" +
        "<ul><li>One thing first: bring the loft to 270 mm (about £650).</li><li>A survey is booked for Dec 2, and Dana has the summary.</li><li>I couldn't find the 2019 energy certificate; the 2023 one says D.</li></ul>",
    });
    e.push({ run: { label: "Worked for 6m 41s", actions: 40, failed: 1 } });
    scenes.long = {
      title: "A long run with forty actions of mixed kinds",
      user: "Get the heat pump decision ready: what fits the house, what it costs after the rebate, and book a survey if it is worth it.",
      events: e,
    };
  }

  // Reasoning, a reply, and no action -----------------------------------------------------
  scenes.thought = {
    title: "A run with reasoning and a text reply and no action",
    user: "Is a heat pump worth it in a cold, damp town?",
    events: [
      { thought: S.reasonings.beforeReply, phrase: "Thinking" },
      {
        reply:
          "<p>Usually yes, if two things are true: the house holds its heat (loft and walls insulated), and the unit is sized for your coldest week, not an average one.</p><p>Damp air makes the unit defrost more often, which costs a little efficiency, not a lot. Want me to check it against your house?</p>",
      },
      { run: null },
    ],
  };

  CT.scenes = scenes;

  // Drawing a scene -----------------------------------------------------------------------

  // Apply one event to a transcript. `ctx` holds the feed and the count of actions.
  CT.sceneStep = (ev, ctx) => {
    const { feed, add } = ctx;
    if (ev.bubble) {
      feed.gap();
      add(CT.msg({ html: esc(ev.bubble) }));
    } else if (ev.start) {
      ctx.actions += 1;
      feed.start({ ...ev.start, status: "running", elapsed: "", thought: ev.thought });
    } else if (ev.end) {
      const { end, phrase, ...patch } = ev;
      feed.update(end, { ...patch, status: patch.status || "done" });
    } else if (ev.card) {
      ctx.actions += ev.count || 0;
      add(ev.card);
      feed.gap();
    } else if (ev.thought) {
      add(CT.thought({ place: "reply", time: ev.thought.time, text: ev.thought.text, raw: CT.thoughtRaw(ev.thought.text) }));
      feed.gap();
    } else if (ev.reply) {
      feed.gap();
      add(CT.msg({ md: true, html: ev.reply }));
    } else if (ev.run) {
      add(CT.runLine({ id: "scene-run-line", ...ev.run, model: "scripted/dev-1", effort: "low", run: "run_2e81d0a4" }));
    }
  };

  // The end of a scene, as markup: what a person sees with nothing opened.
  CT.sceneHtml = (name) => {
    const scene = scenes[name];
    const box = document.createElement("div");
    const add = (html) => {
      const holder = document.createElement("div");
      holder.innerHTML = html;
      const first = holder.firstElementChild;
      box.append(...holder.children);
      return first;
    };
    add(CT.msg({ role: "user", html: esc(scene.user) }));
    const ctx = { add, actions: 0 };
    ctx.feed = CT.feed({ insert: add, instant: () => true });
    scene.events.forEach((ev) => CT.sceneStep(ev, ctx));
    return box.innerHTML;
  };

  // Playing a scene inside the shell (conversation.html?scene=<name>) ----------------------

  const name = CT.params.get("scene");
  if (!name || !scenes[name] || !document.getElementById("transcript-inner")) return;
  const scene = scenes[name];
  const titles = { short: "Backup log check", long: "Heat pump decision", thought: "Heat pumps in a damp town" };

  const state = { index: 0, clock: 0, phrase: "Thinking", face: "thinking", running: false, done: false, actions: 0 };
  let inner;
  let transcript;

  const statusHtml = () =>
    CT.statusLine({ bot: "otto", state: state.face, phrase: state.phrase, elapsed: `${Math.floor(state.clock / 60)}:${String(state.clock % 60).padStart(2, "0")}`, steps: state.face === "working" });
  const renderStatus = () => {
    inner.querySelector(".status-line")?.remove();
    if (state.running) inner.insertAdjacentHTML("beforeend", statusHtml());
  };
  const add = (html) => {
    const status = inner.querySelector(".status-line");
    const holder = document.createElement("div");
    holder.innerHTML = html;
    const nodes = [...holder.children];
    nodes.forEach((node) => (status ? inner.insertBefore(node, status) : inner.appendChild(node)));
    return nodes[0];
  };
  const follow = () => {
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  };
  let ctx;

  function reset() {
    inner.innerHTML = CT.stamp("Today 5:24 PM") + CT.msg({ role: "user", html: esc(scene.user) });
    Object.assign(state, { index: 0, clock: 0, phrase: "Thinking", face: "thinking", running: true, done: false, actions: 0 });
    ctx = { add, actions: 0 };
    ctx.feed = CT.feed({ insert: add, follow });
    renderStatus();
  }

  // One event, and what the status line says after it.
  function step() {
    const ev = scene.events[state.index];
    if (!ev) return false;
    state.index += 1;
    state.clock += ev.end ? 1 : ev.start ? 0 : 2;
    CT.sceneStep(ev, ctx);
    state.actions = ctx.actions;
    if (ev.start || ev.card) [state.face, state.phrase] = ["working", ev.phrase];
    else if (ev.end || ev.bubble || ev.thought) [state.face, state.phrase] = ["thinking", "Thinking"];
    if (ev.run !== undefined) {
      state.running = false;
      state.done = true;
    }
    renderStatus();
    follow();
    return true;
  }

  let timer = null;
  function play(instant = false) {
    clearTimeout(timer);
    if (instant) {
      while (step());
      return;
    }
    const next = () => {
      if (step()) timer = setTimeout(next, scene.events[state.index - 1]?.start ? 520 : 380);
    };
    next();
  }

  window.scenes = {
    state,
    runTo(label) {
      if (label === "end") play(true);
      else while (state.index < Number(label) && step());
    },
    replay() {
      reset();
      play();
    },
  };

  document.addEventListener("DOMContentLoaded", () =>
    setTimeout(() => {
      inner = document.getElementById("transcript-inner");
      transcript = document.getElementById("transcript");
      const task = document.querySelector(".title-pill-task");
      if (task) task.textContent = titles[name];
      const extra = document.getElementById("proto-extra");
      if (extra) {
        extra.innerHTML =
          `<span class="run-controls"><button type="button" id="scene-replay">Play again</button>` +
          `<span id="run-caption">${esc(scene.title)}. Nothing on the cards needs opening to follow it.</span></span>`;
        document.getElementById("scene-replay").addEventListener("click", () => window.scenes.replay());
      }
      reset();
      play(CT.params.get("at") === "end");
    }, 0),
  );
})();
