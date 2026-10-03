const assert = require('node:assert/strict');
const auction = require('../src/auction-core.js');
const engine = require('../server/room-engine.cjs');
const config = { formation: '4-3-3', mode: 'peak', seasonFrom: '1992/93', seasonTo: '2026/27', ratingMin: 40, ratingMax: 95 };
let now = 1800000000000, sequence = 0;
let room = engine.create({ id: 'test-room', code: '0101', uid: 'a', displayName: 'Alex', capacity: 3, config, seed: 31, now });
room = engine.join(room, 'b', 'Blair', now); room = engine.join(room, 'c', 'Casey', now);
const act = (uid, type, details = {}) => { const result = engine.apply(room, uid, { type, requestId: String(++sequence), roundId: room.round?.id ?? null, ...details }, now); assert(!result.error, result.error); room = result.room; };
for (const uid of ['a', 'b', 'c']) act(uid, 'ready', { ready: true }); act('a', 'start');
const firstCycle = [];
for (let index = 0; index < 33; index++) {
  act('a', 'reveal'); now += 2000;
  assert(!firstCycle.includes(room.round.playerId), 'No skipped player can reappear during the first cycle');
  assert.equal(room.round.returning, false); firstCycle.push(room.round.playerId);
  if (index === 0) for (const uid of ['a', 'b', 'c']) act(uid, 'withdraw');
  else if (index === 2) {
    act('a', 'bid', { price: 100 }); act('a', 'withdraw'); now = room.round.deadline; act(null, 'tick');
  } else act('a', 'skip');
  assert.equal(room.round.status, 'passed');
  assert.deepEqual(room.game.skipped, firstCycle);
  assert.equal(room.game.remaining.length, 33); assert.equal(room.game.sales.length, 0);
  const snapshot = engine.view(room, 'b');
  assert.equal(snapshot.game.unseenCount, 33 - firstCycle.length);
  assert.equal(snapshot.game.pool.length, firstCycle.length, 'Only previously revealed identities are exposed');
  assert.deepEqual(snapshot.game.skipped, firstCycle);
  assert.equal(auction.budget(room.game, 'manager-1'), 1000);
  room = engine.unpack(engine.pack(room));
}
assert.equal(room.status, 'draft');
act('a', 'reveal'); now += 2000;
assert.equal(room.round.playerId, firstCycle[0]); assert.equal(room.round.returning, true);
assert.deepEqual(room.round.withdrawn, []); assert.deepEqual(room.round.offers, {}); assert.equal(room.round.deadline, null);
assert.deepEqual(room.game.skipped, firstCycle.slice(1));
room = engine.unpack(engine.pack(room)); assert.equal(room.game.returning, true);
act('a', 'skip'); assert.deepEqual(room.game.skipped, [...firstCycle.slice(1), firstCycle[0]]);
act('a', 'reveal'); now += 2000; assert.equal(room.round.playerId, firstCycle[1]);
act('b', 'bid', { price: 50 }); assert.equal(room.round.deadline, now + 60000);
act('a', 'withdraw'); act('c', 'withdraw');
assert.equal(room.round.status, 'sold'); assert.equal(room.round.winnerId, 'manager-2');
assert.equal(auction.budget(room.game, 'manager-2'), 950);
assert(!room.game.skipped.includes(firstCycle[1]));
assert(!room.game.remaining.includes(firstCycle[1]));
// Saved queues reject duplicate, sold, unknown and currently auctioned identities.
const saved = auction.serialise(room.game);
for (const skipped of [[...saved.skipped, saved.skipped[0]], [firstCycle[1]], ['not-a-player']]) {
  assert.equal(auction.restore({ ...saved, skipped }, engine.players), null);
}
act('a', 'reveal');
assert.equal(auction.restore({ ...auction.serialise(room.game), skipped: [room.game.currentId] }, engine.players), null);
assert.equal(room.round.playerId, firstCycle[2]);
// Older records remain loadable and their last known pass is queued.
act('a', 'skip'); const legacy = auction.serialise(room.game); delete legacy.skipped; delete legacy.returning;
assert.deepEqual(auction.restore(legacy, engine.players).skipped, [legacy.lastPassedId]);
// A single unsold player can keep returning without duplicate entries or early completion.
while (room.game.remaining.length > 1) {
  act('a', 'reveal'); now += 2000;
  const manager = room.members.find(member => auction.purchases(room.game, member.managerId).length < 11);
  act(manager.uid, 'bid', { price: 0 });
  if (room.round.status === 'open') { now = room.round.deadline; act(null, 'tick'); }
}
const lastId = room.game.remaining[0];
for (let index = 0; index < 3; index++) { act('a', 'reveal'); now += 2000; assert.equal(room.round.playerId, lastId); act('a', 'skip'); assert.deepEqual(room.game.skipped, [lastId]); assert.equal(room.status, 'draft'); }
act('a', 'reveal'); now += 2000;
const lastManager = room.members.find(member => auction.purchases(room.game, member.managerId).length < 11);
act(lastManager.uid, 'bid', { price: 0 });
assert.equal(room.status, 'complete'); assert.deepEqual(room.game.skipped, []);
assert.equal(room.game.sales.length, 33);
console.log('Skipped-player checks passed: all withdrawal/skip/expiry paths, full-cycle deferral, FIFO returns/re-skips, fresh bidding, privacy, save migration, validation and last-player completion.');
