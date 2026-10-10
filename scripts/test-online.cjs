const assert = require('node:assert/strict');
const engine = require('../server/room-engine.cjs');
const auction = require('../src/auction-core.js');
const league = require('../src/league-core.js');
const config = { formation: '4-3-3', mode: 'peak', seasonFrom: '1992/93', seasonTo: '2026/27', ratingMin: 40, ratingMax: 95 };
let time = 100000, sequence = 0;
function lobby(count = 3) {
  let room = engine.create({ id: 'test', code: '0001', uid: 'a', displayName: 'Alex', capacity: count, config, seed: 789, now: time });
  for (let index = 1; index < count; index++) room = engine.join(room, String.fromCharCode(97 + index), `Manager ${index + 1}`, time);
  room.members.forEach(member => { room = engine.apply(room, member.uid, { type: 'ready', ready: true }, time).room; });
  return room;
}
function command(room, uid, type, details = {}) { return engine.apply(room, uid, { type, requestId: String(++sequence), ...details }, time).room; }
// The host can change every rule in the lobby; new rules ask everyone to ready up again.
{
  let open = lobby();
  assert.throws(() => command(open, 'b', 'settings', { capacity: 3, config }), /Only the host/);
  assert.throws(() => command(open, 'a', 'settings', { capacity: 2, config }), /Remove someone/);
  assert.throws(() => command(open, 'a', 'settings', { capacity: 3, config: { ...config, ratingMin: 95 } }), /Widen/);
  open = command(open, 'a', 'settings', { capacity: 4, config: { ...config, formation: '3-5-2', mode: 'season', seasonFrom: '2000/01', ratingMin: 60 } });
  assert.equal(open.capacity, 4); assert.deepEqual([open.config.formation, open.config.mode, open.config.seasonFrom, open.config.ratingMin], ['3-5-2', 'season', '2000/01', 60]);
  assert(open.members.every(member => !member.ready)); assert.equal(engine.view(open, 'b').capacity, 4);
  assert.throws(() => command(open, 'a', 'start'), /Wait for every manager/);
}
// Dev mode skips the auction: full XIs, everyone in a position they play, ready for the league.
{
  let dev = lobby();
  dev = command(dev, 'a', 'settings', { capacity: 3, config: { ...config, formation: '3-5-2', devMode: true } });
  dev.members.forEach(member => { dev = command(dev, member.uid, 'ready', { ready: true }); });
  dev = command(dev, 'a', 'start');
  assert.equal(dev.status, 'complete'); assert.equal(dev.game.sales.length, 33); assert.equal(dev.round, null);
  const draft = require('../src/draft-core.js');
  for (const manager of dev.game.managers) {
    assert.equal(manager.board.filter(Boolean).length, 11);
    manager.board.forEach((id, index) => assert(draft.fits(dev.game.pool.find(entry => entry.id === id).player, draft.formations['3-5-2'][index].position), 'Every player is in a position they play'));
    assert(auction.budget(dev.game, manager.id) >= 0);
  }
  assert(league.readiness(dev.game).ready);
  dev = command(dev, 'a', 'startLeague'); assert(dev.league);
  assert.equal(engine.unpack(engine.pack(dev)).status, 'complete');
}
// Free formation: each manager picks their own shape; players move to the best-fitting spots.
{
  let free = lobby();
  free = command(free, 'a', 'settings', { capacity: 3, config: { ...config, formation: 'Free', devMode: true } });
  free.members.forEach(member => { free = command(free, member.uid, 'ready', { ready: true }); });
  free = command(free, 'a', 'start');
  const draft = require('../src/draft-core.js');
  assert.equal(league.team(free.game, free.game.managers[1]).formation, '4-3-3', 'Free rooms start each XI in a 4-3-3');
  free = command(free, 'b', 'formation', { formation: '3-5-2' });
  free = command(free, 'c', 'formation', { formation: '5-3-2' });
  assert.throws(() => command(free, 'b', 'formation', { formation: 'Nonsense' }), /Choose a formation/);
  const teams = free.game.managers.map(manager => league.team(free.game, manager));
  assert.deepEqual(teams.map(team => team.formation), ['4-3-3', '3-5-2', '5-3-2']);
  assert(teams.every(team => team.placed === 11), 'Changing formation keeps every player on the pitch');
  assert.equal(engine.unpack(engine.pack(free)).game.managers[1].formation, '3-5-2', 'Chosen formations survive save and restore');
  free = command(free, 'a', 'startLeague');
  assert.deepEqual(free.league.teams.map(team => team.formation), ['4-3-3', '3-5-2', '5-3-2']);
  assert.throws(() => command(free, 'b', 'formation', { formation: '4-4-2' }), /locked/);
}
// Premier League mode: the managers join 38-0's clubs in a 20-team, 38-matchday league.
{
  let pl = lobby();
  pl = command(pl, 'a', 'settings', { capacity: 3, config: { ...config, devMode: true, competition: 'premier' } });
  pl.members.forEach(member => { pl = command(pl, member.uid, 'ready', { ready: true }); });
  pl = command(pl, 'a', 'start'); pl = command(pl, 'a', 'startLeague');
  assert.equal(pl.league.teams.length, 20); assert.equal(pl.league.fixtures.length, 380); assert.equal(league.roundCount(pl.league), 38);
  const clubs = pl.league.teams.filter(team => team.club);
  assert.equal(clubs.length, 17); assert.equal(clubs[0].name, 'Manchester City'); assert(clubs.every(club => club.squad.length === 11));
  const drafted = new Set(pl.game.pool.map(entry => entry.id));
  assert(clubs.every(club => club.squad.every(player => !drafted.has(player.id))), 'Club squads never include drafted players');
  const shown = engine.view(pl, 'b');
  assert.equal(shown.league.planned, undefined, 'Future results stay on the server');
  assert(shown.league.fixtures.every(fixture => !fixture.result));
  const derbyRound = league.nextDerbyRound(pl.league);
  if (derbyRound > 0) {
    pl = command(pl, 'a', 'playRound'); assert.equal(pl.live, null, 'Matchdays without a manager match are instant');
    if (pl.league.round < derbyRound) pl = command(pl, 'a', 'skipToDerby');
    assert.equal(pl.league.round, derbyRound);
  }
  assert.throws(() => command(pl, 'a', 'skipToDerby'), /Play it live/);
  pl = command(pl, 'a', 'playRound'); assert(pl.live, 'Manager matches play live');
  assert.equal(engine.unpack(engine.pack(pl)).league.fixtures.filter(fixture => fixture.result).length, pl.league.fixtures.filter(fixture => fixture.result).length);
  assert.deepEqual(engine.unpack(engine.pack(pl)).league.fixtures, pl.league.fixtures, 'Premier League seasons replay exactly');
  time = pl.live.endsAt; pl = command(pl, 'a', 'finishLeague');
  const table = league.table(pl.league);
  assert.equal(table.length, 20); assert(table.every(row => row.played === 38));
  assert.equal(table.reduce((sum, row) => sum + row.won, 0), table.reduce((sum, row) => sum + row.lost, 0));
  assert(engine.finished(pl));
}
// Substitutes mode (Touchline's own rules): 16-player squads with two keepers, half-time changes and fatigue.
{
  const draft = require('../src/draft-core.js');
  let subs = lobby();
  subs = command(subs, 'a', 'settings', { capacity: 3, config: { ...config, subs: true } });
  subs.members.forEach(member => { subs = command(subs, member.uid, 'ready', { ready: true }); });
  subs = command(subs, 'a', 'start');
  assert.equal(subs.game.pool.length, 48); assert.equal(subs.game.pool.filter(entry => entry.player.positions.includes('GK')).length, 3, 'Benches are outfield players: one keeper per squad');
  while (subs.status !== 'complete') {
    subs = command(subs, 'a', 'reveal'); time += 2000;
    const active = engine.view(subs, 'a').round.active, winner = subs.members.find(member => active.includes(member.managerId));
    subs = command(subs, winner.uid, 'bid', { price: 1 });
    if (subs.round.status === 'open') { time = subs.round.deadline; subs = command(subs, null, 'tick'); }
  }
  for (const manager of subs.game.managers) {
    const owned = auction.purchases(subs.game, manager.id);
    assert.equal(owned.length, 16, 'Substitutes squads have 16 players');
    assert.equal(owned.filter(sale => subs.game.pool.find(entry => entry.id === sale.playerId).player.positions.includes('GK')).length, 1, 'Every squad ends with one keeper');
  }
  subs.members.forEach(member => { subs = command(subs, member.uid, 'autoPlace'); });
  subs = command(subs, 'a', 'startLeague');
  const snapshot = subs.league.teams.find(team => team.id === 'manager-1');
  assert.equal(snapshot.squad.length, 11); assert.equal(snapshot.bench.length, 5);
  subs = command(subs, 'a', 'playRound');
  assert(subs.league.pending, 'Matchdays stop at half-time');
  assert.deepEqual([subs.live.from, subs.live.to, subs.live.half, subs.live.endsAt - time], [0, 48, 1, 9000]);
  const fixture = subs.league.fixtures.find(item => subs.league.pending.firstHalf[item.id]);
  const firstHalf = subs.league.pending.firstHalf[fixture.id];
  assert([...firstHalf.homeScorers, ...firstHalf.awayScorers].every(goal => league.absoluteMinute(goal) <= 48), 'First-half goals happen in the first half');
  const homeUid = subs.members.find(member => member.managerId === fixture.homeId).uid, homeTeam = subs.league.teams.find(team => team.id === fixture.homeId);
  assert.throws(() => command(subs, homeUid, 'substitute', { off: homeTeam.squad[0].id, on: homeTeam.bench[0].id }), /Wait for half-time/);
  time = subs.live.endsAt;
  assert.throws(() => command(subs, homeUid, 'substitute', { off: homeTeam.bench[0].id, on: homeTeam.bench[1].id }), /on the pitch/);
  const outfield = homeTeam.squad.filter(player => player.position !== 'GK');
  for (let index = 0; index < 5; index++) subs = command(subs, homeUid, 'substitute', { off: outfield[index].id, on: homeTeam.bench[index].id });
  assert.throws(() => command(subs, homeUid, 'substitute', { off: outfield[5].id, on: homeTeam.bench[0].id }), /all five/);
  subs = command(subs, homeUid, 'undoSub');
  const [left, right] = league.lineupAfter(homeTeam, subs.league.pending.changes[fixture.id].home).filter(player => player.position !== 'GK');
  assert.throws(() => command(subs, homeUid, 'swapHalf', { swap: [left.id, left.id] }), /two players/);
  subs = command(subs, homeUid, 'swapHalf', { swap: [left.id, right.id] });
  const swapped = league.lineupAfter(homeTeam, subs.league.pending.changes[fixture.id].home);
  assert.equal(swapped.find(player => player.id === left.id).position, right.position, 'Half-time swaps move players between positions');
  assert.equal(swapped.find(player => player.id === left.id).stamina, left.stamina, 'Moved players keep their stamina');
  subs = command(subs, homeUid, 'readyHalf', { ready: true });
  assert.equal(subs.league.pending.ready[fixture.homeId], true);
  const saved = engine.unpack(engine.pack(subs));
  assert.deepEqual(saved.league.pending.changes, subs.league.pending.changes, 'Half-time changes survive a restart');
  assert.throws(() => command(subs, 'b', 'secondHalf'), /Only the host/);
  assert.throws(() => command(subs, 'a', 'playRound'), /second half/);
  subs = command(subs, 'a', 'secondHalf');
  assert.equal(subs.league.round, 1); assert.equal(subs.league.pending, null); assert.deepEqual([subs.live.from, subs.live.to, subs.live.half], [48, 97, 2]);
  const result = subs.league.fixtures.find(item => item.id === fixture.id).result;
  assert.equal(result.subs.home.filter(change => change.on).length, 4); assert.equal(result.subs.home.filter(change => change.swap).length, 1); assert.deepEqual(result.halfTime, { home: firstHalf.homeGoals, away: firstHalf.awayGoals });
  const pitch = new Set(league.lineupAfter(homeTeam, result.subs.home).map(player => player.id));
  assert(result.homeScorers.filter(goal => league.absoluteMinute(goal) > 48).every(goal => pitch.has(goal.playerId)), 'Second-half scorers were on the pitch');
  assert(league.secondHalfTeam(homeTeam, []).overall <= homeTeam.overall, 'Tired starters are weaker after the break');
  time = subs.live.endsAt; subs = command(subs, 'a', 'finishLeague');
  assert(subs.league.fixtures.every(item => item.result.halfTime && item.result.subs));
  assert.deepEqual(engine.unpack(engine.pack(subs)).league.fixtures, subs.league.fixtures, 'Substitutes seasons replay exactly');
}
let room = command(lobby(), 'a', 'start');
assert.equal(room.status, 'draft', 'Without dev mode the auction runs');
assert.throws(() => command(room, 'b', 'formation', { formation: '3-5-2' }), /fixed formation/);
assert.throws(() => command(room, 'a', 'settings', { capacity: 3, config }), /locked/);
assert.equal(room.game.pool.length, 33);
assert.equal(room.game.pool.filter(entry => entry.player.positions.includes('GK')).length, 3);
assert.throws(() => command(room, 'b', 'reveal'), /Only the host/);
room = command(room, 'a', 'reveal');
assert.throws(() => command(room, 'a', 'bid', { price: 10 }), /Wait for/);
time += 2000;
assert.equal(room.round.deadline, null);
room = command(room, 'a', 'bid', { price: 100, roundId: 1 });
assert.equal(room.round.deadline, time + 60000);
const firstDeadline = room.round.deadline;
time += 30000;
room = command(room, 'b', 'bid', { price: 150, roundId: 1 });
assert.equal(room.round.deadline, firstDeadline + 10000);
assert.throws(() => command(room, 'c', 'bid', { price: 150 }), /beat/);
assert.throws(() => command(room, 'c', 'bid', { price: 1001 }), /budget/);
const token = 'retry';
assert.throws(() => command(room, 'b', 'bid', { price: 200 }), /already have the highest bid/, 'The leader cannot raise their own bid');
room = engine.apply(room, 'c', { type: 'bid', price: 200, requestId: token }, time).room;
const deadline = room.round.deadline;
assert.equal(engine.apply(room, 'c', { type: 'bid', price: 200, requestId: token }, time).changed, false);
assert.equal(room.round.deadline, deadline);
assert.throws(() => command(room, 'c', 'withdraw'), /locked in/, 'The highest bidder cannot back out');
room = command(room, 'b', 'bid', { price: 250 });
assert.deepEqual(engine.leading(room), ['manager-2', 250], 'An outbid manager can bid again');
room = command(room, 'a', 'withdraw');
assert.throws(() => command(room, 'a', 'bid', { price: 300 }), /out/);
room = command(room, 'c', 'withdraw');
assert.equal(room.round.status, 'sold'); assert.equal(room.round.winnerId, 'manager-2');
assert.equal(room.game.sales.length, 1); assert.equal(auction.budget(room.game, 'manager-2'), 750);
assert.equal(auction.STARTING_BUDGET, 1000, 'Budgets are £1bn in whole millions');
assert.throws(() => command(room, 'a', 'place', { playerId: room.round.playerId, slot: 0 }), /another manager/);
room = command(room, 'b', 'place', { playerId: room.round.playerId, slot: 0 });
assert.equal(room.game.managers[1].board[0], room.round.playerId);
room = command(room, 'b', 'clearBoard'); assert(room.game.managers[1].board.every(id => id === null));
room = command(room, 'b', 'place', { playerId: room.round.playerId, slot: 0 });
const restored = engine.unpack(engine.pack(room));
assert.deepEqual(restored.game.sales, room.game.sales); assert.deepEqual(restored.game.managers, room.game.managers);
room = command(room, 'a', 'reveal'); time += 2000;
const publicState = engine.view(room, 'b');
assert.equal(publicState.game.pool.length, 2);
assert.equal(publicState.game.remaining, undefined); assert.equal(publicState.seed, undefined);
assert.equal(publicState.round.offers, undefined); assert.equal(publicState.members[0].uid, undefined);
assert.throws(() => command(room, 'a', 'bid', { price: 10, roundId: 1 }), /next player/);
room = command(room, 'a', 'bid', { price: 10 }); time = room.round.deadline;
const late = engine.apply(room, 'b', { type: 'bid', price: 20 }, time);
assert(late.error); room = late.room; assert.equal(room.round.status, 'sold');
assert.equal(room.game.sales.length, 2); assert.equal(engine.apply(room, null, { type: 'tick' }, time).changed, false);
room = command(room, 'a', 'reveal'); time += 2000;
assert.throws(() => command(room, 'c', 'bid', { price: 0 }), /£1m/, 'Free bids need an empty budget');
room = command(room, 'a', 'withdraw'); room = command(room, 'b', 'withdraw');
assert.equal(room.round.status, 'open'); assert.equal(room.round.deadline, null);
assert.throws(() => command(room, 'c', 'bid', { price: 0 }), /£1m/, 'Free bids need an empty budget even when alone');
room = command(room, 'c', 'bid', { price: 1 }); assert.equal(room.round.status, 'sold');
room = command(room, 'a', 'reveal'); time += 2000;
room = command(room, 'a', 'withdraw'); room = command(room, 'b', 'withdraw'); room = command(room, 'c', 'withdraw');
assert.equal(room.round.status, 'passed'); assert.equal(room.game.sales.length, 3);
// A manager who spends everything can only take a player free once everyone else is out.
room = command(room, 'a', 'reveal'); time += 2000;
room = command(room, 'a', 'withdraw'); room = command(room, 'b', 'withdraw');
room = command(room, 'c', 'bid', { price: auction.budget(room.game, 'manager-3') }); assert.equal(auction.budget(room.game, 'manager-3'), 0);
room = command(room, 'a', 'reveal'); time += 2000;
assert.throws(() => command(room, 'c', 'bid', { price: 0 }), /£1m/);
room = command(room, 'a', 'withdraw'); room = command(room, 'b', 'withdraw');
room = command(room, 'c', 'bid', { price: 0 }); assert.equal(room.round.status, 'sold'); assert.equal(room.round.winnerId, 'manager-3');
// Rating visibility is a room setting only the host controls.
assert.throws(() => command(room, 'b', 'ratings', { show: false }), /Only the host/);
room = command(room, 'a', 'ratings', { show: false }); assert.equal(engine.view(room, 'c').showRatings, false);
room = command(room, 'a', 'ratings', { show: true }); assert.equal(engine.view(room, 'c').showRatings, true);
assert.throws(() => command(lobby(), 'a', 'startLeague'), /Finish the auction/);
// Complete every squad, simulate all double round-robin fixtures, restore results.
while (room.status !== 'complete') {
  room = command(room, 'a', 'reveal'); time += 2000;
  const active = engine.view(room, 'a').round.active, keeper = room.game.pool.find(entry => entry.id === room.round.playerId).player.positions.includes('GK');
  for (const member of room.members) if (keeper && !active.includes(member.managerId) && auction.purchases(room.game, member.managerId).length < 11) assert.throws(() => command(room, member.uid, 'bid', { price: 1 }), /already have a goalkeeper/);
  const winner = room.members.find(member => active.includes(member.managerId)), broke = auction.budget(room.game, winner.managerId) === 0;
  if (broke) for (const other of room.members) if (other !== winner && active.includes(other.managerId)) room = command(room, other.uid, 'withdraw');
  room = command(room, winner.uid, 'bid', { price: broke ? 0 : 1 });
  if (room.round.status === 'open') { time = room.round.deadline; room = command(room, null, 'tick'); }
}
for (const manager of room.game.managers) assert.equal(auction.purchases(room.game, manager.id).filter(sale => room.game.pool.find(entry => entry.id === sale.playerId).player.positions.includes('GK')).length, 1, 'Every XI ends with exactly one goalkeeper');
room.members.forEach(member => { room = command(room, member.uid, 'autoPlace'); });
assert(room.game.managers.every(manager => manager.board.filter(Boolean).length === 11));
room = command(room, 'a', 'startLeague');
assert.throws(() => command(room, 'b', 'playRound'), /Only the host/);
assert.throws(() => command(room, 'a', 'autoPlace'), /locked/);
assert.throws(() => command(room, 'b', 'matchView', { view: 'pitch' }), /Only the host/);
room = command(room, 'a', 'playRound');
assert.deepEqual(engine.view(room, 'b').live, { round: 0, startsAt: time, endsAt: time + 18000, view: 'classic', from: 0, to: 97 });
time = room.live.endsAt; room = command(room, 'a', 'matchView', { view: 'pitch' }); assert.equal(engine.view(room, 'c').matchView, 'pitch');
room = command(room, 'a', 'playRound');
assert.deepEqual(engine.view(room, 'b').live, { round: 1, startsAt: time, endsAt: time + 150000, view: 'pitch', from: 0, to: 97 }, 'The beta pitch view plays longer matchdays');
assert.throws(() => command(room, 'a', 'playRound'), /in play/); assert.throws(() => command(room, 'a', 'finishLeague'), /in play/);
time = room.live.endsAt;
room = command(room, 'a', 'finishLeague'); assert.equal(room.live, null);
assert.equal(room.league.fixtures.length, 6); assert.equal(room.league.round, 6);
const view = require('../src/match-view.js');
for (const fixture of room.league.fixtures) {
  const team = id => room.league.teams.find(team => team.id === id), timeline = view.build({ result: fixture.result, home: team(fixture.homeId), away: team(fixture.awayId), seed: 99, duration: 150 });
  const goals = [...fixture.result.homeScorers, ...fixture.result.awayScorers];
  assert.equal(timeline.events.filter(event => event.goal).length, goals.length, 'The pitch view shows every real goal');
  for (const goal of goals) assert(timeline.events.some(event => event.goal && event.abs === league.absoluteMinute(goal) && event.text === `GOAL! ${goal.name}`));
  assert.equal(view.clockAt(timeline, 149), view.END, 'Highlights finish at full time');
}
assert(league.table(room.league).every(row => row.played === 4));
assert.deepEqual(engine.unpack(engine.pack(room)).league, room.league);
// Finished rooms point every member at a single rematch lobby.
assert(engine.finished(room) && engine.view(room, 'b').finished);
assert.throws(() => engine.linkNext(lobby(), 'a', { id: 'early', code: '0003' }), /Finish the league/);
assert.throws(() => engine.linkNext(room, 'stranger', { id: 'x', code: '0004' }), /not a member/);
const linked = engine.linkNext(room, 'b', { id: 'next', code: '0002' });
assert(linked.changed); assert.deepEqual(engine.view(linked.room, 'c').next, { id: 'next', code: '0002' });
const second = engine.linkNext(linked.room, 'c', { id: 'other', code: '0005' });
assert.equal(second.changed, false); assert.equal(second.room.next.id, 'next', 'The first rematch wins');
console.log('Online engine passed: hidden balanced pool, timer extensions, withdrawals, late bids, budgets, ownership, save/restore and full league.');
