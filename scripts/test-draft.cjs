const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/draft-core.js');
const players = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/38-0/players.json'), 'utf8'));
const henry = players.find(player => player.name === 'Thierry Henry');
const entry = { player: henry, season: henry.clubSeasons.find(season => season.season === '2011/12') };
assert.equal(core.rating(entry, 'peak'), 95);
assert.equal(core.rating(entry, 'season'), 83);
assert(core.fits(henry, 'ST'));
assert(!core.fits(henry, 'GK'));
let result = core.draft(Array(11).fill(null), '4-3-3', 1, entry);
assert.equal(result.target, 1);
assert.equal(result.squad[1].player.id, henry.id);
assert(core.draft(result.squad, '4-3-3', 0, entry).error, 'Duplicate players must be rejected even in a different season');
assert(core.draft(Array(11).fill(null), '4-3-3', 10, entry).error, 'Incompatible selected positions must reject the pick');
const initial = Array(11).fill(null);
core.formations['4-3-3'].forEach((slot, i) => {
  const player = players.find(player => core.fits(player, slot.position) && !initial.some(entry => entry?.player.id === player.id));
  initial[i] = { player, season: player.clubSeasons[0] };
});
for (const [name, slots] of Object.entries(core.formations)) {
  assert.equal(slots.length, 11);
  assert.equal(slots.filter(slot => slot.position === 'GK').length, 1);
  assert(slots.every(slot => slot.x > 0 && slot.x < 100 && slot.y > 0 && slot.y < 100), `${name}: positions stay on the pitch`);
  const central = slots.filter(slot => slot.position === 'CM');
  const holding = slots.filter(slot => slot.position === 'CDM');
  const attacking = slots.filter(slot => slot.position === 'CAM');
  if (central.length && holding.length) assert(Math.min(...holding.map(slot => slot.y)) > Math.max(...central.map(slot => slot.y)), `${name}: CDMs sit behind CMs`);
  if (attacking.length && central.length) assert(Math.max(...attacking.map(slot => slot.y)) < Math.min(...central.map(slot => slot.y)), `${name}: CAMs sit ahead of CMs`);
  if (attacking.length && holding.length) assert(Math.max(...attacking.map(slot => slot.y)) < Math.min(...holding.map(slot => slot.y)), `${name}: CAMs sit ahead of CDMs`);
  const remapped = core.remap(initial, '4-3-3', name);
  assert.equal(remapped.filter(Boolean).length, 11);
  assert.deepEqual(remapped.map(entry => entry.player.id).sort(), initial.map(entry => entry.player.id).sort());
  assert(core.fits(remapped[10].player, 'GK'), 'Keeper should remain in goal');
}
// Returning to the original formation must recover compatible positions, even
// if intermediate formations required an out-of-position player.
let cycled = initial;
let previous = '4-3-3';
for (const name of ['4-4-2', '4-2-3-1', '3-5-2', '4-3-2-1', '4-3-3']) {
  cycled = core.remap(cycled, previous, name);
  previous = name;
}
assert(cycled.every((entry, i) => core.fits(entry.player, core.formations['4-3-3'][i].position)), 'Formation changes must recover a fully compatible assignment when one exists');
console.log('Draft checks passed: exact ratings, compatibility, duplicates, 11-player formations, and preservation when changing formations.');
