(function (scope) {
  const draft = typeof module !== 'undefined' ? require('./draft-core.js') : scope.DraftCore;
  const auction = typeof module !== 'undefined' ? require('./auction-core.js') : scope.AuctionCore;
  const VERSION = 'touchline-head-to-head-v2';
  const VERSIONS = ['touchline-head-to-head-v1', VERSION]; // v1 leagues replay with the current engine.
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const units = { GK: 'goalkeeping', CB: 'defence', LB: 'defence', RB: 'defence', CM: 'midfield', CDM: 'midfield', LM: 'midfield', RM: 'midfield', CAM: 'attack', LW: 'attack', RW: 'attack', ST: 'attack' };
  const unitWeights = { attack: .30, midfield: .30, defence: .28, goalkeeping: .12 };
  const scorerWeights = { GK: 0, CB: 1, LB: 2, RB: 2, LWB: 2, RWB: 2, CDM: 3, CM: 8, CAM: 13, LM: 9, RM: 9, LW: 15, RW: 15, ST: 20 };
  const assistWeights = { GK: 0, LB: 4, CB: 1, RB: 4, LWB: 5, RWB: 5, CDM: 4, CM: 9, CAM: 14, LM: 11, RM: 11, LW: 13, RW: 13, ST: 8 };
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
  // Team strength from the players in each slot: position fit, units and weights as 38-0 does it.
  function rate(entries, formation) {
    const backFive = draft.formations[formation].filter(slot => slot.position === 'CB').length === 3 && formation.startsWith('5-');
    const squad = entries.map(entry => {
      const fit = fitMultiplier(entry.position, entry.positions), unit = ['LWB', 'RWB'].includes(entry.position) ? (backFive ? 'defence' : 'midfield') : units[entry.position];
      return { ...entry, effective: Math.max(40, entry.rating * fit), fit, unit };
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
    return { squad, overall, ...Object.fromEntries(Object.entries(exact).map(([unit, value]) => [unit, Math.round(value)])), placed: squad.length, misplaced: squad.filter(player => player.fit === .93).length };
  }
  function team(game, manager) {
    const formation = draft.formationOf(game, manager), slots = draft.formations[formation];
    const pool = new Map(game.pool.map(entry => [entry.id, entry]));
    const describe = (entry, position) => ({ id: entry.id, name: entry.player.name, position, positions: entry.player.positions.slice(), rating: draft.rating(entry, game.config.mode) });
    const entries = slots.flatMap((slot, index) => { const entry = pool.get(manager.board[index]); return entry ? [describe(entry, slot.position)] : []; });
    const bench = game.config.subs ? auction.purchases(game, manager.id).filter(sale => !manager.board.includes(sale.playerId)).map(sale => describe(pool.get(sale.playerId), pool.get(sale.playerId).player.positions[0])) : undefined;
    return { id: manager.id, name: manager.name, formation, board: manager.board.slice(), ...rate(entries, formation), ...(bench ? { bench } : {}),
      spent: auction.STARTING_BUDGET - auction.budget(game, manager.id) };
  }
  // Substitutes mode (Touchline's own rules; 38-0 has no substitutions). Starters tire in the
  // second half by position; players coming off the bench are fresh.
  const FATIGUE = { GK: .01, CB: .04, LB: .07, RB: .07, LWB: .08, RWB: .08, CDM: .05, CM: .06, CAM: .06, LM: .07, RM: .07, LW: .07, RW: .07, ST: .06 };
  function lineupAfter(snapshot, changes = []) {
    const players = snapshot.squad.map(player => ({ id: player.id, name: player.name, position: player.position, positions: player.positions, rating: player.rating, fresh: false }));
    for (const change of changes) {
      const index = players.findIndex(player => player.id === change.off), incoming = snapshot.bench.find(player => player.id === change.on);
      if (index >= 0 && incoming) players[index] = { id: incoming.id, name: incoming.name, position: players[index].position, positions: incoming.positions, rating: incoming.rating, fresh: true };
    }
    return players;
  }
  function secondHalfTeam(snapshot, changes = []) {
    const entries = lineupAfter(snapshot, changes).map(player => ({ ...player, rating: player.rating * (1 - (player.fresh ? 0 : FATIGUE[player.position] || .05)) }));
    return { ...snapshot, ...rate(entries, snapshot.formation) };
  }
  // Instant matchdays make up to three sensible changes: the most tired outfield starters for the best bench fit.
  function autoChanges(snapshot) {
    if (!snapshot.bench?.length) return [];
    const changes = [], used = new Set();
    const tired = snapshot.squad.filter(player => player.position !== 'GK').sort((a, b) => (FATIGUE[b.position] || 0) - (FATIGUE[a.position] || 0) || a.rating - b.rating);
    for (const starter of tired) {
      if (changes.length >= 3) break;
      const option = snapshot.bench.filter(player => !used.has(player.id) && !player.positions.includes('GK') && naturalRank(starter.position, player.positions) >= 0).sort((a, b) => b.rating - a.rating)[0];
      if (option && option.rating >= starter.rating * (1 - (FATIGUE[starter.position] || .05)) - 2) { used.add(option.id); changes.push({ off: starter.id, on: option.id }); }
    }
    return changes;
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
  // Goal times follow 38-0: 2% land in first-half and 4% in second-half stoppage time.
  function goalTime(value) {
    if (value >= .96) return { minute: 90, stoppage: Math.min(4, 1 + Math.floor((value - .96) / .04 * 4)) };
    if (value >= .94) return { minute: 45, stoppage: Math.min(3, 1 + Math.floor((value - .94) / .02 * 3)) };
    return { minute: Math.min(90, Math.max(1, Math.ceil(90 * Math.pow(value / .94, .82)))) };
  }
  const goalOrder = (a, b) => a.minute - b.minute || (a.stoppage ?? 0) - (b.stoppage ?? 0);
  // Match clock from 0 to 97: 45+3 is 48 and 90+4 is 97.
  const absoluteMinute = goal => goal.minute === 45 && goal.stoppage ? 45 + goal.stoppage : goal.minute === 90 && goal.stoppage ? 93 + goal.stoppage : goal.minute <= 45 ? goal.minute : goal.minute + 3;
  const fromAbsolute = value => value <= 45 ? { minute: value } : value <= 48 ? { minute: 45, stoppage: value - 45 } : value <= 93 ? { minute: value - 3 } : { minute: 90, stoppage: value - 93 };
  const minuteLabel = goal => goal.stoppage ? `${goal.minute}+${goal.stoppage}′` : `${goal.minute}′`;
  // As in 38-0, no two goals in a match share a minute: clashes move later, within the final whistle.
  function separate(...lists) { spread(97, 1, lists); }
  function spread(last, first, lists) {
    const goals = lists.flat().sort(goalOrder), times = goals.map(absoluteMinute);
    for (let index = 1; index < times.length; index++) if (times[index] <= times[index - 1]) times[index] = times[index - 1] + 1;
    for (let index = times.length - 1; index >= 0; index--) { const limit = index === times.length - 1 ? last : times[index + 1] - 1; if (times[index] > limit) times[index] = Math.max(first, limit); }
    goals.forEach((goal, index) => { const time = fromAbsolute(times[index]); goal.minute = time.minute; if (time.stoppage === undefined) delete goal.stoppage; else goal.stoppage = time.stoppage; });
    for (const list of lists) list.sort(goalOrder);
  }
  // 38-0's season engine: 28% of goals are unassisted; otherwise a teammate weighted by role and rating.
  function pickAssist(squad, scorerId, random) {
    if (squad.length < 2 || random() > .72) return null;
    const others = squad.filter(player => player.id !== scorerId);
    const weights = others.map(player => (assistWeights[player.position] || 0) * Math.pow(Math.max(40, player.rating) / 80, 3.5));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (!total) return null;
    let draw = random() * total;
    for (let index = 0; index < others.length; index++) if ((draw -= weights[index]) <= 0) return others[index];
    return others.at(-1);
  }
  function goalEvents(squad, goals, random, tallies, assistRandom) {
    const result = [];
    for (let index = 0; index < goals; index++) {
      const time = goalTime(random());
      if (!squad.length) { result.push({ ...time, playerId: null, name: 'Goal' }); continue; }
      const weights = squad.map(player => {
        const capped = player.position === 'CDM' || player.positions[0] === 'CDM';
        if (capped && (tallies.get(player.id) || 0) >= 10) return 0;
        return (scorerWeights[player.position] || 0) * Math.pow(Math.max(40, player.rating) / 80, defensive.has(player.position) ? 1 : 4);
      });
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      let scorer = squad.at(-1);
      if (!total) scorer = squad[Math.floor(random() * squad.length)];
      else { let draw = random() * total; for (let item = 0; item < squad.length; item++) if ((draw -= weights[item]) <= 0) { scorer = squad[item]; break; } }
      tallies.set(scorer.id, (tallies.get(scorer.id) || 0) + 1);
      const assist = pickAssist(squad, scorer.id, assistRandom);
      result.push({ ...time, playerId: scorer.id, name: scorer.name, ...(assist ? { assistId: assist.id, assistName: assist.name } : {}) });
    }
    return result.sort(goalOrder);
  }
  function simulateMatch(home, away, seed, tallies = new Map()) {
    // The main stream mirrors 38-0's head-to-head exactly; assists use their own stream so they cannot disturb it.
    const random = seeded((seed ^ 0x2c1b3c6d) >>> 0), assists = seeded((seed ^ 0x51a7c0de) >>> 0);
    const homeXg = expectedGoals(home.overall, away.overall, true), awayXg = expectedGoals(away.overall, home.overall, false);
    const homeGoals = poisson(homeXg, random), awayGoals = poisson(awayXg, random);
    const homeScorers = goalEvents(home.squad, homeGoals, random, tallies, assists), awayScorers = goalEvents(away.squad, awayGoals, random, tallies, assists);
    separate(homeScorers, awayScorers);
    return { homeGoals, awayGoals, homeXg, awayXg, homeScorers, awayScorers };
  }
  // 38-0's season engine (simulateSeason), fitted on its 480 historical club-seasons. These are the
  // values its buildSeasonModel derives: expected points from overall, then win/draw odds per fixture.
  const SEASON = { intercept: -219.30241993531556, slope: 3.4879501664022547, minOverall: 68, meanOpponent: 80, homeEdge: .05, strengthK: .035, winCeiling: .92, subShare: .12 };
  const subWeights = { GK: 0, LB: 3, CB: 2, RB: 3, LWB: 3, RWB: 3, CDM: 5, CM: 11, CAM: 13, LM: 12, RM: 12, LW: 12, RW: 12, ST: 6 };
  function targetPoints(overall) {
    const fitted = SEASON.intercept + SEASON.slope * overall, floor = SEASON.intercept + SEASON.slope * SEASON.minOverall;
    if (fitted >= floor) return Math.min(110, fitted);
    const span = floor - 8;
    return 8 + span * Math.exp((fitted - floor) / span);
  }
  function basePlan(overall) {
    const perGame = targetPoints(overall) / 38;
    let draw = Math.max(.05, Math.min(.28, .26 - (perGame - 1) * .1)), win = Math.min(.97, (perGame - draw) / 3);
    if (win < .02) { win = .02; draw = Math.max(0, perGame - .06); }
    win = Math.min(.97, win + .012 * Math.max(0, overall - 88)); draw = Math.min(draw, 1 - win);
    return { win, draw, ceiling: SEASON.winCeiling };
  }
  function fixtureOdds(plan, strength, home) {
    const raw = plan.win - SEASON.strengthK * (strength - SEASON.meanOpponent) + (home ? SEASON.homeEdge : -SEASON.homeEdge);
    const win = Math.max(.05, Math.min(plan.ceiling, raw));
    return { win, draw: Math.min(plan.draw + Math.max(0, raw - win), 1 - win) };
  }
  function pickWeighted(list, weight, draw) {
    const weights = list.map(weight), total = weights.reduce((sum, value) => sum + value, 0);
    if (!total) return list[Math.min(list.length - 1, Math.floor(draw * list.length))];
    let left = draw * total;
    for (let index = 0; index < list.length; index++) if ((left -= weights[index]) <= 0) return list[index];
    return list.at(-1);
  }
  // A manager's results against the computer clubs, decided the way 38-0 decides a season: result first
  // (from overall, opponent strength and home edge), then a scoreline calibrated to the season's goal totals.
  function seasonAgainstClubs(own, fixtures, seed) {
    const random = seeded(seed), count = fixtures.length, scale = count / 38;
    const plan = basePlan(own.overall), a = own.overall;
    const expGA = Math.max(20, Math.min(100, 248.8 - 2.53 * a - .8 * (own.defence - a))) * scale;
    const curve = 57.8 + 3.15 * (a - 80) + .04 * (a - 80) * (a - 80), expGF = Math.max(18, Math.min(90, Math.min(-129 + 2.4 * a, curve) + .8 * (own.attack - a))) * scale;
    const odds = fixtures.map(fixture => fixtureOdds(plan, fixture.club.strength, fixture.home));
    const results = odds.map(({ win, draw }) => { const roll = random(); return roll < win ? 'W' : roll < win + draw ? 'D' : 'L'; });
    const against = { W: .65, D: .9, L: 1.5 }, scored = { W: 1.45, D: .95, L: .55 }, clamp01 = value => Math.max(.6, Math.min(1.4, value));
    const weaker = fixture => clamp01(1 - .035 * (fixture.club.strength - SEASON.meanOpponent)), stronger = fixture => clamp01(1 + .035 * (fixture.club.strength - SEASON.meanOpponent));
    const expected = (index, table) => { const { win, draw } = odds[index]; return win * table.W + draw * table.D + Math.max(0, 1 - win - draw) * table.L; };
    let forScale = fixtures.reduce((sum, fixture, index) => sum + expected(index, scored) * weaker(fixture), 0);
    let againstScale = fixtures.reduce((sum, fixture, index) => sum + expected(index, against) * stronger(fixture), 0);
    const targetFor = fixtures.reduce((sum, fixture, index) => sum + expGF * expected(index, scored) * weaker(fixture), 0) / forScale;
    const targetAgainst = fixtures.reduce((sum, fixture, index) => sum + expGA * expected(index, against) * stronger(fixture), 0) / againstScale;
    for (let pass = 0; pass < 3; pass++) {
      let goalsFor = 0, goalsAgainst = 0;
      fixtures.forEach((fixture, index) => {
        const { win, draw } = odds[index], loss = Math.max(0, 1 - win - draw), up = weaker(fixture), down = stronger(fixture);
        const f = value => expGF * value * up / forScale, g = value => expGA * value * down / againstScale, level = Math.sqrt(f(scored.D) * g(against.D));
        goalsFor += win * f(scored.W) + loss * f(scored.L) + draw * level; goalsAgainst += win * g(against.W) + loss * g(against.L) + draw * level;
      });
      forScale *= goalsFor / targetFor; againstScale *= goalsAgainst / targetAgainst;
    }
    const draws = mean => { if (mean <= 0) return 0; const threshold = Math.exp(-mean); let count = 0, product = 1; do { count++; product *= random(); } while (product > threshold); return count - 1; };
    const cap = value => { let goals = value < 9 ? value : 9; while (goals > 5 && random() >= Math.pow(.7, goals - 5)) goals--; return goals; };
    const tallies = new Map();
    return fixtures.map((fixture, index) => {
      const result = results[index], mean = expGF * scored[result] * weaker(fixture) / forScale, conceded = expGA * against[result] * stronger(fixture) / againstScale;
      let gf, ga;
      if (result === 'D') gf = ga = cap(draws(Math.sqrt(mean * conceded)));
      else { gf = cap(draws(mean)); ga = cap(draws(conceded)); }
      if (result === 'W') { if (gf === 0) { gf = 1; ga = 0; } else if (gf <= ga) ga = gf - 1; }
      else if (result === 'L') { if (ga <= gf) ga = Math.min(9, gf + 1); if (ga <= gf) gf = ga - 1; }
      const ours = [], theirs = [];
      for (let goal = 0; goal < gf; goal++) {
        const time = goalTime(random()), sub = random();
        if (sub < SEASON.subShare) {
          // 38-0 gives about 12% of goals to players picked by role alone, without rating.
          const scorer = pickWeighted(own.squad, player => (player.position === 'CDM' || player.positions[0] === 'CDM') && (tallies.get(player.id) || 0) >= 10 ? 0 : subWeights[player.position] || 0, sub / SEASON.subShare);
          tallies.set(scorer.id, (tallies.get(scorer.id) || 0) + 1); ours.push({ ...time, playerId: scorer.id, name: scorer.name }); continue;
        }
        const scorer = pickWeighted(own.squad, player => (player.position === 'CDM' || player.positions[0] === 'CDM') && (tallies.get(player.id) || 0) >= 10 ? 0 : (scorerWeights[player.position] || 0) * Math.pow(Math.max(40, player.rating) / 80, defensive.has(player.position) ? 1 : 4), random());
        tallies.set(scorer.id, (tallies.get(scorer.id) || 0) + 1);
        const assist = pickAssist(own.squad, scorer.id, random);
        ours.push({ ...time, playerId: scorer.id, name: scorer.name, ...(assist ? { assistId: assist.id, assistName: assist.name } : {}) });
      }
      for (let goal = 0; goal < ga; goal++) {
        const time = goalTime(random()), scorer = pickWeighted(fixture.club.squad, player => (scorerWeights[player.position] || 0) * Math.pow(Math.max(40, player.rating) / 80, defensive.has(player.position) ? 1 : 4), random());
        theirs.push({ ...time, playerId: scorer.id, name: scorer.name });
      }
      separate(ours, theirs);
      return fixture.home ? { homeGoals: gf, awayGoals: ga, homeScorers: ours, awayScorers: theirs } : { homeGoals: ga, awayGoals: gf, homeScorers: theirs, awayScorers: ours };
    });
  }
  const isManagerTeam = item => !item.club;
  // One half of a substitutes-mode match: half the expected goals, goal times inside that half.
  function simulateHalf(home, away, seed, tallies, half) {
    const random = seeded((seed ^ (half === 1 ? 0x2c1b3c6d : 0x68e31da4)) >>> 0), assists = seeded((seed ^ (half === 1 ? 0x51a7c0de : 0x3b9aca07)) >>> 0);
    const homeXg = expectedGoals(home.overall, away.overall, true) / 2, awayXg = expectedGoals(away.overall, home.overall, false) / 2;
    const homeGoals = poisson(homeXg, random), awayGoals = poisson(awayXg, random);
    const place = goal => { const target = half === 1 ? clamp(Math.round(absoluteMinute(goal) * 48 / 97), 1, 48) : clamp(49 + Math.round(absoluteMinute(goal) * 48 / 97), 49, 97), time = fromAbsolute(target); goal.minute = time.minute; if (time.stoppage === undefined) delete goal.stoppage; else goal.stoppage = time.stoppage; return goal; };
    const homeScorers = goalEvents(home.squad, homeGoals, random, tallies, assists).map(place), awayScorers = goalEvents(away.squad, awayGoals, random, tallies, assists).map(place);
    spread(half === 1 ? 48 : 97, half === 1 ? 1 : 49, [homeScorers, awayScorers]);
    return { homeGoals, awayGoals, homeXg, awayXg, homeScorers, awayScorers };
  }
  const tallyOf = (league, extra = []) => { const tallies = new Map(); for (const result of [...league.fixtures.map(fixture => fixture.result), ...extra]) if (result) for (const scorer of [...result.homeScorers, ...result.awayScorers]) tallies.set(scorer.playerId, (tallies.get(scorer.playerId) || 0) + 1); return tallies; };
  // Substitutes mode: kick off a matchday's first halves; the second halves wait for the managers' changes.
  function startRound(league) {
    if (league.round >= roundCount(league)) return { error: 'The league is finished.' };
    const teams = new Map(league.teams.map(item => [item.id, item])), tallies = tallyOf(league), firstHalf = {};
    for (const fixture of league.fixtures) if (fixture.round === league.round && !league.planned?.[fixture.id]) firstHalf[fixture.id] = simulateHalf(teams.get(fixture.homeId), teams.get(fixture.awayId), hash(league.seed, fixture.id), tallies, 1);
    return { league: { ...league, pending: { round: league.round, firstHalf, changes: {}, ready: {} } } };
  }
  function finishRound(league, changes = league.pending?.changes || {}) {
    if (!league.pending) return { error: 'Kick off the first half first.' };
    const teams = new Map(league.teams.map(item => [item.id, item])), firstHalf = league.pending.firstHalf, tallies = tallyOf(league, Object.values(firstHalf)), used = {};
    const fixtures = league.fixtures.map(fixture => {
      if (fixture.round !== league.round) return fixture;
      if (league.planned?.[fixture.id]) return { ...fixture, result: league.planned[fixture.id] };
      const made = { home: changes[fixture.id]?.home || [], away: changes[fixture.id]?.away || [] };
      used[fixture.id] = made;
      const a = firstHalf[fixture.id], b = simulateHalf(secondHalfTeam(teams.get(fixture.homeId), made.home), secondHalfTeam(teams.get(fixture.awayId), made.away), hash(league.seed, fixture.id), tallies, 2);
      return { ...fixture, result: { homeGoals: a.homeGoals + b.homeGoals, awayGoals: a.awayGoals + b.awayGoals, homeXg: a.homeXg + b.homeXg, awayXg: a.awayXg + b.awayXg, homeScorers: [...a.homeScorers, ...b.homeScorers], awayScorers: [...a.awayScorers, ...b.awayScorers], halfTime: { home: a.homeGoals, away: a.awayGoals }, subs: made } };
    });
    return { league: { ...league, fixtures, round: league.round + 1, pending: null, subs: { ...league.subs, ...used } } };
  }
  // Instant play in substitutes mode: both halves, with automatic changes for every side.
  function playWithSubs(league) {
    const started = startRound(league); if (started.error) return started;
    const teams = new Map(league.teams.map(item => [item.id, item])), changes = {};
    for (const id of Object.keys(started.league.pending.firstHalf)) { const fixture = league.fixtures.find(item => item.id === id); changes[id] = { home: autoChanges(teams.get(fixture.homeId)), away: autoChanges(teams.get(fixture.awayId)) }; }
    return finishRound(started.league, changes);
  }
  function create(game, seed = Math.floor(Math.random() * 4294967296), { clubs = [] } = {}) {
    const check = readiness(game);
    if (!check.ready) return { error: check.message };
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) return { error: 'Invalid league seed.' };
    const teams = [...game.managers.map(manager => team(game, manager)), ...clubs.map(club => ({ ...club, club: true, overall: club.strength }))];
    const league = { version: 1, engineVersion: VERSION, seed, round: 0, competition: clubs.length ? 'premier' : 'friends', teams, fixtures: schedule(teams.map(item => item.id)), ...(game.config.subs ? { subs: {}, pending: null } : {}) };
    if (clubs.length) league.planned = plan(league);
    return { league };
  }
  // Premier League mode: everything not manager-v-manager is decided up front (and kept server-side).
  function plan(league) {
    const byId = new Map(league.teams.map(item => [item.id, item])), planned = {};
    for (const manager of league.teams.filter(isManagerTeam)) {
      const fixtures = league.fixtures.filter(fixture => (fixture.homeId === manager.id && byId.get(fixture.awayId).club) || (fixture.awayId === manager.id && byId.get(fixture.homeId).club))
        .map(fixture => ({ fixture, home: fixture.homeId === manager.id, club: byId.get(fixture.homeId === manager.id ? fixture.awayId : fixture.homeId) }));
      seasonAgainstClubs(manager, fixtures, hash(league.seed, `season:${manager.id}`)).forEach((result, index) => { planned[fixtures[index].fixture.id] = result; });
    }
    const tallies = new Map();
    for (const fixture of league.fixtures) if (byId.get(fixture.homeId).club && byId.get(fixture.awayId).club) planned[fixture.id] = simulateMatch(byId.get(fixture.homeId), byId.get(fixture.awayId), hash(league.seed, fixture.id), tallies);
    return planned;
  }
  const managerDerby = (league, fixture) => { const home = league.teams.find(item => item.id === fixture.homeId), away = league.teams.find(item => item.id === fixture.awayId); return isManagerTeam(home) && isManagerTeam(away); };
  const nextDerbyRound = league => { const fixture = league.fixtures.find(item => item.round >= league.round && managerDerby(league, item)); return fixture ? fixture.round : null; };
  const roundCount = league => Math.max(...league.fixtures.map(fixture => fixture.round)) + 1;
  function playRound(league) {
    if (league.round >= roundCount(league)) return { error: 'The league is finished.' };
    if (league.subs) return playWithSubs(league);
    const teams = new Map(league.teams.map(team => [team.id, team]));
    const tallies = new Map();
    for (const fixture of league.fixtures) if (fixture.result) for (const scorer of [...fixture.result.homeScorers, ...fixture.result.awayScorers]) tallies.set(scorer.playerId, (tallies.get(scorer.playerId) || 0) + 1);
    const fixtures = league.fixtures.map(fixture => fixture.round !== league.round ? fixture : {
      ...fixture, result: league.planned?.[fixture.id] || simulateMatch(teams.get(fixture.homeId), teams.get(fixture.awayId), hash(league.seed, fixture.id), tallies) });
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
    return league ? { version: league.version, engineVersion: league.engineVersion, seed: league.seed, round: league.round, competition: league.competition || 'friends', ...(league.subs ? { subs: league.subs, pending: league.pending ? { round: league.pending.round, changes: league.pending.changes, ready: league.pending.ready } : null } : {}), boards: league.teams.filter(isManagerTeam).map(team => ({ id: team.id, board: team.board })) } : null;
  }
  function restore(saved, game, { clubs = [] } = {}) {
    try {
      if (!saved || saved.version !== 1 || !VERSIONS.includes(saved.engineVersion) || !readiness(game).ready || !Number.isInteger(saved.round)) return null;
      if (JSON.stringify(saved.boards) !== JSON.stringify(game.managers.map(manager => ({ id: manager.id, board: manager.board })))) return null;
      if ((saved.competition || 'friends') !== (clubs.length ? 'premier' : 'friends')) return null;
      let league = create(game, saved.seed, { clubs }).league;
      if (!league || saved.round < 0 || saved.round > roundCount(league)) return null;
      if (league.subs) {
        // Replay with the changes the managers actually made, then reopen any half-time in progress.
        for (let round = 0; round < saved.round; round++) { league = startRound(league).league; league = finishRound(league, Object.fromEntries(league.fixtures.filter(fixture => fixture.round === round).map(fixture => [fixture.id, saved.subs?.[fixture.id] || { home: [], away: [] }]))).league; }
        if (saved.pending) { if (saved.pending.round !== saved.round) return null; league = startRound(league).league; league.pending.changes = saved.pending.changes || {}; league.pending.ready = saved.pending.ready || {}; }
        return league;
      }
      for (let round = 0; round < saved.round; round++) league = playRound(league).league;
      return league;
    } catch { return null; }
  }
  const api = { VERSION, FATIGUE, lineupAfter, secondHalfTeam, autoChanges, startRound, finishRound, SEASON, basePlan, fixtureOdds, seasonAgainstClubs, managerDerby, nextDerbyRound, isManagerTeam, absoluteMinute, minuteLabel, goalTime, naturalRank, fitMultiplier, team, readiness, schedule, seeded, poisson, expectedGoals, simulateMatch, create, roundCount, playRound, table, awards, serialise, restore };
  if (typeof module !== 'undefined') module.exports = api; else scope.LeagueCore = api;
})(globalThis);
