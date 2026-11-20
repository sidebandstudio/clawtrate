// voice.html: docs/design/voice.md. Dictation, a voice chat and its band,
// voice, speed and language, ending and failing, one call at a time, the
// "Voice chat" line, voice memos, and Settings › Voice.
//
// Every bot, task, voice, device, gateway answer and history row is a local
// fixture. Nothing records, plays, fetches or opens anything: the microphone,
// the gateway and the player are counters in `S.io`, so the checks can see what
// would have been opened, sent, fetched or played, and when. The system's
// prompts are labelled pictures.
//
// The gateway's and the device's events are named and fired one at a time
// (`window.voice.ev(name, data)`, and the prototype bar). With `auto=0` nothing
// fires by itself; otherwise the fixture answers after a short delay, so the
// walks can be clicked through. Address parameters: voice.md, section 15.

(function () {
  const CT = window.CT;
  const params = CT.params;
  const p = (name) => params.get(name);
  const $ = (selector, root = document) => root.querySelector(selector);
  // Every supplied or fixture string is text: escaped in content and in attributes.
  const esc = (text) =>
    String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name, cls) => CT.icon(name, cls);
  const button = (label, attrs = "", variant = "") =>
    `<button type="button" class="button" data-size="sm"${variant ? ` data-variant="${variant}"` : ""} ${attrs}>${esc(label)}</button>`;
  const MIC =
    '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.6" y="1.8" width="4.8" height="8" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3.4 7.6a4.6 4.6 0 0 0 9.2 0M8 12.2v2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  const WAVE =
    '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6.5v3M5 4v8M7.5 2.5v11M10 5v6M12.5 6.5v3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

  // Fixtures ---------------------------------------------------------------------------------------

  const INJECT = p("inject") === "1"; // markup-shaped strings, which must stay text
  const LONG = p("long") === "1"; // long names, which must show in full
  const GATEWAY = LONG ? "Home gateway on the basement media server" : "Home gateway";
  const GATEWAY_ID = "gw-7f3a";
  const PROVIDERS = {
    openai: LONG ? "OpenAI Realtime Voice (gpt-realtime, European data residency)" : "OpenAI Realtime Voice",
    "openai-eu": LONG ? "OpenAI Realtime Voice (gpt-realtime, European data residency)" : "OpenAI Realtime Voice",
    xai: "xAI Realtime Voice",
  };
  const TRANSCRIBERS = {
    "openai-transcribe": LONG ? "OpenAI Realtime Transcription (gpt-4o-transcribe, European data residency)" : "OpenAI Realtime Transcription",
    "deepgram-live": "Deepgram Live Transcription",
  };
  let TRANSCRIBER = { id: "openai-transcribe", label: TRANSCRIBERS["openai-transcribe"] };
  const BOTS = [
    { id: "juniper", name: "Juniper", tasks: [{ id: "j1", title: "Heat pump vs. gas furnace", when: "5:24 PM", ask: "Compare a heat pump with a gas furnace for this house.", reply: "Here's the comparison, with ten-year running costs." }] },
    { id: "otto", name: INJECT ? '<b data-inject="name">Otto</b>' : "Otto", tasks: [{ id: "o1", title: "Disk almost full on the media box", when: "5:36 PM", ask: "Free up space on the media box.", reply: "The transcode cache is the largest folder: 212 GB." }] },
    { id: "pip", name: "Pip", tasks: [{ id: "p1", title: "Saturday errands route", when: "4:10 PM", ask: "Read me the route for Saturday.", reply: "Here's the route as a voice memo.", memo: true }] },
  ];
  const bot = (id) => BOTS.find((b) => b.id === id);
  const taskOf = (id) => BOTS.flatMap((b) => b.tasks.map((t) => ({ b, t }))).find((x) => x.t.id === id);
  const nameOf = (botId) => bot(botId).name;
  // The voices `talk.voice.get` returns for the call; no "Default" sentinel.
  const VOICES = ["Alloy", "Cedar", "Marin", "Sage", ...(INJECT ? ['<i data-inject="voice">Ember</i>'] : [])];
  const SPEEDS = ["0.5", "0.75", "1", "1.25", "1.5", "2"];
  const LANGS = [["", "Provider default"], ["en", "English"], ["es", "Español"], ["fr", "Français"], ["de", "Deutsch"], ["ja", "日本語"]];
  const DEVICES = ["System Default", "MacBook Pro Microphone", "USB Microphone"];
  const MEMO_ADDRESS = "https://media.example.net/pip/route-saturday.mp3";
  const REFUSAL = INJECT ? '<u data-inject="refusal">Realtime voice provider "openai" is not configured.</u>' : 'Realtime voice provider "openai" is not configured.';
  const CAPTION = INJECT ? '<s data-inject="caption">Is the media box still nearly full?</s>' : "Is the media box still nearly full?";
  // The fixture clock: 5:36 PM. Times are seconds since midnight.
  const NOW = 17 * 3600 + 36 * 60;
  const clock = (secs) => {
    const h = Math.floor(secs / 3600) % 24;
    const m = Math.floor(secs / 60) % 60;
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  };
  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const REPLY = "Yes. It's at 91 percent, and the transcode cache is most of it.";

  // State --------------------------------------------------------------------------------------------

  const pick = (name, list, fallback) => (list.includes(p(name)) ? p(name) : fallback);
  const S = {
    auto: p("auto") !== "0",
    access: p("access") === "read" ? "read" : "write",
    run: p("run") === "running" ? "running" : "idle",
    os: pick("os", ["windows", "web", "remote", "iphone"], "mac"),
    ondevice: p("ondevice") !== "0",
    catalog: { voice: pick("voice", ["none", "direct", "unknown"], "ready"), dict: p("dict") === "none" ? "none" : "ready", reads: 1 },
    providerId: p("provider") === "openai-eu" ? "openai-eu" : "openai",
    drift: p("drift") === "1", // the gateway answers create with another provider
    dictDrift: p("dictdrift") === "1", // the gateway's transcription create answers with another provider
    consent: new Set(), // accepted destinations: gateway, route, provider id and label
    mic: pick("mic", ["prompt", "denied", "none", "missing"], "granted"),
    speech: pick("speech", ["prompt", "denied"], "granted"), // Apple speech recognition
    storedMic: p("mic") === "missing" ? "USB Microphone" : "System Default",
    tempMic: null,
    namesShown: p("mic") !== "prompt",
    namesAsk: false,
    dictRoute: p("route") === "gateway" || p("route") === "device" ? p("route") : null,
    dictChoice: null,
    sel: { bot: p("bot") && bot(p("bot")) ? p("bot") : "otto", task: null },
    view: p("view") === "list" ? "list" : "detail",
    drafts: {},
    caret: {},
    files: {},
    tokens: {},
    picker: p("picker") === "1",
    connected: p("connected") !== "0",
    gen: 1, // the connection's generation
    dict: null, // the one dictation
    draining: null, // a gateway dictation closed and still taking its final words
    call: null, // the one call on this device
    relays: [], // every relay this device asked for: {id, attempt, state, expiresAt}
    attempt: 0,
    next: null, // End and Chat's target, waiting for the old relay's confirmed end
    history: {},
    held: {}, // voiceSessionId -> seconds this device counted
    heldEmpty: {}, // task -> [{vs, secs}] calls this device held with no saved turn found
    lineNotes: {},
    openLine: null,
    prefs: {
      mode: p("prefs") === "none" ? "device" : p("prefs") === "unknown" ? "unknown" : "gateway",
      saved: { otto: { voice: null, speed: "1", lang: "" }, juniper: { voice: null, speed: "1", lang: "" }, pip: { voice: null, speed: "1", lang: "" } },
      pending: null, // {bot, field, value, before}
      notes: {}, // bot -> the last word on its saved settings
      temp: {}, // bot -> a speed for now (read-only, or settings that can't be read)
    },
    memo: { kind: pick("memo", ["grant", "expired", "wrongroute", "redirect", "big", "fail", "address", "scheme", "nohttp", "two"], "inline"), state: "idle", at: 0, which: null },
    notices: [],
    seq: 0,
    sent: [],
    flags: { closeFail: false, createFail: false, voiceFail: false, dictFail: false, sendFail: false, prefFail: false, prefConflict: false },
    noVoices: false,
    os_prompt: null,
    io: { micOpens: 0, micOpensUnauthorized: 0, briefOpens: 0, appends: 0, appendsUnauthorized: 0, deviceFrames: 0, creates: [], closes: [], completes: [], sets: [], downloads: 0, hostFetches: 0, plays: 0, opens: [], prefWrites: [] },
  };
  S.sel.task = p("task") && taskOf(p("task")) ? p("task") : bot(S.sel.bot).tasks[0].id;
  if (taskOf(S.sel.task).b.id !== S.sel.bot) S.sel.bot = taskOf(S.sel.task).b.id;
  if (p("files") === "pending") S.files.o1 = [{ name: "notes.pdf", state: "pending" }];
  if (p("files") === "refused") S.files.o1 = [{ name: "backup.tar", state: "refused", why: "Over 25 MB" }];
  if (p("token") === "slash") S.tokens.o1 = [{ kind: "skill", insert: "/summarize" }];
  if (p("token") === "mention") S.tokens.o1 = [{ kind: "bot", insert: "@Juniper" }];
  if (p("draft")) S.drafts[S.sel.task] = p("draft");

  const canWrite = () => S.access === "write";
  const isWeb = () => S.os === "web" || S.os === "remote";
  const noMicPage = () => S.os === "remote";
  const here = () => (S.os === "iphone" ? "iPhone" : S.os === "windows" ? "PC" : S.os === "mac" ? "Mac" : "computer");
  const later = (fn, ms) => (S.auto ? setTimeout(fn, ms) : null);
  const consentKey = (route, providerId, label) => `${GATEWAY_ID}|${route}|${providerId}|${label}`;
  const callKey = (providerId = S.providerId) => consentKey("call", providerId, PROVIDERS[providerId]);
  const dictKey = (route) => (route === "device" ? consentKey("device", "apple-on-device", "Apple") : consentKey("gateway", TRANSCRIBER.id, TRANSCRIBER.label));
  if (p("seen") === "1") {
    // Accepted before for the provider id "openai"; `provider=openai-eu` keeps its label but not its id.
    S.consent.add(consentKey("call", "openai", PROVIDERS.openai));
    S.consent.add(dictKey("device"));
    S.consent.add(dictKey("gateway"));
  }
  const hasContent = (task) => Boolean((S.drafts[task] || "").trim() || (S.files[task] || []).length || (S.tokens[task] || []).length);

  // Where the audio goes: the full names, shown before the microphone opens (section 2).
  const SENTENCE = {
    call: (providerId) =>
      `Your voice goes to ${GATEWAY}, which sends it to ${PROVIDERS[providerId]}. The gateway can save finalized captions as text in this task. Clawtrate discards its audio buffers when capture or playback stops. The gateway and provider manage their own copies.`,
    gateway: () =>
      `Your voice goes to ${GATEWAY}, which sends it to ${TRANSCRIBER.label} and sends the text back. The words go into your message as an editable draft, and nothing is posted to the task until you send it. Clawtrate discards its audio buffers when capture stops. The gateway and provider manage their own copies.`,
    device: () =>
      `Apple's speech recognition turns your voice into text on this ${here()}. Clawtrate requires on-device recognition, so the recognizer doesn't send your voice over the network. The words go into your message as an editable draft.`,
  };
  const deviceRoute = () => {
    if (S.os === "windows") return { ok: false, why: "Windows has no speech recognition Clawtrate can use without sending your voice to Microsoft." };
    if (isWeb()) return { ok: false, why: "The browser preview has no on-device recognition Clawtrate can use." };
    if (!S.ondevice) return { ok: false, why: `On this ${here()} isn't available for English (United States): this ${here()} can't recognize it without the network.` };
    return { ok: true };
  };
  const gatewayRoute = () => {
    if (!S.connected) return { ok: false, why: `Not connected to ${GATEWAY}.` };
    if (S.catalog.dict === "none") return { ok: false, why: `Dictation through ${GATEWAY} isn't set up on the gateway.` };
    return { ok: true };
  };
  const DENIED = {
    mac: ["Clawtrate can't use the microphone. Allow it in System Settings › Privacy & Security › Microphone.", "Open System Settings"],
    iphone: ["Clawtrate can't use the microphone. Allow it in Settings › Clawtrate.", "Open Settings"],
    windows: ["Clawtrate couldn't open the microphone. Check Settings › Privacy & security › Microphone.", ""],
    web: ["This page can't use the microphone. Allow it in this browser's site settings.", ""],
  };
  const deniedWords = () => DENIED[S.os === "remote" ? "web" : S.os];
  const speechDenied = () =>
    S.os === "iphone"
      ? "Clawtrate can't use speech recognition. Allow it in Settings › Clawtrate."
      : "Clawtrate can't use speech recognition. Allow it in System Settings › Privacy & Security › Speech Recognition.";

  // A relay that is being created, is open, is closing or may be open: then no other call starts (sections 8, 9).
  const liveCall = (c) => Boolean(c) && ["permission", "missing", "creating", "live", "ending"].includes(c.state);
  const openRelays = () => S.relays.filter((r) => r.state !== "closed");
  const blocker = () => {
    const mine = S.call && ["live"].includes(S.call.state) ? S.call.relayIds : [];
    const others = openRelays().filter((r) => !mine.includes(r.id));
    if (!others.length) return null;
    if (others.some((r) => r.state === "closing" || r.state === "creating")) return { why: "Ending the previous voice session…" };
    const until = Math.max(...others.map((r) => r.expiresAt));
    return { why: `The previous voice session may still be open on ${GATEWAY}. A new voice chat can start after ${clock(until)}, when that session is scheduled to end.`, until };
  };

  const callReason = () => {
    if (noMicPage()) return "This page can't use a microphone: a browser allows one only over https or on this computer itself.";
    if (S.catalog.voice === "none") return `Voice chat isn't set up on ${GATEWAY}.`;
    if (S.catalog.voice === "direct") return `${GATEWAY}'s voice provider talks to apps directly, which Clawtrate doesn't do.`;
    if (S.call && liveCall(S.call)) return "";
    const blk = blocker();
    return blk ? blk.why : "";
  };
  const micReason = () => {
    if (noMicPage()) return "This page can't use a microphone: a browser allows one only over https or on this computer itself.";
    if (S.call && liveCall(S.call)) return "The microphone is in use by the voice chat.";
    return "";
  };

  // Announcements: the one polite status region, its real text --------------------------------------------

  const say = (text) => {
    const live = $("#live");
    live.textContent = "";
    requestAnimationFrame(() => (live.textContent = text));
  };

  // Rendering helpers ------------------------------------------------------------------------------------

  const turnHtml = (role, html, attrs = "") => `<div class="turn" data-role="${role}"${attrs}>${CT.msg({ role, html })}</div>`;

  // Rail and header: the call is shown wherever its bot and task are, on every width.
  function renderRail() {
    const el = $("#bot-list");
    el.innerHTML = BOTS.map((b) => {
      const open = b.id === S.sel.bot;
      const t = b.tasks[0];
      const inCall = S.call && liveCall(S.call) && S.call.bot === b.id;
      const mark = inCall ? `In a voice chat · ${S.call.capture ? "Microphone on" : "Microphone off"}` : "";
      return (
        `<li class="bot-group"${open ? ' data-open="true"' : ""}>` +
        `<button type="button" class="bot" data-v-bot="${b.id}" data-k="bot-${b.id}" aria-current="${open}" data-testid="bot">` +
        `<span class="avatar" data-bot="${b.id}"></span>` +
        `<span class="bot-text"><span class="bot-line"><span class="bot-name">${esc(b.name)}</span><time class="bot-time">${t.when}</time></span>` +
        `<span class="bot-line"><span class="bot-preview" data-testid="rail-preview">${esc(mark || t.reply)}</span></span></span></button>` +
        (open
          ? `<ul class="task-list" aria-label="${esc(b.name)}'s tasks"><li><button type="button" class="task" data-v-task="${t.id}" data-k="task-${t.id}" aria-current="${S.sel.task === t.id}"><span class="task-title">${esc(t.title)}</span>` +
            (inCall && S.call.task === t.id ? `<span class="v-task-call" data-testid="task-call">${esc(mark)}</span>` : `<time class="task-time">${t.when}</time>`) +
            `</button></li></ul>`
          : "") +
        `</li>`
      );
    }).join("");
    CT.hydrate(el);
  }

  function header() {
    const { b, t } = taskOf(S.sel.task);
    $("#title-pill").innerHTML = `<span class="avatar" data-bot="${b.id}"></span><span class="title-pill-name">${esc(b.name)}</span><span class="title-pill-task">${esc(t.title)}</span>`;
    CT.hydrate($("#title-pill"));
  }

  // The transcript: history rows; voice rows grouped by the voice session in their ids (section 10).
  const voiceIdOf = (row) => {
    const m = /^voice:([^:]+):(\d+)$/.exec(row.id || "");
    return m ? m[1] : null;
  };
  function transcriptHtml(taskId) {
    const { b, t } = taskOf(taskId);
    const rows = S.history[taskId] || [];
    let body = `<div class="stamp">Today ${t.when}</div>` + turnHtml("user", `<p>${esc(t.ask)}</p>`) + turnHtml("assistant", `<p>${esc(t.reply)}</p>`);
    if (t.memo) body += memoCards();
    const groups = {};
    for (const r of rows) {
      const vs = r.voice ? voiceIdOf(r) : null;
      if (vs) (groups[vs] ||= []).push(r);
    }
    const shown = new Set();
    for (const r of rows) {
      const vs = r.voice ? voiceIdOf(r) : null;
      if (vs) {
        if (shown.has(vs)) continue;
        shown.add(vs);
        body += lineHtml(vs, groups[vs], b);
      } else if (r.voice) {
        // A spoken turn with no voice id: shown on its own, marked as spoken.
        body += turnHtml(r.role, `<p>${esc(r.text)}</p><p class="v-faint">Spoken · ${clock(r.ts)}</p>`, ' data-testid="spoken-turn"');
      } else {
        body += turnHtml(r.role, `<p>${esc(r.text)}</p>`, ' data-testid="typed-turn"');
      }
    }
    for (const e of S.heldEmpty[taskId] || []) body += lineHtml(e.vs, [], b, e);
    return `<div class="transcript-inner"><h1 class="task-line">${esc(t.title)}</h1>${body}</div>`;
  }
  function lineHtml(vs, rows, b, empty) {
    const id = `line-${vs}`;
    const open = S.openLine === id;
    const secs = S.held[vs];
    let label;
    if (empty) label = `Voice chat · ${mmss(empty.secs)} · No saved turns found`;
    else if (secs !== undefined) label = `Voice chat · ${mmss(secs)}`;
    else label = `Voice chat · ${rows.length} turns · ${clock(rows[0].ts).replace(/ (AM|PM)$/, "")}–${clock(rows.at(-1).ts)}`;
    const note = S.lineNotes[vs];
    return (
      `<div class="call-line" data-testid="call-line" data-vs="${esc(vs)}"><button type="button" data-v="line" data-line="${esc(id)}" data-k="${esc(id)}" aria-expanded="${open}" aria-controls="${esc(id)}-turns"${rows.length ? "" : " disabled"}>${icon("chevron")}${esc(label)}</button></div>` +
      (note ? `<p class="call-line-note" data-testid="line-note">${esc(note)}</p>` : "") +
      `<div class="call-turns" id="${esc(id)}-turns" data-testid="call-turns"${open ? "" : " hidden"}>` +
      rows.map((r) => turnHtml(r.role, `<p>${esc(r.text)}</p><p class="v-faint">${esc(r.role === "user" ? "You" : b.name)} · ${clock(r.ts)}</p>`)).join("") +
      `</div>`
    );
  }

  // Memos (section 11): metadata first; Play asks for the item; nothing at render.
  function memoCards() {
    if (S.memo.kind === "two")
      return (
        memoCard("m1", "Saturday route.m4a", "0:24") +
        memoCard("m2", "Saturday route, short.m4a", "0:09") +
        turnHtml("assistant", `<div class="memo" data-testid="attachment"><span class="memo-name">invoice.pdf<small>PDF · 84 KB</small></span></div>`)
      );
    return memoCard("m1", "Saturday route.m4a", "0:24");
  }
  function memoCard(id, name, dur) {
    const m = S.memo;
    const mine = m.which === id;
    const state = mine ? m.state : "idle";
    const sp = memoSpeed();
    let body = "";
    if (m.kind === "address") {
      const open = S.os === "iphone" ? ["Open outside Clawtrate", "Opens outside Clawtrate."] : ["Open in browser", "Opens in your browser."];
      body =
        `<p>This voice memo is at an address Clawtrate doesn't open by itself:</p><p class="mono v-address" data-testid="memo-address">${esc(MEMO_ADDRESS)}</p>` +
        `<div class="memo-head">${button(open[0], `data-v="memo-open" data-k="memo-open" aria-describedby="memo-leave"`)}<span class="v-faint" id="memo-leave">${esc(open[1])}</span></div>`;
    } else if (m.kind === "scheme") {
      body = `<p>This voice memo is at an address Clawtrate doesn't open:</p><p class="mono v-address" data-testid="memo-address">ftp://media.example.net/pip/route-saturday.mp3</p>`;
    } else if (m.kind === "nohttp" && S.os === "iphone") {
      body = `<p>This voice memo can't be played on this iPhone yet: ${esc(GATEWAY)} offers it as a download, and the iPhone app doesn't make downloads yet.</p>`;
    } else {
      const playing = state === "playing";
      const label = state === "loading" ? "Loading voice memo" : playing ? "Pause voice memo" : "Play voice memo";
      body =
        `<div class="memo-head">` +
        `<button type="button" class="icon-button" data-v="memo-play" data-memo="${id}" data-k="memo-play-${id}" aria-label="${label}"${state === "loading" ? ' aria-busy="true"' : ""}>${icon(playing ? "pause" : "play")}</button>` +
        `<span class="memo-name">${esc(name)}<small data-testid="memo-time">${mine && (playing || state === "paused") ? `0:${String(m.at).padStart(2, "0")} / ${dur}` : dur}</small></span>` +
        `<button type="button" class="speed" data-v="memo-speed" data-k="memo-speed-${id}" aria-label="Speed ${sp.rate}×, ${esc(sp.where)}">${sp.rate}×</button>` +
        `</div>`;
      if (state === "error") body += `<p data-testid="memo-error">${esc(m.error)}</p>${m.retry ? button("Try again", `data-v="memo-retry" data-k="memo-retry"`) : ""}`;
      if (sp.temp) body += `<p class="v-faint" data-testid="memo-speed-note">${esc(`${sp.rate}× for now, on this device.`)}</p>`;
      body += `<p class="v-faint" data-testid="memo-note">No text came with this recording.</p><p class="v-faint" data-testid="no-highlight">Words aren't highlighted: the gateway gives no timing for each word.</p>`;
    }
    return turnHtml("assistant", `<div class="memo" data-testid="memo" data-memo="${id}" data-state="${state}">${body}</div>`);
  }
  const memoSpeed = () => {
    const temp = S.prefs.temp.pip;
    if (temp) return { rate: temp, where: "for now, on this device", temp: true };
    return { rate: SPEEDS.includes(S.prefs.saved.pip.speed) ? S.prefs.saved.pip.speed : "1", where: "Pip's saved speed" };
  };

  function renderTranscript() {
    $("#transcript").innerHTML = transcriptHtml(S.sel.task);
    CT.hydrate($("#transcript"));
  }

  // The composer as built (packages/ui/src/Composer.tsx) ----------------------------------------------------
  // The shelf, then the row "Attach files", the field, "How to send", [mic] [waveform], "Stopping…", Stop, Send.

  function renderComposer() {
    const el = $("#composer");
    const { b, t } = taskOf(S.sel.task);
    if (!canWrite()) {
      el.innerHTML = CT.accessBar({ bot: b.id, state: "read" }).replace(/^<footer[^>]*>/, "").replace(/<\/footer>$/, "");
      return;
    }
    const draft = S.drafts[t.id] || "";
    const d = S.dict && S.dict.task === t.id ? S.dict : null;
    const mr = micReason();
    const cr = callReason();
    const myCall = S.call && liveCall(S.call) && S.call.task === t.id;
    const showCall = !hasContent(t.id); // the built rule: no text, no file, no chip
    const running = S.run === "running";
    const callWhy = cr || (S.catalog.voice === "unknown" && !myCall ? `Can't tell whether voice chat is set up on ${GATEWAY}.` : "");
    const desktop = S.os !== "iphone";
    const micLabel = d ? (desktop ? "Stop voice input" : "Stop dictation") : desktop ? "Start voice input" : "Start dictation";
    const keys = isWeb() || S.os === "iphone" ? "" : S.os === "windows" ? " (Ctrl+D)" : " (⌘D)";
    const notices = S.notices.filter((n) => n.task === t.id);
    const shelf = notices.length
      ? `<div class="shelf-notices" role="group" aria-label="Notifications">` +
        notices
          .map(
            (n) =>
              `<div class="shelf-row" data-tone="danger" role="alert" data-testid="notice"><span class="shelf-text"><b>${esc(n.title)}</b> <span>${esc(n.reason)}</span></span>` +
              (n.retry ? button("Try again", `data-v="notice-retry" data-notice="${n.id}" data-k="notice-retry-${n.id}"`) : "") +
              `<button type="button" class="icon-button" data-variant="quiet" aria-label="Dismiss" title="Dismiss" data-v="notice-dismiss" data-notice="${n.id}" data-k="notice-dismiss-${n.id}">${icon("x")}</button></div>`,
          )
          .join("") +
        `</div>`
      : "";
    const chips = (S.tokens[t.id] || []).length
      ? `<ul class="chips composer-tokens" aria-label="Sent first">${S.tokens[t.id].map((x) => `<li class="chip" data-testid="token-chip"><b>${esc(x.insert)}</b></li>`).join("")}</ul>`
      : "";
    const files = (S.files[t.id] || []).length
      ? `<div class="attachments"><ul class="chips">${S.files[t.id].map((f) => `<li class="chip"${f.state === "refused" ? ' data-tone="danger"' : ' aria-busy="true"'} data-testid="file-chip"><b>${esc(f.name)}</b><span>${esc(f.state === "refused" ? f.why : "Uploading…")}</span></li>`).join("")}</ul></div>`
      : "";
    const picker = S.picker
      ? `<div class="composer-menu" data-testid="composer-menu"><ul id="composer-menu" role="listbox" aria-label="Skills and commands"><li role="option" aria-selected="true" class="composer-menu-row">/summarize</li><li role="option" aria-selected="false" class="composer-menu-row">/plan</li></ul></div>`
      : "";
    const refused = (S.files[t.id] || []).some((f) => f.state === "refused");
    el.innerHTML =
      `<div class="composer-inner"><div class="composer-shelf" aria-label="Waiting to send">${shelf}</div><div class="composer-box">${picker}${chips}${files}<div class="composer-row">` +
      `<button type="button" class="icon-button" aria-label="Attach files" title="Attach files">${icon("plus")}</button>` +
      `<textarea class="composer-input" rows="1" data-k="input" aria-label="${esc(running ? `Steer ${b.name}` : `Message ${b.name}`)}" placeholder="${esc(running ? `Steer ${b.name}` : `Message ${b.name}`)}"${S.picker ? ' aria-expanded="true" aria-controls="composer-menu"' : ""}>${esc(draft)}</textarea>` +
      (running && draft.trim() ? `<button type="button" class="send-mode" aria-haspopup="menu" aria-expanded="false" aria-label="How to send: Steer">Steer${icon("chevron")}</button>` : "") +
      `<button type="button" class="icon-button mic-button" data-v="mic" data-k="mic" data-testid="mic" data-state="${d ? "listening" : "ready"}" aria-label="${micLabel}" title="${micLabel}${keys}"` +
      `${mr && !d ? ` aria-disabled="true" aria-description="${esc(mr)}"` : ""}>${MIC}</button>` +
      (showCall
        ? `<button type="button" class="icon-button call-button" data-v="call" data-k="call" data-testid="call-button" aria-label="${myCall ? "In a voice chat" : "Start voice chat"}" title="${esc(callWhy || (myCall ? "In a voice chat" : "Start voice chat"))}"${myCall ? ' aria-pressed="true"' : ""}${cr ? ' aria-disabled="true"' : ""}${callWhy ? ` aria-description="${esc(callWhy)}"` : ""}>${WAVE}</button>`
        : "") +
      (running ? `<button type="button" class="icon-button stop-button" data-v="stop-run" data-k="stop" data-testid="stop" aria-label="${esc(`Stop ${b.name}`)}" title="${esc(`Stop ${b.name}`)} (⌘.)"></button>` : "") +
      `<button type="button" class="icon-button send-button" data-v="send" data-k="send" data-testid="send" aria-label="${running ? "Steer this turn" : "Send"}"${hasContent(t.id) && !refused ? "" : " disabled"}>${icon("arrow-up")}</button>` +
      `</div></div>` +
      (d
        ? `<div class="dictation-line" data-testid="listening"><span class="mic-mark" data-on="${d.capture}">${esc(d.state === "connecting" ? `Connecting to ${GATEWAY}…` : "Listening")} · ${d.capture ? "Microphone on" : "Microphone off"}</span><span>${esc(d.route === "device" ? `On this ${here()}` : `Through ${GATEWAY}`)}</span><span class="v-partial" data-testid="partial">${d.partial ? `Not final yet: <i>${esc(d.partial)}</i>` : ""}</span></div>`
        : "") +
      (mr && !d ? `<p class="v-reason" data-testid="mic-why">${esc(mr)}</p>` : "") +
      (showCall && callWhy ? `<p class="v-reason" data-testid="call-why">${esc(callWhy)}</p>` : "") +
      `</div>`;
  }

  const notify = (title, reason, retry, task = S.sel.task) => {
    S.notices = S.notices.filter((n) => !(n.task === task && n.title === title));
    S.notices.push({ id: `n${++S.seq}`, task, title, reason, retry });
  };

  // The call band (section 6) --------------------------------------------------------------------------------

  // What the band says, from matching events only (section 6).
  const phaseOf = (c) => {
    if (c.state === "ending") return "Ending…";
    if (c.state === "creating" || !c.ready) return `Connecting to ${nameOf(c.bot)}…`;
    if (c.micStopped) return "Microphone stopped";
    if (c.muted) return "Muted";
    if (c.playing) return `${nameOf(c.bot)} is speaking`;
    if (c.thinking) return "Thinking";
    if (c.capture) return "Listening";
    return "Opening the microphone…";
  };

  function renderCall() {
    const slot = $("#call-slot");
    const c = S.call;
    if (!c || c.task !== S.sel.task) {
      slot.innerHTML =
        c && liveCall(c)
          ? `<p class="v-reason v-elsewhere" data-testid="elsewhere-call">${esc(`In a voice chat with ${nameOf(c.bot)} · ${c.capture ? "Microphone on" : "Microphone off"}`)} ${button("Show", 'data-v="go-call" data-k="go-call"', "quiet")}</p>`
          : "";
      return;
    }
    const b = bot(c.bot);
    const micMark = (on) => `<span class="mic-mark" data-on="${on}" data-testid="mic-mark">${on ? "Microphone on" : "Microphone off"}</span>`;
    let top = "";
    let row = "";
    let notes = "";
    let tone = "";
    let simple = true;
    if (c.state === "permission") {
      top = `<span class="call-title" data-testid="call-phase">Waiting for microphone access…</span>`;
      row = `<span class="spacer"></span>${button("Cancel", 'data-v="cancel-start" data-k="cancel-start"', "quiet")}`;
    } else if (c.state === "denied" || c.state === "nomic") {
      tone = "danger";
      const [words, action] = c.state === "nomic" ? ["No microphone found.", ""] : deniedWords();
      top = `<span class="call-title" data-testid="call-phase">${esc(words)}</span>`;
      row = `${action ? button(action, 'data-v="open-os" data-k="open-os"') : ""}<span class="spacer"></span>${button("Dismiss", 'data-v="dismiss" data-k="dismiss"', "quiet")}`;
    } else if (c.state === "missing") {
      top = `<span class="call-title" data-testid="call-phase">${esc(`${S.storedMic} isn't connected.`)}</span>`;
      row = `${button("Use System Default this time", 'data-v="use-default" data-k="use-default"')}${button("Choose another", 'data-v="settings" data-k="choose-mic"', "quiet")}<span class="spacer"></span>${button("Cancel", 'data-v="cancel-start" data-k="cancel-start"', "quiet")}`;
    } else if (c.state === "refused") {
      tone = "danger";
      top = `<span class="call-title"><b data-testid="call-phase">Couldn't start voice chat</b></span>`;
      notes = `<p class="call-note" data-testid="call-note">${esc(c.message)}</p>`;
      row = `<span class="spacer"></span>${button("Dismiss", 'data-v="dismiss" data-k="dismiss"')}`;
    } else if (c.state === "failed" || c.state === "lost") {
      tone = "danger";
      top = `<span class="call-title"><b data-testid="call-phase">Voice chat failed</b></span>`;
      notes = `<p class="call-reason" data-testid="call-reason">${esc(c.reason)}</p>`;
      if (c.state === "lost")
        notes += S.connected
          ? `<p class="call-note" data-testid="call-note">${esc(`Reconnected to ${GATEWAY}. The voice session could not be resumed. This device stopped sending audio when it detected the drop.`)}</p>`
          : `<p class="call-note" data-testid="call-note">${esc(`Microphone off. Reconnecting to ${GATEWAY}…`)}</p>`;
      else notes += `<p class="call-note" data-testid="call-note">${esc(c.second)}</p>`;
      const blk = blocker();
      if (blk && S.connected) notes += `<p class="call-note" data-testid="call-blocked">${esc(blk.why)}</p>`;
      row = `<span class="spacer"></span>${!blk && S.connected && c.state === "lost" ? button("Start a new voice chat", 'data-v="start-new" data-k="start-new"') : ""}${button("Dismiss", 'data-v="dismiss" data-k="dismiss"')}`;
    } else {
      // creating, live, ending
      simple = false;
      top =
        `<span class="avatar" data-bot="${b.id}"></span><span class="call-title"><b>${esc(`Voice chat with ${b.name}`)}</b> · <span data-testid="call-phase">${esc(phaseOf(c))}</span></span>` +
        (c.ready ? `<span class="call-time" data-testid="call-time">${mmss(c.secs)} on this device</span>` : "");
      const active = c.state === "live" && c.ready;
      row =
        `<div class="call-mic">${micMark(c.capture)}</div><div class="call-actions">` +
        (active
          ? button(c.muted ? "Unmute" : "Mute", `data-v="mute" data-k="mute" aria-pressed="${c.muted}"${c.micStopped ? " disabled" : ""}`) +
            button("Transcript", `data-v="transcript" data-k="transcript" aria-label="${c.transcriptOpen ? "Hide transcript" : "Show transcript"}" aria-expanded="${c.transcriptOpen}" aria-controls="call-transcript"`) +
            button("Settings", `data-v="call-settings" data-k="call-settings" aria-haspopup="dialog"`)
          : "") +
        `<span class="spacer"></span>` +
        (c.state === "ending" ? "" : button(active ? "Hang up" : "Cancel", `data-v="hangup" data-k="hangup"${active ? ' data-tone="danger"' : ' data-variant="quiet"'}`)) +
        `</div>`;
      if (c.muted && c.background) notes += `<p class="call-note" data-testid="call-note">Muted when Clawtrate went to the background. Unmute to go on.</p>`;
      else if (c.muted) notes += `<p class="call-note" data-testid="call-note">Muted. This device's microphone is off.</p>`;
      if (c.micStopped)
        notes +=
          `<p class="call-note" data-testid="mic-stopped"><b>Microphone stopped. No new audio is being sent.</b>${c.micStopped === "unplugged" ? ` ${esc(`${S.tempMic || S.storedMic} was disconnected.`)}` : c.micStopped === "revoked" ? " Microphone access was turned off." : ""}</p>` +
          `<div class="call-actions">${button("Turn microphone back on", 'data-v="mic-back" data-k="mic-back"')}</div>`;
      if (c.ready && c.expiresAt - c.clockAt <= 120) notes += `<p class="call-note" data-testid="call-limit">${esc(`This session is scheduled to end at ${clock(c.expiresAt)}.`)}</p>`;
      if (c.voiceGone) notes += `<p class="call-note" data-testid="voice-gone">${esc(`${c.voiceGone} isn't offered by ${GATEWAY} any more, so this call uses the provider's default voice.`)}</p>`;
      if (c.voiceNote) notes += `<p class="call-note" data-testid="voice-note-band">${esc(c.voiceNote)}</p>`;
      if (c.change) notes += `<p class="call-note" data-testid="switching">${esc(`Changing to ${c.change.voice}… The current reply may stop.`)}</p>`;
      if (c.transcriptOpen)
        notes +=
          `<div class="call-transcript" id="call-transcript" role="log" aria-live="off" aria-label="Live captions" data-testid="call-transcript">` +
          (c.captions.length
            ? c.captions.map((x) => `<p data-final="${x.final}" data-saved="${x.saved}" data-testid="caption"><b>${esc(x.role === "user" ? "You" : b.name)}</b> ${esc(x.text)}${x.saved ? ' <span class="v-faint">Saved</span>' : ""}</p>`).join("")
            : `<p class="v-faint">Nothing said yet.</p>`) +
          `</div><p class="call-note" data-testid="captions-note">Live captions. Saved turns appear in this task.</p>`;
    }
    slot.innerHTML =
      `<section class="call-band" role="region" aria-label="${esc(`Voice chat with ${b.name}`)}" data-testid="call-band" data-state="${c.state}"${tone ? ` data-tone="${tone}"` : ""} tabindex="-1">` +
      `<div class="call-top">${top}</div>` +
      (simple ? notes + `<div class="call-actions">${row}</div>` : `<div class="call-row">${row}</div>${notes}`) +
      `</section>`;
    CT.hydrate(slot);
  }

  // The call's settings: a dialog (section 7) ---------------------------------------------------------------

  function openCallSettings() {
    const d = $("#call-settings-dialog");
    renderCallSettings();
    if (!d.open) d.showModal();
    $("select", d)?.focus();
  }
  function renderCallSettings() {
    const d = $("#call-settings-dialog");
    const c = S.call;
    if (!c) {
      if (d.open) d.close();
      return;
    }
    const b = bot(c.bot);
    const saved = S.prefs.saved[c.bot];
    const key = document.activeElement?.dataset?.k;
    const voices = c.canChange && c.voices.length;
    const voiceRow = voices
      ? `<label class="v-field"><span>Voice for this call</span><select class="v-select" data-v="voice" data-k="voice" aria-describedby="voice-note"${c.change || c.state !== "live" ? " disabled" : ""}>` +
        c.voices.map((v) => `<option value="${esc(v)}"${v === c.voice ? " selected" : ""}>${esc(v)}</option>`).join("") +
        `</select></label>`
      : "";
    const voiceNote = c.change
      ? `Changing to ${c.change.voice}… The current reply may stop.`
      : c.voiceMsg || (voices ? `This call: ${c.voice}.` : `${PROVIDERS[c.provider]} offers no voices to choose from for this call.`);
    d.innerHTML =
      `<div class="b-confirm v-call-settings" data-testid="call-settings"><h2 id="call-settings-title">${esc(`Voice chat settings for ${b.name}`)}</h2>` +
      `<div class="v-group"><h4>Voice</h4>${voiceRow}<p class="v-row-note" id="voice-note" data-testid="voice-note">${esc(voiceNote)}</p>` +
      `<p class="v-row-note" data-testid="voice-next">${esc(`Next calls: ${saved.voice || "the provider's default voice"}.`)}</p>` +
      (saved.voice ? button("Default for future calls", 'data-v="voice-default" data-k="voice-default"', "quiet") : "") +
      `</div>` +
      `<div class="v-group"><h4>Speed</h4><label class="v-field"><span>Playback speed</span><select class="v-select" data-v="speed" data-k="speed" aria-describedby="speed-note">${SPEEDS.map((v) => `<option value="${v}"${v === saved.speed ? " selected" : ""}>${v}×</option>`).join("")}</select></label>` +
      `<p class="v-row-note" id="speed-note" data-testid="speed-note">${esc(`Plays at ${saved.speed}× on this device.`)}</p></div>` +
      `<div class="v-group"><h4>Language</h4><label class="v-field"><span>Language for new calls</span><select class="v-select" data-v="lang" data-k="lang" aria-describedby="lang-note">${LANGS.map(([v, l]) => `<option value="${v}"${v === saved.lang ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>` +
      `<p class="v-row-note" id="lang-note" data-testid="lang-note">${esc(c.lang ? `This call: ${langName(c.lang)} requested. The provider decides how it uses it.` : "This call: provider default.")}</p></div>` +
      `<p class="v-row-note" data-testid="kept-note" role="status">${esc(prefNote(c.bot))}</p>` +
      `<div class="b-actions">${button("Close", 'data-v="call-settings-close" data-k="call-settings-close"')}</div></div>`;
    if (key) $(`[data-k="${CSS.escape(key)}"]`, d)?.focus();
  }
  const langName = (v) => (LANGS.find(([k]) => k === v) || [v, v])[1];

  // Where a bot's settings are kept, and whether the last write is confirmed (sections 2, 12).
  function prefNote(botId) {
    const name = nameOf(botId);
    const pr = S.prefs;
    if (pr.pending && pr.pending.bot === botId) return "Saving…";
    if (pr.notes[botId]) return pr.notes[botId];
    if (pr.mode === "device") return `Kept on this device for ${name}.`;
    if (pr.mode === "unknown") return `Couldn't read ${name}'s saved voice settings on ${GATEWAY}, so changes aren't saved.`;
    return `${name}'s saved settings are on ${GATEWAY}, for all your devices.`;
  }

  // Saving one field of one bot: Saving… until the write or a fresh read confirms it.
  function savePref(botId, field, value) {
    const pr = S.prefs;
    delete pr.notes[botId];
    if (pr.mode === "unknown") return render();
    if (pr.mode === "device") {
      pr.saved[botId][field] = value;
      pr.notes[botId] = `Kept on this device for ${nameOf(botId)}.`;
      return render();
    }
    pr.pending = { bot: botId, field, value, before: pr.saved[botId][field] };
    S.io.prefWrites.push({ bot: botId, field, value, expected: { ...pr.saved[botId] } });
    render();
    later(() => ev(S.flags.prefFail ? "prefRefused" : S.flags.prefConflict ? "prefConflict" : "prefOk"), 200);
  }
  const fieldWord = { voice: "voice", speed: "speed", lang: "language" };
  const fieldValue = (field, v) => (field === "voice" ? v || "the provider's default voice" : field === "speed" ? `${v}×` : langName(v));

  // Rendering --------------------------------------------------------------------------------------------

  const shell = $(".shell");
  function strip() {
    const el = $("#status-strip");
    el.hidden = S.connected;
    el.innerHTML = S.connected ? "" : `<span class="status-strip-text">${esc(`Reconnecting to ${GATEWAY}…`)}</span>`;
    $("#gateway-state").textContent = S.connected ? "Connected" : "Reconnecting…";
    $("#gateway-dot").dataset.status = S.connected ? "connected" : "reconnecting";
    $("#gateway-name").textContent = GATEWAY;
  }

  // One render; the focused control, and the field's caret, survive it by their keys.
  function render() {
    const a = document.activeElement;
    const key = a?.dataset?.k;
    const sel = a && a.classList?.contains("composer-input") ? [a.selectionStart, a.selectionEnd] : null;
    shell.dataset.view = S.view;
    renderRail();
    header();
    renderTranscript();
    renderCall();
    renderComposer();
    strip();
    if ($("#call-settings-dialog").open) renderCallSettings();
    if ($("#settings-dialog").open) renderSettings();
    if (key && (!a.isConnected || document.activeElement === document.body)) {
      const el = $(`[data-k="${CSS.escape(key)}"]`);
      if (el) {
        el.focus();
        if (sel && el.setSelectionRange) el.setSelectionRange(sel[0], sel[1]);
      }
    }
  }

  // The microphone (section 2): opened only for the current attempt, an accepted destination and a granted permission.
  function openMic(authorized) {
    if (!authorized || !["granted", "missing"].includes(S.mic)) return false;
    S.io.micOpens += 1;
    return true;
  }
  // The accepted destination, the current attempt and the permission, checked before every opening and every frame.
  const callAudioOk = (c) => Boolean(c) && S.call === c && c.ready && S.consent.has(callKey(c.provider)) && ["granted", "missing"].includes(S.mic);
  const dictAudioOk = (d) => Boolean(d) && S.dict === d && (d.route === "device" || (d.ready && S.consent.has(dictKey("gateway")))) && ["granted", "missing"].includes(S.mic);
  // One frame a second while capture is on: sent only to a ready relay whose destination was accepted.
  function tick() {
    const c = S.call;
    if (c && c.state === "live" && c.ready) {
      c.secs += 1;
      c.clockAt += 1;
      if (c.capture && !c.muted && S.connected && callAudioOk(c)) S.io.appends += 1;
      const el = $('[data-testid="call-time"]');
      if (el) el.textContent = `${mmss(c.secs)} on this device`;
    }
    const d = S.dict;
    if (d && d.capture && d.state === "listening" && dictAudioOk(d)) {
      if (d.route === "gateway" && S.connected) S.io.appends += 1;
      else if (d.route === "device") S.io.deviceFrames += 1; // to the on-device recognizer only
    }
  }
  setInterval(tick, 1000);

  // The system's prompts: pictures of them, labelled as pictures (section 2).
  function showPrompt(kind, then) {
    const layer = $("#os-layer");
    S.os_prompt = { kind, then };
    const web = S.os === "web";
    const words = kind === "speech" ? "“Clawtrate” would like to access Speech Recognition." : web ? "This page wants to use your microphone." : "“Clawtrate” would like to access the microphone.";
    layer.innerHTML =
      `<p class="v-pic-label">Picture of the ${web ? "browser's" : "system's"} prompt. The ${web ? "browser" : "system"} draws the real one.</p>` +
      `<p data-testid="os-prompt"><b>${esc(words)}</b></p>` +
      `<div class="b-actions">${button(web ? "Block" : "Don't Allow", 'data-v="os-deny" data-k="os-deny"', "quiet")}${button("Allow", 'data-v="os-allow" data-k="os-allow"')}</div>`;
    if (!layer.open) layer.showModal(); // above any open dialog, as the system's own is
    $('[data-v="os-allow"]', layer).focus();
  }
  const hidePrompt = () => {
    if ($("#os-layer").open) $("#os-layer").close();
    S.os_prompt = null;
  };
  // Asks the system when it must; then(granted) runs with the answer.
  function withMicPermission(then) {
    if (S.mic === "prompt") return showPrompt("mic", then);
    then(S.mic === "granted" || S.mic === "missing");
  }

  // Consent (section 2): where the audio goes, said in full before the microphone opens --------------------

  function openConsent(kind, extra = {}) {
    const d = $("#consent-dialog");
    S.pending = { kind, ...extra };
    if (!d.open) S.consentOpener = document.activeElement;
    const sub = (text, attrs = "") => `<span class="b-choice-sub b-wrap"${attrs}>${esc(text)}</span>`;
    if (kind === "unknown") {
      d.innerHTML =
        `<div class="b-confirm voice-consent" data-testid="consent" data-kind="unknown"><h2 id="consent-title">Can't verify where your voice would go</h2>` +
        `<p>${esc(`Clawtrate couldn't read which voice provider ${GATEWAY} uses, so it doesn't start a voice chat.`)}</p>` +
        `<div class="b-actions">${button("Cancel", 'data-v="consent-cancel" data-k="consent-cancel"', "quiet")}${button("Retry", 'data-v="catalog-retry" data-k="catalog-retry" data-variant="primary"')}</div></div>`;
    } else if (kind === "call") {
      const providerId = extra.providerId || S.providerId;
      d.innerHTML =
        `<div class="b-confirm voice-consent" data-testid="consent" data-kind="call"><h2 id="consent-title">Where your voice goes</h2>` +
        (extra.drift ? `<p data-testid="drift">${esc(`${GATEWAY} chose a different voice provider than it listed. Nothing was sent.`)}</p>` : "") +
        `<dl class="v-dest"><div><dt>Gateway</dt><dd data-testid="dest-gateway">${esc(GATEWAY)}</dd></div><div><dt>Voice provider</dt><dd data-testid="dest-provider">${esc(PROVIDERS[providerId])}</dd></div></dl>` +
        `<p data-testid="consent-sentence">${esc(SENTENCE.call(providerId))}</p>` +
        `<div class="b-actions">${button("Cancel", 'data-v="consent-cancel" data-k="consent-cancel"', "quiet")}${button("Start voice chat", 'data-v="consent-ok" data-k="consent-ok" data-variant="primary"')}</div></div>`;
    } else {
      const dev = deviceRoute();
      const gw = gatewayRoute();
      const any = dev.ok || gw.ok;
      const okRoute = (r) => (r === "device" ? dev.ok : r === "gateway" ? gw.ok : false);
      if (!okRoute(S.dictChoice)) S.dictChoice = okRoute(S.dictRoute) ? S.dictRoute : dev.ok ? "device" : gw.ok ? "gateway" : null;
      const row = (id, title, ok, sentence, why) =>
        ok
          ? `<li><button type="button" class="b-choice" role="radio" aria-checked="${S.dictChoice === id}" tabindex="${S.dictChoice === id ? 0 : -1}" data-v-route="${id}" data-k="route-${id}"><span class="b-choice-text"><span class="b-choice-title">${esc(title)}</span>${sub(sentence, ' data-testid="route-sentence"')}</span></button></li>`
          : `<li><div class="b-choice" aria-disabled="true"><span class="b-choice-text"><span class="b-choice-title">${esc(title)}</span>${sub(why, ' data-testid="route-why"')}</span></div></li>`;
      d.innerHTML =
        `<div class="b-confirm voice-consent" data-testid="consent" data-kind="dict"><h2 id="consent-title">${any ? "Where your voice goes" : "Dictation isn't available here"}</h2>` +
        `<ul class="b-choices" role="radiogroup" aria-label="Dictation">` +
        row("device", `On this ${here()}`, dev.ok, SENTENCE.device(), dev.why) +
        row("gateway", `Through ${GATEWAY}`, gw.ok, SENTENCE.gateway(), gw.why) +
        `</ul><div class="b-actions">${any ? `${button("Cancel", 'data-v="consent-cancel" data-k="consent-cancel"', "quiet")}${button("Start dictation", 'data-v="consent-ok" data-k="consent-ok" data-variant="primary"')}` : button("Close", 'data-v="consent-cancel" data-k="consent-cancel"')}</div></div>`;
    }
    if (!d.open) d.showModal();
    const key = document.activeElement?.dataset?.k;
    if (!(key && d.contains(document.activeElement))) ($('[data-v="consent-ok"]', d) || $('[data-v="catalog-retry"]', d) || $('[data-v="consent-cancel"]', d)).focus();
    else $(`[data-k="${CSS.escape(key)}"]`, d)?.focus();
  }

  function closeConsent(ok) {
    const d = $("#consent-dialog");
    const pending = S.pending;
    d.close();
    S.pending = null;
    if (!ok || !pending) {
      render();
      return S.consentOpener?.isConnected ? S.consentOpener.focus() : focusKey(pending?.kind === "dict" ? "mic" : "call");
    }
    if (pending.kind === "call") {
      const providerId = pending.providerId || S.providerId;
      S.consent.add(callKey(providerId));
      if (pending.resume !== undefined) {
        const c = S.call;
        if (c && c.attempt === pending.resume) resumeCapture(c, () => ((c.muted = false), (c.unmuting = true)));
        return;
      }
      startCall(pending.task || S.sel.task, providerId);
    } else {
      S.dictRoute = S.dictChoice;
      S.consent.add(dictKey(S.dictRoute));
      startDictation();
    }
  }

  // One call at a time: the second asks first (section 9).
  function askSecond(target) {
    const d = $("#confirm-dialog");
    S.secondTarget = target;
    S.secondOpener = document.activeElement;
    d.innerHTML =
      `<div class="b-confirm" data-testid="second"><h2 id="confirm-title">End the current voice chat?</h2><p id="confirm-text">${esc(`You're in a voice chat with ${nameOf(S.call.bot)}. Ending it starts one with ${taskOf(target).b.name}.`)}</p>` +
      `<div class="b-actions">${button("Cancel", 'data-v="second-cancel" data-k="second-cancel"', "quiet")}${button("End and Chat", 'data-v="second-ok" data-k="second-ok" data-variant="primary"')}</div></div>`;
    d.showModal();
    $('[data-v="second-ok"]', d).focus();
  }

  const focusKey = (k) => requestAnimationFrame(() => $(`[data-k="${k}"]`)?.focus());
  const focusBand = () => requestAnimationFrame(() => $("#call-slot .call-band")?.focus());

  // Dictation (section 4) -----------------------------------------------------------------------------------

  function pressMic() {
    if (S.dict) return stopDictation();
    if (micReason()) return;
    const route = S.dictRoute;
    const ok = route && (route === "device" ? deviceRoute() : gatewayRoute()).ok;
    // The saved route is not consent: the destination is accepted for its route and provider.
    if (!route || !ok || !S.consent.has(dictKey(route))) return openConsent("dict");
    startDictation();
  }

  function startDictation() {
    const task = S.sel.task;
    const route = S.dictRoute;
    const begin = () => {
      if (!S.consent.has(dictKey(route))) return openConsent("dict");
      const id = ++S.seq;
      S.notices = S.notices.filter((n) => n.task !== task || !/dictation|microphone|speech/i.test(n.title));
      S.dict = { id, route, task, state: route === "gateway" ? "connecting" : "listening", capture: false, partial: "", inserted: 0, session: null, ready: false };
      if (route === "gateway") {
        // Created with the accepted transcription provider; the microphone opens after the matching reply and ready.
        S.io.creates.push({ kind: "transcription", id, provider: TRANSCRIBER.id });
        const session = `ts${id}`;
        if (S.flags.dictFail) later(() => ev("dictRefused", { message: "No realtime transcription provider registered" }), 120);
        else {
          later(() => ev("dictCreate", { sessionId: session, provider: S.dictDrift ? "deepgram-live" : TRANSCRIBER.id }), 100);
          later(() => ev("dictReady", { sessionId: session }), 160);
        }
      } else {
        S.dict.capture = openMic(dictAudioOk(S.dict));
        later(() => ev("dictPartial", { text: "check the backup" }), 120);
        later(() => ev("dictFinal", { text: "Check the backup logs too." }), 500);
      }
      render();
      say(route === "gateway" ? `Connecting to ${GATEWAY}` : "Listening");
      focusKey("mic");
    };
    withMicPermission((granted) => {
      if (!granted) {
        if (S.mic === "none") notify("No microphone found.", "", startDictation, task);
        else notify("Microphone not allowed.", deniedWords()[0], startDictation, task);
        render();
        return focusKey("mic");
      }
      if (route === "device" && S.speech !== "granted") {
        if (S.speech === "denied") {
          notify("Speech recognition not allowed.", speechDenied(), startDictation, task);
          render();
          return focusKey("mic");
        }
        return showPrompt("speech", (ok) => {
          if (ok) return begin();
          notify("Speech recognition not allowed.", speechDenied(), startDictation, task);
          render();
          focusKey("mic");
        });
      }
      begin();
    });
  }

  // Final words edit the current selection of their task's draft, after every edit made since.
  function insertFinal(d, text) {
    if (S.sel.task !== d.task) return; // a dictation never writes into another task
    const input = $(".composer-input");
    let v = S.drafts[d.task] || "";
    let [s, e] = [v.length, v.length];
    if (input && document.activeElement === input) [s, e] = [input.selectionStart, input.selectionEnd];
    else if (S.caret[d.task]) [s, e] = S.caret[d.task];
    s = Math.min(s, v.length);
    e = Math.min(Math.max(e, s), v.length);
    const before = v.slice(0, s);
    const after = v.slice(e);
    const piece = (before && !/\s$/.test(before) ? " " : "") + text + (after && !/^\s/.test(after) ? " " : "");
    v = before + piece + after;
    S.drafts[d.task] = v;
    S.caret[d.task] = [s + piece.length, s + piece.length];
    d.inserted += 1;
    if (input) {
      input.value = v;
      input.setSelectionRange(s + piece.length, s + piece.length);
    }
  }

  function stopDictation(why = "") {
    const d = S.dict;
    if (!d) return;
    d.capture = false;
    d.partial = "";
    if (d.route === "gateway") {
      // Closed once; the provider's final words for this draft may still come while it drains.
      S.io.closes.push({ kind: "transcription", id: d.id });
      if (!why && d.state === "listening") {
        S.draining = d;
        later(() => ev("dictClosed"), 300);
      }
    }
    S.dict = null;
    S.held = false;
    if (why) notify("Dictation stopped.", why, null, d.task);
    render();
    say(why ? `Dictation stopped. ${why}` : d.inserted ? "Dictation stopped. The text is in your message." : "Dictation stopped.");
    if (!why) focusKey("mic");
  }

  // A call (sections 5, 6, 8, 9) ----------------------------------------------------------------------------

  function pressCall(task = S.sel.task) {
    if (S.call && liveCall(S.call) && S.call.task === task) return focusBand();
    if (S.call && liveCall(S.call)) return askSecond(task);
    if (callReason()) return;
    if (S.dict) {
      stopDictation();
      if (hasContent(task)) return; // final words arrived: the composer is no longer empty
    }
    gateCall(task);
  }

  // The gate every start passes, the first and every retry: connection, open relays, provider, consent (section 5).
  function gateCall(task, providerId = S.providerId) {
    if (!S.connected) return failStart(task, "No connection", `This device isn't connected to ${GATEWAY}. Start again when it reconnects.`);
    if (blocker()) return render();
    if (S.catalog.voice === "unknown") return openConsent("unknown", { task });
    if (!S.consent.has(callKey(providerId))) return openConsent("call", { task, providerId });
    startCall(task, providerId);
  }

  function newCall(task, providerId) {
    const b = taskOf(task).b.id;
    const saved = S.prefs.saved[b];
    return {
      attempt: ++S.attempt, bot: b, task, provider: providerId, state: "permission", relayIds: [], relay: null,
      ready: false, capture: false, muted: false, playing: false, thinking: false, micStopped: null, background: false,
      secs: 0, clockAt: NOW, expiresAt: NOW + 1800, captions: [], transcriptOpen: false,
      voice: null, voices: [], canChange: false, change: null, voiceMsg: "", voiceNote: "", voiceGone: "",
      lang: saved.lang || "", requestedVoice: saved.voice,
    };
  }

  function startCall(task, providerId) {
    if (blocker()) return render();
    if (S.dict) stopDictation();
    pauseMemo();
    S.call = newCall(task, providerId);
    const c = S.call;
    withMicPermission((granted) => {
      if (S.call !== c) return;
      if (!granted) {
        c.state = S.mic === "none" ? "nomic" : "denied";
        render();
        return focusBand();
      }
      if (S.mic === "missing" && !S.tempMic) {
        c.state = "missing";
        render();
        return focusBand();
      }
      // The microphone stays off until the create's provider matches and that relay is ready.
      createRelay(c);
    });
    if (S.os_prompt) {
      render();
      focusBand();
    }
  }

  // talk.session.create with the disclosed provider by id; nothing is sent until it is ready.
  function createRelay(c) {
    c.state = "creating";
    const relay = { id: null, attempt: c.attempt, state: "creating", expiresAt: NOW + 1800, task: c.task };
    S.relays.push(relay);
    c.relay = relay;
    S.io.creates.push({ kind: "realtime", attempt: c.attempt, provider: c.provider, sessionKey: c.task, language: c.lang || undefined, voice: c.requestedVoice || undefined, capabilities: ["voice-selection"] });
    render();
    focusBand();
    if (S.flags.createFail) later(() => ev("create", { ok: false, message: REFUSAL }), 150);
    else later(() => ev("create", { ok: true, provider: S.drift && c.provider === S.providerId ? "xai" : c.provider }), 150);
  }

  function failStart(task, reason, second) {
    S.call = { ...newCall(task, S.providerId), state: "failed", reason, second };
    render();
    say(`Voice chat failed: ${reason}`);
    focusBand();
  }

  function stopMedia(c) {
    c.capture = false;
    c.playing = false;
    c.thinking = false;
  }

  // Hang up and End and Chat: media stops at once; the band says Ending… until the gateway confirms (section 8).
  function hangup() {
    const c = S.call;
    if (!c) return;
    stopMedia(c);
    if (["permission", "missing", "denied", "nomic"].includes(c.state)) {
      hidePrompt();
      S.call = null;
      S.next = null;
      render();
      return focusKey("call");
    }
    if (c.state === "creating") {
      // A start cancelled before its answer: the answer, if one comes, is closed unused.
      c.relay.cancelled = true;
      S.call = null;
      S.next = null;
      render();
      return focusKey("call");
    }
    c.state = "ending";
    for (const r of S.relays) if (c.relayIds.includes(r.id) && r.state === "open") r.state = "closing";
    for (const id of c.relayIds) if (S.relays.find((r) => r.id === id && r.state === "closing")) S.io.closes.push({ kind: "realtime", id });
    render();
    focusBand();
    later(() => ev("closeResult", { ok: !S.flags.closeFail }), 200);
  }

  function leaveLine(c, confirmed) {
    const vs = c.relayIds[0];
    if (!vs) return;
    S.held[vs] = c.secs;
    const saved = (S.history[c.task] || []).some((r) => voiceIdOf(r) === vs || c.relayIds.includes(voiceIdOf(r)));
    if (!saved && !(S.heldEmpty[c.task] || []).some((e) => e.vs === vs)) (S.heldEmpty[c.task] ||= []).push({ vs, secs: c.secs });
    if (!confirmed) S.lineNotes[vs] = `Ended on this device. ${GATEWAY} did not confirm the call ended.`;
  }

  function endCall(confirmed) {
    const c = S.call;
    if (!c) return;
    leaveLine(c, confirmed);
    S.call = null;
    render();
    say(confirmed ? "Voice chat ended" : `Ended on this device. ${GATEWAY} did not confirm the call ended.`);
    focusKey("call");
    const next = S.next;
    S.next = null;
    // End and Chat goes on only after a confirmed end, through the usual gate.
    if (confirmed && next) {
      selectTask(next);
      render();
      gateCall(next);
    }
  }

  // Reopening capture on a call: the destination, the attempt and the permission first (section 2).
  function resumeCapture(c, then) {
    if (S.mic === "denied") {
      c.micStopped = "revoked";
      return render();
    }
    if (!S.consent.has(callKey(c.provider))) {
      // Consent no longer applies: the microphone stays off and the full destination is offered again.
      c.muted = true;
      c.capture = false;
      render();
      return openConsent("call", { task: c.task, providerId: c.provider, resume: c.attempt });
    }
    then();
    if (openMic(callAudioOk(c))) later(() => ev("capture", { attempt: c.attempt }), 60);
    render();
  }

  // Voice (section 7): talk.voice.set, the gateway's request, the replacement, applied ---------------------

  function setVoice(v) {
    const c = S.call;
    if (!c || c.state !== "live" || !c.ready || c.change) return;
    if (v === c.voice) return; // the gateway answers "applied" with no replacement: nothing to do
    S.io.sets.push({ voice: v, voiceSessionId: c.relayIds.at(-1) });
    c.change = { voice: v, phase: "set", from: c.voice, id: null, replacement: null };
    c.voiceMsg = "";
    render();
    if (S.flags.voiceFail) later(() => ev("setRefused", { message: "Voice is not in this call's catalog; list the available voices first" }), 150);
    else later(() => ev("voiceRequested"), 150);
  }

  // Events: what the gateway and the device report, one at a time ------------------------------------------

  function ev(name, data = {}) {
    const c = S.call;
    const pr = S.prefs;
    switch (name) {
      case "capture": {
        // The track is live: only now can the band say Listening or Unmuted take effect.
        if (!c || !liveCall(c) || c.muted || c.micStopped || !callAudioOk(c) || (data.attempt !== undefined && data.attempt !== c.attempt)) return;
        c.capture = true;
        if (c.unmuting) (c.unmuting = false), say("Unmuted");
        else if (c.ready && !c.announced) (c.announced = true), say(`Voice chat with ${nameOf(c.bot)} started`);
        break;
      }
      case "create": {
        const relay = S.relays.find((r) => r.state === "creating");
        if (!relay) return;
        if (!data.ok) {
          relay.state = "closed";
          if (c && c.relay === relay) {
            stopMedia(c);
            c.state = "refused";
            c.message = data.message;
            say("Couldn't start voice chat");
          }
          break;
        }
        relay.id = `vs${relay.attempt}`;
        relay.state = "open";
        relay.provider = data.provider;
        if (relay.cancelled || !c || c.relay !== relay) {
          // Cancelled before its answer: closed at once, nothing attached.
          relay.state = "closing";
          S.io.closes.push({ kind: "realtime", id: relay.id, why: "cancelled" });
          later(() => ev("closeResult", { ok: true, id: relay.id }), 100);
          break;
        }
        if (data.provider !== c.provider) {
          // Not the provider the person accepted: closed unused, and the person is asked again.
          relay.state = "closing";
          S.io.closes.push({ kind: "realtime", id: relay.id, why: "provider" });
          later(() => ev("closeResult", { ok: true, id: relay.id }), 100);
          stopMedia(c);
          S.call = null;
          render();
          openConsent("call", { task: c.task, providerId: data.provider, drift: true });
          return;
        }
        c.relayIds.push(relay.id);
        c.state = "live";
        c.voices = S.noVoices ? [] : VOICES.slice();
        c.canChange = !S.noVoices;
        c.voice = c.requestedVoice && c.voices.includes(c.requestedVoice) ? c.requestedVoice : c.voices[0] || null;
        if (c.requestedVoice && !c.voices.includes(c.requestedVoice)) c.voiceGone = c.requestedVoice;
        later(() => ev("ready", { id: relay.id }), 120);
        break;
      }
      case "ready": {
        // Only the ready of this call's own relay, matched by id.
        if (!c || c.state !== "live" || data.id !== c.relayIds.at(-1) || c.ready) return;
        c.ready = true;
        if (openMic(callAudioOk(c))) later(() => ev("capture"), 60);
        break;
      }
      case "responseStarted":
        if (c && c.ready) c.thinking = true;
        break;
      case "playbackStart":
        if (c && c.ready && c.state === "live") (c.thinking = false), (c.playing = true);
        break;
      case "playbackEnd":
      case "clear":
        if (c) c.playing = false;
        break;
      case "caption": {
        // Only this call's own relay; another voice session's captions never touch the band.
        if (!c || !data.id || !data.id.startsWith(`voice:${c.relayIds.at(-1)}:`)) return;
        const x = c.captions.find((y) => y.id === data.id);
        if (x) Object.assign(x, { text: data.text ?? x.text, final: Boolean(data.final) });
        else c.captions.push({ id: data.id, role: data.role, text: data.text, final: Boolean(data.final), saved: false });
        break;
      }
      case "history": {
        const task = data.task || (c && c.task) || S.sel.task;
        (S.history[task] ||= []).push({ id: data.id, role: data.role, text: data.text, ts: data.ts ?? NOW, voice: data.voice !== false });
        if (c) for (const x of c.captions) if (x.id === data.id) x.saved = true;
        if (S.heldEmpty[task]) S.heldEmpty[task] = S.heldEmpty[task].filter((e) => !String(data.id).startsWith(`voice:${e.vs}:`));
        break;
      }
      case "error": {
        if (!c || !c.ready || c.state !== "live") return;
        stopMedia(c);
        for (const r of S.relays) if (c.relayIds.includes(r.id)) r.state = "closed";
        leaveLine(c, true);
        S.call = { ...c, state: "failed", reason: "The call ended unexpectedly", second: `${GATEWAY} ended the call: ${data.message || "Realtime provider closed the session."}` };
        say("Voice chat failed: The call ended unexpectedly");
        break;
      }
      case "close": {
        // A matching terminal close ends that relay even with no reply to close. Never across a reconnect.
        const r = S.relays.find((x) => x.id === data.id && x.state !== "closed" && x.connGen === undefined);
        if (!r) return;
        r.state = "closed";
        delete S.lineNotes[data.id];
        if (c && c.state === "live" && c.relayIds.at(-1) === data.id) {
          stopMedia(c);
          leaveLine(c, true);
          S.call = null;
          say("Voice chat ended");
        } else if (c && c.state === "ending" && !openRelays().some((x) => c.relayIds.includes(x.id))) return endCall(true);
        break;
      }
      case "closeResult": {
        const ids = data.id ? [data.id] : c && c.state === "ending" ? c.relayIds : [];
        for (const r of S.relays) if (ids.includes(r.id) && r.state === "closing") r.state = data.ok ? "closed" : "unconfirmed";
        if (c && c.state === "ending" && !data.id) return endCall(Boolean(data.ok));
        break;
      }
      case "drop": {
        S.connected = false;
        // Every relay of this connection may still be open: none is known to have ended.
        for (const r of S.relays) if (r.state !== "closed") (r.state = "unconfirmed"), (r.connGen = S.gen);
        if (c && c.state === "ending") {
          endCall(false);
        } else if (c && liveCall(c)) {
          stopMedia(c);
          hidePrompt();
          leaveLine(c, true);
          if (c.change) c.change = null;
          S.call = { ...c, state: "lost", reason: "Connection lost" };
          say("Voice chat failed: Connection lost");
        }
        if (S.dict && S.dict.route === "gateway") stopDictation("Gateway connection lost.");
        if (S.draining) S.draining = null;
        later(() => ev("hello"), S.helloMs ?? 600);
        break;
      }
      case "hello": {
        // A new connection: it says nothing about the old relays, and starts no media.
        if (S.connected) return;
        S.connected = true;
        S.gen += 1;
        if (S.call && S.call.state === "lost") say(`Reconnected to ${GATEWAY}. The voice session could not be resumed.`);
        break;
      }
      case "expire": {
        // The scheduled end of every relay that may still be open has passed.
        for (const r of S.relays) if (r.state === "unconfirmed") r.state = "closed";
        for (const k of Object.keys(S.lineNotes)) delete S.lineNotes[k];
        break;
      }
      case "trackEnded": {
        if (data.cause === "revoked") S.mic = "denied";
        if (S.dict) {
          S.dict.capture = false;
          stopDictation(`Microphone stopped. No new audio is being sent.${data.cause === "revoked" ? " Microphone access was turned off." : ""}`);
          return;
        }
        if (!c || !liveCall(c)) return;
        c.capture = false;
        c.micStopped = data.cause || "unknown";
        if (data.cause === "revoked") S.mic = "denied";
        say("Microphone stopped. No new audio is being sent.");
        break;
      }
      case "background": {
        if (!c || !liveCall(c)) return;
        stopMedia(c);
        c.muted = true;
        c.background = true;
        break;
      }
      case "voiceRequested": {
        if (!c || !c.change || c.change.phase !== "set" || !S.connected) return;
        c.change.phase = "replacing";
        c.change.id = `chg${c.attempt}`;
        // One replacement, with the change's id, the original task and language, and voice selection.
        S.io.creates.push({ kind: "realtime", voiceChangeId: c.change.id, sessionKey: c.task, language: c.lang || undefined, capabilities: ["voice-selection"] });
        later(() => ev("replacementReady"), 150);
        break;
      }
      case "botVoiceRequested": {
        // A change this device did not ask for: declined, before any replacement opens.
        if (!c || c.change || !c.ready) return;
        S.io.completes.push({ changeId: "bot-change", outcome: "failed" });
        c.voiceNote = `${nameOf(c.bot)} asked for a different voice. Clawtrate kept ${c.voice} for this call.`;
        break;
      }
      case "replacementReady": {
        if (!c || !c.change || c.change.phase !== "replacing" || !S.connected) return;
        const id = `vs${c.attempt}r`;
        c.change.replacement = id;
        S.relays.push({ id, attempt: c.attempt, state: "open", expiresAt: NOW + 1800 + c.secs, task: c.task });
        // Old audio stops being routed and its queue is dropped; the original is closed; then complete.
        c.playing = false;
        const old = S.relays.find((r) => r.id === c.relayIds.at(-1));
        S.io.closes.push({ kind: "realtime", id: c.relayIds.at(-1), why: "voice change" });
        if (old) old.state = "closed";
        c.relayIds.push(id);
        c.change.phase = "completing";
        S.io.completes.push({ changeId: c.change.id, voiceSessionId: id, outcome: "ready" });
        later(() => ev("setApplied"), 100);
        break;
      }
      case "setApplied": {
        // talk.voice.set answered "applied" for this replacement on this connection: only now.
        if (!c || !c.change || c.change.phase !== "completing" || !S.connected) return;
        const v = c.change.voice;
        c.voice = v;
        c.change = null;
        c.voiceMsg = `Voice: ${v}, from ${nameOf(c.bot)}'s next reply.`;
        say(c.voiceMsg);
        savePref(c.bot, "voice", v);
        break;
      }
      case "setRefused":
      case "replacementFailed": {
        if (!c || !c.change) return;
        if (c.change.phase !== "set") {
          S.io.completes.push({ changeId: c.change.id, outcome: "failed" });
          if (c.change.replacement) S.io.closes.push({ kind: "realtime", id: c.change.replacement, why: "replacement failed" });
        }
        c.voiceMsg = `Voice didn't change${data.message ? `: ${data.message}` : ""}. Still using ${c.change.from}.`;
        c.change = null;
        say("Voice didn't change");
        break;
      }
      case "prefOk": {
        const w = pr.pending;
        if (!w) return;
        pr.saved[w.bot][w.field] = w.value;
        pr.pending = null;
        pr.notes[w.bot] = `Saved for ${nameOf(w.bot)} on ${GATEWAY}, so your other devices use it too.`;
        break;
      }
      case "prefConflict": {
        // Another device wrote first: read again, change only this bot's field, try again.
        const w = pr.pending;
        if (!w) return;
        Object.assign(pr.saved[w.bot], data.remote || { speed: "1.5" });
        S.io.prefWrites.push({ bot: w.bot, field: w.field, value: w.value, expected: { ...pr.saved[w.bot] }, retry: true });
        S.flags.prefConflict = false;
        later(() => ev("prefOk"), 150);
        break;
      }
      case "prefRefused": {
        const w = pr.pending;
        if (!w) return;
        pr.pending = null;
        const differs = c && c.bot === w.bot && w.field === "voice" ? " This call may differ." : "";
        pr.notes[w.bot] = `Couldn't save: ${data.message || "the gateway refused the write"}. ${nameOf(w.bot)}'s saved ${fieldWord[w.field]} is still ${fieldValue(w.field, pr.saved[w.bot][w.field])}.${differs}`;
        break;
      }
      case "prefRemote": {
        // Another device changed a saved value: it applies to next calls, never to this one.
        pr.saved[data.bot][data.field] = data.value;
        pr.notes[data.bot] = `Changed on another device: ${fieldWord[data.field]} ${fieldValue(data.field, data.value)} from ${nameOf(data.bot)}'s next call.`;
        break;
      }
      case "dictCreate": {
        const d = S.dict;
        if (!d || d.route !== "gateway" || d.state !== "connecting" || d.session) return;
        if (data.provider !== TRANSCRIBER.id) {
          // Another provider than the one accepted: closed unused; its full name is shown before any consent.
          S.io.closes.push({ kind: "transcription", id: data.sessionId, why: "provider" });
          S.dict = null;
          const label = TRANSCRIBERS[data.provider];
          if (!label) {
            notify("Dictation not started.", "Can't verify where your voice would go.", null, d.task);
            break;
          }
          TRANSCRIBER = { id: data.provider, label };
          render();
          return openConsent("dict");
        }
        d.session = data.sessionId;
        break;
      }
      case "dictReady": {
        const d = S.dict;
        if (!d || d.route !== "gateway" || d.state !== "connecting" || !d.session || data.sessionId !== d.session) return;
        d.ready = true;
        d.capture = openMic(dictAudioOk(d));
        if (!d.capture) return stopDictation("Microphone not allowed.");
        d.state = "listening";
        say("Listening");
        later(() => ev("dictPartial", { text: "check the backup" }), 120);
        later(() => ev("dictFinal", { text: "Check the backup logs too." }), 500);
        break;
      }
      case "dictRefused": {
        const d = S.dict;
        if (!d) return;
        S.dict = null;
        notify("Couldn't start dictation.", data.message, startDictation, d.task);
        break;
      }
      case "dictPartial": {
        const d = S.dict;
        if (!d || d.state !== "listening") return;
        d.partial = data.text;
        const el = $('[data-testid="partial"]');
        if (el) el.innerHTML = d.partial ? `Not final yet: <i>${esc(d.partial)}</i>` : "";
        return;
      }
      case "dictFinal": {
        // From the listening dictation, or from the one draining after an ordinary stop; empty ones ignored.
        let d = S.dict && S.dict.state === "listening" ? S.dict : S.draining;
        if (data.id !== undefined && d && d.id !== data.id) d = null;
        if (!d || !data.text || d.frozen) return;
        d.partial = "";
        insertFinal(d, data.text);
        break;
      }
      case "dictClosed":
        S.draining = null;
        return;
      case "memoAnswer": {
        const m = S.memo;
        if (m.state !== "loading") return;
        const kind = m.kind;
        if (kind === "expired" || kind === "wrongroute") {
          m.state = "error";
          m.error = `Clawtrate didn't fetch this voice memo: ${GATEWAY}'s answer isn't a download it fetches by itself.`;
          m.retry = false;
        } else if (kind === "redirect") {
          S.io.hostFetches += 1;
          m.state = "error";
          m.error = "Couldn't load the voice memo: the download tried to redirect, which Clawtrate doesn't follow.";
          m.retry = true;
        } else if (kind === "big") {
          m.state = "error";
          m.error = "This voice memo is larger than 5 MiB, so Clawtrate can't play it here.";
          m.retry = false;
        } else if (kind === "fail") {
          m.state = "error";
          m.error = "Couldn't load the voice memo.";
          m.retry = true;
        } else {
          if (kind === "grant") S.io.hostFetches += 1;
          m.state = "playing";
          m.at = 3;
          S.io.plays += 1;
        }
        break;
      }
      default:
        return;
    }
    render();
  }

  // Memo actions ----------------------------------------------------------------------------------------------

  function playMemo(which) {
    const m = S.memo;
    if (S.call && liveCall(S.call)) return; // a call has the audio
    if (m.which === which && m.state === "playing") return (m.state = "paused"), render();
    if (m.which === which && m.state === "paused") return (m.state = "playing"), (S.io.plays += 1), render();
    if (m.state === "loading") return;
    m.which = which;
    m.state = "loading";
    S.io.downloads += 1; // artifacts.download for this item, now
    render();
    later(() => ev("memoAnswer"), 150);
  }
  function pauseMemo() {
    if (S.memo.state === "playing") S.memo.state = "paused";
    if (S.memo.state === "loading") S.memo.state = "idle";
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
    const key = document.activeElement?.dataset?.k;
    const choices = S.namesShown ? DEVICES : ["System Default"];
    const micRows =
      `<ul class="b-choices" role="radiogroup" aria-label="Microphone">` +
      choices
        .map(
          (m) =>
            `<li><button type="button" class="b-choice" role="radio" aria-checked="${S.storedMic === m}" tabindex="${S.storedMic === m ? 0 : -1}" data-v-mic="${esc(m)}" data-k="mic-${esc(m)}"><span class="b-choice-text"><span class="b-choice-title">${esc(m)}</span>${m === "USB Microphone" && S.mic === "missing" ? `<span class="b-choice-sub b-wrap">Not connected</span>` : ""}</span></button></li>`,
        )
        .join("") +
      `</ul>`;
    const names = S.namesShown
      ? ""
      : S.namesAsk
        ? `<p class="b-hint b-wrap" data-testid="names-explain">To show your microphones' names, Clawtrate opens the microphone for a moment and closes it at once. Nothing is recorded or sent.</p><p class="b-hint">${button("Continue", 'data-v="names-continue" data-k="names-continue"')} ${button("Cancel", 'data-v="names-cancel" data-k="names-cancel"', "quiet")}</p>`
        : `<p class="b-hint" data-testid="names-hidden">Allow microphone access to see your microphones' names. ${button("Allow", 'data-v="allow-names" data-k="allow-names"')}</p>`;
    const dev = deviceRoute();
    const gw = gatewayRoute();
    const current = S.dictRoute || (dev.ok ? "device" : "gateway");
    const route = (id, title, r, sentence) =>
      r.ok
        ? `<li><button type="button" class="b-choice" role="radio" aria-checked="${S.dictRoute === id}" tabindex="${current === id ? 0 : -1}" data-v-sroute="${id}" data-k="sroute-${id}"><span class="b-choice-text"><span class="b-choice-title">${esc(title)}</span><span class="b-choice-sub b-wrap" data-testid="settings-sentence">${esc(sentence)}</span></span></button></li>`
        : `<li><div class="b-choice" aria-disabled="true"><span class="b-choice-text"><span class="b-choice-title">${esc(title)}</span><span class="b-choice-sub b-wrap">${esc(r.why)}</span></span></div></li>`;
    const callLine =
      S.catalog.voice === "ready"
        ? SENTENCE.call(S.providerId)
        : S.catalog.voice === "none"
          ? `Voice chat isn't set up on ${GATEWAY}. Its owner sets up a voice provider in OpenClaw's Talk settings.`
          : S.catalog.voice === "direct"
            ? `${GATEWAY}'s voice provider talks to apps directly, which Clawtrate doesn't do.`
            : `Can't tell whether voice chat is set up on ${GATEWAY}.`;
    const pr = S.prefs;
    const where =
      pr.mode === "gateway"
        ? `Saved on ${GATEWAY}, so your other devices use them too.`
        : pr.mode === "device"
          ? "Kept on this device, for each bot: this connection has no user profile on the gateway."
          : `Couldn't read the saved voice settings on ${GATEWAY}.`;
    const body =
      `<div class="v-group"><h4>Microphone</h4>${micRows}${names}` +
      (S.mic === "missing" && S.storedMic === "USB Microphone" ? `<p class="b-hint" data-testid="mic-missing">USB Microphone isn't connected. Voice won't use another microphone without asking.</p>` : "") +
      `<p class="b-hint">Kept on this device.</p></div>` +
      `<div class="v-group"><h4>Dictation</h4><ul class="b-choices" role="radiogroup" aria-label="Dictation">${route("device", `On this ${here()}`, dev, SENTENCE.device())}${route("gateway", `Through ${GATEWAY}`, gw, SENTENCE.gateway())}</ul>` +
      `<p class="b-hint b-wrap">Choosing a route here starts nothing; its first use still says where your voice goes.</p>` +
      (canWrite() ? "" : `<p class="b-hint">Dictation and voice chat need more access on this connection.</p>`) +
      `</div>` +
      `<div class="v-group"><h4>Voice chat</h4><p class="b-hint b-wrap" data-testid="settings-call">${esc(callLine)}</p></div>` +
      `<div class="v-group"><h4>Bots</h4><table class="v-table"><thead><tr><th>Bot</th><th>Voice</th><th>Speed</th><th>Language</th><th><span class="visually-hidden">Reset</span></th></tr></thead><tbody>` +
      BOTS.map((b) => {
        const k = pr.saved[b.id];
        const gate = !canWrite() || pr.mode === "unknown" ? ` aria-disabled="true" aria-description="${canWrite() ? "Can't save: the saved settings couldn't be read" : "Needs more access"}"` : "";
        return `<tr><td>${esc(b.name)}</td><td data-testid="saved-voice">${esc(k.voice || "Provider default")}</td><td>${esc(SPEEDS.includes(k.speed) ? k.speed : "1")}×</td><td>${esc(langName(k.lang))}</td><td>${button("Reset", `data-v="reset" data-bot="${b.id}" data-k="reset-${b.id}" aria-label="${esc(`Reset ${b.name}'s voice settings`)}"${gate}`, "quiet")}</td></tr>`;
      }).join("") +
      `</tbody></table><p class="b-hint" data-testid="bots-kept">${esc(where)}</p>` +
      BOTS.filter((b) => pr.notes[b.id] || (pr.pending && pr.pending.bot === b.id)).map((b) => `<p class="b-hint" data-testid="bot-note">${esc(`${b.name}: ${prefNote(b.id)}`)}</p>`).join("") +
      `</div>`;
    d.innerHTML =
      `<div class="b-settings" data-pane="section"><nav class="b-nav" aria-label="Settings"><div class="b-nav-head"><h2 id="settings-title">Settings</h2></div>` +
      `<button type="button" class="b-nav-item" aria-current="page">Voice${icon("chevron")}</button></nav>` +
      `<section class="b-section" aria-labelledby="b-section-title"><button type="button" class="icon-button b-close" data-variant="quiet" data-v="settings-close" data-k="settings-close" aria-label="Close settings">${icon("x")}</button>` +
      `<header class="b-section-head"><h3 id="b-section-title" tabindex="-1">Voice</h3></header><div class="b-section-body" data-testid="settings-voice">${body}</div></section></div>`;
    CT.hydrate(d);
    if (key) $(`[data-k="${CSS.escape(key)}"]`, d)?.focus();
  }

  // Selecting a task: on the phone it opens the detail pane (section 9).
  function selectTask(task) {
    const { b } = taskOf(task);
    if (S.dict && S.dict.task !== task) stopDictation();
    if (S.memo.state === "loading") S.memo.state = "idle"; // a pending play is dropped
    S.sel = { bot: b.id, task };
    S.view = "detail";
  }

  // Applying a state from the address (section 15) --------------------------------------------------------

  function liveAt(task) {
    S.consent.add(callKey());
    const c = newCall(task, S.providerId);
    const id = `vs${c.attempt}`;
    S.relays.push({ id, attempt: c.attempt, state: "open", expiresAt: NOW + 1800 - 134, task });
    Object.assign(c, { state: "live", ready: true, capture: true, relayIds: [id], secs: 134, clockAt: NOW, expiresAt: NOW + 1800 - 134, voices: VOICES.slice(), canChange: true, voice: "Alloy" });
    S.io.micOpens += 1;
    S.call = c;
    return c;
  }

  function applyState() {
    const st = p("state");
    const line = p("line");
    const T = (h, m) => h * 3600 + m * 60;
    if (line === "here" || line === "elsewhere") {
      S.history.o1 = [
        ["user", "Is the media box still nearly full?"], ["assistant", "Yes. It's at 91 percent."], ["user", "Clear anything older than a month."],
        ["assistant", "I'll ask before deleting."], ["user", "Thanks."], ["assistant", "Waiting for your answer."],
      ].map(([role, text], i) => ({ id: `voice:vsA:${i + 1}`, role, text, ts: T(17, 31 + i), voice: true }));
      if (line === "here") S.held.vsA = 134;
    }
    if (line === "interleave") {
      // Two calls with the same times and a typed message between: grouped by id, not by order.
      S.history.o1 = [
        { id: "voice:vsA:1", role: "user", text: "First call, first turn.", ts: T(17, 31), voice: true },
        { id: "voice:vsB:1", role: "user", text: "Second call, first turn.", ts: T(17, 31), voice: true },
        { id: "m-typed", role: "user", text: "A typed message.", ts: T(17, 32), voice: false },
        { id: "voice:vsA:2", role: "assistant", text: "First call, reply.", ts: T(17, 33), voice: true },
        { id: "voice:vsB:2", role: "assistant", text: "Second call, reply.", ts: T(17, 33), voice: true },
      ];
      S.held.vsA = 95;
    }
    if (line === "noid")
      S.history.o1 = [
        { role: "user", text: "A spoken turn with no voice id.", ts: T(17, 31), voice: true },
        { role: "assistant", text: "Its reply, also without one.", ts: T(17, 32), voice: true },
      ];
    if (line === "empty") S.heldEmpty.o1 = [{ vs: "vsE", secs: 7 }];
    if (p("page") === "settings") setTimeout(openSettings, 0);
    if (p("shortcut")) setTimeout(() => shortcut(p("shortcut"), p("shortcutbot")), 0);
    if (!st) return;
    const t = S.sel.task;
    if (st === "consent") return setTimeout(() => gateCall(t), 0);
    if (st === "dictconsent") return setTimeout(() => openConsent("dict"), 0);
    if (st === "dictating" || st === "dictfail") {
      S.dictRoute = st === "dictfail" ? "gateway" : S.dictRoute || (deviceRoute().ok ? "device" : "gateway");
      S.consent.add(dictKey(S.dictRoute));
      if (st === "dictfail") S.flags.dictFail = true;
      return setTimeout(startDictation, 0);
    }
    if (st === "connecting") {
      S.consent.add(callKey());
      S.auto = false;
      return setTimeout(() => startCall(t, S.providerId), 0);
    }
    if (st === "refused") {
      S.call = { ...newCall(t, S.providerId), state: "refused", message: REFUSAL };
      return;
    }
    if (st === "failed") {
      const none = p("reason") === "none";
      S.call = {
        ...newCall(t, S.providerId),
        state: "failed",
        reason: none ? "No connection" : "The call ended unexpectedly",
        second: none ? `This device isn't connected to ${GATEWAY}. Start again when it reconnects.` : `${GATEWAY} ended the call: Realtime provider closed the session.`,
      };
      if (none) S.connected = false;
      return;
    }
    const c = liveAt(t);
    if (st === "muted") (c.muted = true), (c.capture = false);
    if (st === "speaking") (c.playing = true), (c.captions = [{ id: `voice:${c.relayIds[0]}:1`, role: "user", text: CAPTION, final: true, saved: false }]);
    if (st === "thinking") c.thinking = true;
    if (st === "transcript")
      (c.transcriptOpen = true),
        (c.captions = [
          { id: `voice:${c.relayIds[0]}:1`, role: "user", text: CAPTION, final: true, saved: true },
          { id: `voice:${c.relayIds[0]}:2`, role: "assistant", text: REPLY, final: false, saved: false },
        ]);
    if (st === "micgone") (c.capture = false), (c.micStopped = "unplugged"), (S.storedMic = "USB Microphone");
    if (st === "revoked") (c.capture = false), (c.micStopped = "revoked"), (S.mic = "denied");
    if (st === "background") (c.capture = false), (c.muted = true), (c.background = true);
    if (st === "limit") c.clockAt = c.expiresAt - 100;
    if (st === "ending") (c.state = "ending"), (c.capture = false), (S.relays[0].state = "closing"), (S.auto = false);
    if (st === "unconfirmed") {
      S.relays[0].state = "unconfirmed";
      leaveLine(c, false);
      S.call = null;
    }
    if (st === "lost" || st === "reconnected") {
      S.relays[0].state = "unconfirmed";
      S.relays[0].connGen = 1;
      leaveLine(c, true);
      stopMedia(c);
      S.call = { ...c, state: "lost", reason: "Connection lost" };
      S.connected = st === "reconnected";
      S.auto = false;
    }
    if (st === "second") {
      const other = t === "o1" ? "j1" : "o1";
      Object.assign(c, { task: other, bot: taskOf(other).b.id });
      S.relays[0].task = other;
      setTimeout(() => askSecond(t), 0);
    }
    if (["settings", "voicechange", "voicefail", "novoices", "langsaved"].includes(st)) setTimeout(openCallSettings, 0);
    if (st === "voicechange") setTimeout(() => ((S.auto = false), setVoice("Cedar")), 10);
    if (st === "voicefail") (S.flags.voiceFail = true), (c.voiceMsg = "Voice didn't change: Voice is not in this call's catalog; list the available voices first. Still using Alloy.");
    if (st === "novoices") (S.noVoices = true), (c.canChange = false), (c.voices = []);
    if (st === "langsaved") (S.prefs.saved.otto.lang = "es"), (S.prefs.notes.otto = `Saved for Otto on ${GATEWAY}, so your other devices use it too.`);
    if (st === "voicegone") c.voiceGone = "Ember";
  }

  // Siri, Shortcuts and the Action Button (section 5): the requested bot's task, the draft kept.
  function shortcut(kind, botId) {
    if (kind === "dict") {
      selectTask(S.sel.task);
      render();
      return pressMic();
    }
    if (kind === "action" && S.call && liveCall(S.call)) return hangup();
    const target = bot(botId || (kind === "action" ? "pip" : "juniper"));
    const task = target.tasks[0].id;
    selectTask(task);
    render();
    if (hasContent(task)) {
      notify("Voice chat not started.", "Start Voice Chat needs an empty message. Your draft is kept.", null, task);
      return render();
    }
    pressCall(task);
  }

  // The prototype's bar ------------------------------------------------------------------------------------

  function bar() {
    const extra = $("#proto-extra");
    if (!extra) return;
    const b = (k, l) => `<button type="button" data-bar="${k}">${esc(l)}</button>`;
    const t = (k, l) => `<button type="button" data-bar="${k}" aria-pressed="false">${esc(l)}</button>`;
    extra.innerHTML =
      `<span class="run-controls v-bar">` +
      b("speak", "Otto speaks") + b("caption", "A caption") + b("saved", "The turn is saved") +
      b("drop", "Drop connection") + b("expire", "Old session's end passes") + b("unplug", "Unplug microphone") + b("revoke", "Revoke access") +
      b("error", "Gateway ends the call") + b("background", "App to background") + b("botvoice", "Bot asks for a voice") + b("remote", "Another device saves") +
      t("closeFail", "Close fails") + t("createFail", "Start refused") + t("voiceFail", "Voice change fails") + t("prefFail", "Saving fails") + t("prefConflict", "Saving conflicts") + t("dictFail", "Dictation refused") + t("sendFail", "Send fails") +
      b("shortcut-dict", "Shortcut: Start Dictation") + b("shortcut-call", "Shortcut: Start Voice Chat with Juniper") + b("shortcut-action", "Action Button") + b("settings", "Settings") +
      `</span>`;
    extra.addEventListener("click", (event) => {
      const el = event.target.closest("[data-bar]");
      if (!el) return;
      const k = el.dataset.bar;
      const c = S.call;
      if (k === "speak" && c && c.ready) {
        ev("responseStarted");
        ev("playbackStart");
        later(() => ev("playbackEnd"), 600);
      }
      if (k === "caption" && c && c.ready) ev("caption", { id: `voice:${c.relayIds.at(-1)}:${c.captions.length + 1}`, role: "user", text: CAPTION, final: true });
      if (k === "saved" && c && c.captions.length) {
        const x = c.captions.at(-1);
        ev("history", { id: x.id, role: x.role, text: x.text });
      }
      if (k === "drop") ev("drop");
      if (k === "expire") ev("expire");
      if (k === "unplug") ev("trackEnded", { cause: "unplugged" });
      if (k === "revoke") ev("trackEnded", { cause: "revoked" });
      if (k === "error") ev("error", { message: "Realtime provider closed the session." });
      if (k === "background") ev("background");
      if (k === "botvoice") ev("botVoiceRequested");
      if (k === "remote") ev("prefRemote", { bot: "otto", field: "voice", value: "Sage" });
      if (k in S.flags) {
        S.flags[k] = !S.flags[k];
        el.setAttribute("aria-pressed", String(S.flags[k]));
      }
      if (k === "shortcut-dict") shortcut("dict");
      if (k === "shortcut-call") shortcut("call", "juniper");
      if (k === "shortcut-action") shortcut("action", "pip");
      if (k === "settings") openSettings();
    });
  }

  // Events from the page ---------------------------------------------------------------------------------------

  document.addEventListener("click", (event) => {
    const el = event.target.closest("[data-v], [data-v-bot], [data-v-task], [data-v-route], [data-v-sroute], [data-v-mic]");
    if (!el || el.closest("#proto-bar")) return;
    if (el.dataset.vBot) {
      const b = bot(el.dataset.vBot);
      const view = S.view;
      selectTask(b.tasks[0].id);
      // Desktop opens the bot's task; the phone shows its tasks to choose from.
      if (document.documentElement.dataset.width === "phone" || S.os === "iphone") S.view = view;
      return render();
    }
    if (el.dataset.vTask) {
      selectTask(el.dataset.vTask);
      render();
      return focusKey("input");
    }
    if (el.dataset.vRoute) {
      S.dictChoice = el.dataset.vRoute;
      return openConsent("dict");
    }
    if (el.dataset.vSroute) {
      S.dictRoute = el.dataset.vSroute;
      return renderSettings();
    }
    if (el.dataset.vMic) {
      S.storedMic = el.dataset.vMic;
      S.tempMic = null;
      return renderSettings();
    }
    const v = el.dataset.v;
    if (el.getAttribute("aria-disabled") === "true") return;
    const c = S.call;
    switch (v) {
      case "mic":
        if (S.suppressClick) return (S.suppressClick = false);
        return pressMic();
      case "call":
        return pressCall();
      case "send": {
        const t = S.sel.task;
        // The built handoff: what is in the field now is sent; later results of this dictation are dropped.
        if (S.dict && S.dict.task === t) {
          S.dict.frozen = true;
          stopDictation();
        }
        if (S.draining) S.draining.frozen = true;
        const text = S.drafts[t] || "";
        if (!hasContent(t)) return;
        S.drafts[t] = "";
        if (S.flags.sendFail) {
          // As built: the draft comes back and the shelf says so.
          S.drafts[t] = text;
          notify("Couldn't send.", "The gateway didn't accept the message. It's back in the field.", null, t);
        } else S.sent.push(text);
        return render();
      }
      case "stop-run":
        return (S.run = "idle"), render();
      case "consent-ok":
        return closeConsent(true);
      case "consent-cancel":
        return closeConsent(false);
      case "catalog-retry":
        S.catalog.reads += 1;
        return openConsent("unknown", S.pending || {});
      case "second-cancel":
        $("#confirm-dialog").close();
        return S.secondOpener?.focus();
      case "second-ok":
        $("#confirm-dialog").close();
        S.next = S.secondTarget;
        return hangup();
      case "mute": {
        if (!c) return;
        if (c.muted) {
          // Unmuting opens the microphone again: permission is checked first, and the track must start.
          return resumeCapture(c, () => {
            c.muted = false;
            c.background = false;
            c.unmuting = true; // said once the track has started
          });
        } else {
          c.muted = true;
          c.capture = false;
          say("Muted");
        }
        return render();
      }
      case "transcript":
        c.transcriptOpen = !c.transcriptOpen;
        return render();
      case "call-settings":
        return openCallSettings();
      case "call-settings-close":
        $("#call-settings-dialog").close();
        return focusKey("call-settings");
      case "voice-default":
        savePref(c.bot, "voice", null);
        c.voiceMsg = `${nameOf(c.bot)}'s next calls use the provider's default voice. This call keeps ${c.voice}.`;
        return render();
      case "hangup":
        return hangup();
      case "dismiss":
        S.call = null;
        hidePrompt();
        render();
        return focusKey("call");
      case "start-new": {
        const t = c.task;
        S.call = null;
        return gateCall(t);
      }
      case "cancel-start":
        return hangup();
      case "use-default":
        // For this call only: the stored choice stays.
        S.tempMic = "System Default";
        if (!S.consent.has(callKey(c.provider))) return resumeCapture(c, () => {});
        return createRelay(c);
      case "mic-back": {
        // Back on only by the person's choice, after permission and the device are checked again.
        return resumeCapture(c, () => {
          if (c.micStopped === "unplugged" && !S.tempMic && S.storedMic !== "System Default") S.tempMic = "System Default";
          c.micStopped = null;
        });
      }
      case "go-call":
        // Show moves focus to the band; it never captures by itself.
        selectTask(c.task);
        render();
        return focusBand();
      case "os-allow":
      case "os-deny": {
        const pr = S.os_prompt;
        hidePrompt();
        if (!pr) return;
        if (pr.kind === "speech") S.speech = v === "os-allow" ? "granted" : "denied";
        else S.mic = v === "os-allow" ? "granted" : "denied";
        return pr.then(v === "os-allow");
      }
      case "line":
        S.openLine = S.openLine === el.dataset.line ? null : el.dataset.line;
        return render();
      case "memo-play":
        return playMemo(el.dataset.memo);
      case "memo-speed": {
        const cur = memoSpeed().rate;
        const next = SPEEDS[(SPEEDS.indexOf(cur) + 1) % SPEEDS.length];
        if (!canWrite() || S.prefs.mode === "unknown") S.prefs.temp.pip = next;
        else savePref("pip", "speed", next);
        return render();
      }
      case "memo-retry":
        S.memo.state = "idle";
        return render();
      case "memo-open":
        S.io.opens.push(MEMO_ADDRESS);
        return;
      case "notice-dismiss":
        S.notices = S.notices.filter((n) => n.id !== el.dataset.notice);
        render();
        return focusKey("mic");
      case "notice-retry": {
        const n = S.notices.find((x) => x.id === el.dataset.notice);
        S.notices = S.notices.filter((x) => x !== n);
        render();
        return n?.retry?.();
      }
      case "settings":
        return openSettings();
      case "settings-close":
        $("#settings-dialog").close();
        return S.settingsOpener?.focus?.();
      case "allow-names":
        S.namesAsk = true;
        renderSettings();
        return focusKey("names-continue");
      case "names-cancel":
        S.namesAsk = false;
        return renderSettings();
      case "names-continue":
        S.namesAsk = false;
        return withMicPermission((ok) => {
          if (ok) {
            // Opened only to list the names; its tracks stop at once; nothing is sent.
            openMic(true);
            S.io.briefOpens += 1;
            S.namesShown = true;
          }
          renderSettings();
        });
      case "reset": {
        const id = el.dataset.bot;
        if (S.prefs.mode === "device") {
          S.prefs.saved[id] = { voice: null, speed: "1", lang: "" };
          return renderSettings();
        }
        return savePref(id, "voice", null);
      }
      case "back":
        S.view = "list";
        return render();
      default:
        return;
    }
  });

  document.addEventListener("change", (event) => {
    const v = event.target.dataset.v;
    const c = S.call;
    if (!c) return;
    if (v === "voice") return setVoice(event.target.value);
    if (v === "speed") return savePref(c.bot, "speed", event.target.value);
    // A language for new calls only: this call keeps what it asked for (section 7).
    if (v === "lang") return savePref(c.bot, "lang", event.target.value);
  });

  document.addEventListener("input", (event) => {
    if (!event.target.classList.contains("composer-input")) return;
    const t = S.sel.task;
    const had = hasContent(t);
    S.drafts[t] = event.target.value;
    S.caret[t] = [event.target.selectionStart, event.target.selectionEnd];
    if (had !== hasContent(t)) render();
  });
  document.addEventListener("selectionchange", () => {
    const a = document.activeElement;
    if (a && a.classList?.contains("composer-input")) S.caret[S.sel.task] = [a.selectionStart, a.selectionEnd];
  });

  // Radio groups: one tab stop; arrows, Home and End move and choose; Space chooses.
  document.addEventListener("keydown", (event) => {
    const r = event.target.closest?.('[role="radio"]');
    if (!r) return;
    const group = [...r.closest('[role="radiogroup"]').querySelectorAll('[role="radio"]:not([aria-disabled="true"])')];
    const i = group.indexOf(r);
    const to = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: group.length - 1 }[event.key];
    if (event.key === " ") {
      event.preventDefault();
      return r.click();
    }
    if (to === undefined) return;
    event.preventDefault();
    const next = group[(to + group.length) % group.length];
    const k = next.dataset.k;
    next.click();
    requestAnimationFrame(() => (k ? $(`[data-k="${CSS.escape(k)}"]`) : next)?.focus());
  });

  // ⌘D (Ctrl+D off the Mac): toggles; held past 400 ms, hold to talk (section 3).
  const command = (e) => (S.os === "mac" ? e.metaKey : e.ctrlKey);
  const reachable = () => canWrite() && Boolean($(".composer-input")) && !document.querySelector("dialog[open]") && S.view === "detail";
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.activeElement?.classList?.contains("composer-input")) {
      // The built picker handler first; then dictation.
      if (S.picker) {
        event.preventDefault();
        S.picker = false;
        return render();
      }
      if (S.dict) {
        event.preventDefault();
        return stopDictation();
      }
      return;
    }
    if (document.querySelector("dialog[open]")) return;
    if (event.key.toLowerCase() !== "d" || !command(event) || event.shiftKey || event.altKey) return;
    // The browser preview leaves ⌘D to its bookmark; the button works there.
    if (isWeb() || event.isComposing || !reachable()) return;
    event.preventDefault();
    if (event.repeat) return;
    if (S.dict) return stopDictation();
    pressMic();
    clearTimeout(S.holdTimer);
    S.holdTimer = setTimeout(() => (S.held = Boolean(S.dict)), 400);
  });
  document.addEventListener("keyup", (event) => {
    // Releasing either key ends a hold, whichever goes first.
    if (!["d", "D", "Meta", "Control"].includes(event.key)) return;
    clearTimeout(S.holdTimer);
    if (S.held && S.dict) stopDictation();
    S.held = false;
  });
  window.addEventListener("blur", () => {
    if (S.held && S.dict) stopDictation();
    S.held = false;
  });
  // Press and hold the microphone button: the same; a cancelled gesture stops its capture.
  document.addEventListener("pointerdown", (event) => {
    const el = event.target.closest('[data-v="mic"]');
    if (!el || el.getAttribute("aria-disabled") === "true" || S.dict) return;
    S.pressTimer = setTimeout(() => {
      S.suppressClick = true;
      pressMic();
      S.held = Boolean(S.dict);
    }, 400);
  });
  const endHold = () => {
    clearTimeout(S.pressTimer);
    if (S.held && S.dict) stopDictation();
    S.held = false;
  };
  document.addEventListener("pointerup", endHold);
  document.addEventListener("pointercancel", endHold);

  $("#consent-dialog").addEventListener("cancel", (e) => (e.preventDefault(), closeConsent(false)));
  $("#confirm-dialog").addEventListener("cancel", (e) => (e.preventDefault(), $("#confirm-dialog").close(), S.secondOpener?.focus()));
  $("#os-layer").addEventListener("cancel", (e) => e.preventDefault()); // a system prompt is answered, not escaped
  $("#call-settings-dialog").addEventListener("cancel", (e) => (e.preventDefault(), $("#call-settings-dialog").close(), focusKey("call-settings")));

  // For the checks: the same paths the bar takes, and the counters.
  window.voice = { S, ev, render, setVoice };

  applyState();
  render();
  document.addEventListener("DOMContentLoaded", bar);
  if (document.readyState !== "loading") bar();
})();
