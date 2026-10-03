const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/auction-core.js');
const draft = require('../src/draft-core.js');
const players = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/38-0/players.json'), 'utf8'));
function seeded(seed) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }
const config = { managerCount: 3, names: ['Alex', 'Sam', 'Charlie'], formation: '4-3-3', mode: 'peak', seasonFrom: '1992/93', seasonTo: '2026/27', ratingMin: 40, ratingMax: 95 };
for (const formation of Object.keys(draft.formations)) {
  for (const managerCount of [2, 3, 5, 8]) {
    for (const mode of ['peak', 'season']) {
      const settings = { ...config, formation, managerCount, mode };
      const { pool, error } = core.makePool(players, settings, seeded(managerCount * 19));
      assert(!error, error); assert.equal(pool.length, managerCount * 11);
      assert.equal(new Set(pool.map(entry => entry.id)).size, pool.length);
      assert.equal(pool.filter(entry => entry.player.positions.includes('GK')).length, managerCount);
      const quotas = new Map(); draft.formations[formation].forEach(slot => quotas.set(slot.position, (quotas.get(slot.position) || 0) + managerCount));
      for (const [position, count] of quotas) assert.equal(pool.filter(entry => entry.allocatedPosition === position).length, count);
      assert(pool.every(entry => draft.fits(entry.player, entry.allocatedPosition)));
    }
  }
}
const narrow = { ...config, mode: 'season', seasonFrom: '2011/12', seasonTo: '2011/12', ratingMin: 60, ratingMax: 90 };
const limited = core.makePool(players, narrow, seeded(8));
assert(!limited.error, limited.error);
assert(limited.pool.every(entry => entry.season.season === '2011/12' && entry.season.seasonRating >= 60 && entry.season.seasonRating <= 90));
assert(core.makePool(players, { ...config, ratingMin: 95 }, seeded(1)).error, 'An impossible pool must be rejected');
const first = core.makePool(players, config, seeded(1)).pool;
const second = core.makePool(players, config, seeded(2)).pool;
assert.notDeepEqual(first.map(entry => entry.id), second.map(entry => entry.id), 'Pools must vary with randomness');
let game = core.createGame(config, first);
assert(Object.isFrozen(game.config));
assert(core.buy(game, 'manager-1', 10).error, 'Cannot buy before reveal');
game = core.reveal(game, seeded(1)).game;
const passedId = game.currentId; game = core.pass(game).game;
assert.equal(game.remaining.length, 33);
game = core.reveal(game, seeded(1)).game;
assert.notEqual(game.currentId, passedId, 'A pass should not immediately reveal the same player');
assert(core.reveal(game).error, 'Cannot reveal twice before resolving the bid');
for (const price of [-1, 1.1, NaN, Infinity, 1001]) assert(core.buy(game, 'manager-1', price).error);
assert(core.buy(game, 'unknown', 10).error);
game = core.buy(game, 'manager-1', 1000).game;
assert.equal(core.budget(game, 'manager-1'), 0);
const firstPurchase = game.currentId;
assert(core.buy(game, 'manager-1', 0).error, 'Cannot sell the same player twice');
game = core.place(game, 'manager-1', firstPurchase, 1).game;
assert.equal(game.managers[0].board[1], firstPurchase);
assert(core.place(game, 'manager-2', firstPurchase, 1).error, 'Cannot place another manager’s player');
game = core.reveal(game, seeded(2)).game;
assert(core.buy(game, 'manager-1', 1).error, 'Cannot overspend');
game = core.buy(game, 'manager-1', 0).game;
const secondPurchase = game.currentId;
game = core.place(game, 'manager-1', secondPurchase, 2).game;
game = core.place(game, 'manager-1', firstPurchase, 2).game;
assert.equal(game.managers[0].board[2], firstPurchase);
assert.equal(game.managers[0].board[1], secondPurchase, 'Moving a placed player swaps occupied positions');
game = core.unplace(game, 'manager-1', firstPurchase);
assert.equal(core.purchases(game, 'manager-1').length, 2, 'Unplacing must not undo ownership');
assert.equal(core.budget(game, 'manager-1'), 0);
game = core.undo(game).game;
assert.equal(game.phase, 'revealed'); assert.equal(game.sales.length, 1);
assert(!game.managers[0].board.includes(secondPurchase));
assert(core.restore(core.serialise(game), players), 'A revealed game must restore');
game = core.createGame(config, first);
for (let i = 0; i < 33; i++) {
  game = core.reveal(game, seeded(i + 3)).game;
  const managerId = `manager-${i % 3 + 1}`;
  game = core.buy(game, managerId, i * 2).game;
  game = core.place(game, managerId, game.currentId, Math.floor(i / 3)).game;
}
assert.equal(game.phase, 'complete'); assert.equal(game.remaining.length, 0);
assert.equal(game.sales.length, 33);
assert.equal(new Set(game.sales.map(sale => sale.playerId)).size, 33);
for (const manager of game.managers) {
  assert.equal(core.purchases(game, manager.id).length, 11);
  assert.equal(manager.board.filter(Boolean).length, 11);
  assert(core.budget(game, manager.id) >= 0);
}
assert(core.reveal(game).error, 'Cannot spin after completion');
const restored = core.restore(core.serialise(game), players);
assert(restored);
assert.deepEqual(core.serialise(restored), core.serialise(game));
const corrupt = core.serialise(game);
corrupt.managers = JSON.parse(JSON.stringify(corrupt.managers)); corrupt.managers[0].board[0] = 'not-owned';
assert.equal(core.restore(corrupt, players), null);
const last = game.sales.at(-1), budgetBefore = core.budget(game, last.managerId);
game = core.undo(game).game;
assert.equal(game.phase, 'revealed'); assert.equal(game.remaining.length, 1);
assert.equal(core.budget(game, last.managerId), budgetBefore + last.price);
console.log('Auction checks passed: balanced unique pools for 2–8 managers and every formation/mode, exact goalkeepers, filtering, bids/budgets, pass, undo, placement/swaps, save restore, and all 33 sales.');
