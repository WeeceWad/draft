(function (scope) {
  const row = (positions, y, xs) => positions.map((position, i) => ({ position, x: xs[i], y }));
  const point = (position, x, y) => ({ position, x, y });
  const backFour = row(['LB', 'CB', 'CB', 'RB'], 72, [12, 32, 68, 88]);
  const backThree = [point('CB', 30, 72), point('CB', 50, 66), point('CB', 70, 72)];
  const backFive = [point('LWB', 10, 63), ...backThree, point('RWB', 90, 63)];
  const keeper = point('GK', 50, 88);
  const formations = {
    // Keep the original slot order so saved teams retain their assigned positions.
    '4-3-3': [...row(['LW', 'ST', 'RW'], 12, [18, 50, 82]), point('CM', 24, 43), point('CDM', 50, 55), point('CM', 76, 43), ...backFour, keeper],
    '4-4-2': [...row(['ST', 'ST'], 15, [35, 65]), ...row(['LM', 'CM', 'CM', 'RM'], 44, [14, 38, 62, 86]), ...backFour, keeper],
    '4-2-3-1': [point('ST', 50, 10), point('LM', 16, 35), point('CAM', 50, 31), point('RM', 84, 35), ...row(['CDM', 'CDM'], 53, [35, 65]), ...backFour, keeper],
    '3-5-2': [...row(['ST', 'ST'], 12, [35, 65]), point('CAM', 50, 32), ...row(['LWB', 'CM', 'CM', 'RWB'], 49, [10, 30, 70, 90]), ...backThree, keeper],
    '4-3-2-1': [point('ST', 50, 10), ...row(['LW', 'RW'], 29, [30, 70]), point('CM', 24, 49), point('CDM', 50, 57), point('CM', 76, 49), ...backFour, keeper],
    '4-3-3 (flat)': [...row(['LW', 'ST', 'RW'], 12, [18, 50, 82]), ...row(['CM', 'CM', 'CM'], 45, [24, 50, 76]), ...backFour, keeper],
    '4-3-3 (attacking)': [...row(['LW', 'ST', 'RW'], 10, [18, 50, 82]), point('CM', 25, 49), point('CAM', 50, 32), point('CM', 75, 49), ...backFour, keeper],
    '4-1-2-1-2 (diamond)': [...row(['ST', 'ST'], 11, [33, 67]), point('CAM', 50, 31), ...row(['CM', 'CM'], 45, [24, 76]), point('CDM', 50, 55), ...backFour, keeper],
    '4-1-2-1-2 (wide)': [...row(['ST', 'ST'], 11, [33, 67]), point('CAM', 50, 31), ...row(['LM', 'RM'], 45, [14, 86]), point('CDM', 50, 55), ...backFour, keeper],
    '4-1-4-1': [point('ST', 50, 10), ...row(['LM', 'CM', 'CM', 'RM'], 34, [12, 36, 64, 88]), point('CDM', 50, 55), ...backFour, keeper],
    '4-4-1-1': [point('ST', 50, 10), point('CAM', 50, 31), ...row(['LM', 'CM', 'CM', 'RM'], 51, [12, 36, 64, 88]), ...backFour, keeper],
    '4-2-2-2': [...row(['ST', 'ST'], 11, [33, 67]), ...row(['CAM', 'CAM'], 33, [24, 76]), ...row(['CDM', 'CDM'], 53, [35, 65]), ...backFour, keeper],
    '4-5-1': [point('ST', 50, 12), point('LM', 10, 37), ...row(['CM', 'CM', 'CM'], 47, [30, 50, 70]), point('RM', 90, 37), ...backFour, keeper],
    '3-4-3': [...row(['LW', 'ST', 'RW'], 12, [18, 50, 82]), ...row(['LWB', 'CM', 'CM', 'RWB'], 43, [10, 35, 65, 90]), ...backThree, keeper],
    '3-4-2-1': [point('ST', 50, 10), ...row(['CAM', 'CAM'], 29, [28, 72]), ...row(['LWB', 'CM', 'CM', 'RWB'], 50, [10, 30, 70, 90]), ...backThree, keeper],
    '3-4-1-2': [...row(['ST', 'ST'], 11, [33, 67]), point('CAM', 50, 31), ...row(['LWB', 'CM', 'CM', 'RWB'], 49, [10, 30, 70, 90]), ...backThree, keeper],
    '3-5-2 (holding)': [...row(['ST', 'ST'], 12, [35, 65]), ...row(['CM', 'CM'], 34, [28, 72]), point('LWB', 10, 47), point('CDM', 50, 46), point('RWB', 90, 47), ...backThree, keeper],
    '5-3-2': [...row(['ST', 'ST'], 12, [35, 65]), point('CM', 24, 37), point('CDM', 50, 46), point('CM', 76, 37), ...backFive, keeper],
    '5-2-1-2': [...row(['ST', 'ST'], 11, [33, 67]), point('CAM', 50, 31), ...row(['CM', 'CM'], 47, [28, 72]), ...backFive, keeper],
    '5-4-1': [point('ST', 50, 12), ...row(['LM', 'CM', 'CM', 'RM'], 40, [12, 36, 64, 88]), ...backFive, keeper],
  };
  const equivalents = { LW: ['LW', 'LM'], LM: ['LM', 'LW'], RW: ['RW', 'RM'], RM: ['RM', 'RW'], LB: ['LB', 'LWB'], LWB: ['LWB', 'LB'], RB: ['RB', 'RWB'], RWB: ['RWB', 'RB'] };
  const fits = (player, position) => (equivalents[position] || [position]).some(item => player.positions.includes(item));
  const rating = (entry, mode) => mode === 'season' ? entry.season.seasonRating : entry.player.peakRating;
  function remap(squad, oldFormation, nextFormation) {
    const candidates = squad.map((entry, i) => ({ entry, index: i, position: formations[oldFormation][i].position }));
    const memo = new Map();
    // Find the best complete assignment so retaining one position cannot block
    // another player's only compatible position. Keep all picks even when a new
    // formation cannot accommodate everyone; the UI flags those mismatches.
    function best(i, mask) {
      if (i === 11) return { score: 0, indexes: [] };
      if (memo.has(mask)) return memo.get(mask);
      const slot = formations[nextFormation][i];
      let result = { score: -Infinity, indexes: [] };
      candidates.forEach((candidate, index) => {
        if (mask & (1 << index)) return;
        const compatible = candidate.entry && fits(candidate.entry.player, slot.position);
        const score = (compatible ? 1000 : 0) + (compatible && candidate.position === slot.position ? 20 : 0) + (candidate.index === i ? 1 : 0);
        const next = best(i + 1, mask | (1 << index));
        if (score + next.score > result.score) result = { score: score + next.score, indexes: [index, ...next.indexes] };
      });
      memo.set(mask, result);
      return result;
    }
    return best(0, 0).indexes.map(index => candidates[index].entry);
  }
  function draft(squad, formation, selected, entry) {
    if (squad.some(item => item?.player.id === entry.player.id)) return { error: 'This player is already in your XI.' };
    const slots = formations[formation];
    const target = selected === null ? slots.findIndex((slot, i) => !squad[i] && fits(entry.player, slot.position)) : selected;
    if (target < 0) return { error: 'No empty position fits this player. Select a filled position to replace someone.' };
    if (!fits(entry.player, slots[target].position)) return { error: `${entry.player.name} does not play ${slots[target].position}. Select a matching position.` };
    const next = squad.slice();
    next[target] = entry;
    return { squad: next, target };
  }
  // 'Free' rooms let each manager pick a formation. Their pool is balanced like a 4-3-3.
  const FREE = 'Free';
  const poolShape = formation => formations[formation === FREE ? '4-3-3' : formation];
  const formationOf = (game, manager) => formations[manager?.formation] ? manager.formation : formations[game.config.formation] ? game.config.formation : '4-3-3';
  // Substitutes mode: 16-player squads, an XI plus five outfield substitutes. One keeper per squad either way.
  const squadSize = config => config?.subs ? 16 : 11;
  const keepersNeeded = () => 1;
  // Kit colours: each manager picks one, unique in the room and locked once chosen.
  // Twelve kits that stay clearly distinct from one another (perceptual colour distance above 140 for every pair).
  const KITS = { red: { name: 'Red', hex: '#e53935' }, sky: { name: 'Sky blue', hex: '#4fc3f7' }, white: { name: 'White', hex: '#f5f5f5' }, yellow: { name: 'Yellow', hex: '#fdd835' },
    purple: { name: 'Purple', hex: '#8e24aa' }, pink: { name: 'Pink', hex: '#f48fb1' }, navy: { name: 'Navy', hex: '#1a237e' }, black: { name: 'Black', hex: '#1b1b1b' },
    orange: { name: 'Orange', hex: '#fb8c00' }, teal: { name: 'Teal', hex: '#00897b' }, claret: { name: 'Claret', hex: '#7b1131' }, lime: { name: 'Lime', hex: '#c6ff00' } };
  const rgb = hex => [1, 3, 5].map(index => parseInt(String(hex).slice(index, index + 2), 16) || 0);
  // Redmean distance: a cheap approximation of how different two colours look.
  const colourDistance = (a, b) => { const [r1, g1, b1] = rgb(a), [r2, g2, b2] = rgb(b), mean = (r1 + r2) / 2; return Math.sqrt((2 + mean / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - mean) / 256) * (b1 - b2) ** 2); };
  const clash = (a, b) => colourDistance(a, b) < 130;
  const textOn = hex => { const [r, g, b] = rgb(hex); return .299 * r + .587 * g + .114 * b > 150 ? '#0c1018' : '#ffffff'; };
  const api = { formations, fits, rating, remap, draft, FREE, poolShape, formationOf, squadSize, keepersNeeded, KITS, colourDistance, clash, textOn };
  if (typeof module !== 'undefined') module.exports = api;
  else scope.DraftCore = api;
})(globalThis);
