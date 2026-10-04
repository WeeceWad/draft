# Put Touchline online with Render

The online version is ready to deploy. Render runs both the HTML game and its Node server. PostgreSQL stores rooms, manager identities, bids, budgets, lineups and league results. No Firebase setup is needed.

## What you need to do

1. Create a **private GitHub repository** for this project. Upload the project files, preserving the `src`, `server`, `scripts`, `docs` and `data/38-0` folders. Include `package.json`, `package-lock.json` and `render.yaml` at the repository root. Do not upload `node_modules`, `.env`, `.test-data` or screenshots. If using GitHub's web upload, enable hidden files in Windows Explorer so you can also upload `.gitignore`. The generated `public` folder is rebuilt by Render.
2. Sign into [Render](https://dashboard.render.com/), choose **New → Blueprint**, connect GitHub and select your repository. Render reads `render.yaml` and proposes a Node web service called `touchline-auction` and a PostgreSQL database called `touchline-db` in Frankfurt.
3. Check that both the web service and database show the **Free** compute plan, then deploy. The Blueprint now requests free plans. You do not need to enter database credentials: Render supplies `DATABASE_URL` from the linked database. The app creates its tables automatically. If your setup page still shows a paid plan, go back and start the Blueprint setup again so Render reads the latest commit.
4. Open the web service's public **HTTPS URL** when it shows **Live**. Create a room, share the URL/code with friends, and have everyone join from their own device. Each participant presses **I'm ready**; the host starts the auction.

The build installs packages, builds the HTML and runs the automated server/database tests. The start command is `npm start`; the health endpoint is `/health`. Keep this a **Web Service**, because multiplayer needs the Node server and WebSockets. [Render's Node guide](https://render.com/docs/deploy-node-express-app) and [Blueprint reference](https://render.com/docs/blueprint-spec) cover these settings.

Both resources use `plan: free`. This is a free trial deployment with useful limits: the web service sleeps after 15 minutes without traffic and can take around a minute to wake; free PostgreSQL expires after 30 days. The app cannot function after the database expires until a working database is connected. Only one free PostgreSQL database can be active per Render workspace. See [Render's free plan limits](https://render.com/docs/free). A permanent database would need a separate hosting decision before the trial ends; this configuration does not automatically upgrade you to a paid plan.

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

- Host selects 2–8 managers, formation (or **Free**, where each manager picks their own formation on the Teams screen until the league starts), peak/season rating mode, season range and rating range. The host can change any of these in the lobby under **Room rules**; saving new rules asks everyone to ready up again. The rules lock when the auction starts.
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
- After the auction, bargains, big spends and team comparisons appear. When every XI is filled, the host starts the home-and-away league; lineups then lock. The host kicks off each matchday and everyone is taken to the League tab to watch it live: the match clock, including added time, runs over 18 seconds and goals appear at their minute with their assist. The host can switch to the **pitch view (beta)**, modelled on Football Manager's 2D highlights: each goal and several chances play as a highlight at near real speed, with players moving as a team shape that steps up and drops with the ball, pressing and covering, runs into the box, build-up passes, crosses, through balls, shots, saves, goal kicks, corners and throw-ins. Every real goal is scored by its real scorer from its real assister at its real minute; the clock fast-forwards between highlights. Pitch-view matchdays take about 2½ minutes; with several games on a matchday, each viewer picks which one to watch. The table updates at full time. Each result lists the scorers under their own team with the minute.
- At the end of the season everyone sees a summary: champions, final table, goals, biggest win, golden boot, and how every team did. **Play again** opens a fresh lobby with a new code and the same rules, and everyone still in the room is moved into it automatically. **Leave the room** returns home.

## Reconnect, hosting and persistence

Rooms last **24 hours**. Refreshing or reopening in the same browser restores your room and identity. You can also return home and rejoin with the same code. Anonymous identities are saved in an HttpOnly cookie for 30 days. Clearing cookies or changing devices creates a different identity; there is no account login or cross-device recovery in this version.

The lobby host can remove a manager. Host controls can be handed to another room member under **Room options**. If the host disconnects, active bids still settle; the host can reconnect to continue revealing players, or should hand over controls before leaving.

The server validates every action, serializes conflicting room changes with database row locks, and checks auction deadlines when processing bids. PostgreSQL notifications broadcast room changes to connected devices. Absolute deadlines survive restarts; overdue auctions settle on startup. The live connection reconnects automatically after interruptions. [Render supports inbound WebSockets on web services](https://render.com/docs/websocket).

To release updates, push source changes to the connected repository; Render rebuilds the app. Keep the database and the same public domain to retain browser identities. Do not delete the database between releases.

## Verification

```powershell
npm run build
npm test
npm run test:browser
```

`npm test` covers pool balance, auction rules, authorization, simultaneous bids, WebSocket updates and PostgreSQL SQL/persistence using PGlite. It is suitable for the Render build. The browser suite uses Playwright and Edge; `DRAFT_BROWSER_PACKAGES` can point at another installed Playwright package location. Browser checks cover three isolated managers, reload/rejoin, bid input preservation, read-only opponent pitches, ratings, mobile widths and a complete shared league.

Database tests run PostgreSQL compiled to WebAssembly locally. A real Render deploy, network latency and real phones still need a smoke test after your account provisions the service. No Render account or public URL has been configured from this workspace yet.
