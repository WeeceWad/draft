const assert = require('node:assert/strict');
const path = require('node:path');
const { createServer } = require('../server/index.cjs');
const { MemoryStore } = require('../server/store.cjs');
const packages = process.env.DRAFT_BROWSER_PACKAGES || 'C:/Users/chocc/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const { chromium } = require(require.resolve('playwright', { paths: [packages] }));
(async () => {
  const service = await createServer({ store: new MemoryStore() });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const errors = [];
  try {
    const pages = await Promise.all(Array.from({ length: 3 }, async () => { const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(base); await page.locator('[data-do=setup]').waitFor(); return page; }));
    const [host, guest, third] = pages;
    await host.locator('[data-do=setup]').click(); await host.locator('#host-name').fill('Alex'); await host.locator('#formation').selectOption('4-1-2-1-2 (diamond)');
    await host.locator('#create-form .primary').click(); await host.locator('.big-code').waitFor();
    const code = await host.locator('.big-code').innerText();
    assert(await host.locator('[data-do=start]').isDisabled());
    for (const [page, name] of [[guest, 'Blair'], [third, 'CaseysLegendaryXI1234567']]) { await page.locator('#join-name').fill(name); await page.locator('#join-code').fill(code); await page.locator('#join-form .primary').click(); await page.locator('.big-code').waitFor(); await page.locator('[data-do=ready]').click(); }
    await host.locator('[data-do=ready]').click(); await host.locator('[data-do=start]').click();
    await guest.locator('nav [data-do=tab][data-id=auction]').waitFor();
    assert.equal(await host.locator('#season-from').count(), 0);
    await host.locator('[data-do=reveal]').click(); await host.locator('.spinner').waitFor();
    await host.locator('#bid-value:not([disabled])').waitFor();
    await host.locator('#bid-value').fill('10'); await host.locator('#bid-form .primary').click();
    await guest.waitForFunction(() => document.querySelector('.bid-price')?.textContent === '£10m');
    assert.match(await guest.locator('#timer').innerText(), /0:59|1:00/);
    await guest.locator('#bid-value').fill('12');
    await third.locator('#bid-value').fill('11'); await third.locator('#bid-form .primary').click();
    await guest.waitForFunction(() => document.querySelector('.bid-price')?.textContent === '£11m');
    assert.equal(await guest.locator('#bid-value').inputValue(), '12', 'Remote updates preserve typed bids');
    await guest.locator('#bid-form .primary').click();
    await host.waitForFunction(() => document.querySelector('.bid-price')?.textContent === '£12m');
    assert.match(await host.locator('#timer').innerText(), /1:1[789]|1:20/);
    await host.locator('[data-do=withdraw]').click(); await third.locator('[data-do=withdraw]').click();
    await guest.waitForFunction(() => document.querySelector('.player-card')?.textContent.includes('Blair signed them for'));
    assert.equal(await guest.locator('.budget').innerText(), '£88m');
    await guest.reload(); await guest.locator('nav [data-do=tab][data-id=teams]').click();
    assert.equal(await guest.locator('.squad-player').count(), 1);
    await guest.locator('.squad-player').click(); await guest.locator('.slot').first().click();
    await guest.waitForFunction(() => document.querySelector('.slot .paid')?.textContent === '£12m');
    await host.locator('nav [data-do=tab][data-id=teams]').click(); await host.locator('[data-do=team][data-id=manager-2]').click();
    assert.equal(await host.locator('.slot:disabled').count(), 11);
    assert.equal(await host.locator('.slot .paid').first().innerText(), '£12m');
    await host.locator('#rating-toggle').click(); assert.equal(await host.locator('.small-rating').count(), 0);
    await host.locator('nav [data-do=tab][data-id=transfers]').click(); assert.match(await host.locator('.sale-row').innerText(), /Blair/); assert.equal(await host.locator('.sale-row .rating').count(), 0);
    for (const width of [320, 390, 430, 1440]) for (const screen of ['auction', 'teams', 'transfers', 'league']) {
      await host.setViewportSize({ width, height: 900 }); await host.locator(`nav [data-do=tab][data-id=${screen}]`).click();
      assert(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${screen} must fit ${width}px`);
      if (screen === 'teams') {
        const boxes = await host.locator('.slot').evaluateAll(elements => elements.map(element => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, w: box.width, h: box.height }; }));
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i], b = boxes[j]; assert(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), `Pitch slots overlap at ${width}px`); }
      }
    }
    await host.setViewportSize({ width: 390, height: 844 }); await host.locator('nav [data-do=tab][data-id=auction]').click();
    await host.screenshot({ path: path.resolve(__dirname, '../preview-online-mobile.png'), fullPage: true });
    const id = await host.evaluate(() => localStorage.getItem('touchline-online-room'));
    // Fill remaining squads through validated server rules; exercise XI/league in the UI.
    await service.store.mutate(id, room => {
      const engine = require('../server/room-engine.cjs'), auction = require('../src/auction-core.js'); let now = Date.now();
      while (room.status !== 'complete') {
        room = engine.apply(room, room.hostUid, { type: 'reveal' }, now).room; now += 2000;
        const winner = room.members.find(member => auction.purchases(room.game, member.managerId).length < 11);
        room = engine.apply(room, winner.uid, { type: 'bid', price: 0 }, now).room;
        if (room.round.status === 'open') { now = room.round.deadline; room = engine.apply(room, null, { type: 'tick' }, now).room; }
      }
      return { room, changed: true };
    });
    for (const page of pages) { await page.locator('nav [data-do=tab][data-id=teams]').click(); await page.locator(`[data-do=team][data-id=manager-${pages.indexOf(page) + 1}]`).click(); await page.locator('[data-do=autoPlace]').click(); }
    await host.locator('nav [data-do=tab][data-id=league]').click(); await host.locator('[data-do=startLeague]').click();
    await guest.locator('nav [data-do=tab][data-id=league]').click(); assert.equal(await guest.locator('[data-do=playRound]').count(), 0);
    await host.locator('[data-do=playRound]').click(); await guest.waitForFunction(() => document.querySelector('.fixture .score')?.textContent !== 'vs');
    await host.locator('[data-do=finishLeague]').click(); await guest.waitForFunction(() => document.querySelector('h2')?.textContent.includes('champions'));
    await guest.reload(); await guest.locator('table').waitFor(); assert.equal(await guest.locator('tbody tr').count(), 3);
    for (const width of [320, 390, 430, 1440]) { await guest.setViewportSize({ width, height: 900 }); assert(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); assert(await guest.evaluate(() => document.querySelector('.points').getBoundingClientRect().right <= document.querySelector('.scroll-table').getBoundingClientRect().right + 1), 'Points must stay visible on mobile'); }
    await guest.setViewportSize({ width: 390, height: 844 }); await guest.screenshot({ path: path.resolve(__dirname, '../preview-online-league.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('Online browser passed: three separate managers, live bidding/input retention, withdrawals, reload/rejoin, own-only pitch edits, prices/ratings, mobile layouts and shared full league.');
  } finally { await browser.close(); await service.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
