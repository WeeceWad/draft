const express = require('express');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { MemoryStore, PostgresStore } = require('./store.cjs');
const engine = require('./room-engine.cjs');
const cookieName = 'touchline_session';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const tokenFrom = req => (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
async function createServer({ store, now = Date.now, production = process.env.NODE_ENV === 'production', timers = true } = {}) {
  if (!store) {
    if (production && !process.env.DATABASE_URL) throw new Error('DATABASE_URL is required in production. Connect the Render PostgreSQL database.');
    store = process.env.DATABASE_URL ? new PostgresStore(process.env.DATABASE_URL, process.env.DATABASE_SSL === 'true') : new MemoryStore();
  }
  await store.init(); await store.cleanup(now());
  const app = express(); app.disable('x-powered-by'); app.set('trust proxy', 1);
  const server = http.createServer(app), live = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const clients = new Map(), limits = new Map();
  app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" }); next(); });
  app.use(express.json({ limit: '8kb' }));
  function originAllowed(req) {
    if (!req.headers.origin) return true;
    try { const origin = new URL(req.headers.origin); return origin.host === req.headers.host && ['http:', 'https:'].includes(origin.protocol); } catch { return false; }
  }
  app.use('/api', (req, res, next) => {
    if (!originAllowed(req) || (req.method === 'POST' && !req.is('application/json'))) return res.status(403).json({ error: 'Use the game page to make this request.' });
    const key = `${req.ip}:${['/create', '/join', '/session'].includes(req.path) ? 'rooms' : 'actions'}`;
    const bucket = limits.get(key) || { at: now(), count: 0 };
    if (now() - bucket.at > 60000) { bucket.at = now(); bucket.count = 0; }
    bucket.count++; limits.set(key, bucket);
    if (bucket.count > (key.endsWith('rooms') ? 40 : 360)) return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
    next();
  });
  const uidFor = async req => { const token = tokenFrom(req); return token && /^[a-f0-9]{64}$/.test(token) ? store.session(hash(token), now()) : null; };
  const auth = async (req, res, next) => { req.uid = await uidFor(req); if (!req.uid) return res.status(401).json({ error: 'Your session expired. Refresh to reconnect.' }); next(); };
  const state = (room, uid) => ({ type: 'state', room: engine.view(room, uid), serverTime: now() });
  const getRoom = async id => { if (!uuid(id)) throw new engine.RoomError('Room not found.', 404); const room = await store.get(id); if (!room || room.expiresAt <= now()) throw new engine.RoomError('Room not found or expired.', 404); return room; };
  const broadcast = async id => {
    const sockets = clients.get(id); if (!sockets?.size) return;
    try {
      const room = await getRoom(id);
      for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify(state(room, socket.uid))); } catch { socket.close(1008, 'Room membership ended'); }
      }
    } catch { for (const socket of sockets) socket.close(1008, 'Room expired'); }
  };
  store.on('change', broadcast);
  app.post('/api/session', async (req, res) => {
    let uid = await uidFor(req);
    if (!uid) {
      const token = crypto.randomBytes(32).toString('hex'); uid = crypto.randomUUID();
      await store.saveSession(hash(token), uid, now() + 30 * 86400000);
      res.cookie(cookieName, token, { httpOnly: true, sameSite: 'lax', secure: production, maxAge: 30 * 86400000, path: '/' });
    }
    res.json({ serverTime: now() });
  });
  app.get('/api/options', (req, res) => res.json({ seasons: engine.seasons }));
  app.get('/api/clock', (req, res) => res.json({ serverTime: now() }));
  async function createRoom(uid, displayName, capacity, config) {
    await store.cleanup(now());
    for (let attempt = 0; attempt < 30; attempt++) {
      const room = engine.create({ id: crypto.randomUUID(), code: String(crypto.randomInt(10000)).padStart(4, '0'), uid, displayName, capacity, config, seed: crypto.randomBytes(4).readUInt32LE(), now: now() });
      if (await store.create(room)) return room;
    }
    throw new engine.RoomError('No room codes are available. Please try later.', 503);
  }
  const joinRoom = (id, uid, displayName) => store.mutate(id, room => ({ room: engine.join(room, uid, displayName, now()), changed: !room.members.some(member => member.uid === uid) }));
  app.post('/api/create', auth, async (req, res) => {
    const room = await createRoom(req.uid, req.body.name, req.body.capacity, req.body.config || {});
    res.json(state(room, req.uid));
  });
  app.post('/api/join', auth, async (req, res) => {
    if (typeof req.body.code !== 'string' || !/^\d{4}$/.test(req.body.code)) throw new engine.RoomError('Enter the four-digit room code.');
    const id = await store.byCode(req.body.code, now()); if (!id) throw new engine.RoomError('Room not found. Check the code with your host.', 404);
    const result = await joinRoom(id, req.uid, req.body.name);
    res.json(state(result.room, req.uid));
  });
  // Play again: the first member to ask creates a fresh lobby with the same rules; everyone else joins it.
  app.post('/api/rematch', auth, async (req, res) => {
    const old = await getRoom(req.body.roomId), me = old.members.find(member => member.uid === req.uid);
    if (!me) throw new engine.RoomError('You are not a member of this room.', 403);
    if (!engine.finished(old)) throw new engine.RoomError('Finish the league before starting a new game.', 409);
    let created = null, target = old.next;
    if (!target) {
      created = await createRoom(req.uid, me.name, old.capacity, old.config);
      target = (await store.mutate(old.id, room => engine.linkNext(room, req.uid, { id: created.id, code: created.code }))).room.next;
    }
    if (created && target.id === created.id) return res.json(state(created, req.uid));
    const result = await joinRoom(target.id, req.uid, me.name);
    res.json(state(result.room, req.uid));
  });
  app.get('/api/room/:id', auth, async (req, res) => {
    await getRoom(req.params.id);
    const result = await store.mutate(req.params.id, room => { engine.view(room, req.uid); return engine.apply(room, null, { type: 'tick' }, now()); });
    res.json(state(result.room, req.uid));
  });
  app.post('/api/action', auth, async (req, res) => {
    await getRoom(req.body.roomId);
    const command = req.body.command;
    if (!command || typeof command.type !== 'string' || !uuid(command.requestId)) throw new engine.RoomError('Invalid action. Refresh and try again.');
    const result = await store.mutate(req.body.roomId, room => engine.apply(room, req.uid, command, now()));
    res.status(result.error ? 409 : 200).json({ ...state(result.room, req.uid), ...(result.error ? { error: result.error } : {}) });
  });
  app.get('/health', async (req, res) => { try { await store.due(now()); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); } });
  app.use(express.static(path.join(__dirname, '../public'), { etag: true }));
  app.use((error, req, res, next) => { if (!error.status) console.error(error); res.status(error.status || 500).json({ error: error.status && error.status !== 500 ? error.message : 'The server could not complete that request. Please try again.' }); });
  server.on('upgrade', async (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://local'); if (url.pathname !== '/live' || !originAllowed(req)) throw new Error('Invalid connection');
      const uid = await uidFor(req), room = await getRoom(url.searchParams.get('roomId'));
      if (!uid) throw new Error('No session'); engine.view(room, uid);
      live.handleUpgrade(req, socket, head, ws => { ws.uid = uid; ws.roomId = room.id; live.emit('connection', ws); });
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
  });
  live.on('connection', socket => {
    if (!clients.has(socket.roomId)) clients.set(socket.roomId, new Set()); clients.get(socket.roomId).add(socket);
    socket.alive = true; socket.on('pong', () => { socket.alive = true; });
    socket.on('error', () => {});
    socket.on('close', () => { const set = clients.get(socket.roomId); set?.delete(socket); if (!set?.size) clients.delete(socket.roomId); });
    broadcast(socket.roomId);
  });
  const settle = async () => { for (const id of await store.due(now())) await store.mutate(id, room => engine.apply(room, null, { type: 'tick' }, now())); };
  await settle();
  const intervals = timers ? [
    setInterval(() => settle().catch(console.error), 500),
    setInterval(() => { for (const sockets of clients.values()) for (const socket of sockets) { if (!socket.alive) socket.terminate(); else { socket.alive = false; socket.ping(); } } }, 30000),
    setInterval(() => { store.cleanup(now()).catch(console.error); for (const [key, bucket] of limits) if (now() - bucket.at > 120000) limits.delete(key); }, 60000)
  ] : [];
  return { app, server, store, settle, close: async () => { intervals.forEach(clearInterval); store.off('change', broadcast); for (const sockets of clients.values()) for (const socket of sockets) socket.close(1012, 'Server restarting'); await new Promise(resolve => server.close(resolve)); live.close(); await store.close(); } };
}
if (require.main === module) createServer().then(service => {
  const port = Number(process.env.PORT || 4174); service.server.listen(port, '0.0.0.0', () => console.log(`Touchline online: http://localhost:${port}${process.env.DATABASE_URL ? ' · PostgreSQL persistence' : ' · local memory (rooms reset on restart)'}`));
  let closing = false; const shutdown = () => { if (closing) return; closing = true; service.close().then(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref(); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { createServer };
