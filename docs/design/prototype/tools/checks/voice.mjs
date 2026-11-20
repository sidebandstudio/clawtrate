// Behaviour checks for voice.html (docs/design/voice.md). The fixture records,
// plays, fetches and opens nothing: what it would have opened, sent, fetched,
// played or written is counted in `window.voice.S.io`, and the gateway's and
// the device's events are fired one at a time with `window.voice.ev`. Each part
// below is one of the design's rules; its lines fail without it.
// Run from the repository root:  node docs/design/prototype/tools/checks/voice.mjs
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("voice.html") + "?chrome=0&theme=light";
const b = await chromium.launch();
const out = [];
const check = (name, ok, extra = "") => out.push(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ` ${extra}` : ""}`);
let offDisk = 0;
const open = async (query = "", viewport = { width: 1440, height: 900 }) => {
  const p = await b.newPage({ viewport });
  p.on("pageerror", (e) => out.push("PAGEERROR " + e));
  p.on("request", (r) => {
    if (!r.url().startsWith("file:") && !r.url().startsWith("data:")) offDisk += 1;
  });
  await p.goto(base + (query ? "&" + query : ""));
  await p.waitForTimeout(120);
  return p;
};
const q = (p, fn, arg) => p.evaluate(fn, arg);
const text = (p, sel) => q(p, (s) => document.querySelector(s)?.textContent.replace(/\s+/g, " ").trim() ?? null, sel);
const has = async (p, sel, words) => ((await text(p, sel)) ?? "").includes(words);
const ev = (p, name, data = {}) => q(p, ([n, d]) => window.voice.ev(n, d), [name, data]);
const io = (p) => q(p, () => JSON.parse(JSON.stringify(window.voice.S.io)));
const call = (p) => q(p, () => (window.voice.S.call ? JSON.parse(JSON.stringify({ ...window.voice.S.call, relay: null })) : null));
const live = async (p) => {
  await p.waitForTimeout(60);
  return q(p, () => document.querySelector("#live").textContent);
};
const phase = (p) => text(p, '[data-testid="call-phase"]');
const wait = (p, ms = 80) => p.waitForTimeout(ms);
const click = async (p, sel) => {
  await p.click(sel, { force: true });
  await wait(p, 40);
};
const rowLabels = (p) => q(p, () => [...document.querySelectorAll(".composer-row > *")].map((x) => x.getAttribute("aria-label")).join("|"));

// 1. The full destination, and consent before any opening of the microphone ----------------------------

let p = await open("auto=0");
await click(p, '[data-v="call"]');
check("1 the consent sheet names the gateway and the provider in full", await q(p, () =>
  document.querySelector('[data-testid="dest-gateway"]').textContent === "Home gateway" && document.querySelector('[data-testid="dest-provider"]').textContent === "OpenAI Realtime Voice"));
check("1 the call's sentence, as the design says it", (await text(p, '[data-testid="consent-sentence"]')) ===
  "Your voice goes to Home gateway, which sends it to OpenAI Realtime Voice. The gateway can save finalized captions as text in this task. Clawtrate discards its audio buffers when capture or playback stops. The gateway and provider manage their own copies.");
let s = await io(p);
let c = null;
check("1 nothing opens or is created before consent", s.micOpens === 0 && s.creates.length === 0);
await click(p, '[data-v="consent-ok"]');
s = await io(p);
await ev(p, "capture");
await wait(p, 1200);
await ev(p, "create", { ok: true, provider: "openai" });
const opensBeforeReady = (await io(p)).micOpens;
await ev(p, "ready", { id: "vs1" });
s = await io(p);
check("1 after Start, create names the accepted provider and the microphone opens only after the matching reply and ready", s.creates[0].provider === "openai" && s.creates[0].capabilities.join() === "voice-selection" && opensBeforeReady === 0 && s.micOpens === 1 && s.appends === 0);
await ev(p, "capture");
await wait(p, 1200);
s = await io(p);
check("1 audio goes only to the ready relay whose destination was accepted", s.appends >= 1 && s.appendsUnauthorized === 0);
await p.close();

for (const [w, vp] of [["1440", { width: 1440, height: 900 }], ["390", { width: 390, height: 844 }]]) {
  p = await open(`auto=0&long=1&width=${w === "390" ? "phone" : "full"}`, vp);
  await click(p, '[data-v="call"]');
  check(`1 ${w}: long gateway and provider names show in full`, await q(p, () =>
    ["dest-gateway", "dest-provider", "consent-sentence"].every((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return el.scrollWidth <= el.clientWidth + 1 && getComputedStyle(el).textOverflow !== "ellipsis";
    }) && document.querySelector('[data-testid="dest-provider"]').textContent.includes("European data residency")));
  await p.keyboard.press("Escape");
  await click(p, '[data-v="mic"]');
  check(`1 ${w}: each dictation route's sentence wraps, never cut short`, await q(p, () =>
    [...document.querySelectorAll('[data-testid="route-sentence"]')].every((el) => getComputedStyle(el).whiteSpace !== "nowrap" && el.scrollWidth <= el.clientWidth + 1) &&
    document.querySelector("#consent-dialog").textContent.includes("gpt-4o-transcribe, European data residency")));
  await p.close();
}

p = await open("auto=0&seen=1");
await click(p, '[data-v="call"]');
check("1 an accepted destination isn't asked again", await q(p, () => !document.querySelector("#consent-dialog").open && window.voice.S.io.creates.length === 1));
await p.close();
p = await open("auto=0&seen=1&provider=openai-eu");
await click(p, '[data-v="call"]');
check("1 the same label under another provider id asks again", await q(p, () => document.querySelector("#consent-dialog").open && window.voice.S.io.creates.length === 0));
await p.close();

p = await open("auto=0&voice=unknown");
await click(p, '[data-v="call"]');
check("1 an unknown destination: Can't verify where your voice would go, with Retry", await q(p, () => {
  const d = document.querySelector("#consent-dialog");
  return d.open && d.querySelector("h2").textContent === "Can't verify where your voice would go" && Boolean(d.querySelector('[data-v="catalog-retry"]'));
}));
await click(p, '[data-v="catalog-retry"]');
s = await io(p);
check("1 …Retry reads the catalog again; nothing opens or is created", (await q(p, () => window.voice.S.catalog.reads)) === 2 && s.micOpens === 0 && s.creates.length === 0);
await p.close();

p = await open("auto=0&seen=1&drift=1");
await click(p, '[data-v="call"]');
await ev(p, "capture");
await ev(p, "create", { ok: true, provider: "xai" });
s = await io(p);
check("1 another provider than the one asked for: closed unused, nothing sent", s.closes.some((c) => c.why === "provider") && s.appends === 0);
check("1 …and the sheet asks again, for what the gateway chose", await q(p, () =>
  document.querySelector("#consent-dialog").open && document.querySelector('[data-testid="dest-provider"]').textContent === "xAI Realtime Voice" &&
  document.querySelector('[data-testid="drift"]').textContent === "Home gateway chose a different voice provider than it listed. Nothing was sent."));
await p.close();

p = await open("auto=0&seen=1");
await click(p, '[data-v="call"]');
await q(p, () => (window.voice.S.providerId = "openai-eu"));
await click(p, '[data-v="hangup"]');
await ev(p, "create", { ok: true, provider: "openai" });
await ev(p, "closeResult", { ok: true, id: "vs1" });
await click(p, '[data-v="call"]');
check("1 a retry after the destination changed passes the gate again", await q(p, () => document.querySelector("#consent-dialog").open));
await p.close();

for (const [os, words, action] of [
  ["mac", "Clawtrate can't use the microphone. Allow it in System Settings › Privacy & Security › Microphone.", "Open System Settings"],
  ["iphone", "Clawtrate can't use the microphone. Allow it in Settings › Clawtrate.", "Open Settings"],
  ["web", "This page can't use the microphone. Allow it in this browser's site settings.", ""],
]) {
  p = await open(`auto=0&seen=1&mic=prompt&os=${os}`);
  await click(p, '[data-v="call"]');
  check(`1 ${os}: the prompt is asked after Start, drawn as a labelled picture`, await q(p, (o) =>
    document.querySelector("#os-layer").open && document.querySelector(".v-pic-label").textContent.startsWith("Picture of the") &&
    document.querySelector('[data-testid="os-prompt"]').textContent === (o === "web" ? "This page wants to use your microphone." : "“Clawtrate” would like to access the microphone."), os));
  await click(p, '[data-v="os-deny"]');
  check(`1 ${os}: refused, in that platform's words, nothing opened`, await q(p, ([w, a]) =>
    document.querySelector('[data-testid="call-phase"]').textContent === w && window.voice.S.io.micOpens === 0 &&
    (a ? [...document.querySelectorAll(".call-band button")].some((x) => x.textContent === a) : true), [words, action]));
  await p.close();
}
p = await open("auto=0&seen=1&mic=denied&os=windows");
await click(p, '[data-v="call"]');
check("1 windows: a microphone that won't open, in Windows' words", (await phase(p)) === "Clawtrate couldn't open the microphone. Check Settings › Privacy & security › Microphone.");
await p.close();
p = await open("auto=0&seen=1&os=iphone&route=device&speech=prompt");
await click(p, '[data-v="mic"]');
check("1 iphone: Apple dictation asks for speech recognition separately", (await text(p, '[data-testid="os-prompt"]')) === "“Clawtrate” would like to access Speech Recognition.");
await click(p, '[data-v="os-deny"]');
check("1 …refused: the iPhone's words, and nothing listens", await q(p, () =>
  document.querySelector('[data-testid="notice"]').textContent.includes("Allow it in Settings › Clawtrate.") && !window.voice.S.dict));
await p.close();

p = await open("auto=0&state=live");
let before = (await io(p)).appends;
await ev(p, "trackEnded", {});
check("1 a track that ends: stopped, no cause invented", await q(p, () =>
  document.querySelector('[data-testid="mic-stopped"]').textContent === "Microphone stopped. No new audio is being sent." && document.querySelector('[data-testid="call-phase"]').textContent === "Microphone stopped"));
await wait(p, 1200);
check("1 …and nothing more is sent", (await io(p)).appends === before);
await p.close();
p = await open("auto=0&state=live");
await ev(p, "trackEnded", { cause: "revoked" });
before = (await io(p)).micOpens;
check("1 revoked: said as known", await has(p, '[data-testid="mic-stopped"]', "Microphone access was turned off."));
await click(p, '[data-v="mic-back"]');
check("1 …Turn microphone back on rechecks the permission and opens nothing", (await io(p)).micOpens === before && (await phase(p)) === "Microphone stopped");
await p.close();
p = await open("auto=0&state=micgone");
check("1 unplugged: the device named", await has(p, '[data-testid="mic-stopped"]', "USB Microphone was disconnected."));
await click(p, '[data-v="mic-back"]');
check("1 …back on only by choice, and Listening only once the track is live", (await phase(p)) === "Opening the microphone…");
await ev(p, "capture");
check("1 …then Listening", (await phase(p)) === "Listening");
await p.close();
p = await open("auto=0&state=muted");
await click(p, '[data-v="mute"]');
check("1 Unmute: not announced before the track is live", (await live(p)) !== "Unmuted" && (await phase(p)) === "Opening the microphone…");
await ev(p, "capture");
check("1 …then Unmuted", (await live(p)) === "Unmuted");
await p.close();
p = await open("auto=0&state=muted");
let priorOpens = (await io(p)).micOpens;
let priorAppends = (await io(p)).appends;
await q(p, () => window.voice.S.consent.clear());
await click(p, '[data-v="mute"]');
await ev(p, "capture");
await wait(p, 1200);
s = await io(p);
c = await call(p);
check("1 Unmute with expired consent opens no track and appends no frame", !c.capture && s.micOpens === priorOpens && s.appends === priorAppends && (await q(p, () => document.querySelector("#consent-dialog").open)));
await p.close();
p = await open("auto=0&state=micgone");
priorOpens = (await io(p)).micOpens;
priorAppends = (await io(p)).appends;
await q(p, () => window.voice.S.consent.clear());
await click(p, '[data-v="mic-back"]');
await ev(p, "capture");
await wait(p, 1200);
s = await io(p);
c = await call(p);
check("1 revoked destination keeps capture off", !c.capture && s.micOpens === priorOpens && s.appends === priorAppends);
await p.close();
p = await open("auto=0&seen=1&mic=missing");
await click(p, '[data-v="call"]');
check("1 the chosen microphone missing: never replaced silently", (await phase(p)) === "USB Microphone isn't connected.");
await click(p, '[data-v="use-default"]');
check("1 …Use System Default this time leaves the stored choice", await q(p, () => window.voice.S.storedMic === "USB Microphone" && window.voice.S.tempMic === "System Default"));
await p.close();
p = await open("page=settings&mic=prompt");
await wait(p);
await click(p, '[data-v="allow-names"]');
check("1 Settings: Allow first says the microphone opens for a moment; nothing opened yet", await q(p, () =>
  document.querySelector('[data-testid="names-explain"]').textContent === "To show your microphones' names, Clawtrate opens the microphone for a moment and closes it at once. Nothing is recorded or sent." && window.voice.S.io.micOpens === 0));
await click(p, '[data-v="names-continue"]');
await click(p, '[data-v="os-allow"]');
check("1 …after the system's Allow, the names, from one brief opening", await q(p, () =>
  window.voice.S.io.briefOpens === 1 && [...document.querySelectorAll('[aria-label="Microphone"] .b-choice-title')].map((x) => x.textContent).join() === "System Default,MacBook Pro Microphone,USB Microphone"));
await p.close();
p = await open("auto=0&state=background&os=iphone");
check("1 iphone to the background: muted, said why", await has(p, '[data-testid="call-note"]', "Muted when Clawtrate went to the background. Unmute to go on."));
await p.close();

// 2. A confirmed end before another call; a drop ends the call -----------------------------------------

p = await open("auto=0&state=live");
await click(p, '[data-v="hangup"]');
check("2 Hang up: media stops at once, Ending… until the gateway confirms", (await phase(p)) === "Ending…" && (await call(p)).capture === false && (await io(p)).closes.length === 1);
await ev(p, "closeResult", { ok: false });
check("2 an unconfirmed end is said as such, never as ended", (await live(p)) === "Ended on this device. Home gateway did not confirm the previous session ended." && (await has(p, '[data-testid="line-note"]', "Ended on this device. Home gateway did not confirm the previous session ended.")));
check("2 …and the next start waits, saying why", await q(p, () => {
  const el = document.querySelector('[data-v="call"]');
  return el.getAttribute("aria-disabled") === "true" && el.getAttribute("aria-description") === "The previous voice session may still be open on Home gateway. This connection cannot confirm that it ended.";
}));
await click(p, '[data-v="call"]');
check("2 …no create while the close is unconfirmed", (await io(p)).creates.length === 0);
await ev(p, "close", { id: "vs1" });
check("2 the relay's own close event releases it", await q(p, () => document.querySelector('[data-v="call"]').getAttribute("aria-disabled") !== "true" && !document.querySelector('[data-testid="line-note"]')));
await p.close();

p = await open("auto=0&state=live");
await click(p, '[data-v="hangup"]');
await ev(p, "closeResult", { ok: true });
check("2 a confirmed end: Voice chat ended", (await live(p)) === "Voice chat ended" && !(await q(p, () => document.querySelector(".call-band"))));
await p.close();

p = await open("auto=0&state=second");
await wait(p);
await click(p, '[data-v="second-ok"]');
await ev(p, "closeResult", { ok: false });
check("2 End and Chat after an unconfirmed close starts nothing", await q(p, () => window.voice.S.io.creates.length === 0 && !window.voice.S.call));
await p.close();
p = await open("auto=0&state=second");
await wait(p);
await click(p, '[data-v="second-ok"]');
check("2 End and Chat waits: no create while Ending…", (await io(p)).creates.length === 0);
await ev(p, "closeResult", { ok: true });
check("2 …after a confirmed end, the requested bot's call starts through the gate", await q(p, () => {
  const c = window.voice.S.call;
  return c && c.bot === "otto" && c.secs === 0 && window.voice.S.io.creates.length === 1 && window.voice.S.io.creates[0].sessionKey === "o1";
}));
await p.close();

p = await open("auto=0&seen=1");
await click(p, '[data-v="call"]');
await click(p, '[data-v="hangup"]');
await ev(p, "create", { ok: true, provider: "openai" });
await ev(p, "ready", { id: "vs1" });
s = await io(p);
check("2 a start cancelled before its answer: the late relay is closed at once, nothing attached", s.closes.some((c) => c.why === "cancelled") && !(await call(p)) && s.appends === 0);
check("2 …and the next start waits for that close", await q(p, () => document.querySelector('[data-v="call"]').getAttribute("aria-description") === "Ending the previous voice session…"));
await p.close();

p = await open("auto=0&state=live");
await ev(p, "drop");
before = (await io(p)).appends;
check("2 a drop: Voice chat failed, Connection lost, the microphone off, reconnecting", await q(p, () =>
  document.querySelector('[data-testid="call-phase"]').textContent === "Voice chat failed" && document.querySelector('[data-testid="call-reason"]').textContent === "Connection lost" &&
  document.querySelector('[data-testid="call-note"]').textContent === "Microphone off. Reconnecting to Home gateway…"));
check("2 …announced as a failure", (await live(p)) === "Voice chat failed: Connection lost");
check("2 …and the line keeps the time this device counted", await has(p, '[data-testid="call-line"]', "Voice chat · 2:14"));
await ev(p, "hello");
check("2 hello: Reconnected, the session not resumed, audio stopped at the drop", await q(p, () =>
  document.querySelector('[data-testid="call-note"]').textContent === "Reconnected to Home gateway. The voice session could not be resumed. This device stopped sending audio when it detected the drop." &&
  document.querySelector('[data-testid="call-blocked"]').textContent.startsWith("The previous voice session may still be open on Home gateway.")));
check("2 …a hello starts no media and announces no reconnected call", (await io(p)).creates.length === 0 && (await live(p)) === "Reconnected to Home gateway. The voice session could not be resumed." && (await io(p)).appends === before);
check("2 …and offers no new call while the old session may be open", await q(p, () => !document.querySelector('[data-v="start-new"]')));
await ev(p, "close", { id: "vs1" });
check("2 a close event from the old connection is not a release across the reconnect", await q(p, () => !document.querySelector('[data-v="start-new"]')));
before = (await io(p)).creates.length;
await ev(p, "expire");
await click(p, '[data-v="call"]');
check("2 after expiresAt, no new call without confirmation", (await io(p)).creates.length === before && (await q(p, () => document.querySelector('[data-v="call"]').getAttribute("aria-description"))) === "The previous voice session may still be open on Home gateway. This connection cannot confirm that it ended.");
check("2 expiry does not confirm release", (await io(p)).creates.length === before && !(await p.locator('[data-v="start-new"]').count()));
await click(p, '[data-v="dismiss"]');
await ev(p, "drop");
await ev(p, "hello");
check("2 …kept through Dismiss and another reconnection to the same gateway", (await q(p, () => document.querySelector('[data-v="call"]').getAttribute("aria-disabled"))) === "true");
await p.close();
p = await open("auto=0&seen=1&mic=prompt");
await click(p, '[data-v="call"]');
await ev(p, "drop");
await ev(p, "hello");
check("2 a drop while asking for the microphone: nothing was created, so nothing waits", await q(p, () => Boolean(document.querySelector('[data-v="start-new"]')) && window.voice.S.io.micOpens === 0));
await click(p, '[data-v="start-new"]');
await click(p, '[data-v="os-allow"]');
check("2 …Start a new voice chat: a new call, through the gate, with its own time", await q(p, () => window.voice.S.io.creates.length === 1 && window.voice.S.call.secs === 0 && window.voice.S.call.attempt === 2));
await p.close();
p = await open("auto=0&seen=1");
await click(p, '[data-v="call"]');
await ev(p, "drop");
await ev(p, "hello");
check("2 a create still unanswered at a drop stays unresolved: Start stays disabled", await q(p, () => !document.querySelector('[data-v="start-new"]') && document.querySelector('[data-testid="call-blocked"]').textContent === "The previous voice session may still be open on Home gateway. This connection cannot confirm that it ended."));
await p.close();
p = await open("auto=0&state=failed&reason=none");
check("2 F-411 No connection", (await text(p, '[data-testid="call-note"]')) === "This device isn't connected to Home gateway. Start again when it reconnects.");
await p.close();

// 3. The voice handshake before any word that it changed --------------------------------------------------

// The gateway's side of one change, each step its own event, matched by its returned identity.
const step = {
  requested: (p, voice) => ev(p, "voiceRequested", { changeId: "chg1", voiceSessionId: "vs1", voice, gen: 1 }),
  created: (p) => ev(p, "replacementCreate", { id: "vs1r", changeId: "chg1" }),
  ready: (p) => ev(p, "replacementReady", { id: "vs1r" }),
  closed: (p, ok = true) => ev(p, "originalClosed", { id: "vs1", ok }),
  applied: (p) => ev(p, "setApplied", { voiceSessionId: "vs1r", gen: 1 }),
};
p = await open("auto=0&state=settings");
await wait(p);
check("3 the voices offered are the call's, with no Default sentinel", await q(p, () => [...document.querySelectorAll('[data-v="voice"] option')].map((o) => o.value).join() === "Alloy,Cedar,Marin,Sage"));
await p.selectOption('[data-v="voice"]', "Alloy");
check("3 the same voice: nothing is sent", (await io(p)).sets.length === 0);
await p.selectOption('[data-v="voice"]', "Cedar");
await wait(p, 40);
c = await call(p);
check("3 set: pending, said, the active voice and the saved choice unchanged", (await io(p)).sets[0].voice === "Cedar" && c.voice === "Alloy" && (await q(p, () => window.voice.S.prefs.saved.otto.voice)) === null && (await text(p, '[data-testid="voice-note"]')) === "Changing to Cedar… The current reply may stop.");
await ev(p, "voiceRequested", { changeId: "chg1", voiceSessionId: "vs9", voice: "Cedar", gen: 1 });
check("3 a request for another session is not this setter's", (await io(p)).creates.length === 0);
await step.requested(p, "Cedar");
s = await io(p);
check("3 requested: one replacement, with its change id, the task and the language", s.creates.length === 1 && s.creates[0].voiceChangeId === "chg1" && s.creates[0].sessionKey === "o1" && s.creates[0].capabilities.join() === "voice-selection" && (await call(p)).voice === "Alloy");
await step.ready(p);
check("3 a ready before the create's reply is buffered, not acted on", (await io(p)).closes.length === 0);
await step.created(p);
s = await io(p);
check("3 …and taken once the replacement is admitted: the original's close requested", await q(p, () => window.voice.S.relays.some((r) => r.id === "vs1r" && r.state === "open")) && s.closes.at(-1).why === "voice change");
before = (await io(p)).appends;
await wait(p, 1200);
s = await io(p);
check("3 replacement ready without original close issues no complete or new output", s.completes.length === 0 && s.appends === before && !(await call(p)).playing);
await step.closed(p);
s = await io(p);
check("3 the original closed: complete with the replacement's id", s.completes.at(-1).outcome === "ready" && s.completes.at(-1).voiceSessionId === "vs1r" && (await call(p)).voice === "Alloy");
check("3 …complete alone changes nothing on screen", (await live(p)) !== "Voice changed to Cedar for this session.");
await ev(p, "setApplied", { voiceSessionId: "vs9", gen: 1 });
await ev(p, "setApplied", { voiceSessionId: "vs1r", gen: 2 });
check("3 foreign applied result cannot change voice or save", (await call(p)).voice === "Alloy" && (await io(p)).prefWrites.length === 0);
check("3 foreign applied is ignored", (await call(p)).voice === "Alloy" && (await io(p)).prefWrites.length === 0);
await step.applied(p);
check("3 applied: the voice changes, said once", (await call(p)).voice === "Cedar" && (await live(p)) === "Voice changed to Cedar for this session.");
check("3 …then saved: Saving… until confirmed", (await text(p, '[data-testid="kept-note"]')) === "Saving…" && (await q(p, () => window.voice.S.prefs.saved.otto.voice)) === null);
await ev(p, "prefOk");
check("3 …confirmed", (await text(p, '[data-testid="kept-note"]')) === "Saved for Otto on Home gateway, so your other devices use it too." && (await q(p, () => window.voice.S.prefs.saved.otto.voice)) === "Cedar");
await click(p, '[data-v="voice-default"]');
check("3 Default for future calls: clears the saved voice, keeps this call's", (await call(p)).voice === "Cedar" && (await io(p)).prefWrites.at(-1).value === null);
await p.close();

p = await open("auto=0&state=voicechange");
await wait(p, 100);
await step.requested(p, "Cedar");
await ev(p, "drop");
await ev(p, "hello");
await step.created(p);
await step.ready(p);
await step.applied(p);
check("3 drop before replacement ready keeps both admitted or unresolved relays blocked", await q(p, () =>
  window.voice.S.relays.filter((r) => r.state === "unconfirmed").length === 2 && document.querySelector('[data-v="call"]').getAttribute("aria-disabled") === "true" && !document.querySelector('[data-v="start-new"]')));
check("3 …no changed voice, no announcement of it, nothing saved", !(await live(p)).includes("Cedar") && (await q(p, () => window.voice.S.prefs.saved.otto.voice)) === null);
await p.close();
p = await open("auto=0&state=settings");
await wait(p);
await p.selectOption('[data-v="voice"]', "Marin");
await ev(p, "setRefused", { message: "A voice change is already in progress for this call" });
check("3 a refused set: the gateway's words, still the old voice", (await text(p, '[data-testid="voice-note"]')) === "Voice didn't change: A voice change is already in progress for this call. Still using Alloy." && (await call(p)).voice === "Alloy");
await p.selectOption('[data-v="voice"]', "Sage");
await step.requested(p, "Sage");
await ev(p, "replacementFailed", {});
s = await io(p);
check("3 a replacement that fails while the original works: complete failed, still the old voice", s.completes.at(-1).outcome === "failed" && (await call(p)).voice === "Alloy");
await ev(p, "botVoiceRequested");
s = await io(p);
check("3 a change the device didn't ask for: declined before any replacement", s.completes.at(-1).changeId === "bot-change" && s.completes.at(-1).outcome === "failed" && s.creates.length === 1 && (await has(p, '[data-testid="voice-note-band"]', "A voice change was requested. Clawtrate did not switch voices.")));
await p.close();
p = await open("auto=0&state=settings");
await wait(p);
await p.selectOption('[data-v="voice"]', "Cedar");
await step.requested(p, "Cedar");
await step.created(p);
await step.ready(p);
await step.closed(p, false);
check("3 the original's close unconfirmed: the call is interrupted, never 'Still using'", await q(p, () =>
  window.voice.S.call.state === "failed" && !document.body.textContent.includes("Still using") && window.voice.S.relays.filter((r) => r.state !== "closed").length === 2));
await p.close();
p = await open("auto=0&state=novoices");
await wait(p);
check("3 no voice changes on this call: said, no list", (await text(p, '[data-testid="voice-note"]')) === "Voice changes are unavailable for this call" && !(await q(p, () => document.querySelector('[data-v="voice"]'))));
await p.close();
p = await open("auto=0&state=voicesfail");
await wait(p);
check("3 the voices couldn't be read: said", (await text(p, '[data-testid="voice-note"]')) === "Couldn't read the voices for this call.");
await p.close();
p = await open("auto=0&state=voicegone");
check("3 a saved voice the call didn't get: Clawtrate did not request it", (await text(p, '[data-testid="voice-gone"]')) === "Clawtrate did not request Ember for this call");
await p.close();
p = await open("auto=0&state=settings");
await wait(p);
await p.selectOption('[data-v="voice"]', "Cedar");
await step.requested(p, "Cedar");
await step.created(p);
await step.ready(p);
await step.closed(p);
await step.applied(p);
await ev(p, "prefRefused", { message: "conflict" });
check("3 applied but not saved: both said, separately", (await call(p)).voice === "Cedar" && (await text(p, '[data-testid="kept-note"]')) === "Couldn't save: conflict. Otto's saved voice is still the provider's default voice. This call may differ.");
await p.close();

// 4. A call keeps its language; a language is for new calls -------------------------------------------------

p = await open("auto=0&state=settings");
await wait(p);
check("4 Language for new calls, with Provider default and no Auto-detect", await q(p, () =>
  document.querySelector('[data-v="lang"]').closest("label").textContent.startsWith("Language for new calls") &&
  document.querySelector('[data-v="lang"] option').textContent === "Provider default" && !document.body.textContent.includes("Auto-detect")));
await p.selectOption('[data-v="lang"]', "es");
await ev(p, "drop");
check("4 choosing a language changes nothing on this call and starts no session", await q(p, () =>
  window.voice.S.io.creates.length === 0 && window.voice.S.call.lang === "" && window.voice.S.prefs.pending.field === "lang"));
check("4 …and nothing announces it", !(await live(p)).includes("Español"));
await p.close();
p = await open("auto=0&state=settings");
await wait(p);
check("4 this call's language: provider default", (await text(p, '[data-testid="lang-note"]')) === "This call: provider default.");
await p.selectOption('[data-v="lang"]', "es");
await ev(p, "prefOk");
check("4 …still provider default after saving Español", (await text(p, '[data-testid="lang-note"]')) === "This call: provider default." && (await q(p, () => window.voice.S.prefs.saved.otto.lang)) === "es");
await p.close();
p = await open("auto=0&seen=1&state=langsaved");
await wait(p);
await q(p, () => {
  window.voice.S.call = null;
  window.voice.S.relays.forEach((r) => (r.state = "closed"));
  window.voice.render();
});
await click(p, '[data-v="call"]');
await ev(p, "create", { ok: true, provider: "openai" });
check("4 a new call asks for the saved language at its start", (await io(p)).creates.at(-1).language === "es");
await ev(p, "ready", { id: "vs2" });
await click(p, '[data-v="call-settings"]');
check("4 …and says only that it was requested", (await text(p, '[data-testid="lang-note"]')) === "This call: Español requested. The provider decides how it uses it.");
await p.close();

// 5. Phases, captions and the saved line from matching events and ids ---------------------------------------

p = await open("auto=0&seen=1");
await click(p, '[data-v="call"]');
check("5 Connecting until the create and its ready", (await phase(p)) === "Connecting to Otto…");
await ev(p, "create", { ok: true, provider: "openai" });
await ev(p, "ready", { id: "vs9" });
check("5 a ready of another relay is ignored", (await phase(p)) === "Connecting to Otto…");
await ev(p, "ready", { id: "vs1" });
check("5 a ready relay without a live track isn't Listening", (await phase(p)) === "Opening the microphone…" && (await live(p)) !== "Voice chat with Otto started");
await ev(p, "capture");
check("5 a live track and the ready relay: Listening, announced", (await phase(p)) === "Listening" && (await live(p)) === "Voice chat with Otto started");
await ev(p, "caption", { id: "voice:vs1:1", role: "user", text: "Hello", final: true });
check("5 a caption alone isn't speaking", (await phase(p)) === "Listening");
await ev(p, "responseStarted");
check("5 responseStarted: Thinking", (await phase(p)) === "Thinking");
await ev(p, "playbackStart");
check("5 local playback: Otto is speaking", (await phase(p)) === "Otto is speaking");
await ev(p, "playbackEnd");
check("5 drained: Listening", (await phase(p)) === "Listening");
await click(p, '[data-v="transcript"]');
check("5 the disclosure is named Hide transcript when open; captions are a silent log", await q(p, () =>
  document.querySelector('[data-v="transcript"]').getAttribute("aria-label") === "Hide transcript" &&
  document.querySelector(".call-transcript").getAttribute("role") === "log" && document.querySelector(".call-transcript").getAttribute("aria-live") === "off"));
await ev(p, "caption", { id: "voice:vsX:1", role: "user", text: "Another call's words", final: true });
check("5 another voice session's captions never touch this band", !(await has(p, ".call-transcript", "Another call's words")));
check("5 a final caption isn't saved before its history row", await q(p, () => document.querySelector('[data-testid="caption"]').dataset.saved === "false"));
await ev(p, "history", { id: "voice:vs1:1", role: "user", text: "Hello" });
check("5 …the matching history row marks it Saved", await q(p, () => document.querySelector('[data-testid="caption"]').dataset.saved === "true") && (await text(p, '[data-testid="captions-note"]')) === "Live captions. Saved turns appear in this task.");
await ev(p, "close", { id: "vs1" });
check("5 a close event ends the call; an ordinary close isn't put down to the schedule", (await live(p)) === "Voice chat ended" && !(await q(p, () => document.body.textContent.includes("30 minutes"))));
await p.close();

p = await open("auto=0&seen=1");
await click(p, '[data-v="call"]');
await ev(p, "create", { ok: false, message: 'Realtime voice provider "openai" is not configured.' });
check("5 a refused start: Couldn't start voice chat, the gateway's words, no ended call, no line", await q(p, () =>
  document.querySelector('[data-testid="call-phase"]').textContent === "Couldn't start voice chat" && document.querySelector('[data-testid="call-note"]').textContent === 'Realtime voice provider "openai" is not configured.' &&
  !document.body.textContent.includes("ended unexpectedly") && !document.querySelector('[data-testid="call-line"]')));
await p.close();

p = await open("auto=0&seen=1");
await click(p, '[data-v="call"]');
await ev(p, "capture");
await ev(p, "create", { ok: true, provider: "openai" });
await ev(p, "ready", { id: "vs1" });
await wait(p, 2200);
await click(p, '[data-v="hangup"]');
await ev(p, "closeResult", { ok: true });
check("5 a short silent call keeps its measured time, with no turns made up", await q(p, () => {
  const l = document.querySelector('[data-testid="call-line"]').textContent;
  return /^Voice chat · 0:0[1-3] · No saved turns found$/.test(l) && document.querySelector('[data-v="line"]').disabled;
}));
await p.close();

p = await open("line=interleave");
check("5 two calls at the same times and a typed message: one line per voice session", await q(p, () =>
  [...document.querySelectorAll('[data-testid="call-line"]')].map((x) => x.textContent).join("|") === "Voice chat · 1:35|Voice chat · 2 turns · 5:31–5:33 PM" && Boolean(document.querySelector('[data-testid="typed-turn"]'))));
await click(p, '[data-line="line-vsA"]');
check("5 …a line opens only its own session's turns", await q(p, () => {
  const t = document.querySelector("#line-vsA-turns").textContent;
  return t.includes("First call, first turn.") && t.includes("First call, reply.") && !t.includes("Second call");
}));
await p.close();
p = await open("line=noid");
check("5 spoken rows with no voice id: shown singly, marked spoken, no line", await q(p, () => document.querySelectorAll('[data-testid="spoken-turn"]').length === 2 && !document.querySelector('[data-testid="call-line"]')));
await p.close();
p = await open("line=elsewhere");
check("5 F-111 elsewhere: the saved turns' count and times", (await text(p, '[data-testid="call-line"]')) === "Voice chat · 6 turns · 5:31–5:36 PM");
await p.close();
p = await open("line=here");
check("5 F-111 this device's line: Voice chat · 2:14", (await text(p, '[data-testid="call-line"]')) === "Voice chat · 2:14");
await p.close();
p = await open("auto=0&state=limit");
check("5 the scheduled end, from expiresAt", /^This session is scheduled to end at \d+:\d\d PM\.$/.test(await text(p, '[data-testid="call-limit"]')));
await p.close();
p = await open("auto=0&state=live");
await ev(p, "error", { message: "Realtime provider closed the session." });
c = await call(p);
await click(p, '[data-v="dismiss"]');
await click(p, '[data-v="call"]');
check("2 error before terminal close stops media and cannot start the next call", !c.capture && !c.playing && (await io(p)).creates.length === 0 && (await io(p)).closes.some((x) => x.why === "error") && (await q(p, () => document.querySelector('[data-v="call"]').getAttribute("aria-disabled"))) === "true");
await ev(p, "closeResult", { ok: false, id: "vs1" });
check("2 …an error is reported as an error, and a failed close leaves the relay possibly open", (await q(p, () => document.querySelector('[data-v="call"]').getAttribute("aria-description"))) === "The previous voice session may still be open on Home gateway. This connection cannot confirm that it ended.");
await p.close();
p = await open("auto=0&state=failed&reason=error");
check("2 F-411 the call ended unexpectedly: the gateway reported an error", (await text(p, '[data-testid="call-note"]')) === "Home gateway reported an error: Realtime provider closed the session.");
await p.close();

// 6. The built composer: its row, content rule, caret, edits, keys and send -----------------------------------

p = await open();
check("6 the built row: Attach, field, microphone, voice chat, Send", (await rowLabels(p)) === "Attach files|Message Otto|Start voice input|Start voice chat|Send");
check("6 the desktop label and shortcut", (await q(p, () => document.querySelector('[data-v="mic"]').title)) === "Start voice input (⌘D)");
await p.close();
p = await open("os=iphone");
check("6 iPhone: Start dictation", (await q(p, () => document.querySelector('[data-v="mic"]').getAttribute("aria-label"))) === "Start dictation");
await p.close();
p = await open("run=running");
check("6 during a run, the buttons come before Stop and Send", (await rowLabels(p)) === "Attach files|Steer Otto|Start voice input|Start voice chat|Stop Otto|Steer this turn");
await p.close();
for (const q2 of ["files=pending", "files=refused", "token=slash", "token=mention"]) {
  p = await open(q2);
  check(`6 ${q2}: the composer isn't empty, so no voice chat button`, await q(p, () => !document.querySelector('[data-v="call"]')));
  await p.close();
}
p = await open("auto=0&run=running&state=live");
await click(p, '[data-v="stop-run"]');
check("6 Stop stops the run and leaves the call", (await call(p)).state === "live");
await p.close();

p = await open("auto=0&seen=1&route=device");
await p.click(".composer-input");
await p.keyboard.type("Before after");
await q(p, () => document.querySelector(".composer-input").setSelectionRange(7, 7));
await wait(p, 40);
await click(p, '[data-v="mic"]');
await ev(p, "dictPartial", { text: "check the" });
check("6 words not yet final stay out of the field; the waveform stays while only they exist", await q(p, () =>
  document.querySelector(".composer-input").value === "Before after" && document.querySelector('[data-testid="partial"]').textContent === "Not final yet: check the"));
await ev(p, "dictFinal", { text: "Check the backup logs too." });
check("6 final words go in at the caret", (await q(p, () => document.querySelector(".composer-input").value)) === "Before Check the backup logs too. after");
await p.click(".composer-input");
await p.keyboard.press("End");
await p.keyboard.type(" My correction");
await ev(p, "dictFinal", { text: "Second." });
check("6 …after every edit made since", (await q(p, () => document.querySelector(".composer-input").value)) === "Before Check the backup logs too. after My correction Second.");
await p.keyboard.press("Escape");
check("6 Escape stops dictation and keeps every edit", await q(p, () => !window.voice.S.dict && document.querySelector(".composer-input").value.includes("My correction")) && (await live(p)) === "Dictation stopped. The text is in your message.");
await p.close();

p = await open("auto=0&seen=1&route=device");
await click(p, '[data-v="mic"]');
await click(p, '[data-v="mic"]');
check("6 a dictation with no final words: Dictation stopped.", (await live(p)) === "Dictation stopped.");
await p.close();

p = await open("auto=0&seen=1&route=device&picker=1");
await click(p, '[data-v="mic"]');
await p.focus(".composer-input");
await p.keyboard.press("Escape");
check("6 Escape closes the picker first", await q(p, () => !document.querySelector('[data-testid="composer-menu"]') && Boolean(window.voice.S.dict)));
await p.keyboard.press("Escape");
check("6 …then stops dictation", await q(p, () => !window.voice.S.dict));
await p.close();

p = await open("auto=0&seen=1&route=device");
await click(p, '[data-v="mic"]');
await click(p, '[data-v-bot="juniper"]');
await ev(p, "dictFinal", { text: "Late words." });
check("6 a late result after a task change is dropped, in both tasks", await q(p, () => !window.voice.S.drafts.j1 && !window.voice.S.drafts.o1 && !window.voice.S.dict));
await p.close();

p = await open("auto=0&seen=1&route=gateway&dictdrift=1");
await click(p, '[data-v="mic"]');
await ev(p, "dictCreate", { sessionId: "ts1", provider: "deepgram-live" });
await ev(p, "dictReady", { sessionId: "ts1" });
await wait(p, 1100);
s = await io(p);
check("1 different transcription provider closes unused, with zero opens and appends", s.closes.some((x) => x.kind === "transcription" && x.why === "provider") && s.micOpens === 0 && s.appends === 0 && (await q(p, () => document.querySelector("#consent-dialog").textContent.includes("Deepgram Live Transcription"))));
await p.close();

p = await open("auto=0&seen=1&route=gateway");
await click(p, '[data-v="mic"]');
await ev(p, "dictReady", { sessionId: "ts1" });
await wait(p, 1200);
check("6 gateway dictation sends nothing before its ready", (await io(p)).appends === 0 && (await io(p)).micOpens === 0 && (await has(p, '[data-testid="listening"]', "Connecting to Home gateway…")) && (await io(p)).creates[0].provider === "openai-transcribe");
await ev(p, "dictCreate", { sessionId: "ts1", provider: "openai-transcribe" });
await ev(p, "dictReady", { sessionId: "ts1" });
await wait(p, 1100);
check("6 …then sends, with consent", (await io(p)).appends >= 1 && (await io(p)).appendsUnauthorized === 0);
await ev(p, "dictFinal", { text: "First." });
await click(p, '[data-v="mic"]');
await ev(p, "dictFinal", { text: "Drained." });
check("6 an ordinary stop closes once and takes the drained final words", await q(p, () => document.querySelector(".composer-input").value === "First. Drained." && window.voice.S.io.closes.filter((c) => c.kind === "transcription").length === 1));
await ev(p, "dictFinal", { text: "" });
check("6 an empty final envelope is ignored", (await q(p, () => document.querySelector(".composer-input").value)) === "First. Drained.");
await click(p, '[data-v="send"]');
await ev(p, "dictFinal", { text: "Too late." });
check("6 after Send, later results of that dictation are dropped", await q(p, () => window.voice.S.sent[0] === "First. Drained." && document.querySelector(".composer-input").value === ""));
await p.close();

p = await open("auto=0&seen=1&route=gateway");
await click(p, '[data-v="mic"]');
await ev(p, "dictCreate", { sessionId: "ts1", provider: "openai-transcribe" });
await ev(p, "dictReady", { sessionId: "ts1" });
await ev(p, "dictFinal", { text: "Kept." });
await ev(p, "drop");
check("6 a lost connection keeps the draft and says so", await q(p, () => document.querySelector(".composer-input").value === "Kept." && document.querySelector('[data-testid="notice"]').textContent.includes("Gateway connection lost.")));
await p.close();

p = await open("auto=0&draft=Keep%20me");
await q(p, () => (window.voice.S.flags.sendFail = true));
await click(p, '[data-v="send"]');
check("6 a failed send brings the draft back, with the shelf's notice", await q(p, () => document.querySelector(".composer-input").value === "Keep me" && document.querySelector('[data-testid="notice"]').textContent.includes("Couldn't send.")));
await p.close();

p = await open("auto=0&seen=1&route=device");
await p.focus(".composer-input");
await p.keyboard.down("Meta");
await p.keyboard.down("d");
await wait(p, 480);
check("6 ⌘D held: dictating", await q(p, () => Boolean(window.voice.S.dict)));
await p.keyboard.up("Meta");
await wait(p, 40);
check("6 …releasing the modifier first ends the hold", await q(p, () => !window.voice.S.dict));
await p.keyboard.up("d");
await p.close();
p = await open("auto=0&seen=1&route=device");
await p.dispatchEvent('[data-v="mic"]', "pointerdown");
await wait(p, 480);
check("6 a press held on the microphone: dictating", await q(p, () => Boolean(window.voice.S.dict)));
await p.dispatchEvent('[data-v="mic"]', "pointercancel");
await wait(p, 40);
check("6 …a cancelled pointer stops it", await q(p, () => !window.voice.S.dict));
await p.close();
p = await open("auto=0&seen=1&route=device&os=web");
await p.focus(".composer-input");
await p.keyboard.press("Meta+d");
check("6 the web preview leaves ⌘D to the browser; the button has no shortcut", await q(p, () => !window.voice.S.dict && document.querySelector('[data-v="mic"]').title === "Start voice input"));
await p.close();

p = await open("auto=0&shortcut=call&shortcutbot=juniper");
await wait(p);
check("6 Start Voice Chat with Juniper opens Juniper's task, never Otto's", await q(p, () => window.voice.S.sel.task === "j1" && document.querySelector("#consent-dialog").open));
await p.close();
p = await open("auto=0&shortcut=call&shortcutbot=otto&draft=Hello");
await wait(p);
check("6 a shortcut on a task with a draft keeps the draft and starts nothing", await q(p, () =>
  window.voice.S.drafts.o1 === "Hello" && window.voice.S.io.creates.length === 0 && !document.querySelector("#consent-dialog").open &&
  document.querySelector('[data-testid="notice"]').textContent.includes("Start Voice Chat needs an empty message. Your draft is kept.")));
await p.close();
p = await open("auto=0&state=live&task=p1");
await q(p, () => window.voice.render());
await q(p, () => document.querySelector("#proto-extra")?.querySelector('[data-bar="shortcut-action"]')?.click());
await q(p, () => {
  if (!document.querySelector("#proto-extra")) window.voice.S.call && document.querySelector('[data-v="hangup"]').click();
});
check("6 the Action Button during a call hangs up through Hang up", (await phase(p)) === "Ending…");
await p.close();

// 7. A memo only on Play, for that item; no text joined ----------------------------------------------------

p = await open("auto=0&bot=pip");
await p.hover('[data-v="memo-play"]');
check("7 nothing downloads at render or on hover", (await io(p)).downloads === 0);
await click(p, '[data-v="memo-play"]');
check("7 Play asks for this item once", (await io(p)).downloads === 1 && (await q(p, () => document.querySelector('[data-v="memo-play"]').getAttribute("aria-label"))) === "Loading voice memo");
await ev(p, "memoAnswer");
check("7 returned bytes play, with no HTTP request", (await io(p)).plays === 1 && (await io(p)).hostFetches === 0);
check("7 no text joined; no highlighting", (await text(p, '[data-testid="memo-note"]')) === "No text came with this recording." && (await text(p, '[data-testid="no-highlight"]')) === "Words aren't highlighted: the gateway gives no timing for each word.");
await q(p, () => window.voice.S.consent.add("gw-7f3a|call|openai|OpenAI Realtime Voice"));
await click(p, '[data-v="call"]');
check("7 a call pauses the memo", (await q(p, () => window.voice.S.memo.state)) === "paused");
await click(p, '[data-v="hangup"]');
check("7 …and ending it doesn't resume it", (await q(p, () => window.voice.S.memo.state)) === "paused" && (await io(p)).plays === 1);
await p.close();
for (const [kind, words, fetches] of [
  ["grant", null, 1],
  ["expired", "Clawtrate didn't fetch this voice memo: Home gateway's answer isn't a download it fetches by itself.", 0],
  ["wrongroute", "Clawtrate didn't fetch this voice memo: Home gateway's answer isn't a download it fetches by itself.", 0],
  ["redirect", "Couldn't load the voice memo: the download tried to redirect, which Clawtrate doesn't follow.", 1],
  ["big", "This voice memo is larger than 5 MiB, so Clawtrate can't play it here.", 0],
]) {
  p = await open(`auto=0&bot=pip&memo=${kind}`);
  await click(p, '[data-v="memo-play"]');
  await ev(p, "memoAnswer");
  s = await io(p);
  check(`7 ${kind}: ${words ? "not played, said why" : "the host fetches the grant, then plays"}`, s.hostFetches === fetches && (words ? s.plays === 0 && (await text(p, '[data-testid="memo-error"]')) === words : s.plays === 1));
  await p.close();
}
p = await open("auto=0&bot=pip&memo=fail");
await click(p, '[data-v="memo-play"]');
await ev(p, "memoAnswer");
await click(p, '[data-v="memo-retry"]');
check("7 Try again returns to Play and asks for nothing until Play", (await io(p)).downloads === 1 && (await q(p, () => document.querySelector('[data-v="memo-play"]').getAttribute("aria-label"))) === "Play voice memo");
await p.close();
p = await open("auto=0&bot=pip");
await click(p, '[data-v="memo-play"]');
await click(p, '[data-v-bot="otto"]');
await ev(p, "memoAnswer");
check("7 a play still waiting is dropped when the task changes", (await io(p)).plays === 0);
await p.close();
p = await open("bot=pip&memo=address");
check("7 an address: the full address as text, with the leaving words; nothing fetched", await q(p, () =>
  document.querySelector('[data-testid="memo-address"]').textContent === "https://media.example.net/pip/route-saturday.mp3" && document.querySelector("#memo-leave").textContent === "Opens in your browser." &&
  !document.querySelector('[data-testid="memo"] a, [data-v="memo-play"]') && window.voice.S.io.downloads === 0));
await click(p, '[data-v="memo-open"]');
check("7 …opened once, outside the app, with that address", (await io(p)).opens.join() === "https://media.example.net/pip/route-saturday.mp3");
await p.close();
p = await open("bot=pip&memo=address&os=iphone");
check("7 iphone: Open outside Clawtrate", (await text(p, '[data-v="memo-open"]')) === "Open outside Clawtrate" && (await text(p, "#memo-leave")) === "Opens outside Clawtrate.");
await p.close();
p = await open("bot=pip&memo=scheme");
check("7 another scheme: text only, no button", await q(p, () => !document.querySelector('[data-v="memo-open"]') && document.querySelector('[data-testid="memo-address"]').textContent.startsWith("ftp://")));
await p.close();
p = await open("bot=pip&memo=nohttp&os=iphone");
check("7 a grant on the iPhone: not played yet, said why", (await has(p, '[data-testid="memo"]', "can't be played on this iPhone yet")) && (await io(p)).downloads === 0);
await p.close();
p = await open("bot=pip&memo=two");
check("7 two clips and an attachment in one run: no text joined to either", await q(p, () =>
  document.querySelectorAll('[data-testid="memo"]').length === 2 && [...document.querySelectorAll('[data-testid="memo-note"]')].every((x) => x.textContent === "No text came with this recording.") &&
  !document.body.textContent.includes("made from")));
await p.close();
p = await open("bot=pip&access=read");
await click(p, '[data-v="memo-speed"]');
check("7 read-only: the memo's speed is for now, on this device, with no write", (await text(p, '[data-testid="memo-speed-note"]')) === "1.25× for now, on this device." && (await io(p)).prefWrites.length === 0);
await p.close();

// 8. The phone's walk, dialogs, choices, focus and announcements ---------------------------------------------

const phone = { width: 390, height: 844 };
p = await open("auto=0&width=phone&state=live", phone);
await click(p, '[data-v="back"]');
await click(p, '[data-v-bot="juniper"]');
check("8 phone: choosing a bot shows its tasks", await q(p, () => document.querySelector(".shell").dataset.view === "list" && Boolean(document.querySelector('[data-v-task="j1"]'))));
check("8 phone: the call shows in the list", await q(p, () => [...document.querySelectorAll('[data-testid="rail-preview"]')].some((x) => x.textContent === "In a voice chat · Microphone on")));
await click(p, '[data-v-task="j1"]');
check("8 phone: choosing a task opens it", await q(p, () => document.querySelector(".shell").dataset.view === "detail" && window.voice.S.sel.task === "j1"));
check("8 …where the call is still shown, with Show", (await text(p, '[data-testid="elsewhere-call"]')) === "In a voice chat with Otto · Microphone on Show");
before = (await io(p)).micOpens;
await click(p, '[data-v="go-call"]');
await wait(p, 40);
check("8 Show opens the call's task and moves focus to the band; it captures nothing", await q(p, () => window.voice.S.sel.task === "o1" && document.activeElement.classList.contains("call-band")) && (await io(p)).micOpens === before);
check("8 phone: the four actions share one row under the microphone mark", await q(p, () => {
  const bs = [...document.querySelectorAll(".call-row .call-actions > .button")];
  const mark = document.querySelector(".call-mic").getBoundingClientRect();
  const tops = new Set(bs.map((x) => Math.round(x.getBoundingClientRect().top)));
  return bs.map((x) => x.textContent).join() === "Mute,Transcript,Settings,Hang up" && tops.size === 1 && bs[0].getBoundingClientRect().top >= mark.bottom - 1;
}));
check("8 phone: the band's controls are 44 px tall", await q(p, () => [...document.querySelectorAll(".call-band button")].every((x) => x.getBoundingClientRect().height >= 44)));
check("8 phone: the composer's two buttons have a 44 px hit area", await q(p, () =>
  ["mic", "call"].every((v) => {
    const el = document.querySelector(`[data-v="${v}"]`);
    const r = el.getBoundingClientRect();
    const cx = Math.floor(r.left + r.width / 2);
    const cy = Math.floor(r.top + r.height / 2);
    return [[0, -22], [0, 21], [-22, 0], [21, 0]].every(([dx, dy]) => el.contains(document.elementFromPoint(cx + dx, cy + dy)));
  })));
await click(p, '[data-v="hangup"]');
check("8 phone: Hang up from there", (await phase(p)) === "Ending…");
await p.close();

p = await open("auto=0&state=live");
await p.focus('[data-v="mute"]');
await p.keyboard.press("Tab");
const order = [await q(p, () => document.activeElement.dataset.k)];
for (let i = 0; i < 2; i++) {
  await p.keyboard.press("Tab");
  order.push(await q(p, () => document.activeElement.dataset.k));
}
check("8 the band's actions in reading order", order.join() === "transcript,call-settings,hangup", order.join());
await p.focus('[data-v="mute"]');
await ev(p, "caption", { id: "voice:vs1:1", role: "user", text: "Hi", final: false });
await ev(p, "responseStarted");
check("8 an update keeps focus where it was", (await q(p, () => document.activeElement.dataset.k)) === "mute");
await p.click(".composer-input");
await p.keyboard.type("abc def");
await q(p, () => document.querySelector(".composer-input").setSelectionRange(3, 3));
await ev(p, "playbackStart");
check("8 …and the field's caret", await q(p, () => document.activeElement.classList.contains("composer-input") && document.activeElement.selectionStart === 3));
await click(p, '[data-v="call-settings"]');
check("8 the call's settings are a modal dialog, focus inside", await q(p, () => document.querySelector("#call-settings-dialog").open && document.querySelector("#call-settings-dialog").contains(document.activeElement)));
await p.keyboard.press("Escape");
await wait(p, 40);
check("8 …Escape closes it and returns focus to Settings", await q(p, () => !document.querySelector("#call-settings-dialog").open && document.activeElement.dataset.k === "call-settings"));
await p.close();

p = await open("auto=0&state=dictconsent");
await wait(p);
check("8 the route choice: one tab stop", await q(p, () => [...document.querySelectorAll('#consent-dialog [role="radio"]')].filter((x) => x.tabIndex === 0).length === 1));
await p.focus('[data-k="route-device"]');
await p.keyboard.press("ArrowDown");
await wait(p, 40);
check("8 …ArrowDown moves and chooses", await q(p, () => document.activeElement.dataset.k === "route-gateway" && document.activeElement.getAttribute("aria-checked") === "true"));
await p.keyboard.press("Home");
await wait(p, 40);
check("8 …Home goes back to the first", await q(p, () => document.activeElement.dataset.k === "route-device" && document.activeElement.getAttribute("aria-checked") === "true"));
await p.close();
p = await open("page=settings");
await wait(p);
await p.focus('[data-k="mic-System Default"]');
await p.keyboard.press("ArrowRight");
await wait(p, 40);
check("8 Settings: the microphone group takes arrows too", await q(p, () => window.voice.S.storedMic === "MacBook Pro Microphone" && document.activeElement.getAttribute("aria-checked") === "true"));
await p.close();

// 9. Supplied values as text; Saved only once confirmed -------------------------------------------------------

p = await open("auto=0&inject=1&state=transcript");
check("9 a markup-shaped name and caption stay text: shown literally, no element made", await q(p, () =>
  document.querySelectorAll("[data-inject]").length === 0 && document.body.textContent.includes('<b data-inject="name">Otto</b>') && document.body.textContent.includes('<s data-inject="caption">')));
await click(p, '[data-v="call-settings"]');
check("9 …and a voice", await q(p, () => document.querySelectorAll("[data-inject]").length === 0 && [...document.querySelectorAll('[data-v="voice"] option')].some((o) => o.textContent === '<i data-inject="voice">Ember</i>')));
await p.close();
p = await open("auto=0&inject=1&state=refused");
check("9 …and a refusal", await q(p, () => document.querySelectorAll("[data-inject]").length === 0 && document.querySelector('[data-testid="call-note"]').textContent.startsWith('<u data-inject="refusal">')));
await p.close();
p = await open("auto=0&state=settings");
await wait(p);
await p.selectOption('[data-v="speed"]', "1.25");
check("9 a speed: Saving… until confirmed", (await text(p, '[data-testid="kept-note"]')) === "Saving…" && (await q(p, () => window.voice.S.prefs.saved.otto.speed)) === "1");
await ev(p, "prefConflict", { remote: { lang: "fr" } });
s = await io(p);
check("9 a conflict: read again, only this field written again, the other device's kept", s.prefWrites.length === 2 && s.prefWrites[1].retry && s.prefWrites[1].field === "speed" && s.prefWrites[1].expected.lang === "fr");
await ev(p, "prefOk");
check("9 …confirmed, both values kept", await q(p, () => window.voice.S.prefs.saved.otto.speed === "1.25" && window.voice.S.prefs.saved.otto.lang === "fr"));
await p.selectOption('[data-v="speed"]', "2");
await ev(p, "prefRefused", { message: "the gateway refused the write" });
check("9 a refusal keeps the confirmed value and says so", (await text(p, '[data-testid="kept-note"]')) === "Couldn't save: the gateway refused the write. Otto's saved speed is still 1.25×.");
await ev(p, "prefRemote", { bot: "otto", field: "voice", value: "Sage" });
check("9 a change from another device is for the next call; this call's voice stays", (await call(p)).voice === "Alloy" && (await text(p, '[data-testid="kept-note"]')) === "Changed on another device: voice Sage from Otto's next call.");
await p.close();
p = await open("auto=0&state=settings&prefs=unknown");
await wait(p);
await p.selectOption('[data-v="speed"]', "1.5");
check("9 unreadable settings stay unknown: said, nothing written", (await text(p, '[data-testid="kept-note"]')) === "Couldn't read Otto's saved voice settings on Home gateway, so changes aren't saved." && (await io(p)).prefWrites.length === 0);
await p.close();
p = await open("auto=0&state=settings&prefs=none");
await wait(p);
await p.selectOption('[data-v="speed"]', "1.5");
check("9 a confirmed no_durable_identity: kept on this device", (await text(p, '[data-testid="kept-note"]')) === "Kept on this device for Otto." && (await io(p)).prefWrites.length === 0);
await p.close();
p = await open("page=settings&access=read");
await wait(p);
check("9 read-only Settings: nothing to write is offered", await q(p, () =>
  [...document.querySelectorAll('#settings-dialog [data-v="reset"]')].every((x) => x.getAttribute("aria-disabled") === "true" && x.getAttribute("aria-description") === "Needs more access") &&
  document.querySelector("#settings-dialog").textContent.includes("Dictation and voice chat need more access on this connection.")));
await p.close();
p = await open("access=read");
check("read-only: the built access bar, no voice buttons", await q(p, () =>
  document.querySelector("#composer").textContent.includes("Read-only. You can follow Otto's work here. Approvals and questions aren't shown on this connection.") && !document.querySelector('[data-v="mic"], [data-v="call"]')));
await p.close();
for (const [voice, words] of [
  ["none", "Voice chat isn't set up on Home gateway."],
  ["direct", "Home gateway's voice provider talks to apps directly, which Clawtrate doesn't do."],
]) {
  p = await open(`voice=${voice}`);
  check(`voice=${voice}: disabled, saying "${words}"`, await q(p, (w) => document.querySelector('[data-v="call"]').getAttribute("aria-description") === w, words));
  await p.close();
}
p = await open("os=remote");
check("a page over plain http: both buttons disabled with the reason", await q(p, () =>
  ["mic", "call"].every((v) => document.querySelector(`[data-v="${v}"]`).getAttribute("aria-disabled") === "true")));
await p.close();

// Widths, themes, motion, the walk with answers, and the gallery ------------------------------------------------

const widths = [["full", { width: 1440, height: 900 }], ["1100", { width: 1100, height: 800 }], ["800", { width: 800, height: 800 }], ["phone", { width: 390, height: 844 }]];
for (const theme of ["light", "dark"]) {
  let bad = [];
  for (const [w, vp] of widths) {
    for (const st of ["state=transcript", "state=settings", "state=lost", "state=reconnected", "state=dictating", "bot=pip&memo=address", "state=consent&long=1", "page=settings"]) {
      const pg = await b.newPage({ viewport: vp });
      pg.on("pageerror", (e) => out.push("PAGEERROR " + e));
      await pg.goto(pageUrl("voice.html") + `?chrome=0&auto=0&theme=${theme}&width=${w}&${st}`);
      await pg.waitForTimeout(120);
      if (!(await q(pg, () => document.documentElement.scrollWidth <= innerWidth + 1))) bad.push(`${w} ${st}`);
      await pg.close();
    }
  }
  check(`no sideways scroll at 1440, 1100, 800 and phone width, ${theme}`, bad.length === 0, bad.join("; "));
}
p = await open("auto=0&state=live&motion=reduce");
check("reduced motion: the microphone mark holds still", (await q(p, () => getComputedStyle(document.querySelector(".mic-mark"), "::before").animationName)) === "none");
await p.close();
p = await open("theme=dark&auto=0&state=lost");
check("dark: a failed band uses --danger-soft", await q(p, () => {
  const probe = document.createElement("div");
  probe.style.background = "var(--danger-soft)";
  document.body.append(probe);
  const want = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return getComputedStyle(document.querySelector(".call-band")).backgroundColor === want;
}));
await p.close();

p = await open();
await click(p, '[data-v="call"]');
await click(p, '[data-v="consent-ok"]');
await wait(p, 700);
check("the walk clicks through with the fixture's answers: Listening", (await phase(p)) === "Listening");
await click(p, '[data-v="hangup"]');
await wait(p, 400);
check("…and Hang up ends it, confirmed", (await live(p)) === "Voice chat ended");
await p.close();

p = await b.newPage();
await p.goto(pageUrl("gallery.html"));
const links = await q(p, () => [...document.querySelectorAll('a[href^="voice.html"]')].map((a) => a.getAttribute("href")));
await p.close();
let broken = 0;
for (const href of links) {
  const pg = await b.newPage();
  const errs = [];
  pg.on("pageerror", (e) => errs.push(String(e)));
  await pg.goto(pageUrl(href));
  await pg.waitForTimeout(150);
  if (errs.length) (broken += 1), out.push(`PAGEERROR ${href}: ${errs.join("; ")}`);
  await pg.close();
}
check(`every voice state the gallery links to opens without an error (${links.length})`, broken === 0 && links.length > 40);
check("no request left the disk", offDisk === 0, String(offDisk));

await b.close();
console.log(out.join("\n"));
const failed = out.filter((l) => l.startsWith("FAIL") || l.startsWith("PAGEERROR")).length;
console.log(`\n${out.length - failed} ok, ${failed} not ok`);
process.exit(failed ? 1 : 0);
