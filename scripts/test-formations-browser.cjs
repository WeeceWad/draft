const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const packages = process.env.DRAFT_BROWSER_PACKAGES || 'C:/Users/chocc/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const { chromium } = require(require.resolve('playwright', { paths: [packages] }));
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.wheelLabels = [];
      const fillText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (label, ...args) {
        if (this.canvas.id === 'wheel') window.wheelLabels.push(label);
        return fillText.call(this, label, ...args);
      };
    });
    await page.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href);
    const formations = await page.locator('#setup-formation option').evaluateAll(options => options.map(option => option.value));
    assert.equal(formations.length, 20);
    await page.locator('#start').click();
    assert.deepEqual(await page.evaluate(() => [...new Set(wheelLabels)]), ['?'], 'Wheel must never draw player names');
    await page.locator('#spin').click();
    assert(await page.locator('#player-card').isHidden());
    assert.equal(await page.locator('#reveal-name').textContent(), '', 'Identity is withheld during animation');
    const playerName = await page.evaluate(() => {
      const game = JSON.parse(localStorage.getItem('touchline-auction-v1')).game;
      return DRAFT_GAME_DATA.players.find(player => player.id === game.currentId).name;
    });
    assert(!(await page.locator('body').innerText()).includes(playerName));
    await page.locator('#bid-form').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#reveal-name').textContent(), playerName);
    assert.deepEqual(await page.evaluate(() => [...new Set(wheelLabels)]), ['?']);
    await page.screenshot({ path: path.resolve(__dirname, '../preview-mystery-reveal-mobile.png'), fullPage: true });

    // Use genuinely bought and compatible players to measure every fully filled XI.
    for (const formation of formations) {
      await page.evaluate(formation => {
        const config = { managerCount: 3, names: ['Alex', 'Sam', 'Charlie'], formation, mode: 'peak', seasonFrom: '1992/93', seasonTo: '2026/27', ratingMin: 40, ratingMax: 95 };
        const pool = AuctionCore.makePool(DRAFT_GAME_DATA.players, config).pool;
        let game = AuctionCore.createGame(config, pool);
        const used = new Set();
        for (const manager of game.managers) {
          DraftCore.formations[formation].forEach((slot, index) => {
            const entry = pool.find(entry => !used.has(entry.id) && entry.allocatedPosition === slot.position);
            used.add(entry.id);
            game = AuctionCore.buy({ ...game, phase: 'revealed', currentId: entry.id }, manager.id, 10).game;
            game = AuctionCore.place(game, manager.id, entry.id, index).game;
          });
        }
        localStorage.setItem('touchline-auction-v1', JSON.stringify({ game: AuctionCore.serialise(game), showRatings: true, selectedManager: 'manager-1', view: 'teams' }));
      }, formation);
      await page.reload(); await page.locator('#resume').click();
      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        const issues = await page.evaluate(() => {
          const pitch = document.getElementById('pitch').getBoundingClientRect();
          const slots = [...document.querySelectorAll('.slot-button')].map(element => ({ position: element.querySelector('.slot-position').textContent, rect: element.getBoundingClientRect() }));
          const issues = [];
          if (document.documentElement.scrollWidth > innerWidth) issues.push('horizontal overflow');
          for (const [i, slot] of slots.entries()) {
            if (slot.rect.left < pitch.left - 1 || slot.rect.right > pitch.right + 1 || slot.rect.top < pitch.top - 1 || slot.rect.bottom > pitch.bottom + 1) issues.push(`${i} ${slot.position} clipped`);
            for (const [j, other] of slots.entries()) if (j > i) {
              const overlapX = Math.min(slot.rect.right, other.rect.right) - Math.max(slot.rect.left, other.rect.left);
              const overlapY = Math.min(slot.rect.bottom, other.rect.bottom) - Math.max(slot.rect.top, other.rect.top);
              if (overlapX > 1 && overlapY > 1) issues.push(`${i} ${slot.position} overlaps ${j} ${other.position} (${overlapX.toFixed(1)} x ${overlapY.toFixed(1)})`);
            }
          }
          return issues;
        });
        assert.deepEqual(issues, [], `${formation} at ${width}px`);
      }
      if (formation === '4-1-2-1-2 (diamond)') {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: path.resolve(__dirname, '../preview-diamond-mobile.png'), fullPage: true });
      }
    }
    await page.locator('#open-settings').click(); await page.locator('#start').click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.resolve(__dirname, '../preview-mystery-wheel-mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('Browser checks passed: mystery wheel hides identities during the spin, plus all 20 fully filled formations at 320/390/1440px without overlap or clipping.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
