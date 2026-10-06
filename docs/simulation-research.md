# 38-0 simulation research and Touchline league

Researched **3 October 2026** against the actual `38-0.app` game. Search results include several similarly named fan sites; their descriptions were not used as evidence for this engine.

## Primary evidence

- [38-0: How it works](https://38-0.app/how-it-works): describes strength across goalkeeping, defence, midfield and attack, with variable season outcomes.
- [38-0: Season simulator](https://38-0.app/season-simulator): describes its full 38-match campaign.
- [Public rating and position module](https://38-0.app/_next/static/immutable/chunks/0t_d4h73ui0ca.js): exports `naturalRank`, `calcTeamRating` and `calcEffectiveRating`.
- [Public simulation module](https://38-0.app/_next/static/immutable/chunks/0fbgc9mt4pxcs.js): exports `simulateHeadToHead` and `simulateSeason`.
- [Public season model and rulesets](https://38-0.app/_next/static/immutable/chunks/32ijc3bchq1z8.js): season calibration and version handling.
- [Public game screen](https://38-0.app/_next/static/immutable/chunks/0-4me4ia_gso2.js): includes both local simulations and calls to a server-verified simulation service.

The relevant downloaded assets are retained in `data/research/38-0`. `scripts/research-38-0.cjs` loads only the needed rating modules in an isolated context with no network or browser APIs. It records concrete outputs in `data/research/verified-engine.json`.

## What the browser code establishes

There are **two different models**. The season mode selects outcomes against a historical opponent field, calibrates goal totals and generates compatible scores. The head-to-head mode compares two drafted sides directly and plays home and away legs. The latter matches a league made entirely from your managers' XIs.

Position-adjusted strength uses these browser defaults:

| Input | Default |
| --- | --- |
| First natural position | 100% contribution |
| Second natural position | 99% |
| Third or later natural position | 98% |
| Incompatible assignment | 93% |
| Minimum effective individual rating | 40 |
| Attack / midfield / defence / keeper weights | 30% / 30% / 28% / 12% |
| Fullback weighting within defence | 0.6 versus 1 for a centre-back |

The original position order matters. Compatibility has specific rules for central midfield, wingers and wing-backs. CAMs contribute to attack; wing-backs contribute to midfield in back-three formations and defence in back-five formations. Overall strength is rounded after combining the unit averages.

Head-to-head expected goals are:

```
home = clamp(1.35 + 0.05 × (home strength − away strength) + 0.35, 0.2, 4.5)
away = clamp(1.35 + 0.05 × (away strength − home strength),        0.2, 4.5)
```

Each score is a Poisson draw. Equal sides therefore average 1.70 home goals and 1.35 away goals, without a guaranteed winner. Scorer selection favours attacking positions and higher ratings. A stored seed makes a run repeatable.

Goal times follow the same module: 2% of goals fall in first-half added time (45+1 to 45+3) and 4% in second-half added time (90+1 to 90+4); the rest use `ceil(90 × (r / 0.94)^0.82)`. After both teams' goals are drawn, the module separates them so that no two goals in a match share a minute, moving clashes later within 90+4.

Assists come from 38-0's season engine, because its head-to-head mode records only scorers: 28% of goals are unassisted, otherwise a teammate is chosen by role weight × `(rating / 80)^3.5`. Touchline draws assists from a separate seeded stream, so scores, scorers and minutes stay identical to the head-to-head module.

## What Touchline implements

Our own implementation in `src/league-core.js` reproduces the observed position rules, effective team rating and head-to-head expected-goal calculation. It reads the auction's chosen overall/season mode and each manager's actual pitch arrangement. Prices affect budgets and awards, not match strength.

League-specific decisions:

- A circle schedule pairs every manager with every opponent twice, once at home and once away. Odd team counts include rest days. Three managers have six matches, four matches per team and six matchdays.
- A unique seed per fixture prevents navigation or a reload from changing scores. Saves store the seed, completed rounds, engine version and starting boards; restoration reconstructs the played fixtures.
- The league starts only after every manager has placed eleven owned players. Starting locks those XIs and the auction's final sale. Out-of-position assignments remain allowed and receive the observed contribution penalty.
- Three points for a win, one for a draw. Standings use points, goal difference and goals scored. Teams equal on all three share a final rank; a complete tie at the top produces shared champions.
- Goal times and the round-by-round interface are our presentation. Timing is approximate. The sequence of scorer draws and fixture seeds differs from 38-0's two-leg interface, so identical teams need not produce identical complete match reports.
- Best bargain uses an auction-relative estimate: total money spent is distributed across signings in proportion to `(rating / 80)^4`; the largest estimated saving wins. This is our award heuristic, not a real-world valuation or a claim about 38-0's awards.

## Verification and limits

`node scripts/test-league.cjs` checks position-rule parity over 2,744 role combinations, rating parity for all twenty formations in both rating modes, score parity with the reference head-to-head function for 640 first-leg cases, and complete match-report parity (scorers, minutes and added time) for 900 matches between drafted XIs, using the module's own goal-time, scorer and minute-separation helpers. Ten thousand equal-strength matches verify the expected home/away goal averages; another ten thousand strength-mismatched matches confirm that stronger teams win more often while upsets remain possible. Scheduling and save/restore checks cover every manager count from two to eight.

This verifies the downloaded browser defaults, not every private server setting or future engine release. No undisclosed chemistry, pace, shooting, injuries, fitness or tactical attributes are invented. The data already present in our game contains overall ratings, season ratings and ordered positions, which are sufficient for this verified head-to-head model. Public source assets are research references; the HTML bundles our independently written league module.

## Premier League mode

38-0's season mode, read from its season-model and simulation modules, plays only the user's team: 38 matches against a fixed field of 19 Premier League clubs (Manchester City 88, Arsenal 86, Liverpool 86, Chelsea 84, Manchester United 84, Tottenham 83, Newcastle 82, Aston Villa 81, Brighton 80, West Ham 79, Crystal Palace 78, Everton/Leeds/Wolves/Brentford/Fulham 77, Bournemouth/Nottingham Forest 76, Burnley 74; Leicester City 78 stands in when the user's club is in the field). Each result is drawn first: expected season points come from a linear fit of points on overall across 480 historical club-seasons (intercept -219.30, slope 3.488, softened below 68 overall), giving a base win and draw probability; each fixture adjusts the win probability by -0.035 per point of opponent strength above 80 and ±0.05 for home or away, capped at 0.92. The scoreline is then drawn to fit the result, with season goal totals from the team's overall, attack and defence, calibrated over the season. About 12% of goals use an alternate scorer table that ignores rating. The other clubs' points are sampled from their historical profiles rather than played.

Touchline's Premier League mode places the managers' XIs in a 20-team league with the strongest clubs from that field. Manager v club fixtures use the season engine above, unchanged except that a manager plays fewer than 38 club fixtures, so the season goal totals are scaled to the number played. Manager v manager fixtures use the head-to-head engine and play live. Because a live league table needs results between the clubs, club v club fixtures use the head-to-head model with the clubs' strengths; this is Touchline's addition. Clubs field their latest squad from the player data, excluding drafted players, so their scorers are real players rather than 38-0's generic surnames. A check over 300 seasons per overall reproduces 38-0's own expected points (42.3, 59.3, 76.7 and 94.6 for 75, 80, 85 and 90 overall).
