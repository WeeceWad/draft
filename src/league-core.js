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
  function team(game, manager, { january = true } = {}) {
    const formation = draft.formationOf(game, manager), slots = draft.formations[formation];
    const pool = new Map(game.pool.map(entry => [entry.id, entry]));
    const describe = (entry, position) => ({ id: entry.id, name: entry.player.name, position, positions: entry.player.positions.slice(), rating: draft.rating(entry, game.config.mode) });
    const entries = slots.flatMap((slot, index) => { const entry = pool.get(manager.board[index]); return entry ? [describe(entry, slot.position)] : []; });
    const bench = game.config.subs ? auction.purchases(game, manager.id).filter(sale => !manager.board.includes(sale.playerId) && (january || !pool.get(sale.playerId).january)).map(sale => describe(pool.get(sale.playerId), pool.get(sale.playerId).player.positions[0])) : undefined;
    return { id: manager.id, name: manager.name, formation, board: manager.board.slice(), ...rate(entries, formation), ...(bench ? { bench } : {}),
      spent: auction.STARTING_BUDGET - auction.budget(game, manager.id) };
  }
  // Substitutes mode (Touchline's own rules; 38-0 has no substitutions). Starters tire in the
  // second half by position; players coming off the bench are fresh.
  // Stamina at half-time: how much a role drains in a first half (wide players and full-backs run most),
  // plus a fixed per-player constitution of -4 to +4. Each missing stamina point costs 0.3% of rating.
  const DRAIN = { GK: 3, CB: 12, LB: 20, RB: 20, LWB: 22, RWB: 22, CDM: 16, CM: 17, CAM: 15, LM: 20, RM: 20, LW: 20, RW: 20, ST: 14 };
  const STAMINA_COST = .003;
  const FATIGUE = Object.fromEntries(Object.entries(DRAIN).map(([position, drain]) => [position, drain * STAMINA_COST]));
  const constitution = id => { let value = 0; for (const char of String(id)) value = (Math.imul(value, 31) + char.charCodeAt(0)) >>> 0; return value % 9 - 4; };
  const staminaAt = (id, position) => clamp(100 - (DRAIN[position] ?? 15) + constitution(id), 60, 100);
  const secondHalfRating = player => player.rating * (1 - (100 - player.stamina) * STAMINA_COST);
  // The second-half XI after half-time changes: substitutions ({ off, on }) and position swaps ({ swap: [a, b] }).
  // Swapped players keep the stamina they had; substitutes come on fresh.
  function lineupAfter(snapshot, changes = []) {
    const players = snapshot.squad.map(player => ({ id: player.id, name: player.name, position: player.position, positions: player.positions, rating: player.rating, fresh: false, stamina: staminaAt(player.id, player.position) }));
    for (const change of changes) {
      if (change.swap) {
        const a = players.findIndex(player => player.id === change.swap[0]), b = players.findIndex(player => player.id === change.swap[1]);
        if (a < 0 || b < 0) continue;
        const first = players[a], second = players[b];
        players[a] = { ...second, position: first.position }; players[b] = { ...first, position: second.position };
        continue;
      }
      const index = players.findIndex(player => player.id === change.off), incoming = snapshot.bench.find(player => player.id === change.on);
      if (index >= 0 && incoming) players[index] = { id: incoming.id, name: incoming.name, position: players[index].position, positions: incoming.positions, rating: incoming.rating, fresh: true, stamina: 100 };
    }
    return players;
  }
  function secondHalfTeam(snapshot, changes = []) {
    const entries = lineupAfter(snapshot, changes).map(player => ({ ...player, rating: secondHalfRating(player) }));
    return { ...snapshot, ...rate(entries, snapshot.formation) };
  }
  // Instant matchdays make up to three sensible changes: the most tired outfield starters for the best bench fit.
  function autoChanges(snapshot) {
    if (!snapshot.bench?.length) return [];
    const changes = [], used = new Set();
    const tired = lineupAfter(snapshot).filter(player => player.position !== 'GK').sort((a, b) => a.stamina - b.stamina || a.rating - b.rating);
    for (const starter of tired) {
      if (changes.length >= 3) break;
      const option = snapshot.bench.filter(player => !used.has(player.id) && !player.positions.includes('GK') && naturalRank(starter.position, player.positions) >= 0).sort((a, b) => b.rating - a.rating)[0];
      if (option && option.rating >= secondHalfRating(starter) - 2) { used.add(option.id); changes.push({ off: starter.id, on: option.id }); }
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
  // The match clock: 0–48 first half (with stoppage), 49–97 second half, then 98–127 for extra time (91'–120').
  const absoluteMinute = goal => goal.extra ? 97 + goal.minute - 90 : goal.minute === 45 && goal.stoppage ? 45 + goal.stoppage : goal.minute === 90 && goal.stoppage ? 93 + goal.stoppage : goal.minute <= 45 ? goal.minute : goal.minute + 3;
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
  function simulateMatch(home, away, seed, tallies = new Map(), neutral = false) {
    // The main stream mirrors 38-0's head-to-head exactly; assists use their own stream so they cannot disturb it.
    const random = seeded((seed ^ 0x2c1b3c6d) >>> 0), assists = seeded((seed ^ 0x51a7c0de) >>> 0);
    const homeXg = expectedGoals(home.overall, away.overall, !neutral), awayXg = expectedGoals(away.overall, home.overall, false);
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
  // ---- Player form (optional; Touchline's own rule) ------------------------------------------------
  // Each match gives a player a score around 6: goals +1, assists +0.6, a win +0.4 or a loss -0.4, and for
  // keepers and defenders a clean sheet +0.6 or three conceded -0.5. Form is the weighted average of the last
  // five (most recent counts most), from 3 to 10. Every point above or below 6 moves a rating by 0.8.
  const FORM_NEUTRAL = 6, FORM_EFFECT = .8, FORM_WEIGHTS = [1, .8, .6, .4, .2];
  function playedMatches(league) {
    const matches = [], cupRounds = league.cup?.rounds || [];
    const cupAt = round => cupRounds.filter((cupRound, index) => index < (league.cup?.round || 0) && cupRound.after === round).flatMap(cupRound => cupRound.ties.filter(tie => tie.result));
    const euroAt = round => league.europe ? league.europe.dates.flatMap((date, step) => step < league.europe.step && date.after === round ? euroPlayed(league.europe, step) : []) : [];
    for (let round = 0; round <= roundCount(league); round++) {
      matches.push(...cupAt(round), ...euroAt(round));
      matches.push(...league.fixtures.filter(fixture => fixture.round === round && fixture.result));
    }
    return matches;
  }
  function formTable(league) {
    const scores = new Map(), teams = new Map(league.teams.map(item => [item.id, item]));
    const credit = (id, score) => { if (!scores.has(id)) scores.set(id, []); scores.get(id).push(score); };
    for (const match of playedMatches(league)) for (const side of ['home', 'away']) {
      const snapshot = teams.get(side === 'home' ? match.homeId : match.awayId);
      if (!snapshot || snapshot.club) continue;
      const result = match.result, own = side === 'home' ? result.homeGoals : result.awayGoals, against = side === 'home' ? result.awayGoals : result.homeGoals;
      const goals = side === 'home' ? result.homeScorers : result.awayScorers, outcome = own > against ? .4 : own < against ? -.4 : 0;
      const changes = result.subs?.[side] || [];
      const lineup = [...snapshot.squad.map(player => ({ id: player.id, position: player.position })), ...changes.filter(change => change.on).map(change => ({ id: change.on, position: snapshot.squad.find(player => player.id === change.off)?.position || 'CM' }))];
      for (const player of lineup) {
        let score = FORM_NEUTRAL + outcome + goals.filter(goal => goal.playerId === player.id).length + .6 * goals.filter(goal => goal.assistId === player.id).length;
        if (defensive.has(player.position) || player.position === 'GK') score += against === 0 ? .6 : against >= 3 ? -.5 : 0;
        credit(player.id, score);
      }
    }
    const form = new Map();
    for (const [id, list] of scores) {
      const recent = list.slice(-5).reverse(), weights = FORM_WEIGHTS.slice(0, recent.length);
      form.set(id, Math.round(clamp(recent.reduce((sum, value, index) => sum + value * weights[index], 0) / weights.reduce((sum, value) => sum + value, 0), 3, 10) * 10) / 10);
    }
    return form;
  }
  const formOf = (table, id) => table.get(id) ?? FORM_NEUTRAL;
  // A team snapshot with each player's rating moved by their form.
  function formed(league, snapshot, table = null) {
    if (!league.form || snapshot.club) return snapshot;
    const form = table || formTable(league), shift = player => ({ id: player.id, name: player.name, position: player.position, positions: player.positions, rating: player.rating + (formOf(form, player.id) - FORM_NEUTRAL) * FORM_EFFECT });
    return { ...snapshot, ...rate(snapshot.squad.map(shift), snapshot.formation), ...(snapshot.bench ? { bench: snapshot.bench.map(shift) } : {}) };
  }
  const formedTeams = league => { const table = league.form ? formTable(league) : null; return new Map(league.teams.map(item => [item.id, formed(league, item, table)])); };
  // One fixture's result. Premier League games against clubs are planned up front, except with form on,
  // when each is decided at kick-off by 38-0's season engine so a manager's current form counts.
  function resultFor(league, fixture, teams, tallies) {
    if (league.planned?.[fixture.id]) return league.planned[fixture.id];
    const home = teams.get(fixture.homeId), away = teams.get(fixture.awayId);
    if (!!home.club !== !!away.club) {
      const manager = home.club ? away : home, club = home.club ? home : away;
      return seasonAgainstClubs(manager, [{ club, home: !home.club }], hash(league.seed, fixture.id))[0];
    }
    return simulateMatch(home, away, hash(league.seed, fixture.id), tallies);
  }
  // ---- FA Cup (optional) ---------------------------------------------------------------------------
  const CUP_NAMES = { 2: 'Final', 4: 'Semi-finals', 8: 'Quarter-finals', 16: 'Fifth round', 32: 'Fourth round' };
  function drawCup(league) {
    const random = seeded(hash(league.seed, 'fa-cup')), shuffle = list => { const copy = list.slice(); for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; } return copy; };
    // Managers always enter; in the Premier League the strongest clubs complete a draw of sixteen.
    const managers = league.teams.filter(isManagerTeam).map(item => item.id), clubs = league.teams.filter(item => item.club).sort((a, b) => b.strength - a.strength).map(item => item.id);
    const entrants = shuffle([...managers, ...clubs.slice(0, Math.max(0, 16 - managers.length))]);
    let size = 2; while (size < entrants.length) size *= 2;
    const byes = size - entrants.length, pairs = [];
    let index = 0;
    for (let bye = 0; bye < byes; bye++) pairs.push([entrants[index++], null]);
    while (index < entrants.length) pairs.push([entrants[index++], entrants[index++]]);
    const count = Math.round(Math.log2(size)), leagueRounds = roundCount(league);
    const rounds = Array.from({ length: count }, (_, round) => ({ name: CUP_NAMES[size / 2 ** round] || `Round of ${size / 2 ** round}`, after: Math.max(1, Math.floor(leagueRounds * (round + 1) / (count + 1))), ties: [] }));
    rounds[0].ties = shuffle(pairs).map(([homeId, awayId], tie) => ({ id: `cup-1-${tie + 1}`, homeId, awayId, result: null, winnerId: awayId === null ? homeId : null, bye: awayId === null }));
    return { name: 'FA Cup', size, round: 0, rounds };
  }
  // Extra time: a third of normal expected goals, at minutes 91–120.
  function extraTime(home, away, seed, tallies, neutral) {
    const random = seeded(hash(seed, 'extra-time')), assists = seeded(hash(seed, 'extra-time-assists'));
    const homeGoals = poisson(expectedGoals(home.overall, away.overall, !neutral) / 3, random), awayGoals = poisson(expectedGoals(away.overall, home.overall, false) / 3, random);
    const used = new Set(), place = goal => { let minute = 90 + clamp(Math.ceil(random() * 30), 1, 30); while (used.has(minute) && minute < 120) minute++; while (used.has(minute)) minute--; used.add(minute); delete goal.stoppage; goal.minute = minute; goal.extra = true; return goal; };
    return { homeGoals, awayGoals, homeScorers: goalEvents(home.squad, homeGoals, random, tallies, assists).map(place).sort(goalOrder), awayScorers: goalEvents(away.squad, awayGoals, random, tallies, assists).map(place).sort(goalOrder) };
  }
  // Penalties: five each, then sudden death. Better takers and worse keepers mean more goals (60–90%).
  function shootout(home, away, seed) {
    const random = seeded(hash(seed, 'penalties'));
    const order = team => { const outfield = team.squad.filter(player => player.position !== 'GK').sort((a, b) => (scorerWeights[b.position] || 0) * b.rating - (scorerWeights[a.position] || 0) * a.rating || b.rating - a.rating); return [...outfield, ...team.squad.filter(player => player.position === 'GK')]; };
    const keeper = team => team.squad.find(player => player.position === 'GK')?.rating ?? 70;
    const takers = { home: order(home), away: order(away) }, keepers = { home: keeper(away), away: keeper(home) }, score = { home: 0, away: 0 }, taken = { home: 0, away: 0 }, kicks = [];
    const kick = side => { const taker = takers[side][taken[side] % takers[side].length], scored = random() < clamp(.76 + (taker.rating - keepers[side]) * .004, .6, .9); taken[side]++; if (scored) score[side]++; kicks.push({ side, name: taker.name, scored }); };
    for (let round = 0; round < 5; round++) {
      kick('home'); if (score.home > score.away + (5 - taken.away) || score.away > score.home + (5 - taken.home)) break;
      kick('away'); if (score.home > score.away + (5 - taken.away) || score.away > score.home + (5 - taken.home)) break;
    }
    while (score.home === score.away) { kick('home'); kick('away'); }
    return { home: score.home, away: score.away, kicks };
  }
  function cupMatch(league, tie, teams, tallies, neutral) {
    const home = teams.get(tie.homeId), away = teams.get(tie.awayId), seed = hash(league.seed, tie.id);
    const result = simulateMatch(home, away, seed, tallies, neutral);
    if (result.homeGoals === result.awayGoals) {
      const extra = extraTime(home, away, seed, tallies, neutral);
      result.extraTime = { home: extra.homeGoals, away: extra.awayGoals };
      result.homeGoals += extra.homeGoals; result.awayGoals += extra.awayGoals;
      result.homeScorers = [...result.homeScorers, ...extra.homeScorers]; result.awayScorers = [...result.awayScorers, ...extra.awayScorers];
      if (result.homeGoals === result.awayGoals) result.penalties = shootout(home, away, seed);
    }
    const homeWins = result.homeGoals > result.awayGoals || (result.penalties && result.penalties.home > result.penalties.away);
    return { result, winnerId: homeWins ? tie.homeId : tie.awayId };
  }
  function playCupRound(league) {
    const cup = league.cup;
    if (!cup || cup.round >= cup.rounds.length) return { error: 'The cup is finished.' };
    const teams = formedTeams(league), tallies = tallyOf(league), final = cup.round === cup.rounds.length - 1;
    const ties = cup.rounds[cup.round].ties.map(tie => tie.bye ? tie : { ...tie, ...cupMatch(league, tie, teams, tallies, final) });
    const rounds = cup.rounds.map((round, index) => index === cup.round ? { ...round, ties } : round);
    if (!final) rounds[cup.round + 1] = { ...rounds[cup.round + 1], ties: Array.from({ length: ties.length / 2 }, (_, index) => ({ id: `cup-${cup.round + 2}-${index + 1}`, homeId: ties[2 * index].winnerId, awayId: ties[2 * index + 1].winnerId, result: null, winnerId: null, bye: false })) };
    return { league: { ...league, cup: { ...cup, round: cup.round + 1, rounds, winnerId: final ? ties[0].winnerId : null } } };
  }
  // ---- Champions League (optional): 38-0's "European Nights" in its draft form ----------------------
  // 38-0's 2026/27 European field: id, name, association, pot, UEFA coefficient, strength, English, kit.
  const EURO_CLUBS = [
    ['psg', 'Paris Saint-Germain', 'France', 1, 118.5, 87, 0, '#0b1f3a'], ['real-madrid', 'Real Madrid', 'Spain', 1, 143.5, 91, 0, '#0a4ea2'], ['man-city', 'Manchester City', 'England', 1, 137.75, 88, 1, '#6cabdd'],
    ['bayern', 'Bayern Munich', 'Germany', 1, 135.25, 90, 0, '#dc052d'], ['liverpool', 'Liverpool', 'England', 1, 125.5, 89, 1, '#c8102e'], ['inter', 'Inter Milan', 'Italy', 1, 116.25, 86, 0, '#0a52a0'],
    ['chelsea', 'Chelsea', 'England', 1, 109, 86, 1, '#034694'], ['dortmund', 'Borussia Dortmund', 'Germany', 1, 106.75, 85, 0, '#f5d800'], ['barcelona', 'Barcelona', 'Spain', 1, 103.25, 89, 0, '#004d98'],
    ['arsenal', 'Arsenal', 'England', 2, 98, 83, 1, '#ef0107'], ['leverkusen', 'Bayer Leverkusen', 'Germany', 2, 95.25, 80, 0, '#e32219'], ['atletico', 'Atlético Madrid', 'Spain', 2, 93.5, 82, 0, '#cb3524'],
    ['benfica', 'Benfica', 'Portugal', 2, 87.75, 81, 0, '#e10600'], ['atalanta', 'Atalanta', 'Italy', 2, 82, 78, 0, '#1a6fb5'], ['villarreal', 'Villarreal', 'Spain', 2, 82, 77, 0, '#ffd95a'],
    ['juventus', 'Juventus', 'Italy', 2, 74.25, 85, 0, '#1a1a1a'], ['frankfurt', 'Eintracht Frankfurt', 'Germany', 2, 74, 77, 0, '#e1000f'], ['brugge', 'Club Brugge', 'Belgium', 2, 71.75, 75, 0, '#0a53a8'],
    ['tottenham', 'Tottenham Hotspur', 'England', 3, 70.25, 80, 1, '#13234b'], ['psv', 'PSV Eindhoven', 'Netherlands', 3, 69.25, 78, 0, '#ed1c24'], ['ajax', 'Ajax', 'Netherlands', 3, 67.25, 81, 0, '#d2122e'],
    ['napoli', 'Napoli', 'Italy', 3, 61, 78, 0, '#12a0d7'], ['sporting', 'Sporting CP', 'Portugal', 3, 59, 78, 0, '#15803d'], ['olympiacos', 'Olympiacos', 'Greece', 3, 56.5, 74, 0, '#e30613'],
    ['slavia', 'Slavia Prague', 'Czech Republic', 3, 51, 72, 0, '#d7141a'], ['bodo', 'Bodø/Glimt', 'Norway', 3, 49, 71, 0, '#f0c808'], ['marseille', 'Marseille', 'France', 3, 48, 78, 0, '#2faee0'],
    ['copenhagen', 'Copenhagen', 'Denmark', 4, 44.875, 72, 0, '#16396b'], ['monaco', 'Monaco', 'France', 4, 41, 76, 0, '#e0162b'], ['galatasaray', 'Galatasaray', 'Turkey', 4, 38.25, 75, 0, '#a4123f'],
    ['union-sg', 'Union Saint-Gilloise', 'Belgium', 4, 36, 71, 0, '#f5c518'], ['qarabag', 'Qarabağ', 'Azerbaijan', 4, 32, 69, 0, '#0a52a0'], ['bilbao', 'Athletic Bilbao', 'Spain', 4, 26.75, 76, 0, '#ee2523'],
    ['newcastle', 'Newcastle United', 'England', 4, 23.039, 78, 1, '#1a1a1a'], ['pafos', 'Pafos', 'Cyprus', 4, 11.125, 68, 0, '#0a52a0'], ['kairat', 'Kairat', 'Kazakhstan', 4, 5.5, 67, 0, '#f0c808'],
  ];
  // 38-0's constants: ratings pulled 30% towards 80, drafted XIs' field 4 below listed strength, pots re-ranked by
  // strength, and its tournament match model (win and draw odds from expected points, then a goals model).
  const EURO = { anchor: 80, compression: .7, fieldAdjust: -4, strengthK: .048, winFloor: .05, winCap: .96, drawFloor: .04, drawGapDamp: .003, goalCap: 5, groupScale: .85, koScale: .55, lateScale: .45, koScore: .8, lateScore: .75 };
  const EURO_LINEUP = [['GK', 'Keeper'], ['RB', 'Full Back'], ['CB', 'Centre Back'], ['CB', 'Centre Back'], ['LB', 'Full Back'], ['CDM', 'Holder'], ['CM', 'Midfielder'], ['CAM', 'Playmaker'], ['RW', 'Winger'], ['ST', 'Striker'], ['LW', 'Winger']];
  const EURO_SCORER = { GK: 0, LB: 2, CB: 1, RB: 2, LWB: 2, RWB: 2, CDM: 3, CM: 8, CAM: 13, LM: 9, RM: 9, LW: 15, RW: 15, ST: 20 };
  const EURO_ASSIST = { GK: 0, LB: 6, CB: 2, RB: 6, LWB: 8, RWB: 8, CDM: 5, CM: 10, CAM: 16, LM: 10, RM: 10, LW: 12, RW: 12, ST: 8 };
  const EURO_ET_SCORER = { ST: 5, LW: 4, RW: 4, CAM: 3, CM: 2, LM: 2, RM: 2, CDM: 1, CB: 1, LB: 1, RB: 1, LWB: 1, RWB: 1, GK: 0 };
  // Eight league-phase nights, then two-legged play-off, last-16, quarter- and semi-finals, and a one-off final.
  const EURO_DATES = [...Array.from({ length: 8 }, (_, index) => ({ key: `MD${index + 1}`, name: `League phase · matchday ${index + 1}` })),
    { key: 'PO-1', round: 'PO', leg: 1, name: 'Knockout play-off · first leg' }, { key: 'PO-2', round: 'PO', leg: 2, name: 'Knockout play-off · second leg' },
    { key: 'R16-1', round: 'R16', leg: 1, name: 'Round of 16 · first leg' }, { key: 'R16-2', round: 'R16', leg: 2, name: 'Round of 16 · second leg' },
    { key: 'QF-1', round: 'QF', leg: 1, name: 'Quarter-finals · first leg' }, { key: 'QF-2', round: 'QF', leg: 2, name: 'Quarter-finals · second leg' },
    { key: 'SF-1', round: 'SF', leg: 1, name: 'Semi-finals · first leg' }, { key: 'SF-2', round: 'SF', leg: 2, name: 'Semi-finals · second leg' }, { key: 'F', round: 'F', leg: 1, name: 'Final' }];
  const euroRating = value => EURO.anchor + (value - EURO.anchor) * EURO.compression;
  const euroMod = (value, size) => (value % size + size) % size;
  const genericSquad = (id, overall) => EURO_LINEUP.map(([position, label], index) => ({ id: `${id}:${index + 1}`, name: `${label} ${index + 1}`, position, positions: [position], rating: clamp(Math.round(overall) + index % 3 - 1, 40, 99) }));
  // The field: managers take the English places from the lowest seed up (then the smallest clubs), the other
  // English places keep their real squads from our data, everyone else fields 38-0's generic line-up.
  function euroField(league, english = {}) {
    const managers = league.teams.filter(isManagerTeam);
    const order = [...EURO_CLUBS.filter(club => club[6]).sort((a, b) => a[4] - b[4]), ...EURO_CLUBS.filter(club => !club[6]).sort((a, b) => a[4] - b[4])];
    const slots = new Map(order.slice(0, managers.length).map((club, index) => [club[0], managers[index]]));
    const teams = EURO_CLUBS.map(([slot, name, association, pot, coeff, strength, isEnglish, kit]) => {
      const manager = slots.get(slot);
      if (manager) return { id: manager.id, name: manager.name, association: 'England', pot, coeff, raw: manager.overall, slot };
      const id = `euro:${slot}`, overall = euroRating(strength + EURO.fieldAdjust), squad = english[slot]?.squad?.length === 11 ? english[slot].squad : genericSquad(id, overall);
      return { id, name, association, pot, coeff, raw: strength, club: true, strength, overall, kit, alternates: english[slot]?.alternates || [], formation: '4-3-3', squad };
    });
    [...teams].sort((a, b) => b.raw - a.raw || b.coeff - a.coeff || Number(!a.club) - Number(!b.club) || a.id.localeCompare(b.id)).forEach((team, index) => { team.pot = Math.min(4, Math.floor(index / 9) + 1); });
    return teams;
  }
  // 38-0's draw: each team meets one side from every pot at home and one away, managers avoid their own association.
  function euroDraw(teams, seed, managerIds) {
    const byId = new Map(teams.map(team => [team.id, team])), clash = (a, b) => byId.get(a).association === byId.get(b).association;
    const once = attempt => {
      const random = seeded(hash(seed, `euro-draw:${attempt}`)), pots = [[], [], [], []];
      for (const team of teams) pots[team.pot - 1].push(team);
      for (const pot of pots) { pot.sort((a, b) => b.coeff - a.coeff || a.id.localeCompare(b.id)); for (let a = pot.length - 1; a > 0; a--) { const t = Math.floor(random() * (a + 1)); [pot[a], pot[t]] = [pot[t], pot[a]]; } }
      const index = new Map(); pots.forEach(pot => pot.forEach((team, position) => index.set(team.id, position)));
      const offsets = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], pick = () => 1 + Math.floor(8 * random());
      for (let e = 0; e < 4; e++) offsets[e][e] = pick();
      for (let e = 0; e < 4; e++) for (let a = e + 1; a < 4; a++) { offsets[e][a] = pick(); let t = pick(); while (euroMod(offsets[e][a] + t, 9) === 0) t = t % 8 + 1; offsets[a][e] = t; }
      return teams.flatMap(team => [0, 1, 2, 3].map(pot => ({ homeId: team.id, awayId: pots[pot][euroMod(index.get(team.id) + offsets[team.pot - 1][pot], 9)].id })));
    };
    const clashes = matches => matches.filter(match => (managerIds.includes(match.homeId) || managerIds.includes(match.awayId)) && clash(match.homeId, match.awayId)).length;
    let best = null;
    for (let attempt = 0; attempt < 400; attempt++) { const matches = once(attempt), count = clashes(matches); if (!count) return matches; if (!best || count < best.count) best = { matches, count }; }
    return best.matches;
  }
  // Eight nights with every team playing once a night (edge colouring with Kempe-chain repairs).
  function euroNights(teams, matches, seed) {
    const ids = new Map(teams.map((team, index) => [team.id, index]));
    for (let attempt = 0; attempt < 500; attempt++) {
      const random = seeded(hash(seed, `euro-nights:${attempt}`)), colour = new Array(matches.length).fill(-1), at = teams.map(() => new Array(8).fill(-1));
      const ends = matches.map(match => [ids.get(match.homeId), ids.get(match.awayId)]);
      const set = (m, c) => { colour[m] = c; at[ends[m][0]][c] = m; at[ends[m][1]][c] = m; }, unset = m => { const c = colour[m]; at[ends[m][0]][c] = -1; at[ends[m][1]][c] = -1; colour[m] = -1; };
      const order = matches.map((_, index) => index); for (let a = order.length - 1; a > 0; a--) { const t = Math.floor(random() * (a + 1)); [order[a], order[t]] = [order[t], order[a]]; }
      let failed = false;
      for (const m of order) {
        const [u, v] = ends[m], free = node => [0, 1, 2, 3, 4, 5, 6, 7].filter(day => at[node][day] < 0);
        let day = free(u).find(value => at[v][value] < 0);
        for (const a of day === undefined ? free(u) : []) {
          for (const b of free(v)) {
            const path = []; let node = v, want = a;
            for (let guard = 0; guard < 80; guard++) { const edge = at[node][want]; if (edge < 0) break; path.push(edge); node = ends[edge][0] === node ? ends[edge][1] : ends[edge][0]; want = want === a ? b : a; }
            if (path.some(edge => ends[edge].includes(u))) continue;
            const colours = path.map(edge => colour[edge]); path.forEach(unset); path.forEach((edge, index) => set(edge, colours[index] === a ? b : a));
            if (at[u][a] < 0 && at[v][a] < 0) { day = a; break; }
          }
          if (day !== undefined) break;
        }
        if (day === undefined) { failed = true; break; }
        set(m, day);
      }
      if (!failed) return colour;
    }
    return matches.map((_, index) => index % 8);
  }
  function drawEurope(league, english = {}) {
    const teams = euroField(league, english), managerIds = league.teams.filter(isManagerTeam).map(team => team.id), seed = hash(league.seed, 'champions-league');
    const matches = euroDraw(teams, seed, managerIds), nights = euroNights(teams, matches, seed), leagueRounds = roundCount(league);
    const fixtures = matches.map((match, index) => ({ ...match, matchday: nights[index] })).sort((a, b) => a.matchday - b.matchday || a.homeId.localeCompare(b.homeId)).map((match, index) => ({ id: `ucl-${match.matchday + 1}-${index + 1}`, ...match, result: null }));
    const dates = EURO_DATES.map((date, index) => ({ ...date, after: clamp(Math.floor(leagueRounds * (index + 1) / (EURO_DATES.length + 1)), 1, leagueRounds) }));
    return { name: 'Champions League', teams, fixtures, dates, step: 0, ties: [], winnerId: null };
  }
  // ---- 38-0's tournament match model --------------------------------------------------------------
  function euroPlan(own, opponent) {
    const perGame = targetPoints(own) / 38;
    let draw = clamp(.26 - (perGame - 1) * .1, .05, .28), win = clamp((perGame - draw) / 3, .02, .97);
    win = Math.min(.97, win + .012 * Math.max(0, own - 88)); draw = Math.min(draw, 1 - win);
    const odds = clamp(win - (opponent - 80) * EURO.strengthK, EURO.winFloor, EURO.winCap);
    return { win: odds, draw: Math.min(draw, 1 - odds) };
  }
  const euroGoals = (own, opponent) => (clamp(-129 + 2.4 * own, 18, 90) / 38 + clamp(248.8 - 2.53 * opponent, 20, 100) / 38) / 2;
  const euroPick = (squad, weights, random, skip = null) => { const options = squad.filter(player => player.id !== skip), values = options.map(player => (weights[player.position] ?? 4) * Math.pow(Math.max(40, player.rating) / 80, 2)); return pickWeighted(options, (_, index) => values[index], random()) || options[0]; };
  function euroScorers(team, count, random, first, last, extra = false) {
    return Array.from({ length: count }, () => {
      const scorer = extra ? pickWeighted(team.squad, player => EURO_ET_SCORER[player.position] ?? 1, random()) : euroPick(team.squad, EURO_SCORER, random);
      const assist = random() < .22 ? null : euroPick(team.squad, EURO_ASSIST, random, scorer.id);
      return { minute: first + Math.floor(random() * (last + 1 - first)), playerId: scorer.id, name: scorer.name, ...(assist ? { assistId: assist.id, assistName: assist.name } : {}), ...(extra ? { extra: true } : {}) };
    });
  }
  function euroShootout(home, away, random) {
    const chance = team => clamp(clamp(.7 + (team.overall - 80) * .005, .55, .9), .5, .93), takers = team => team.squad.filter(player => player.position !== 'GK').sort((a, b) => (scorerWeights[b.position] || 0) * b.rating - (scorerWeights[a.position] || 0) * a.rating || b.rating - a.rating);
    const order = { home: takers(home), away: takers(away) }, odds = { home: chance(home), away: chance(away) }, score = { home: 0, away: 0 }, taken = { home: 0, away: 0 }, kicks = [];
    const kick = side => { const taker = order[side][taken[side] % order[side].length], scored = random() < odds[side]; taken[side]++; if (scored) score[side]++; kicks.push({ side, name: taker?.name || 'Penalty taker', scored }); };
    let side = 'home';
    while ((taken.home < 5 || taken.away < 5) && !(score.home > score.away + (5 - taken.away)) && !(score.away > score.home + (5 - taken.home))) { if (taken[side] < 5) kick(side); side = side === 'home' ? 'away' : 'home'; }
    while (score.home === score.away) { kick('home'); kick('away'); }
    return { home: score.home, away: score.away, kicks };
  }
  // One match: the result first (from both sides' odds), then goals; a knockout draw goes to extra time and penalties.
  function euroMatch(home, away, seed, { knockout = false, late = false } = {}) {
    const random = seeded(seed), own = home.overall, opponent = away.overall, a = euroPlan(own, opponent), b = euroPlan(opponent, own);
    const draw = Math.max(EURO.drawFloor, (a.draw + b.draw) / 2 - Math.abs(own - opponent) * EURO.drawGapDamp), total = a.win + b.win + draw || 1;
    const roll = random(), outcome = roll < a.win / total ? 'home' : roll < (a.win + draw) / total ? 'draw' : 'away';
    const scale = knockout ? (late ? EURO.lateScale : EURO.koScale) : EURO.groupScale;
    let homeGoals = Math.min(EURO.goalCap, poisson(euroGoals(own, opponent) * scale, random)), awayGoals = Math.min(EURO.goalCap, poisson(euroGoals(opponent, own) * scale, random));
    if (knockout && outcome !== 'draw') {
      const again = seeded(hash(seed, 'ko-scoreline')), size = late ? EURO.lateScore : EURO.koScore; let found = false;
      for (let attempt = 0; attempt < 64 && !found; attempt++) { const h = Math.min(EURO.goalCap, poisson(euroGoals(own, opponent) * size, again)), g = Math.min(EURO.goalCap, poisson(euroGoals(opponent, own) * size, again)); if (outcome === 'home' ? h > g : g > h) { homeGoals = h; awayGoals = g; found = true; } }
      if (!found) [homeGoals, awayGoals] = outcome === 'home' ? [1, 0] : [0, 1];
    } else if (outcome === 'home' && homeGoals <= awayGoals) { if (homeGoals >= 1) awayGoals = homeGoals - 1; else homeGoals = awayGoals + 1; }
    else if (outcome === 'away' && awayGoals <= homeGoals) { if (awayGoals >= 1) homeGoals = awayGoals - 1; else awayGoals = homeGoals + 1; }
    else if (outcome === 'draw') homeGoals = awayGoals = Math.round((homeGoals + awayGoals) / 2);
    const result = { homeGoals, awayGoals, homeScorers: euroScorers(home, homeGoals, random, 1, 90), awayScorers: euroScorers(away, awayGoals, random, 1, 90) };
    separate(result.homeScorers, result.awayScorers);
    if (!knockout || outcome !== 'draw') return result;
    const extraHome = Math.min(EURO.goalCap, poisson(euroGoals(own, opponent) * (30 / 90) * scale, random)), extraAway = Math.min(EURO.goalCap, poisson(euroGoals(opponent, own) * (30 / 90) * scale, random));
    return finishExtra(result, home, away, extraHome, extraAway, random, result.homeGoals + extraHome === result.awayGoals + extraAway, false);
  }
  // Extra time on top of a result (in a second leg the scorers follow 38-0's simpler role weights), then penalties if still level.
  function finishExtra(result, home, away, extraHome, extraAway, random, level, legWeights) {
    const homeExtra = euroScorers(home, extraHome, random, 91, 120, legWeights), awayExtra = euroScorers(away, extraAway, random, 91, 120, legWeights);
    const used = new Set(); for (const goal of [...homeExtra, ...awayExtra].sort((x, y) => x.minute - y.minute)) { while (used.has(goal.minute) && goal.minute < 120) goal.minute++; while (used.has(goal.minute)) goal.minute--; used.add(goal.minute); goal.extra = true; }
    const out = { ...result, homeGoals: result.homeGoals + extraHome, awayGoals: result.awayGoals + extraAway, homeScorers: [...result.homeScorers, ...homeExtra.sort(goalOrder)], awayScorers: [...result.awayScorers, ...awayExtra.sort(goalOrder)], extraTime: { home: extraHome, away: extraAway } };
    if (level) out.penalties = euroShootout(home, away, random);
    return out;
  }
  // ---- The competition as it runs through the season -----------------------------------------------
  function euroTable(europe) {
    const rows = new Map(europe.teams.map(team => [team.id, { id: team.id, name: team.name, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, points: 0, awayWins: 0, awayGoals: 0, coeff: team.coeff }]));
    for (const fixture of europe.fixtures) if (fixture.result) {
      const home = rows.get(fixture.homeId), away = rows.get(fixture.awayId), r = fixture.result;
      home.played++; away.played++; home.gf += r.homeGoals; home.ga += r.awayGoals; away.gf += r.awayGoals; away.ga += r.homeGoals; away.awayGoals += r.awayGoals;
      if (r.homeGoals > r.awayGoals) { home.won++; home.points += 3; away.lost++; } else if (r.homeGoals < r.awayGoals) { away.won++; away.awayWins++; away.points += 3; home.lost++; } else { home.drawn++; away.drawn++; home.points++; away.points++; }
    }
    for (const row of rows.values()) row.gd = row.gf - row.ga;
    return [...rows.values()].sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf || b.awayGoals - a.awayGoals || b.won - a.won || b.awayWins - a.awayWins || b.coeff - a.coeff || a.id.localeCompare(b.id)).map((row, index) => ({ ...row, rank: index + 1 }));
  }
  // The games on the next (or a given) European night.
  function euroTonight(europe, step = europe.step) {
    const date = europe.dates[step]; if (!date) return [];
    if (!date.round) return europe.fixtures.filter(fixture => fixture.matchday === step);
    return europe.ties.filter(tie => tie.round === date.round).map(tie => ({ id: `${tie.id}-${date.leg}`, tieId: tie.id, ...(date.leg === 1 && tie.round !== 'F' ? { homeId: tie.bId, awayId: tie.aId } : { homeId: tie.aId, awayId: tie.bId }), result: tie.legs[date.leg - 1]?.result || null, leg: date.leg, round: tie.round }));
  }
  const euroNightHasManager = (league, step) => euroTonight(league.europe, step).some(match => [match.homeId, match.awayId].some(id => isManagerTeam(league.teams.find(item => item.id === id) || { club: true })));
  // A team as it plays tonight: managers at their current (form-adjusted) strength, compressed like 38-0's field;
  // in the last 16 the league-phase ranking gives a small edge (1st +2.5, 2nd–4th +2, 5th–8th +1, 9th–24th +0.5).
  function euroSide(league, teams, id, bonus = 0) {
    const club = league.europe.teams.find(team => team.id === id);
    if (club?.club) return { ...club, overall: club.overall + bonus };
    const team = teams.get(id); return { ...team, overall: euroRating(team.overall) + bonus };
  }
  function euroTies(europe, round, seed) {
    const table = euroTable(europe), team = rank => table[rank - 1].id, random = seeded(hash(seed, 'euro-bracket')), coin = Array.from({ length: 8 }, () => random() < .5);
    const tie = (id, aId, bId, slot) => ({ id, round, aId, bId, slot, legs: [], winnerId: null });
    if (round === 'PO') return [[9, 10, 23, 24], [11, 12, 21, 22], [13, 14, 19, 20], [15, 16, 17, 18]].flatMap(([a, b, c, d], index) => [tie(`ucl-po-${a}`, team(a), team(coin[index] ? d : c), a), tie(`ucl-po-${b}`, team(b), team(coin[index] ? c : d), b)]);
    if (round === 'R16') {
      const winners = europe.ties.filter(item => item.round === 'PO').sort((a, b) => a.slot - b.slot).map(item => item.winnerId), pairs = new Map();
      for (let e = 0; e < 4; e++) { const [n, o] = [winners[6 - 2 * e], winners[7 - 2 * e]], swap = coin[4 + e]; pairs.set(2 * e + 1, swap ? o : n); pairs.set(2 * e + 2, swap ? n : o); }
      return [1, 8, 3, 5, 2, 7, 4, 6].map(rank => tie(`ucl-r16-${rank}`, team(rank), pairs.get(rank), rank));
    }
    const previous = europe.ties.filter(item => item.round === { QF: 'R16', SF: 'QF', F: 'SF' }[round]), next = [];
    for (let index = 0; index < previous.length; index += 2) {
      const a = previous[index], b = previous[index + 1], first = a.slot <= b.slot;
      next.push(tie(`ucl-${round.toLowerCase()}-${index / 2 + 1}`, first ? a.winnerId : b.winnerId, first ? b.winnerId : a.winnerId, Math.min(a.slot, b.slot)));
    }
    return next;
  }
  function playEuroNight(league) {
    const europe = league.europe; if (!europe || europe.step >= europe.dates.length) return { error: 'The Champions League is finished.' };
    const date = europe.dates[europe.step], teams = formedTeams(league), seed = hash(league.seed, 'champions-league');
    let next = { ...europe, fixtures: europe.fixtures, ties: europe.ties.slice() };
    if (!date.round) {
      next.fixtures = europe.fixtures.map(fixture => fixture.matchday !== europe.step ? fixture : { ...fixture, result: euroMatch(euroSide(league, teams, fixture.homeId), euroSide(league, teams, fixture.awayId), hash(seed, fixture.id)) });
    } else {
      if (date.leg === 1) next.ties = [...next.ties, ...euroTies(next, date.round, seed)];
      const ranks = new Map(euroTable(next).map(row => [row.id, row.rank])), bonus = id => date.round !== 'R16' ? 0 : (rank => rank === 1 ? 2.5 : rank <= 4 ? 2 : rank <= 8 ? 1 : rank <= 24 ? .5 : 0)(ranks.get(id) ?? 36);
      next.ties = next.ties.map(tie => {
        if (tie.round !== date.round) return tie;
        const a = euroSide(league, teams, tie.aId, bonus(tie.aId)), b = euroSide(league, teams, tie.bId, bonus(tie.bId));
        if (date.round === 'F') {
          const result = euroMatch(a, b, hash(seed, tie.id), { knockout: true, late: true }), aWins = result.homeGoals > result.awayGoals || (result.penalties && result.penalties.home > result.penalties.away);
          return { ...tie, legs: [{ homeId: tie.aId, awayId: tie.bId, result }], aggA: result.homeGoals, aggB: result.awayGoals, winnerId: aWins ? tie.aId : tie.bId };
        }
        if (date.leg === 1) return { ...tie, legs: [{ homeId: tie.bId, awayId: tie.aId, result: euroMatch(b, a, hash(seed, `${tie.id}:1`)) }] };
        // Second leg at the higher seed; level on aggregate means 30 more minutes, then penalties.
        const first = tie.legs[0].result, random = seeded(hash(seed, `${tie.id}:2:extra`));
        let result = euroMatch(a, b, hash(seed, `${tie.id}:2`));
        let aggA = first.awayGoals + result.homeGoals, aggB = first.homeGoals + result.awayGoals;
        if (aggA === aggB) {
          const extraA = poisson(euroGoals(a.overall, b.overall) * (30 / 90) * .45, random), extraB = poisson(euroGoals(b.overall, a.overall) * (30 / 90) * .45, random);
          result = finishExtra(result, a, b, extraA, extraB, random, aggA + extraA === aggB + extraB, true);
          aggA += extraA; aggB += extraB;
        }
        const aWins = aggA > aggB || (aggA === aggB && result.penalties && result.penalties.home > result.penalties.away);
        return { ...tie, legs: [...tie.legs, { homeId: tie.aId, awayId: tie.bId, result: { ...result, aggregate: { home: aggA, away: aggB } } }], aggA, aggB, winnerId: aWins ? tie.aId : tie.bId };
      });
    }
    next.step = europe.step + 1;
    if (date.round === 'F') next.winnerId = next.ties.find(tie => tie.round === 'F').winnerId;
    return { league: { ...league, europe: next } };
  }
  // Every played European match, for form.
  const euroPlayed = (europe, step) => euroTonight(europe, step).filter(match => match.result);
  const cupTies = league => league.cup && league.cup.round < league.cup.rounds.length ? league.cup.rounds[league.cup.round].ties : [];
  // What happens next: a cup round once its league point is reached, then the January window, then league football.
  function nextEvent(league) {
    if (league.cup && league.cup.round < league.cup.rounds.length && league.round >= league.cup.rounds[league.cup.round].after) return 'cup';
    if (league.europe && league.europe.step < league.europe.dates.length && league.round >= league.europe.dates[league.europe.step].after) return 'europe';
    if (league.window && !league.window.done && league.round >= league.window.after) return 'window';
    if (league.round < roundCount(league)) return 'league';
    return null;
  }
  const eventHasDerby = league => {
    const event = nextEvent(league);
    if (event === 'cup') return cupTies(league).some(tie => managerTie(league, tie));
    if (event === 'europe') return euroNightHasManager(league, league.europe.step);
    if (event === 'league') return league.fixtures.some(fixture => fixture.round === league.round && managerDerby(league, fixture));
    return false;
  };
  // Play whatever comes next, instantly (the window is never automatic).
  function advance(league) {
    const event = nextEvent(league);
    if (event === 'cup') return playCupRound(league);
    if (event === 'europe') return playEuroNight(league);
    if (event === 'league') return playRound(league);
    return { error: event === 'window' ? 'Open the January transfer window first.' : 'The season is finished.' };
  }
  // January window: the managers' new XIs (and benches) apply from the next matchday.
  function applyWindow(league, game, boards) {
    const teams = league.teams.map(item => item.club ? item : team({ ...game, managers: game.managers.map(manager => ({ ...manager, board: boards[manager.id] || manager.board })) }, { ...game.managers.find(manager => manager.id === item.id), board: boards[item.id] || item.board }));
    return { league: { ...league, teams, window: { ...league.window, done: true, boards } } };
  }
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
  const tallyOf = (league, extra = []) => { const tallies = new Map(); for (const result of [...league.fixtures.map(fixture => fixture.result), ...(league.cup?.rounds || []).flatMap(round => round.ties.map(tie => tie.result)), ...extra]) if (result) for (const scorer of [...result.homeScorers, ...result.awayScorers]) tallies.set(scorer.playerId, (tallies.get(scorer.playerId) || 0) + 1); return tallies; };
  // Substitutes mode: kick off a matchday's first halves; the second halves wait for the managers' changes.
  function startRound(league) {
    if (league.round >= roundCount(league)) return { error: 'The league is finished.' };
    const teams = formedTeams(league), tallies = tallyOf(league), firstHalf = {};
    for (const fixture of league.fixtures) if (fixture.round === league.round && managerDerby(league, fixture)) firstHalf[fixture.id] = simulateHalf(teams.get(fixture.homeId), teams.get(fixture.awayId), hash(league.seed, fixture.id), tallies, 1);
    return { league: { ...league, pending: { round: league.round, firstHalf, changes: {}, ready: {} } } };
  }
  function finishRound(league, changes = league.pending?.changes || {}) {
    if (!league.pending) return { error: 'Kick off the first half first.' };
    const teams = formedTeams(league), firstHalf = league.pending.firstHalf, tallies = tallyOf(league, Object.values(firstHalf)), used = {};
    const fixtures = league.fixtures.map(fixture => {
      if (fixture.round !== league.round) return fixture;
      if (!firstHalf[fixture.id]) return { ...fixture, result: resultFor(league, fixture, teams, tallies) };
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
    const teams = formedTeams(league), changes = {};
    for (const id of Object.keys(started.league.pending.firstHalf)) { const fixture = league.fixtures.find(item => item.id === id); changes[id] = { home: autoChanges(teams.get(fixture.homeId)), away: autoChanges(teams.get(fixture.awayId)) }; }
    return finishRound(started.league, changes);
  }
  function create(game, seed = Math.floor(Math.random() * 4294967296), { clubs = [], europe = {} } = {}) {
    const check = readiness(game);
    if (!check.ready) return { error: check.message };
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) return { error: 'Invalid league seed.' };
    const teams = [...game.managers.map(manager => team(game, manager)), ...clubs.map(club => ({ ...club, club: true, overall: club.strength }))];
    const league = { version: 1, engineVersion: VERSION, seed, round: 0, competition: clubs.length ? 'premier' : 'friends', teams, fixtures: schedule(teams.map(item => item.id)), ...(game.config.subs ? { subs: {}, pending: null } : {}),
      form: !!game.config.form, startBoards: Object.fromEntries(game.managers.map(manager => [manager.id, manager.board.slice()])) };
    if (clubs.length) league.planned = plan(league);
    if (game.config.cup) league.cup = drawCup(league);
    if (game.config.europe) league.europe = drawEurope(league, europe);
    if (game.config.january) league.window = { after: Math.floor(roundCount(league) / 2), done: false };
    return { league };
  }
  // Premier League mode: everything not manager-v-manager is decided up front (and kept server-side).
  function plan(league) {
    const byId = new Map(league.teams.map(item => [item.id, item])), planned = {};
    for (const manager of league.form ? [] : league.teams.filter(isManagerTeam)) {
      const fixtures = league.fixtures.filter(fixture => (fixture.homeId === manager.id && byId.get(fixture.awayId).club) || (fixture.awayId === manager.id && byId.get(fixture.homeId).club))
        .map(fixture => ({ fixture, home: fixture.homeId === manager.id, club: byId.get(fixture.homeId === manager.id ? fixture.awayId : fixture.homeId) }));
      seasonAgainstClubs(manager, fixtures, hash(league.seed, `season:${manager.id}`)).forEach((result, index) => { planned[fixtures[index].fixture.id] = result; });
    }
    const tallies = new Map();
    for (const fixture of league.fixtures) if (byId.get(fixture.homeId).club && byId.get(fixture.awayId).club) planned[fixture.id] = simulateMatch(byId.get(fixture.homeId), byId.get(fixture.awayId), hash(league.seed, fixture.id), tallies);
    return planned;
  }
  const managerTie = (league, tie) => !tie.bye && [tie.homeId, tie.awayId].some(id => isManagerTeam(league.teams.find(item => item.id === id)));
  const managerDerby = (league, fixture) => { const home = league.teams.find(item => item.id === fixture.homeId), away = league.teams.find(item => item.id === fixture.awayId); return isManagerTeam(home) && isManagerTeam(away); };
  const nextDerbyRound = league => { const fixture = league.fixtures.find(item => item.round >= league.round && managerDerby(league, item)); return fixture ? fixture.round : null; };
  const roundCount = league => Math.max(...league.fixtures.map(fixture => fixture.round)) + 1;
  function playRound(league) {
    if (league.round >= roundCount(league)) return { error: 'The league is finished.' };
    if (league.subs) return playWithSubs(league);
    const teams = formedTeams(league), tallies = tallyOf(league);
    const fixtures = league.fixtures.map(fixture => fixture.round !== league.round ? fixture : { ...fixture, result: resultFor(league, fixture, teams, tallies) });
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
    return league ? { version: league.version, engineVersion: league.engineVersion, seed: league.seed, round: league.round, competition: league.competition || 'friends', ...(league.subs ? { subs: league.subs, pending: league.pending ? { round: league.pending.round, changes: league.pending.changes, ready: league.pending.ready } : null } : {}), boards: league.teams.filter(isManagerTeam).map(team => ({ id: team.id, board: league.startBoards?.[team.id] || team.board })), cupRound: league.cup?.round || 0, euroStep: league.europe?.step || 0, window: league.window?.done ? league.window.boards : null } : null;
  }
  function restore(saved, game, { clubs = [], europe = {} } = {}) {
    try {
      if (!saved || saved.version !== 1 || !VERSIONS.includes(saved.engineVersion) || !Number.isInteger(saved.round)) return null;
      if ((saved.competition || 'friends') !== (clubs.length ? 'premier' : 'friends')) return null;
      // Rebuild from the XIs the league started with (the managers' boards may have moved on in January).
      const startBoards = Object.fromEntries((saved.boards || []).map(item => [item.id, item.board]));
      for (const manager of game.managers) {
        const board = startBoards[manager.id], owned = new Set(auction.purchases(game, manager.id).map(sale => sale.playerId));
        if (!board || board.length !== 11 || board.some(id => !owned.has(id))) return null;
      }
      const startGame = { ...game, phase: 'complete', managers: game.managers.map(manager => ({ ...manager, board: startBoards[manager.id].slice() })) };
      let league = create(startGame, saved.seed, { clubs, europe }).league;
      if (!league || saved.round < 0 || saved.round > roundCount(league)) return null;
      // Starting snapshots leave out January signings, who join the squads only when the window closes.
      league = { ...league, teams: league.teams.map(item => item.club ? item : team(startGame, startGame.managers.find(manager => manager.id === item.id), { january: false })) };
      const playLeagueRound = () => {
        if (!league.subs) return playRound(league).league;
        const round = league.round, started = startRound(league).league;
        return finishRound(started, Object.fromEntries(started.fixtures.filter(fixture => fixture.round === round && started.pending.firstHalf[fixture.id]).map(fixture => [fixture.id, saved.subs?.[fixture.id] || { home: [], away: [] }]))).league;
      };
      // Replay events in the order they happened: cup rounds, the window, then league matchdays.
      for (let guard = 0; guard < 200; guard++) {
        const event = nextEvent(league);
        if (event === 'cup' && league.cup.round < (saved.cupRound || 0)) league = playCupRound(league).league;
        else if (event === 'europe' && league.europe.step < (saved.euroStep || 0)) league = playEuroNight(league).league;
        else if (event === 'window' && saved.window) league = applyWindow(league, game, saved.window).league;
        else if (event === 'league' && league.round < saved.round) league = playLeagueRound();
        else break;
      }
      if (league.round !== saved.round || (league.cup?.round || 0) !== (saved.cupRound || 0) || (league.europe?.step || 0) !== (saved.euroStep || 0)) return null;
      if (league.subs && saved.pending) { if (saved.pending.round !== saved.round) return null; league = startRound(league).league; league.pending.changes = saved.pending.changes || {}; league.pending.ready = saved.pending.ready || {}; }
      return league;
    } catch { return null; }
  }
  const api = { VERSION, formTable, formOf, formed, FORM_NEUTRAL, FORM_EFFECT, drawCup, playCupRound, cupTies, EURO_CLUBS, drawEurope, playEuroNight, euroTable, euroTonight, euroMatch, nextEvent, eventHasDerby, advance, applyWindow, shootout, FATIGUE, DRAIN, staminaAt, secondHalfRating, lineupAfter, secondHalfTeam, autoChanges, startRound, finishRound, SEASON, basePlan, fixtureOdds, seasonAgainstClubs, managerDerby, managerTie, nextDerbyRound, isManagerTeam, absoluteMinute, minuteLabel, goalTime, naturalRank, fitMultiplier, team, readiness, schedule, seeded, poisson, expectedGoals, simulateMatch, create, roundCount, playRound, table, awards, serialise, restore };
  if (typeof module !== 'undefined') module.exports = api; else scope.LeagueCore = api;
})(globalThis);
