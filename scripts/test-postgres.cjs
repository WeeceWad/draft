const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { PostgresStore } = require('../server/store.cjs');
const engine = require('../server/room-engine.cjs');
// Execute production SQL against PostgreSQL compiled to WASM, using one leased connection.
function adapter(db) {
  let queue = Promise.resolve();
  const query = async (sql, args) => {
    if (sql.includes('CREATE TABLE')) { await db.exec(sql); return { rows: [], rowCount: 0 }; }
    const result = await db.query(sql, args); return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  return { query, connect: async () => { const previous = queue; let release; queue = new Promise(resolve => { release = resolve; }); await previous; return { query, release }; }, end: () => db.close() };
}
async function storeFor(directory) {
  const store = new PostgresStore('postgresql://unused'); await store.pool.end();
  store.pool = adapter(new PGlite(directory)); store.listen = async () => {};
  await store.init(); return store;
}
(async () => {
  const parent = path.resolve(__dirname, '../.test-data'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'pg-'));
  assert(path.resolve(directory).startsWith(parent + path.sep), 'Test data stays within the workspace test directory');
  let store, now = 1800000000000;
  try {
    store = await storeFor(directory);
    const id = crypto.randomUUID(), uid = crypto.randomUUID(), other = crypto.randomUUID(), hash = 'fake-test-session';
    await store.saveSession(hash, uid, now + 86400000); assert.equal(await store.session(hash, now), uid);
    let room = engine.create({ id, code: '0017', uid, displayName: 'Alex', capacity: 2, seed: 4, now, config: { formation: '4-3-3', mode: 'peak', seasonFrom: '1992/93', seasonTo: '2026/27', ratingMin: 40, ratingMax: 95 } });
    assert(await store.create(room)); assert.equal(await store.create({ ...room, id: crypto.randomUUID() }), false);
    await store.mutate(id, room => ({ room: engine.join(room, other, 'Blair', now), changed: true }));
    const act = (uid, type, details = {}) => store.mutate(id, room => engine.apply(room, uid, { type, requestId: crypto.randomUUID(), ...details }, now));
    await Promise.all([act(uid, 'ready', { ready: true }), act(other, 'ready', { ready: true })]);
    await act(uid, 'start'); await act(uid, 'reveal'); now += 2000;
    const bids = await Promise.allSettled([act(uid, 'bid', { price: 100 }), act(other, 'bid', { price: 100 })]);
    assert.equal(bids.filter(result => result.status === 'fulfilled').length, 1);
    room = await store.get(id); const deadline = room.round.deadline, leading = room.round.bids[0].managerId, before = room.revision;
    assert.equal(deadline, now + 60000);
    await assert.rejects(act(other, 'bid', { price: 1001 }), /budget/);
    assert.equal((await store.get(id)).revision, before);
    await store.close(); store = null; store = await storeFor(directory);
    assert.equal(await store.session(hash, now), uid); assert.equal(await store.byCode('0017', now), id);
    assert.equal((await store.get(id)).round.deadline, deadline);
    now = deadline; assert.deepEqual(await store.due(now), [id]);
    await store.mutate(id, room => engine.apply(room, null, { type: 'tick' }, now));
    room = await store.get(id); assert.equal(room.round.status, 'sold'); assert.equal(room.game.sales[0].managerId, leading);
    assert.equal((await store.due(now)).length, 0);
    await store.close(); store = null; store = await storeFor(directory);
    assert.equal((await store.get(id)).game.sales.length, 1);
    await store.cleanup(now + 2 * 86400000); assert.equal(await store.get(id), null); assert.equal(await store.session(hash, now + 2 * 86400000), null);
    console.log('PostgreSQL SQL passed: schema, unique codes, atomic bids, rollback, persisted sessions/rooms/deadlines, restart settlement and cleanup (PGlite).');
  } finally { await store?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
