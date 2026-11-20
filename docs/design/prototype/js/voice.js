// voice.html: docs/design/voice.md. Dictation, a voice chat and its band,
// voice, speed and language, ending and failing, one call at a time, the
// "Voice chat" line, voice memos, and Settings › Voice. Every bot, task,
// voice and device is a local fixture; nothing records or plays sound. The
// system's microphone prompt is a labelled picture.
//
// Address parameters (section 15 of the design lists them):
//   bot task access run prefs voice dict os ondevice mic seen state reason line memo page

(function () {
  const CT = window.CT;
  const params = CT.params;
  const p = (name) => params.get(name);
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name, cls) => CT.icon(name, cls);
  const button = (label, attrs = "", variant = "") =>
    `<button type="button" class="button" data-size="sm"${variant ? ` data-variant="${variant}"` : ""} ${attrs}>${label}</button>`;
  // A microphone and a waveform, drawn for this prototype.
  const MIC =
    '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.6" y="1.8" width="4.8" height="8" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3.4 7.6a4.6 4.6 0 0 0 9.2 0M8 12.2v2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  const WAVE =
    '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6.5v3M5 4v8M7.5 2.5v11M10 5v6M12.5 6.5v3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

  // Fixtures ---------------------------------------------------------------------------------------

  const GATEWAY = "Home gateway";
  const PROVIDER = "OpenAI Realtime Voice";
  const TRANSCRIBER = "OpenAI Realtime Transcription";
  const BOTS = [
    { id: "juniper", name: "Juniper", tasks: [{ id: "j1", title: "Heat pump vs. gas furnace", when: "5:24 PM", ask: "Compare a heat pump with a gas furnace for this house.", reply: "Here's the comparison, with ten-year running costs." }] },
    { id: "otto", name: "Otto", tasks: [{ id: "o1", title: "Disk almost full on the media box", when: "5:36 PM", ask: "Free up space on the media box.", reply: "The transcode cache is the largest folder: 212 GB." }] },
    { id: "pip", name: "Pip", tasks: [{ id: "p1", title: "Saturday errands route", when: "4:10 PM", ask: "Read me the route for Saturday.", reply: "Here's the route as a voice memo.", memo: true }] },
  ];
  const bot = (id) => BOTS.find((b) => b.id === id);
  const taskOf = (id) => BOTS.flatMap((b) => b.tasks.map((t) => ({ b, t }))).find((x) => x.t.id === id);
  const VOICES = ["Default", "Alloy", "Cedar", "Marin", "Sage"];
  const SPEEDS = ["0.5", "0.75", "1", "1.25", "1.5", "2"];
  const LANGS = [["auto", "Auto-detect"], ["en", "English"], ["es", "Español"], ["fr", "Français"], ["de", "Deutsch"], ["ja", "日本語"]];
  const DEVICES = ["System Default", "MacBook Pro Microphone", "USB Microphone"];
  const MEMO_ADDRESS = "https://media.example.net/pip/route-saturday.mp3";
  const TURNS = [
    ["You", "Is the media box still nearly full?"],
    ["Otto", "Yes. It's at 91 percent, and the transcode cache is most of it."],
    ["You", "Clear anything older than a month."],
    ["Otto", "I'll ask before deleting. That frees about 160 gigabytes."],
  ];

  // State --------------------------------------------------------------------------------------------

  const S = {
    access: p("access") === "read" ? "read" : "write",
    run: p("run") === "running" ? "running" : "idle",
    prefs: p("prefs") === "none" ? "device" : "gateway", // where each bot's voice settings are kept
    notices: [], // the composer's shelf notices
    noticeSeq: 0,
    voice: ["none", "direct", "unknown"].includes(p("voice")) ? p("voice") : "ready",
    dict: p("dict") === "none" ? "none" : "ready",
    os: ["windows", "web", "remote", "iphone"].includes(p("os")) ? p("os") : "mac",
    ondevice: p("ondevice") !== "0",
    mic: ["prompt", "denied", "none", "missing"].includes(p("mic")) ? p("mic") : "granted",
    seen: { call: p("seen") === "1", dict: p("seen") === "1" },
    dictRoute: null,
    sel: { bot: p("bot") && bot(p("bot")) ? p("bot") : "otto", task: null },
    view: "detail",
    drafts: {},
    connected: true,
    dictating: null, // {route, words, partial}
    call: null, // the one call on this device
    lines: {}, // task -> [{kind, dur}]
    openLine: null,
    kept: { otto: { voice: "Default", speed: "1", lang: "auto" }, juniper: { voice: "Default", speed: "1", lang: "auto" }, pip: { voice: "Default", speed: "1", lang: "auto" } },
    flags: { closeFail: false, createFail: false, voiceFail: false, noVoices: false, langFail: false, dictFail: false },
    memo: ["text", "notext", "big", "fail", "address", "nohttp"].includes(p("memo")) ? p("memo") : "ready",
    memoPlaying: false,
    memoAt: 0,
    memoText: p("memo") === "text",
    chosenMic: p("mic") === "missing" ? "USB Microphone" : "System Default",
    pending: null, // what the consent sheet starts
  };
  S.sel.task = p("task") && taskOf(p("task")) ? p("task") : bot(S.sel.bot).tasks[0].id;
  if (taskOf(S.sel.task).b.id !== S.sel.bot) S.sel.bot = taskOf(S.sel.task).b.id;
  if (S.os === "iphone") S.view = "detail";
  if (p("state") === "voicegone") S.kept.otto.voice = "Ember";

  const canWrite = () => S.access === "write";
  const noMicPage = () => S.os === "remote";
  const deviceRoute = () => {
    if (S.os === "windows") return { ok: false, why: "Windows has no speech recognition Clawtrate can use without sending your voice to Microsoft." };
    if (S.os === "web" || S.os === "remote") return { ok: false, why: "The browser preview has no on-device recognition Clawtrate can use." };
    if (!S.ondevice) return { ok: false, why: `On this ${S.os === "iphone" ? "iPhone" : "Mac"} isn't available for English (United States): this ${S.os === "iphone" ? "iPhone" : "Mac"} can't recognize it without the network.` };
    return { ok: true };
  };
  const gatewayRoute = () => {
    if (!S.connected) return { ok: false, why: `Not connected to ${GATEWAY}.` };
    if (S.dict === "none") return { ok: false, why: `Dictation through ${GATEWAY} isn't set up on the gateway.` };
    return { ok: true };
  };
  const here = () => (S.os === "iphone" ? "iPhone" : S.os === "windows" ? "PC" : S.os === "mac" ? "Mac" : "computer");
  const SENTENCE = {
    call: (b) => `Your voice goes to ${GATEWAY} over this connection, and the gateway sends it to ${PROVIDER}, which listens and speaks ${b}'s replies. What you both say is saved as text in this task. Clawtrate doesn't keep the recording.`,
    gateway: () => `Your voice goes to ${GATEWAY}, which sends it to ${TRANSCRIBER} and sends the text back. Nothing of it is saved in the task. Clawtrate doesn't keep the recording.`,
    device: () => `Apple's speech recognition turns your voice into text on this ${here()}, with its network use turned off. It's offered only for languages this ${here()} can recognize on its own.`,
  };
  const keptLine = (name) =>
    S.prefs === "gateway" ? `Saved for ${name} on ${GATEWAY}, so your other devices use it too.` : `Kept on this device for ${name}.`;
  const callReason = () => {
    if (noMicPage()) return "This page can't use a microphone: a browser allows one only over https or on this computer itself.";
    if (S.voice === "none") return `Voice chat isn't set up on ${GATEWAY}.`;
    if (S.voice === "direct") return `${GATEWAY}'s voice provider talks to apps directly, which Clawtrate doesn't do.`;
    return "";
  };
  const micReason = () => {
    if (noMicPage()) return "This page can't use a microphone: a browser allows one only over https or on this computer itself.";
    if (S.call && !["failed"].includes(S.call.state)) return "The microphone is in use by the voice chat.";
    if (!deviceRoute().ok && !gatewayRoute().ok && S.dictRoute === null && S.seen.dict) return "Dictation isn't available here.";
    return "";
  };

  // Announcements -------------------------------------------------------------------------------------

  const say = (text) => {
    const live = $("#live");
    live.textContent = "";
    requestAnimationFrame(() => (live.textContent = text));
    live.dataset.last = text;
  };

  // Rail, header, transcript ----------------------------------------------------------------------------

  function renderRail() {
    const el = $("#bot-list");
    el.innerHTML = BOTS.map((b) => {
      const open = b.id === S.sel.bot;
      const t = b.tasks[0];
      const inCall = S.call && S.call.bot === b.id && S.call.state !== "failed";
      return (
        `<li class="bot-group"${open ? ' data-open="true"' : ""}>` +
        `<button type="button" class="bot" data-v-bot="${b.id}" aria-current="${open}" data-testid="bot">` +
        `<span class="avatar" data-bot="${b.id}"></span>` +
        `<span class="bot-text"><span class="bot-line"><span class="bot-name">${b.name}</span><time class="bot-time">${t.when}</time></span>` +
        `<span class="bot-line"><span class="bot-preview">${inCall ? "In a voice chat" : esc(t.reply)}</span></span></span></button>` +
        (open ? `<ul class="task-list" aria-label="${b.name}'s tasks"><li><button type="button" class="task" data-v-task="${t.id}" aria-current="${S.sel.task === t.id}"><span class="task-title">${esc(t.title)}</span><time class="task-time">${t.when}</time></button></li></ul>` : "") +
        `</li>`
      );
    }).join("");
    CT.hydrate(el);
  }

  function header() {
    const { b, t } = taskOf(S.sel.task);
    $("#title-pill").innerHTML = `<span class="avatar" data-bot="${b.id}"></span><span class="title-pill-name">${b.name}</span><span class="title-pill-task">${esc(t.title)}</span>`;
    CT.hydrate($("#title-pill"));
  }

  const turnHtml = (role, html) => `<div class="turn" data-role="${role}">${CT.msg({ role, html })}</div>`;

  function lineHtml(taskId, line, i) {
    const id = `line-${taskId}-${i}`;
    const open = S.openLine === id;
    let label = `Voice chat · ${line.dur}`;
    if (line.kind === "elsewhere") label = "Voice chat · 6 turns · 5:31–5:36 PM";
    if (line.kind === "empty") label = `Voice chat · ${line.dur} · nothing was saved`;
    const turns = line.kind === "empty" ? [] : line.kind === "elsewhere" ? [...TURNS, ...TURNS.slice(0, 2)] : TURNS;
    return (
      `<div class="call-line" data-testid="call-line"><button type="button" data-v="line" data-line="${id}" aria-expanded="${open}" aria-controls="${id}-turns"${turns.length ? "" : " disabled"}>${icon("chevron")}${label}</button></div>` +
      (line.endfail ? `<p class="call-line-note" data-testid="endfail">Ended on this device. ${GATEWAY} didn't confirm; it ends the call when this connection closes, or after 30 minutes.</p>` : "") +
      `<div class="call-turns" id="${id}-turns" data-testid="call-turns"${open ? "" : " hidden"}>` +
      turns.map(([who, text], n) => turnHtml(who === "You" ? "user" : "assistant", `<p>${esc(text)}</p><p class="v-faint">${who === "You" ? "You" : taskOf(taskId).b.name}, said at 5:3${1 + n} PM</p>`)).join("") +
      `</div>`
    );
  }

  function memoHtml() {
    const sp = S.kept.pip.speed;
    if (S.memo === "big") return `<div class="memo" data-testid="memo"><p>This voice memo is 7.2 MiB. Clawtrate fetches items up to 5 MiB, so it can't be played here.</p></div>`;
    // docs/decisions.md: an address the item carries is never fetched by itself; opening
    // it follows the link row, with the full address shown beside the control.
    if (S.memo === "address")
      return (
        `<div class="memo" data-testid="memo"><p>This voice memo is at an address Clawtrate doesn't open by itself:</p>` +
        `<p class="mono v-address" data-testid="memo-address">${esc(MEMO_ADDRESS)}</p>${button("Open in browser", 'data-v="memo-open"')}</div>`
      );
    if (S.memo === "nohttp")
      return `<div class="memo" data-testid="memo"><p>This voice memo can't be played on this iPhone yet: ${GATEWAY} offers it as a download, and the iPhone app doesn't make downloads yet.</p></div>`;
    if (S.memo === "fail")
      return `<div class="memo" data-testid="memo"><p>Couldn't load the voice memo.</p>${button("Try again", 'data-v="memo-retry"')}</div>`;
    const at = `0:${String(S.memoAt).padStart(2, "0")}`;
    const text =
      S.memo === "notext"
        ? `<p class="v-faint" data-testid="memo-notext">No text came with this recording.</p>`
        : `<button type="button" class="link-button" data-v="memo-text" aria-expanded="${S.memoText}" aria-controls="memo-body">${S.memoText ? "Hide text" : "Show text"}</button>` +
          `<div class="memo-text" id="memo-body" data-testid="memo-text"${S.memoText ? "" : " hidden"}><p class="v-faint">The text this was made from</p><p>Leave at nine. Hardware store first, then the library, then the farmers market before it closes at one.</p>` +
          `<p class="v-faint" data-testid="no-highlight">Words aren't highlighted: the gateway gives no timing for each word.</p></div>`;
    return (
      `<div class="memo" data-testid="memo"><div class="memo-head">` +
      `<button type="button" class="icon-button" data-v="memo-play" aria-label="${S.memoPlaying ? "Pause voice memo" : "Play voice memo"}">${icon(S.memoPlaying ? "pause" : "play")}</button>` +
      `<span class="memo-name">Saturday route.m4a<small data-testid="memo-time">${S.memoPlaying || S.memoAt ? `${at} / 0:24` : "0:24"}</small></span>` +
      `<button type="button" class="speed" data-v="memo-speed" aria-label="Speed ${sp}×, kept on this device for Pip">${sp}×</button>` +
      `</div>${S.memo === "notext" ? text : `<div>${text}</div>`}</div>`
    );
  }

  function transcript() {
    const { b, t } = taskOf(S.sel.task);
    let body = `<div class="stamp">Today ${t.when}</div>` + turnHtml("user", `<p>${esc(t.ask)}</p>`) + turnHtml("assistant", `<p>${esc(t.reply)}</p>`);
    if (t.memo) body += `<div class="turn" data-role="assistant">${memoHtml()}</div>`;
    (S.lines[t.id] || []).forEach((line, i) => (body += lineHtml(t.id, line, i)));
    $("#transcript").innerHTML = `<div class="transcript-inner"><h1 class="task-line">${esc(t.title)}</h1>${body}</div>`;
    CT.hydrate($("#transcript"));
    void b;
  }

  // The composer: only the two buttons are this design's (section 3) ----------------------------------------

  // The composer as built (packages/ui/src/Composer.tsx): the shelf, then the row
  // "Attach files", the field, "How to send", [mic] [waveform], "Stopping…", Stop, Send.
  function renderComposer() {
    const el = $("#composer");
    const { b, t } = taskOf(S.sel.task);
    if (!canWrite()) {
      // The built access bar stands in the composer's place, unchanged by this design.
      el.innerHTML = CT.accessBar({ bot: b.id, state: "read" }).replace(/^<footer[^>]*>/, "").replace(/<\/footer>$/, "");
      return;
    }
    const draft = S.drafts[t.id] || "";
    const listening = Boolean(S.dictating);
    const mr = micReason();
    const cr = callReason();
    const myCall = S.call && S.call.task === t.id && S.call.state !== "failed";
    const showCall = !draft.trim() && !listening;
    const callLabel = myCall ? "In a voice chat" : "Start voice chat";
    const running = S.run === "running";
    const callWhy = cr || (S.voice === "unknown" && !myCall ? `Can't tell whether voice chat is set up on ${GATEWAY}.` : "");
    const notices = S.notices.filter((n) => n.task === t.id);
    const shelf = notices.length
      ? `<div class="shelf-notices" role="group" aria-label="Notifications">` +
        notices
          .map(
            (n) =>
              `<div class="shelf-row" data-tone="danger" role="alert" data-testid="notice"><span class="shelf-text"><b>${esc(n.title)}</b> <span>${esc(n.reason)}</span></span>` +
              (n.retry ? button("Try again", `data-v="notice-retry" data-notice="${n.id}"`) : "") +
              `<button type="button" class="icon-button" data-variant="quiet" aria-label="Dismiss" title="Dismiss" data-v="notice-dismiss" data-notice="${n.id}">${icon("x")}</button></div>`,
          )
          .join("") +
        `</div>`
      : "";
    el.innerHTML =
      `<div class="composer-inner"><div class="composer-shelf" aria-label="Waiting to send">${shelf}</div><div class="composer-box"><div class="composer-row">` +
      `<button type="button" class="icon-button" aria-label="Attach files" title="Attach files">${icon("plus")}</button>` +
      `<textarea class="composer-input" rows="1" aria-label="${running ? `Steer ${b.name}` : `Message ${b.name}`}" placeholder="${running ? `Steer ${b.name}` : `Message ${b.name}`}">${esc(draft)}</textarea>` +
      (running && draft.trim() ? `<button type="button" class="send-mode" aria-haspopup="menu" aria-expanded="false" aria-label="How to send: Steer">Steer${icon("chevron")}</button>` : "") +
      `<button type="button" class="icon-button mic-button" data-v="mic" data-testid="mic" data-state="${listening ? "listening" : "ready"}" aria-label="${listening ? "Stop dictation" : "Start dictation"}" title="${listening ? "Stop dictation" : "Start dictation"} (${S.os === "windows" ? "Ctrl+D" : "⌘D"})"` +
      `${mr && !listening ? ` aria-disabled="true" aria-description="${esc(mr)}"` : ""}>${MIC}</button>` +
      (showCall
        ? `<button type="button" class="icon-button call-button" data-v="call" data-testid="call-button" aria-label="${callLabel}" title="${esc(callWhy || callLabel)}"${myCall ? ' aria-pressed="true"' : ""}${cr ? ' aria-disabled="true"' : ""}${callWhy ? ` aria-description="${esc(callWhy)}"` : ""}>${WAVE}</button>`
        : "") +
      (running ? `<button type="button" class="icon-button stop-button" data-v="stop-run" data-testid="stop" aria-label="Stop ${b.name}" title="Stop ${b.name} (⌘.)"></button>` : "") +
      `<button type="button" class="icon-button send-button" data-v="send" data-testid="send" aria-label="${running ? "Steer this turn" : "Send"}"${draft.trim() ? "" : " disabled"}>${icon("arrow-up")}</button>` +
      `</div></div>` +
      (listening
        ? `<div class="dictation-line" data-testid="listening"><span class="mic-mark" data-on="true">Listening · Microphone on</span><span>${S.dictating.route === "device" ? `On this ${here()}` : `Through ${GATEWAY}`}</span><span class="v-partial" data-testid="partial"></span></div>`
        : "") +
      (mr && !listening ? `<p class="v-reason" data-testid="mic-why">${esc(mr)}</p>` : "") +
      (showCall && callWhy ? `<p class="v-reason" data-testid="call-why">${esc(callWhy)}</p>` : "") +
      `</div>`;
  }

  const notify = (title, reason, retry) => {
    const t = S.sel.task;
    S.notices = S.notices.filter((n) => !(n.task === t && n.title === title));
    S.notices.push({ id: `n${++S.noticeSeq}`, task: t, title, reason, retry });
  };

  // The call band (section 6) --------------------------------------------------------------------------------

  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  function renderCall() {
    const slot = $("#call-slot");
    const c = S.call;
    if (!c || c.task !== S.sel.task) {
      slot.innerHTML = c && c.state !== "failed" ? `<p class="v-reason" data-testid="elsewhere-call" style="text-align:center">In a voice chat with ${bot(c.bot).name}. ${button("Show", 'data-v="go-call"', "quiet")}</p>` : "";
      return;
    }
    const b = bot(c.bot);
    const kept = S.kept[c.bot];
    let top = "";
    let actions = "";
    let notes = "";
    let tone = "";
    const micMark = (on) => `<span class="mic-mark" data-on="${on}" data-testid="mic-mark">${on ? "Microphone on" : "Microphone off"}</span>`;
    if (c.state === "permission") {
      top = `<span class="call-title" data-testid="call-phase">Waiting for microphone access…</span>`;
      actions = `<span class="spacer"></span>${button("Cancel", 'data-v="cancel-start"', "quiet")}`;
    } else if (c.state === "denied") {
      tone = "danger";
      top = `<span class="call-title" data-testid="call-phase">${S.os === "windows" ? "Clawtrate can't use the microphone. Check Settings › Privacy & security › Microphone." : "Clawtrate can't use the microphone. Allow it in System Settings › Privacy & Security › Microphone."}</span>`;
      actions = `${S.os === "windows" ? "" : button("Open System Settings", 'data-v="noop"')}<span class="spacer"></span>${button("Dismiss", 'data-v="dismiss"', "quiet")}`;
    } else if (c.state === "nomic") {
      tone = "danger";
      top = `<span class="call-title" data-testid="call-phase">No microphone found.</span>`;
      actions = `<span class="spacer"></span>${button("Dismiss", 'data-v="dismiss"', "quiet")}`;
    } else if (c.state === "missing") {
      top = `<span class="call-title" data-testid="call-phase">${esc(S.chosenMic)} isn't connected.</span>`;
      actions = `${button("Use System Default this time", 'data-v="use-default"')}${button("Choose another", 'data-v="settings"', "quiet")}<span class="spacer"></span>${button("Cancel", 'data-v="cancel-start"', "quiet")}`;
    } else if (c.state === "connecting") {
      top = `<span class="avatar" data-bot="${b.id}"></span><span class="call-title" data-testid="call-phase">Connecting to ${b.name}…</span>`;
      actions = `${micMark(true)}<span class="spacer"></span>${button("Cancel", 'data-v="hangup"', "quiet")}`;
    } else if (c.state === "reconnecting") {
      top =
        `<span class="avatar" data-bot="${b.id}"></span><span class="call-title"><b>Voice chat with ${b.name}</b> · <span data-testid="call-phase">Reconnecting…</span></span>` +
        `<span class="call-time" data-testid="call-time">${mmss(c.secs)} on this device</span>`;
      actions = `${micMark(false)}<span class="spacer"></span>${button("Hang up", 'data-v="hangup" data-tone="danger"')}`;
      notes = `<p class="call-note" data-testid="call-note">The connection to ${GATEWAY} dropped. Nothing is being sent. The call starts again here when it reconnects.</p>`;
    } else if (c.state === "live" || c.state === "ending") {
      const phase = c.state === "ending" ? "Ending…" : c.muted ? "Muted" : c.phase;
      top =
        `<span class="avatar" data-bot="${b.id}"></span><span class="call-title"><b>Voice chat with ${b.name}</b> · <span data-testid="call-phase">${phase}</span></span>` +
        `<span class="call-time" data-testid="call-time">${mmss(c.secs)} on this device</span>`;
      const off = c.muted || c.micgone || c.state === "ending";
      actions =
        micMark(!off) +
        button(c.muted ? "Unmute" : "Mute", `data-v="mute" aria-pressed="${c.muted}"${c.state === "ending" || c.micgone ? " disabled" : ""}`) +
        button("Transcript", `data-v="transcript" aria-expanded="${c.transcriptOpen}" aria-controls="call-transcript"`) +
        button("Settings", `data-v="call-settings" aria-expanded="${c.settingsOpen}" aria-controls="call-settings"`) +
        `<span class="spacer"></span>` +
        button("Hang up", `data-v="hangup" data-tone="danger"${c.state === "ending" ? " disabled" : ""}`);
      if (c.muted) notes += `<p class="call-note" data-testid="call-note">Muted. This device's microphone is off.</p>`;
      if (c.micgone)
        notes += `<p class="call-note" data-testid="call-note"><b>The microphone stopped: USB Microphone was disconnected.</b> Nothing is being sent.</p><div class="call-actions">${button("Use System Default", 'data-v="mic-back"')}</div>`;
      if (c.limit) notes += `<p class="call-note" data-testid="call-limit">${GATEWAY} ends calls after 30 minutes. This one ends at 5:59 PM.</p>`;
      if (c.resumed)
        notes += `<p class="call-note" data-testid="call-resumed">Reconnected. ${GATEWAY} closed the call's session when the connection dropped, so the call goes on in a new one. Nothing said while it was down was heard.</p>`;
      if (c.voiceGone) notes += `<p class="call-note" data-testid="voice-gone">Ember isn't offered by ${GATEWAY} any more, so this call uses its default voice.</p>`;
      if (c.transcriptOpen)
        notes +=
          `<div class="call-transcript" id="call-transcript" role="log" aria-label="Live transcript" data-testid="call-transcript">` +
          (c.heard.length ? c.heard.map(([who, text, fin]) => `<p data-final="${fin}"><b>${who === "You" ? "You" : b.name}</b> ${esc(text)}</p>`).join("") : `<p class="v-faint">Nothing said yet.</p>`) +
          `</div><p class="call-note">Saved in this task as it's said.</p>`;
      if (c.settingsOpen) notes += settingsPanel(c, kept);
    } else if (c.state === "failed") {
      tone = "danger";
      const second = {
        "Connection lost": `The connection to ${GATEWAY} dropped and didn't come back within 30 seconds. What was said is saved in this task.`,
        "No connection": `This device isn't connected to ${GATEWAY}. Start again when it reconnects.`,
        "The call ended unexpectedly": `${GATEWAY} ended the call: ${c.why || "Realtime voice provider \"openai\" is not configured."}`,
      }[c.reason];
      top = `<span class="call-title"><b data-testid="call-phase">Voice chat failed</b></span>`;
      notes = `<p class="call-reason" data-testid="call-reason">${c.reason}</p><p class="call-note" data-testid="call-note">${esc(second)}</p>`;
      actions = `<span class="spacer"></span>${button("Dismiss", 'data-v="dismiss"')}`;
    }
    slot.innerHTML =
      `<section class="call-band" role="region" aria-label="Voice chat with ${b.name}" data-testid="call-band" data-state="${c.state}"${tone ? ` data-tone="${tone}"` : ""} tabindex="-1">` +
      `<div class="call-top">${top}</div>` +
      (c.state === "failed" ? notes + `<div class="call-actions">${actions}</div>` : `<div class="call-actions">${actions}</div>${notes}`) +
      `</section>`;
    CT.hydrate(slot);
  }

  function settingsPanel(c, kept) {
    const b = bot(c.bot);
    const radios = (name, list, current, fmt = (x) => x) =>
      `<div class="v-radios" role="radiogroup" aria-label="${name}">` +
      list.map((v) => `<button type="button" class="v-radio" role="radio" aria-checked="${v === current}" tabindex="${v === current ? 0 : -1}" data-v-${name.toLowerCase()}="${v}">${fmt(v)}</button>`).join("") +
      `</div>`;
    const voiceRow = S.flags.noVoices
      ? `<p class="v-row-note" data-testid="voice-note">${PROVIDER} offers no voices to choose from on ${GATEWAY}.</p>`
      : `${radios("Voice", VOICES, c.voice)}<p class="v-row-note" data-testid="voice-note">${esc(c.voiceMsg || (c.voice === "Default" ? `${b.name} speaks in ${GATEWAY}'s default voice.` : `Voice: ${c.voice}.`))}</p>`;
    const langNote = c.langMsg || `${GATEWAY} passes it to its voice provider.`;
    return (
      `<div class="call-settings" id="call-settings" data-testid="call-settings">` +
      `<h4>Voice</h4>${voiceRow}` +
      `<h4>Speed</h4>${radios("Speed", SPEEDS, kept.speed, (v) => `${v}×`)}<p class="v-row-note" data-testid="speed-note">Plays at ${kept.speed}× on this device.</p>` +
      `<h4>Language</h4><select class="v-select" data-v="lang" aria-label="Language" aria-describedby="lang-note"${c.langBusy ? " disabled" : ""}>${LANGS.map(([v, l]) => `<option value="${v}"${v === (c.langBusy || c.lang) ? " selected" : ""}>${l}</option>`).join("")}</select>` +
      `<p class="v-row-note" id="lang-note" data-testid="lang-note">${esc(langNote)}</p>` +
      `<p class="v-row-note" data-testid="kept-note">${esc(keptLine(b.name))}</p></div>`
    );
  }

  const langName = (v) => LANGS.find(([k]) => k === v)[1];

  // A session's language is set when it starts: a second session takes over (section 7).
  function setLang(v) {
    const c = S.call;
    if (!c || c.state !== "live" || v === c.lang) return;
    c.langBusy = v;
    c.langMsg = `Changing the language to ${langName(v)}…`;
    render();
    setTimeout(() => {
      if (S.call !== c) return;
      c.langBusy = null;
      if (S.flags.langFail) {
        c.langMsg = `The language didn't change: Too many active realtime relay sessions for this connection. The call goes on as before.`;
        say("The language didn't change");
      } else {
        c.lang = v;
        S.kept[c.bot].lang = v;
        c.sessionStart = c.secs;
        c.langMsg = `Language: ${langName(v)}, from what you say next.`;
        say(c.langMsg);
      }
      render();
      $('[data-v="lang"]')?.focus();
    }, 300);
  }

  // Dialogs: where the audio goes, one call at a time ----------------------------------------------------------

  function openConsent(kind) {
    const d = $("#consent-dialog");
    S.pending = kind;
    S.consentOpener = document.activeElement;
    const b = taskOf(S.sel.task).b;
    if (kind === "call") {
      d.innerHTML =
        `<div class="b-confirm voice-consent" data-testid="consent"><h2 id="consent-title">Where your voice goes</h2><p>${esc(SENTENCE.call(b.name))}</p>` +
        `<div class="b-actions">${button("Cancel", 'data-v="consent-cancel"', "quiet")}${button("Start voice chat", 'data-v="consent-ok" data-variant="primary"')}</div></div>`;
    } else {
      const dev = deviceRoute();
      const gw = gatewayRoute();
      const any = dev.ok || gw.ok;
      if (!S.dictChoice) S.dictChoice = dev.ok ? "device" : gw.ok ? "gateway" : null;
      const row = (id, title, ok, sentence, why) =>
        ok
          ? `<li><button type="button" class="b-choice" role="radio" aria-checked="${S.dictChoice === id}" tabindex="${S.dictChoice === id ? 0 : -1}" data-v-route="${id}"><span class="b-choice-text"><span class="b-choice-title">${title}</span><span class="b-choice-sub">${esc(sentence)}</span></span></button></li>`
          : `<li><div class="b-choice" aria-disabled="true"><span class="b-choice-text"><span class="b-choice-title">${title}</span><span class="b-choice-sub" data-testid="route-why">${esc(why)}</span></span></div></li>`;
      d.innerHTML =
        `<div class="b-confirm voice-consent" data-testid="consent"><h2 id="consent-title">${any ? "Where your voice goes" : "Dictation isn't available here"}</h2>` +
        `<ul class="b-choices" role="radiogroup" aria-label="Dictation">` +
        row("device", `On this ${here()}`, dev.ok, SENTENCE.device(), dev.why) +
        row("gateway", `Through ${GATEWAY}`, gw.ok, SENTENCE.gateway(), gw.why) +
        `</ul><div class="b-actions">${any ? `${button("Cancel", 'data-v="consent-cancel"', "quiet")}${button("Start dictation", 'data-v="consent-ok" data-variant="primary"')}` : button("Close", 'data-v="consent-cancel"')}</div></div>`;
    }
    if (!d.open) d.showModal();
    $('[data-v="consent-ok"]', d)?.focus() || $('[data-v="consent-cancel"]', d)?.focus();
  }

  function closeConsent(ok) {
    const d = $("#consent-dialog");
    const kind = S.pending;
    d.close();
    S.pending = null;
    if (!ok) {
      if (kind === "dict" && !deviceRoute().ok && !gatewayRoute().ok) S.seen.dict = true;
      render();
      return focusComposerButton(kind === "call" ? "call" : "mic");
    }
    if (kind === "call") {
      S.seen.call = true;
      beginCall(true);
    } else {
      S.seen.dict = true;
      S.dictRoute = S.dictChoice;
      startDictation();
    }
  }

  function askSecond(target) {
    const d = $("#confirm-dialog");
    const from = bot(S.call.bot).name;
    const to = bot(taskOf(target).b.id).name;
    S.secondTarget = target;
    d.innerHTML =
      `<div class="b-confirm" data-testid="second"><h2 id="confirm-title">End the current voice chat?</h2><p id="confirm-text">You're in a voice chat with ${from}. Ending it starts one with ${to}.</p>` +
      `<div class="b-actions">${button("Cancel", 'data-v="second-cancel"', "quiet")}${button("End and Chat", 'data-v="second-ok" data-variant="primary"')}</div></div>`;
    d.showModal();
    $('[data-v="second-ok"]', d).focus();
  }

  const focusComposerButton = (which) => requestAnimationFrame(() => $(`[data-v="${which}"]`)?.focus());

  // Dictation (section 4) -----------------------------------------------------------------------------------

  function pressMic() {
    if (S.dictating) return stopDictation();
    if (micReason()) return;
    if (!S.seen.dict || !S.dictRoute) return openConsent("dict");
    const route = S.dictRoute === "device" ? deviceRoute() : gatewayRoute();
    if (!route.ok) {
      notify("Couldn't start dictation.", route.why, route.why.startsWith("Not connected") ? null : pressMic);
      return render();
    }
    startDictation();
  }

  function startDictation() {
    if (S.mic === "denied" || S.mic === "none") {
      if (S.mic === "none") notify("No microphone found.", "", startDictation);
      else notify("Clawtrate can't use the microphone.", S.os === "windows" ? "Check Settings › Privacy & security › Microphone." : "Allow it in System Settings › Privacy & Security › Microphone.", startDictation);
      render();
      return focusComposerButton("mic");
    }
    if (S.dictRoute === "gateway" && S.flags.dictFail) {
      notify("Couldn't start dictation.", "No realtime transcription provider registered", startDictation);
      render();
      return focusComposerButton("mic");
    }
    S.notices = S.notices.filter((n) => n.task !== S.sel.task || !/dictation|microphone/i.test(n.title));
    const t = S.sel.task;
    S.dictating = { route: S.dictRoute, task: t, base: S.drafts[t] || "" };
    render();
    say("Listening");
    focusComposerButton("mic");
    // Words arrive: partial first, then final.
    S.dictating.partial = "check the backup";
    paintDraft();
    S.dictTimer = setTimeout(() => {
      if (!S.dictating) return;
      S.dictating.final = "Check the backup logs too.";
      S.dictating.partial = "";
      paintDraft();
    }, 500);
  }

  // Only final words go into the field (a plain textarea, as built); words not
  // yet final are shown in the dictation line under the row.
  function paintDraft() {
    const d = S.dictating;
    const input = $(".composer-input");
    if (!input || !d) return;
    input.value = ((d.base ? d.base + " " : "") + (d.final || "")).trimEnd();
    S.drafts[d.task] = input.value;
    const send = $('[data-v="send"]');
    if (send) send.disabled = !input.value.trim();
    const shown = $('[data-testid="partial"]');
    if (shown) shown.innerHTML = d.partial ? `Not final yet: <i>${esc(d.partial)}</i>` : "";
  }

  function stopDictation(why = "") {
    const d = S.dictating;
    if (!d) return;
    clearTimeout(S.dictTimer);
    // Words not yet final are dropped.
    S.drafts[d.task] = ((d.base ? d.base + " " : "") + (d.final || "")).trim();
    S.dictating = null;
    S.held = false;
    if (why) notify("Dictation stopped.", why, null);
    render();
    say(why ? `Dictation stopped. ${why}` : "Dictation stopped. The text is in your message.");
    focusComposerButton("mic");
  }

  // A call (sections 5, 6, 8, 9) ----------------------------------------------------------------------------

  function pressCall() {
    const t = S.sel.task;
    if (callReason()) return;
    if (S.call && S.call.task === t && S.call.state !== "failed") return $("#call-slot .call-band")?.focus();
    if (S.call && S.call.state !== "failed") return askSecond(t);
    if (!S.connected) return fail("No connection", "", t);
    if (!S.seen.call) return openConsent("call");
    beginCall(false);
  }

  function newCall(t) {
    const b = taskOf(t).b.id;
    return { bot: b, task: t, state: "connecting", phase: "Listening", muted: false, secs: 0, sessionStart: 0, heard: [], transcriptOpen: false, settingsOpen: false, voice: S.kept[b].voice, voiceMsg: "", lang: S.kept[b].lang, langMsg: "", langBusy: null, micgone: false, limit: false, resumed: false };
  }

  function beginCall() {
    const t = S.sel.task;
    if (S.dictating) stopDictation();
    S.call = newCall(t);
    if (S.mic === "missing") S.call.state = "missing";
    else if (S.mic === "denied") S.call.state = "denied";
    else if (S.mic === "none") S.call.state = "nomic";
    else if (S.mic === "prompt") {
      S.call.state = "permission";
      showPrompt();
    } else return connect();
    render();
    $("#call-slot .call-band")?.focus();
  }

  function connect() {
    const c = S.call;
    c.state = "connecting";
    render();
    clearTimeout(S.connectTimer);
    S.connectTimer = setTimeout(() => {
      if (S.call !== c || c.state !== "connecting") return;
      if (S.flags.createFail || S.voice === "unknown") return fail("The call ended unexpectedly", 'Realtime voice provider "openai" is not configured.');
      if (!VOICES.includes(c.voice)) {
        c.voiceGone = true;
        c.voice = "Default";
        S.kept[c.bot].voice = "Default";
      }
      c.state = "live";
      c.phase = "Listening";
      render();
      say(`Voice chat with ${bot(c.bot).name} started`);
      tick();
    }, 350);
  }

  function tick() {
    clearInterval(S.tickTimer);
    S.tickTimer = setInterval(() => {
      if (!S.call || !["live", "reconnecting"].includes(S.call.state)) return clearInterval(S.tickTimer);
      S.call.secs += 1;
      const el = $('[data-testid="call-time"]');
      if (el) el.textContent = `${mmss(S.call.secs)} on this device`;
    }, 1000);
  }

  function showPrompt() {
    const layer = $("#os-layer");
    layer.hidden = false;
    layer.innerHTML =
      `<p class="v-pic-label">Picture of the system's microphone prompt. The system draws the real one.</p>` +
      `<p data-testid="os-prompt"><b>“Clawtrate” would like to access the microphone.</b></p>` +
      `<div class="b-actions">${button("Don't Allow", 'data-v="os-deny"', "quiet")}${button("Allow", 'data-v="os-allow"')}</div>`;
  }
  const hidePrompt = () => ($("#os-layer").hidden = true);

  function hangup() {
    const c = S.call;
    if (!c) return;
    if (c.state === "reconnecting") {
      // Nothing is sent: the gateway already closed the session with the connection.
      clearTimeout(S.giveUp);
      return endCall();
    }
    if (c.state === "connecting" || c.state === "permission" || c.state === "missing") {
      S.call = null;
      hidePrompt();
      render();
      return focusComposerButton("call");
    }
    c.state = "ending";
    clearInterval(S.tickTimer);
    render();
    return new Promise((resolve) =>
      setTimeout(() => {
        endCall({ endfail: S.flags.closeFail });
        resolve();
      }, 300),
    );
  }

  function endCall({ endfail = false, why = "" } = {}) {
    const c = S.call;
    if (!c) return;
    (S.lines[c.task] ||= []).push({ kind: c.secs || c.heard.length ? "here" : "empty", dur: mmss(Math.max(c.secs, c.secs === 0 && !c.heard.length ? 40 : c.secs)), endfail });
    S.call = null;
    render();
    say(why || "Voice chat ended");
    focusComposerButton("call");
  }

  function fail(reason, why = "", t = S.call?.task) {
    clearInterval(S.tickTimer);
    clearTimeout(S.connectTimer);
    hidePrompt();
    const had = S.call;
    if (had && ["live", "reconnecting"].includes(had.state) && (had.secs || had.heard.length)) (S.lines[had.task] ||= []).push({ kind: "here", dur: mmss(had.secs) });
    S.call = { ...(had || newCall(t)), task: t, bot: taskOf(t).b.id, state: "failed", reason, why };
    render();
    say(`Voice chat failed: ${reason}`);
    $("#call-slot .call-band")?.focus();
  }

  function setVoice(v) {
    const c = S.call;
    if (!c || c.state !== "live") return;
    const before = S.kept[c.bot].voice;
    S.kept[c.bot].voice = v;
    c.voiceMsg = `Changing to ${v}…`;
    render();
    $(`[data-v-voice="${v}"]`)?.focus();
    setTimeout(() => {
      if (S.call !== c) return;
      if (S.flags.voiceFail) {
        c.voiceMsg = `The voice didn't change: Voice is not in this call's catalog.`;
        S.kept[c.bot].voice = before;
        say("The voice didn't change");
      } else {
        c.voice = v;
        c.voiceMsg = `Voice: ${v}, from ${bot(c.bot).name}'s next reply.`;
        say(c.voiceMsg);
      }
      render();
      $(`[data-v-voice="${S.call?.voice}"]`)?.focus();
    }, 300);
  }

  function speak() {
    const c = S.call;
    if (!c || c.state !== "live") return;
    const n = c.heard.length;
    const [who, text] = TURNS[n % TURNS.length];
    const [who2, text2] = TURNS[(n + 1) % TURNS.length];
    c.heard.push([who, text, true], [who2, text2, false]);
    c.phase = `${bot(c.bot).name} is speaking`;
    render();
    setTimeout(() => {
      if (S.call !== c) return;
      c.heard[c.heard.length - 1][2] = true;
      c.phase = "Listening";
      render();
    }, 400);
  }

  // The gateway closes the call's session with the connection. Back within the
  // window (30 seconds; shortened here), the call goes on in a new session.
  function dropConnection(long = false) {
    S.connected = false;
    const c = S.call;
    if (c && c.state === "connecting") fail("Connection lost");
    else if (c && c.state === "ending") endCall({ endfail: true });
    else if (c && c.state === "live") {
      c.state = "reconnecting";
      c.wasMuted = c.muted;
      c.resumed = false;
      say("Reconnecting the voice chat");
      clearTimeout(S.giveUp);
      S.giveUp = setTimeout(() => {
        if (S.call === c && c.state === "reconnecting") fail("Connection lost");
      }, S.windowMs ?? 1500);
    }
    if (S.dictating && S.dictating.route === "gateway") stopDictation(`${GATEWAY} ended it.`);
    render();
    setTimeout(() => {
      S.connected = true;
      if (S.call && S.call.state === "reconnecting") resume();
      render();
    }, long ? (S.longMs ?? 2400) : (S.reconnectMs ?? 600));
  }

  function resume() {
    const c = S.call;
    clearTimeout(S.giveUp);
    if (S.flags.createFail) return fail("The call ended unexpectedly", 'Realtime voice provider "openai" is not configured.');
    c.state = "live";
    c.phase = "Listening";
    c.resumed = true;
    c.sessionStart = c.secs;
    c.muted = Boolean(c.wasMuted);
    render();
    say(`Voice chat with ${bot(c.bot).name} reconnected`);
    tick();
  }

  // Settings › Voice (section 12) --------------------------------------------------------------------------

  function openSettings() {
    S.settingsOpener = document.activeElement;
    renderSettings();
    const d = $("#settings-dialog");
    if (!d.open) d.showModal();
    requestAnimationFrame(() => $("#b-section-title")?.focus());
  }

  function renderSettings() {
    const d = $("#settings-dialog");
    const named = S.mic !== "prompt";
    const choices = named ? DEVICES : ["System Default"];
    const micRows =
      `<ul class="b-choices" role="radiogroup" aria-label="Microphone">` +
      choices
        .map((m) => `<li><button type="button" class="b-choice" role="radio" aria-checked="${S.chosenMic === m}" tabindex="${S.chosenMic === m ? 0 : -1}" data-v-mic="${esc(m)}"><span class="b-choice-text"><span class="b-choice-title">${m}</span>${m === "USB Microphone" && S.mic === "missing" ? `<span class="b-choice-sub">Not connected</span>` : ""}</span></button></li>`)
        .join("") +
      `</ul>` +
      (named ? "" : `<p class="b-hint" data-testid="names-hidden">Allow microphone access to see your microphones' names. ${button("Allow", 'data-v="allow-names"')}</p>`) +
      (S.mic === "missing" && S.chosenMic === "USB Microphone" ? `<p class="b-hint" data-testid="mic-missing">USB Microphone isn't connected. Voice won't use another microphone without asking.</p>` : "") +
      `<p class="b-hint">Kept on this device.</p>`;
    const dev = deviceRoute();
    const gw = gatewayRoute();
    const route = (id, title, r, sentence) =>
      r.ok
        ? `<li><button type="button" class="b-choice" role="radio" aria-checked="${S.dictRoute === id}" tabindex="${S.dictRoute === id ? 0 : -1}" data-v-sroute="${id}"><span class="b-choice-text"><span class="b-choice-title">${title}</span><span class="b-choice-sub">${esc(sentence)}</span></span></button></li>`
        : `<li><div class="b-choice" aria-disabled="true"><span class="b-choice-text"><span class="b-choice-title">${title}</span><span class="b-choice-sub">${esc(r.why)}</span></span></div></li>`;
    const callLine =
      S.voice === "ready"
        ? `${GATEWAY} relays calls to ${PROVIDER}. ${SENTENCE.call("the bot")}`
        : S.voice === "none"
          ? `Voice chat isn't set up on ${GATEWAY}. Its owner sets up a voice provider in OpenClaw's Talk settings.`
          : S.voice === "direct"
            ? `${GATEWAY}'s voice provider talks to apps directly, which Clawtrate doesn't do.`
            : `Can't tell whether voice chat is set up on ${GATEWAY}.`;
    const body =
      `<div class="v-group"><h4>Microphone</h4>${micRows}</div>` +
      `<div class="v-group"><h4>Dictation</h4><ul class="b-choices" role="radiogroup" aria-label="Dictation">${route("device", `On this ${here()}`, dev, SENTENCE.device())}${route("gateway", `Through ${GATEWAY}`, gw, SENTENCE.gateway())}</ul>` +
      (canWrite() ? "" : `<p class="b-hint">Dictation and voice chat need more access on this connection.</p>`) +
      `</div>` +
      `<div class="v-group"><h4>Voice chat</h4><p class="b-hint" data-testid="settings-call">${esc(callLine)}</p></div>` +
      `<div class="v-group"><h4>Bots</h4><table class="v-table"><thead><tr><th>Bot</th><th>Voice</th><th>Speed</th><th>Language</th><th><span class="visually-hidden">Reset</span></th></tr></thead><tbody>` +
      BOTS.map((b) => {
        const k = S.kept[b.id];
        const reset = canWrite() ? "" : ' aria-disabled="true" aria-description="Needs more access"';
        return `<tr><td>${b.name}</td><td>${k.voice}</td><td>${k.speed}×</td><td>${langName(k.lang)}</td><td>${button("Reset", `data-v="reset" data-bot="${b.id}" aria-label="Reset ${b.name}'s voice settings"${reset}`, "quiet")}</td></tr>`;
      }).join("") +
      `</tbody></table><p class="b-hint" data-testid="bots-kept">${S.prefs === "gateway" ? `Saved on ${GATEWAY}, so your other devices use them too.` : "Kept on this device, for each bot: this connection has no user profile on the gateway."}</p></div>`;
    d.innerHTML =
      `<div class="b-settings" data-pane="section"><nav class="b-nav" aria-label="Settings"><div class="b-nav-head"><h2 id="settings-title">Settings</h2></div>` +
      `<button type="button" class="b-nav-item" aria-current="page">Voice${icon("chevron")}</button></nav>` +
      `<section class="b-section" aria-labelledby="b-section-title"><button type="button" class="icon-button b-close" data-variant="quiet" data-v="settings-close" aria-label="Close settings">${icon("x")}</button>` +
      `<header class="b-section-head"><h3 id="b-section-title" tabindex="-1">Voice</h3></header><div class="b-section-body" data-testid="settings-voice">${body}</div></section></div>`;
    CT.hydrate(d);
  }

  // Rendering --------------------------------------------------------------------------------------------

  const shell = $(".shell");
  function strip() {
    const el = $("#status-strip");
    el.hidden = S.connected;
    el.innerHTML = S.connected ? "" : `<span class="status-strip-text">Reconnecting to ${GATEWAY}…</span>`;
    $("#gateway-state").textContent = S.connected ? "Connected" : "Reconnecting…";
    $("#gateway-dot").dataset.status = S.connected ? "connected" : "reconnecting";
  }

  function render() {
    shell.dataset.view = S.view;
    renderRail();
    header();
    transcript();
    renderCall();
    renderComposer();
    strip();
    if (S.dictating) paintDraft();
  }

  // Applying a state from the address (section 15) --------------------------------------------------------

  function applyState() {
    const st = p("state");
    const line = p("line");
    if (line) S.lines.o1 = [{ kind: line === "elsewhere" ? "elsewhere" : line === "empty" ? "empty" : "here", dur: line === "empty" ? "0:40" : "2:14" }];
    if (p("page") === "settings") setTimeout(openSettings, 0);
    if (!st) return;
    const t = S.sel.task;
    const live = () => {
      S.seen.call = true;
      S.call = { ...newCall(t), state: "live", secs: 134 };
    };
    if (st === "consent") return setTimeout(() => openConsent("call"), 0);
    if (st === "dictconsent") return setTimeout(() => openConsent("dict"), 0);
    if (st === "dictating") {
      S.seen.dict = true;
      S.dictRoute = deviceRoute().ok ? "device" : "gateway";
      return setTimeout(startDictation, 0);
    }
    if (st === "dictfail") {
      S.seen.dict = true;
      S.dictRoute = "gateway";
      S.flags.dictFail = true;
      return setTimeout(startDictation, 0);
    }
    if (st === "connecting") {
      S.seen.call = true;
      S.call = newCall(t);
      S.connectTimer = null;
      return;
    }
    if (["live", "muted", "speaking", "transcript", "settings", "micgone", "limit", "second", "ending", "voicechange", "voicefail", "novoices", "langchange", "langfail", "endfail", "reconnecting", "reconnected"].includes(st)) live();
    if (st === "voicegone") {
      S.seen.call = true;
      S.call = newCall(t);
      setTimeout(connect, 0);
      return;
    }
    const c = S.call;
    if (st === "muted") c.muted = true;
    if (st === "speaking") (c.phase = `${bot(c.bot).name} is speaking`), (c.heard = [[...TURNS[0], true], [...TURNS[1], false]]);
    if (st === "transcript") (c.transcriptOpen = true), (c.heard = [[...TURNS[0], true], [...TURNS[1], true], [...TURNS[2], false]]);
    if (["settings", "voicechange", "voicefail", "novoices", "langchange", "langfail"].includes(st)) c.settingsOpen = true;
    if (st === "voicechange") c.voiceMsg = "Changing to Cedar…";
    if (st === "voicefail") (S.flags.voiceFail = true), (c.voiceMsg = "The voice didn't change: Voice is not in this call's catalog.");
    if (st === "novoices") S.flags.noVoices = true;
    if (st === "langchange") (c.langBusy = "es"), (c.langMsg = "Changing the language to Español…");
    if (st === "langfail") (S.flags.langFail = true), (c.langMsg = "The language didn't change: Too many active realtime relay sessions for this connection. The call goes on as before.");
    if (st === "reconnecting") (c.state = "reconnecting"), (S.connected = false);
    if (st === "reconnected") c.resumed = true;
    if (st === "micgone") c.micgone = true;
    if (st === "limit") (c.limit = true), (c.secs = 1680);
    if (st === "ending") c.state = "ending";
    if (st === "endfail") {
      S.call = null;
      S.lines[t] = [{ kind: "here", dur: "2:14", endfail: true }];
    }
    if (st === "second") {
      const other = t === "o1" ? "j1" : "o1";
      S.call = { ...c, task: other, bot: taskOf(other).b.id };
      setTimeout(() => askSecond(t), 0);
    }
    if (st === "failed") {
      const reason = { drop: "Connection lost", none: "No connection", error: "The call ended unexpectedly" }[p("reason")] || "Connection lost";
      S.call = { ...newCall(t), state: "failed", reason, why: p("reason") === "error" ? "Realtime provider closed the session." : "" };
      if (reason === "No connection") S.connected = false;
    }
    if (S.call && ["live", "reconnecting"].includes(S.call.state)) setTimeout(tick, 0);
  }

  // The prototype's bar ------------------------------------------------------------------------------------

  function bar() {
    const extra = $("#proto-extra");
    if (!extra) return;
    const b = (k, l) => `<button type="button" data-bar="${k}">${l}</button>`;
    extra.innerHTML =
      `<span class="run-controls v-bar">` +
      b("speak", "Otto speaks") +
      b("drop", "Drop connection") +
      b("droplong", "Drop for a minute") +
      b("unplug", "Unplug microphone") +
      b("error", "Gateway ends the call") +
      b("limit", "28 minutes") +
      b("thirty", "30 minutes") +
      `<button type="button" data-bar="closefail" aria-pressed="false">Close fails</button>` +
      `<button type="button" data-bar="createfail" aria-pressed="false">Start refused</button>` +
      `<button type="button" data-bar="voicefail" aria-pressed="false">Voice change fails</button>` +
      `<button type="button" data-bar="langfail" aria-pressed="false">Language change fails</button>` +
      `<button type="button" data-bar="dictfail" aria-pressed="false">Dictation refused</button>` +
      b("shortcut-dict", "Shortcut: Start Dictation") +
      b("shortcut-call", "Shortcut: Start Voice Chat") +
      b("settings", "Settings") +
      `</span>`;
    extra.addEventListener("click", (event) => {
      const el = event.target.closest("[data-bar]");
      if (!el) return;
      const k = el.dataset.bar;
      if (k === "speak") speak();
      if (k === "drop") dropConnection();
      if (k === "droplong") dropConnection(true);
      if (k === "unplug" && S.call && S.call.state === "live") (S.call.micgone = true), render();
      if (k === "error" && S.call && S.call.state === "live") fail("The call ended unexpectedly", "Realtime provider closed the session.");
      if (k === "limit" && S.call && S.call.state === "live") (S.call.limit = true), (S.call.secs = 1680), render();
      if (k === "thirty" && S.call && S.call.state === "live") (S.call.secs = 1800), endCall({ why: `Voice chat ended: ${GATEWAY} ends calls after 30 minutes.` });
      if (["closefail", "createfail", "voicefail", "langfail", "dictfail"].includes(k)) {
        const key = { closefail: "closeFail", createfail: "createFail", voicefail: "voiceFail", langfail: "langFail", dictfail: "dictFail" }[k];
        S.flags[key] = !S.flags[key];
        el.setAttribute("aria-pressed", String(S.flags[key]));
      }
      if (k === "shortcut-dict") {
        S.sel = { bot: "otto", task: "o1" };
        render();
        pressMic();
      }
      if (k === "shortcut-call") {
        if (S.call && S.call.state !== "failed") hangup();
        else {
          S.sel = { bot: "otto", task: "o1" };
          S.drafts.o1 = "";
          render();
          pressCall();
        }
      }
      if (k === "settings") openSettings();
    });
  }

  // Events ---------------------------------------------------------------------------------------------------

  document.addEventListener("click", (event) => {
    const el = event.target.closest("[data-v], [data-v-bot], [data-v-task], [data-v-route], [data-v-sroute], [data-v-mic], [data-v-voice], [data-v-speed]");
    if (!el) return;
    if (el.dataset.vBot) {
      S.sel = { bot: el.dataset.vBot, task: bot(el.dataset.vBot).tasks[0].id };
      if (S.dictating) stopDictation();
      return render();
    }
    if (el.dataset.vTask) return (S.sel.task = el.dataset.vTask), render();
    if (el.dataset.vRoute) {
      S.dictChoice = el.dataset.vRoute;
      return openConsent("dict");
    }
    if (el.dataset.vSroute) {
      S.dictRoute = el.dataset.vSroute;
      S.seen.dict = true;
      return renderSettings();
    }
    if (el.dataset.vMic) {
      S.chosenMic = el.dataset.vMic;
      if (S.chosenMic !== "USB Microphone" && S.mic === "missing") S.mic = "granted";
      return renderSettings();
    }
    if (el.dataset.vVoice) return setVoice(el.dataset.vVoice);
    if (el.dataset.vSpeed) {
      S.kept[S.call.bot].speed = el.dataset.vSpeed;
      render();
      return $(`[data-v-speed="${el.dataset.vSpeed}"]`)?.focus();
    }
    const v = el.dataset.v;
    if (el.getAttribute("aria-disabled") === "true") return;
    if (v === "mic") {
      if (S.suppressClick) return (S.suppressClick = false);
      return pressMic();
    }
    if (v === "call") return pressCall();
    if (v === "send") {
      const t = S.sel.task;
      if (S.dictating) stopDictation();
      if (!(S.drafts[t] || "").trim()) return;
      S.sent = S.drafts[t];
      S.drafts[t] = "";
      return render();
    }
    if (v === "consent-ok") return closeConsent(true);
    if (v === "consent-cancel") return closeConsent(false);
    if (v === "second-cancel") {
      $("#confirm-dialog").close();
      return focusComposerButton("call");
    }
    if (v === "second-ok") {
      $("#confirm-dialog").close();
      const target = S.secondTarget;
      return Promise.resolve(hangup()).then(() => {
        S.sel = { bot: taskOf(target).b.id, task: target };
        render();
        beginCall();
      });
    }
    if (v === "mute") {
      S.call.muted = !S.call.muted;
      render();
      say(S.call.muted ? "Muted" : "Unmuted");
      return $('[data-v="mute"]').focus();
    }
    if (v === "transcript") return (S.call.transcriptOpen = !S.call.transcriptOpen), render(), $('[data-v="transcript"]').focus();
    if (v === "call-settings") return (S.call.settingsOpen = !S.call.settingsOpen), render(), $('[data-v="call-settings"]').focus();
    if (v === "hangup") return hangup();
    if (v === "dismiss") {
      S.call = null;
      render();
      return focusComposerButton("call");
    }
    if (v === "cancel-start") return hangup();
    if (v === "use-default") {
      S.mic = "granted";
      S.chosenMic = "System Default";
      return connect();
    }
    if (v === "mic-back") return (S.call.micgone = false), render();
    if (v === "go-call") {
      S.sel = { bot: S.call.bot, task: S.call.task };
      return render();
    }
    if (v === "os-allow") {
      hidePrompt();
      S.mic = "granted";
      return connect();
    }
    if (v === "os-deny") {
      hidePrompt();
      S.mic = "denied";
      S.call.state = "denied";
      return render();
    }
    if (v === "line") {
      S.openLine = S.openLine === el.dataset.line ? null : el.dataset.line;
      transcript();
      return $(`[data-line="${el.dataset.line}"]`).focus();
    }
    if (v === "memo-play") {
      S.memoPlaying = !S.memoPlaying;
      if (S.memoPlaying) S.memoAt = Math.max(S.memoAt, 3);
      transcript();
      return $('[data-v="memo-play"]').focus();
    }
    if (v === "memo-speed") {
      const k = S.kept.pip;
      k.speed = SPEEDS[(SPEEDS.indexOf(k.speed) + 1) % SPEEDS.length];
      transcript();
      return $('[data-v="memo-speed"]').focus();
    }
    if (v === "memo-text") return (S.memoText = !S.memoText), transcript(), $('[data-v="memo-text"]').focus();
    if (v === "memo-retry") return (S.memo = "ready"), transcript();
    if (v === "memo-open") return (S.opened = MEMO_ADDRESS), say("Opened in your browser");
    if (v === "notice-dismiss") {
      S.notices = S.notices.filter((n) => n.id !== el.dataset.notice);
      render();
      return focusComposerButton("mic");
    }
    if (v === "notice-retry") {
      const n = S.notices.find((x) => x.id === el.dataset.notice);
      S.notices = S.notices.filter((x) => x !== n);
      render();
      return n?.retry?.();
    }
    if (v === "stop-run") return (S.run = "idle"), render();
    if (v === "settings") return openSettings();
    if (v === "settings-close") {
      $("#settings-dialog").close();
      return S.settingsOpener?.focus?.();
    }
    if (v === "allow-names") return (S.mic = "granted"), renderSettings();
    if (v === "reset") {
      S.kept[el.dataset.bot] = { voice: "Default", speed: "1", lang: "auto" };
      return renderSettings();
    }
    if (v === "back") return (S.view = "list"), render();
  });

  document.addEventListener("change", (event) => {
    if (event.target.dataset.v === "lang" && S.call) setLang(event.target.value);
  });

  document.addEventListener("input", (event) => {
    if (!event.target.classList.contains("composer-input")) return;
    const t = S.sel.task;
    const had = Boolean((S.drafts[t] || "").trim());
    S.drafts[t] = event.target.value;
    if (had !== Boolean(event.target.value.trim())) {
      const at = event.target.selectionStart;
      renderComposer();
      const input = $(".composer-input");
      input.focus();
      input.setSelectionRange(at, at);
    }
  });

  // ⌘D (Ctrl+D off the Mac): toggles; held past 400 ms, hold to talk. Escape stops.
  const isCommand = (e) => (S.os === "windows" ? e.ctrlKey : e.metaKey || e.ctrlKey);
  document.addEventListener("keydown", (event) => {
    if (document.querySelector("dialog[open]")) return;
    if (event.key === "Escape" && S.dictating) {
      event.preventDefault();
      return stopDictation();
    }
    if (!isCommand(event) || event.key.toLowerCase() !== "d" || event.shiftKey || event.altKey) return;
    if (!canWrite()) return;
    event.preventDefault();
    if (event.repeat) return;
    if (S.dictating) return stopDictation();
    pressMic();
    clearTimeout(S.holdTimer);
    S.holdTimer = setTimeout(() => (S.held = Boolean(S.dictating)), 400);
  });
  document.addEventListener("keyup", (event) => {
    if (event.key.toLowerCase() !== "d") return;
    clearTimeout(S.holdTimer);
    if (S.held && S.dictating) stopDictation();
    S.held = false;
  });
  // Press and hold the microphone button: the same.
  document.addEventListener("pointerdown", (event) => {
    const el = event.target.closest('[data-v="mic"]');
    if (!el || el.getAttribute("aria-disabled") === "true" || S.dictating) return;
    S.pressTimer = setTimeout(() => {
      S.suppressClick = true;
      pressMic();
      S.held = Boolean(S.dictating);
    }, 400);
  });
  document.addEventListener("pointerup", () => {
    clearTimeout(S.pressTimer);
    if (S.held && S.dictating) stopDictation();
    S.held = false;
  });

  $("#consent-dialog").addEventListener("cancel", (e) => (e.preventDefault(), closeConsent(false)));
  $("#confirm-dialog").addEventListener("cancel", (e) => (e.preventDefault(), $("#confirm-dialog").close(), focusComposerButton("call")));

  // For the checks: the same paths the bar takes.
  window.voice = { S, speak, dropConnection, endCall, fail, setReconnect: (ms) => (S.reconnectMs = ms) };

  applyState();
  render();
  if (p("state") === "connecting") connect();
  document.addEventListener("DOMContentLoaded", bar);
  if (document.readyState !== "loading") bar();
})();
