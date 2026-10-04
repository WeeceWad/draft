const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const draft = require('../src/draft-core.js');
const auction = require('../src/auction-core.js');
const core = require('../src/league-core.js');
const reference = require('./research-38-0.cjs');
const players = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/38-0/players.json'), 'utf8'));
function completeGame(count = 3, formation = '4-3-3', mode = 'peak') {
  const config = { managerCount: count, names: Array.from({ length: count }, (_, index) => `Manager ${index + 1}`), formation, mode, seasonFrom: '1992/93', seasonTo: '2026/27', ratingMin: 40, ratingMax: 95 };
  const pool = auction.makePool(players, config, core.seeded(31)).pool;
  let game = auction.createGame(config, pool);
  const used = new Set();
  for (const manager of game.managers) draft.formations[formation].forEach((slot, index) => {
    const entry = pool.find(entry => !used.has(entry.id) && entry.allocatedPosition === slot.position);
    used.add(entry.id);
    game = auction.buy({ ...game, phase: 'revealed', currentId: entry.id }, manager.id, 10).game;
    game = auction.place(game, manager.id, entry.id, index).game;
  });
  return game;
}
// Compare the independent implementation with the actual public reference module.
const positions = ['GK', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'ST'];
for (const slot of positions) for (const first of positions) for (const second of positions) {
  assert.equal(core.naturalRank(slot, [first, second]), reference.positions.naturalRank(slot, [first, second]), `${slot} vs ${first}/${second}`);
}
for (const formation of Object.keys(draft.formations)) for (const mode of ['peak', 'season']) {
  const game = completeGame(3, formation, mode);
  for (const manager of game.managers) {
    const own = core.team(game, manager);
    const referenceTeam = draft.formations[formation].map((slot, index) => {
      const entry = game.pool.find(entry => entry.id === manager.board[index]);
      return { slot: { ...slot, unit: ['LWB', 'RWB'].includes(slot.position) ? (formation.startsWith('5-') ? 'def' : 'mid') : undefined }, player: { ...entry.player, overall: entry.player.peakRating }, ratingUsed: draft.rating(entry, mode) };
    });
    const expected = reference.ratings.calcEffectiveRating(referenceTeam);
    for (const key of ['overall', 'attack', 'midfield', 'defence', 'goalkeeping']) assert.equal(own[key], expected[key], `${formation} ${mode} ${key}`);
  }
}
for (const homeRating of [40, 60, 80, 95]) for (const awayRating of [40, 60, 80, 95]) for (let seed = 0; seed < 40; seed++) {
  const home = { name: 'Home', overall: homeRating, squad: [] }, away = { name: 'Away', overall: awayRating, squad: [] };
  const expected = reference.headToHead(home, away, seed).legs[0];
  const own = core.simulateMatch(home, away, seed);
  assert.equal(own.homeGoals, expected.homeGoals);
  assert.equal(own.awayGoals, expected.awayGoals);
}
// Complete match reports against 38-0's own head-to-head: scores, scorers, minutes and stoppage time.
let assisted = 0, goalCount = 0;
for (const formation of ['4-3-3', '3-5-2', '5-3-2']) {
  const game = completeGame(2, formation, 'season'), [home, away] = game.managers.map(manager => core.team(game, manager));
  const report = goals => JSON.parse(JSON.stringify(goals.map(goal => [goal.minute, goal.stoppage ?? 0, goal.name ?? goal.scorer])));
  for (let seed = 0; seed < 300; seed++) {
    const expected = reference.headToHead(home, away, seed).legs[0], own = core.simulateMatch(home, away, seed);
    assert.deepEqual(report(own.homeScorers), report(expected.homeScorers), `${formation} seed ${seed} home goals`);
    assert.deepEqual(report(own.awayScorers), report(expected.awayScorers), `${formation} seed ${seed} away goals`);
    const goals = [...own.homeScorers, ...own.awayScorers], minutes = goals.map(core.absoluteMinute);
    assert.equal(new Set(minutes).size, minutes.length, 'No two goals share a minute');
    for (const goal of goals) { goalCount++; if (goal.assistId) { assisted++; assert.notEqual(goal.assistId, goal.playerId); } }
  }
}
assert(Math.abs(assisted / goalCount - .72) < .04, `About 72% of goals are assisted (${assisted}/${goalCount})`);
assert.equal(core.minuteLabel({ minute: 90, stoppage: 3 }), '90+3′');
assert(Math.abs(core.expectedGoals(80, 80, true) - 1.7) < 1e-10);
assert.equal(core.expectedGoals(80, 80, false), 1.35);
let strongWins = 0, weakWins = 0, homeGoals = 0, awayGoals = 0;
for (let seed = 0; seed < 10000; seed++) {
  const result = core.simulateMatch({ overall: 90, squad: [] }, { overall: 70, squad: [] }, seed);
  if (result.homeGoals > result.awayGoals) strongWins++;
  if (result.homeGoals < result.awayGoals) weakWins++;
  const equal = core.simulateMatch({ overall: 80, squad: [] }, { overall: 80, squad: [] }, seed);
  homeGoals += equal.homeGoals; awayGoals += equal.awayGoals;
}
assert(strongWins > weakWins * 4 && weakWins > 0, 'Strength matters while upsets remain possible');
assert(Math.abs(homeGoals / 10000 - 1.7) < .06 && Math.abs(awayGoals / 10000 - 1.35) < .06);
for (let count = 2; count <= 8; count++) {
  const game = completeGame(count);
  let league = core.create(game, 65432).league;
  assert.equal(league.fixtures.length, count * (count - 1));
  const pairs = new Set(league.fixtures.map(fixture => `${fixture.homeId}/${fixture.awayId}`));
  assert.equal(pairs.size, league.fixtures.length, 'Exactly one home match against every opponent');
  for (let round = 0; round < core.roundCount(league); round++) {
    const fixtures = league.fixtures.filter(fixture => fixture.round === round);
    assert.equal(new Set(fixtures.flatMap(fixture => [fixture.homeId, fixture.awayId])).size, fixtures.length * 2, 'No team plays twice in a round');
    league = core.playRound(league).league;
    assert.deepEqual(core.restore(core.serialise(league), game), league, 'Reload preserves every score');
  }
  const table = core.table(league);
  assert(table.every(row => row.played === 2 * (count - 1) && row.won + row.drawn + row.lost === row.played && row.points === row.won * 3 + row.drawn));
  assert.equal(table.reduce((sum, row) => sum + row.gf, 0), table.reduce((sum, row) => sum + row.ga, 0));
  assert.equal(table.reduce((sum, row) => sum + row.gd, 0), 0);
  for (const fixture of league.fixtures) {
    assert.equal(fixture.result.homeScorers.length, fixture.result.homeGoals);
    assert.equal(fixture.result.awayScorers.length, fixture.result.awayGoals);
    const home = league.teams.find(team => team.id === fixture.homeId);
    assert(fixture.result.homeScorers.every(scorer => home.squad.some(player => player.id === scorer.playerId && player.position !== 'GK')));
  }
  assert(core.playRound(league).error);
  assert(core.restore({ ...core.serialise(league), round: 999 }, game) === null);
  assert(core.restore({ ...core.serialise(league), engineVersion: 'other' }, game) === null);
}
const game = completeGame();
assert(core.create(auction.unplace(game, 'manager-1', game.managers[0].board[0]), 1).error);
const awards = core.awards(game);
assert.equal(awards.biggestBuy.price, 10);
assert.equal(awards.biggestSpender.spent, 110);
const free = { ...game, sales: game.sales.map(sale => ({ ...sale, price: 0 })) };
assert(Number.isFinite(core.awards(free).bargain.estimated));
console.log('League checks passed: public reference parity for position fit, team units and 640 match scores; statistical strength/home advantage; double round-robin for 2–8 teams, points, scorers, awards and deterministic save/resume.');
