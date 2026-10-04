// Inspect downloaded public browser modules in an isolated context. No network,
// browser APIs, or application dependencies are available to the module loader.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../data/research/38-0');
const registrations = [];
const context = vm.createContext({ TURBOPACK: { push: value => registrations.push(value) } });
vm.runInContext(fs.readFileSync(path.join(root, '0t_d4h73ui0ca.js'), 'utf8'), context, { timeout: 1000 });
const factories = new Map(), exportsById = new Map([[247167, { default: { env: {} } }]]);
for (const registration of registrations) {
  let ids = [];
  for (const item of registration.slice(1)) {
    if (typeof item === 'number') ids.push(item);
    else if (typeof item === 'function') { for (const id of ids) factories.set(id, { factory: item, ids }); ids = []; }
  }
}
function load(id) {
  if (exportsById.has(id)) return exportsById.get(id);
  assert([13898, 40693, 414553].includes(id), `Unexpected dependency ${id}`);
  const registration = factories.get(id);
  for (const key of registration.ids) exportsById.set(key, {});
  registration.factory({ i: load, s: (entries, target = id) => {
    const exported = exportsById.get(target);
    for (let index = 0; index < entries.length; index += 3) exported[entries[index]] = entries[index + 2];
  } });
  return exportsById.get(id);
}
const positions = load(13898), ratings = load(414553), formations = load(40693);
const slots = formations.FORMATIONS['4-3-3'];
const team = slots.map(slot => ({ slot, ratingUsed: 80, player: { overall: 80, positions: [slot.position] } }));
assert.equal(ratings.calcEffectiveRating(team).overall, 80);
team.find(entry => entry.slot.position === 'ST').player.positions = ['CB'];
assert.equal(ratings.calcEffectiveRating(team).attack, 78);
const weights = { attack: 0.30, midfield: 0.30, defence: 0.28, goalkeeping: 0.12 };
const evidence = {
  checkedOn: '2026-10-03',
  source: 'https://38-0.app/_next/static/immutable/chunks/0t_d4h73ui0ca.js',
  examples: {
    natural: positions.naturalRank('ST', ['ST']),
    secondary: positions.naturalRank('ST', ['LW', 'ST']),
    third: positions.naturalRank('ST', ['LW', 'RW', 'ST']),
    incompatible: positions.naturalRank('ST', ['CB']),
    centralMidfielderAsCDM: positions.naturalRank('CDM', ['CM']),
    attackingMidfielderAsCDM: positions.naturalRank('CDM', ['CAM', 'CM']),
    primaryFullbackAsWingback: positions.naturalRank('RWB', ['RB']),
  },
  effectiveRatingsWithMisplacedStriker: ratings.calcEffectiveRating(team),
  verifiedDefaults: { fit: [1, 0.99, 0.98, 0.93], minimumEffectiveRating: 40, unitWeights: weights, fullbackDefenceWeight: 0.6 },
};
const simSource = fs.readFileSync(path.join(root, '0fbgc9mt4pxcs.js'), 'utf8');
const prefix = '"simulateHeadToHead",0,';
const start = simSource.indexOf(prefix);
assert(start >= 0);
const expression = simSource.slice(start + prefix.length, simSource.indexOf(',"simulateSeason"', start));
// The module's own seeded random, goal-time, scorer and minute-separation helpers sit together, from ar to a_.
const helpersStart = simSource.indexOf('function ar('), helpersEnd = simSource.indexOf('let ax=new Set', helpersStart);
assert(helpersStart >= 0 && helpersEnd > helpersStart);
const simContext = vm.createContext({ a: { default: { env: {} } } });
vm.runInContext(simSource.slice(helpersStart, helpersEnd), simContext, { timeout: 1000 });
const headToHead = vm.runInContext(`(${expression})`, simContext, { timeout: 1000 });
if (require.main === module) {
  fs.writeFileSync(path.join(root, '../verified-engine.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
}
module.exports = { positions, ratings, formations, headToHead };
