// Extract the English roster from the public browser assets saved in data/source.
// Usage: node scripts/extract-38-0.cjs
// No network requests are made by this script.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const sourceDir = path.join(root, 'data', 'source');
const outputDir = path.join(root, 'data', '38-0');
fs.mkdirSync(outputDir, { recursive: true });
const files = fs.readdirSync(sourceDir).filter(name => name.endsWith('.js'));
const sources = files.map(name => ({ name, text: fs.readFileSync(path.join(sourceDir, name), 'utf8') }));
const playerSource = sources.find(file => file.text.includes('packed player blob is v'));
assert(playerSource, 'English packed player asset was not found.');
const blobs = [...playerSource.text.matchAll(/"(eyJ2Ijo[A-Za-z0-9+/=]+)"/g)];
assert.equal(blobs.length, 1, 'Expected one English player blob.');
const packed = JSON.parse(Buffer.from(blobs[0][1], 'base64').toString('utf8'));
assert.equal(packed.v, 3);
const positions = ['GK', 'LB', 'CB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'ST'];

function rating(stored, key) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x1000193) >>> 0;
  }
  return stored ^ (hash & 127);
}

const players = packed.p.map(([id, name, nation, positionIndexes, peak, seasons]) => ({
  id,
  name,
  nationality: packed.nations[nation],
  positions: positionIndexes.map(index => positions[index]),
  peakRating: rating(peak, id),
  clubSeasons: seasons.map(([clubIndex, seasonIndex, storedRating, squadOnly]) => {
    const clubId = packed.clubs[clubIndex];
    const season = packed.seasons[seasonIndex];
    return { clubId, season, seasonRating: rating(storedRating, `${id}|${clubId}|${season}`), squadOnly: !!squadOnly };
  }),
}));

// Independently compare our extraction with the game's own exported decoder
// and rating functions, run in an isolated VM without filesystem/network APIs.
const context = vm.createContext({ TURBOPACK: [], Buffer, TextDecoder, Uint8Array });
new vm.Script(playerSource.text).runInContext(context, { timeout: 3000 });
const clubSource = sources.find(file => /665873,[a-z]+=>/.test(file.text));
assert(clubSource, 'English club asset was not found.');
new vm.Script(clubSource.text).runInContext(context, { timeout: 3000 });
const factories = new Map();
for (const chunk of context.TURBOPACK) {
  let pending = [];
  for (const entry of chunk.slice(1)) {
    if (typeof entry === 'number') pending.push(entry);
    else if (typeof entry === 'function') {
      for (const id of pending) factories.set(id, entry);
      pending = [];
    }
  }
}
const modules = new Map([[467034, { Buffer }], [13898, {}]]);
function load(id) {
  if (modules.has(id)) return modules.get(id);
  const factory = factories.get(id);
  assert(factory, `Missing required source module ${id}.`);
  const exports = {};
  modules.set(id, exports);
  factory({ i: load, s: entries => {
    for (let i = 0; i < entries.length; i += 3) {
      assert.equal(entries[i + 1], 0, 'Unexpected export format.');
      exports[entries[i]] = entries[i + 2];
    }
  } });
  return exports;
}
const game = load(157485);
const clubs = JSON.parse(JSON.stringify(load(665873).PREMIER_LEAGUE_CLUBS));
const clubById = new Map(clubs.map(club => [club.id, club]));
assert.equal(game.PLAYERS.length, players.length);
const uniqueIds = new Set();
const uniqueRecords = new Set();
const rows = [];
const coverage = new Map();
const sourceAnomalies = [];
for (let index = 0; index < players.length; index++) {
  const player = players[index];
  const original = game.PLAYERS[index];
  assert(!uniqueIds.has(player.id), `Duplicate player ID ${player.id}.`);
  uniqueIds.add(player.id);
  assert.equal(player.id, original.id);
  assert.equal(player.name, original.name);
  assert.equal(player.nationality, original.nationality);
  assert.equal(JSON.stringify(player.positions), JSON.stringify(original.positions));
  assert.equal(player.peakRating, original.overall);
  assert.equal(player.clubSeasons.length, original.clubSeasons.length);
  assert(player.positions.length && player.positions.every(position => positions.includes(position)));
  assert(Number.isInteger(player.peakRating) && player.peakRating >= 0 && player.peakRating <= 99);
  for (const season of player.clubSeasons) {
    const key = `${player.id}|${season.clubId}|${season.season}`;
    assert(!uniqueRecords.has(key), `Duplicate club-season record ${key}.`);
    uniqueRecords.add(key);
    const club = clubById.get(season.clubId);
    assert(club, `Unknown club ${season.clubId}.`);
    const selectableClubSeason = club.seasons.includes(season.season);
    if (!selectableClubSeason) sourceAnomalies.push({ playerId: player.id, name: player.name,
      clubId: season.clubId, season: season.season, reason: 'Present in player data but absent from the club wheel season list' });
    assert.equal(season.seasonRating, game.effectiveOverall(original, season.clubId, season.season, 'season'));
    assert.equal(player.peakRating, game.effectiveOverall(original, season.clubId, season.season, 'peak'));
    const originalSeason = original.clubSeasons.find(item => item.club === season.clubId && item.season === season.season);
    assert.equal(season.squadOnly, !!originalSeason.squadOnly);
    assert(Number.isInteger(season.seasonRating) && season.seasonRating >= 0 && season.seasonRating <= 99);
    const coverageKey = `${season.clubId}|${season.season}`;
    coverage.set(coverageKey, (coverage.get(coverageKey) || 0) + 1);
    rows.push({ playerId: player.id, name: player.name, nationality: player.nationality,
      positions: player.positions.join('|'), clubId: club.id, clubName: club.name,
      season: season.season, seasonRating: season.seasonRating, peakRating: player.peakRating,
      squadOnly: season.squadOnly, selectableClubSeason });
  }
}
const clubSeasonRows = clubs.flatMap(club => club.seasons.map(season => ({
  clubId: club.id, clubName: club.name, season, playerCount: coverage.get(`${club.id}|${season}`) || 0,
}))).sort((a, b) => a.clubName.localeCompare(b.clubName) || a.season.localeCompare(b.season));
assert(clubSeasonRows.every(row => row.playerCount > 0), 'At least one selectable club season has no players.');

const writeJson = (name, data) => fs.writeFileSync(path.join(outputDir, name), JSON.stringify(data, null, 2) + '\n');
const csvValue = value => '"' + String(value).replaceAll('"', '""') + '"';
function writeCsv(name, data) {
  const columns = Object.keys(data[0]);
  const csv = [columns.map(csvValue).join(','), ...data.map(row => columns.map(column => csvValue(row[column])).join(','))].join('\r\n');
  fs.writeFileSync(path.join(outputDir, name), '\ufeff' + csv + '\r\n');
}
writeJson('players.json', players);
writeJson('clubs.json', clubs);
writeCsv('player-seasons.csv', rows);
writeCsv('players.csv', players.map(player => ({ playerId: player.id, name: player.name,
  nationality: player.nationality, positions: player.positions.join('|'), peakRating: player.peakRating,
  clubSeasonCount: player.clubSeasons.length })));
writeCsv('club-season-coverage.csv', clubSeasonRows);
writeJson('source-anomalies.json', sourceAnomalies);
fs.writeFileSync(path.join(outputDir, 'players.js'),
  '/* English player snapshot from https://38-0.app/game; see README.md and manifest.json. */\n' +
  'globalThis.DRAFT_GAME_DATA = ' + JSON.stringify({ players, clubs }) + ';\n');

const seasons = [...new Set(rows.map(row => row.season))].sort();
const manifest = {
  source: 'https://38-0.app/game?new=true', scope: 'Main English league game only',
  snapshotDate: '2026-10-02', generatedAtUtc: new Date().toISOString(), packedVersion: packed.v,
  sources: [playerSource, clubSource].map(file => ({
    file: file.name, url: `https://38-0.app/_next/static/immutable/chunks/${file.name}`,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(sourceDir, file.name))).digest('hex'),
  })),
  counts: { players: players.length, playerClubSeasons: rows.length, clubs: clubs.length,
    seasons: seasons.length, clubSeasons: clubSeasonRows.length, squadOnlyRecords: rows.filter(row => row.squadOnly).length,
    recordsOutsideSelectableClubSeasons: sourceAnomalies.length },
  seasonRange: [seasons[0], seasons.at(-1)],
  ratingRanges: { peak: [Math.min(...players.map(player => player.peakRating)), Math.max(...players.map(player => player.peakRating))],
    season: [Math.min(...rows.map(row => row.seasonRating)), Math.max(...rows.map(row => row.seasonRating))] },
  validation: { matchedGameDecoder: true, matchedEverySeasonRating: true, matchedEveryPeakRating: true,
    uniquePlayerIds: true, uniquePlayerClubSeasonKeys: true, allSelectableClubSeasonsCovered: true },
  notes: [
    'Complete snapshot of the English PLAYERS array bundled with the public game on the snapshot date; not a claim of historical or future completeness.',
    'Season mode uses the club-season rating; peak mode uses the player-level overall rating.',
    'Positions are player-level in this source blob. squadOnly is a source flag, not an exclusion from the draft roster.',
    'The source website describes these as its own independent ratings, not official EA/FIFA ratings.',
    'Source terms restrict automated extraction and database reuse without permission; possession of this snapshot does not establish a reuse licence.',
  ],
};
writeJson('manifest.json', manifest);
console.log(JSON.stringify(manifest, null, 2));
console.log('\nExample: ' + JSON.stringify(players.find(player => player.name === 'Thierry Henry'), null, 2));
