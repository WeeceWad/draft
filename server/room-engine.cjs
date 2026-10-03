const auction = require('../src/auction-core.js');
const draft = require('../src/draft-core.js');
const leagueCore = require('../src/league-core.js');
const players = require('../data/38-0/players.json');
const clubs = require('../data/38-0/clubs.json');
const clubMap = new Map(clubs.map(club => [club.id, club]));
const seasons = [...new Set(players.flatMap(player => player.clubSeasons.map(season => season.season)))].sort();
class RoomError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const fail = (message, status) => { throw new RoomError(message, status); };
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 24) fail('Enter a name between 1 and 24 characters.');
  return value.trim();
}
function settings(input, capacity) {
  if (!Number.isInteger(capacity) || capacity < 2 || capacity > 8) fail('Choose between 2 and 8 managers.');
  const config = { managerCount: capacity, names: Array.from({ length: capacity }, (_, i) => `Manager ${i + 1}`), formation: input.formation,
    mode: input.mode, seasonFrom: input.seasonFrom, seasonTo: input.seasonTo, ratingMin: input.ratingMin, ratingMax: input.ratingMax };
  if (!draft.formations[config.formation] || !['peak', 'season'].includes(config.mode) || !seasons.includes(config.seasonFrom) || !seasons.includes(config.seasonTo)
    || config.seasonFrom > config.seasonTo || !Number.isInteger(config.ratingMin) || !Number.isInteger(config.ratingMax)
    || config.ratingMin < 40 || config.ratingMax > 95 || config.ratingMin > config.ratingMax) fail('Choose valid formation, seasons and ratings.');
  const eligible = auction.candidates(players, config), coverage = auction.balance(eligible, config.formation, capacity, () => .47);
  if (coverage.error) fail(coverage.error);
  return config;
}
function create({ id, code, uid, displayName, capacity, config, seed, now }) {
  return { version: 1, id, code, hostUid: uid, capacity, config: settings(config, capacity), seed,
    createdAt: now, expiresAt: now + 24 * 60 * 60 * 1000, revision: 1, status: 'lobby',
    members: [{ uid, managerId: 'manager-1', name: name(displayName), ready: false }],
    game: null, league: null, round: null, roundNumber: 0, seen: [] };
}
function pack(room) {
  return { ...room, game: room.game ? auction.serialise(room.game) : null, league: leagueCore.serialise(room.league) };
}
function unpack(record) {
  const room = structuredClone(record);
  if (room.game) {
    room.game = auction.restore(room.game, players);
    if (!room.game) fail('This saved room cannot be loaded.', 500);
  }
  if (room.league) {
    room.league = leagueCore.restore(room.league, room.game);
    if (!room.league) fail('This saved league cannot be loaded.', 500);
  }
  return room;
}
function member(room, uid) {
  const member = room.members.find(member => member.uid === uid);
  if (!member) fail('You are not a member of this room.', 403);
  return member;
}
const host = (room, uid) => { if (room.hostUid !== uid) fail('Only the host can do that.', 403); };
function join(room, uid, displayName, now) {
  if (room.expiresAt <= now) fail('This room has expired.', 404);
  const existing = room.members.find(member => member.uid === uid);
  if (existing) return room;
  if (room.status !== 'lobby') fail('The auction has already started. Only existing managers can rejoin.', 409);
  if (room.members.length >= room.capacity) fail('This room is full.', 409);
  if (room.members.some(member => member.name.toLowerCase() === name(displayName).toLowerCase())) fail('That name is already taken in this room.');
  const used = new Set(room.members.map(member => member.managerId));
  const managerId = Array.from({ length: room.capacity }, (_, i) => `manager-${i + 1}`).find(id => !used.has(id));
  return { ...room, members: [...room.members, { uid, managerId, name: name(displayName), ready: false }] };
}
function eligible(room) { return room.game.managers.filter(manager => auction.purchases(room.game, manager.id).length < 11).map(manager => manager.id); }
function active(room) { return eligible(room).filter(id => !room.round.withdrawn.includes(id)); }
function leading(room) {
  return Object.entries(room.round.offers).filter(([id]) => active(room).includes(id)).sort((a, b) => b[1] - a[1])[0] || null;
}
function resolve(room, now, force = false) {
  if (!room.round || room.round.status !== 'open') return false;
  const bid = leading(room), remaining = active(room);
  const timedOut = room.round.deadline !== null && room.round.deadline <= now;
  if (!force && !timedOut && remaining.length !== 0 && !(remaining.length === 1 && bid)) return false;
  if (bid) {
    const result = auction.buy(room.game, bid[0], bid[1]);
    if (result.error) fail(result.error, 500);
    room.game = result.game; room.round.status = 'sold';
    room.round.winnerId = bid[0]; room.round.price = bid[1];
    if (room.game.phase === 'complete') room.status = 'complete';
  } else {
    room.game = auction.pass(room.game).game;
    room.round.status = 'passed'; room.round.winnerId = null;
  }
  room.round.finishedAt = now;
  return true;
}
function apply(room, uid, command, now) {
  if (room.expiresAt <= now) fail('This room has expired. Create a new room.', 404);
  const system = uid === null && command.type === 'tick';
  const me = system ? null : member(room, uid);
  if (command.requestId && room.seen.includes(`${uid}:${command.requestId}`)) return { room, changed: false };
  const expired = resolve(room, now);
  const stale = command.roundId !== undefined && command.roundId !== (room.round?.id ?? null);
  if (stale && ['bid', 'withdraw', 'reveal', 'skip'].includes(command.type)) {
    if (expired) return { room, changed: true, error: 'That auction has ended. Your bid was not placed.' };
    fail('The next player has already appeared. Try again on the current player.', 409);
  }
  if (['bid', 'withdraw'].includes(command.type) && room.round?.status !== 'open') {
    if (expired) return { room, changed: true, error: 'That auction has ended. Your bid was not placed.' };
    fail('This player’s auction is already finished.', 409);
  }
  switch (command.type) {
    case 'tick':
      if (!system) member(room, uid);
      return { room, changed: expired };
    case 'ready':
      if (room.status !== 'lobby') fail('The auction has already started.', 409);
      me.ready = command.ready === true; break;
    case 'start': {
      host(room, uid);
      if (room.status !== 'lobby') fail('The auction has already started.', 409);
      if (room.members.length !== room.capacity || room.members.some(member => !member.ready)) fail('Wait for every manager to join and mark themselves ready.');
      room.members.forEach((member, index) => { member.managerId = `manager-${index + 1}`; });
      const config = { ...room.config, names: room.members.map(member => member.name) };
      const pool = auction.makePool(players, config, leagueCore.seeded(room.seed));
      if (pool.error) fail(pool.error);
      room.game = auction.createGame(config, pool.pool); room.status = 'draft'; break;
    }
    case 'reveal': {
      host(room, uid);
      if (room.status !== 'draft' || room.round?.status === 'open') fail('Finish the current auction first.', 409);
      const result = auction.reveal(room.game, leagueCore.seeded((room.seed + (room.roundNumber + 1) * 7919) >>> 0));
      if (result.error) fail(result.error);
      room.game = result.game; room.roundNumber++;
      room.round = { id: room.roundNumber, playerId: room.game.currentId, returning: room.game.returning, status: 'open', revealedAt: now, opensAt: now + 1600,
        startedAt: null, deadline: null, offers: {}, withdrawn: [], bids: [], winnerId: null, price: null };
      break;
    }
    case 'bid': {
      if (now < room.round.opensAt) fail('Wait for the player to be revealed.', 409);
      if (!active(room).includes(me.managerId)) fail('You are out of this auction or your XI is full.', 409);
      const amount = command.price, bid = leading(room);
      if (!Number.isInteger(amount) || amount < 0) fail('Bid in £0.1m increments.');
      if (bid && amount <= bid[1]) fail('Your bid must beat the current highest bid.', 409);
      if (amount > auction.budget(room.game, me.managerId)) fail('That bid exceeds your remaining budget.');
      room.round.offers[me.managerId] = amount;
      room.round.bids = [...room.round.bids, { managerId: me.managerId, price: amount, at: now }].slice(-12);
      if (room.round.startedAt === null) { room.round.startedAt = now; room.round.deadline = now + 60000; }
      else room.round.deadline += 10000;
      resolve(room, now); break;
    }
    case 'withdraw':
      if (now < room.round.opensAt) fail('Wait for the player to be revealed.', 409);
      if (!active(room).includes(me.managerId)) fail('You have already backed out or your XI is full.', 409);
      room.round.withdrawn.push(me.managerId); resolve(room, now); break;
    case 'skip':
      host(room, uid);
      if (room.round?.status !== 'open' || leading(room)) fail('A player with a live bid cannot be skipped.', 409);
      resolve(room, now, true); break;
    case 'place': {
      if (!room.game || room.league) fail('The starting XIs are locked for the league.', 409);
      const result = auction.place(room.game, me.managerId, command.playerId, command.slot);
      if (result.error) fail(result.error, 403);
      room.game = result.game; break;
    }
    case 'unplace':
      if (!room.game || room.league) fail('The starting XIs are locked for the league.', 409);
      if (!auction.purchases(room.game, me.managerId).some(sale => sale.playerId === command.playerId)) fail('You can only move your own players.', 403);
      room.game = auction.unplace(room.game, me.managerId, command.playerId); break;
    case 'autoPlace': {
      if (!room.game || room.league) fail('The starting XIs are locked for the league.', 409);
      const manager = room.game.managers.find(manager => manager.id === me.managerId);
      const unplaced = auction.purchases(room.game, me.managerId).filter(sale => !manager.board.includes(sale.playerId)).map(sale => room.game.pool.find(entry => entry.id === sale.playerId));
      const squad = manager.board.map(id => id ? room.game.pool.find(entry => entry.id === id) : unplaced.shift() || null);
      const board = draft.remap(squad, room.game.config.formation, room.game.config.formation).map(entry => entry?.id || null);
      room.game = { ...room.game, managers: room.game.managers.map(manager => manager.id === me.managerId ? { ...manager, board } : manager) }; break;
    }
    case 'startLeague': {
      host(room, uid);
      if (!room.game || room.status !== 'complete') fail('Finish the auction before starting the league.', 409);
      if (room.league) fail('The league has already started.', 409);
      const result = leagueCore.create(room.game, (room.seed ^ 0x52ff8844) >>> 0);
      if (result.error) fail(result.error);
      room.league = result.league; break;
    }
    case 'playRound':
    case 'finishLeague': {
      host(room, uid);
      if (!room.league || room.league.round >= leagueCore.roundCount(room.league)) fail('There is no matchday left to play.', 409);
      do { room.league = leagueCore.playRound(room.league).league; } while (command.type === 'finishLeague' && room.league.round < leagueCore.roundCount(room.league));
      break;
    }
    case 'kick':
      host(room, uid);
      if (room.status !== 'lobby' || command.managerId === me.managerId) fail('Only another manager in the lobby can be removed.');
      room.members = room.members.filter(member => member.managerId !== command.managerId); break;
    case 'transferHost': {
      host(room, uid);
      const next = room.members.find(member => member.managerId === command.managerId);
      if (!next) fail('Choose a manager in the room.');
      room.hostUid = next.uid; break;
    }
    default: fail('Unknown room action.');
  }
  if (command.requestId) room.seen = [...room.seen, `${uid}:${command.requestId}`].slice(-100);
  return { room, changed: true };
}
function entryView(entry) {
  return { id: entry.id, player: { id: entry.id, name: entry.player.name, positions: entry.player.positions, nationality: entry.player.nationality, peakRating: entry.player.peakRating },
    season: entry.season, club: clubMap.get(entry.season.clubId) };
}
function view(room, uid) {
  const me = member(room, uid);
  const round = room.round && { ...room.round, leader: leading(room) ? { managerId: leading(room)[0], price: leading(room)[1] } : null, active: active(room) };
  if (round) delete round.offers;
  const skipped = room.game?.skipped || [];
  const known = room.game ? new Set([...room.game.sales.map(sale => sale.playerId), ...skipped, ...(room.round ? [room.round.playerId] : [])]) : new Set();
  // Only already revealed identities leave the server; unseen players stay private.
  const game = room.game && { config: room.game.config, managers: room.game.managers, sales: room.game.sales, phase: room.game.phase,
    pool: room.game.pool.filter(entry => known.has(entry.id)).map(entryView), skipped: skipped.slice(),
    unseenCount: room.game.remaining.filter(id => !skipped.includes(id) && !(room.game.phase === 'revealed' && id === room.game.currentId)).length,
    remainingCount: room.game.remaining.length, totalPlayers: room.game.pool.length };
  const league = room.league && { round: room.league.round, teams: room.league.teams, fixtures: room.league.fixtures, engineVersion: room.league.engineVersion };
  return { id: room.id, code: room.code, capacity: room.capacity, config: room.config, status: room.status, revision: room.revision, expiresAt: room.expiresAt,
    isHost: room.hostUid === uid, me: me.managerId, members: room.members.map(member => ({ managerId: member.managerId, name: member.name, ready: member.ready, isHost: member.uid === room.hostUid })), game, round, league };
}
module.exports = { RoomError, create, pack, unpack, join, apply, view, resolve, leading, seasons, players };
