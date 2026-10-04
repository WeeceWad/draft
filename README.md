# Touchline — Auction Night

**Online multiplayer is now available.** Run `npm install`, `npm run build`, then `npm start`, and open **http://localhost:4174**. Hosts create rooms with a four-digit code; each manager joins from their own browser/device and bids live. See [the Render setup guide](docs/render-setup.md) to put it online with a persistent PostgreSQL database. The original offline version remains below.

Open **index.html** in a browser. The whole game, player data, styles and scripts are embedded in this one HTML file. It works offline with no installation or server required.

## Play together

1. Choose **2–8 managers**, enter their names, and choose a formation, rating mode, season range and rating range. Everyone starts with **£1bn**.
2. Press **Start auction**. The game randomly chooses **11 unique footballers per manager** from your eligible pool. Three managers means 33 players, including exactly three goalkeepers.
3. **Spin for a player**. The mystery wheel hides every player until the spin finishes. Bid out loud with your group, choose the winning manager, enter the price in whole millions, then confirm the sale. The budget updates immediately.
4. Open **Teams** or **Place on team pitch**. Tap one of your bought players, then any pitch position. Tap a placed player to move or swap them. Desktop drag-and-drop also works. Prices appear on the pitch and in your player list.
5. Return to **Auction** and reveal the next player. Once every player is sold, review all the teams and the **Transfers** list, ordered from highest to lowest price with each buyer shown.
6. Open **League** for **Bargains & big spends** and a comparison of everyone's XI. Use **Auto-place XI** in Teams if you want a starting arrangement, then adjust it freely.
7. When all XIs are filled, press **Start the league**. Teams lock for the competition. Play each matchday, or play all remaining matches, with scores, scorers and a league table. Everyone plays each opponent home and away. Three managers means six matches and four games per team.

The standalone `index.html` is a shared-device game for an in-person group. Its bidding happens verbally; one person records the final buyer and price. Use the Node-hosted online version for synchronized bidding on separate devices.

## Game rules

- Each manager can buy at most 11 players. Nobody can spend more than their remaining budget.
- Prices are whole millions; £0 is allowed for a free transfer. Money is stored as integer millions to avoid rounding errors.
- **Pass** queues an unsold player at the end of the cycle. Every new player appears before skipped players return, in skip order. The Auction screen shows the skipped-player list. Passing a returning player again moves them to the end of that list.
- **Undo this sale** refunds the latest purchase and reopens that player's bidding. It is available until you spin again, including after the final sale.
- All players are unique by player ID, even in season mode. In season mode the game chooses one eligible club-season per selected player.
- The balanced pool covers every position in the chosen formation for every manager. It uses matching to account for versatile players and includes exactly one goalkeeper per manager. Settings that cannot produce a complete balanced pool are blocked.
- Pool balance guarantees enough positions across the group. Managers decide who buys each player, so the auction does not guarantee that every individual team buys the right positions.
- Positioning is free: players can go anywhere on their owner's board. Players outside their listed positions are marked **Out of position**. Moving a player does not change their owner, purchase price or budget.
- A player moved onto an occupied spot swaps with the existing player if both are already placed. If the selected player was unplaced, the displaced player returns to the owned-player list.
- **Show ratings** toggles the player card, team ratings and transfers. It is a display preference and does not change the eligible pool.
- Manager count, formation, rating mode, season range and rating range are locked for the auction. **New game** opens setup; pressing Start creates a fresh auction. Resume keeps the saved auction's original rules.
- Starting the league locks the XIs and final sale so the saved results remain consistent. All matchdays save automatically; resuming preserves every score.
- League points are 3 for a win and 1 for a draw, sorted by points, goal difference and goals scored. Teams fully tied share a rank and, if tied at the top, the championship.
- Simulation follows the researched 38-0 head-to-head browser model, using position-adjusted overall/season ratings, home advantage and random goals. The detailed evidence, formulas, adaptations and limits are in [`docs/simulation-research.md`](docs/simulation-research.md).
- Sound effects play for the spinning wheel and each sale. The **Sound** switch turns them off on this device.
- Choose from 20 formations, including narrow and wide diamonds, attacking and flat 4-3-3, back-three and back-five systems. Pitch positions follow each shape: CDMs sit deeper, CAMs sit nearer the forwards, and wing-backs sit ahead of the centre-backs.

## Save and resume

The game saves to browser storage after every sale, pass, placement and view change. Open the file again and press **Resume auction**. A reload during a spin resumes the already selected player without charging anyone or choosing a second player. Saves are local to the browser and file/site address; they do not sync between devices.

## Development and checks

Edit files in `src/`, then run:

```powershell
node scripts/build.cjs
node scripts/test-draft.cjs
node scripts/test-auction.cjs
node scripts/test-league.cjs
```

`scripts/test-browser.cjs` exercises a complete 33-player auction in Edge using Playwright, with mobile widths of 320, 390 and 430 pixels. Set `DRAFT_BROWSER_PACKAGES` to your Playwright package directory if needed.

`node scripts/test-formations-browser.cjs` checks that the wheel hides identities during a spin and every formation fits a fully filled team at phone and desktop sizes.

`node scripts/test-league-browser.cjs` exercises awards, readiness checks, lineup locking, matchdays, rating visibility and league save/resume on mobile.

For an optional local preview, run `node scripts/serve.cjs` and open http://127.0.0.1:4173.

Player-source details and database reuse terms are documented in `data/38-0/README.md`. The app uses the 4,854-player English roster snapshot, with 18,522 club-season entries.
