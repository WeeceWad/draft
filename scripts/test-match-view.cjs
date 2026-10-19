// Pitch view realism: no offside receivers, shots from a sensible range, corners from the flag,
// nobody (and no ball) jumping, extra time on the clock, and every real goal shown.
const assert = require('node:assert/strict');
const view = require('../src/match-view.js');
const draft = require('../src/draft-core.js');
const league = require('../src/league-core.js');
const LENGTH = 105, WIDTH = 68, DT = .1;
const formations = Object.keys(draft.formations);
const squadFor = (formation, tag) => draft.formations[formation].map((slot, i) => ({ id: `${tag}${i}`, name: `${tag} Player${i}`, position: slot.position, rating: 70 + (i * 7) % 20 }));
const stats = { passes: 0, offside: 0, goals: 0, far: 0, corners: 0, badCorners: 0, ballJumps: 0, playerJumps: 0 };
for (let seed = 1; seed <= 250; seed++) {
  const hf = formations[seed % formations.length], af = formations[(seed * 7) % formations.length];
  const home = { formation: hf, squad: squadFor(hf, 'H') }, away = { formation: af, squad: squadFor(af, 'A') };
  const extraTime = seed % 5 === 0;
  const goals = (count, tag, extra) => Array.from({ length: count }, (_, i) => ({ playerId: `${tag}${10 - (i % 4)}`, name: `${tag} Player${10 - (i % 4)}`, minute: extra ? 92 + i * 9 : 5 + ((seed * 13 + i * 29) % 85), ...(i % 2 ? { assistId: `${tag}${7 + (i % 3)}`, assistName: 'y' } : {}), ...(extra ? { extra: true } : {}) }));
  const result = { homeScorers: [...goals(seed % 4, 'H'), ...(extraTime ? goals(1, 'H', true) : [])], awayScorers: goals((seed >> 2) % 3, 'A'), homeXg: 1.5, awayXg: 1.1 };
  const to = extraTime ? 127 : view.END, timeline = view.build({ result, home, away, seed, duration: extraTime ? 196 : 150, to });
  assert.equal(view.clockAt(timeline, 1e9), to, 'The clock runs to the end of the match, extra time included');
  const real = [...result.homeScorers, ...result.awayScorers];
  assert.equal(timeline.events.filter(event => event.goal).length, real.length, 'Every real goal is shown');
  for (const goal of real) assert(timeline.events.some(event => event.goal && event.abs === league.absoluteMinute(goal)));
  for (const item of timeline.highlights) {
    const abs = item.plan.abs, homeDir = (abs < 48.6 || (abs >= 97 && abs < 112.5)) ? 1 : -1;
    const sideOf = index => item.players[index].side, dir = side => side === 'home' ? homeDir : -homeDir, depth = (side, x) => dir(side) === 1 ? x : LENGTH - x;
    const frames = item.frames;
    for (let f = 1; f < frames.length; f++) {
      const a = frames[f - 1], b = frames[f];
      // A pass: the next teammate to have the ball was onside when it was played.
      if (a[3] >= 0 && b[3] < 0) {
        const side = sideOf(a[3]); let g = f; while (g < frames.length && frames[g][3] < 0) g++;
        const receiver = g < frames.length ? frames[g][3] : -1;
        if (receiver >= 0 && receiver !== a[3] && sideOf(receiver) === side && !item.players[receiver].keeper) {
          const defenders = item.players.map((p, i) => i).filter(i => sideOf(i) !== side).map(i => depth(side, a[4 + 2 * i])).sort((x, y) => y - x);
          stats.passes++; if (depth(side, a[4 + 2 * receiver]) > Math.max(defenders[1], depth(side, a[0]), LENGTH / 2) + .5) stats.offside++;
        }
      }
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 3.5) stats.ballJumps++;
      for (let i = 0; i < item.players.length; i++) if (Math.hypot(b[4 + 2 * i] - a[4 + 2 * i], b[5 + 2 * i] - a[5 + 2 * i]) > 1.6) stats.playerJumps++;
    }
    for (const event of item.events) if (/swings it in/.test(event.text)) {
      const frame = frames[Math.min(frames.length - 1, Math.round(event.t / DT))]; stats.corners++;
      if (Math.min(...[[0, 0], [0, WIDTH], [LENGTH, 0], [LENGTH, WIDTH]].map(([x, y]) => Math.hypot(frame[0] - x, frame[1] - y))) > 2.5) stats.badCorners++;
    }
    if (item.plan.kind === 'goal' && item.plan.style !== 'penalty') {
      let f = frames.length - 1; while (f > 0 && !(frames[f][3] >= 0 && sideOf(frames[f][3]) === item.plan.side)) f--;
      const p = frames[f][3], gx = dir(item.plan.side) === 1 ? LENGTH : 0; stats.goals++;
      if (Math.hypot(frames[f][4 + 2 * p] - gx, frames[f][5 + 2 * p] - WIDTH / 2) > (item.plan.style === 'freekick' ? 32 : 26)) stats.far++;
    }
  }
}
assert(stats.passes > 3000 && stats.goals > 400 && stats.corners > 150, JSON.stringify(stats));
assert(stats.offside <= stats.passes / 2000, `Offside receivers: ${JSON.stringify(stats)}`);
assert.equal(stats.far, 0, 'No goals from distance'); assert.equal(stats.badCorners, 0, 'Corners are taken from the flag');
assert.equal(stats.ballJumps, 0, 'The ball never jumps'); assert.equal(stats.playerJumps, 0, 'Players never jump');
// Extra-time goals sit on the clock after 97 (91'–120'), labelled with their real minute.
assert.equal(league.absoluteMinute({ minute: 105, extra: true }), 112); assert.equal(league.minuteLabel({ minute: 105, extra: true }), '105′');
console.log(`Match view passed: ${stats.passes} passes onside (${stats.offside} marginal), ${stats.goals} goals in range, ${stats.corners} corners from the flag, no jumps.`);
