(function (scope) {
  const draft = typeof module !== 'undefined' ? require('./draft-core.js') : scope.DraftCore;
  const auction = typeof module !== 'undefined' ? require('./auction-core.js') : scope.AuctionCore;
  const VERSION = 'touchline-head-to-head-v1';
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const units = { GK: 'goalkeeping', CB: 'defence', LB: 'defence', RB: 'defence', CM: 'midfield', CDM: 'midfield', LM: 'midfield', RM: 'midfield', CAM: 'attack', LW: 'attack', RW: 'attack', ST: 'attack' };
  const unitWeights = { attack: .30, midfield: .30, defence: .28, goalkeeping: .12 };
  const scorerWeights = { GK: 0, CB: 1, LB: 2, RB: 2, LWB: 2, RWB: 2, CDM: 3, CM: 8, CAM: 13, LM: 9, RM: 9, LW: 15, RW: 15, ST: 20 };
  const defensive = new Set(['GK', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM']);
  // Observed browser defaults, independently implemented. See docs/simulation-research.md.
  function naturalRank(position, positions) {
    if (!positions?.length) return -1;
    if (position === 'LW' || position === 'RW') {
      const wide = position === 'LW' ? 'LM' : 'RM';
      const attacking = ['ST', 'CAM', 'LW', 'RW', 'LM', 'RM'].includes(positions[0]);
      return positions.findIndex(role => role === position || (role === wide && attacking));
    }
    if (position === 'CDM' || position === 'CAM') {
      const opposite = position === 'CDM' ? 'CAM' : 'CDM';
      return positions.findIndex(role => role === position || (role === 'CM' && !positions.includes(opposite)));
    }
    if (position === 'LWB' || position === 'RWB') {
      const exact = positions.indexOf(position);
      if (exact >= 0) return exact;
      const roles = position === 'LWB' ? ['LB', 'LM'] : ['RB', 'RM'];
      if (roles.includes(positions[0])) return 0;
      return positions[0] === (position === 'LWB' ? 'LW' : 'RW') ? 2 : -1;
    }
    const compatible = { LM: ['LM', 'LW'], RM: ['RM', 'RW'], CM: ['CM', 'CAM', 'CDM'] };
    return positions.findIndex(role => (compatible[position] || [position]).includes(role));
  }
  function fitMultiplier(position, positions) {
    const rank = naturalRank(position, positions);
    return rank === 0 ? 1 : rank === 1 ? .99 : rank >= 2 ? .98 : .93;
  }
  function team(game, manager) {
    const slots = draft.formations[game.config.formation];
    const pool = new Map(game.pool.map(entry => [entry.id, entry]));
    const backFive = slots.filter(slot => slot.position === 'CB').length === 3 && game.config.formation.startsWith('5-');
    const squad = slots.flatMap((slot, index) => {
      const entry = pool.get(manager.board[index]);
      if (!entry) return [];
      const rating = draft.rating(entry, game.config.mode), fit = fitMultiplier(slot.position, entry.player.positions);
      const unit = ['LWB', 'RWB'].includes(slot.position) ? (backFive ? 'defence' : 'midfield') : units[slot.position];
      return [{ id: entry.id, name: entry.player.name, position: slot.position, positions: entry.player.positions.slice(), rating, effective: Math.max(40, rating * fit), fit, unit }];
    });
    const exact = {};
    for (const unit of Object.keys(unitWeights)) {
      const players = squad.filter(player => player.unit === unit);
      const weight = player => unit === 'defence' && player.position !== 'CB' ? .6 : 1;
      exact[unit] = players.length ? players.reduce((sum, player) => sum + player.effective * weight(player), 0) / players.reduce((sum, player) => sum + weight(player), 0) : 0;
    }
    const present = Object.keys(unitWeights).filter(unit => exact[unit] > 0);
    const denominator = present.reduce((sum, unit) => sum + unitWeights[unit], 0);
    const overall = denominator ? Math.round(present.reduce((sum, unit) => sum + exact[unit] * unitWeights[unit], 0) / denominator) : 0;
    return { id: manager.id, name: manager.name, board: manager.board.slice(), squad, overall,
      ...Object.fromEntries(Object.entries(exact).map(([unit, value]) => [unit, Math.round(value)])),
      placed: squad.length, misplaced: squad.filter(player => player.fit === .93).length,
      spent: auction.STARTING_BUDGET - auction.budget(game, manager.id) };
  }
  function readiness(game) {
    if (game.phase !== 'complete') return { ready: false, message: 'Finish the auction before starting your league.' };
    const incomplete = game.managers.filter(manager => manager.board.filter(Boolean).length !== 11);
    return incomplete.length ? { ready: false, message: `Place all 11 players for ${incomplete.map(manager => manager.name).join(', ')}.`, managerId: incomplete[0].id }
      : { ready: true, message: 'Every XI is ready. Starting locks the teams for this league.' };
  }
  function schedule(ids) {
    const ring = ids.slice();
    if (ring.length % 2) ring.push(null);
    const first = [];
    for (let round = 0; round < ring.length - 1; round++) {
      const fixtures = [];
      for (let index = 0; index < ring.length / 2; index++) {
        const left = ring[index], right = ring[ring.length - 1 - index];
        if (!left || !right) continue;
        const swap = (round + index) % 2;
        fixtures.push({ homeId: swap ? right : left, awayId: swap ? left : right });
      }
      first.push(fixtures);
      ring.splice(1, 0, ring.pop());
    }
    return [...first, ...first.map(fixtures => fixtures.map(fixture => ({ homeId: fixture.awayId, awayId: fixture.homeId })))].flatMap((fixtures, round) => fixtures.map((fixture, index) => ({ ...fixture, id: `${round + 1}-${index + 1}`, round, result: null })));
  }
  function seeded(seed) {
    let state = seed >>> 0;
    return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967295; };
  }
  function hash(seed, value) {
    let result = seed >>> 0;
    for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619) >>> 0;
    return result;
  }
  function poisson(mean, random) {
    const threshold = Math.exp(-mean);
    let product = 1, count = 0;
    do { product *= random(); count++; } while (product > threshold);
    return count - 1;
  }
  const expectedGoals = (own, opponent, home) => clamp(1.35 + .05 * (own - opponent) + (home ? .35 : 0), .2, 4.5);
  function goalEvents(squad, goals, random, tallies) {
    const result = [];
    for (let index = 0; index < goals; index++) {
      const minute = clamp(Math.ceil(90 * Math.pow(random(), .82)), 1, 90);
      const weights = squad.map(player => {
        const capped = player.position === 'CDM' || player.positions[0] === 'CDM';
        if (capped && (tallies.get(player.id) || 0) >= 10) return 0;
        return (scorerWeights[player.position] || 0) * Math.pow(Math.max(40, player.rating) / 80, defensive.has(player.position) ? 1 : 4);
      });
      let draw = random() * weights.reduce((sum, weight) => sum + weight, 0);
      let scorer = squad.at(-1);
      for (let index = 0; index < squad.length; index++) if (weights[index] > 0 && (draw -= weights[index]) <= 0) { scorer = squad[index]; break; }
      if (!scorer) continue;
      tallies.set(scorer.id, (tallies.get(scorer.id) || 0) + 1);
      result.push({ minute, playerId: scorer.id, name: scorer.name });
    }
    return result.sort((a, b) => a.minute - b.minute);
  }
  function simulateMatch(home, away, seed, tallies = new Map()) {
    const random = seeded((seed ^ 0x2c1b3c6d) >>> 0);
    const homeXg = expectedGoals(home.overall, away.overall, true), awayXg = expectedGoals(away.overall, home.overall, false);
    const homeGoals = poisson(homeXg, random), awayGoals = poisson(awayXg, random);
    return { homeGoals, awayGoals, homeXg, awayXg,
      homeScorers: goalEvents(home.squad, homeGoals, random, tallies), awayScorers: goalEvents(away.squad, awayGoals, random, tallies) };
  }
  function create(game, seed = Math.floor(Math.random() * 4294967296)) {
    const check = readiness(game);
    if (!check.ready) return { error: check.message };
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) return { error: 'Invalid league seed.' };
    return { league: { version: 1, engineVersion: VERSION, seed, round: 0, teams: game.managers.map(manager => team(game, manager)), fixtures: schedule(game.managers.map(manager => manager.id)) } };
  }
  const roundCount = league => Math.max(...league.fixtures.map(fixture => fixture.round)) + 1;
  function playRound(league) {
    if (league.round >= roundCount(league)) return { error: 'The league is finished.' };
    const teams = new Map(league.teams.map(team => [team.id, team]));
    const tallies = new Map();
    for (const fixture of league.fixtures) if (fixture.result) for (const scorer of [...fixture.result.homeScorers, ...fixture.result.awayScorers]) tallies.set(scorer.playerId, (tallies.get(scorer.playerId) || 0) + 1);
    const fixtures = league.fixtures.map(fixture => fixture.round !== league.round ? fixture : {
      ...fixture, result: simulateMatch(teams.get(fixture.homeId), teams.get(fixture.awayId), hash(league.seed, fixture.id), tallies) });
    return { league: { ...league, fixtures, round: league.round + 1 } };
  }
  function table(league) {
    const rows = league.teams.map(team => ({ id: team.id, name: team.name, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, points: 0 }));
    const byId = new Map(rows.map(row => [row.id, row]));
    for (const fixture of league.fixtures) {
      if (!fixture.result) continue;
      const home = byId.get(fixture.homeId), away = byId.get(fixture.awayId), { homeGoals, awayGoals } = fixture.result;
      home.played++; away.played++; home.gf += homeGoals; home.ga += awayGoals; away.gf += awayGoals; away.ga += homeGoals;
      if (homeGoals > awayGoals) { home.won++; home.points += 3; away.lost++; }
      else if (awayGoals > homeGoals) { away.won++; away.points += 3; home.lost++; }
      else { home.drawn++; away.drawn++; home.points++; away.points++; }
    }
    rows.forEach(row => { row.gd = row.gf - row.ga; });
    return rows.sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf || league.teams.findIndex(team => team.id === a.id) - league.teams.findIndex(team => team.id === b.id));
  }
  function awards(game) {
    if (game.phase !== 'complete' || !game.sales.length) return null;
    const pool = new Map(game.pool.map(entry => [entry.id, entry]));
    const spent = game.sales.reduce((sum, sale) => sum + sale.price, 0);
    const weight = sale => Math.pow(draft.rating(pool.get(sale.playerId), game.config.mode) / 80, 4);
    const totalWeight = game.sales.reduce((sum, sale) => sum + weight(sale), 0);
    const valued = game.sales.map(sale => ({ ...sale, rating: draft.rating(pool.get(sale.playerId), game.config.mode), estimated: spent * weight(sale) / totalWeight }));
    const biggestBuy = valued.slice().sort((a, b) => b.price - a.price || b.rating - a.rating)[0];
    const bargain = valued.slice().sort((a, b) => (b.estimated - b.price) - (a.estimated - a.price) || b.rating - a.rating)[0];
    const biggestSpender = game.managers.map(manager => ({ id: manager.id, name: manager.name, spent: auction.STARTING_BUDGET - auction.budget(game, manager.id) })).sort((a, b) => b.spent - a.spent)[0];
    return { biggestBuy, bargain, biggestSpender };
  }
  function serialise(league) {
    return league ? { version: league.version, engineVersion: league.engineVersion, seed: league.seed, round: league.round, boards: league.teams.map(team => ({ id: team.id, board: team.board })) } : null;
  }
  function restore(saved, game) {
    try {
      if (!saved || saved.version !== 1 || saved.engineVersion !== VERSION || !readiness(game).ready || !Number.isInteger(saved.round)) return null;
      if (JSON.stringify(saved.boards) !== JSON.stringify(game.managers.map(manager => ({ id: manager.id, board: manager.board })))) return null;
      let league = create(game, saved.seed).league;
      if (!league || saved.round < 0 || saved.round > roundCount(league)) return null;
      for (let round = 0; round < saved.round; round++) league = playRound(league).league;
      return league;
    } catch { return null; }
  }
  const api = { VERSION, naturalRank, fitMultiplier, team, readiness, schedule, seeded, poisson, expectedGoals, simulateMatch, create, roundCount, playRound, table, awards, serialise, restore };
  if (typeof module !== 'undefined') module.exports = api; else scope.LeagueCore = api;
})(globalThis);
