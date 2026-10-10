const auction = require('../src/auction-core.js');
const draft = require('../src/draft-core.js');
const leagueCore = require('../src/league-core.js');
const players = require('../data/38-0/players.json');
const clubs = require('../data/38-0/clubs.json');
const clubMap = new Map(clubs.map(club => [club.id, club]));
const seasons = [...new Set(players.flatMap(player => player.clubSeasons.map(season => season.season)))].sort();
// 38-0's Premier League field: its 19 opponent clubs and their strengths (Leicester City is its stand-in).
const FIELD = [['Manchester City', 88, 'manchester-city'], ['Arsenal', 86, 'arsenal'], ['Liverpool', 86, 'liverpool'], ['Chelsea', 84, 'chelsea'], ['Manchester United', 84, 'manchester-united'], ['Tottenham', 83, 'tottenham'], ['Newcastle', 82, 'newcastle'], ['Aston Villa', 81, 'aston-villa'], ['Brighton', 80, 'brighton'], ['West Ham', 79, 'west-ham'], ['Crystal Palace', 78, 'crystal-palace'], ['Everton', 77, 'everton'], ['Leeds United', 77, 'leeds'], ['Wolves', 77, 'wolves'], ['Brentford', 77, 'brentford'], ['Fulham', 77, 'fulham'], ['Bournemouth', 76, 'bournemouth'], ['Nottm Forest', 76, 'nottm-forest'], ['Burnley', 74, 'burnley']];
// The strongest clubs fill the places the managers leave in a 20-team league. Each fields its latest
// squad from our data as a 4-3-3, without anyone the managers drafted.
const clubCache = new Map();
function premierClubs(game) {
  const key = `${game.managers.length}:${game.pool.map(entry => entry.id).join(',')}`;
  if (!clubCache.has(key)) { if (clubCache.size > 50) clubCache.clear(); clubCache.set(key, buildClubs(game)); }
  return clubCache.get(key);
}
function buildClubs(game) {
  const taken = new Set(game.pool.map(entry => entry.id)), slots = draft.formations['4-3-3'];
  return FIELD.slice(0, 20 - game.managers.length).map(([name, strength, clubId]) => {
    const counts = new Map();
    for (const player of players) for (const season of player.clubSeasons) if (season.clubId === clubId) counts.set(season.season, (counts.get(season.season) || 0) + 1);
    const latest = [...counts.keys()].sort().reverse().find(season => counts.get(season) >= 14);
    const options = players.filter(player => !taken.has(player.id)).flatMap(player => { const season = player.clubSeasons.find(item => item.clubId === clubId && item.season === latest); return season ? [{ player, rating: season.seasonRating }] : []; }).sort((a, b) => b.rating - a.rating || a.player.id.localeCompare(b.player.id));
    const used = new Set();
    const squad = slots.map(slot => {
      const pick = options.find(option => !used.has(option.player.id) && (slot.position === 'GK' ? option.player.positions.includes('GK') : !option.player.positions.includes('GK') && draft.fits(option.player, slot.position)))
        || options.find(option => !used.has(option.player.id) && (slot.position === 'GK') === option.player.positions.includes('GK'));
      if (!pick) return null;
      used.add(pick.player.id);
      return { id: pick.player.id, name: pick.player.name, position: slot.position, positions: pick.player.positions.slice(), rating: pick.rating };
    }).filter(Boolean);
    return { id: `club:${clubId}`, name, strength, season: latest, squad };
  });
}
const clubsFor = room => room.config.competition === 'premier' && room.game ? premierClubs(room.game) : [];
class RoomError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const fail = (message, status) => { throw new RoomError(message, status); };
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 24) fail('Enter a name between 1 and 24 characters.');
  return value.trim();
}
function settings(input, capacity) {
  if (!Number.isInteger(capacity) || capacity < 2 || capacity > 8) fail('Choose between 2 and 8 managers.');
  const config = { managerCount: capacity, names: Array.from({ length: capacity }, (_, i) => `Manager ${i + 1}`), formation: input.formation,
    mode: input.mode, seasonFrom: input.seasonFrom, seasonTo: input.seasonTo, ratingMin: input.ratingMin, ratingMax: input.ratingMax, devMode: input.devMode === true, subs: input.subs === true, competition: input.competition === 'premier' ? 'premier' : 'friends' };
  if (!draft.poolShape(config.formation) || !['peak', 'season'].includes(config.mode) || !seasons.includes(config.seasonFrom) || !seasons.includes(config.seasonTo)
    || config.seasonFrom > config.seasonTo || !Number.isInteger(config.ratingMin) || !Number.isInteger(config.ratingMax)
    || config.ratingMin < 40 || config.ratingMax > 95 || config.ratingMin > config.ratingMax) fail('Choose valid formation, seasons and ratings.');
  const eligible = auction.candidates(players, config), coverage = auction.balance(eligible, config.formation, capacity, () => .47, config.subs);
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
    room.league = leagueCore.restore(room.league, room.game, { clubs: clubsFor(room) });
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
// A live matchday plays the full match clock in 18 seconds, or 2½ minutes of highlights in the beta pitch view.
const LIVE_MS = { classic: 18000, pitch: 150000 };
const isKeeper = (room, playerId) => !!room.game.pool.find(entry => entry.id === playerId)?.player.positions.includes('GK');
const keeperCount = (room, managerId) => auction.purchases(room.game, managerId).filter(sale => isKeeper(room, sale.playerId)).length;
const hasKeeper = (room, managerId) => keeperCount(room, managerId) > 0;
// Every squad gets its keepers (one, or two with substitutes): keeper owners skip extra keepers,
// and a manager's last spots are saved for the keepers they still need.
function canBuy(room, managerId, playerId) {
  const size = draft.squadSize(room.game.config), need = draft.keepersNeeded(room.game.config);
  const count = auction.purchases(room.game, managerId).length, keepers = keeperCount(room, managerId);
  if (count >= size) return false;
  return isKeeper(room, playerId) ? keepers < need : size - count - 1 >= need - keepers;
}
function eligible(room) { return room.game.managers.filter(manager => canBuy(room, manager.id, room.round.playerId)).map(manager => manager.id); }
function blocked(room, managerId) {
  if (auction.purchases(room.game, managerId).length >= draft.squadSize(room.game.config)) return 'Your squad is full.';
  if (canBuy(room, managerId, room.round.playerId)) return null;
  const need = draft.keepersNeeded(room.game.config);
  return isKeeper(room, room.round.playerId) ? (need === 1 ? 'You already have a goalkeeper.' : 'You already have two goalkeepers.') : 'Your last spots are saved for the goalkeepers you still need.';
}
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
// Dev mode: skip the auction. Every manager gets a full XI, each player in the spot the balanced pool drew them for.
function autoDraft(room) {
  const slots = draft.poolShape(room.game.config.formation), used = new Set();
  let game = room.game;
  for (const manager of game.managers) slots.forEach((slot, index) => {
    const entry = game.pool.find(entry => !used.has(entry.id) && entry.allocatedPosition === slot.position);
    used.add(entry.id);
    const price = Math.max(1, draft.rating(entry, game.config.mode) - 60);
    game = auction.buy({ ...game, phase: 'revealed', currentId: entry.id }, manager.id, price).game;
    game = auction.place(game, manager.id, entry.id, index).game;
  });
  if (game.config.subs) for (const manager of game.managers) {
    const outfield = game.pool.filter(entry => !used.has(entry.id) && !entry.player.positions.includes('GK')).slice(0, 5);
    for (const entry of outfield) { used.add(entry.id); game = auction.buy({ ...game, phase: 'revealed', currentId: entry.id }, manager.id, Math.max(1, draft.rating(entry, game.config.mode) - 65)).game; }
  }
  room.game = { ...game, currentId: game.sales.at(-1).playerId, phase: 'complete' }; room.status = 'complete';
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
      room.game = auction.createGame(config, pool.pool); room.status = 'draft';
      if (config.devMode) autoDraft(room);
      break;
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
      if (!active(room).includes(me.managerId)) fail(blocked(room, me.managerId) || 'You are out of this auction.', 409);
      const amount = command.price, bid = leading(room);
      if (!Number.isInteger(amount) || amount < 0) fail('Bid in whole millions.');
      if (bid && bid[0] === me.managerId) fail('You already have the highest bid. Wait to be outbid.', 409);
      if (bid && amount <= bid[1]) fail('Your bid must beat the current highest bid.', 409);
      // A free signing is only for a manager with no money left once everyone else has backed out.
      if (amount === 0 && !(auction.budget(room.game, me.managerId) === 0 && active(room).length === 1)) fail('Bids start at £1m. You can only take a player for free when you have no money left and everyone else has backed out.');
      if (amount > auction.budget(room.game, me.managerId)) fail('That bid exceeds your remaining budget.');
      room.round.offers[me.managerId] = amount;
      room.round.bids = [...room.round.bids, { managerId: me.managerId, price: amount, at: now }].slice(-12);
      if (room.round.startedAt === null) { room.round.startedAt = now; room.round.deadline = now + 60000; }
      else room.round.deadline += 10000;
      resolve(room, now); break;
    }
    case 'withdraw':
      if (now < room.round.opensAt) fail('Wait for the player to be revealed.', 409);
      if (!active(room).includes(me.managerId)) fail(blocked(room, me.managerId) || 'You have already backed out.', 409);
      if (leading(room)?.[0] === me.managerId) fail('You have the highest bid, so you are locked in.', 409);
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
    case 'formation': {
      // Free rooms: each manager picks a shape. Players move to the best-fitting spots in it.
      if (!room.game || room.league) fail('Formations are locked for the league.', 409);
      if (room.game.config.formation !== draft.FREE) fail('This room uses a fixed formation.');
      if (!draft.formations[command.formation]) fail('Choose a formation.');
      const manager = room.game.managers.find(manager => manager.id === me.managerId), current = draft.formationOf(room.game, manager);
      const board = draft.remap(manager.board.map(id => id ? room.game.pool.find(entry => entry.id === id) : null), current, command.formation).map(entry => entry?.id || null);
      room.game = { ...room.game, managers: room.game.managers.map(item => item.id === manager.id ? { ...item, formation: command.formation, board } : item) }; break;
    }
    case 'clearBoard': {
      if (!room.game || room.league) fail('The starting XIs are locked for the league.', 409);
      room.game = { ...room.game, managers: room.game.managers.map(manager => manager.id === me.managerId ? { ...manager, board: Array(11).fill(null) } : manager) }; break;
    }
    case 'autoPlace': {
      if (!room.game || room.league) fail('The starting XIs are locked for the league.', 409);
      const manager = room.game.managers.find(manager => manager.id === me.managerId);
      const unplaced = auction.purchases(room.game, me.managerId).filter(sale => !manager.board.includes(sale.playerId)).map(sale => room.game.pool.find(entry => entry.id === sale.playerId));
      const squad = manager.board.map(id => id ? room.game.pool.find(entry => entry.id === id) : unplaced.shift() || null);
      const formation = draft.formationOf(room.game, manager), board = draft.remap(squad, formation, formation).map(entry => entry?.id || null);
      room.game = { ...room.game, managers: room.game.managers.map(manager => manager.id === me.managerId ? { ...manager, board } : manager) }; break;
    }
    case 'startLeague': {
      host(room, uid);
      if (!room.game || room.status !== 'complete') fail('Finish the auction before starting the league.', 409);
      if (room.league) fail('The league has already started.', 409);
      const result = leagueCore.create(room.game, (room.seed ^ 0x52ff8844) >>> 0, { clubs: clubsFor(room) });
      if (result.error) fail(result.error);
      room.league = result.league; break;
    }
    case 'playRound':
    case 'finishLeague': {
      host(room, uid);
      if (!room.league || room.league.round >= leagueCore.roundCount(room.league)) fail('There is no matchday left to play.', 409);
      if (room.live && room.live.endsAt > now) fail('Wait for the matchday in play to finish.', 409);
      if (room.league.pending) fail('Kick off the second half first.', 409);
      // Only manager-v-manager matchdays play live; the rest of a Premier League season is instant.
      const derby = room.league.fixtures.some(fixture => fixture.round === room.league.round && leagueCore.managerDerby(room.league, fixture));
      const view = room.matchView === 'pitch' ? 'pitch' : 'classic';
      if (command.type === 'playRound' && derby && room.league.subs) {
        // Substitutes mode: play the first half, then stop for half-time changes.
        room.league = leagueCore.startRound(room.league).league;
        room.live = { round: room.league.round, startsAt: now, endsAt: now + LIVE_MS[view] / 2, view, from: 0, to: 48, half: 1 };
        break;
      }
      if (command.type === 'playRound' && derby) room.live = { round: room.league.round, startsAt: now, endsAt: now + LIVE_MS[view], view, from: 0, to: 97 };
      else room.live = null;
      do { room.league = leagueCore.playRound(room.league).league; } while (command.type === 'finishLeague' && room.league.round < leagueCore.roundCount(room.league));
      break;
    }
    case 'substitute':
    case 'swapHalf':
    case 'undoSub':
    case 'readyHalf': {
      const pending = room.league?.pending;
      if (!pending) fail('Substitutions are made at half-time.', 409);
      if (room.live && room.live.endsAt > now) fail('Wait for half-time.', 409);
      const fixture = room.league.fixtures.find(item => pending.firstHalf[item.id] && (item.homeId === me.managerId || item.awayId === me.managerId));
      if (!fixture) fail('You are not playing in a live match this matchday.', 409);
      const side = fixture.homeId === me.managerId ? 'home' : 'away', snapshot = room.league.teams.find(item => item.id === me.managerId);
      pending.changes[fixture.id] = pending.changes[fixture.id] || { home: [], away: [] };
      const mine = pending.changes[fixture.id][side];
      if (command.type === 'readyHalf') { pending.ready[me.managerId] = command.ready === true; break; }
      if (command.type === 'undoSub') { if (!mine.length) fail('There is no change to undo.'); mine.pop(); pending.ready[me.managerId] = false; break; }
      const onPitch = leagueCore.lineupAfter(snapshot, mine);
      if (command.type === 'swapHalf') {
        if (!Array.isArray(command.swap) || command.swap.length !== 2 || command.swap[0] === command.swap[1] || !command.swap.every(id => onPitch.some(player => player.id === id))) fail('Choose two players on the pitch to swap.');
        mine.push({ swap: [command.swap[0], command.swap[1]] }); pending.ready[me.managerId] = false; break;
      }
      if (mine.filter(change => change.on).length >= 5) fail('You have made all five substitutions.', 409);
      if (!onPitch.some(player => player.id === command.off)) fail('Choose a player who is on the pitch.');
      if (!snapshot.bench?.some(player => player.id === command.on) || mine.some(change => change.on === command.on)) fail('Choose a substitute from your bench.');
      mine.push({ off: command.off, on: command.on }); pending.ready[me.managerId] = false; break;
    }
    case 'secondHalf': {
      host(room, uid);
      if (!room.league?.pending) fail('There is no half-time to finish.', 409);
      if (room.live && room.live.endsAt > now) fail('Wait for half-time.', 409);
      const view = room.live?.view || (room.matchView === 'pitch' ? 'pitch' : 'classic'), round = room.league.round;
      room.league = leagueCore.finishRound(room.league).league;
      room.live = { round, startsAt: now, endsAt: now + LIVE_MS[view] / 2, view, from: 48, to: 97, half: 2 };
      break;
    }
    case 'skipToDerby': {
      host(room, uid);
      if (room.league?.pending) fail('Kick off the second half first.', 409);
      if (!room.league || room.league.round >= leagueCore.roundCount(room.league)) fail('There is no matchday left to play.', 409);
      if (room.live && room.live.endsAt > now) fail('Wait for the matchday in play to finish.', 409);
      const stop = leagueCore.nextDerbyRound(room.league);
      if (stop === room.league.round) fail('The next matchday is a manager match. Play it live.', 409);
      room.live = null;
      while (room.league.round < (stop ?? leagueCore.roundCount(room.league))) room.league = leagueCore.playRound(room.league).league;
      break;
    }
    case 'matchView':
      host(room, uid);
      if (!['classic', 'pitch'].includes(command.view)) fail('Choose a match view.');
      room.matchView = command.view; break;
    case 'ratings':
      host(room, uid);
      room.showRatings = command.show === true; break;
    case 'settings': {
      host(room, uid);
      if (room.status !== 'lobby') fail('The rules are locked once the auction starts.', 409);
      const capacity = command.capacity;
      if (Number.isInteger(capacity) && capacity < room.members.length) fail(`${room.members.length} managers have joined. Remove someone before lowering the number.`);
      room.config = settings(command.config || {}, capacity); room.capacity = capacity;
      // New rules need everyone to agree again.
      room.members.forEach(member => { member.ready = false; }); break;
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
const finished = room => !!room.league && room.league.round >= leagueCore.roundCount(room.league);
// Point a finished room at its rematch. The first rematch wins; later callers join it.
function linkNext(room, uid, next) {
  member(room, uid);
  if (!finished(room)) fail('Finish the league before starting a new game.', 409);
  if (room.next) return { room, changed: false };
  room.next = next; return { room, changed: true };
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
  // Planned Premier League results stay on the server until each matchday is played.
  const league = room.league && { round: room.league.round, teams: room.league.teams, fixtures: room.league.fixtures, engineVersion: room.league.engineVersion, competition: room.league.competition || 'friends', nextDerby: leagueCore.nextDerbyRound(room.league), subs: !!room.league.subs, pending: room.league.pending || null };
  return { id: room.id, code: room.code, capacity: room.capacity, config: room.config, status: room.status, revision: room.revision, expiresAt: room.expiresAt,
    isHost: room.hostUid === uid, me: me.managerId, preview: room.config.competition === 'premier' && room.game && !room.league ? premierClubs(room.game).map(club => ({ name: club.name, strength: club.strength })) : null, showRatings: room.showRatings !== false, finished: finished(room), next: room.next || null, live: room.live || null, matchView: room.matchView === 'pitch' ? 'pitch' : 'classic',
    keepers: room.game ? room.game.managers.filter(manager => hasKeeper(room, manager.id)).map(manager => manager.id) : [], members: room.members.map(member => ({ managerId: member.managerId, name: member.name, ready: member.ready, isHost: member.uid === room.hostUid })), game, round, league };
}
module.exports = { FIELD, premierClubs, RoomError, create, pack, unpack, join, apply, view, resolve, leading, finished, linkNext, seasons, players };
