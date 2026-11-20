// Behaviour checks for voice.html (docs/design/voice.md): the composer's two buttons
// as placed in the built composer, dictation, a call and its band, reconnecting,
// voice, speed and language, ending and failing, one call at a time, the "Voice
// chat" line, memos, Settings › Voice, and every width and theme.
// Run from the repository root:  node docs/design/prototype/tools/checks/voice.mjs
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("voice.html") + "?chrome=0&theme=light";
const b = await chromium.launch();
const out = [];
const check = (name, ok, extra = "") => out.push(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ` ${extra}` : ""}`);
const open = async (query = "", viewport = { width: 1440, height: 900 }) => {
  const p = await b.newPage({ viewport });
  p.on("pageerror", (e) => out.push("PAGEERROR " + e));
  await p.goto(base + (query ? "&" + query : ""));
  await p.waitForTimeout(150);
  return p;
};
const q = (p, fn, arg) => p.evaluate(fn, arg);
const text = (p, sel) => q(p, (s) => document.querySelector(s)?.textContent.replace(/\s+/g, " ").trim() ?? null, sel);
const has = async (p, sel, words) => ((await text(p, sel)) ?? "").includes(words);
const live = (p) => q(p, () => document.querySelector("#live").dataset.last || "");
const wait = (p, ms = 450) => p.waitForTimeout(ms);

// The composer: the two buttons in the built row ---------------------------------------------

let p = await open();
check("F-253 the built row's order: Attach, field, microphone, voice chat, Send", await q(p, () =>
  [...document.querySelectorAll(".composer-row > *")].map((x) => x.getAttribute("aria-label")).join("|") ===
  "Attach files|Message Otto|Start dictation|Start voice chat|Send"));
check("the composer keeps its shelf, box and row as built", await q(p, () => Boolean(document.querySelector(".composer > .composer-inner > .composer-shelf + .composer-box > .composer-row"))));
check("the microphone's shortcut is in its title", (await q(p, () => document.querySelector('[data-v="mic"]').title)) === "Start dictation (⌘D)");
await p.fill(".composer-input", "Hello");
await wait(p, 50);
check("F-254 typing hides Start voice chat", await q(p, () => !document.querySelector('[data-v="call"]')));
await p.fill(".composer-input", "");
await wait(p, 50);
check("F-254 clearing shows it again", await q(p, () => Boolean(document.querySelector('[data-v="call"]'))));
await p.close();

p = await open("run=running");
check("during a run, the two buttons come before Stop, and Stop and Send keep the end", await q(p, () =>
  [...document.querySelectorAll(".composer-row > *")].map((x) => x.getAttribute("aria-label")).join("|") ===
  "Attach files|Steer Otto|Start dictation|Start voice chat|Stop Otto|Steer this turn"));
await p.fill(".composer-input", "faster");
await wait(p, 50);
check("…with text, How to send sits before the microphone", await q(p, () =>
  [...document.querySelectorAll(".composer-row > *")].map((x) => x.getAttribute("aria-label")).join("|") ===
  "Attach files|Steer Otto|How to send: Steer|Start dictation|Stop Otto|Steer this turn"));
await p.close();

p = await open("access=read");
check("read-only: the built access bar stands in the composer's place, words unchanged", await has(p, "#composer", "Read-only. You can follow Otto's work here. Approvals and questions aren't shown on this connection."));
check("read-only: no microphone and no voice chat button", await q(p, () => !document.querySelector('[data-v="mic"], [data-v="call"]')));
check("read-only: Request access is offered", await q(p, () => document.querySelector("#composer .access-bar button")?.textContent === "Request access"));
await p.close();

p = await open("os=windows");
check("off the Mac the shortcut is Ctrl+D", (await q(p, () => document.querySelector('[data-v="mic"]').title)) === "Start dictation (Ctrl+D)");
await p.close();

p = await open("os=remote");
const remote = "This page can't use a microphone: a browser allows one only over https or on this computer itself.";
check("a page over plain http: both buttons disabled with the reason as their description", await q(p, (r) =>
  ["mic", "call"].every((v) => {
    const el = document.querySelector(`[data-v="${v}"]`);
    return el.getAttribute("aria-disabled") === "true" && el.getAttribute("aria-description") === r;
  }), remote));
await p.close();

for (const [voice, words] of [
  ["none", "Voice chat isn't set up on Home gateway."],
  ["direct", "Home gateway's voice provider talks to apps directly, which Clawtrate doesn't do."],
]) {
  p = await open(`voice=${voice}`);
  check(`voice=${voice}: the button is disabled, saying "${words}"`, await q(p, (w) => {
    const el = document.querySelector('[data-v="call"]');
    return el.getAttribute("aria-disabled") === "true" && el.getAttribute("aria-description") === w;
  }, words));
  await p.close();
}
p = await open("voice=unknown");
check("voice=unknown: ready, described as unknown", await q(p, () => {
  const el = document.querySelector('[data-v="call"]');
  return el.getAttribute("aria-disabled") !== "true" && el.getAttribute("aria-description") === "Can't tell whether voice chat is set up on Home gateway.";
}));
await p.close();

// Dictation ---------------------------------------------------------------------------------

p = await open();
await p.click('[data-v="mic"]');
await wait(p, 100);
check("F-253 first press: where your voice goes, with both routes on a Mac", await q(p, () => {
  const d = document.querySelector("#consent-dialog");
  return d.open && d.querySelector("h2").textContent === "Where your voice goes" &&
    [...d.querySelectorAll(".b-choice-title")].map((x) => x.textContent).join() === "On this Mac,Through Home gateway";
}));
check("the device route's sentence names Apple's recognizer with its network use off", await has(p, "#consent-dialog", "Apple's speech recognition turns your voice into text on this Mac, with its network use turned off."));
check("the gateway route's sentence names the gateway and the provider", await has(p, "#consent-dialog", "Your voice goes to Home gateway, which sends it to OpenAI Realtime Transcription and sends the text back."));
await p.keyboard.press("Escape");
await wait(p, 100);
check("Escape cancels; focus returns to the microphone; nothing listens", await q(p, () => document.activeElement?.dataset.v === "mic" && !document.querySelector('[data-testid="listening"]')));
await p.click('[data-v="mic"]');
await wait(p, 80);
await p.click('[data-v="consent-ok"]');
await wait(p, 80);
check("Listening: the button says Stop dictation, the line says where the words go", await q(p, () =>
  document.querySelector('[data-v="mic"]').getAttribute("aria-label") === "Stop dictation" &&
  document.querySelector('[data-testid="listening"]').textContent.startsWith("Listening · Microphone on") &&
  document.querySelector('[data-testid="listening"]').textContent.includes("On this Mac")));
check("words not yet final are only in the dictation line, never in the field", await q(p, () =>
  document.querySelector('[data-testid="partial"]').textContent === "Not final yet: check the backup" &&
  document.querySelector(".composer-input").value === ""));
check("the region said Listening", (await live(p)) === "Listening");
await wait(p, 600);
check("final words go into the field, unsent", await q(p, () => document.querySelector(".composer-input").value === "Check the backup logs too." && !document.querySelector('[data-v="send"]').disabled));
await p.keyboard.press("Escape");
await wait(p, 80);
check("Escape stops dictation and keeps the text", await q(p, () => !document.querySelector('[data-testid="listening"]') && document.querySelector(".composer-input").value === "Check the backup logs too."));
check("…announced", (await live(p)) === "Dictation stopped. The text is in your message.");
check("with text in the draft, voice chat is hidden", await q(p, () => !document.querySelector('[data-v="call"]')));
await p.close();

p = await open("seen=1&state=dictating");
await wait(p, 650);
await q(p, () => (window.voice.S.dictating.partial = "and the"));
await p.click('[data-v="send"]');
await wait(p, 80);
check("sending during dictation stops it, sends the final words and drops the rest", await q(p, () =>
  !document.querySelector('[data-testid="listening"]') && document.querySelector(".composer-input").value === "" && window.voice.S.sent === "Check the backup logs too."));
await p.close();

p = await open("state=dictating");
await wait(p, 650);
await p.keyboard.press("Meta+d");
await wait(p, 80);
check("⌘D stops dictation", await q(p, () => !document.querySelector('[data-testid="listening"]')));
await p.keyboard.down("Meta");
await p.keyboard.down("d");
await wait(p, 500);
check("⌘D held: dictating while held", await q(p, () => Boolean(document.querySelector('[data-testid="listening"]'))));
await p.keyboard.up("d");
await p.keyboard.up("Meta");
await wait(p, 80);
check("…released: stopped", await q(p, () => !document.querySelector('[data-testid="listening"]')));
await p.close();

p = await open("state=dictfail");
await wait(p, 100);
check("a refused dictation is a notice on the composer's shelf, with the gateway's words", await q(p, () => {
  const n = document.querySelector('.composer-shelf [data-testid="notice"]');
  return n && n.getAttribute("role") === "alert" && n.textContent.includes("Couldn't start dictation.") && n.textContent.includes("No realtime transcription provider registered");
}));
check("…with Try again and Dismiss, as built", await q(p, () => {
  const n = document.querySelector('[data-testid="notice"]');
  return n.querySelector('[data-v="notice-retry"]').textContent === "Try again" && n.querySelector('[data-v="notice-dismiss"]').getAttribute("aria-label") === "Dismiss";
}));
await q(p, () => (window.voice.S.flags.dictFail = false));
await p.click('[data-v="notice-retry"]');
await wait(p, 80);
check("Try again starts dictation once the gateway accepts", await q(p, () => Boolean(document.querySelector('[data-testid="listening"]')) && !document.querySelector('[data-testid="notice"]')));
await p.close();

p = await open("os=windows");
await p.click('[data-v="mic"]');
await wait(p, 80);
check("Windows: the gateway route only, with the reason for the other", await q(p, () =>
  document.querySelector('[data-testid="route-why"]').textContent === "Windows has no speech recognition Clawtrate can use without sending your voice to Microsoft."));
await p.close();

p = await open("os=windows&dict=none");
await p.click('[data-v="mic"]');
await wait(p, 80);
check("no route at all: Dictation isn't available here, with Close only", await q(p, () => {
  const d = document.querySelector("#consent-dialog");
  return d.querySelector("h2").textContent === "Dictation isn't available here" && [...d.querySelectorAll(".b-actions button")].map((x) => x.textContent).join() === "Close";
}));
await p.close();

p = await open("ondevice=0");
await p.click('[data-v="mic"]');
await wait(p, 80);
check("a Mac that can't recognize the language on its own says so", await has(p, "#consent-dialog", "On this Mac isn't available for English (United States): this Mac can't recognize it without the network."));
await p.close();

// Starting a call ---------------------------------------------------------------------------

p = await open();
await p.click('[data-v="call"]');
await wait(p, 80);
check("F-254 first call: where your voice goes, naming gateway, provider and what is saved", await has(p, "#consent-dialog", "Your voice goes to Home gateway over this connection, and the gateway sends it to OpenAI Realtime Voice, which listens and speaks Otto's replies. What you both say is saved as text in this task. Clawtrate doesn't keep the recording."));
await p.click('[data-v="consent-ok"]');
await wait(p, 50);
check("Connecting to Otto…, the microphone mark on, Cancel", await q(p, () =>
  document.querySelector('[data-testid="call-phase"]').textContent === "Connecting to Otto…" &&
  document.querySelector('[data-testid="mic-mark"]').textContent === "Microphone on"));
await wait(p, 500);
check("Listening, with the time on this device", await q(p, () =>
  document.querySelector('[data-testid="call-phase"]').textContent === "Listening" && /on this device$/.test(document.querySelector('[data-testid="call-time"]').textContent)));
check("the band is a region named for the bot; its actions in reading order", await q(p, () => {
  const band = document.querySelector(".call-band");
  return band.getAttribute("role") === "region" && band.getAttribute("aria-label") === "Voice chat with Otto" &&
    [...band.querySelectorAll(".call-actions button")].map((x) => x.textContent).join() === "Mute,Transcript,Settings,Hang up";
}));
check("…announced", (await live(p)) === "Voice chat with Otto started");
check("the microphone is disabled during a call, with its reason", await q(p, () => document.querySelector('[data-v="mic"]').getAttribute("aria-description") === "The microphone is in use by the voice chat."));
check("the voice chat button is pressed: In a voice chat", await q(p, () => document.querySelector('[data-v="call"]').getAttribute("aria-label") === "In a voice chat" && document.querySelector('[data-v="call"]').getAttribute("aria-pressed") === "true"));
await p.click('[data-v="mute"]');
check("F-254 Mute: Microphone off, the note, Unmute pressed", await q(p, () =>
  document.querySelector('[data-testid="mic-mark"]').textContent === "Microphone off" &&
  document.querySelector('[data-testid="call-note"]').textContent === "Muted. This device's microphone is off." &&
  document.querySelector('[data-v="mute"]').textContent === "Unmute" && document.querySelector('[data-v="mute"]').getAttribute("aria-pressed") === "true"));
check("…announced Muted", (await live(p)) === "Muted");
await p.click('[data-v="mute"]');
await p.click('[data-v="transcript"]');
await q(p, () => window.voice.speak());
await wait(p, 50);
check("F-254 Transcript: a log, with the saved-as-said line", await q(p, () =>
  document.querySelector(".call-transcript").getAttribute("role") === "log" && document.querySelector(".call-band").textContent.includes("Saved in this task as it's said.")));
check("Otto is speaking, from the frames", (await text(p, '[data-testid="call-phase"]')) === "Otto is speaking");
await wait(p, 450);
await p.click('[data-v="hangup"]');
check("Hang up: Ending…", (await text(p, '[data-testid="call-phase"]')) === "Ending…");
await wait(p, 400);
check("F-111 the band goes and the line is left", await q(p, () => !document.querySelector(".call-band") && document.querySelector('[data-testid="call-line"]').textContent.startsWith("Voice chat · 0:")));
check("…announced Voice chat ended", (await live(p)) === "Voice chat ended");
await p.close();

p = await open("seen=1&mic=prompt");
await p.click('[data-v="call"]');
await wait(p, 50);
check("the system's prompt: Waiting for microphone access…, drawn as a labelled picture", await q(p, () =>
  document.querySelector('[data-testid="call-phase"]').textContent === "Waiting for microphone access…" &&
  document.querySelector(".v-pic-label").textContent.startsWith("Picture of the system's microphone prompt.")));
await p.click('[data-v="os-deny"]');
check("refused: the words and Open System Settings", await q(p, () =>
  document.querySelector('[data-testid="call-phase"]').textContent === "Clawtrate can't use the microphone. Allow it in System Settings › Privacy & Security › Microphone." &&
  Boolean([...document.querySelectorAll(".call-band button")].find((x) => x.textContent === "Open System Settings"))));
await p.close();

p = await open("seen=1&mic=missing");
await p.click('[data-v="call"]');
check("the chosen microphone isn't connected: never replaced silently", await q(p, () =>
  document.querySelector('[data-testid="call-phase"]').textContent === "USB Microphone isn't connected." &&
  [...document.querySelectorAll(".call-band button")].map((x) => x.textContent).join() === "Use System Default this time,Choose another,Cancel"));
await p.close();

p = await open("seen=1&mic=none");
await p.click('[data-v="call"]');
check("no microphone: No microphone found.", (await text(p, '[data-testid="call-phase"]')) === "No microphone found.");
await p.close();

// On a call: the gateway's limits --------------------------------------------------------------

p = await open("state=limit");
check("28 minutes: the band says when the gateway ends the call", await has(p, '[data-testid="call-limit"]', "Home gateway ends calls after 30 minutes. This one ends at 5:59 PM."));
await p.close();

p = await open("state=micgone");
check("the microphone goes away: nothing is sent, Use System Default", await q(p, () =>
  document.querySelector(".call-band").textContent.includes("The microphone stopped: USB Microphone was disconnected. Nothing is being sent.") &&
  document.querySelector('[data-testid="mic-mark"]').textContent === "Microphone off" && Boolean(document.querySelector('[data-v="mic-back"]'))));
await p.close();

// Reconnecting (F-463) ---------------------------------------------------------------------------

p = await open("state=live");
await wait(p, 50);
await q(p, () => window.voice.dropConnection());
await wait(p, 50);
check("F-463 a drop: Reconnecting…, Microphone off, nothing sent, Hang up only", await q(p, () =>
  document.querySelector('[data-testid="call-phase"]').textContent === "Reconnecting…" &&
  document.querySelector('[data-testid="mic-mark"]').textContent === "Microphone off" &&
  document.querySelector('[data-testid="call-note"]').textContent === "The connection to Home gateway dropped. Nothing is being sent. The call starts again here when it reconnects." &&
  [...document.querySelectorAll(".call-band button")].map((x) => x.textContent).join() === "Hang up"));
check("…announced", (await live(p)) === "Reconnecting the voice chat");
check("…the status strip shows the app reconnecting", await q(p, () => !document.querySelector("#status-strip").hidden));
await wait(p, 750);
check("F-463 back within the window: the same band goes on listening, in a new session", await q(p, () =>
  document.querySelector('[data-testid="call-phase"]').textContent === "Listening" &&
  document.querySelector('[data-testid="call-resumed"]').textContent === "Reconnected. Home gateway closed the call's session when the connection dropped, so the call goes on in a new one. Nothing said while it was down was heard."));
check("F-463 the time went on counting", await q(p, () => window.voice.S.call.secs >= 134));
check("F-463 at most one call throughout", await q(p, () => document.querySelectorAll(".call-band").length === 1));
check("…announced", (await live(p)) === "Voice chat with Otto reconnected");
await p.close();

p = await open("state=muted");
await wait(p, 50);
await q(p, () => window.voice.dropConnection());
await wait(p, 750);
check("a muted call comes back muted: the microphone isn't opened by itself", await q(p, () => window.voice.S.call.muted && document.querySelector('[data-testid="mic-mark"]').textContent === "Microphone off"));
await p.close();

p = await open("state=live");
await wait(p, 50);
await q(p, () => window.voice.dropConnection(true));
await wait(p, 1700);
check("F-411 not back within the window: Voice chat failed, Connection lost", await q(p, () =>
  document.querySelector('[data-testid="call-phase"]').textContent === "Voice chat failed" &&
  document.querySelector('[data-testid="call-reason"]').textContent === "Connection lost" &&
  document.querySelector('[data-testid="call-note"]').textContent === "The connection to Home gateway dropped and didn't come back within 30 seconds. What was said is saved in this task."));
check("…the line is left for what was said", await q(p, () => Boolean(document.querySelector('[data-testid="call-line"]'))));
await wait(p, 900);
await p.click('[data-v="dismiss"]');
check("F-411 Dismiss closes it; Start voice chat starts a new call", await q(p, () => !document.querySelector(".call-band") && document.querySelector('[data-v="call"]').getAttribute("aria-label") === "Start voice chat"));
await p.close();

p = await open("state=reconnecting");
await p.click('[data-v="hangup"]');
check("Hang up while reconnecting: the band goes, the line is left", await q(p, () => !document.querySelector(".call-band") && Boolean(document.querySelector('[data-testid="call-line"]'))));
await p.close();

p = await open("state=live");
await wait(p, 50);
await q(p, () => (window.voice.S.flags.createFail = true));
await q(p, () => window.voice.dropConnection());
await wait(p, 750);
check("a reconnect the gateway refuses: The call ended unexpectedly, with its words", await q(p, () =>
  document.querySelector('[data-testid="call-reason"]').textContent === "The call ended unexpectedly" &&
  document.querySelector('[data-testid="call-note"]').textContent === 'Home gateway ended the call: Realtime voice provider "openai" is not configured.'));
await p.close();

for (const [reason, words, second] of [
  ["none", "No connection", "This device isn't connected to Home gateway. Start again when it reconnects."],
  ["error", "The call ended unexpectedly", "Home gateway ended the call: Realtime provider closed the session."],
]) {
  p = await open(`state=failed&reason=${reason}`);
  check(`F-411 failed, ${words}`, await q(p, ([w, s]) =>
    document.querySelector('[data-testid="call-reason"]').textContent === w && document.querySelector('[data-testid="call-note"]').textContent === s &&
    document.querySelector(".call-band").dataset.tone === "danger" && document.querySelector('[data-v="dismiss"]').textContent === "Dismiss", [words, second]));
  await p.close();
}

p = await open("state=endfail");
check("a close the gateway didn't confirm: said under the line", await has(p, '[data-testid="endfail"]', "Ended on this device. Home gateway didn't confirm; it ends the call when this connection closes, or after 30 minutes."));
await p.close();

// Voice, speed, language (F-410, F-461, F-462) -----------------------------------------------------

p = await open("state=settings");
check("the call's settings: Voice, Speed, Language", await q(p, () => [...document.querySelectorAll(".call-settings h4")].map((x) => x.textContent).join() === "Voice,Speed,Language"));
check("kept for the bot on the gateway, for every device", (await text(p, '[data-testid="kept-note"]')) === "Saved for Otto on Home gateway, so your other devices use it too.");
await p.click('[data-v-voice="Cedar"]');
check("F-410 choosing a voice: Changing to Cedar…, the call goes on", await q(p, () => document.querySelector('[data-testid="voice-note"]').textContent === "Changing to Cedar…" && document.querySelector('[data-testid="call-phase"]').textContent === "Listening"));
await wait(p, 400);
check("F-410 …Voice: Cedar, from Otto's next reply, kept for Otto", await q(p, () =>
  document.querySelector('[data-testid="voice-note"]').textContent === "Voice: Cedar, from Otto's next reply." && window.voice.S.kept.otto.voice === "Cedar"));
await p.click('[data-v-speed="1.5"]');
check("F-461 speed: at once, on this device, kept for Otto", await q(p, () => document.querySelector('[data-testid="speed-note"]').textContent === "Plays at 1.5× on this device." && window.voice.S.kept.otto.speed === "1.5"));
await p.selectOption('[data-v="lang"]', "es");
await wait(p, 30);
check("F-462 a language during a call: a second session takes over, the call goes on", await q(p, () =>
  document.querySelector('[data-testid="lang-note"]').textContent === "Changing the language to Español…" && document.querySelector('[data-testid="call-phase"]').textContent === "Listening"));
await wait(p, 400);
check("F-462 …Language: Español, from what you say next; kept for Otto", await q(p, () =>
  document.querySelector('[data-testid="lang-note"]').textContent === "Language: Español, from what you say next." && window.voice.S.kept.otto.lang === "es"));
check("F-462 …one band, its time unbroken", await q(p, () => document.querySelectorAll(".call-band").length === 1 && window.voice.S.call.secs >= 134));
check("…announced", (await live(p)) === "Language: Español, from what you say next.");
await p.close();

p = await open("state=voicefail");
await p.click('[data-v-voice="Sage"]');
await wait(p, 400);
check("a refused voice: the gateway's words; the kept choice stays", await q(p, () =>
  document.querySelector('[data-testid="voice-note"]').textContent === "The voice didn't change: Voice is not in this call's catalog." && window.voice.S.kept.otto.voice === "Default"));
await p.close();

p = await open("state=langfail");
check("a refused language: the gateway's words; the call goes on as before", (await text(p, '[data-testid="lang-note"]')) === "The language didn't change: Too many active realtime relay sessions for this connection. The call goes on as before.");
await p.selectOption('[data-v="lang"]', "fr");
await wait(p, 400);
check("…and the kept choice stays", await q(p, () => window.voice.S.kept.otto.lang === "auto"));
await p.close();

p = await open("state=novoices");
check("a provider with no voices: said, no list", await q(p, () =>
  document.querySelector('[data-testid="voice-note"]').textContent === "OpenAI Realtime Voice offers no voices to choose from on Home gateway." && !document.querySelector('[data-v-voice]')));
await p.close();

p = await open("state=voicegone");
await wait(p, 500);
check("a kept voice no longer offered: said once, back to Default", await q(p, () =>
  document.querySelector('[data-testid="voice-gone"]').textContent === "Ember isn't offered by Home gateway any more, so this call uses its default voice." && window.voice.S.kept.otto.voice === "Default"));
await p.close();

p = await open("state=settings&prefs=none");
check("with no durable user: Kept on this device for Otto.", (await text(p, '[data-testid="kept-note"]')) === "Kept on this device for Otto.");
await p.close();

// One call at a time (F-412) ---------------------------------------------------------------------

p = await open("state=second");
await wait(p, 80);
check("F-412 a second call asks first", await q(p, () => {
  const d = document.querySelector("#confirm-dialog");
  return d.open && d.querySelector("h2").textContent === "End the current voice chat?" &&
    d.querySelector("#confirm-text").textContent === "You're in a voice chat with Juniper. Ending it starts one with Otto." &&
    [...d.querySelectorAll("button")].map((x) => x.textContent).join() === "Cancel,End and Chat";
}));
await p.keyboard.press("Escape");
await wait(p, 50);
check("F-412 Cancel (Escape) leaves the old call running", await q(p, () => window.voice.S.call.bot === "juniper" && window.voice.S.call.state === "live"));
await q(p, () => document.querySelector('[data-v="call"]').click());
await wait(p, 50);
await p.click('[data-v="second-ok"]');
await wait(p, 900);
check("F-412 End and Chat ends the old call and connects Otto, one call at most", await q(p, () => window.voice.S.call.bot === "otto" && window.voice.S.call.state === "live" && document.querySelectorAll(".call-band").length === 1));
await p.close();

// The "Voice chat" line (F-111) ----------------------------------------------------------------------

p = await open("line=here");
check("F-111 this device's line: Voice chat · 2:14", (await text(p, '[data-testid="call-line"]')) === "Voice chat · 2:14");
await p.click('[data-v="line"]');
check("F-111 it opens the transcript in place", await q(p, () => document.querySelector('[data-v="line"]').getAttribute("aria-expanded") === "true" && !document.querySelector('[data-testid="call-turns"]').hidden));
await p.close();
p = await open("line=elsewhere");
check("F-111 elsewhere: the turns' count and their times", (await text(p, '[data-testid="call-line"]')) === "Voice chat · 6 turns · 5:31–5:36 PM");
await p.close();
p = await open("line=empty");
check("a call that saved nothing: said so, nothing to open", await q(p, () =>
  document.querySelector('[data-testid="call-line"]').textContent === "Voice chat · 0:40 · nothing was saved" && document.querySelector('[data-v="line"]').disabled));
await p.close();

// Memos (F-255, F-413) and docs/decisions.md ---------------------------------------------------------------

p = await open("bot=pip");
check("F-255 a memo: Play voice memo", (await q(p, () => document.querySelector('[data-v="memo-play"]').getAttribute("aria-label"))) === "Play voice memo");
await p.click('[data-v="memo-text"]');
check("F-255 Show text: the text it was made from, headed as such", await q(p, () => document.querySelector('[data-testid="memo-text"]').textContent.startsWith("The text this was made from")));
check("F-413 no word highlighting, said", (await text(p, '[data-testid="no-highlight"]')) === "Words aren't highlighted: the gateway gives no timing for each word.");
await p.click('[data-v="memo-speed"]');
check("F-461 the memo plays at the bot's speed, which cycles", (await text(p, '[data-v="memo-speed"]')) === "1.25×");
await p.close();
p = await open("bot=pip&memo=notext");
check("a memo with no text says so; nothing is called a transcript", await q(p, () => document.querySelector('[data-testid="memo-notext"]').textContent === "No text came with this recording." && !/transcript/i.test(document.querySelector('[data-testid="memo"]').textContent)));
await p.close();
p = await open("bot=pip&memo=big");
check("over 5 MiB: said, in MiB", await has(p, '[data-testid="memo"]', "This voice memo is 7.2 MiB. Clawtrate fetches items up to 5 MiB, so it can't be played here."));
await p.close();
p = await open("bot=pip&memo=fail");
check("a failure: Couldn't load the voice memo., Try again", await q(p, () => document.querySelector('[data-testid="memo"]').textContent.startsWith("Couldn't load the voice memo.") && document.querySelector('[data-v="memo-retry"]').textContent === "Try again"));
await p.close();
p = await open("bot=pip&memo=address");
check("an address the item carries: never played, shown in full as text, opened only by choice", await q(p, () => {
  const m = document.querySelector('[data-testid="memo"]');
  return m.textContent.startsWith("This voice memo is at an address Clawtrate doesn't open by itself:") &&
    document.querySelector('[data-testid="memo-address"]').textContent === "https://media.example.net/pip/route-saturday.mp3" &&
    !m.querySelector("a, audio, [data-v='memo-play']") && m.querySelector('[data-v="memo-open"]').textContent === "Open in browser";
}));
await p.close();
p = await open("bot=pip&memo=nohttp&os=iphone");
check("a grant on the iPhone: not played yet, said why", await has(p, '[data-testid="memo"]', "This voice memo can't be played on this iPhone yet: Home gateway offers it as a download, and the iPhone app doesn't make downloads yet."));
await p.close();
p = await open("bot=pip&access=read");
check("read-only: a memo still plays", await q(p, () => Boolean(document.querySelector('[data-v="memo-play"]'))));
await p.close();

// Settings › Voice (F-392) -----------------------------------------------------------------------------

p = await open("page=settings");
await wait(p, 80);
check("Settings › Voice: Microphone, Dictation, Voice chat, Bots", await q(p, () => [...document.querySelectorAll("#settings-dialog .v-group h4")].map((x) => x.textContent).join() === "Microphone,Dictation,Voice chat,Bots"));
check("F-392 System Default, then each device by name, a radio group", await q(p, () => {
  const g = document.querySelector('#settings-dialog [role="radiogroup"][aria-label="Microphone"]');
  return [...g.querySelectorAll(".b-choice-title")].map((x) => x.textContent).join() === "System Default,MacBook Pro Microphone,USB Microphone";
}));
check("the bots' settings: saved on the gateway for every device", (await text(p, '[data-testid="bots-kept"]')) === "Saved on Home gateway, so your other devices use them too.");
check("what voice chat uses, from the catalog", await has(p, '[data-testid="settings-call"]', "Home gateway relays calls to OpenAI Realtime Voice."));
await p.close();
p = await open("page=settings&mic=prompt");
await wait(p, 80);
check("F-392 before access, names are unknown, with Allow", await has(p, '[data-testid="names-hidden"]', "Allow microphone access to see your microphones' names."));
await p.close();
p = await open("page=settings&mic=missing");
await wait(p, 80);
check("F-392 the chosen device not connected: never replaced silently", await has(p, '[data-testid="mic-missing"]', "USB Microphone isn't connected. Voice won't use another microphone without asking."));
await p.close();
p = await open("page=settings&access=read&prefs=none");
await wait(p, 80);
check("read-only Settings: dictation and voice chat need more access; Reset disabled", await q(p, () =>
  document.querySelector("#settings-dialog").textContent.includes("Dictation and voice chat need more access on this connection.") &&
  [...document.querySelectorAll('#settings-dialog [data-v="reset"]')].every((x) => x.getAttribute("aria-disabled") === "true" && x.getAttribute("aria-description") === "Needs more access")));
check("with no durable user: kept on this device, said why", (await text(p, '[data-testid="bots-kept"]')) === "Kept on this device, for each bot: this connection has no user profile on the gateway.");
await p.close();
for (const [voice, words] of [
  ["none", "Voice chat isn't set up on Home gateway. Its owner sets up a voice provider in OpenClaw's Talk settings."],
  ["unknown", "Can't tell whether voice chat is set up on Home gateway."],
]) {
  p = await open(`page=settings&voice=${voice}`);
  await wait(p, 80);
  check(`Settings, voice=${voice}`, (await text(p, '[data-testid="settings-call"]')) === words);
  await p.close();
}

// Widths, themes, motion -------------------------------------------------------------------------------

const widths = [
  ["1440", { width: 1440, height: 900 }],
  ["1100", { width: 1100, height: 800 }],
  ["800", { width: 800, height: 800 }],
  ["phone", { width: 390, height: 844 }],
];
for (const theme of ["light", "dark"]) {
  for (const [w, vp] of widths) {
    for (const st of ["state=transcript", "state=settings", "state=failed&reason=drop", "state=reconnecting", "state=dictating", "bot=pip&memo=address"]) {
      const pg = await b.newPage({ viewport: vp });
      pg.on("pageerror", (e) => out.push("PAGEERROR " + e));
      await pg.goto(pageUrl("voice.html") + `?chrome=0&theme=${theme}&width=${w}&${st}`);
      await pg.waitForTimeout(120);
      const ok = await q(pg, () => document.documentElement.scrollWidth <= innerWidth + 1);
      if (!ok) check(`no sideways scroll: ${theme} ${w} ${st}`, false);
      await pg.close();
    }
  }
  check(`no sideways scroll at 1440, 1100, 800 and phone width, ${theme}`, !out.some((l) => l.startsWith(`FAIL no sideways scroll: ${theme}`)));
}

p = await open("state=live&width=phone", { width: 390, height: 844 });
check("phone: the band's controls are 44 px touch targets", await q(p, () =>
  [...document.querySelectorAll(".call-band button")].every((x) => x.getBoundingClientRect().height >= 44)));
check("phone: Hang up keeps its place at the end, and the time stays on the first row", await q(p, () => {
  const buttons = [...document.querySelectorAll(".call-actions button")];
  const hang = buttons.at(-1);
  const time = document.querySelector('[data-testid="call-time"]').getBoundingClientRect();
  const title = document.querySelector(".call-title").getBoundingClientRect();
  return hang.textContent === "Hang up" && Math.abs(time.top - title.top) < 24;
}));
check("phone: the composer's two buttons have a 44 px hit area the pointer reaches", await q(p, () =>
  ["mic", "call"].every((v) => {
    const el = document.querySelector(`[data-v="${v}"]`);
    const r = el.getBoundingClientRect();
    const cx = Math.floor(r.left + r.width / 2);
    const cy = Math.floor(r.top + r.height / 2);
    return [[0, -22], [0, 21], [-22, 0], [21, 0]].every(([dx, dy]) => el.contains(document.elementFromPoint(cx + dx, cy + dy)));
  })));
await p.close();

p = await open("state=live&motion=reduce");
check("reduced motion: the microphone mark holds still", (await q(p, () => getComputedStyle(document.querySelector(".mic-mark"), "::before").animationName)) === "none");
await p.close();
p = await open("state=live");
check("full motion: the microphone mark pulses", (await q(p, () => getComputedStyle(document.querySelector(".mic-mark"), "::before").animationName)) === "v-pulse");
await p.close();

p = await open("theme=dark&state=failed&reason=drop");
check("dark: a failed band uses --danger-soft", await q(p, () => {
  const probe = document.createElement("div");
  probe.style.background = "var(--danger-soft)";
  document.body.append(probe);
  const want = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return getComputedStyle(document.querySelector(".call-band")).backgroundColor === want;
}));
await p.close();

// The gallery links here -----------------------------------------------------------------------------------

p = await b.newPage();
await p.goto(pageUrl("gallery.html"));
check("the gallery links to voice.html", await q(p, () => Boolean(document.querySelector('a[href^="voice.html"]'))));
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
check(`every voice state the gallery links to opens without an error (${links.length})`, broken === 0 && links.length > 20);

await b.close();
console.log(out.join("\n"));
const failed = out.filter((l) => l.startsWith("FAIL") || l.startsWith("PAGEERROR")).length;
console.log(`\n${out.length - failed} ok, ${failed} not ok`);
process.exit(failed ? 1 : 0);
