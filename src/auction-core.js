(function (scope) {
  const draft = typeof module !== 'undefined' ? require('./draft-core.js') : scope.DraftCore;
  const STARTING_BUDGET = 1000; // Tenths of a million: integer arithmetic avoids rounding errors.
  function shuffle(items, random = Math.random) {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
  function candidates(players, config) {
    return players.flatMap(player => {
      if (config.mode === 'peak' && (player.peakRating < config.ratingMin || player.peakRating > config.ratingMax)) return [];
      const seasons = player.clubSeasons.filter(season => season.season >= config.seasonFrom && season.season <= config.seasonTo
        && (config.mode !== 'season' || (season.seasonRating >= config.ratingMin && season.seasonRating <= config.ratingMax)));
      return seasons.length ? [{ player, seasons }] : [];
    });
  }
  function balance(eligible, formation, managerCount, random = Math.random) {
    const shape = draft.formations[formation];
    if (!shape || !Number.isInteger(managerCount) || managerCount < 2 || managerCount > 8) return { error: 'Choose a formation and between 2 and 8 managers.' };
    if (eligible.length < managerCount * 11) return { error: `You need at least ${managerCount * 11} different players. Widen your season or rating range.` };
    const needs = Array.from({ length: managerCount }, () => shape.map(slot => slot.position)).flat();
    const byPosition = new Map();
    for (const position of new Set(needs)) {
      const indexes = eligible.flatMap((entry, i) => {
        const goalkeeper = entry.player.positions.includes('GK');
        return (position === 'GK' ? goalkeeper : !goalkeeper && draft.fits(entry.player, position)) ? [i] : [];
      });
      const required = needs.filter(item => item === position).length;
      if (indexes.length < required) return { error: `This pool needs ${required} ${position} players, but only ${indexes.length} qualify. Widen your season or rating range.` };
      byPosition.set(position, shuffle(indexes, random));
    }
    const assigned = Array(needs.length).fill(-1);
    const taken = new Map();
    // Randomised bipartite matching accounts for versatile players without
    // counting the same footballer twice toward positional quotas.
    function find(slot, visited) {
      for (const index of byPosition.get(needs[slot])) {
        if (visited.has(index)) continue;
        visited.add(index);
        if (!taken.has(index) || find(taken.get(index), visited)) {
          taken.set(index, slot); assigned[slot] = index; return true;
        }
      }
      return false;
    }
    const order = needs.map((_, i) => i).sort((a, b) => byPosition.get(needs[a]).length - byPosition.get(needs[b]).length);
    for (const slot of order) if (!find(slot, new Set())) return { error: 'There are not enough different players to cover all positions. Widen your season or rating range.' };
    return { assigned, needs };
  }
  function makePool(players, config, random = Math.random) {
    const eligible = candidates(players, config);
    const result = balance(eligible, config.formation, config.managerCount, random);
    if (result.error) return result;
    const pool = result.assigned.map((index, slot) => {
      const entry = eligible[index];
      return { id: entry.player.id, player: entry.player, season: entry.seasons[Math.floor(random() * entry.seasons.length)], allocatedPosition: result.needs[slot] };
    });
    return { pool: shuffle(pool, random) };
  }
  function createGame(config, pool) {
    return { config: Object.freeze({ ...config, names: Object.freeze(config.names.slice()) }), pool,
      managers: config.names.map((name, i) => ({ id: `manager-${i + 1}`, name, board: Array(11).fill(null) })),
      remaining: pool.map(entry => entry.id), currentId: null, phase: 'ready', sales: [], lastPassedId: null };
  }
  const purchases = (game, managerId) => game.sales.filter(sale => sale.managerId === managerId);
  const budget = (game, managerId) => STARTING_BUDGET - purchases(game, managerId).reduce((total, sale) => total + sale.price, 0);
  function reveal(game, random = Math.random) {
    if (game.phase === 'revealed') return { error: 'Sell this player or pass before spinning again.' };
    if (!game.remaining.length) return { error: 'All players have been sold.' };
    const choices = game.remaining.length > 1 ? game.remaining.filter(id => id !== game.lastPassedId) : game.remaining;
    return { game: { ...game, currentId: choices[Math.floor(random() * choices.length)], phase: 'revealed', lastPassedId: null } };
  }
  function buy(game, managerId, price) {
    if (game.phase !== 'revealed' || !game.currentId || !game.remaining.includes(game.currentId)) return { error: 'Spin to reveal a player first.' };
    const manager = game.managers.find(manager => manager.id === managerId);
    if (!manager) return { error: 'Choose the winning manager.' };
    if (!Number.isInteger(price) || price < 0) return { error: 'Enter a price in £0.1m increments, including £0 for a free transfer.' };
    if (purchases(game, managerId).length >= 11) return { error: `${manager.name} already has 11 players.` };
    if (price > budget(game, managerId)) return { error: `${manager.name} does not have enough budget.` };
    const sales = [...game.sales, { playerId: game.currentId, managerId, price }];
    return { game: { ...game, sales, remaining: game.remaining.filter(id => id !== game.currentId), phase: sales.length === game.pool.length ? 'complete' : 'sold' } };
  }
  function pass(game) {
    if (game.phase !== 'revealed') return { error: 'There is no unsold player to pass.' };
    return { game: { ...game, lastPassedId: game.currentId, currentId: null, phase: 'ready' } };
  }
  function undo(game) {
    if (!game.sales.length || !['sold', 'complete'].includes(game.phase)) return { error: 'You can undo the most recent sale before spinning again.' };
    const last = game.sales.at(-1);
    return { game: { ...game, sales: game.sales.slice(0, -1), remaining: [...game.remaining, last.playerId], currentId: last.playerId,
      phase: 'revealed', lastPassedId: null, managers: game.managers.map(manager => ({ ...manager, board: manager.board.map(id => id === last.playerId ? null : id) })) } };
  }
  function place(game, managerId, playerId, slot) {
    const manager = game.managers.find(item => item.id === managerId);
    if (!manager || !purchases(game, managerId).some(sale => sale.playerId === playerId)) return { error: 'This player belongs to another manager.' };
    if (!Number.isInteger(slot) || slot < 0 || slot >= 11) return { error: 'Choose a spot on the pitch.' };
    const board = manager.board.slice(), from = board.indexOf(playerId), displaced = board[slot];
    if (from >= 0) board[from] = displaced;
    board[slot] = playerId;
    return { game: { ...game, managers: game.managers.map(item => item.id === managerId ? { ...item, board } : item) } };
  }
  function unplace(game, managerId, playerId) {
    return { ...game, managers: game.managers.map(manager => manager.id === managerId ? { ...manager, board: manager.board.map(id => id === playerId ? null : id) } : manager) };
  }
  function serialise(game) {
    return { version: 1, config: game.config, pool: game.pool.map(entry => ({ id: entry.id, clubId: entry.season.clubId, season: entry.season.season, allocatedPosition: entry.allocatedPosition })),
      managers: game.managers, remaining: game.remaining, currentId: game.currentId, phase: game.phase, sales: game.sales, lastPassedId: game.lastPassedId };
  }
  function restore(saved, players) {
    try {
      const config = saved.config;
      if (saved.version !== 1 || !draft.formations[config.formation] || !['peak', 'season'].includes(config.mode)
        || !Number.isInteger(config.managerCount) || config.managerCount < 2 || config.managerCount > 8
        || config.names.length !== config.managerCount || config.names.some(name => typeof name !== 'string' || !name.trim() || name.length > 24)
        || !Number.isInteger(config.ratingMin) || !Number.isInteger(config.ratingMax) || config.ratingMin < 40 || config.ratingMax > 95 || config.ratingMin > config.ratingMax
        || config.seasonFrom > config.seasonTo) return null;
      const playerMap = new Map(players.map(player => [player.id, player]));
      const pool = saved.pool.map(record => {
        const player = playerMap.get(record.id);
        const season = player.clubSeasons.find(season => season.clubId === record.clubId && season.season === record.season);
        if (!season || !candidates([{ ...player, clubSeasons: [season] }], config).length) throw Error('Invalid saved pool');
        return { id: player.id, player, season, allocatedPosition: record.allocatedPosition };
      });
      if (pool.length !== config.managerCount * 11 || new Set(pool.map(entry => entry.id)).size !== pool.length) return null;
      let game = createGame(config, pool);
      // Replay sales through normal validation to rebuild budgets and ownership.
      for (const sale of saved.sales) {
        if (!game.remaining.includes(sale.playerId)) return null;
        const result = buy({ ...game, phase: 'revealed', currentId: sale.playerId }, sale.managerId, sale.price);
        if (result.error) return null;
        game = result.game;
      }
      if (saved.managers.length !== config.managerCount || !['ready', 'revealed', 'sold', 'complete'].includes(saved.phase)) return null;
      const managers = game.managers.map((manager, i) => {
        const record = saved.managers[i], owned = new Set(purchases(game, manager.id).map(sale => sale.playerId));
        if (record.id !== manager.id || record.board.length !== 11 || record.board.some(id => id !== null && !owned.has(id))
          || new Set(record.board.filter(id => id !== null)).size !== record.board.filter(id => id !== null).length) throw Error('Invalid saved board');
        return { ...manager, board: record.board.slice() };
      });
      if (!Array.isArray(saved.remaining) || saved.remaining.length !== game.remaining.length
        || new Set(saved.remaining).size !== saved.remaining.length || saved.remaining.some(id => !game.remaining.includes(id))) return null;
      if (saved.phase === 'revealed' && !game.remaining.includes(saved.currentId)) return null;
      if (saved.phase === 'ready' && saved.currentId !== null) return null;
      if (['sold', 'complete'].includes(saved.phase) && saved.currentId !== game.sales.at(-1)?.playerId) return null;
      if ((saved.phase === 'complete') !== (game.remaining.length === 0)) return null;
      return { ...game, managers, remaining: saved.remaining.slice(), phase: saved.phase, currentId: saved.currentId,
        lastPassedId: game.remaining.includes(saved.lastPassedId) ? saved.lastPassedId : null };
    } catch { return null; }
  }
  const api = { STARTING_BUDGET, shuffle, candidates, balance, makePool, createGame, purchases, budget, reveal, buy, pass, undo, place, unplace, serialise, restore };
  if (typeof module !== 'undefined') module.exports = api; else scope.AuctionCore = api;
})(globalThis);
