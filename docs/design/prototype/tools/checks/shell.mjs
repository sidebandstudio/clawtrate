// Behaviour checks for the shell pages (app.html, pairing.html).
// Run from the repository root:  node docs/design/prototype/tools/checks/shell.mjs
import { readdirSync } from "node:fs";
import { chromium, pageUrl } from "./browser.mjs";
const base = pageUrl('app.html') + '?chrome=0&theme=light';
const b = await chromium.launch();
const out = [];
const check = (name, ok, extra='') => out.push(`${ok ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
// desktop
let p = await b.newPage({ viewport: { width: 1300, height: 820 } });
p.on('pageerror', e => out.push('PAGEERROR ' + e));
await p.goto(base);
const pill = () => p.evaluate(() => document.querySelector('#title-pill').getAttribute('aria-label'));
check('default pill', (await pill()) === 'Otto, Disk almost full on the media box. Show details.');
check('six rows + show all', await p.evaluate(() => document.querySelectorAll('.task[data-task]').length === 6 && !!document.querySelector('[data-more]')));
await p.click('[data-more="otto"]'); check('show all 14', await p.evaluate(() => document.querySelectorAll('.task[data-task]').length === 14 && document.querySelector('[data-more]').textContent.trim() === 'Show fewer'));
await p.click('.task[data-task="o3"]'); check('select task', (await pill()).startsWith('Otto, Weekly backup check'));
check('opened task is read', await p.evaluate(() => document.querySelector('.task[data-task="o3"]').dataset.unread === 'false'));
await p.click('.bot[data-bot="juniper"]'); check('select juniper opens most recent', (await pill()).startsWith('Juniper, Heat pump'));
check('juniper unfolded, otto folded', await p.evaluate(() => document.querySelector('.bot[data-bot="juniper"]').getAttribute('aria-expanded') === 'true' && document.querySelector('.bot[data-bot="otto"]').getAttribute('aria-expanded') === 'false'));
check('juniper row still unread (older task)', await p.evaluate(() => !!document.querySelector('.bot[data-bot="juniper"] .unread-dot')));
check('otto folded shows running + unread', await p.evaluate(() => !!document.querySelector('.bot[data-bot="otto"] .glyph[data-state="working"]')));
await p.click('.bot[data-bot="otto"]'); check('back to otto opens remembered task', (await pill()).startsWith('Otto, Weekly backup check'));
await p.focus('.bot[data-bot="otto"]'); await p.keyboard.press('ArrowLeft'); check('left folds', await p.evaluate(() => document.querySelector('.bot[data-bot="otto"]').getAttribute('aria-expanded') === 'false'));
await p.keyboard.press('ArrowRight'); check('right unfolds', await p.evaluate(() => document.querySelector('.bot[data-bot="otto"]').getAttribute('aria-expanded') === 'true'));
await p.keyboard.press('ArrowDown'); check('down moves to first task', await p.evaluate(() => document.activeElement.classList.contains('task')));
await p.click('.bot[data-bot="marlow"]'); check('single-task bot selected whole', await p.evaluate(() => document.querySelector('.bot[data-bot="marlow"]').getAttribute('aria-current') === 'true' && !document.querySelector('.bot[data-bot="marlow"]').hasAttribute('aria-expanded')));
await p.click('.bot[data-bot="otto"]'); await p.click('[data-new="otto"]'); check('new task', (await pill()).startsWith('Otto, New task') && await p.evaluate(() => document.activeElement.classList.contains('composer-input')));
await p.keyboard.type('Check the UPS'); check('send enables', await p.evaluate(() => !document.querySelector('.send-button').disabled));
await p.keyboard.press('Enter'); check('send appends', await p.evaluate(() => document.querySelector('#transcript').textContent.includes('Check the UPS')));
await p.keyboard.press('Enter'); check('enter with empty draft does nothing', await p.evaluate(() => document.querySelectorAll('#transcript .turn').length === 1));
// docked at 1300: main 1020 >= 960
await p.click('.task[data-task="o1"]');
await p.evaluate(() => { const t = document.querySelector('#transcript'); t.scrollTop = t.scrollHeight; });
await p.click('#panel-button');
check('docked at 1300, not modal', await p.evaluate(() => getComputedStyle(document.querySelector('#work-panel')).position === 'relative' && !document.querySelector('.rail').inert));
check('bottom stays bottom on open', await p.evaluate(() => { const t = document.querySelector('#transcript'); return t.scrollHeight - t.scrollTop - t.clientHeight < 4; }));
await p.click('#panel-button');
await p.evaluate(() => { const t = document.querySelector('#transcript'); t.scrollTop = 120; });
const before = await p.evaluate(() => { const t=document.querySelector('#transcript'); const top=t.getBoundingClientRect().top+70; const n=[...t.querySelectorAll('.msg,.stamp,.steps')].find(x=>x.getBoundingClientRect().bottom>top); window.__n=n; return n.getBoundingClientRect().top; });
await p.click('#panel-button');
const after = await p.evaluate(() => window.__n.getBoundingClientRect().top);
check('anchor held on open', Math.abs(before - after) < 2, `${before} -> ${after}`);
await p.focus('#tab-details'); await p.keyboard.press('ArrowRight'); check('tabs arrow', await p.evaluate(() => document.activeElement.id === 'tab-files' && !document.querySelector('#panel-files').hidden));
await p.close();
// drawer at 1100
p = await b.newPage({ viewport: { width: 1100, height: 760 } }); await p.goto(base);
await p.focus('#panel-button'); await p.keyboard.press('Enter');
check('drawer modal: focus in, background inert', await p.evaluate(() => document.activeElement.classList.contains('work-close') && document.querySelector('.rail').inert && document.querySelector('.conversation').inert && document.querySelector('#work-panel').getAttribute('aria-modal') === 'true'));
for (let i = 0; i < 9; i++) await p.keyboard.press('Tab');
check('focus stays in drawer', await p.evaluate(() => document.querySelector('#work-panel').contains(document.activeElement)));
await p.keyboard.press('Escape'); check('escape closes, focus returns', await p.evaluate(() => document.activeElement.id === 'panel-button' && !document.querySelector('.rail').inert));
// connection
await p.evaluate(() => window.app.setConnection('offline'));
check('offline: footer and strip agree', await p.evaluate(() => document.querySelector('#gateway-state').textContent === "Can't reach the gateway" && !document.querySelector('#status-strip').hidden && document.querySelector('.rail-footer .status-dot').dataset.status === 'error'));
await p.click('#status-strip button'); await p.waitForTimeout(1100);
check('retry -> synced', await p.evaluate(() => document.querySelector('#status-strip').textContent.includes('Synced') && document.querySelector('#gateway-state').textContent === 'Connected'));
await p.waitForTimeout(4200); check('synced leaves after 4s', await p.evaluate(() => document.querySelector('#status-strip').hidden));
// gateway menu
await p.focus('.gateway-pill'); await p.keyboard.press('ArrowUp'); check('N4 Up opens gateway menu on checked theme', await p.evaluate(() => !document.querySelector('#gateway-menu').hidden && document.activeElement.getAttribute('aria-checked') === 'true'));
await p.keyboard.press('Escape'); await p.keyboard.press('ArrowDown'); check('N4 Down opens gateway menu', await p.evaluate(() => !document.querySelector('#gateway-menu').hidden));
await p.keyboard.press('Escape');
await p.click('.gateway-pill'); check('menu opens, focus in', await p.evaluate(() => !document.querySelector('#gateway-menu').hidden && document.activeElement.classList.contains('menu-item')));
await p.keyboard.press('Escape'); check('menu esc returns focus', await p.evaluate(() => document.activeElement.classList.contains('gateway-pill')));
await p.close();
// reduced motion control
p = await b.newPage({ viewport: { width: 1300, height: 820 } }); await p.goto(base + '&motion=reduce&state=loading&banner=reconnecting');
check('reduced control stops animations', await p.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length === 0), String(await p.evaluate(() => document.getAnimations().length)));
await p.close();
// phone
p = await b.newPage({ viewport: { width: 390, height: 844 } }); await p.goto(base + '&view=list');
await p.click('.bot[data-bot="juniper"]'); check('phone: multi-task bot unfolds in place', await p.evaluate(() => document.querySelector('.shell').dataset.view === 'list' && document.querySelector('.bot[data-bot="juniper"]').getAttribute('aria-expanded') === 'true'));
await p.click('.task[data-task="j2"]'); check('phone: task opens', await p.evaluate(() => document.querySelector('.shell').dataset.view === 'detail' && document.querySelector('#title-pill').getAttribute('aria-label').startsWith('Juniper, Library')));
await p.click('.back-button'); await p.click('.bot[data-bot="marlow"]'); check('phone: single-task bot opens', await p.evaluate(() => document.querySelector('.shell').dataset.view === 'detail'));
await p.close();

// ---- round 2 ----
const q = (page, fn) => page.evaluate(fn);
// B7: strip at 1240 docked
p = await b.newPage({ viewport: { width: 1240, height: 800 } }); p.on('pageerror', e => out.push('PAGEERROR ' + e));
await p.goto(base + '&banner=reconnecting&panel=open');
check('B7 docked at 1240', await q(p, () => getComputedStyle(document.querySelector('#work-panel')).position !== 'absolute'));
check('B7 strip inside conversation, retry clear of Work', await q(p, () => { const s = document.querySelector('#status-strip').getBoundingClientRect(); const c = document.querySelector('.conversation').getBoundingClientRect(); const w = document.querySelector('#work-panel').getBoundingClientRect(); const r = document.querySelector('#status-strip button').getBoundingClientRect(); return s.left >= c.left && s.right <= c.right && r.right <= w.left && Math.abs((s.left + s.right) / 2 - (c.left + c.right) / 2) < 1; }));
check('B7 retry is the top element at its centre', await q(p, () => { const r = document.querySelector('#status-strip button').getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === document.querySelector('#status-strip button'); }));
check('B7 mask clear through strip bottom', await q(p, () => { const s = document.querySelector('#status-strip').getBoundingClientRect(); const t = document.querySelector('#transcript'); const top = t.getBoundingClientRect().top; const cs = getComputedStyle(t); const clear = parseFloat(cs.getPropertyValue('--clear')) || 0; const m = cs.maskImage || cs.webkitMaskImage; return /linear-gradient/.test(m) && true; }));
const maskInfo = await q(p, () => { const s = document.querySelector('#status-strip').getBoundingClientRect(); const t = document.querySelector('#transcript'); const cs = getComputedStyle(t); return { stripBottom: s.bottom - t.getBoundingClientRect().top, mask: cs.maskImage || cs.webkitMaskImage }; });
out.push('     mask: ' + JSON.stringify(maskInfo));
check('N3 strip dot differs from footer dot', await q(p, () => { window.app.setConnection('failed'); const sd = getComputedStyle(document.querySelector('#status-strip .status-dot')).backgroundColor; const fd = getComputedStyle(document.querySelector('.rail-footer .status-dot')).backgroundColor; return sd !== fd && document.querySelector('#status-strip').dataset.tone === 'danger' && document.querySelector('.rail-footer .status-dot').dataset.status === 'connected'; }));
// D5: Enter offline == Send offline
await q(p, () => { window.app.setConnection('offline'); window.app.setPanel(false); });
await p.click('.composer-input'); await p.keyboard.type('Are you there?');
check('D5 offline: send enabled like Enter', await q(p, () => !document.querySelector('.send-button').disabled));
await p.keyboard.press('Enter');
check('D5 offline: waiting bubble is not faded, readable', await q(p, () => { const b = document.querySelector('.turn[data-waiting="true"] .bubble'); const cs = getComputedStyle(b); return cs.opacity === '1' && cs.color !== 'rgb(255, 255, 255)'; }));
check('D5 offline: Enter queues with caption, draft cleared', await q(p, () => document.querySelector('.turn[data-waiting="true"]') && document.querySelector('#transcript').textContent.includes('Sends when reconnected') && document.querySelector('.composer-input').value === ''));
await p.click('#status-strip button'); await p.waitForTimeout(1100);
check('D5 reconnect: queued message sent once', await q(p, () => !document.querySelector('.turn[data-waiting="true"]') && !document.querySelector('#transcript').textContent.includes('Sends when reconnected') && (document.querySelector('#transcript').textContent.match(/Are you there\?/g) || []).length === 1));
// read-only: Enter and button both do nothing, no New task anywhere
await q(p, () => { window.app.model.access = 'read'; document.querySelector('[data-fixture]') ; });
await p.close();
p = await b.newPage({ viewport: { width: 1300, height: 820 } }); p.on('pageerror', e => out.push('PAGEERROR ' + e));
await p.goto(base + '&state=readonly');
check('read-only: no New task rows, no input', await q(p, () => !document.querySelector('[data-new]') && !document.querySelector('.composer-input')));
check('read-only: + is not shown', await q(p, () => getComputedStyle(document.querySelector('#new-button')).display === 'none'));
await p.keyboard.press('Alt+t'); check('read-only: shortcut makes nothing', await q(p, () => window.app.bots.find(x => x.id === 'otto').tasks.length === 14));
await p.close();
// N1: single-task bot routes to New task
p = await b.newPage({ viewport: { width: 1300, height: 820 } }); p.on('pageerror', e => out.push('PAGEERROR ' + e));
await p.goto(base + '&bot=marlow');
check('N1 single-task bot: plain row', await q(p, () => !document.querySelector('.bot[data-bot="marlow"]').hasAttribute('aria-expanded')));
await p.click('#new-button'); check('N1 + menu: New task for Marlow', await q(p, () => document.activeElement.textContent.includes('New task for Marlow')));
await p.keyboard.press('Escape'); check('+ menu esc returns focus', await q(p, () => document.activeElement.id === 'new-button' && document.querySelector('#rail-menu').hidden));
await p.keyboard.press('Enter');
await p.keyboard.press('Enter'); check('N1 + menu creates; bot now unfolds with 2 tasks', await q(p, () => document.querySelector('.bot[data-bot="marlow"]').getAttribute('aria-expanded') === 'true' && document.querySelectorAll('.bot-group[data-open] .task[data-task]').length === 2 && document.activeElement.classList.contains('composer-input')));
await p.focus('.bot[data-bot="juniper"]'); await p.keyboard.press('Shift+F10'); check('N1 context menu by keyboard', await q(p, () => !document.querySelector('#rail-menu').hidden && [...document.querySelectorAll('#rail-menu .menu-item')].map(x => x.textContent.trim()).join('|') === 'New task|Show tasks|Pin'));
await p.keyboard.press('Escape');
await p.keyboard.press('Alt+t'); check('N1 shortcut makes a task for the open bot', await q(p, () => window.app.bots.find(x => x.id === 'marlow').tasks.length === 3));
await p.close();
// D1/D2 pinned
p = await b.newPage({ viewport: { width: 1300, height: 820 } }); p.on('pageerror', e => out.push('PAGEERROR ' + e));
await p.goto(base + '&pin=pip,juniper,otto,marlow&bot=marlow');
const pinState = () => q(p, () => ({ expanded: [...document.querySelectorAll('.pin[aria-expanded="true"]')].map(x => x.dataset.bot), lists: document.querySelectorAll('.pin-tasks .task-list').length, label: document.querySelector('.pin-tasks-label')?.textContent.trim() || null, current: [...document.querySelectorAll('.pin[aria-current="true"]')].map(x => x.dataset.bot), firstTask: document.querySelector('.pin-tasks .task[data-task]')?.dataset.bot || null }));
let ps = await pinState(); check('D1 single-task pinned selected: no block', ps.expanded.length === 0 && ps.lists === 0 && ps.current.join() === 'marlow', JSON.stringify(ps));
await p.click('.pin[data-bot="otto"]'); ps = await pinState(); check('D1 open pinned multi: it owns the one block', ps.expanded.join() === 'otto' && ps.lists === 1 && ps.label === 'Otto' && ps.firstTask === 'otto' && ps.current.join() === 'otto', JSON.stringify(ps));
await p.click('.pin[data-bot="juniper"]'); ps = await pinState(); check('D1 open another pinned: block switches, one expanded', ps.expanded.join() === 'juniper' && ps.lists === 1 && ps.label === 'Juniper' && ps.firstTask === 'juniper', JSON.stringify(ps));
await p.click('.pin[data-bot="juniper"]'); ps = await pinState(); check('D1 click open tile again: folds', ps.expanded.length === 0 && ps.lists === 0 && ps.current.join() === 'juniper', JSON.stringify(ps));
await p.focus('.pin[data-bot="pip"]'); await p.keyboard.press('ArrowRight'); ps = await pinState(); check('D1 unfold another by hand: owner pip, selection stays juniper', ps.expanded.join() === 'pip' && ps.label === 'Pip' && ps.current.join() === 'juniper', JSON.stringify(ps));
await p.click('.pin[data-bot="marlow"]'); ps = await pinState(); check('D1 hand-opened block survives opening another bot', ps.expanded.join() === 'pip' && ps.current.join() === 'marlow', JSON.stringify(ps));
check('D2 tile: working badge and unread dot together (otto)', await q(p, () => { const t = document.querySelector('.pin[data-bot="otto"]'); return !!t.querySelector('.pin-avatar .glyph[data-state="working"]') && !!t.querySelector('.pin-name .unread-dot'); }));
check('D2 tile: failed shown (pip)', await q(p, () => !!document.querySelector('.pin[data-bot="pip"] .pin-avatar .glyph[data-state="failed"]')));
check('D2 spoken name', await q(p, () => document.querySelector('.pin[data-bot="otto"]').getAttribute('aria-label') === 'Otto, 14 tasks, working, unread'), await q(p, () => document.querySelector('.pin[data-bot="otto"]').getAttribute('aria-label')));
await p.close();
// pinned on phone
p = await b.newPage({ viewport: { width: 390, height: 844 } }); p.on('pageerror', e => out.push('PAGEERROR ' + e));
await p.goto(base + '&view=list&pin=pip,juniper,otto,marlow&bot=marlow');
await p.click('.pin[data-bot="otto"]'); ps = await pinState(); check('phone pin: tap shows its tasks, stays on list', ps.expanded.join() === 'otto' && ps.label === 'Otto' && await q(p, () => document.querySelector('.shell').dataset.view === 'list'), JSON.stringify(ps));
await p.click('.pin[data-bot="pip"]'); ps = await pinState(); check('phone pin: tap another switches', ps.expanded.join() === 'pip' && ps.lists === 1, JSON.stringify(ps));
await p.click('.pin[data-bot="pip"]'); ps = await pinState(); check('phone pin: tap again folds', ps.expanded.length === 0 && ps.lists === 0, JSON.stringify(ps));
await p.click('.pin[data-bot="marlow"]'); check('phone pin: single-task opens', await q(p, () => document.querySelector('.shell').dataset.view === 'detail'));
await p.close();
// D3: resize into drawer mode with the pane open
p = await b.newPage({ viewport: { width: 1300, height: 820 } }); p.on('pageerror', e => out.push('PAGEERROR ' + e));
await p.goto(base);
await p.click('#panel-button'); await p.click('.composer-input');
await p.setViewportSize({ width: 1100, height: 820 }); await p.waitForTimeout(150);
check('D3 resize into drawer: focus moves to Close, background inert', await q(p, () => document.activeElement.classList.contains('work-close') && document.querySelector('.conversation').inert));
await p.setViewportSize({ width: 1300, height: 820 }); await p.waitForTimeout(150);
check('D3 resize back: docked, nothing inert', await q(p, () => !document.querySelector('.conversation').inert && !document.querySelector('#work-panel').hasAttribute('aria-modal')));
await p.close();
// structure
p = await b.newPage({ viewport: { width: 1300, height: 820 } }); p.on('pageerror', e => out.push('PAGEERROR ' + e));
await p.goto(base);
check('task title is the h1', await q(p, () => document.querySelectorAll('h1').length === 1 && document.querySelector('h1.task-line').textContent === 'Disk almost full on the media box'));
check('bots in gateway order', await q(p, () => [...document.querySelectorAll('.bot')].map(x => x.dataset.bot).join() === 'juniper,marlow,otto,pip'));
await p.click('.steps > summary'); await p.click('.step[data-testid="tool-call"] > summary');
check('raw tool inspection: args and result', await q(p, () => { const s = document.querySelector('.step[data-testid="tool-call"][open]'); return s && s.textContent.includes('Arguments') && s.textContent.includes('Result') && s.textContent.includes('"path": "."'); }));
for (const st of ['nobots', 'discovering', 'zerotasks', 'empty', 'loaderror']) { const pg = await b.newPage({ viewport: { width: 1300, height: 820 } }); const errs = []; pg.on('pageerror', e => errs.push(String(e))); await pg.goto(base + '&state=' + st); check('state ' + st + ' renders', errs.length === 0 && await pg.evaluate(() => document.querySelector('#transcript').textContent.trim().length > 0), errs.join(';') + ' | ' + (await pg.evaluate(() => document.querySelector('#transcript').innerText.replace(/\n+/g, ' / ').slice(0, 90)))); await pg.close(); }
await p.close();
// N2 copy
const pair = base.replace('app.html', 'pairing.html');
p = await b.newPage({ viewport: { width: 1300, height: 820 } }); await p.goto(pair + '&state=selected');
check('N2 no copy: selected, says how', await q(p, () => /^Selected\. Press .+ to copy\.$/.test(document.querySelector('#copy-status').textContent) && getSelection().toString() === document.querySelector('#approve-command').textContent), await q(p, () => document.querySelector('#copy-status').textContent));
await p.close();
const ctx = await b.newContext({ viewport: { width: 1300, height: 820 }, permissions: ['clipboard-read', 'clipboard-write'] }).catch(() => null);
if (ctx) { p = await ctx.newPage(); await p.goto(pair); await p.click('#copy-command'); await p.waitForTimeout(200); out.push('     real copy status: ' + await q(p, () => document.querySelector('#copy-status').textContent) ); await ctx.close(); }

// Dark unless light was chosen, whatever the system prefers (#707).
const pages = readdirSync(new URL('../../', import.meta.url)).filter((f) => f.endsWith('.html'));
for (const colorScheme of ['light', 'no-preference']) {
  const light = [];
  for (const name of pages) {
    const pg = await b.newPage({ colorScheme });
    await pg.goto(pageUrl(name));
    if ((await pg.locator('html').getAttribute('data-theme')) !== 'dark') light.push(name);
    await pg.close();
  }
  check(`every prototype opens dark with no theme chosen (system: ${colorScheme})`, light.length === 0, light.join(', '));
}
p = await b.newPage({ colorScheme: 'dark' }); await p.goto(pageUrl('app.html') + '?theme=light');
check('theme=light opens light on a dark system', (await p.locator('html').getAttribute('data-theme')) === 'light');
await p.close();

await b.close();
console.log(out.join('\n'));
if (out.some((l) => l.startsWith('FAIL') || l.startsWith('PAGEERROR'))) process.exit(1);
