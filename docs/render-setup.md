# Put Touchline online with Render

The online version is ready to deploy. Render runs both the HTML game and its Node server. PostgreSQL stores rooms, manager identities, bids, budgets, lineups and league results. No Firebase setup is needed.

## What you need to do

1. Create a **private GitHub repository** for this project. Upload the project files, preserving the `src`, `server`, `scripts`, `docs` and `data/38-0` folders. Include `package.json`, `package-lock.json` and `render.yaml` at the repository root. Do not upload `node_modules`, `.env`, `.test-data` or screenshots. If using GitHub's web upload, enable hidden files in Windows Explorer so you can also upload `.gitignore`. The generated `public` folder is rebuilt by Render.
2. Create a free PostgreSQL database at [Neon](https://neon.tech) (its free plan does not expire). Open the project, click **Connect**, and copy the connection string that starts with `postgresql://`.
3. Sign into [Render](https://dashboard.render.com/), choose **New → Blueprint**, connect GitHub and select your repository. Render reads `render.yaml` and proposes a free Node web service called `touchline-auction`. When it asks for `DATABASE_URL`, paste the Neon connection string, then deploy. The app creates its tables automatically.
4. Open the web service's public **HTTPS URL** when it shows **Live**. Create a room, share the URL/code with friends, and have everyone join from their own device. Each participant presses **I'm ready**; the host starts the auction.

The build installs packages, builds the HTML and runs the automated server/database tests. The start command is `npm start`; the health endpoint is `/health`. Keep this a **Web Service**, because multiplayer needs the Node server and WebSockets. [Render's Node guide](https://render.com/docs/deploy-node-express-app) and [Blueprint reference](https://render.com/docs/blueprint-spec) cover these settings.

The web service uses Render's free plan: it never expires, but it sleeps after 15 minutes without traffic and can take around a minute to wake. Neon's free database also pauses when idle and wakes in about a second. Render's own free PostgreSQL is not used because it expires 30 days after creation. See [Render's free plan limits](https://render.com/docs/free) and [Neon's pricing](https://neon.tech/pricing).

## Try it on this computer

From this project folder, run:

```powershell
npm install
npm run build
npm start
```

Open [http://localhost:4174](http://localhost:4174). You can test multiple managers in different browser profiles or private browsing sessions. Tabs within the same profile share an identity, so use separate profiles for separate managers.

Local development without `DATABASE_URL` keeps rooms in memory; restarting the local server clears them. The Render deployment always requires PostgreSQL and saves rooms across restarts. To test against your own database locally:

```powershell
$env:DATABASE_URL = 'postgresql://user:password@localhost:5432/touchline'
npm start
```

The hosted game is at `/`, and the original shared-device game is at `/offline.html`. The original `index.html` remains an offline standalone file. `online.html` is generated for reference; open the online version through its server URL.

## Online auction rules

- **Kit colours**: each manager picks one of twelve kit colours in the lobby. A colour is locked once chosen and nobody else can take it; anyone who has not picked gets the first free colour when the auction starts. The twelve colours are all clearly distinct from each other. In the Premier League, a club whose kit would clash with a manager's changes to its alternate kit, and keepers always wear a colour that clashes with neither side.
- **Late-bid protection**: every bid adds 10 seconds, and a bid in the final seconds always leaves at least 15 to answer it. Everyone sees a "late bid" notice when it happens.
- **Player form** (Room rules switch, Touchline's own rule): each match gives a player a score around 6 (a goal +1, an assist +0.6, a win +0.4 or a loss -0.4, and for keepers and defenders a clean sheet +0.6 or three conceded -0.5). Form is the weighted average of the last five matches, from 3 to 10, shown as a badge on the Teams screen and at half-time. Every point above or below 6 moves a player's rating by 0.8 in matches, so out-of-form players are worth dropping or subbing off.
- **FA Cup** (Room rules switch): a seeded knockout draw played between league matchdays. In "Just us" the managers enter (with byes when the numbers are uneven); in the Premier League the strongest clubs join to make sixteen. Ties are one game, then 30 minutes of extra time, then a penalty shoot-out (five each, then sudden death; better takers and weaker keepers mean more goals). The final is at a neutral venue. Every tie with a manager in it plays live (including a manager against a club): a level tie carries on into extra time on the same clock (91′–120′), then the shoot-out is revealed kick by kick. Afterwards the cup round leads the League page as the latest results, and the Cup tab shows the bracket.
- **Champions League** (Room rules switch): 38-0's "European Nights", in the form 38-0 uses for drafted XIs, played alongside the league. The field is 38-0's 2026/27 European field of 36 clubs (Real Madrid, Bayern, Barcelona, PSG, Inter…); managers take the English places from the lowest seed up (then the smallest clubs), the remaining English clubs play with their real latest squads from our data, and the others field 38-0's generic line-up. As in 38-0, ratings are pulled 30% towards 80, the clubs play 4 below their listed strength, and the pots are re-ranked by strength. The draw gives every team one home and one away game against each pot (eight games, managers never against their own association); the eight league-phase nights are spread through the season. 1st–8th go straight to the last 16, 9th–24th play a two-legged knockout play-off (9th–16th seeded against 17th–24th), and 25th–36th are out. The last 16 (with 38-0's small edge for the top seeds), quarter-finals and semi-finals are two legs, the lower seed at home first, with extra time and penalties in the second leg if the aggregate is level; the final is one game at a neutral venue. Matches use 38-0's tournament model: win and draw odds from expected points, then goals. Every European game with a manager in it plays live, and the ⭐ UCL tab shows your nights, the 36-team table and the knockout bracket.
- **January transfer window** (Room rules switch): at the season's halfway point the host opens the window. Two new players per manager, drawn from the best eligible players not already in the game, go up for auction with no squad limit, so a manager who has saved money can sign them all. Unsold players are released. Managers then place their signings, and the new XIs play from the host's restart.
- **Substitutes** (a Room rules switch, Touchline's own rules since 38-0 has no substitutions): every manager buys 16 players, an XI plus five random outfield substitutes (still one keeper per squad). The bench shows under the pitch on the Teams screen. In manager v manager games each half is simulated separately with half the expected goals. The first half plays live, then half-time shows each manager their XI in their formation with each player's stamina: tap two players to swap positions, or a player and a substitute to make a change (up to five), then mark ready; the host kicks off the second half. The second half is played, and shown on the pitch view, with the XI the manager sent out, and each result lists the changes (▲ on, ▼ off). Stamina after a first half depends on the role (keepers about 97%, centre-backs 88%, central midfielders 83%, wide players and full-backs about 80%) plus a fixed per-player constitution of ±4, and each missing point costs 0.3% of a player's rating. Substitutes are fresh. Instantly simulated matchdays make up to three sensible changes automatically.
- **League format**: "Just us" (managers play each other home and away) or **Premier League** (the managers join 38-0's clubs in a 20-team, 38-matchday season; games against clubs are instant, manager v manager games play live, and the host can skip ahead to the next manager match).
- Host selects 2–8 managers, formation (or **Free**, where each manager picks their own formation on the Teams screen until the league starts), peak/season rating mode, season range and rating range. The host can change any of these in the lobby under **Room rules**; changes save automatically half a second after the last edit (shown as "Saved ✓") and ask everyone to ready up again. The rules lock when the auction starts.
- Squad lists are grouped by main position: goalkeeper, defence, midfield, attack.
- **Dev mode** (a Room rules switch, for testing): starting skips the auction. Every manager gets a full XI from the balanced pool, each player placed in a position they play, with a nominal fee by rating. Everyone lands on the League tab ready to start.
- The server picks 11 unique players per manager, using the existing balanced pool logic. Future player identities and the selected remaining pool never appear in client snapshots.
- The host spins the mystery wheel to reveal each player. Bidding opens after the reveal animation.
- The first accepted bid starts a 60-second countdown. Every subsequent accepted bid adds 10 seconds to the current deadline, including a higher bid by the leader. Bids must exceed the highest active bid and stay within the bidder's budget. Bids are whole millions from £1m. A £0 bid is only accepted from a manager with no money left once everyone else has backed out. After each new bid, everyone's bid box moves to £1m above it.
- **The highest bidder is locked in**: they cannot back out or raise their own bid until someone outbids them. Anyone else, including a manager who has been outbid, can **Back out**; it is final for that player. A manager can bid again on the next player.
- **One goalkeeper per XI.** A manager who owns a goalkeeper sits out other goalkeepers, and a manager without one keeps their last spot for a goalkeeper.
- When only one eligible manager remains and has a bid, they win immediately at that bid. Otherwise, expiry awards the player to the highest active bidder. With no active bidder, the player joins the skipped-player queue. All new players appear before that queue returns in skip order, with bidding in the same auction panel. Skipping a returning player again puts them at the end of the queue. The Auction screen shows the queue for every manager. Only the host can skip a player with no bids.
- Full squads cannot bid. Disconnecting or closing the browser does **not** cancel a bid; server timers continue. Each manager can own at most 11 players and starts with £1bn.
- Managers arrange their own XI: tap a position, then choose a player for it, or drag players onto the pitch and between positions to swap them. Dragging a player back to the squad list takes them off; **Clear the pitch** removes everyone. Position colours show goalkeeper, defence, midfield and attack. Managers place and swap their own players freely; everyone can view other XIs and the transfer board. Only the host can show or hide ratings, and the choice applies to everyone in the room.
- Sound effects play for the spinning wheel, every bid and each signing. The **Sound** button in the header mutes them on that device.
- Once the league starts the Auction tab disappears (it only returns for the January window's auction), and the League tab comes first.
- After the auction, bargains, big spends and team comparisons appear. When every XI is filled, the host starts the home-and-away league; lineups then lock. The host kicks off each matchday and everyone is taken to the League tab to watch it live: the match clock, including added time, runs over 18 seconds and goals appear at their minute with their assist. The host can switch to the **pitch view (beta)**, modelled on Football Manager's 2D highlights: each goal and several chances play as a highlight at near real speed, with players moving as a team shape that steps up and drops with the ball, pressing and covering, runs into the box, build-up passes, crosses, through balls, shots, saves, goal kicks, corners and throw-ins. Moves are built patiently with short and medium passes into open lanes (about 19 metres on average, few long balls or flank-to-flank switches), the odd carry and one-two, and play through the middle in the final third; central players tend to slide a through ball, wide players cross or cut it back along the ground, and most goal kicks are played short. Attackers hold the offside line (the second-last defender, the ball or halfway) until the pass is played, receivers run onto the ball rather than it jumping to them, open-play shots come from inside about 22 metres after the shooter carries the ball into range, and set pieces are taken from the right place: the ball is rolled to the corner flag, penalty spot, goal-kick spot or touchline and the taker walks over to it. Every real goal is scored by its real scorer from its real assister at its real minute; the clock fast-forwards between highlights. Pitch-view matchdays take about 2½ minutes; with several games on a matchday, each viewer picks which one to watch. The table updates at full time. Each result lists the scorers under their own team with the minute.
- At the end of the season everyone sees a summary: champions, final table, goals, biggest win, golden boot, and how every team did. **Play again** opens a fresh lobby with a new code and the same rules, and everyone still in the room is moved into it automatically. **Leave the room** returns home.

## Reconnect, hosting and persistence

Rooms last **24 hours**. Refreshing or reopening in the same browser restores your room and identity. You can also return home and rejoin with the same code. Anonymous identities are saved in an HttpOnly cookie for 30 days. Clearing cookies or changing devices creates a different identity; there is no account login or cross-device recovery in this version.

The lobby host can remove a manager. Host controls can be handed to another room member under **Room options**. If the host disconnects, active bids still settle; the host can reconnect to continue revealing players, or should hand over controls before leaving.

The server validates every action, serializes conflicting room changes with database row locks, and checks auction deadlines when processing bids. PostgreSQL notifications broadcast room changes to connected devices. Absolute deadlines survive restarts; overdue auctions settle on startup. The live connection reconnects automatically after interruptions. [Render supports inbound WebSockets on web services](https://render.com/docs/websocket).

To release updates, push source changes to the connected repository; Render rebuilds the app. Keep the Neon database and the same public domain to retain browser identities.

## Verification

```powershell
npm run build
npm test
npm run test:browser
```

`npm test` covers pool balance, auction rules, authorization, simultaneous bids, WebSocket updates and PostgreSQL SQL/persistence using PGlite. It is suitable for the Render build. The browser suite uses Playwright and Edge; `DRAFT_BROWSER_PACKAGES` can point at another installed Playwright package location. Browser checks cover three isolated managers, reload/rejoin, bid input preservation, read-only opponent pitches, ratings, mobile widths and a complete shared league.

Database tests run PostgreSQL compiled to WebAssembly locally. A real Render deploy, network latency and real phones still need a smoke test after your account provisions the service. No Render account or public URL has been configured from this workspace yet.
