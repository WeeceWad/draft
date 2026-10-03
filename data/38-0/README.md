# 38-0 English player and rating snapshot

Sourced from the public browser assets loaded by https://38-0.app/game?new=true on **2 October 2026**. Scope: the main English league game, as requested.

## Coverage

| Measure | Count |
| --- | ---: |
| Unique player IDs | 4,854 |
| Player / club / season records | 18,522 |
| Clubs | 51 |
| Seasons | 35 |
| Selectable club / season combinations | 706 |
| Records carrying the source's `squadOnly` flag | 22 |
| Records outside the selectable club / season list | 3 |

Season range: **1992/93–2026/27**. Ratings in this snapshot range from **40 to 95**.

This is the complete English `PLAYERS` array bundled with the public game at the time of retrieval. It does not include Spanish league or tournament rosters. It is a dated snapshot and will not automatically update with the live game.

## Files

- `players.json`: full player records, positions, nationality, peak rating, and every club-season rating. Recommended input for building the game.
- `player-seasons.csv`: one row per player / club / season, with both ratings, club name, positions, and source flags. Recommended for reviewing all season ratings.
- `players.csv`: one row per player with peak rating and club-season count.
- `players.js`: the full players and clubs assigned to `globalThis.DRAFT_GAME_DATA`, suitable for a local HTML page without a web server.
- `clubs.json`: the game's English club list, including its selectable seasons.
- `club-season-coverage.csv`: record counts for every selectable club / season.
- `source-anomalies.json`: the three source entries outside the selectable club-season list. They remain in the full dataset.
- `manifest.json`: source asset URLs, SHA-256 hashes, counts, and verification results.

## Rating meanings

`peakRating` is the game's player-level `overall`, used by its **peak / prime ratings** setting.

`seasonRating` is the game's `overall` for the specified club and season, used by its **season ratings** setting. For example, Thierry Henry's Arsenal 2003/04 rating is 95; his Arsenal 2011/12 rating is 83; his peak rating is 95.

The source describes its ratings as an independent interpretation based on publicly available data. These are 38-0's values, not a claim that they are official EA/FIFA ratings.

## Source flags and anomalies

`squadOnly` is retained exactly from the source. The game includes these entries in its club-season player lookup; the flag should not automatically exclude them from drafting. It is used in some career / appearance filters.

`selectableClubSeason` in the season CSV tells you whether the record's club and season appear in the game's club-wheel list. Three source records have `false`. They were retained rather than silently changed or removed.

Positions are player-level in this packed data; no separate season-specific positions are supplied. IDs are source identifiers, sometimes numeric strings and sometimes names. Preserve IDs as strings and use them to identify players.

## Verification and reproduction

From the project folder, run:

```powershell
node scripts/extract-38-0.cjs
```

The script makes no network requests. It reads the saved public assets in `data/source`, extracts the packed roster, and independently compares it with the game's own decoder and rating functions in an isolated JavaScript VM. Every player, position list, nationality, peak rating, season rating, and squad-only flag is checked. Player IDs and player / club / season keys are unique, and all 706 selectable club-season combinations have player data.

CSV files use UTF-8 with a BOM for accented names. JSON and JavaScript use UTF-8. For an HTML page opened directly from disk, use `<script src="data/38-0/players.js"></script>` and read `globalThis.DRAFT_GAME_DATA.players`. The data can also be embedded in a single HTML file later.

## Reuse terms

The site's [Terms of Use](https://38-0.app/terms) explicitly restrict automated extraction and substantial database reuse without permission. This snapshot does not grant a licence to reuse or publish their database. Obtain permission from 38-0 before using these exact ratings and records in a published game.
