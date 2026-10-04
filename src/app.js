(() => {
  'use strict';
  const { players, clubs } = globalThis.DRAFT_GAME_DATA;
  const core = globalThis.AuctionCore, draft = globalThis.DraftCore, leagueCore = globalThis.LeagueCore;
  const $ = id => document.getElementById(id);
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const clubMap = new Map(clubs.map(club => [club.id, club]));
  const seasons = [...new Set(players.flatMap(player => player.clubSeasons.map(season => season.season)))].sort();
  const colours = ['#d6f48d', '#93c5fd', '#e9a6d5', '#f4c588', '#b4a6f3', '#82d8c4', '#f6ac9c', '#bdd0e5'];
  const storageKey = 'touchline-auction-v1';
  let game = null, league = null, showRatings = true, selectedManager = null, selectedPlayer = null, buyerId = null, view = 'auction';
  let spinning = false, rotation = 0, spinTimer = null, spinEpoch = 0, setupCache = null;
  let pending = { seasonMin: 0, seasonMax: seasons.length - 1, ratingMin: 40, ratingMax: 95, mode: 'peak' };
  const money = millions => millions >= 1000 ? `£${+(millions / 1000).toFixed(3)}bn` : `£${millions}m`;
  const sound = globalThis.TouchlineSound;
  const entryFor = id => game?.pool.find(entry => entry.id === id);
  const managerFor = id => game?.managers.find(manager => manager.id === id);
  const colourFor = id => colours[game.managers.findIndex(manager => manager.id === id)] || colours[0];
  const visibleRating = entry => showRatings ? draft.rating(entry, game.config.mode) : '?';
  function notify(message, error = false) { $('game-status').textContent = message; $('game-status').classList.toggle('error', error); }
  function save() {
    if (!game) return;
    try { localStorage.setItem(storageKey, JSON.stringify({ game: core.serialise(game), league: leagueCore.serialise(league), showRatings, selectedManager, view })); }
    catch { notify('This browser cannot save the auction. Keep this page open to continue.', true); }
  }
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (saved) {
      game = core.restore(saved.game, players);
      if (game) {
        league = leagueCore.restore(saved.league, game);
        showRatings = saved.showRatings !== false;
        selectedManager = game.managers.some(manager => manager.id === saved.selectedManager) ? saved.selectedManager : game.managers[0].id;
        view = ['auction', 'teams', 'transfers', 'league'].includes(saved.view) ? saved.view : 'auction';
      }
    }
  } catch { /* An invalid saved game starts at setup. */ }
  function options(id, entries) {
    entries.forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; $(id).append(option); });
  }
  options('manager-count', Array.from({ length: 7 }, (_, i) => [i + 2, `${i + 2} managers`]));
  options('setup-formation', Object.keys(draft.formations).map(value => [value, value]));
  const teamActions = document.createElement('div');
  teamActions.className = 'team-actions';
  teamActions.innerHTML = '<button id="auto-place" class="secondary-button small">Auto-place XI</button><button id="open-league" class="secondary-button small">Awards & league →</button>';
  $('placement-help').after(teamActions);
  // Once started, put standings and matchdays ahead of the pre-season review.
  $('champion').after($('league-season'));
  $('manager-count').value = '3';
  function renderNames(names = []) {
    const count = Number($('manager-count').value);
    const previous = [...document.querySelectorAll('[data-manager-name]')].map(input => input.value);
    $('manager-names').innerHTML = Array.from({ length: count }, (_, i) => `<label class="manager-name" style="--manager-color:${colours[i]}">Manager ${i + 1}<input data-manager-name="${i}" aria-label="Manager ${i + 1} name" maxlength="24" placeholder="Manager ${i + 1}" value="${escape(names[i] ?? previous[i] ?? '')}" autocomplete="off"></label>`).join('');
  }
  function configFromSetup() {
    return { managerCount: Number($('manager-count').value), formation: $('setup-formation').value, mode: pending.mode,
      seasonFrom: seasons[pending.seasonMin], seasonTo: seasons[pending.seasonMax], ratingMin: pending.ratingMin, ratingMax: pending.ratingMax,
      names: [...document.querySelectorAll('[data-manager-name]')].map((input, i) => input.value.trim() || `Manager ${i + 1}`) };
  }
  function rangeDisplay(prefix, min, max, seasonRange) {
    const [low, high] = seasonRange ? [0, seasons.length - 1] : [40, 95];
    for (const edge of ['min', 'max']) { $(prefix + '-' + edge).min = low; $(prefix + '-' + edge).max = high; }
    $(prefix + '-min').value = min; $(prefix + '-max').value = max;
    $(prefix + '-from').textContent = seasonRange ? seasons[min] : min;
    $(prefix + '-to').textContent = seasonRange ? seasons[max] : max;
    $(prefix + '-min').setAttribute('aria-valuetext', seasonRange ? seasons[min] : String(min));
    $(prefix + '-max').setAttribute('aria-valuetext', seasonRange ? seasons[max] : String(max));
    const element = document.querySelector(`[data-range="${prefix}"]`);
    element.style.setProperty('--range-from', `${100 * (min - low) / (high - low)}%`);
    element.style.setProperty('--range-to', `${100 * (max - low) / (high - low)}%`);
    $(prefix + '-min').style.zIndex = min === high ? 4 : 2;
  }
  function renderSetup() {
    rangeDisplay('setup-season', pending.seasonMin, pending.seasonMax, true);
    rangeDisplay('setup-rating', pending.ratingMin, pending.ratingMax, false);
    document.querySelectorAll('[data-setup-mode]').forEach(button => button.setAttribute('aria-pressed', button.dataset.setupMode === pending.mode));
    $('setup-rating-label').textContent = pending.mode === 'peak' ? 'Overall rating range' : 'Season rating range';
    const config = configFromSetup();
    const key = JSON.stringify({ ...config, names: [] });
    if (setupCache?.key !== key) {
      const eligible = core.candidates(players, config);
      setupCache = { key, eligibleCount: eligible.length, result: core.balance(eligible, config.formation, config.managerCount, () => .47) };
    }
    $('setup-pool').textContent = `${config.managerCount * 11} players · ${config.managerCount} managers · £1bn each`;
    const quotas = new Map();
    draft.formations[config.formation].forEach(slot => quotas.set(slot.position, (quotas.get(slot.position) || 0) + config.managerCount));
    $('setup-coverage').textContent = `${setupCache.eligibleCount.toLocaleString()} eligible footballers. Pool covers ${[...quotas].map(([position, count]) => `${count} ${position}`).join(' · ')}.`;
    $('setup-error').textContent = setupCache.result.error || '';
    $('start').disabled = !!setupCache.result.error;
    $('resume').hidden = !game;
    $('setup-saved-note').hidden = !game;
  }
  function showSetup() {
    if (spinning) return;
    if (game) {
      const config = game.config;
      pending = { seasonMin: seasons.indexOf(config.seasonFrom), seasonMax: seasons.indexOf(config.seasonTo), ratingMin: config.ratingMin, ratingMax: config.ratingMax, mode: config.mode };
      $('manager-count').value = config.managerCount; $('setup-formation').value = config.formation;
      renderNames(config.names);
    } else renderNames();
    $('setup-show-ratings').checked = showRatings;
    renderSetup(); $('setup-screen').hidden = false; $('game-screen').hidden = true; window.scrollTo(0, 0);
  }
  function showGame() {
    if (!game) return;
    $('setup-screen').hidden = true; $('game-screen').hidden = false;
    renderGame(); window.scrollTo(0, 0);
  }
  function setView(nextView) {
    view = nextView; renderGame(); save();
    if (matchMedia('(max-width:760px)').matches) $('game-content').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function renderGame() {
    if (!game) return;
    const config = game.config;
    $('active-settings').textContent = `${config.managerCount} managers · ${config.formation} · ${config.seasonFrom}–${config.seasonTo} · ${config.ratingMin}–${config.ratingMax} ${config.mode === 'peak' ? 'overall' : 'season'} · Rules locked`;
    $('ratings-toggle').checked = showRatings;
    $('open-settings').disabled = spinning;
    $('game-content').dataset.view = view;
    document.querySelectorAll('[data-view]').forEach(button => { if (button.tagName === 'BUTTON') button.setAttribute('aria-pressed', button.dataset.view === view); });
    $('transfer-count').textContent = game.sales.length;
    $('manager-strip').innerHTML = game.managers.map(manager => {
      const remaining = core.budget(game, manager.id), bought = core.purchases(game, manager.id).length;
      return `<button class="manager-card" data-manager="${manager.id}" style="--manager-color:${colourFor(manager.id)}" aria-pressed="${selectedManager === manager.id}" aria-label="View ${escape(manager.name)}: ${money(remaining)} remaining, ${bought} players"><span class="manager-card-name">${escape(manager.name)}</span><span class="manager-money">${money(remaining)}</span><span class="manager-count">${bought} / 11 players · remaining budget</span><span class="budget-track"><span style="width:${remaining / 10}%"></span></span></button>`;
    }).join('');
    renderAuction(); renderTeam(); renderTransfers(); renderLeague();
    $('undo-final').disabled = !!league;
  }
  function drawWheel() {
    if (spinning) return;
    const canvas = $('wheel'), context = canvas.getContext('2d');
    const count = game.remaining.length;
    rotation = 0; canvas.style.transition = 'none'; canvas.style.transform = 'rotate(0deg)';
    context.clearRect(0, 0, 640, 640);
    if (!count) return;
    // Decorative mystery segments have no connection to players in the pool.
    const segments = 12, step = Math.PI * 2 / segments;
    const palette = ['#314438', '#2a3a4b', '#3a3450', '#3c4430', '#3e3540', '#29444a'];
    for (let i = 0; i < segments; i++) {
      const start = -Math.PI / 2 + step * i;
      context.beginPath(); context.moveTo(320, 320); context.arc(320, 320, 316, start, start + step); context.closePath();
      context.fillStyle = palette[i % palette.length]; context.fill();
      context.strokeStyle = '#72809855'; context.lineWidth = 1.5; context.stroke();
      context.save(); context.translate(320, 320); context.rotate(start + step / 2);
      context.translate(232, 0); context.rotate(Math.PI / 2);
      context.fillStyle = '#d8e0e9'; context.font = '700 40px Segoe UI, sans-serif';
      context.textAlign = 'center'; context.textBaseline = 'middle';
      context.fillText('?', 0, 0);
      context.restore();
    }
    $('wheel-caption').textContent = `${count} PLAYERS LEFT`;
  }
  function renderAuction() {
    const current = entryFor(game.currentId), revealed = game.phase === 'revealed' && !spinning;
    const sold = ['sold', 'complete'].includes(game.phase), complete = game.phase === 'complete';
    $('auction-progress').textContent = `${game.sales.length} / ${game.pool.length} sold`;
    $('auction-title').textContent = spinning ? 'Here comes your next player…' : complete ? 'The final deal is done.' : revealed ? 'Let the bidding begin.' : sold ? 'One more for the squad.' : 'Who’s up next?';
    $('wheel-area').hidden = !!current && !spinning;
    $('player-card').hidden = !current || spinning;
    $('spin-actions').hidden = !!current && !spinning;
    $('bid-form').hidden = !revealed;
    $('sold-actions').hidden = !sold || complete || spinning;
    $('completion').hidden = !complete;
    $('spin').disabled = spinning || !game.remaining.length;
    $('spin').innerHTML = spinning ? 'Spinning…' : 'Spin for a player <span aria-hidden="true">↻</span>';
    if (!current || spinning) drawWheel();
    if (current && !spinning) {
      $('reveal-kicker').textContent = sold ? 'SOLD. SEALED. SIGNED.' : 'UP FOR AUCTION';
      $('reveal-rating').textContent = visibleRating(current);
      $('reveal-name').textContent = current.player.name;
      $('reveal-positions').innerHTML = current.player.positions.map(position => `<span>${position}</span>`).join('');
      $('reveal-meta').textContent = `${clubMap.get(current.season.clubId).name} · ${current.season.season} · ${current.player.nationality}`;
      const sale = game.sales.find(sale => sale.playerId === current.id);
      $('sale-result').hidden = !sale;
      if (sale) $('sale-result').textContent = `${managerFor(sale.managerId).name} wins the bid · ${money(sale.price)}`;
    } else {
      // Clear the old reveal and withhold the new identity until the spin ends.
      for (const id of ['reveal-name', 'reveal-rating', 'reveal-meta', 'reveal-positions', 'sale-result']) $(id).textContent = '';
      $('sale-result').hidden = true;
    }
    if (revealed) renderBid();
    const skipped = game.skipped || [];
    $('pass').textContent = 'No bids? Skip until the end of the cycle';
    $('skipped-players').hidden = !skipped.length;
    $('skipped-count').textContent = `${skipped.length} waiting`;
    const unseen = game.remaining.filter(id => !skipped.includes(id) && !(game.phase === 'revealed' && id === game.currentId)).length;
    $('skipped-note').textContent = unseen ? `They return after the ${unseen} remaining new players, in the order below.` : 'These players return next. Bid normally when each player comes back.';
    $('skipped-list').innerHTML = skipped.map((id, index) => { const entry = entryFor(id); return `<div class="transfer-row"><span class="transfer-rank">${index + 1}</span><div><strong class="transfer-name">${escape(entry.player.name)}</strong><small class="transfer-meta">${escape(entry.player.positions.join(' / '))} · ${escape(entry.season.season)}</small></div>${showRatings ? `<span class="badge">${draft.rating(entry, game.config.mode)}</span>` : ''}</div>`; }).join('');
    if (game.returning && current && !spinning && revealed) $('reveal-kicker').textContent = 'BACK FOR BIDDING';
  }
  function bidValue() {
    const raw = $('bid-price').value.trim();
    if (!raw) return null;
    const amount = Number(raw);
    return Number.isInteger(amount) && amount >= 0 ? amount : null;
  }
  function renderBid() {
    const price = bidValue();
    $('winner-options').innerHTML = game.managers.map(manager => {
      const full = core.purchases(game, manager.id).length >= 11;
      const budget = core.budget(game, manager.id);
      return `<button type="button" class="winner-option" data-buyer="${manager.id}" style="--manager-color:${colourFor(manager.id)}" aria-pressed="${buyerId === manager.id}" ${full ? 'disabled' : ''}><strong>${escape(manager.name)}</strong><small>${full ? 'XI complete' : `${money(budget)} left · ${core.purchases(game, manager.id).length}/11 bought`}</small></button>`;
    }).join('');
    let error = '';
    const buyer = managerFor(buyerId);
    if (price === null) error = 'Use a whole-million price. £0 is allowed.';
    else if (buyer && price > core.budget(game, buyerId)) error = `${buyer.name} only has ${money(core.budget(game, buyerId))} left.`;
    else if (buyer && core.purchases(game, buyerId).length >= 11) error = `${buyer.name} already has 11 players.`;
    $('bid-error').textContent = error;
    $('sell').disabled = !buyer || !!error || spinning || game.phase !== 'revealed';
    $('sell').textContent = buyer && !error ? `Sell to ${buyer.name} · ${money(price)}` : 'Confirm sale →';
  }
  function renderTeam() {
    const manager = managerFor(selectedManager) || game.managers[0]; selectedManager = manager.id;
    const sales = core.purchases(game, manager.id), palette = colourFor(manager.id);
    $('team-title').textContent = `${manager.name}’s XI`;
    $('team-formation').textContent = game.config.formation;
    $('team-tabs').innerHTML = game.managers.map(item => `<button class="team-tab" data-team="${item.id}" style="--manager-color:${colourFor(item.id)}" aria-pressed="${item.id === manager.id}">${escape(item.name)}</button>`).join('');
    $('team-players').textContent = `${sales.length} / 11`;
    $('team-budget').textContent = money(core.budget(game, manager.id));
    $('team-average').textContent = !showRatings ? 'Hidden' : sales.length ? (sales.reduce((total, sale) => total + draft.rating(entryFor(sale.playerId), game.config.mode), 0) / sales.length).toFixed(1) : '—';
    if (selectedPlayer && !sales.some(sale => sale.playerId === selectedPlayer)) selectedPlayer = null;
    $('placement-help').textContent = league ? 'Your XI is locked for this league. View the matchdays and results in League.' : selectedPlayer ? `${entryFor(selectedPlayer).player.name} selected. Tap any position to place or swap.` : 'Tap a player below, then a spot on the pitch. Tap a placed player to move them.';
    $('auto-place').disabled = !!league || !sales.length;
    $('open-league').hidden = game.phase !== 'complete';
    $('deselect-player').hidden = !selectedPlayer;
    $('pitch-slots').innerHTML = draft.formations[game.config.formation].map((slot, i) => {
      const id = manager.board[i], entry = id && entryFor(id), sale = sales.find(sale => sale.playerId === id);
      const offPosition = entry && leagueCore.naturalRank(slot.position, entry.player.positions) < 0;
      return `<div class="pitch-slot ${entry ? 'filled' : ''} ${id && id === selectedPlayer ? 'selected' : ''}" data-drop="${i}" style="left:${slot.x}%;top:${slot.y}%;--manager-color:${palette}"><button class="slot-button" data-slot="${i}" ${league ? 'disabled' : ''} ${entry && !league ? `draggable="true" data-drag="${escape(id)}"` : ''} aria-label="${escape(slot.position + (entry ? ': ' + entry.player.name + ', paid ' + money(sale.price) : ': empty'))}" aria-pressed="${!!id && id === selectedPlayer}"><span class="slot-shirt">${entry ? visibleRating(entry) : '+'}</span>${entry ? `<span class="slot-name" title="${escape(entry.player.name)}">${escape(entry.player.name)}</span>` : ''}<span class="slot-position">${slot.position}</span>${entry ? `<span class="slot-price">${money(sale.price)}</span>${offPosition ? '<span class="off-position">Out of position</span>' : ''}` : ''}</button>${entry && !league ? `<button class="unplace-button" data-unplace="${escape(id)}" aria-label="Return ${escape(entry.player.name)} to your player list">×</button>` : ''}</div>`;
    }).join('');
    $('owned-players').innerHTML = sales.length ? sales.map(sale => {
      const entry = entryFor(sale.playerId), index = manager.board.indexOf(entry.id), placed = index >= 0;
      return `<button class="owned-player ${selectedPlayer === entry.id ? 'selected' : ''}" data-owned="${escape(entry.id)}" data-drag="${escape(entry.id)}" ${league ? 'disabled' : 'draggable="true"'} aria-pressed="${selectedPlayer === entry.id}"><strong>${escape(entry.player.name)}</strong><span class="owned-meta">${escape(entry.player.positions.join(' / '))} · ${clubMap.get(entry.season.clubId).shortName} ${entry.season.season}${showRatings ? ` · ${visibleRating(entry)} OVR` : ''}</span><span class="owned-bottom"><span>${money(sale.price)}</span><span class="owned-state">${placed ? `On pitch · ${draft.formations[game.config.formation][index].position}` : 'Tap to place'}</span></span></button>`;
    }).join('') : '<div class="empty-state">Your first signing is waiting on the wheel.<br>Win a bid, then place the player here.</div>';
  }
  function renderTransfers() {
    $('ledger-progress').textContent = `${game.sales.length} / ${game.pool.length} deals`;
    const sorted = game.sales.map((sale, index) => ({ ...sale, index })).sort((a, b) => b.price - a.price || a.index - b.index);
    $('transfers-list').innerHTML = sorted.length ? sorted.map((sale, i) => {
      const entry = entryFor(sale.playerId), manager = managerFor(sale.managerId);
      return `<div class="transfer-row" data-transfer="${escape(entry.id)}"><span class="transfer-rank">${String(i + 1).padStart(2, '0')}</span><div><strong class="transfer-name">${escape(entry.player.name)}</strong><span class="transfer-meta">${escape(entry.player.positions.join(' / '))} · ${clubMap.get(entry.season.clubId).shortName} ${entry.season.season}${showRatings ? ` · ${visibleRating(entry)} OVR` : ''}</span><span class="transfer-owner" style="--manager-color:${colourFor(manager.id)}">Bought by ${escape(manager.name)}</span></div><span class="transfer-price">${money(sale.price)}</span></div>`;
    }).join('') : '<div class="empty-state">No deals yet. Once the bidding starts,<br>every sale will be listed here.</div>';
  }
  function fixtureCard(fixture, compact = false) {
    const home = managerFor(fixture.homeId), away = managerFor(fixture.awayId), result = fixture.result;
    const score = result ? `${result.homeGoals} – ${result.awayGoals}` : 'v';
    const heading = `<div class="fixture-scoreline"><span class="fixture-team" style="--manager-color:${colourFor(home.id)}">${escape(home.name)}<small>HOME</small></span><strong class="fixture-score">${score}</strong><span class="fixture-team away-team" style="--manager-color:${colourFor(away.id)}">${escape(away.name)}<small>AWAY</small></span></div>`;
    if (!result) return `<div class="fixture-card upcoming-fixture">${heading}</div>`;
    const goals = [...result.homeScorers.map(goal => ({ ...goal, teamId: home.id })), ...result.awayScorers.map(goal => ({ ...goal, teamId: away.id }))].sort((a, b) => leagueCore.absoluteMinute(a) - leagueCore.absoluteMinute(b));
    const events = goals.length ? goals.map(goal => `<li><span class="goal-minute">${leagueCore.minuteLabel(goal)}</span><span style="--manager-color:${colourFor(goal.teamId)}" class="goal-player">${escape(goal.name)}</span><small>${escape(managerFor(goal.teamId).name)}</small></li>`).join('') : '<li class="no-goals">A clean sheet at both ends.</li>';
    return `<details class="fixture-card" ${compact ? '' : 'open'}><summary>${heading}<span class="fixture-detail-label">Goals & scorers <span aria-hidden="true">⌄</span></span></summary><ul class="goal-events">${events}</ul></details>`;
  }
  function renderLeague() {
    const complete = game.phase === 'complete';
    $('league-waiting').hidden = complete;
    $('post-auction').hidden = !complete;
    $('league-progress').textContent = !complete ? 'After the auction' : !league ? 'Pre-season' : `Matchday ${league.round} / ${leagueCore.roundCount(league)}`;
    if (!complete) return;
    const awards = leagueCore.awards(game), buy = awards.biggestBuy, bargain = awards.bargain;
    const playerAward = (title, sale, note) => `<article class="award-card" style="--manager-color:${colourFor(sale.managerId)}"><p class="eyebrow">${title}</p><h4>${escape(entryFor(sale.playerId).player.name)}</h4><strong>${money(sale.price)}</strong><span>${escape(managerFor(sale.managerId).name)}${showRatings ? ` · ${sale.rating} OVR` : ''}</span><small>${note}</small></article>`;
    $('award-grid').innerHTML = playerAward('BIGGEST BUY', buy, 'The auction’s most expensive signing.')
      + playerAward('BEST BARGAIN', bargain, bargain.estimated > 0 ? `${money(Math.max(0, bargain.estimated - bargain.price))} below this auction’s rating-based estimate.` : 'A free signing. No budget spent.')
      + `<article class="award-card" style="--manager-color:${colourFor(awards.biggestSpender.id)}"><p class="eyebrow">BIGGEST SPENDER</p><h4>${escape(awards.biggestSpender.name)}</h4><strong>${money(awards.biggestSpender.spent)}</strong><span>Spent on their eleven</span><small>${money(core.budget(game, awards.biggestSpender.id))} left in the bank.</small></article>`;
    const teams = league ? league.teams : game.managers.map(manager => leagueCore.team(game, manager));
    const unitLabel = { attack: 'ATT', midfield: 'MID', defence: 'DEF', goalkeeping: 'GK' };
    $('comparison-note').textContent = !showRatings ? 'Ratings hidden' : league ? 'Starting XIs locked' : 'Position-adjusted strength';
    $('comparison-grid').innerHTML = teams.map(team => {
      const manager = managerFor(team.id), purchases = core.purchases(game, team.id);
      const score = showRatings ? (team.placed === 11 ? team.overall : '—') : '?';
      const roster = draft.formations[game.config.formation].map((slot, index) => {
        const id = manager.board[index], entry = entryFor(id), sale = purchases.find(sale => sale.playerId === id);
        return `<div class="comparison-player"><span class="xi-position">${slot.position}</span><span class="xi-name">${entry ? escape(entry.player.name) : 'Empty position'}${entry && showRatings ? `<small>${visibleRating(entry)} OVR</small>` : ''}</span><strong>${sale ? money(sale.price) : '—'}</strong></div>`;
      }).join('');
      return `<article class="comparison-card" style="--manager-color:${colourFor(team.id)}"><div class="comparison-top"><div><h4>${escape(team.name)}</h4><span>${team.placed} / 11 placed · ${money(team.spent)} spent</span></div><strong class="team-strength">${score}<small>TEAM</small></strong></div><div class="unit-scores">${Object.entries(unitLabel).map(([unit, label]) => `<div><strong>${showRatings ? (team[unit] || '—') : '?'}</strong><small>${label}</small></div>`).join('')}</div>${team.misplaced ? `<p class="shape-warning">${team.misplaced} out of position · reduced contribution</p>` : ''}<details class="comparison-roster"><summary>View the XI</summary>${roster}</details><button class="text-button" data-review-team="${team.id}">${league ? 'View pitch' : 'Arrange XI'} →</button></article>`;
    }).join('');
    $('league-setup').hidden = !!league;
    $('league-season').hidden = !league;
    $('champion').hidden = true;
    if (!league) {
      const check = leagueCore.readiness(game), count = game.managers.length;
      $('league-format').textContent = `${count} teams. ${count * (count - 1)} matches. Everyone plays each opponent twice, home and away.`;
      $('league-readiness').textContent = check.message;
      $('start-league').disabled = !check.ready;
      $('finish-teams').hidden = check.ready;
      return;
    }
    const rounds = leagueCore.roundCount(league), finished = league.round === rounds, rows = leagueCore.table(league);
    const tied = (a, b) => a.points === b.points && a.gd === b.gd && a.gf === b.gf;
    let rank = 1;
    $('league-table').innerHTML = `<table class="league-table"><caption class="visually-hidden">${finished ? 'Final' : 'Current'} league standings</caption><thead><tr><th scope="col">#</th><th scope="col">Team</th><th scope="col"><abbr title="Played">P</abbr></th><th scope="col"><abbr title="Won">W</abbr></th><th scope="col"><abbr title="Drawn">D</abbr></th><th scope="col"><abbr title="Lost">L</abbr></th><th scope="col" class="stat-extra"><abbr title="Goals for">GF</abbr></th><th scope="col" class="stat-extra"><abbr title="Goals against">GA</abbr></th><th scope="col"><abbr title="Goal difference">GD</abbr></th><th scope="col">Pts</th></tr></thead><tbody>${rows.map((row, index) => {
      if (index === 0 || !tied(row, rows[index - 1])) rank = index + 1;
      return `<tr data-standing="${row.id}" class="${rank === 1 && finished ? 'winning-row' : ''}"><td>${rank}</td><th scope="row" style="--manager-color:${colourFor(row.id)}">${escape(row.name)}</th><td>${row.played}</td><td>${row.won}</td><td>${row.drawn}</td><td>${row.lost}</td><td class="stat-extra">${row.gf}</td><td class="stat-extra">${row.ga}</td><td>${row.gd > 0 ? '+' : ''}${row.gd}</td><td class="standing-points">${row.points}</td></tr>`;
    }).join('')}</tbody></table>`;
    $('league-controls').hidden = finished;
    $('play-round').textContent = `Play matchday ${league.round + 1} →`;
    $('finish-league').hidden = rounds - league.round <= 1;
    const round = league.round ? league.round - 1 : 0;
    const fixtures = league.fixtures.filter(fixture => fixture.round === round);
    const resting = game.managers.filter(manager => !fixtures.some(fixture => fixture.homeId === manager.id || fixture.awayId === manager.id));
    $('latest-matchday').innerHTML = `<div class="post-heading"><h3>${league.round ? 'Latest results' : 'Opening fixtures'}</h3><span>Matchday ${round + 1}</span></div>${fixtures.map(fixture => fixtureCard(fixture)).join('')}${resting.length ? `<p class="league-note">Resting this matchday: ${resting.map(manager => escape(manager.name)).join(', ')}.</p>` : ''}`;
    $('fixture-list').innerHTML = Array.from({ length: rounds }, (_, round) => `<div class="fixture-round"><h4>Matchday ${round + 1}</h4>${league.fixtures.filter(fixture => fixture.round === round).map(fixture => fixtureCard(fixture, true)).join('')}</div>`).join('');
    if (finished) {
      const winners = rows.filter(row => tied(row, rows[0]));
      $('champion').hidden = false;
      $('champion').innerHTML = `<p class="eyebrow">${winners.length > 1 ? 'SHARED CHAMPIONS' : 'YOUR LEAGUE CHAMPION'}</p><h3>${winners.map(row => escape(row.name)).join(' & ')}</h3><p>${rows[0].points} points · ${rows[0].played} games · ${rows[0].gf} goals scored</p>`;
    }
  }
  function spin() {
    if (!game || spinning || !$('setup-screen').hidden) return;
    const result = core.reveal(game);
    if (result.error) return notify(result.error, true);
    // Persist the selected player before animating: a reload resumes the reveal.
    drawWheel();
    game = result.game; buyerId = null; selectedPlayer = null; $('bid-price').value = '1';
    spinning = true; const epoch = ++spinEpoch;
    save(); renderGame(); notify('The wheel is spinning…');
    const landing = 360 - (Math.floor(Math.random() * 12) + .5) * 30;
    const duration = matchMedia('(prefers-reduced-motion:reduce)').matches ? 180 : 2400;
    const canvas = $('wheel');
    canvas.getBoundingClientRect(); sound.spin(duration / 1000);
    rotation += 360 * 5 + landing;
    canvas.style.transition = `transform ${duration}ms cubic-bezier(.14,.65,.14,1)`;
    canvas.style.transform = `rotate(${rotation}deg)`;
    clearTimeout(spinTimer);
    spinTimer = setTimeout(() => {
      if (epoch !== spinEpoch) return;
      spinning = false; renderGame(); notify(`${entryFor(game.currentId).player.name} is up for auction. Agree the bids, then record the sale.`);
    }, duration + 70);
  }
  function applyPlacement(slot) {
    if (league) return notify('Your XI is locked for this league.');
    if (!selectedPlayer) {
      const id = managerFor(selectedManager).board[slot];
      if (id) { selectedPlayer = id; renderTeam(); }
      else notify('Tap one of your bought players first, then tap a spot on the pitch.');
      return;
    }
    const id = selectedPlayer, result = core.place(game, selectedManager, id, slot);
    if (result.error) return notify(result.error, true);
    game = result.game; selectedPlayer = null; save(); renderTeam(); renderLeague();
    notify(`${entryFor(id).player.name} placed at ${draft.formations[game.config.formation][slot].position}.`);
  }
  for (const prefix of ['setup-season', 'setup-rating']) for (const edge of ['min', 'max']) {
    $(prefix + '-' + edge).addEventListener('input', () => {
      const type = prefix.endsWith('season') ? 'season' : 'rating', value = Number($(prefix + '-' + edge).value);
      pending[type + (edge === 'min' ? 'Min' : 'Max')] = edge === 'min' ? Math.min(value, pending[type + 'Max']) : Math.max(value, pending[type + 'Min']);
      renderSetup();
    });
  }
  $('manager-count').addEventListener('change', () => { renderNames(); renderSetup(); });
  $('setup-formation').addEventListener('change', renderSetup);
  document.querySelectorAll('[data-setup-mode]').forEach(button => button.addEventListener('click', () => { pending.mode = button.dataset.setupMode; renderSetup(); }));
  $('start').addEventListener('click', () => {
    if ($('setup-screen').hidden || $('start').disabled) return;
    const config = configFromSetup(), result = core.makePool(players, config);
    if (result.error) { $('setup-error').textContent = result.error; return; }
    ++spinEpoch; clearTimeout(spinTimer); spinning = false;
    game = core.createGame(config, result.pool); league = null; showRatings = $('setup-show-ratings').checked;
    selectedManager = game.managers[0].id; selectedPlayer = null; buyerId = null; view = 'auction';
    save(); showGame(); notify(`${game.pool.length} players are ready. Spin to start the auction.`);
  });
  $('resume').addEventListener('click', showGame);
  $('open-settings').addEventListener('click', showSetup);
  document.querySelectorAll('button[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  $('manager-strip').addEventListener('click', event => {
    const button = event.target.closest('[data-manager]');
    if (button) { selectedManager = button.dataset.manager; selectedPlayer = null; setView('teams'); }
  });
  $('team-tabs').addEventListener('click', event => {
    const button = event.target.closest('[data-team]');
    if (button) { selectedManager = button.dataset.team; selectedPlayer = null; renderGame(); save(); }
  });
  $('sound-toggle').checked = sound.enabled;
  $('sound-toggle').addEventListener('change', () => { if ($('sound-toggle').checked !== sound.enabled) sound.toggle(); });
  document.addEventListener('pointerdown', () => sound.unlock(), true);
  $('ratings-toggle').addEventListener('change', () => { showRatings = $('ratings-toggle').checked; save(); renderGame(); });
  $('spin').addEventListener('click', spin); $('next-player').addEventListener('click', spin);
  $('winner-options').addEventListener('click', event => {
    const button = event.target.closest('[data-buyer]');
    if (button && !button.disabled) { buyerId = button.dataset.buyer; renderBid(); }
  });
  $('bid-price').addEventListener('input', renderBid);
  document.querySelectorAll('[data-price]').forEach(button => button.addEventListener('click', () => { $('bid-price').value = button.dataset.price; renderBid(); }));
  $('bid-form').addEventListener('submit', event => {
    event.preventDefault(); if (spinning) return;
    const price = bidValue();
    if (price === null) { renderBid(); return; }
    const result = core.buy(game, buyerId, price);
    if (result.error) { $('bid-error').textContent = result.error; return; }
    game = result.game; selectedManager = buyerId; selectedPlayer = game.currentId; sound.sold();
    save(); renderGame(); notify(`${managerFor(buyerId).name} bought ${entryFor(game.currentId).player.name} for ${money(price)}. Tap Teams to place the player.`);
  });
  $('pass').addEventListener('click', () => {
    if (spinning) return;
    const result = core.pass(game); if (result.error) return notify(result.error, true);
    game = result.game; buyerId = null; save(); renderGame(); notify('Player returned to the pool. Everyone will still get 11 signings.');
  });
  function undo() {
    if (league) return notify('The league has started. Its squads and auction results are locked.');
    if (spinning) return;
    const result = core.undo(game); if (result.error) return notify(result.error, true);
    const last = game.sales.at(-1);
    game = result.game; buyerId = last.managerId; selectedPlayer = null; $('bid-price').value = last.price;
    save(); renderGame(); notify('Sale undone. The budget is refunded and the player is back up for auction.');
  }
  $('undo').addEventListener('click', undo); $('undo-final').addEventListener('click', undo);
  $('view-buyer').addEventListener('click', () => {
    const sale = game.sales.at(-1); if (!sale) return;
    selectedManager = sale.managerId; selectedPlayer = sale.playerId; setView('teams');
  });
  $('review-teams').addEventListener('click', () => setView('teams'));
  $('review-auction').addEventListener('click', () => setView('league'));
  $('open-league').addEventListener('click', () => setView('league'));
  $('comparison-grid').addEventListener('click', event => {
    const button = event.target.closest('[data-review-team]');
    if (button) { selectedManager = button.dataset.reviewTeam; selectedPlayer = null; setView('teams'); }
  });
  $('finish-teams').addEventListener('click', () => {
    selectedManager = leagueCore.readiness(game).managerId || game.managers[0].id;
    selectedPlayer = null; setView('teams');
  });
  $('auto-place').addEventListener('click', () => {
    if (league) return;
    const manager = managerFor(selectedManager), sales = core.purchases(game, manager.id);
    const unplaced = sales.filter(sale => !manager.board.includes(sale.playerId)).map(sale => entryFor(sale.playerId));
    const squad = manager.board.map(id => id ? entryFor(id) : unplaced.shift() || null);
    const board = draft.remap(squad, game.config.formation, game.config.formation).map(entry => entry?.id || null);
    game = { ...game, managers: game.managers.map(item => item.id === manager.id ? { ...item, board } : item) };
    selectedPlayer = null; save(); renderGame(); notify(`${manager.name}’s players placed. You can still move or swap them before starting the league.`);
  });
  $('start-league').addEventListener('click', () => {
    if (league || $('start-league').disabled) return;
    const result = leagueCore.create(game);
    if (result.error) return notify(result.error, true);
    league = result.league; selectedPlayer = null; save(); renderGame();
    $('league-season').scrollIntoView({ behavior: 'smooth', block: 'start' });
    notify('The XIs are locked. Play your first matchday when everyone is ready.');
  });
  function playLeague(all = false) {
    if (!league || league.round >= leagueCore.roundCount(league)) return;
    do { league = leagueCore.playRound(league).league; } while (all && league.round < leagueCore.roundCount(league));
    save(); renderGame();
    notify(league.round === leagueCore.roundCount(league) ? 'The league is finished. Your final table and champions are ready.' : `Matchday ${league.round} finished. Scores and the league table are saved.`);
  }
  $('play-round').addEventListener('click', () => playLeague());
  $('finish-league').addEventListener('click', () => playLeague(true));
  $('full-table').addEventListener('change', () => $('league-table').classList.toggle('show-all', $('full-table').checked));
  $('owned-players').addEventListener('click', event => {
    if (league) return;
    const button = event.target.closest('[data-owned]');
    if (button) { selectedPlayer = selectedPlayer === button.dataset.owned ? null : button.dataset.owned; renderTeam(); }
  });
  $('pitch-slots').addEventListener('click', event => {
    if (league) return;
    const unplace = event.target.closest('[data-unplace]');
    if (unplace) {
      game = core.unplace(game, selectedManager, unplace.dataset.unplace); selectedPlayer = null; save(); renderTeam(); renderLeague();
      notify('Player returned to your list. The purchase and budget are unchanged.'); return;
    }
    const button = event.target.closest('[data-slot]'); if (button) applyPlacement(Number(button.dataset.slot));
  });
  $('deselect-player').addEventListener('click', () => { selectedPlayer = null; renderTeam(); });
  $('team-panel').addEventListener('dragstart', event => {
    if (league) { event.preventDefault(); return; }
    const element = event.target.closest('[data-drag]'); if (!element) return;
    event.dataTransfer.setData('text/plain', element.dataset.drag); event.dataTransfer.effectAllowed = 'move';
  });
  $('pitch-slots').addEventListener('dragover', event => { if (event.target.closest('[data-drop]')) event.preventDefault(); });
  $('pitch-slots').addEventListener('drop', event => {
    const target = event.target.closest('[data-drop]'); if (!target) return;
    event.preventDefault(); selectedPlayer = event.dataTransfer.getData('text/plain'); applyPlacement(Number(target.dataset.drop));
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && game) { selectedPlayer = null; renderTeam(); }
  });
  showSetup();
})();
