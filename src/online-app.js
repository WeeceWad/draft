(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = price => `£${(price / 10).toFixed(price % 10 ? 1 : 0)}m`;
  const storage = { get(key) { try { return localStorage.getItem(`touchline-online-${key}`); } catch { return null; } }, set(key, value) { try { value === null ? localStorage.removeItem(`touchline-online-${key}`) : localStorage.setItem(`touchline-online-${key}`, value); } catch {} } };
  let room = null, socket = null, connected = false, busy = false, retry = 0, reconnectTimer = null, screen = 'home', tab = 'auction', teamId = null, selected = null, bidText = '', offset = 0, seasons = [], revealDrawn = null;
  let showRatings = storage.get('ratings') !== 'hide';
  let fullStats = false;
  const clock = () => Date.now() + offset;
  const memberName = id => room?.members.find(member => member.managerId === id)?.name || 'Manager';
  const entry = id => room?.game?.pool.find(player => player.id === id);
  const rating = player => DraftCore.rating(player, room.game.config.mode);
  const myBudget = () => room?.game ? AuctionCore.budget(room.game, room.me) : 1000;
  const myFull = () => room?.game && AuctionCore.purchases(room.game, room.me).length >= 11;
  const disabled = value => value ? 'disabled' : '';
  const wheel = spinning => `<div class="mystery-wheel" role="img" aria-label="Mystery player wheel. Identities stay hidden until the spin ends."><div class="wheel-disc ${spinning ? 'spinner' : ''}"></div><span class="wheel-arrow"></span><span class="wheel-centre">?</span></div>`;
  let toastTimer;
  function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4500); }
  async function api(url, body) {
    const started = Date.now();
    const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let data;
    try { data = await response.json(); } catch { throw new Error('Could not reach the game server. Please try again.'); }
    if (data.serverTime) offset = data.serverTime - (started + Date.now()) / 2;
    if (data.room) accept(data.room);
    if (!response.ok) { const error = new Error(data.error || 'Request failed.'); error.status = response.status; throw error; }
    return data;
  }
  function connection() {
    $('#connection').textContent = room ? (connected ? '● Live' : '● Reconnecting…') : 'Online rooms';
    $('#connection').classList.toggle('live', connected);
  }
  function accept(next) {
    if (room?.id === next.id && next.revision < room.revision) return;
    const newRound = room?.round?.id !== next.round?.id;
    const first = room?.id !== next.id;
    room = next; storage.set('room', room.id);
    if (newRound) { bidText = ''; revealDrawn = null; }
    if (first) { teamId = room.me; selected = null; tab = room.status === 'complete' ? 'league' : 'auction'; }
    if (room.status === 'complete' && newRound) tab = 'league';
    render();
  }
  function connect() {
    clearTimeout(reconnectTimer);
    if (!room) return;
    if (socket) { socket.onclose = null; socket.close(); }
    const id = room.id;
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/live?roomId=${encodeURIComponent(id)}`);
    socket.onopen = () => { if (room?.id !== id) return; connected = true; retry = 0; connection(); render(); };
    socket.onmessage = event => { try { const message = JSON.parse(event.data); if (message.type === 'state' && room?.id === id) { offset = message.serverTime - Date.now(); accept(message.room); } } catch { toast('A live update could not be read. Reconnect to refresh.'); } };
    socket.onclose = event => {
      if (room?.id !== id) return;
      connected = false; connection(); render();
      if (event.code === 1008) { toast(event.reason || 'Room no longer available.'); return; }
      reconnectTimer = setTimeout(async () => { try { await api(`/api/room/${id}`); connect(); } catch (error) { toast(error.message); if (error.status === 403 || error.status === 404) return; connect(); } }, Math.min(1000 * 2 ** retry++, 15000));
    };
  }
  async function action(type, details = {}) {
    if (busy || !connected) return;
    busy = true; render();
    try { await api('/api/action', { roomId: room.id, command: { type, requestId: crypto.randomUUID(), ...(['bid', 'withdraw', 'skip', 'reveal'].includes(type) ? { roundId: room.round?.id ?? null } : {}), ...details } }); }
    catch (error) { toast(error.message); }
    finally { busy = false; render(); }
  }
  function rules(config) { return `<div class="rules stack"><div class="row"><span>Seasons</span><strong>${esc(config.seasonFrom)} – ${esc(config.seasonTo)}</strong></div><div class="row"><span>${config.mode === 'peak' ? 'Peak overall' : 'Season'} rating</span><strong>${config.ratingMin} – ${config.ratingMax}</strong></div><div class="row"><span>Formation</span><strong>${esc(config.formation)}</strong></div><p>£100m each · 11 players each · 60 seconds from the first bid · +10 seconds per new bid. Settings lock when the room is created.</p></div>`; }
  function home() {
    const code = new URLSearchParams(location.search).get('code') || '';
    return `<div class="hero"><div class="eyebrow">A room. A budget. Your best XI.</div><h1 class="gap-top">Build your team.<br>Beat your mates.</h1><p>A live football auction, straight from your phone. Draft legends, outbid your friends, then play a league together.</p></div><div class="grid home-panels"><section class="panel stack"><div class="eyebrow">You set the rules</div><h2>Host an auction</h2><p>Choose your player pool, share a four-digit code and get everyone ready.</p><button class="primary" data-do="setup">Create room →</button></section><form id="join-form" class="panel stack"><div class="eyebrow">Got an invite?</div><h2>Join your friends</h2><div class="field"><label for="join-name">Your manager name</label><input id="join-name" name="name" maxlength="24" required autocomplete="nickname" value="${esc(storage.get('name') || '')}" placeholder="e.g. Alex"></div><div class="field"><label for="join-code">Room code</label><input class="code-input" id="join-code" name="code" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required value="${esc(/^\d{4}$/.test(code) ? code : '')}" placeholder="0000" autocomplete="off"></div><button class="primary" ${disabled(busy)}>Join room →</button></form><p class="wide hint">Each manager needs their own browser or device. Already playing? Use the same browser to rejoin with your saved team. <a href="/offline.html">Play the local version</a>.</p></div>`;
  }
  function setup() {
    return `<div class="settings stack"><div class="row"><div><div class="eyebrow">Before kick-off</div><h1 class="gap-top">Your auction rules</h1></div><button class="quiet" data-do="home">Back</button></div><form id="create-form" class="panel stack"><div class="grid"><div class="field"><label for="host-name">Your manager name</label><input id="host-name" name="name" maxlength="24" required autocomplete="nickname" value="${esc(storage.get('name') || '')}" placeholder="e.g. Alex"></div><div class="field"><label for="capacity">Number of managers</label><select id="capacity" name="capacity">${Array.from({ length: 7 }, (_, i) => `<option value="${i + 2}" ${i === 1 ? 'selected' : ''}>${i + 2} managers · ${(i + 2) * 11} players</option>`).join('')}</select></div><div class="field"><label for="formation">Starting formation</label><select id="formation" name="formation">${Object.keys(DraftCore.formations).map(value => `<option>${esc(value)}</option>`).join('')}</select></div><div class="field"><label for="mode">Rating type</label><select id="mode" name="mode"><option value="peak">Peak overall rating</option><option value="season">Rating in the selected season</option></select></div></div><div class="sliders"><div class="row"><span class="label">Season range</span><strong id="season-label">${esc(seasons[0])} – ${esc(seasons.at(-1))}</strong></div><div class="range-pair"><label>From<input id="season-from" type="range" name="seasonFrom" min="0" max="${seasons.length - 1}" value="0"></label><label>To<input id="season-to" type="range" name="seasonTo" min="0" max="${seasons.length - 1}" value="${seasons.length - 1}"></label></div></div><div class="sliders"><div class="row"><span class="label">Rating range</span><strong id="rating-label">40 – 95</strong></div><div class="range-pair"><label>Minimum<input id="rating-min" type="range" name="ratingMin" min="40" max="95" value="40"></label><label>Maximum<input id="rating-max" type="range" name="ratingMax" min="40" max="95" value="95"></label></div></div><p class="hint">The server selects a hidden, balanced pool with enough players for the chosen formation, including one goalkeeper per manager. These rules stay fixed for the game.</p><button class="primary" ${disabled(busy)}>Create room & get your code →</button></form></div>`;
  }
  function lobby() {
    const me = room.members.find(member => member.managerId === room.me), allReady = room.members.length === room.capacity && room.members.every(member => member.ready);
    return `<div class="room-head row"><div><div class="eyebrow">The dressing room</div><h1 class="gap-top">Waiting for your managers</h1></div><span class="pill">${room.members.length}/${room.capacity} joined</span></div><div class="grid lobby-grid"><section class="panel stack"><h2>Share your room code</h2><div class="big-code">${room.code}</div><div class="actions"><button data-do="copy-code">Copy code</button><button data-do="share">Share invite</button></div><p class="hint">Open this game on another device and enter the code. The room lasts 24 hours.</p>${rules(room.config)}</section><section class="panel stack"><h2>Your managers</h2><div>${room.members.map(member => `<div class="member"><div class="avatar">${esc(member.name.slice(0, 1).toUpperCase())}</div><div class="grow"><strong>${esc(member.name)}${member.managerId === room.me ? ' (you)' : ''}</strong><small>${member.isHost ? 'Host · ' : ''}${member.ready ? 'Ready to draft' : 'Not ready yet'}</small></div>${room.isHost && member.managerId !== room.me ? `<button class="quiet danger" data-do="kick" data-id="${member.managerId}" aria-label="Remove ${esc(member.name)}">×</button>` : `<span class="pill ${member.ready ? 'green' : ''}">${member.ready ? 'Ready' : 'Waiting'}</span>`}</div>`).join('')}</div><button class="${me.ready ? 'quiet' : 'primary'}" data-do="ready" ${disabled(!connected || busy)}>${me.ready ? 'Not ready' : 'I’m ready'}</button>${room.isHost ? `<button class="primary" data-do="start" ${disabled(!allReady || !connected || busy)}>Start the auction →</button><p class="hint">Everyone must join and be ready before you start.</p>` : '<p class="hint">Your host starts once everyone is ready.</p>'}</section></div>${roomFooter()}`;
  }
  function roomFooter() { return `<details class="gap-top"><summary class="hint">Room options</summary><div class="footer-actions"><button class="quiet" data-do="leave">Return to home</button>${room.isHost ? `<select id="next-host" aria-label="Choose next host">${room.members.filter(member => member.managerId !== room.me).map(member => `<option value="${member.managerId}">${esc(member.name)}</option>`).join('')}</select><button class="quiet" data-do="transferHost" ${disabled(!connected || busy || room.members.length < 2)}>Hand over host</button>` : ''}</div><p class="hint gap-top">Leaving this page keeps your place in the room. Closing the browser does not withdraw a live bid. Hand over hosting before the host leaves.</p></details>`; }
  function navigation() { return `<div class="room-head row"><div><div class="eyebrow">ROOM ${room.code} · ${room.game.sales.length}/${room.game.totalPlayers} drafted</div><h1 class="gap-top">${esc(memberName(room.me))}</h1></div><div><div class="hint">Your budget</div><div class="budget">${money(myBudget())}</div></div></div><nav class="tabs" aria-label="Game sections">${[['auction', '◎ Auction'], ['teams', '▣ Teams'], ['transfers', '⇄ Transfers'], ['league', '♜ League']].map(([id, label]) => `<button data-do="tab" data-id="${id}" class="${tab === id ? 'active' : ''}" aria-current="${tab === id ? 'page' : 'false'}">${label}</button>`).join('')}</nav>`; }
  function auctionScreen() {
    const round = room.round, player = round && entry(round.playerId), spinning = round?.status === 'open' && clock() < round.opensAt;
    const open = round?.status === 'open', out = round?.withdrawn.includes(room.me), leader = round?.leader;
    const allowed = open && !spinning && !out && !myFull() && connected && !busy && !(round.deadline && clock() >= round.deadline);
    const min = leader ? leader.price + 1 : 0;
    const ended = round && !open;
    return `<div class="auction-layout"><div class="stack"><section class="panel player-card">${!player ? `${wheel(false)}<div class="eyebrow">The pool is a secret</div><h2>${room.status === 'complete' ? 'Every XI is drafted' : 'Who will you sign?'}</h2><p>${room.isHost ? 'Reveal the first player when everyone is ready.' : 'Your host will reveal the first player.'}</p>` : spinning ? `${wheel(true)}<div class="eyebrow">Finding your next signing</div><h2>Who’s it going to be?</h2><p>No peeking at the next player.</p>` : `<div class="player-symbol">${esc(player.player.positions[0])}</div><div class="eyebrow">${ended ? round.status === 'sold' ? 'SIGNED' : 'UNSOLD · BACK IN THE POOL' : 'UP FOR AUCTION'}</div><h2>${esc(player.player.name)}</h2><div class="player-meta"><span class="pill">${esc(player.club?.name)} · ${esc(player.season.season)}</span><span class="pill">${esc(player.player.positions.join(' / '))}</span>${showRatings ? `<span class="rating">${rating(player)}</span>` : ''}</div>${ended ? `<p>${round.status === 'sold' ? `${esc(memberName(round.winnerId))} signed them for <strong>${money(round.price)}</strong>` : 'Nobody signed this player.'}</p>` : ''}`}</section><section class="panel stack"><div class="row"><h3>Managers in the auction</h3><span class="hint">${room.members.length} managers</span></div><div class="bidders">${room.members.map(member => { const full = AuctionCore.purchases(room.game, member.managerId).length >= 11, withdrew = round?.withdrawn.includes(member.managerId); return `<div class="bidder ${leader?.managerId === member.managerId && open ? 'leader' : ''} ${full || withdrew ? 'out' : ''}"><strong>${esc(member.name)}</strong> · ${full ? 'XI full' : withdrew ? 'Out' : leader?.managerId === member.managerId && open ? 'Leading' : 'In'}<br>${money(AuctionCore.budget(room.game, member.managerId))} left</div>`; }).join('')}</div>${round?.bids.length && !spinning ? `<details><summary class="hint">Recent bids</summary>${round.bids.slice().reverse().map(bid => `<div class="sale-row"><span>${esc(memberName(bid.managerId))}${round.withdrawn.includes(bid.managerId) ? ' · withdrawn' : ''}</span><strong>${money(bid.price)}</strong></div>`).join('')}</details>` : ''}</section></div><section class="panel bid-panel"><div class="row"><div><div class="hint">${open ? 'Current highest bid' : 'Last sale'}</div><div class="bid-price">${open && leader ? money(leader.price) : ended && round.status === 'sold' ? money(round.price) : '—'}</div><p>${open && leader ? esc(memberName(leader.managerId)) : open ? 'Be the first to bid' : 'Ready for the next player'}</p></div><div id="timer" class="timer">${open ? round.deadline ? '1:00' : 'Waiting' : 'Ended'}</div></div>${open ? `<form id="bid-form" class="bid-form"><label for="bid-value" class="label">Your bid (£m)</label><input id="bid-value" inputmode="decimal" type="number" min="${min / 10}" max="${myBudget() / 10}" step="0.1" placeholder="${min / 10}" value="${esc(bidText)}" ${disabled(!allowed)}><div class="increments">${[1, 5, 10].map(value => `<button type="button" data-do="increment" data-id="${value}" ${disabled(!allowed)}>+£${value}m</button>`).join('')}</div><button class="primary" ${disabled(!allowed)}>Place bid${leader?.managerId === room.me ? ' · you’re leading' : ''}</button><button type="button" class="quiet danger" data-do="withdraw" ${disabled(!allowed)}>${out ? 'You’re out for this player' : myFull() ? 'Your XI is full' : 'Back out for this player'}</button><p class="hint">First bid starts 60 seconds. Every later bid adds 10 seconds. Backing out removes your bids; you cannot re-enter this player’s auction.</p><p class="hint">${out ? 'You can bid again when the next player appears.' : 'The last manager in wins at their current bid. Otherwise, the highest active bid wins when time runs out.'}</p></form>` : `<p>${room.status === 'complete' ? 'Arrange everyone’s XI, review your bargains and big spends, then start the league.' : room.isHost ? 'Keep everyone guessing. Reveal the next player when you’re ready.' : 'Waiting for your host to reveal the next player.'}</p>`}${room.isHost && room.status === 'draft' ? `<button class="${open ? 'quiet' : 'primary'}" data-do="${open ? 'skip' : 'reveal'}" ${disabled(!connected || busy || open && !!leader || spinning)}>${open ? 'Skip unsold player' : 'Reveal next player →'}</button>` : ''}${room.status === 'complete' ? '<button data-do="tab" data-id="teams">Arrange your XI →</button><button class="primary" data-do="tab" data-id="league">Bargains & league →</button>' : ''}</section></div>${roomFooter()}`;
  }
  function teamsScreen() {
    if (!room.game.managers.some(manager => manager.id === teamId)) teamId = room.me;
    const manager = room.game.managers.find(manager => manager.id === teamId), own = teamId === room.me, editable = own && !room.league;
    const team = LeagueCore.team(room.game, manager), sales = AuctionCore.purchases(room.game, teamId);
    if (!sales.some(sale => sale.playerId === selected) || !editable) selected = null;
    const paid = id => sales.find(sale => sale.playerId === id)?.price || 0;
    return `<div class="team-picker">${room.game.managers.map(manager => `<button data-do="team" data-id="${manager.id}" class="${teamId === manager.id ? 'selected' : ''}">${esc(manager.name)}${manager.id === room.me ? ' · You' : ''}</button>`).join('')}</div><div class="team-layout"><section class="panel stack"><div class="row"><h2>${esc(manager.name)}’s XI</h2><span class="pill">${esc(room.game.config.formation)}</span></div>${showRatings ? `<div class="stat-grid">${[['Attack', team.attack], ['Midfield', team.midfield], ['Defence', team.defence], ['GK', team.goalkeeping]].map(([label, value]) => `<div class="stat"><strong>${value || '—'}</strong>${label}</div>`).join('')}</div>` : ''}<div class="pitch"><div class="circle"></div><div class="box top-box"></div><div class="box bottom-box"></div>${DraftCore.formations[room.game.config.formation].map((slot, index) => { const player = entry(manager.board[index]); return `<button class="slot ${player && LeagueCore.fitMultiplier(slot.position, player.player.positions) === .93 ? 'misplaced' : ''} ${player?.id === selected ? 'selected' : ''}" style="left:${slot.x}%;top:${slot.y}%" data-do="slot" data-id="${index}" ${disabled(!editable || !connected || busy)} aria-label="${esc(slot.position)}: ${esc(player?.player.name || 'Empty slot')}"><span class="role">${slot.position}</span><span class="name">${player ? esc(player.player.name) : '+'}</span>${player ? `<span class="paid">${money(paid(player.id))}</span>${showRatings ? `<span class="small-rating"> · ${rating(player)}</span>` : ''}` : ''}</button>`; }).join('')}</div><p class="hint">${room.league ? 'Starting XIs are locked for the league.' : own ? selected ? `${esc(entry(selected).player.name)} selected. Tap any position to place or swap.` : 'Tap a squad player, then tap a position to place or swap them.' : 'You can view this XI. Only its manager can move players.'} Orange outlines show an unfamiliar position.</p></section><section class="panel stack"><div class="row"><h2>The squad</h2><span class="pill">${sales.length}/11 · ${money(AuctionCore.budget(room.game, teamId))} left</span></div>${editable ? `<div class="actions"><button data-do="autoPlace" ${disabled(!connected || busy || !sales.length)}>Arrange automatically</button>${selected ? `<button class="quiet" data-do="unplace" data-id="${esc(selected)}" ${disabled(!connected || busy)}>Take off pitch</button>` : ''}</div>` : ''}<div class="squad-list">${sales.map(sale => { const player = entry(sale.playerId), placed = manager.board.includes(player.id); return `<button class="squad-player ${player.id === selected ? 'selected' : ''} ${placed ? 'placed' : ''}" data-do="select-player" data-id="${esc(player.id)}" ${disabled(!editable)}><span><strong>${esc(player.player.name)}</strong><small>${esc(player.player.positions.join(' / '))} · ${esc(player.season.season)}${placed ? ' · On pitch' : ''}</small></span><span>${money(sale.price)}${showRatings ? `<small> · ${rating(player)}</small>` : ''}</span></button>`; }).join('') || '<div class="empty">Your first signing is waiting in the auction.</div>'}</div>${showRatings ? `<p class="hint">Team overall: ${team.overall || '—'}. Positions affect team strength in the league.</p>` : ''}</section></div>`;
  }
  function transfersScreen() { return `<section class="panel stack"><div class="row"><h2>Transfer board</h2><span class="pill">${room.game.sales.length} signings</span></div><p>Every deal, ordered from the biggest fee to the smallest.</p><div>${room.game.sales.slice().sort((a, b) => b.price - a.price).map((sale, i) => { const player = entry(sale.playerId); return `<div class="sale-row"><span class="muted">${i + 1}</span><div style="flex:1"><strong>${esc(player.player.name)} ${showRatings ? `<span class="rating">${rating(player)}</span>` : ''}</strong><small>${esc(memberName(sale.managerId))} · ${esc(player.player.positions.join(' / '))} · ${esc(player.season.season)}</small></div><span class="price">${money(sale.price)}</span><button class="quiet" data-do="team" data-id="${sale.managerId}" aria-label="View ${esc(memberName(sale.managerId))}’s team">XI</button></div>`; }).join('') || '<div class="empty">No deals yet. The auction is where it all starts.</div>'}</div></section>`; }
  function leagueScreen() {
    const game = room.game;
    if (room.status !== 'complete') return `<section class="panel stack"><div class="eyebrow">After the auction</div><h2>Your league is coming</h2><p>Once all ${game.totalPlayers} players are signed, we’ll reveal the bargains and big spends. Arrange every XI, then everyone plays each other home and away.</p><button data-do="tab" data-id="auction">Back to the auction</button></section>`;
    const awards = LeagueCore.awards(game), check = LeagueCore.readiness(game), league = room.league, count = league ? LeagueCore.roundCount(league) : 0;
    const playerAward = (label, sale) => `<div class="award"><div class="eyebrow">${label}</div><strong>${esc(entry(sale.playerId).player.name)}</strong><p>${esc(memberName(sale.managerId))} · ${money(sale.price)}</p>${showRatings ? `<span class="pill">${sale.rating} rated</span>` : ''}</div>`;
    const report = `<div class="grid">${playerAward('Bargain of the draft', awards.bargain)}${playerAward('Biggest signing', awards.biggestBuy)}<div class="award wide"><div class="eyebrow">Biggest spender</div><strong>${esc(awards.biggestSpender.name)}</strong><p>${money(awards.biggestSpender.spent)} spent on their XI</p><p class="hint gap-top">Bargains compare each fee with a share of the total spend weighted by player rating.</p></div></div>`;
    if (!league) return `<div class="stack">${report}<section class="panel stack"><h2>Meet the teams</h2>${game.managers.map(manager => { const team = LeagueCore.team(game, manager); return `<div class="sale-row"><div><strong>${esc(manager.name)}</strong><small>${team.placed}/11 placed · ${money(team.spent)} spent${showRatings ? ` · ${team.overall} overall` : ''}</small></div><button data-do="team" data-id="${manager.id}">View XI</button></div>`; }).join('')}<p>${esc(check.message)}</p>${room.isHost ? `<button class="primary" data-do="startLeague" ${disabled(!check.ready || !connected || busy)}>Start the home & away league →</button>` : '<p class="hint">The host will start once everyone has placed their XI.</p>'}</section></div>`;
    const finished = league.round >= count, rows = LeagueCore.table(league);
    const scorers = new Map(); for (const fixture of league.fixtures) if (fixture.result) for (const scorer of [...fixture.result.homeScorers, ...fixture.result.awayScorers]) { const value = scorers.get(scorer.playerId) || { name: scorer.name, goals: 0 }; value.goals++; scorers.set(scorer.playerId, value); }
    return `<div class="stack"><section class="panel stack"><div class="row"><div><div class="eyebrow">${finished ? 'Season complete' : `Matchday ${league.round}/${count}`}</div><h2 class="gap-top">${finished ? `${esc(rows[0].name)} are champions!` : 'The league table'}</h2></div><span class="pill">Home & away · 3 points for a win</span></div><div class="scroll-table"><table><thead><tr><th>#</th><th>Manager</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>GD</th><th>Pts</th></tr></thead><tbody>${rows.map((row, i) => `<tr><td>${i + 1}</td><td>${esc(row.name)}</td>${['played', 'won', 'drawn', 'lost', 'gf', 'ga', 'gd'].map(key => `<td>${row[key]}</td>`).join('')}<td class="points">${row.points}</td></tr>`).join('')}</tbody></table></div>${room.isHost && !finished ? `<div class="actions"><button class="primary" data-do="playRound" ${disabled(!connected || busy)}>Play matchday ${league.round + 1} →</button><button class="quiet" data-do="finishLeague" ${disabled(!connected || busy)}>Simulate remaining season</button></div>` : !finished ? '<p class="hint">Your host plays the next matchday. Results update live for everyone.</p>' : ''}</section><section class="panel stack"><h2>Fixtures & results</h2>${Array.from({ length: count }, (_, round) => `<details ${round === Math.max(0, league.round - 1) ? 'open' : ''}><summary>Matchday ${round + 1}${round >= league.round ? ' · Upcoming' : ''}</summary>${league.fixtures.filter(fixture => fixture.round === round).map(fixture => { const result = fixture.result; return `<div class="fixture"><div class="row"><span class="team-name">${esc(memberName(fixture.homeId))}</span><span class="score">${result ? `${result.homeGoals} – ${result.awayGoals}` : 'vs'}</span><span class="team-name">${esc(memberName(fixture.awayId))}</span></div>${result ? `<small>${result.homeScorers.map(scorer => `${esc(scorer.name)} ${scorer.minute}′`).join(', ') || '—'}<br>${result.awayScorers.map(scorer => `${esc(scorer.name)} ${scorer.minute}′`).join(', ') || '—'}</small>` : ''}</div>`; }).join('')}</details>`).join('')}</section>${scorers.size ? `<section class="panel stack"><h2>Golden boot</h2>${[...scorers.values()].sort((a, b) => b.goals - a.goals).slice(0, 10).map(scorer => `<div class="sale-row"><strong>${esc(scorer.name)}</strong><span class="price">${scorer.goals} goals</span></div>`).join('')}</section>` : ''}<details><summary>Bargains & big spends</summary><div class="gap-top">${report}</div></details></div>`;
  }
  function render() {
    const focus = document.activeElement, focusId = focus?.id, value = focus && ['INPUT', 'SELECT'].includes(focus.tagName) ? focus.value : null;
    const caret = focus?.tagName === 'INPUT' && ['text', 'search'].includes(focus.type) ? [focus.selectionStart, focus.selectionEnd] : null;
    $('#rating-toggle').hidden = !room?.game; $('#rating-toggle').textContent = showRatings ? 'Hide ratings' : 'Show ratings';
    connection();
    $('#app').innerHTML = !room ? screen === 'setup' ? setup() : home() : room.status === 'lobby' ? lobby() : navigation() + ({ auction: auctionScreen, teams: teamsScreen, transfers: transfersScreen, league: leagueScreen }[tab] || auctionScreen)();
    if (room?.league && tab === 'league') {
      $('.scroll-table').classList.toggle('full-table', fullStats);
      $('.scroll-table').insertAdjacentHTML('afterend', `<button class="quiet mobile-stats" data-do="table-stats">${fullStats ? 'Show compact table' : 'Show full stats'}</button>`);
    }
    if (focusId) { const next = document.getElementById(focusId); if (next && !next.disabled) { if (value !== null) next.value = value; next.focus({ preventScroll: true }); if (caret) next.setSelectionRange(...caret); } }
    updateTimer();
  }
  function updateTimer() {
    const round = room?.round;
    if (round?.status === 'open' && clock() >= round.opensAt && revealDrawn !== round.id) { revealDrawn = round.id; if (tab === 'auction') render(); return; }
    const timer = $('#timer'); if (!timer || !round) return;
    const seconds = round.deadline ? Math.max(0, Math.ceil((round.deadline - clock()) / 1000)) : null;
    timer.textContent = round.status !== 'open' ? 'Ended' : clock() < round.opensAt ? 'Revealing' : seconds === null ? 'Waiting' : seconds === 0 ? 'Settling…' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    timer.classList.toggle('urgent', seconds !== null && seconds <= 10 && round.status === 'open');
    if (seconds === 0) $('#bid-form')?.querySelectorAll('button,input').forEach(element => { element.disabled = true; });
  }
  $('#rating-toggle').addEventListener('click', () => { showRatings = !showRatings; storage.set('ratings', showRatings ? 'show' : 'hide'); render(); });
  $('#app').addEventListener('input', event => {
    if (event.target.id === 'bid-value') bidText = event.target.value;
    if (['season-from', 'season-to', 'rating-min', 'rating-max'].includes(event.target.id)) {
      const seasonInput = event.target.id.startsWith('season'), low = $(seasonInput ? '#season-from' : '#rating-min'), high = $(seasonInput ? '#season-to' : '#rating-max');
      if (+low.value > +high.value) (event.target === low ? high : low).value = event.target.value;
      $(seasonInput ? '#season-label' : '#rating-label').textContent = seasonInput ? `${seasons[+low.value]} – ${seasons[+high.value]}` : `${low.value} – ${high.value}`;
    }
  });
  $('#app').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.target;
    if (form.id === 'bid-form') {
      const value = $('#bid-value').value, price = Math.round(Number(value) * 10);
      if (value === '' || !Number.isFinite(Number(value)) || Math.abs(Number(value) * 10 - price) > .00001) return toast('Enter a bid in £0.1m increments.');
      return action('bid', { price });
    }
    if (busy) return;
    const data = new FormData(form), displayName = String(data.get('name') || '').trim(); storage.set('name', displayName);
    let body;
    if (form.id === 'join-form') body = { name: displayName, code: String(data.get('code') || '') };
    else if (form.id === 'create-form') body = { name: displayName, capacity: +data.get('capacity'), config: { formation: data.get('formation'), mode: data.get('mode'), seasonFrom: seasons[+data.get('seasonFrom')], seasonTo: seasons[+data.get('seasonTo')], ratingMin: +data.get('ratingMin'), ratingMax: +data.get('ratingMax') } };
    else return;
    busy = true; form.querySelector('button[type=submit],button:not([type])').disabled = true;
    try { await api(form.id === 'join-form' ? '/api/join' : '/api/create', body); connect(); }
    catch (error) { toast(error.message); }
    finally { busy = false; if (room) render(); else form.querySelector('button[type=submit],button:not([type])').disabled = false; }
  });
  $('#app').addEventListener('click', async event => {
    const button = event.target.closest('[data-do]'); if (!button || button.disabled) return;
    const type = button.dataset.do, id = button.dataset.id;
    if (type === 'setup' || type === 'home') { screen = type; render(); return; }
    if (type === 'tab') { tab = id; render(); window.scrollTo({ top: 0 }); return; }
    if (type === 'table-stats') { fullStats = !fullStats; render(); return; }
    if (type === 'team') { teamId = id; tab = 'teams'; selected = null; render(); window.scrollTo({ top: 0 }); return; }
    if (type === 'select-player') { selected = selected === id ? null : id; render(); return; }
    if (type === 'slot') { if (selected) return action('place', { playerId: selected, slot: +id }); const manager = room.game.managers.find(manager => manager.id === teamId); selected = manager.board[+id]; render(); return; }
    if (type === 'unplace') return action(type, { playerId: id });
    if (type === 'increment') { const floor = room.round.leader ? room.round.leader.price : 0, value = bidText === '' ? floor : Math.round(Number(bidText) * 10); bidText = ((Math.max(floor, value) + +id * 10) / 10).toFixed(1); $('#bid-value').value = bidText; return; }
    if (type === 'copy-code' || type === 'share') {
      const url = `${location.origin}/?code=${room.code}`;
      try { if (type === 'share' && navigator.share) await navigator.share({ title: 'Join my Touchline auction', text: `Room ${room.code}`, url }); else { await navigator.clipboard.writeText(type === 'share' ? url : room.code); toast(type === 'share' ? 'Invite link copied' : 'Room code copied'); } } catch (error) { if (error.name !== 'AbortError') toast(`Room ${room.code} · ${url}`); }
      return;
    }
    if (type === 'leave') { clearTimeout(reconnectTimer); if (socket) { socket.onclose = null; socket.close(); } socket = null; room = null; connected = false; storage.set('room', null); screen = 'home'; render(); return; }
    if (type === 'ready') return action(type, { ready: !room.members.find(member => member.managerId === room.me).ready });
    if (type === 'kick') return action(type, { managerId: id });
    if (type === 'transferHost') return action(type, { managerId: $('#next-host').value });
    return action(type);
  });
  async function init() {
    try {
      const results = await Promise.all([api('/api/session', {}), api('/api/options')]); seasons = results[1].seasons;
      const id = storage.get('room');
      if (id) { try { await api(`/api/room/${id}`); connect(); } catch (error) { if ([403, 404].includes(error.status)) storage.set('room', null); toast(error.message); } }
      render();
    } catch (error) { $('#app').innerHTML = `<div class="panel stack error-panel"><h2>Couldn’t reach the game server</h2><p>${esc(error.message)}</p><p>Online play needs the Node server. Locally, run <strong>npm start</strong> and open <a href="http://localhost:4174">localhost:4174</a>.</p><button onclick="location.reload()">Try again</button></div>`; }
  }
  setInterval(updateTimer, 200);
  setInterval(() => { if (room && connected) api('/api/clock').catch(() => {}); }, 30000);
  window.addEventListener('online', () => { if (room && !connected) connect(); });
  init();
})();
