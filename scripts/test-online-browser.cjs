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
    await host.locator('[data-do=setup]').click(); await host.locator('#host-name').fill('Alex'); await host.locator('#formation').selectOption('4-1-2-1-2 (diamond)'); assert.equal(await host.locator('#capacity').inputValue(), '2', 'Rooms default to two managers'); await host.locator('#capacity').selectOption('3');
    await host.locator('#create-form .primary').click(); await host.locator('.big-code').waitFor();
    const code = await host.locator('.big-code').innerText();
    assert(await host.locator('[data-do=start]').isDisabled());
    for (const [page, name] of [[guest, 'Blair'], [third, 'CaseysLegendaryXI1234567']]) { await page.locator('#join-name').fill(name); await page.locator('#join-code').fill(code); await page.locator('#join-form .primary').click(); await page.locator('.big-code').waitFor(); await page.locator('[data-do=ready]').click(); }
    // The host edits the rules in the lobby; guests see them and ready up again.
    await host.locator('#rules-form #formation').selectOption('4-4-2'); await host.locator('#rules-form .primary').click();
    await guest.waitForFunction(() => document.querySelector('.rules')?.textContent.includes('4-4-2'));
    assert.match(await guest.locator('[data-do=ready]').innerText(), /I’m ready/);
    await host.locator('#rules-form #formation').selectOption('4-1-2-1-2 (diamond)'); await host.locator('#rules-form .primary').click();
    await guest.waitForFunction(() => document.querySelector('.rules')?.textContent.includes('diamond'));
    for (const page of [guest, third]) await page.locator('[data-do=ready]').click();
    await host.locator('[data-do=ready]').click(); await host.locator('[data-do=start]').click();
    await guest.locator('nav [data-do=tab][data-id=auction]').waitFor();
    assert.equal(await host.locator('#season-from').count(), 0);
    await host.locator('[data-do=reveal]').click(); await host.locator('.spinner').waitFor();
    await host.locator('#bid-value:not([disabled])').waitFor();
    await guest.locator('#bid-value:not([disabled])').waitFor();
    assert(await guest.locator('.player-symbol').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Position text fits its badge');
    await guest.locator('#bid-value').fill('10'); await guest.locator('#bid-form .primary').click();
    await host.waitForFunction(() => document.querySelector('.bid-price')?.textContent === '£10m');
    assert.match(await host.locator('#timer').innerText(), /0:59|1:00/);
    assert.equal(await host.locator('#bid-value').inputValue(), '11', 'The bid box moves to £1m above the highest bid');
    assert(await guest.locator('[data-do=withdraw]').isDisabled(), 'Bidders are locked in');
    assert.match(await guest.locator('[data-do=withdraw]').innerText(), /Locked in/);
    await host.locator('#bid-value').fill('12');
    await third.locator('[data-do=withdraw]').click();
    await host.waitForFunction(() => document.querySelector('.bidders')?.textContent.includes('Out'));
    assert.equal(await host.locator('#bid-value').inputValue(), '12', 'Remote updates preserve typed bids');
    await host.locator('[data-do=withdraw]').click();
    await guest.waitForFunction(() => document.querySelector('.player-card')?.textContent.includes('Blair signed them for'));
    assert.equal(await guest.locator('.budget').innerText(), '£990m');
    // A fresh visit offers to rejoin instead of jumping into the saved room; a refresh stays in it.
    const fresh = await guest.context().newPage(); await fresh.goto(base); await fresh.locator('.resume-card').waitFor();
    assert.equal(await fresh.locator('nav.tabs').count(), 0, 'A new visit lands on the home screen');
    assert.match(await fresh.locator('.resume-card').innerText(), new RegExp(code));
    await fresh.locator('[data-do=resume]').click(); await fresh.locator('nav.tabs').waitFor(); await fresh.close();
    await guest.reload(); await guest.locator('nav [data-do=tab][data-id=teams]').click();
    assert.equal(await guest.locator('.squad-player').count(), 1); assert.equal(await guest.locator('.squad-group').count(), 1);
    await guest.locator('.slot').first().click(); await guest.locator('.pick-prompt').waitFor(); await guest.locator('.squad-player').click();
    await guest.waitForFunction(() => document.querySelector('.slot .paid')?.textContent === '£10m');
    await guest.locator('[data-do=clearBoard]').click();
    await guest.waitForFunction(() => !document.querySelector('.slot .paid'));
    await guest.locator('.squad-player').dragTo(guest.locator('.slot').first());
    await guest.waitForFunction(() => document.querySelector('.slot .paid')?.textContent === '£10m');
    await host.locator('nav [data-do=tab][data-id=teams]').click(); await host.locator('[data-do=team][data-id=manager-2]').click();
    assert.equal(await host.locator('.slot:disabled').count(), 11);
    assert.equal(await host.locator('.slot .paid').first().innerText(), '£10m');
    assert(await guest.locator('#rating-toggle').isHidden(), 'Only the host can change rating visibility');
    await host.locator('#rating-toggle').click(); await host.waitForFunction(() => !document.querySelector('.small-rating'));
    await guest.waitForFunction(() => !document.querySelector('.small-rating'));
    await host.locator('nav [data-do=tab][data-id=transfers]').click(); assert.match(await host.locator('.sale-row').innerText(), /Blair/); assert.equal(await host.locator('.sale-row .rating').count(), 0);
    await host.locator('nav [data-do=tab][data-id=auction]').click();
    const skippedNames = [];
    for (let index = 0; index < 2; index++) {
      await host.locator('[data-do=reveal]').click(); await host.locator('#bid-value:not([disabled])').waitFor();
      const name = await host.locator('.player-card h2').innerText();
      assert(!skippedNames.includes(name)); skippedNames.push(name);
      if (index === 0) {
        for (const page of pages) { await page.locator('nav [data-do=tab][data-id=auction]').click(); await page.locator('[data-do=withdraw]').click(); }
      } else await host.locator('[data-do=skip]').click();
      await host.locator('[data-skipped]').nth(index).waitFor();
      assert.deepEqual(await host.locator('[data-skipped] strong').allTextContents(), skippedNames);
    }
    await guest.reload(); await guest.locator('#skipped-players').waitFor();
    assert.deepEqual(await guest.locator('[data-skipped] strong').allTextContents(), skippedNames);
    assert.equal(await host.locator('#skipped-players .rating').count(), 0, 'Hidden ratings stay hidden in the queue');
    await host.screenshot({ path: path.resolve(__dirname, '../preview-skipped-mobile.png'), fullPage: true });
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
    // Finish new players only, so the queued returns can be auctioned through the UI.
    await service.store.mutate(id, room => {
      const engine = require('../server/room-engine.cjs'), auction = require('../src/auction-core.js'); let now = Date.now();
      while (room.game.remaining.some(playerId => !room.game.skipped.includes(playerId))) {
        room = engine.apply(room, room.hostUid, { type: 'reveal' }, now).room; now += 2000;
        const active = engine.view(room, room.hostUid).round.active, winner = room.members.filter(member => active.includes(member.managerId)).sort((a, b) => auction.purchases(room.game, a.managerId).length - auction.purchases(room.game, b.managerId).length)[0];
        room = engine.apply(room, winner.uid, { type: 'bid', price: 1 }, now).room;
        if (room.round.status === 'open') { now = room.round.deadline; room = engine.apply(room, null, { type: 'tick' }, now).room; }
      }
      return { room, changed: true };
    });
    await host.locator('[data-do=reveal]').waitFor();
    assert.match(await host.locator('[data-do=reveal]').innerText(), /skipped player/);
    await host.locator('[data-do=reveal]').click(); await host.locator('.player-card .eyebrow').filter({ hasText: 'BACK FOR BIDDING' }).waitFor();
    assert.equal(await host.locator('.player-card h2').innerText(), skippedNames[0]);
    assert.equal(await host.locator('.player-card .eyebrow').innerText(), 'BACK FOR BIDDING');
    assert.equal(await host.locator('#timer').innerText(), 'Waiting');
    // Re-skipping rotates the queue and the other skipped player gets their turn.
    await host.locator('[data-do=skip]').click();
    assert.deepEqual(await host.locator('[data-skipped] strong').allTextContents(), [skippedNames[1], skippedNames[0]]);
    for (const name of [skippedNames[1], skippedNames[0]]) {
      await host.locator('[data-do=reveal]').click(); await host.locator('.player-card .eyebrow').filter({ hasText: 'BACK FOR BIDDING' }).waitFor();
      assert.equal(await host.locator('.player-card h2').innerText(), name);
      const current = await service.store.get(id), active = require('../server/room-engine.cjs').view(current, current.hostUid).round.active, winner = current.members.find(member => active.includes(member.managerId));
      const page = pages[current.members.indexOf(winner)];
      await page.locator('#bid-value:not([disabled])').waitFor(); await page.locator('#bid-value').fill('1'); await page.locator('#bid-form .primary').click();
      for (const other of pages.filter((_, index) => current.members[index].managerId !== winner.managerId && active.includes(current.members[index].managerId))) await other.locator('[data-do=withdraw]').click();
      await host.waitForFunction(() => document.querySelector('.player-card')?.textContent.includes('signed them for'));
    }
    assert.equal(await host.locator('#skipped-players').count(), 0);
    for (const page of pages) { await page.locator('nav [data-do=tab][data-id=teams]').click(); await page.locator(`[data-do=team][data-id=manager-${pages.indexOf(page) + 1}]`).click(); await page.locator('[data-do=autoPlace]').click(); }
    await host.locator('nav [data-do=tab][data-id=league]').click(); await host.locator('[data-do=startLeague]').click();
    await guest.locator('nav [data-do=tab][data-id=league]').click(); assert.equal(await guest.locator('[data-do=playRound]').count(), 0);
    await host.locator('[data-do=playRound]').click(); await guest.locator('#live-matchday').waitFor();
    assert(await host.locator('[data-do=playRound]').isDisabled(), 'The next matchday waits for the live one');
    await guest.waitForFunction(() => /^[1-9]\d?′$/.test(document.querySelector('.live-minute')?.textContent || ''));
    await host.locator('[data-do=finishLeague]').click(); await guest.waitForFunction(() => document.querySelector('h2')?.textContent.includes('champions'));
    await guest.reload(); await guest.locator('table').waitFor(); assert.equal(await guest.locator('tbody tr').count(), 3);
    for (const width of [320, 390, 430, 1440]) { await guest.setViewportSize({ width, height: 900 }); assert(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); assert(await guest.evaluate(() => document.querySelector('.points').getBoundingClientRect().right <= document.querySelector('.scroll-table').getBoundingClientRect().right + 1), 'Points must stay visible on mobile'); }
    await guest.setViewportSize({ width: 390, height: 844 }); await guest.screenshot({ path: path.resolve(__dirname, '../preview-online-league.png'), fullPage: true });
    // End-of-season summary, then a rematch lobby with a new code for everyone.
    assert.match(await guest.locator('.summary-hero').innerText(), /champions/);
    assert.equal(await guest.locator('.summary-team').count(), 3);
    await host.locator('nav [data-do=tab][data-id=summary]').click(); await host.locator('[data-do=rematch]').click(); await host.locator('.big-code').waitFor();
    const newCode = await host.locator('.big-code').innerText();
    assert.notEqual(newCode, code); assert(host.url().endsWith(`?code=${newCode}`));
    // Everyone else follows the rematch into the new lobby automatically.
    await guest.locator('.big-code').filter({ hasText: newCode }).waitFor(); await third.locator('.big-code').filter({ hasText: newCode }).waitFor();
    assert.equal(await host.locator('.member').count(), 3);
    assert.equal(await guest.locator('.big-code').innerText(), newCode);
    // Opening the new invite link swaps the old finished room for the fresh lobby.
    await third.goto(`${base}/?code=${newCode}`); await third.locator('.big-code').waitFor();
    assert.equal(await third.locator('.big-code').innerText(), newCode); assert.equal(await third.locator('.member').count(), 3);
    await third.reload(); await third.locator('.big-code').waitFor(); assert.equal(await third.locator('.big-code').innerText(), newCode);
    await third.locator('.room-head ~ details summary, details summary.hint').first().click(); await third.locator('[data-do=leave]').click();
    await third.locator('#join-form').waitFor(); assert(third.url().endsWith('/'));
    await guest.screenshot({ path: path.resolve(__dirname, '../preview-online-rematch.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('Online browser passed: three separate managers, live bidding/input retention, withdrawals, reload/rejoin, own-only pitch edits, prices/ratings, mobile layouts and shared full league.');
  } finally { await browser.close(); await service.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
