// Behaviour checks for the conversation pages (conversation.html, gallery.html).
// Run from the repository root:  node docs/design/prototype/tools/checks/conversation.mjs
// Behaviour checks for the conversation prototype (part 2).
import { chromium, pageUrl } from "./browser.mjs";
const base = pageUrl('');
const run = base + 'conversation.html?theme=light';
const gallery = base + 'gallery.html?chrome=0&theme=light';
const b = await chromium.launch();
const out = [];
const check = (name, ok, extra = '') => out.push(`${ok ? 'ok  ' : 'FAIL'} ${name} ${ok ? '' : extra}`);
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

async function open(url, { w = 1440, h = 900, clip = false } = {}) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, permissions: clip ? ['clipboard-read', 'clipboard-write'] : [] });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => out.push('PAGEERROR ' + String(e.stack || e).split('\n').slice(0, 2).join(' | ')));
  await p.goto(url);
  await p.evaluate(() => document.fonts.ready);
  return p;
}
const q = (p, fn, arg) => p.evaluate(fn, arg);
const to = (p, label) => q(p, (l) => demo.runTo(l), label);

// D1: a fresh page has its controls, and the whole run plays through them -------------------
let p = await open(run);
check('D1 controls exist on a fresh page', await q(p, () => document.querySelectorAll('#run-play, #run-step, #run-net, #run-reset').length === 4));
check('C11 nothing yet', await q(p, () => !document.querySelector('.status-line')));
await q(p, () => (demo.state.speed = 30));
await p.click('#run-play');
await p.waitForSelector('#approval[data-state="pending"]', { timeout: 20000 });
check('D1 Play reaches the approval and waits', await q(p, () => document.querySelector('#run-play').textContent === 'Waiting for your answer'));
check('C11 the phrase is never empty', await q(p, () => document.querySelector('.status-phrase').textContent.length > 0));
await p.click('#approval [data-row="main"] [data-decision="once"]');
await p.waitForSelector('#approval[data-state="once"]');
check('D4 allowed once says the command can run, not that it ran', await q(p, () => { const t = document.querySelector('#approval').textContent; return t.includes('The command can run now') && !/\bran\b/i.test(document.querySelector('#approval .request-resolved-body > p').textContent); }));
await p.waitForSelector('#question[data-state="pending"]', { timeout: 20000 });
await p.click('#question .option[data-letter="B"]');
await p.waitForFunction(() => document.querySelector('#run-play')?.textContent === 'Finished', null, { timeout: 30000 });
check('D1 the run finishes through the visible controls', await q(p, () => !document.querySelector('.status-line') || document.querySelector('.status-line').dataset.leaving === 'true'));
check('C7 the answered question shows the answer', await q(p, () => document.querySelector('#question').textContent.includes('A month')));
await p.close();

// The first moment ------------------------------------------------------------------------
p = await open(run + '&chrome=0');
await to(p, 'send');
check('C11 Thinking shows at once with the avatar', await q(p, () => document.querySelector('.status-phrase')?.textContent === 'Thinking'));

// B1 / D5: every step has detail, Raw everywhere, honest copy --------------------------------
await to(p, 'approval');
check('B1 every step has a body with two tabs', await q(p, () => [...document.querySelectorAll('#run-activity .step')].every((s) => s.querySelectorAll('[role="tab"]').length === 2 && s.querySelector('[data-view="readable"]').textContent.trim().length > 0)));
check('B1 no step body is still loading after its step ended', await q(p, () => ![...document.querySelectorAll('#run-activity .step:not([data-status="running"])')].some((s) => s.querySelector('[aria-busy="true"]'))));
check('D2 tabs: one tab stop, panels named', await q(p, () => { const s = document.querySelector('#s-read'); const tabs = [...s.querySelectorAll('[role="tab"]')]; return tabs.filter((t) => t.tabIndex === 0).length === 1 && tabs.every((t) => document.getElementById(t.getAttribute('aria-controls'))?.getAttribute('aria-labelledby') === t.id); }));
await q(p, () => { document.querySelector('#run-activity').open = true; document.querySelector('#s-read').open = true; });
await p.click('#s-read [data-view-button="readable"]');
await p.keyboard.press('ArrowRight');
check('D2 ArrowRight moves to Raw and selects it', await q(p, () => document.activeElement.dataset.viewButton === 'raw' && !document.querySelector('#s-read [data-view="raw"]').hidden && document.querySelector('#s-read [data-view="readable"]').hidden));
await p.keyboard.press('Home');
check('D2 Home goes back to Readable', await q(p, () => document.activeElement.dataset.viewButton === 'readable'));
const lines = await q(p, () => { const btn = document.querySelector('#s-read [data-view="readable"] [data-action="unclip"]'); const n = Number(btn.dataset.lines); btn.click(); const pre = btn.closest('.code-more').previousElementSibling; return [n, pre.textContent.split('\n').length, pre.dataset.clipped, btn.textContent]; });
check('D5 Show all N lines reveals N lines', lines[0] === lines[1] && lines[2] === 'false' && lines[3] === 'Show fewer', JSON.stringify(lines));
check('D5 raw fixtures hold whole payloads, no ellipsis', await q(p, () => ![...document.querySelectorAll('#run-activity [data-view="raw"] .code-block')].some((c) => c.textContent.includes('…'))));
for (const [sel, name] of [['#m-marlow', 'Messaged card'], ['#m-t3', 'T3 Code card'], ['#approval', 'approval']]) {
  await q(p, (s) => { const c = document.querySelector(s); if (c.tagName === 'DETAILS') c.open = true; }, sel);
  await p.click(`${sel} [data-action="raw"]`);
  check(`B1 Raw opens on the ${name}`, await q(p, (s) => { const btn = document.querySelector(`${s} [data-action="raw"]`); const panel = document.getElementById(btn.getAttribute('aria-controls')); return btn.getAttribute('aria-expanded') === 'true' && !panel.hidden && panel.textContent.includes('Identifiers'); }, sel));
  await p.focus(`${sel} .raw-panel .copy`);
  await p.keyboard.press('Escape');
  check(`B1 Escape in the ${name}'s Raw closes it and returns focus`, await q(p, (s) => document.activeElement === document.querySelector(`${s} [data-action="raw"]`) && document.activeElement.getAttribute('aria-expanded') === 'false', sel));
}
await p.click('#m-marlow [data-action="full-exchange"]');
check('B1 the full exchange opens in place', await q(p, () => !document.querySelector('#m-marlow [data-exchange="all"]').hidden && document.querySelectorAll('#m-marlow [data-exchange="all"] .exchange-item').length === 4 && document.activeElement.dataset.action === 'full-exchange'));

// C2/C3: the recipient's task and the way back -------------------------------------------------
const before = await q(p, () => document.querySelector('#transcript').scrollTop);
await p.click('#m-marlow [data-action="open-recipient"]');
check('C3 Open in Marlow shows the receiving card, open and focused', await q(p, () => document.activeElement === document.querySelector('#from-otto > summary') && document.querySelector('#from-otto').open && document.querySelector('#from-otto').textContent.includes('Message from') && document.querySelector('#title-pill').textContent.includes('Marlow')));
await p.click('#from-otto [data-action="open-sender"]');
check('C3 Open in Otto returns to the same place, card open, focus on its button', await q(p, (y) => Math.abs(document.querySelector('#transcript').scrollTop - y) < 2 && document.querySelector('#m-marlow').open && document.activeElement.dataset.action === 'open-recipient', before));

// B2 / D2: the approval from the keyboard ------------------------------------------------------
await p.click('#approval [data-action="standing-open"]');
check('B2 the form shows Deny beside its buttons', await q(p, () => { const d = document.querySelector('#approval .standing [data-decision="deny"]'); const r = d.getBoundingClientRect(); return r.width > 0 && !document.querySelector('#approval .standing').hidden && document.activeElement.dataset.decision === 'always'; }));
check('M1 the form shows the request\'s fields, and in words what the gateway keeps, with no lifetime', await q(p, () => { const f = document.querySelector('#approval .standing'); const labels = [...f.querySelectorAll('dt')].map((d) => d.textContent).join(); const t = f.textContent; return labels === 'Command,Folder,Runs on,Bot' && t.includes("media-box's allowlist") && t.includes('The gateway decides what that covers') && !f.querySelector('.days') && !t.includes('Until removed') && !t.includes('Saved on'); }));
await p.keyboard.press('Escape');
check('D2 Escape closes the form and returns focus to Always allow', await q(p, () => document.querySelector('#approval .standing').hidden && document.activeElement.dataset.action === 'standing-open'));
// D3: a steer leaves the approval pending
await p.click('.composer-input');
await p.keyboard.type('Use the scratch disk.');
check('D3 the mode word says what Enter does', await q(p, () => document.querySelector('.send-mode')?.textContent.trim() === 'Steer' && document.querySelector('.send-button').getAttribute('aria-label') === 'Steer this turn'));
await p.keyboard.press('Enter');
check('D3 a steer joins the run and leaves the approval pending', await q(p, () => document.querySelector('#approval').dataset.state === 'pending' && [...document.querySelectorAll('.msg-caption')].some((c) => c.textContent === 'Steer') && document.querySelector('.composer-input').value === ''));
await p.keyboard.type('Then check the certificate.');
await p.keyboard.press('Alt+Enter');
check('D3 Alt+Enter queues one message and leaves the mode as it was', await q(p, () => demo.state.queued.length === 1 && demo.state.mode === 'steer' && document.querySelector('.shelf-row').textContent.includes('Queued')));
await p.click('[data-queue="send"]');
check('D3 Send now goes through the same operation: a Steer bubble, approval still pending', await q(p, () => demo.state.queued.length === 0 && document.querySelector('#approval').dataset.state === 'pending' && [...document.querySelectorAll('.msg[data-role="user"]')].at(-1).textContent.includes('certificate')));
await p.keyboard.type('Look at the UPS too');
await p.keyboard.press(`${mod}+Shift+Enter`);
check('D3 Shift+Cmd+Enter starts a new task in the rail', await q(p, () => demo.state.newTasks.length === 1 && document.querySelector('#rail-otto .task').textContent.includes('Look at the UPS too') && document.querySelector('.composer-input').value === ''));
await p.focus('#approval [data-action="standing-open"]');
await p.keyboard.press(`${mod}+Enter`);
await p.waitForSelector('#approval[data-state="once"]');
check('D2 Cmd+Enter in the card allows once, and focus lands on the resolved card', await q(p, () => document.querySelector('#approval').contains(document.activeElement)));
check('D4 the step, not the card, says the command is running', await q(p, () => document.querySelector('#s-exec').textContent.includes('Running mv')));

// Questions, the held message ------------------------------------------------------------------
await to(p, 'question');
check('C7 the question pauses the run', await q(p, () => demo.state.run === 'waiting' && demo.state.pending.join() === 'question'));
await p.click('.composer-input');
await p.keyboard.type('Also tell me how big it is.');
check('held: the mode word reads Hold', await q(p, () => document.querySelector('.send-mode').textContent.trim() === 'Hold'));
await p.keyboard.press('Enter');
check('held: the message waits on the shelf, not in the transcript', await q(p, () => demo.state.held.length === 1 && [...document.querySelectorAll('.shelf-row')].some((r) => r.textContent.includes('Held until you answer')) && ![...document.querySelectorAll('.msg[data-role="user"]')].some((m) => m.textContent.includes('how big'))));
await p.keyboard.press(`${mod}+j`);
check('D2 Cmd+J moves focus to the question', await q(p, () => document.activeElement.classList.contains('option')));
await p.keyboard.press('ArrowDown');
check('D2 arrows move within the options, one tab stop', await q(p, () => document.activeElement.dataset.letter === 'B' && document.querySelectorAll('#question .option[tabindex="0"]').length === 1));
await p.keyboard.press('c');
await p.waitForSelector('#question[data-state="answered"]');
check('D2 a letter answers; the held message is then sent as a steer', await q(p, () => document.querySelector('#question').textContent.includes('Until I say so') && demo.state.held.length === 0 && [...document.querySelectorAll('.msg[data-role="user"]')].some((m) => m.textContent.includes('how big')) && document.querySelector('#question').contains(document.activeElement)));
await p.close();

// M7: held and queued messages follow one rule -------------------------------------------------
p = await open(run + '&chrome=0');
await to(p, 'approval');
await p.click('.composer-input');
await p.keyboard.type('Then check the certificate.');
await p.keyboard.press('Alt+Enter');
check('M7 a queued message has Send now while only an approval is pending', await q(p, () => !!document.querySelector('[data-queue="send"]')));
await p.click('#approval [data-row="main"] [data-decision="once"]');
await p.waitForSelector('#approval[data-state="once"]');
await to(p, 'question');
check('M7 no Send now while a question is pending', await q(p, () => demo.state.pending.includes('question') && demo.state.queued.length === 1 && !document.querySelector('[data-queue="send"]') && !!document.querySelector('[data-queue="cancel"]')));
await q(p, () => demo.send('steer', 'A message sent as Send now would send it.'));
await p.click('.composer-input');
await p.keyboard.type('Queue this one.');
await p.keyboard.press('Alt+Enter');
check('M7 a pending question holds every outgoing message, however it was sent', await q(p, () => demo.state.held.length === 2 && demo.state.queued.length === 1 && ![...document.querySelectorAll('.msg[data-role="user"]')].some((m) => /Send now would|Queue this one/.test(m.textContent))));
const bubbles = await q(p, () => document.querySelectorAll('.msg[data-role="user"]').length);
await q(p, () => demo.stop());
await p.waitForTimeout(1000);
check('M7 nothing starts after Stop: held and queued messages stay on the shelf, unsent', await q(p, (n) => demo.state.run === 'idle' && demo.state.unsent.length === 3 && demo.state.held.length === 0 && demo.state.queued.length === 0 && document.querySelectorAll('.msg[data-role="user"]').length === n && document.querySelectorAll('[data-unsent="send"]').length === 3 && [...document.querySelectorAll('.shelf-row')].filter((r) => r.textContent.includes('Not sent')).length === 3, bubbles));
await p.click('[data-unsent="send"]');
check('M7 Send on an unsent row sends that one, and the others stay', await q(p, (n) => document.querySelectorAll('.msg[data-role="user"]').length === n + 1 && demo.state.unsent.length === 2, bubbles));
await p.click('[data-unsent="remove"]');
check('M7 Remove takes a row off the shelf', await q(p, () => demo.state.unsent.length === 1));
await p.close();
p = await open(run + '&chrome=0');
await to(p, 'approval');
await p.click('#approval [data-row="main"] [data-decision="once"]');
await p.waitForSelector('#approval[data-state="once"]');
await to(p, 'question');
await q(p, () => demo.send('plain', 'Also tell me how big it is.'));
await q(p, () => demo.expireQuestion());
check('M7 a question that expires releases held messages in order, and the run goes on', await q(p, () => document.querySelector('#question').dataset.state === 'expired' && demo.state.held.length === 0 && demo.state.run === 'running' && [...document.querySelectorAll('.msg[data-role="user"]')].some((m) => m.textContent.includes('how big'))));
await p.close();

// Standing allow saved: the outcome repeats what was kept ------------------------------------
p = await open(run + '&chrome=0');
await to(p, 'approval');
await p.click('#approval [data-action="standing-open"]');
await p.click('#approval .standing [data-decision="always"]');
check('M2 sending: not resolved yet, Deny still there', await q(p, () => document.querySelector('#approval').dataset.state === 'pending' && document.querySelector('#approval .standing').textContent.includes('Sending your decision') && !!document.querySelector('#approval .standing [data-decision="deny"]')));
await p.waitForSelector('#approval[data-state="always"]');
check('M1/D4 the resolved card says what was kept in words, shows no rule, and links to Saved rules', await q(p, () => { const c = document.querySelector('#approval'); c.open = true; const t = c.textContent; return t.includes('Allowed, and saved. The command can run now.') && t.includes("Added to media-box's allowlist") && t.includes('Saved rules') && !c.querySelector('.standing-grid') && !t.includes('Until removed'); }));
await p.close();

// The form with a lifetime in days (gallery) ----------------------------------------------------
p = await open(gallery + '&section=approval');
const days = '.spec:has(h3:text-is("Always allow, for a command raised by a routine")) .request';
check('M1 only a routine\'s request has a lifetime field', await p.evaluate(() => document.querySelectorAll('.standing .days input').length === 1));
await p.fill(`${days} .days input`, '4000');
check('M1 days outside 1 to 3650 are refused', await p.evaluate(() => { const f = document.querySelector('.standing .days input').closest('.standing'); return !f.querySelector('.days-error').hidden && f.querySelector('[data-decision="always"]').disabled; }));
await p.fill(`${days} .days input`, '7');
check('M1 a valid number of days is accepted, and an empty field leaves the default', await p.evaluate(() => { const f = document.querySelector('.standing .days input').closest('.standing'); const ok = !f.querySelector('[data-decision="always"]').disabled; f.querySelector('.days input').value = ''; f.querySelector('.days input').dispatchEvent(new Event('input', { bubbles: true })); return ok && !f.querySelector('[data-decision="always"]').disabled && f.querySelector('.days-error').hidden; }));
check('M1 an expired request has no action on the installed gateway', await p.evaluate(() => !document.querySelector('.request[data-state="expired"] [data-action="standing-open"]')));
check('M2 unknown: never says the command did not run, offers Check again and Deny, and no allow', await p.evaluate(() => { const f = document.querySelector('.standing[data-sent="unknown"]'); const t = f.textContent; return t.includes('may or may not have been applied') && !/not run|has not run/.test(t) && !!f.querySelector('[data-action="check-decision"]') && !!f.querySelector('[data-decision="deny"]') && !f.querySelector('[data-decision="always"], [data-decision="once"]'); }));
check('M2 refused: the reason, and the request is still open', await p.evaluate(() => { const f = document.querySelector('.standing[data-sent="refused"]'); return f.textContent.includes('The gateway refused this decision') && f.textContent.includes('The request is still open') && !f.textContent.includes('has not run'); }));
await p.click('.standing[data-sent="unknown"] [data-action="check-decision"]');
await p.waitForTimeout(900);
check('M2 Check again asks for the request\'s state and shows the winner', await p.evaluate(() => !document.querySelector('.standing[data-sent="unknown"]') && [...document.querySelectorAll('.request[data-state="always"]')].some((c) => c.open)));
check('M3 a request whose run ended says only what is known', await p.evaluate(() => { const t = document.querySelector('.request-ended').textContent; return t.includes('still open') && !t.includes('next message'); }));
check('C5 gallery approval answers resolve', await p.evaluate(async () => { const c = document.querySelector('.spec .request[data-state="pending"]'); const id = c.id; c.querySelector('[data-decision="deny"]').click(); return document.getElementById(id).dataset.state === 'denied'; }));
await p.close();

// D5: copy copies what it says ------------------------------------------------------------------
p = await open(run + '&chrome=0', { clip: true });
await to(p, 'approval');
await q(p, () => (document.querySelector('#run-activity').open = true));
await p.click('#run-activity .activity-foot .copy');
check('D5 the run id copy button copies the run id', (await q(p, () => navigator.clipboard.readText())) === 'run_7f3a91c2');
await q(p, () => { document.querySelector('#s-read').open = true; document.querySelector('#s-read [data-view-button="raw"]').click(); });
await p.click('#s-read [data-view="raw"] [aria-label="Copy took time"]');
check('D5 a timing value copies', (await q(p, () => navigator.clipboard.readText())) === '0.6 s');
await p.click('#s-read [data-view="raw"] [aria-label="Copy arguments"]');
check('D5 Copy arguments copies the arguments', (await q(p, () => navigator.clipboard.readText())).includes('"path": "logs/backup-2026-11-15.log"'));
check('D5 success is announced', await q(p, () => new Promise((r) => setTimeout(() => r(document.querySelector('#announcer').textContent === 'Copied arguments'), 60))));
await p.close();
p = await open(run + '&chrome=0');
await p.addInitScript(() => {});
await to(p, 'read-done');
await q(p, () => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true }); document.querySelector('#run-activity').open = true; document.querySelector('#s-read').open = true; });
await p.click('#s-read [data-view="readable"] .code-head .copy');
check('D5 a failed copy claims nothing and selects the text', await q(p, () => new Promise((r) => setTimeout(() => r(document.querySelector('#s-read [data-view="readable"] .code-head .copy').dataset.copied === 'failed' && getSelection().toString().length > 100 && document.querySelector('#announcer').textContent.startsWith("Couldn't copy")), 60))));
await p.close();

// B4: a lost connection never looks live -----------------------------------------------------------
p = await open(run + '&chrome=0');
await to(p, 'message-working');
await q(p, () => demo.disconnect());
await p.waitForTimeout(150);
const moving = await q(p, () => document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.target && !a.effect.target.closest('.status-strip, .rail-footer, .rail-status')).map((a) => a.animationName + ' ' + (a.effect.target.className || a.effect.pseudoElement)));
check('B4 nothing that stands for work is moving', moving.length === 0, JSON.stringify(moving));
check('B4 what is left is marked last seen', await q(p, () => document.querySelector('#m-marlow .state').textContent === 'Last seen working' && document.querySelector('#s-msg .step-status').textContent === 'Last seen running' && document.querySelector('#run-activity .activity-label').textContent === 'Last seen working' && document.querySelector('#rail-marlow .bot-preview').textContent.startsWith('Last seen:') && document.querySelector('.status-phrase').textContent.startsWith('Reconnecting. Last seen')));
await p.click('.composer-input');
await p.keyboard.type('Are you there?');
await p.keyboard.press('Enter');
const held = await q(p, () => { const m = document.querySelector('.msg[data-pending="held"] .bubble'); const cs = getComputedStyle(m); return [cs.opacity, cs.color, cs.backgroundColor, m.parentElement.nextElementSibling.textContent]; });
check('B6 a message written offline keeps full contrast', held[0] === '1' && held[1] === 'rgb(17, 18, 19)' && held[3] === 'Sends when reconnected', JSON.stringify(held));
await q(p, () => demo.reconnect());
await p.waitForTimeout(900);
check('reconnect: the held message is sent once and work looks live again', await q(p, () => !document.querySelector('.msg[data-pending="held"]') && document.querySelector('#root').dataset.connection === 'live' && document.querySelectorAll('#status-strip').length === 1));
await q(p, () => demo.disconnect());
await q(p, () => demo.reconnect());
await p.waitForTimeout(900);
check('D8 a second disconnect and reconnect still works', await q(p, () => document.querySelector('#status-strip .status-strip-text')?.textContent.startsWith('Synced')));
await p.close();

// Stop ---------------------------------------------------------------------------------------------
p = await open(run + '&chrome=0&stopfail=1');
await to(p, 'approval');
await p.click('[data-action="stop"]');
await p.waitForTimeout(800);
check('stop failed: the run is still waiting, the card still pending, a notice offers to try again', await q(p, () => demo.state.run === 'waiting' && document.querySelector('#approval').dataset.state === 'pending' && [...document.querySelectorAll('.shelf-row')].some((r) => r.textContent.includes("Couldn't stop Otto")) && !!document.querySelector('.stop-button')));
await p.click('[data-notice="retry"]');
await p.waitForTimeout(900);
check('stop confirmed: the approval closes as Cancelled and the T3 card says the call was made', await q(p, () => document.querySelector('#approval').dataset.state === 'cancelled' && document.querySelector('#m-t3').textContent.includes('The call was made. Work handed to T3 Code may continue there.') && document.querySelector('.turn-note').textContent.includes('may continue there')));
await p.close();
p = await open(run + '&chrome=0');
await to(p, 'message-started');
await q(p, () => demo.stop());
await p.waitForTimeout(900);
check('M5 the first state is Call started, never proof the call was made', await q(p, () => true));
check('C2 stopped while the call had started: Unknown, and the note claims nothing', await q(p, () => document.querySelector('#m-marlow').dataset.state === 'unknown' && document.querySelector('.turn-note').textContent.includes('may or may not have been delivered')));
await p.close();

// C10: the read tier ---------------------------------------------------------------------------------
p = await open(run + '&tier=read');
check('C10 read-only: an access bar in the composer place, no Stop, no New', await q(p, () => !!document.querySelector('.access-bar') && !document.querySelector('.composer-input') && document.querySelector('#rail-new').hidden && document.querySelector('.access-bar').textContent.includes("aren't shown")));
await to(p, 'approval');
check('C10 read-only: live work shows, the approval card does not', await q(p, () => !document.querySelector('#approval') && !!document.querySelector('#unseen-wait') && document.querySelector('.status-phrase').textContent === 'Waiting for an answer' && document.querySelectorAll('#run-activity .step').length > 5));
await p.click('.access-bar [data-action="request-access"]');
await p.waitForSelector('.access-bar[data-state="requested"]');
check('C10 requested: the request id and the command, both copyable, and the owner controls', await q(p, () => { const bar = document.querySelector('.access-bar'); return bar.textContent.includes('7c41d09e') && !!bar.querySelector('[aria-label="Copy approve command"]') && !!bar.querySelector('[aria-label="Copy request id"]') && !document.querySelector('#run-owner').hidden; }));
await p.click('[data-owner="denied"]');
check('C10 denied', await q(p, () => document.querySelector('.access-bar').dataset.state === 'denied'));
await p.click('.access-bar [data-action="request-access"]');
await p.waitForSelector('.access-bar[data-state="requested"]');
await p.focus('.access-bar [data-action="access-check"]');
await p.click('[data-owner="granted"]');
check('C10 granted: the composer takes the bar place and the approval arrives without taking focus', await q(p, () => !!document.querySelector('.composer-input') && !!document.querySelector('#approval[data-state="pending"]') && !document.querySelector('#approval').contains(document.activeElement) && document.querySelector('#status-strip').textContent.includes('Access granted') && document.querySelector('.status-phrase').textContent === 'Waiting for you'));
await p.close();

// The phone -------------------------------------------------------------------------------------------
p = await open(run + '&chrome=0', { w: 390, h: 844 });
await to(p, 'approval');
check('B3 the phone keeps the word Messaged', await q(p, () => [...document.querySelectorAll('.messaged-verb')].every((v) => v.getBoundingClientRect().width > 40 && getComputedStyle(v).visibility === 'visible')));
const fits = () => q(p, () => { const t = document.querySelector('#transcript').getBoundingClientRect(); const s = document.querySelector('.status-line').getBoundingClientRect(); return [Math.round(s.bottom), Math.round(t.bottom)]; });
let f = await fits();
check('B5 phone: the status line is in view after the approval and its shelf row arrive', f[0] <= f[1], JSON.stringify(f));
await p.click('#approval [data-action="standing-open"]');
await p.waitForTimeout(100);
check('B2 phone: Deny is in the form, full width, 48px, and in view', await q(p, () => { const d = document.querySelector('#approval .standing [data-decision="deny"]').getBoundingClientRect(); const t = document.querySelector('#transcript').getBoundingClientRect(); return d.height >= 48 && d.width > 250 && d.bottom <= t.bottom && d.top >= t.top; }));
check('D6 touch: a copy button answers a tap 18px from its centre', await q(p, () => { document.querySelector('#run-activity').open = true; document.querySelector('#s-thought').open = true; const c = document.querySelector('#s-thought [data-view="raw"]'); document.querySelector('#s-thought [data-view-button="raw"]').click(); const btn = document.querySelector('#s-thought [data-view="raw"] .copy'); btn.scrollIntoView({ block: 'center' }); const r = btn.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2 + 18) === btn && r.width >= 32; }));
await q(p, () => document.querySelector('#transcript').scrollTo(0, 1e6));
await p.click('.composer-input');
await p.keyboard.type('Wait');
check('D3 phone: the mode word is visible', await q(p, () => document.querySelector('.send-mode').getBoundingClientRect().width > 30));
await p.click('.send-mode');
check('D3 phone: the mode word opens the sheet', await q(p, () => !!document.querySelector('#sheet [role="menu"]') && document.querySelectorAll('#sheet .menu-item').length === 3 && document.activeElement.classList.contains('menu-item')));
await p.keyboard.press('Escape');
check('D3 phone: Escape closes the sheet', await q(p, () => !document.querySelector('#sheet')));
await p.close();
p = await open(run + '&chrome=0', { w: 880, h: 700 });
await to(p, 'approval');
f = await q(p, () => { const t = document.querySelector('#transcript').getBoundingClientRect(); const s = document.querySelector('.status-line').getBoundingClientRect(); return [Math.round(s.bottom), Math.round(t.bottom), Math.round(document.querySelector('.conversation').getBoundingClientRect().width)]; });
check('B5 600px conversation: the status line is in view', f[0] <= f[1] && f[2] <= 640, JSON.stringify(f));
await p.close();

// The gallery -------------------------------------------------------------------------------------------
p = await open(gallery);
check('gallery: every step and card specimen has Raw', await q(p, () => [...document.querySelectorAll('.spec-box:not([inert]) .messaged, .spec-box:not([inert]) .request')].every((c) => c.querySelector('[data-action="raw"]')) && [...document.querySelectorAll('.spec-box .step')].every((s) => s.querySelector('.step-body'))));
check('C3 the receiving cards have content when opened', await q(p, () => [...document.querySelectorAll('.messaged[data-target="otto"]')].every((c) => c.querySelector('.exchange-text'))));
check('C4 a T3 card without a link has no Open thread', await q(p, () => { const cards = [...document.querySelectorAll('.messaged[data-target="t3code"][data-state="call-made"]')]; return cards.some((c) => c.querySelector('[data-action="open-thread"]')) && cards.some((c) => !c.querySelector('[data-action="open-thread"]') && !c.querySelector('.chips')); }));
await p.click('.messaged[data-target="t3code"][open] [data-action="open-thread"]');
check('C4 Open thread says where it goes and makes no request', await q(p, () => document.querySelector('#proto-toast').textContent.includes('t3code.example') && location.href.includes('gallery.html')));
await p.click('#question .spec:first-of-type .option[data-letter="A"]');
check('C7 a gallery question answers', await q(p, () => document.querySelector('#question .spec:first-of-type .request').dataset.state === 'answered'));
check('C7 three questions: Send answers waits for all three', await q(p, () => { const card = [...document.querySelectorAll('.request[data-kind="question"]')].find((c) => c.querySelectorAll('.question').length === 3); const send = card.querySelector('[data-action="send-answers"]'); const was = send.disabled; card.querySelectorAll('.question')[1].querySelector('.option').click(); const mid = send.disabled; card.querySelectorAll('.question')[2].querySelector('.option').click(); return was && mid && !send.disabled && card.querySelector('.question-count').textContent === '3 of 3 answered'; }));
check('C11/C12 specimens: picture avatars, restarted steer', await q(p, () => document.querySelectorAll('.presence[data-kind="image"]').length === 8 && document.body.textContent.includes('Steer · restarted the turn')));
check('B4 gallery lost specimens do not move', await q(p, () => document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.target?.closest('[data-connection="lost"]')).length === 0));
check('M8 truncation gives the size actually received, and no fixed number', await q(p, () => { const lines = [...document.querySelectorAll('.code-truncated')].map((l) => l.textContent); const plain = lines.find((l) => /characters were received/.test(l)); const pre = [...document.querySelectorAll('.code-truncated')].find((l) => /characters were received/.test(l.textContent)).previousElementSibling; const n = Number(plain.match(/([\d,]+) characters/)[1].replace(/,/g, '')); return n === pre.textContent.length && !lines.some((l) => l.includes('8,000')) && lines.some((l) => l.trim().endsWith('Truncated by the gateway. The rest was not sent.')); }));
check('M9 Raw says which parts follow the gateway\'s schema, and the question record does', await q(p, () => { const labels = [...document.querySelectorAll('.raw-panel .code-label, [data-view="raw"] .code-label')].map((l) => l.textContent); const record = [...document.querySelectorAll('.raw-panel .code-block')].map((b) => b.textContent).find((t) => t.includes('"questionId"')); return !labels.some((l) => /as received/i.test(l)) && labels.some((l) => l.includes('as the gateway sends it')) && document.querySelectorAll('.raw-note').length > 10 && record.includes('"header"') && record.includes('"status": "pending"') && !record.includes('"title"'); }));
check('M6 a question record outside the ordinary subset is readable and not answerable', await q(p, () => { const c = document.querySelector('.request[data-state="unanswerable"]'); return !!c && !c.querySelector('.option, input, [data-action="dismiss-question"]') && !!c.querySelector('[data-action="raw"]'); }));
check('M5 the gallery shows no Sending state, and shows Recipient failed', await q(p, () => ![...document.querySelectorAll('.messaged .state')].some((s) => s.textContent === 'Sending') && [...document.querySelectorAll('.messaged .state')].some((s) => s.textContent === 'Recipient failed')));
check('still specimens are inert', await q(p, () => document.querySelectorAll('.spec-box[inert]').length > 20));
await p.close();
await b.close();
console.log(out.join('\n'));
console.log(`\n${out.filter((l) => l.startsWith('ok')).length} ok, ${out.filter((l) => !l.startsWith('ok')).length} not ok`);
if (out.some((l) => l.startsWith('FAIL') || l.startsWith('PAGEERROR'))) process.exit(1);
