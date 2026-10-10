const { EventEmitter } = require('node:events');
const { Pool } = require('pg');
const engine = require('./room-engine.cjs');
const schema = `
CREATE TABLE IF NOT EXISTS draft_sessions (token_hash text PRIMARY KEY, uid uuid NOT NULL, expires_at bigint NOT NULL);
CREATE TABLE IF NOT EXISTS draft_rooms (id uuid PRIMARY KEY, code char(4) UNIQUE NOT NULL, expires_at bigint NOT NULL, deadline bigint, record jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS draft_rooms_deadline ON draft_rooms(deadline) WHERE deadline IS NOT NULL;
CREATE INDEX IF NOT EXISTS draft_sessions_expiry ON draft_sessions(expires_at);`;
class MemoryStore extends EventEmitter {
  constructor() { super(); this.rooms = new Map(); this.sessions = new Map(); this.queue = Promise.resolve(); }
  async init() {}
  async session(hash, now) { const session = this.sessions.get(hash); return session?.expiresAt > now ? session.uid : null; }
  async saveSession(hash, uid, expiresAt) { this.sessions.set(hash, { uid, expiresAt }); }
  async create(room) {
    if ([...this.rooms.values()].some(value => value.code === room.code)) return false;
    this.rooms.set(room.id, engine.pack(room)); return true;
  }
  async get(id) { const record = this.rooms.get(id); return record ? engine.unpack(record) : null; }
  async byCode(code, now) { return [...this.rooms.values()].find(room => room.code === code && room.expiresAt > now)?.id || null; }
  async mutate(id, fn) {
    const run = async () => {
      const room = await this.get(id); if (!room) throw new engine.RoomError('Room not found.', 404);
      const result = fn(room);
      if (result.changed) { result.room.revision++; this.rooms.set(id, engine.pack(result.room)); this.emit('change', id); }
      return result;
    };
    const task = this.queue.then(run); this.queue = task.catch(() => {}); return task;
  }
  async due(now) { return [...this.rooms.values()].filter(room => room.expiresAt > now && room.round?.status === 'open' && room.round.deadline !== null && room.round.deadline <= now).map(room => room.id); }
  async cleanup(now) { for (const [id, room] of this.rooms) if (room.expiresAt <= now) this.rooms.delete(id); for (const [hash, value] of this.sessions) if (value.expiresAt <= now) this.sessions.delete(hash); }
  async close() {}
}
class PostgresStore extends EventEmitter {
  constructor(url, ssl) {
    super();
    this.options = { connectionString: url, ...(ssl ? { ssl: { rejectUnauthorized: true } } : {}) };
    this.pool = new Pool({ ...this.options, max: 8, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
    // Serverless Postgres (such as Neon) closes idle connections when it pauses; the pool reconnects on the next query.
    this.pool.on('error', () => {});
  }
  async init() { await this.pool.query(schema); }
  async session(hash, now) { return (await this.pool.query('SELECT uid FROM draft_sessions WHERE token_hash=$1 AND expires_at>$2', [hash, now])).rows[0]?.uid || null; }
  async saveSession(hash, uid, expiry) { await this.pool.query('INSERT INTO draft_sessions(token_hash,uid,expires_at) VALUES($1,$2,$3)', [hash, uid, expiry]); }
  async create(room) {
    const result = await this.pool.query('INSERT INTO draft_rooms(id,code,expires_at,record) VALUES($1,$2,$3,$4) ON CONFLICT(code) DO NOTHING RETURNING id', [room.id, room.code, room.expiresAt, engine.pack(room)]);
    return result.rowCount === 1;
  }
  async get(id) { const row = (await this.pool.query('SELECT record FROM draft_rooms WHERE id=$1', [id])).rows[0]; return row ? engine.unpack(row.record) : null; }
  async byCode(code, now) { return (await this.pool.query('SELECT id FROM draft_rooms WHERE code=$1 AND expires_at>$2', [code, now])).rows[0]?.id || null; }
  async mutate(id, fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query('SELECT record FROM draft_rooms WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!row) throw new engine.RoomError('Room not found.', 404);
      const result = fn(engine.unpack(row.record));
      if (result.changed) {
        result.room.revision++;
        const deadline = result.room.round?.status === 'open' ? result.room.round.deadline : null;
        await client.query('UPDATE draft_rooms SET record=$2,deadline=$3 WHERE id=$1', [id, engine.pack(result.room), deadline]);
      }
      await client.query('COMMIT');
      // The game runs as a single server, so it tells its own connected players once the change is saved.
      if (result.changed) this.emit('change', id);
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async due(now) { return (await this.pool.query('SELECT id FROM draft_rooms WHERE deadline<=$1 AND expires_at>$1', [now])).rows.map(row => row.id); }
  async cleanup(now) { await this.pool.query('DELETE FROM draft_rooms WHERE expires_at<=$1', [now]); await this.pool.query('DELETE FROM draft_sessions WHERE expires_at<=$1', [now]); }
  async close() { await this.pool.end(); }
}
module.exports = { MemoryStore, PostgresStore, schema };
