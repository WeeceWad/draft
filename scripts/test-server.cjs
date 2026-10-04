const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');
const { createServer } = require('../server/index.cjs');
const { MemoryStore } = require('../server/store.cjs');
async function run() {
  let time = 1800000000000;
  const store = new MemoryStore(), service = await createServer({ store, now: () => time, timers: false });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const clients = [];
  async function client() {
    const response = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const user = { cookie, call: async (url, body) => { const result = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: result.status, data: await result.json() }; } };
    clients.push(user); return user;
  }
  let socket;
  try {
    const [a, b, c, outsider] = await Promise.all([client(), client(), client(), client()]);
    const created = await a.call('/api/create', { name: 'Alex', capacity: 3, config: { formation: '4-2-3-1', mode: 'season', seasonFrom: '1992/93', seasonTo: '2026/27', ratingMin: 40, ratingMax: 95 } });
    assert.equal(created.status, 200); const id = created.data.room.id, code = created.data.room.code;
    assert.match(code, /^\d{4}$/);
    assert.equal((await outsider.call(`/api/room/${id}`)).status, 403);
    assert.equal((await b.call('/api/join', { name: 'Blair', code })).status, 200);
    assert.equal((await c.call('/api/join', { name: 'Casey', code })).status, 200);
    assert.equal((await outsider.call('/api/join', { name: 'Fourth', code })).status, 409);
    assert.equal((await a.call('/api/rematch', { roomId: id })).status, 409, 'No rematch before the league finishes');
    assert.equal((await outsider.call('/api/rematch', { roomId: id })).status, 403);
    const action = (user, type, details = {}) => user.call('/api/action', { roomId: id, command: { type, requestId: crypto.randomUUID(), ...details } });
    await Promise.all([action(a, 'ready', { ready: true }), action(b, 'ready', { ready: true }), action(c, 'ready', { ready: true })]);
    assert.equal((await action(b, 'start')).status, 403);
    assert.equal((await action(a, 'start')).status, 200);
    let latest;
    socket = new WebSocket(base.replace('http:', 'ws:') + `/live?roomId=${id}`, { headers: { Cookie: b.cookie, Origin: base } });
    socket.on('message', data => { latest = JSON.parse(data).room; });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    let result = await action(a, 'reveal', { roundId: null }); assert.equal(result.status, 200); time += 2000;
    const concurrent = await Promise.all([action(a, 'bid', { price: 100, roundId: 1 }), action(b, 'bid', { price: 100, roundId: 1 })]);
    assert.deepEqual(concurrent.map(value => value.status).sort(), [200, 409]);
    result = await c.call(`/api/room/${id}`); assert.equal(result.data.room.round.leader.price, 100);
    assert.equal(result.data.room.round.deadline, time + 60000);
    const winner = result.data.room.round.leader.managerId, others = [a, b, c].filter((value, i) => `manager-${i + 1}` !== winner);
    await Promise.all(others.map(user => action(user, 'withdraw', { roundId: 1 })));
    result = await a.call(`/api/room/${id}`); assert.equal(result.data.room.round.status, 'sold'); assert.equal(result.data.room.game.sales.length, 1);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(latest.game.sales.length, 1); assert.equal(latest.round.winnerId, winner);
    assert.equal((await b.call('/api/join', { name: 'new name', code })).status, 200);
    result = await action(a, 'reveal'); time += 2000; await action(c, 'bid', { price: 50, roundId: 2 }); time += 60000;
    await Promise.all([service.settle(), service.settle()]);
    result = await c.call(`/api/room/${id}`); assert.equal(result.data.room.game.sales.length, 2); assert.equal(result.data.room.round.price, 50);
    assert.equal(result.data.room.game.remaining, undefined);
    assert.equal((await a.call('/api/action', { roomId: id, command: { type: 'place', playerId: result.data.room.round.playerId, slot: 0, requestId: crypto.randomUUID() } })).status, 403);
    const csrf = await fetch(base + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://bad.example', Cookie: a.cookie }, body: '{}' }); assert.equal(csrf.status, 403);
    const unauth = await fetch(base + `/api/room/${id}`); assert.equal(unauth.status, 401);
    assert.equal((await fetch(base + '/server/index.cjs')).status, 404);
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await fetch(base + '/health')).status, 200);
    console.log('Server integration passed: isolated sessions, lobby permissions, atomic competing bids, WebSocket updates, reconnect, exactly-once settlement and request protection.');
  } finally { socket?.terminate(); await service.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
