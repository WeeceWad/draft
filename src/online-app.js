(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = price => price >= 1000 ? `£${+(price / 1000).toFixed(3)}bn` : `£${price}m`;
  const sound = globalThis.TouchlineSound;
  const lines = { GK: 'gk', CB: 'def', LB: 'def', RB: 'def', LWB: 'def', RWB: 'def', CDM: 'mid', CM: 'mid', CAM: 'mid', LM: 'mid', RM: 'mid', LW: 'att', RW: 'att', ST: 'att' };
  const line = position => lines[position] || 'mid';
  const positions = list => `<span class="pos-list">${list.map(position => `<span class="pos pos-${line(position)}">${esc(position)}</span>`).join('')}</span>`;
  const storage = { get(key) { try { return localStorage.getItem(`touchline-online-${key}`); } catch { return null; } }, set(key, value) { try { value === null ? localStorage.removeItem(`touchline-online-${key}`) : localStorage.setItem(`touchline-online-${key}`, value); } catch {} } };
  let allFixtures = false, resumable = null, rulesDraft = null, room = null, socket = null, connected = false, busy = false, retry = 0, reconnectTimer = null, screen = 'home', tab = 'auction', teamId = null, selectedSlot = null, drag = null, suppressClick = false, liveKey = null, shownMinute = -1, liveGoals = 0, summaryPending = false, watchFixture = null, frame = null, timelines = new Map(), bidText = '', offset = 0, seasons = [], revealDrawn = null;
  let showRatings = true;
  let fullStats = false;
  const clock = () => Date.now() + offset;
  const memberName = id => room?.members.find(member => member.managerId === id)?.name || 'Manager';
  const teamName = id => room?.league?.teams.find(team => team.id === id)?.name || memberName(id);
  const premier = () => room?.league?.competition === 'premier' || room?.config?.competition === 'premier';
  const isManager = id => !!room?.game?.managers.some(manager => manager.id === id);
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
    const previous = room?.id === next.id ? room : null;
    const newRound = room?.round?.id !== next.round?.id;
    const first = room?.id !== next.id;
    const leaderMoved = newRound || previous?.round?.leader?.price !== next.round?.leader?.price;
    room = next; storage.set('room', room.id); resumable = null;
    try { sessionStorage.setItem('touchline-online-tab-room', room.id); } catch {}
    if (newRound) revealDrawn = null;
    // Keep the bid box one million above the highest bid, unless a higher bid is already typed.
    showRatings = next.showRatings !== false;
    if (leaderMoved) { const min = minBid(next); if (newRound || !(Number(bidText) >= min)) bidText = String(min); }
    if (previous) cue(previous.round, next.round);
    if (previous && !previous.next && next.next && next.finished) setTimeout(followNext, 0);
    if (first) { teamId = room.me; selectedSlot = null; tab = room.status === 'complete' ? 'league' : 'auction'; history.replaceState(null, '', `/?code=${room.code}`); }
    if (room.status === 'complete' && (newRound || previous?.status === 'lobby')) tab = 'league';
    if (previous && next.league && (!previous.league || previous.league.round !== next.league.round)) tab = 'league';
    if (room.finished && (first || !previous?.finished)) { if (liveNow()) { summaryPending = true; tab = 'league'; } else tab = 'summary'; }
    render();
  }
  // Bids start at £1m. £0 only works for a manager with no money left, once everyone else is out.
  function minBid(state) {
    if (state?.round?.leader) return state.round.leader.price + 1;
    return state?.game && AuctionCore.budget(state.game, state.me) === 0 ? 0 : 1;
  }
  function blockedReason(managerId, keeper) {
    if (AuctionCore.purchases(room.game, managerId).length >= 11) return 'Your XI is full';
    return keeper ? 'You already have a goalkeeper' : 'Your last spot is saved for a goalkeeper';
  }
  function cue(before, after) {
    if (!after) return;
    if (before?.id !== after.id) { if (after.status === 'open' && clock() < after.opensAt) sound.spin(Math.max(.3, (after.opensAt - clock()) / 1000)); return; }
    const last = after.bids.at(-1), prior = before.bids.at(-1);
    if (last && (!prior || last.at !== prior.at || last.managerId !== prior.managerId || last.price !== prior.price)) sound.bid(last.managerId === room.me);
    if (before.status === 'open' && after.status === 'sold') sound.sold(after.winnerId === room.me);
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
  function rules(config) { return `<div class="rules stack">${config.devMode ? '<p class="pill green">Dev mode · the auction is skipped and XIs are picked automatically</p>' : ''}<div class="row"><span>Seasons</span><strong>${esc(config.seasonFrom)} – ${esc(config.seasonTo)}</strong></div><div class="row"><span>${config.mode === 'peak' ? 'Peak overall' : 'Season'} rating</span><strong>${config.ratingMin} – ${config.ratingMax}</strong></div><div class="row"><span>League</span><strong>${config.competition === 'premier' ? 'Premier League · 20 teams' : 'Just us · home & away'}</strong></div><div class="row"><span>Formation</span><strong>${config.formation === DraftCore.FREE ? 'Free · each manager picks' : esc(config.formation)}</strong></div><p>£1bn each · 11 players each · bids from £1m in whole millions · 60 seconds from the first bid · +10 seconds per new bid · the highest bidder is locked in. The host can change these in the lobby. They lock when the auction starts.</p></div>`; }
  function home() {
    const code = new URLSearchParams(location.search).get('code') || '';
    return `<div class="hero"><div class="eyebrow">A room. A budget. Your best XI.</div><h1 class="gap-top">Build your team.<br>Beat your mates.</h1><p>A live football auction, straight from your phone. Draft legends, outbid your friends, then play a league together.</p></div>${resumable ? `<section class="panel resume-card"><div><div class="eyebrow">Continue where you left off</div><h2>Room ${esc(resumable.code)}</h2><p>${esc(resumable.label)}</p></div><div class="actions"><button class="primary" data-do="resume" ${disabled(busy)}>Rejoin room →</button><button class="quiet" data-do="forget">Forget it</button></div></section>` : ''}<div class="grid home-panels"><section class="panel stack"><div class="eyebrow">You set the rules</div><h2>Host an auction</h2><p>Choose your player pool, share a four-digit code and get everyone ready.</p><button class="primary" data-do="setup">Create room →</button></section><form id="join-form" class="panel stack"><div class="eyebrow">Got an invite?</div><h2>Join your friends</h2><div class="field"><label for="join-name">Your manager name</label><input id="join-name" name="name" maxlength="24" required autocomplete="nickname" value="${esc(storage.get('name') || '')}" placeholder="e.g. Alex"></div><div class="field"><label for="join-code">Room code</label><input class="code-input" id="join-code" name="code" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required value="${esc(/^\d{4}$/.test(code) ? code : '')}" placeholder="0000" autocomplete="off"></div><button class="primary" ${disabled(busy)}>Join room →</button></form><p class="wide hint">Each manager needs their own browser or device. Already playing? Use the same browser to rejoin with your saved team. <a href="/offline.html">Play the local version</a>.</p></div>`;
  }
  // The same rule controls create a room and, for the host, edit it in the lobby.
  function ruleFields(values, minimum = 2) {
    const from = Math.max(0, seasons.indexOf(values.seasonFrom)), to = Math.max(0, seasons.indexOf(values.seasonTo));
    return `<div class="grid"><div class="field"><label for="capacity">Number of managers</label><select id="capacity" name="capacity">${Array.from({ length: 7 }, (_, i) => i + 2).map(count => `<option value="${count}" ${count === values.capacity ? 'selected' : ''} ${count < minimum ? 'disabled' : ''}>${count} managers · ${count * 11} players</option>`).join('')}</select></div><div class="field"><label for="formation">Starting formation</label><select id="formation" name="formation">${[DraftCore.FREE, ...Object.keys(DraftCore.formations)].map(value => `<option value="${esc(value)}" ${value === values.formation ? 'selected' : ''}>${value === DraftCore.FREE ? 'Free (each manager picks)' : esc(value)}</option>`).join('')}</select></div><div class="field"><label for="competition">League format</label><select id="competition" name="competition"><option value="friends" ${values.competition !== 'premier' ? 'selected' : ''}>Just us · home &amp; away</option><option value="premier" ${values.competition === 'premier' ? 'selected' : ''}>Premier League · 20 teams with 38-0's clubs</option></select></div><div class="field"><label for="mode">Rating type</label><select id="mode" name="mode"><option value="peak" ${values.mode === 'peak' ? 'selected' : ''}>Peak overall rating</option><option value="season" ${values.mode === 'season' ? 'selected' : ''}>Rating in the selected season</option></select></div></div><div class="slider-grid"><div class="sliders"><div class="row"><span class="label">Season range</span><strong id="season-label">${esc(seasons[from])} – ${esc(seasons[to])}</strong></div><div class="range-pair"><label>From<input id="season-from" type="range" name="seasonFrom" min="0" max="${seasons.length - 1}" value="${from}"></label><label>To<input id="season-to" type="range" name="seasonTo" min="0" max="${seasons.length - 1}" value="${to}"></label></div></div><div class="sliders"><div class="row"><span class="label">Rating range</span><strong id="rating-label">${values.ratingMin} – ${values.ratingMax}</strong></div><div class="range-pair"><label>Minimum<input id="rating-min" type="range" name="ratingMin" min="40" max="95" value="${values.ratingMin}"></label><label>Maximum<input id="rating-max" type="range" name="ratingMax" min="40" max="95" value="${values.ratingMax}"></label></div></div></div><label class="check"><input type="checkbox" name="devMode" ${values.devMode ? 'checked' : ''}><span><strong>Dev mode</strong> · skip the auction. Every manager gets a full XI in the right positions, so you can go straight to the league.</span></label>`;
  }
  const readRules = form => { const data = new FormData(form); return { capacity: +data.get('capacity'), formation: data.get('formation'), mode: data.get('mode'), seasonFrom: seasons[+data.get('seasonFrom')], seasonTo: seasons[+data.get('seasonTo')], ratingMin: +data.get('ratingMin'), ratingMax: +data.get('ratingMax'), devMode: data.get('devMode') === 'on', competition: data.get('competition') === 'premier' ? 'premier' : 'friends' }; };
  const ruleKeys = ['capacity', 'formation', 'mode', 'seasonFrom', 'seasonTo', 'ratingMin', 'ratingMax', 'devMode', 'competition'];
  const savedRules = () => ({ capacity: room.capacity, ...room.config, devMode: room.config.devMode === true, competition: room.config.competition === 'premier' ? 'premier' : 'friends' });
  const matchesRoom = values => ruleKeys.every(key => values[key] === savedRules()[key]);
  function lobbyRules() {
    if (!room.isHost) return rules(room.config);
    const values = rulesDraft || savedRules(), changed = !!rulesDraft && !matchesRoom(rulesDraft);
    return `<form id="rules-form" class="stack rules-form"><div class="row"><h2>Room rules</h2>${changed ? '<span class="pill">Unsaved changes</span>' : ''}</div>${ruleFields(values, room.members.length)}<div class="actions"><button class="primary" ${disabled(!changed || !connected || busy)}>Save rules</button>${changed ? '<button type="button" class="quiet" data-do="discard-rules">Discard</button>' : ''}</div><p class="hint">£1bn each · 11 players each · bids from £1m · 60 seconds from the first bid, +10 per bid. Saving new rules asks everyone to ready up again.</p></form>`;
  }
  function setup() {
    return `<div class="settings stack"><div class="row"><div><div class="eyebrow">Before kick-off</div><h1 class="gap-top">Your auction rules</h1></div><button class="quiet" data-do="home">Back</button></div><form id="create-form" class="panel stack"><div class="field"><label for="host-name">Your manager name</label><input id="host-name" name="name" maxlength="24" required autocomplete="nickname" value="${esc(storage.get('name') || '')}" placeholder="e.g. Alex"></div>${ruleFields({ capacity: 3, competition: 'friends', formation: Object.keys(DraftCore.formations)[0], mode: 'peak', seasonFrom: seasons[0], seasonTo: seasons.at(-1), ratingMin: 40, ratingMax: 95 })}<p class="hint">The server selects a hidden, balanced pool with enough players for the chosen formation, including one goalkeeper per manager. These rules stay fixed for the game.</p><button class="primary" ${disabled(busy)}>Create room & get your code →</button></form></div>`;
  }
  function lobby() {
    const me = room.members.find(member => member.managerId === room.me), allReady = room.members.length === room.capacity && room.members.every(member => member.ready);
    return `<div class="room-head row"><div><div class="eyebrow">The dressing room</div><h1 class="gap-top">Waiting for your managers</h1></div><span class="pill">${room.members.length}/${room.capacity} joined</span></div><div class="grid lobby-grid"><section class="panel stack"><h2>Share your room code</h2><div class="big-code">${room.code}</div><div class="actions"><button data-do="copy-code">Copy code</button><button data-do="share">Share invite</button></div><p class="hint">Open this game on another device and enter the code. The room lasts 24 hours.</p></section><section class="panel stack"><h2>Your managers</h2><div>${room.members.map(member => `<div class="member"><div class="avatar">${esc(member.name.slice(0, 1).toUpperCase())}</div><div class="grow"><strong>${esc(member.name)}${member.managerId === room.me ? ' (you)' : ''}</strong><small>${member.isHost ? 'Host · ' : ''}${member.ready ? 'Ready to draft' : 'Not ready yet'}</small></div>${room.isHost && member.managerId !== room.me ? `<button class="quiet danger" data-do="kick" data-id="${member.managerId}" aria-label="Remove ${esc(member.name)}">×</button>` : `<span class="pill ${member.ready ? 'green' : ''}">${member.ready ? 'Ready' : 'Waiting'}</span>`}</div>`).join('')}</div><button class="${me.ready ? 'quiet' : 'primary'}" data-do="ready" ${disabled(!connected || busy)}>${me.ready ? 'Not ready' : 'I’m ready'}</button>${room.isHost ? `<button class="primary" data-do="start" ${disabled(!allReady || !connected || busy)}>Start the auction →</button><p class="hint">Everyone must join and be ready before you start.</p>` : '<p class="hint">Your host starts once everyone is ready.</p>'}</section></div><section class="panel stack lobby-rules">${room.isHost ? lobbyRules() : `<h2>Room rules</h2>${rules(room.config)}`}</section>${roomFooter()}`;
  }
  function roomFooter() { return `<details class="gap-top"><summary class="hint">Room options</summary><div class="footer-actions"><button class="quiet" data-do="leave">Return to home</button>${room.isHost ? `<select id="next-host" aria-label="Choose next host">${room.members.filter(member => member.managerId !== room.me).map(member => `<option value="${member.managerId}">${esc(member.name)}</option>`).join('')}</select><button class="quiet" data-do="transferHost" ${disabled(!connected || busy || room.members.length < 2)}>Hand over host</button>` : ''}</div><p class="hint gap-top">Leaving this page keeps your place in the room. Closing the browser does not withdraw a live bid. Hand over hosting before the host leaves.</p></details>`; }
  function navigation() { return `<div class="room-head row"><div><div class="eyebrow">ROOM ${room.code} · ${room.game.sales.length}/${room.game.totalPlayers} drafted</div><h1 class="gap-top">${esc(memberName(room.me))}</h1></div><div><div class="hint">Your budget</div><div class="budget">${money(myBudget())}</div></div></div><nav class="tabs" aria-label="Game sections">${[['auction', '◎ Auction'], ['teams', '▣ Teams'], ['transfers', '⇄ Transfers'], ['league', '♜ League'], ...(room.finished ? [['summary', '★ Summary']] : [])].map(([id, label]) => `<button data-do="tab" data-id="${id}" class="${tab === id ? 'active' : ''}" aria-current="${tab === id ? 'page' : 'false'}">${label}</button>`).join('')}</nav>`; }
  function auctionScreen() {
    const round = room.round, player = round && entry(round.playerId), spinning = round?.status === 'open' && clock() < round.opensAt;
    const open = round?.status === 'open', out = round?.withdrawn.includes(room.me), leader = round?.leader;
    const keeper = !!player?.player.positions.includes('GK'), blocked = open && !out && !round.active.includes(room.me) ? blockedReason(room.me, keeper) : null;
    const allowed = open && !spinning && !out && !blocked && leader?.managerId !== room.me && connected && !busy && !(round.deadline && clock() >= round.deadline);
    const min = minBid(room), locked = open && leader?.managerId === room.me, broke = myBudget() === 0 && !myFull();
    const ended = round && !open;
    return `<div class="auction-layout"><div class="stack"><section class="panel player-card">${!player ? `${wheel(false)}<div class="eyebrow">The pool is a secret</div><h2>${room.status === 'complete' ? 'Every XI is drafted' : 'Who will you sign?'}</h2><p>${room.isHost ? 'Reveal the first player when everyone is ready.' : 'Your host will reveal the first player.'}</p>` : spinning ? `${wheel(true)}<div class="eyebrow">Finding your next signing</div><h2>Who’s it going to be?</h2><p>No peeking at the next player.</p>` : `<div class="player-symbol line-${line(player.player.positions[0])}">${esc(player.player.positions[0])}</div><div class="eyebrow">${ended ? round.status === 'sold' ? 'SIGNED' : 'UNSOLD · BACK IN THE POOL' : 'UP FOR AUCTION'}</div><h2>${esc(player.player.name)}</h2><div class="player-meta"><span class="pill">${esc(player.club?.name)} · ${esc(player.season.season)}</span>${positions(player.player.positions)}${showRatings ? `<span class="rating">${rating(player)}</span>` : ''}</div>${ended ? `<p>${round.status === 'sold' ? `${esc(memberName(round.winnerId))} signed them for <strong>${money(round.price)}</strong>` : 'Nobody signed this player.'}</p>` : ''}`}</section><section class="panel stack"><div class="row"><h3>Managers in the auction</h3><span class="hint">${room.members.length} managers</span></div><div class="bidders">${room.members.map(member => { const full = AuctionCore.purchases(room.game, member.managerId).length >= 11, withdrew = round?.withdrawn.includes(member.managerId), cannot = !full && !withdrew && open && !round.active.includes(member.managerId); return `<div class="bidder ${leader?.managerId === member.managerId && open ? 'leader' : ''} ${full || withdrew || cannot ? 'out' : ''}"><strong>${esc(member.name)}</strong> · ${full ? 'XI full' : withdrew ? 'Out' : cannot ? (keeper ? 'Has a GK' : 'Needs a GK') : leader?.managerId === member.managerId && open ? 'Leading' : 'In'}<br>${money(AuctionCore.budget(room.game, member.managerId))} left</div>`; }).join('')}</div>${round?.bids.length && !spinning ? `<details><summary class="hint">Recent bids</summary>${round.bids.slice().reverse().map(bid => `<div class="sale-row"><span>${esc(memberName(bid.managerId))}${round.withdrawn.includes(bid.managerId) ? ' · withdrawn' : ''}</span><strong>${money(bid.price)}</strong></div>`).join('')}</details>` : ''}</section></div><section class="panel bid-panel"><div class="row"><div><div class="hint">${open ? 'Current highest bid' : 'Last sale'}</div><div class="bid-price">${open && leader ? money(leader.price) : ended && round.status === 'sold' ? money(round.price) : '—'}</div><p>${open && leader ? esc(memberName(leader.managerId)) : open ? 'Be the first to bid' : 'Ready for the next player'}</p></div><div id="timer" class="timer">${open ? round.deadline ? '1:00' : 'Waiting' : 'Ended'}</div></div>${open ? `<form id="bid-form" class="bid-form"><label for="bid-value" class="label">Your bid (£m)</label><input id="bid-value" inputmode="numeric" type="number" min="${min}" max="${myBudget()}" step="1" placeholder="${min}" value="${esc(bidText)}" ${disabled(!allowed)}><div class="increments">${[1, 5, 10, 50].map(value => `<button type="button" data-do="increment" data-id="${value}" ${disabled(!allowed)}>+£${value}m</button>`).join('')}</div><button class="primary" ${disabled(!allowed)}>${leader?.managerId === room.me ? 'You’re the highest bidder' : 'Place bid'}</button><button type="button" class="quiet danger" data-do="withdraw" ${disabled(!allowed || locked)}>${out ? 'You’re out for this player' : blocked ? blocked : locked ? 'Locked in · you’re the highest bidder' : 'Back out for this player'}</button>${broke && !out ? '<p class="hint">You’re out of money. If everyone else backs out, bid £0 to take this player for free.</p>' : ''}<p class="hint">Bids are whole millions, from £1m. First bid starts 60 seconds; every later bid adds 10 seconds. The highest bidder is locked in and can’t bid again until someone outbids them. If you’re outbid, you can bid again or back out.</p><p class="hint">${out ? 'You can bid again when the next player appears.' : 'The last manager in wins at their current bid. Otherwise, the highest active bid wins when time runs out.'}</p></form>` : `<p>${room.status === 'complete' ? 'Arrange everyone’s XI, review your bargains and big spends, then start the league.' : room.isHost ? 'Keep everyone guessing. Reveal the next player when you’re ready.' : 'Waiting for your host to reveal the next player.'}</p>`}${room.isHost && room.status === 'draft' ? `<button class="${open ? 'quiet' : 'primary'}" data-do="${open ? 'skip' : 'reveal'}" ${disabled(!connected || busy || open && !!leader || spinning)}>${open ? 'Skip unsold player' : 'Reveal next player →'}</button>` : ''}${room.status === 'complete' ? '<button data-do="tab" data-id="teams">Arrange your XI →</button><button class="primary" data-do="tab" data-id="league">Bargains & league →</button>' : ''}</section></div>${roomFooter()}`;
  }
  function skippedPlayers() {
    const queued = room.game.skipped || [];
    if (!queued.length) return '';
    const unseen = room.game.unseenCount || 0;
    return `<section id="skipped-players" class="panel stack skipped-panel"><div class="row"><h2>Skipped players</h2><span class="pill">${queued.length} waiting</span></div><p>${unseen ? `These players return after the ${unseen} remaining new player${unseen === 1 ? '' : 's'}.` : 'The new-player cycle is finished. These players are next, in the order below.'} Bid for them in the usual auction panel when they return.</p><div>${queued.map((id, index) => { const player = entry(id); return `<div class="sale-row" data-skipped="${esc(id)}"><span class="queue-number">${index + 1}</span><div class="queue-player"><strong>${esc(player.player.name)}</strong><small>${positions(player.player.positions)} ${esc(player.club?.name)} · ${esc(player.season.season)}</small></div>${showRatings ? `<span class="rating">${rating(player)}</span>` : ''}<span class="pill">${index === 0 ? 'First back' : 'Queued'}</span></div>`; }).join('')}</div><p class="hint">If everyone backs out again, the player moves to the end of this list.</p></section>`;
  }
  // Squad lists run keeper, defence, midfield, attack by each player's main position, then by rating.
  const positionOrder = ['GK', 'LB', 'CB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'LM', 'RM', 'CAM', 'LW', 'RW', 'ST'];
  const mainPosition = sale => entry(sale.playerId).player.positions[0];
  const squadOrder = sales => sales.slice().sort((a, b) => positionOrder.indexOf(mainPosition(a)) - positionOrder.indexOf(mainPosition(b)) || rating(entry(b.playerId)) - rating(entry(a.playerId)));
  const lineNames = { gk: 'Goalkeeper', def: 'Defence', mid: 'Midfield', att: 'Attack' };
  const groupHeading = (list, index) => index > 0 && line(mainPosition(list[index - 1])) === line(mainPosition(list[index])) ? '' : `<div class="squad-group"><span class="pos pos-${line(mainPosition(list[index]))}">${lineNames[line(mainPosition(list[index]))]}</span></div>`;
  function teamsScreen() {
    if (!room.game.managers.some(manager => manager.id === teamId)) teamId = room.me;
    const manager = room.game.managers.find(manager => manager.id === teamId), own = teamId === room.me, editable = own && !room.league;
    const team = LeagueCore.team(room.game, manager), sales = AuctionCore.purchases(room.game, teamId), slots = DraftCore.formations[DraftCore.formationOf(room.game, manager)];
    if (!editable || !Number.isInteger(selectedSlot) || selectedSlot < 0 || selectedSlot >= slots.length) selectedSlot = null;
    const paid = id => sales.find(sale => sale.playerId === id)?.price || 0, placedCount = manager.board.filter(Boolean).length;
    const target = selectedSlot === null ? null : slots[selectedSlot], targetPlayer = selectedSlot === null ? null : entry(manager.board[selectedSlot]);
    const draggable = player => editable && player ? ` data-drag-id="${esc(player.id)}" data-drag-label="${esc(player.player.name)}" data-drag-line="${line(player.player.positions[0])}"` : '';
    const help = room.league ? 'Starting XIs are locked for the league.' : !own ? 'You can view this XI. Only its manager can move players.'
      : target ? `Choose a squad player for ${target.position}${targetPlayer ? `, or tap another position to swap ${esc(targetPlayer.player.name)}` : ''}.`
      : 'Tap a position, then choose a player for it. Or drag players onto the pitch, and between positions to swap them.';
    const legend = `<div class="legend">${[['gk', 'Goalkeeper'], ['def', 'Defence'], ['mid', 'Midfield'], ['att', 'Attack']].map(([key, label]) => `<span class="pos pos-${key}">${label}</span>`).join('')}</div>`;
    return `<div class="team-picker">${room.game.managers.map(manager => `<button data-do="team" data-id="${manager.id}" class="${teamId === manager.id ? 'selected' : ''}">${esc(manager.name)}${manager.id === room.me ? ' · You' : ''}</button>`).join('')}</div><div class="team-layout"><section class="panel stack"><div class="row"><h2>${esc(manager.name)}’s XI</h2>${room.game.config.formation === DraftCore.FREE && editable ? `<select id="my-formation" class="formation-pick" aria-label="Your formation" ${disabled(!connected || busy)}>${Object.keys(DraftCore.formations).map(value => `<option ${value === team.formation ? 'selected' : ''}>${esc(value)}</option>`).join('')}</select>` : `<span class="pill">${esc(team.formation)}</span>`}</div>${showRatings ? `<div class="stat-grid">${[['Attack', team.attack, 'att'], ['Midfield', team.midfield, 'mid'], ['Defence', team.defence, 'def'], ['GK', team.goalkeeping, 'gk']].map(([label, value, key]) => `<div class="stat line-${key}"><strong>${value || '—'}</strong>${label}</div>`).join('')}</div>` : ''}<div class="pitch"><div class="circle"></div><div class="box top-box"></div><div class="box bottom-box"></div>${slots.map((slot, index) => { const player = entry(manager.board[index]); return `<button class="slot line-${line(slot.position)} ${player ? 'filled' : ''} ${player && LeagueCore.fitMultiplier(slot.position, player.player.positions) === .93 ? 'misplaced' : ''} ${index === selectedSlot ? 'selected' : ''}" style="left:${slot.x}%;top:${slot.y}%" data-do="slot" data-id="${index}" data-drop-slot="${index}"${draggable(player)} ${disabled(!editable || !connected || busy)} aria-pressed="${index === selectedSlot}" aria-label="${esc(slot.position)}: ${esc(player?.player.name || 'Empty slot')}"><span class="role">${slot.position}</span><span class="name">${player ? esc(player.player.name) : '+'}</span>${player ? `<span class="paid">${money(paid(player.id))}</span>${showRatings ? `<span class="small-rating"> · ${rating(player)}</span>` : ''}` : ''}</button>`; }).join('')}</div>${legend}<p class="hint">${help} Dashed orange outlines show an unfamiliar position.</p></section><section class="panel stack"><div class="row"><h2>The squad</h2><span class="pill">${sales.length}/11 · ${money(AuctionCore.budget(room.game, teamId))} left</span></div>${editable ? `<div class="actions"><button data-do="autoPlace" ${disabled(!connected || busy || !sales.length)}>Arrange automatically</button><button class="quiet danger" data-do="clearBoard" ${disabled(!connected || busy || !placedCount)}>Clear the pitch</button>${targetPlayer ? `<button class="quiet" data-do="unplace" data-id="${esc(targetPlayer.id)}" ${disabled(!connected || busy)}>Take ${esc(targetPlayer.player.name)} off</button>` : ''}</div>` : ''}${target ? `<p class="pick-prompt">Choose a player for <span class="pos pos-${line(target.position)}">${target.position}</span></p>` : ''}<div class="squad-list ${target ? 'picking' : ''}"${editable ? ' data-drop-squad' : ''}>${squadOrder(sales).map((sale, index, list) => { const player = entry(sale.playerId), at = manager.board.indexOf(player.id); return `${groupHeading(list, index)}<button class="squad-player ${at >= 0 ? 'placed' : ''}" data-do="select-player" data-id="${esc(player.id)}"${draggable(player)} ${disabled(!editable)}><span><strong>${esc(player.player.name)}</strong><small>${positions(player.player.positions)} ${esc(player.season.season)}${at >= 0 ? ` · On pitch at ${slots[at].position}` : ''}</small></span><span>${money(sale.price)}${showRatings ? `<small> · ${rating(player)}</small>` : ''}</span></button>`; }).join('') || '<div class="empty">Your first signing is waiting in the auction.</div>'}</div>${editable && placedCount ? '<p class="hint">Drag a player from the pitch back to this list to take them off.</p>' : ''}${showRatings ? `<p class="hint">Team overall: ${team.overall || '—'}. Positions affect team strength in the league.</p>` : ''}</section></div>`;
  }
  function transfersScreen() { return `<section class="panel stack"><div class="row"><h2>Transfer board</h2><span class="pill">${room.game.sales.length} signings</span></div><p>Every deal, ordered from the biggest fee to the smallest.</p><div>${room.game.sales.slice().sort((a, b) => b.price - a.price).map((sale, i) => { const player = entry(sale.playerId); return `<div class="sale-row"><span class="muted">${i + 1}</span><div style="flex:1"><strong>${esc(player.player.name)} ${showRatings ? `<span class="rating">${rating(player)}</span>` : ''}</strong><small>${positions(player.player.positions)} ${esc(memberName(sale.managerId))} · ${esc(player.season.season)}</small></div><span class="price">${money(sale.price)}</span><button class="quiet" data-do="team" data-id="${sale.managerId}" aria-label="View ${esc(memberName(sale.managerId))}’s team">XI</button></div>`; }).join('') || '<div class="empty">No deals yet. The auction is where it all starts.</div>'}</div></section>`; }
  const liveNow = () => room?.live && clock() < room.live.endsAt ? room.live : null;
  const liveClock = live => Math.max(0, Math.min(MatchView.END, (clock() - live.startsAt) / (live.endsAt - live.startsAt) * MatchView.END));
  const liveMinute = live => Math.floor(liveClock(live));
  const clockLabel = value => value <= 45 ? `${value}′` : value <= 48 ? `45+${value - 45}′` : value <= 93 ? `${value - 3}′` : `90+${value - 93}′`;
  const pitchColours = { home: '#6cb4ff', homeKeeper: '#ffd84d', away: '#ff7b7b', awayKeeper: '#c792ff' };
  function watchedFixture(live) {
    const fixtures = liveFixtures(live);
    return fixtures.find(fixture => fixture.id === watchFixture) || fixtures.find(fixture => fixture.homeId === room.me || fixture.awayId === room.me) || fixtures[0];
  }
  function timelineFor(live, fixture) {
    const key = `${room.id}:${live.startsAt}:${fixture.id}`;
    if (!timelines.has(key)) {
      if (timelines.size > 20) timelines.clear();
      const team = id => room.league.teams.find(team => team.id === id), index = liveFixtures(live).indexOf(fixture);
      timelines.set(key, MatchView.build({ result: fixture.result, home: team(fixture.homeId), away: team(fixture.awayId), seed: (live.startsAt ^ Math.imul(index + 1, 2654435761)) >>> 0, duration: (live.endsAt - live.startsAt) / 1000 }));
    }
    return timelines.get(key);
  }
  const liveFixtures = live => room.league.fixtures.filter(fixture => fixture.round === live.round && (!premier() || (isManager(fixture.homeId) && isManager(fixture.awayId))));
  const realSeconds = live => Math.max(0, (clock() - live.startsAt) / 1000);
  const fixtureClock = (live, fixture) => live.view === 'pitch' ? MatchView.clockAt(timelineFor(live, fixture), realSeconds(live)) : liveClock(live);
  const goalsNow = live => liveFixtures(live).reduce((sum, fixture) => { const minute = fixtureClock(live, fixture); return sum + [...fixture.result.homeScorers, ...fixture.result.awayScorers].filter(goal => LeagueCore.absoluteMinute(goal) <= minute).length; }, 0);
  // Scorers sit under their own team, one per line, with the minute beside them.
  function fixtureCard(fixture, minute = MatchView.END) {
    const result = fixture.result, upTo = goals => (goals || []).filter(goal => LeagueCore.absoluteMinute(goal) <= minute);
    const home = upTo(result?.homeScorers), away = upTo(result?.awayScorers);
    const list = goals => goals.map(goal => `<li><span class="goal-name">${esc(goal.name)}</span><span class="goal-minute">${LeagueCore.minuteLabel(goal)}</span>${goal.assistName ? `<span class="goal-assist">Assist: ${esc(goal.assistName)}</span>` : ''}</li>`).join('');
    return `<div class="fixture"><div class="fixture-line"><span class="team-name">${esc(teamName(fixture.homeId))}</span><span class="score">${result ? `${home.length} – ${away.length}` : 'vs'}</span><span class="team-name away">${esc(teamName(fixture.awayId))}</span></div>${home.length || away.length ? `<div class="goal-columns"><ul class="goals">${list(home)}</ul><ul class="goals away">${list(away)}</ul></div>` : ''}</div>`;
  }
  function liveHead(live) {
    const watched = live.view === 'pitch' ? watchedFixture(live) : null, minute = Math.floor(watched ? fixtureClock(live, watched) : liveClock(live)), done = minute >= MatchView.END;
    const score = watched && (side => watched.result[side].filter(goal => LeagueCore.absoluteMinute(goal) <= minute).length);
    return `<div class="row"><div><div class="eyebrow live-label">● Live · Matchday ${live.round + 1}${live.view === 'pitch' ? ' · Pitch view beta' : ''}</div><h2 class="gap-top live-minute">${done ? 'Full time' : clockLabel(minute)}</h2></div><span class="pill">${done ? 'Full time' : minute < 48 ? 'First half' : 'Second half'}</span></div><div class="live-clock"><span style="width:${minute / MatchView.END * 100}%"></span></div>${watched ? `<div class="pitch-scoreboard"><span class="team-name"><i class="kit home-kit"></i>${esc(teamName(watched.homeId))}</span><strong class="score">${score('homeScorers')} – ${score('awayScorers')}</strong><span class="team-name away">${esc(teamName(watched.awayId))}<i class="kit away-kit"></i></span></div>` : ''}`;
  }
  function liveRest(live) {
    const minute = liveMinute(live), fixtures = liveFixtures(live);
    if (live.view !== 'pitch') return fixtures.map(fixture => fixtureCard(fixture, minute)).join('');
    const watched = watchedFixture(live), now = fixtureClock(live, watched), teamOf = side => teamName(side === 'home' ? watched.homeId : watched.awayId);
    const ticker = timelineFor(live, watched).events.filter(event => event.abs <= now).slice(-5).reverse()
      .map(event => `<li class="${event.goal ? 'goal-event' : ''}"><span class="goal-minute">${clockLabel(Math.min(MatchView.END, Math.round(event.abs)))}</span><span>${esc(event.text)}${event.assist ? ` · assist ${esc(event.assist)}` : ''}${event.side ? ` <small>${esc(teamOf(event.side))}</small>` : ''}</span></li>`).join('');
    return `<ul class="ticker">${ticker || '<li><span>Waiting for kick-off</span></li>'}</ul>${fixtures.length > 1 ? `<div class="watch-picker">${fixtures.map(fixture => `<button data-do="watch" data-id="${esc(fixture.id)}" class="${fixture.id === watched.id ? 'selected' : ''}">Watch ${esc(teamName(fixture.homeId))} v ${esc(teamName(fixture.awayId))}</button>`).join('')}</div>` : ''}${fixtures.map(fixture => fixtureCard(fixture, Math.floor(fixtureClock(live, fixture)))).join('')}`;
  }
  function liveInner(live) {
    return `<div id="live-head">${liveHead(live)}</div>${live.view === 'pitch' ? '<canvas id="match-canvas" class="match-canvas" role="img" aria-label="Live 2D match view"></canvas>' : ''}<div id="live-rest">${liveRest(live)}</div>`;
  }
  function animate() {
    frame = null;
    const live = liveNow();
    if (!live || live.view !== 'pitch') { sound.crowdStop(); return; }
    const canvas = document.getElementById('match-canvas');
    if (canvas && canvas.clientWidth) {
      const width = Math.round(canvas.clientWidth * (window.devicePixelRatio || 1));
      if (canvas.width !== width) { canvas.width = width; canvas.height = Math.round(width * MatchView.ASPECT); }
      MatchView.draw(canvas, timelineFor(live, watchedFixture(live)), realSeconds(live), pitchColours);
      sound.crowd(MatchView.intensity(timelineFor(live, watchedFixture(live)), realSeconds(live)));
    }
    frame = requestAnimationFrame(animate);
  }
  const topAssists = league => { const totals = new Map(); for (const fixture of league.fixtures) if (fixture.result) for (const [side, goals] of [['homeId', fixture.result.homeScorers], ['awayId', fixture.result.awayScorers]]) for (const goal of goals) if (goal.assistId) { const value = totals.get(goal.assistId) || { name: goal.assistName, managerId: fixture[side], assists: 0 }; value.assists++; totals.set(goal.assistId, value); } return [...totals.values()].sort((a, b) => b.assists - a.assists); };
  const matchViewControl = () => room.isHost ? `<div class="view-choice"><span class="hint">Match view</span><div class="segmented">${[['classic', 'Classic'], ['pitch', 'Pitch view · beta']].map(([id, label]) => `<button data-do="matchView" data-id="${id}" class="${room.matchView === id ? 'selected' : ''}" ${disabled(!connected || busy)}>${label}</button>`).join('')}</div><span class="hint">${room.matchView === 'pitch' ? 'Football Manager-style highlights on a 2D pitch. Matchdays take about 2½ minutes.' : 'Scores and scorers tick in. Matchdays take 18 seconds.'}</span></div>` : `<p class="hint">Match view: ${room.matchView === 'pitch' ? 'pitch view (beta)' : 'classic'}.</p>`;
  const playerAward = (label, sale) => `<div class="award"><div class="eyebrow">${label}</div><strong>${esc(entry(sale.playerId).player.name)}</strong><p>${esc(memberName(sale.managerId))} · ${money(sale.price)}</p>${showRatings ? `<span class="pill">${sale.rating} rated</span>` : ''}</div>`;
  const awardsReport = awards => `<div class="grid">${playerAward('Bargain of the draft', awards.bargain)}${playerAward('Biggest signing', awards.biggestBuy)}<div class="award wide"><div class="eyebrow">Biggest spender</div><strong>${esc(awards.biggestSpender.name)}</strong><p>${money(awards.biggestSpender.spent)} spent on their XI</p><p class="hint gap-top">Bargains compare each fee with a share of the total spend weighted by player rating.</p></div></div>`;
  function goldenBoot(league) {
    const scorers = new Map();
    for (const fixture of league.fixtures) if (fixture.result) for (const scorer of [...fixture.result.homeScorers, ...fixture.result.awayScorers]) { const value = scorers.get(scorer.playerId) || { name: scorer.name, managerId: fixture.result.homeScorers.includes(scorer) ? fixture.homeId : fixture.awayId, goals: 0 }; value.goals++; scorers.set(scorer.playerId, value); }
    return [...scorers.values()].sort((a, b) => b.goals - a.goals);
  }
  const standings = rows => `<div class="scroll-table"><table><thead><tr><th>#</th><th>${premier() ? 'Team' : 'Manager'}</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>GD</th><th>Pts</th></tr></thead><tbody>${rows.map((row, i) => `<tr class="${premier() && isManager(row.id) ? 'manager-row' : ''}"><td>${i + 1}</td><td>${esc(row.name)}</td>${['played', 'won', 'drawn', 'lost', 'gf', 'ga', 'gd'].map(key => `<td>${row[key]}</td>`).join('')}<td class="points">${row.points}</td></tr>`).join('')}</tbody></table></div>`;
  function summaryScreen() {
    const game = room.game, league = room.league, rows = LeagueCore.table(league), awards = LeagueCore.awards(game), top = rows[0];
    const champions = rows.filter(row => row.points === top.points && row.gd === top.gd && row.gf === top.gf);
    const played = league.fixtures.filter(fixture => fixture.result), goals = played.reduce((sum, fixture) => sum + fixture.result.homeGoals + fixture.result.awayGoals, 0);
    const margin = fixture => Math.abs(fixture.result.homeGoals - fixture.result.awayGoals), total = fixture => fixture.result.homeGoals + fixture.result.awayGoals;
    const biggest = played.slice().sort((a, b) => margin(b) - margin(a) || total(b) - total(a))[0];
    const boot = goldenBoot(league), next = room.next;
    const stat = (label, value, note) => `<div class="summary-stat"><small>${label}</small><strong>${value}</strong>${note ? `<span>${note}</span>` : ''}</div>`;
    const managerRows = rows.map((row, index) => ({ row, index })).filter(item => isManager(item.row.id));
    const teams = managerRows.map(({ row, index }) => {
      const team = league.teams.find(team => team.id === row.id), sales = AuctionCore.purchases(game, row.id);
      const priciest = sales.slice().sort((a, b) => b.price - a.price)[0], star = sales.map(sale => entry(sale.playerId)).sort((a, b) => rating(b) - rating(a))[0];
      return `<div class="summary-team"><span class="queue-number">${index + 1}</span><div class="grow"><strong>${esc(row.name)}${champions.includes(row) ? ' 🏆' : ''}</strong><small>${row.points} pts · ${row.won}W ${row.drawn}D ${row.lost}L · ${row.gf} scored · ${money(team.spent)} spent${showRatings ? ` · ${team.overall} team rating` : ''}</small><small>Top signing: ${esc(entry(priciest.playerId).player.name)} (${money(priciest.price)})${showRatings ? ` · Best player: ${esc(star.player.name)} (${rating(star)})` : ''}</small></div></div>`;
    }).join('');
    return `<div class="stack"><section class="panel stack summary-hero"><div class="eyebrow">Full time · Season complete</div><h2>${champions.map(row => esc(row.name)).join(' & ')} ${champions.length > 1 ? 'are joint champions!' : isManager(top.id) || !premier() ? 'are champions!' : 'win the league'}</h2>${premier() && !isManager(top.id) ? `<p>Best of the managers: <strong>${esc(managerRows[0].row.name)}</strong> in ${managerRows[0].index + 1}${['st', 'nd', 'rd'][managerRows[0].index] || 'th'} place.</p>` : ''}<p>${top.points} points from ${top.played} games · ${top.won} wins · ${top.gf} goals</p><div class="summary-stats">${stat('Goals this season', goals, `${(goals / Math.max(1, played.length)).toFixed(1)} per game`)}${biggest ? stat('Biggest win', `${biggest.result.homeGoals} – ${biggest.result.awayGoals}`, `${esc(teamName(biggest.homeId))} v ${esc(teamName(biggest.awayId))}`) : ''}${boot.length ? stat('Golden boot', esc(boot[0].name), `${boot[0].goals} goals · ${esc(teamName(boot[0].managerId))}`) : ''}${topAssists(league).length ? stat('Most assists', esc(topAssists(league)[0].name), `${topAssists(league)[0].assists} assists · ${esc(teamName(topAssists(league)[0].managerId))}`) : ''}${stat('Players signed', game.sales.length, `${money(game.sales.reduce((sum, sale) => sum + sale.price, 0))} spent in total`)}</div><div class="actions">${next ? `<button class="primary" data-do="rematch" ${disabled(busy)}>Join the new game · room ${esc(next.code)} →</button>` : `<button class="primary" data-do="rematch" ${disabled(busy)}>Play again · same rules →</button>`}<button class="quiet" data-do="leave">Leave the room</button></div><p class="hint">${next ? 'A fresh lobby with the same rules is waiting for you.' : 'Play again opens a fresh lobby with a new code and the same rules. Everyone else can join it from this screen.'}</p></section><section class="panel stack"><h2>Final table</h2>${standings(rows)}</section><section class="panel stack"><h2>How every team did</h2>${teams}</section>${awardsReport(awards)}</div>`;
  }
  function leagueScreen() {
    const game = room.game;
    if (room.status !== 'complete') return `<section class="panel stack"><div class="eyebrow">After the auction</div><h2>Your league is coming</h2><p>Once all ${game.totalPlayers} players are signed, we’ll reveal the bargains and big spends. Arrange every XI, then everyone plays each other home and away.</p><button data-do="tab" data-id="auction">Back to the auction</button></section>`;
    const awards = LeagueCore.awards(game), check = LeagueCore.readiness(game), league = room.league, count = league ? LeagueCore.roundCount(league) : 0;
    const report = awardsReport(awards);
    if (!league) return `<div class="stack">${report}<section class="panel stack"><h2>Meet the teams</h2>${game.managers.map(manager => { const team = LeagueCore.team(game, manager); return `<div class="sale-row"><div><strong>${esc(manager.name)}</strong><small>${team.placed}/11 placed · ${money(team.spent)} spent${showRatings ? ` · ${team.overall} overall` : ''}</small></div><button data-do="team" data-id="${manager.id}">View XI</button></div>`; }).join('')}<p>${esc(check.message)}</p>${premier() ? `<p class="hint">Premier League: your ${game.managers.length} XIs join ${20 - game.managers.length} of 38-0's clubs for 38 matchdays. Games against the clubs are instant; manager v manager games are played live.</p>` : ''}${room.isHost ? `<button class="primary" data-do="startLeague" ${disabled(!check.ready || !connected || busy)}>Start the home & away league →</button>` : '<p class="hint">The host will start once everyone has placed their XI.</p>'}</section></div>`;
    // While a matchday is live, the table and results wait for full time.
    const live = liveNow(), shown = live ? { ...league, round: live.round, fixtures: league.fixtures.map(fixture => fixture.round === live.round ? { ...fixture, result: null } : fixture) } : league;
    const finished = !live && league.round >= count, rows = LeagueCore.table(shown);
    const scorers = goldenBoot(shown);
    return `<div class="stack">${live ? `<section id="live-matchday" class="panel stack live-panel">${liveInner(live)}</section>` : ''}<section class="panel stack"><div class="row"><div><div class="eyebrow">${finished ? 'Season complete' : `Matchday ${shown.round}/${count}`}</div><h2 class="gap-top">${finished ? `${esc(rows[0].name)} are champions!` : 'The league table'}</h2></div><span class="pill">Home & away · 3 points for a win</span></div>${standings(rows)}${finished ? '<button class="primary" data-do="tab" data-id="summary">See the season summary →</button>' : room.isHost ? `${matchViewControl()}<div class="actions"><button class="primary" data-do="playRound" ${disabled(!connected || busy || !!live)}>${live ? 'Matchday in play…' : `Play matchday ${league.round + 1} →`}</button>${premier() && room.league.nextDerby !== null && room.league.nextDerby > room.league.round ? `<button data-do="skipToDerby" ${disabled(!connected || busy || !!live)}>Skip to the next manager match · matchday ${room.league.nextDerby + 1}</button>` : ''}<button class="quiet" data-do="finishLeague" ${disabled(!connected || busy || !!live)}>Simulate remaining season</button></div>` : !finished ? `${matchViewControl()}<p class="hint">Your host kicks off each matchday. Everyone watches it live.</p>` : ''}</section><section class="panel stack"><div class="row"><h2>Fixtures & results</h2>${premier() ? `<button class="quiet" data-do="all-fixtures">${allFixtures ? 'Only manager games' : 'Every game'}</button>` : ''}</div>${Array.from({ length: count }, (_, round) => `<details ${round === Math.max(0, shown.round - 1) ? 'open' : ''}><summary>Matchday ${round + 1}${live && round === live.round ? ' · In play' : round >= shown.round ? ' · Upcoming' : ''}</summary>${shown.fixtures.filter(fixture => fixture.round === round && (!premier() || allFixtures || isManager(fixture.homeId) || isManager(fixture.awayId))).map(fixture => fixtureCard(fixture)).join('')}</details>`).join('')}</section>${scorers.length ? `<section class="panel stack"><h2>Golden boot</h2>${scorers.slice(0, 10).map(scorer => `<div class="sale-row"><strong>${esc(scorer.name)}</strong><span class="price">${scorer.goals} goal${scorer.goals === 1 ? "" : "s"}</span></div>`).join('')}</section>` : ''}${topAssists(shown).length ? `<section class="panel stack"><h2>Most assists</h2>${topAssists(shown).slice(0, 10).map(player => `<div class="sale-row"><strong>${esc(player.name)}</strong><span class="price">${player.assists} assist${player.assists === 1 ? "" : "s"}</span></div>`).join('')}</section>` : ''}<details><summary>Bargains & big spends</summary><div class="gap-top">${report}</div></details></div>`;
  }
  function render() {
    const focus = document.activeElement, focusId = focus?.id, value = focus && ['INPUT', 'SELECT'].includes(focus.tagName) ? focus.value : null;
    const caret = focus?.tagName === 'INPUT' && ['text', 'search'].includes(focus.type) ? [focus.selectionStart, focus.selectionEnd] : null;
    $('#sound-toggle').hidden = !room; $('#sound-toggle').textContent = sound.enabled ? 'Sound on' : 'Sound off'; $('#sound-toggle').setAttribute('aria-pressed', sound.enabled);
    $('#rating-toggle').hidden = !room?.game || !room.isHost; $('#rating-toggle').textContent = showRatings ? 'Hide ratings' : 'Show ratings';
    connection();
    $('#app').innerHTML = !room ? screen === 'setup' ? setup() : home() : room.status === 'lobby' ? lobby() : navigation() + ({ auction: auctionScreen, teams: teamsScreen, transfers: transfersScreen, league: leagueScreen, summary: room.finished ? summaryScreen : leagueScreen }[tab] || auctionScreen)();
    if (room?.game && tab === 'auction') {
      $('.auction-layout').insertAdjacentHTML('afterend', skippedPlayers());
      if (room.round?.status === 'passed') $('.player-card .eyebrow').textContent = 'SKIPPED · QUEUED FOR LATER';
      if (room.round?.returning) {
        const label = $('.player-card .eyebrow');
        if (label && room.round.status === 'open') label.textContent = clock() < room.round.opensAt ? 'Bringing back a skipped player' : 'BACK FOR BIDDING';
      }
      if (room.game.skipped?.length && room.game.unseenCount === 0 && room.round?.status !== 'open') {
        const reveal = $('[data-do=reveal]'); if (reveal) reveal.textContent = 'Auction next skipped player →';
      }
    }
    if (room?.league && tab === 'league') {
      $('.scroll-table').classList.toggle('full-table', fullStats);
      $('.scroll-table').insertAdjacentHTML('afterend', `<button class="quiet mobile-stats" data-do="table-stats">${fullStats ? 'Show compact table' : 'Show full stats'}</button>`);
    }
    if (focusId) { const next = document.getElementById(focusId); if (next && !next.disabled) { if (value !== null && focusId !== 'bid-value') next.value = value; next.focus({ preventScroll: true }); if (caret) next.setSelectionRange(...caret); } }
    updateTimer();
  }
  function updateLive() {
    const live = liveNow(), key = live ? `${room.id}:${live.round}:${live.startsAt}` : null;
    if (key !== liveKey) {
      if (liveKey && !key) { liveKey = null; sound.whistle(); if (summaryPending) { summaryPending = false; tab = 'summary'; } render(); return; }
      liveKey = key; shownMinute = -1; liveGoals = goalsNow(live);
      if (liveMinute(live) < 2) sound.whistle();
    }
    if (!live) return;
    // Refresh the score, clock and commentary whenever the minute or the shown events change.
    let minute = liveMinute(live);
    if (live.view === 'pitch') { const watched = watchedFixture(live), now = fixtureClock(live, watched); minute = `${Math.floor(now)}:${timelineFor(live, watched).events.filter(event => event.abs <= now).length}:${watched.id}`; }
    if (minute === shownMinute) return;
    shownMinute = minute;
    const goals = goalsNow(live); if (goals > liveGoals) { if (live.view === 'pitch') sound.roar(); else sound.goal(); } liveGoals = goals;
    const head = document.getElementById('live-head'), rest = document.getElementById('live-rest');
    if (head && rest) { head.innerHTML = liveHead(live); rest.innerHTML = liveRest(live); }
    if (live.view === 'pitch' && !frame) frame = requestAnimationFrame(animate);
  }
  function updateTimer() {
    updateLive();
    const round = room?.round;
    if (round?.status === 'open' && clock() >= round.opensAt && revealDrawn !== round.id) { revealDrawn = round.id; if (tab === 'auction') render(); return; }
    const timer = $('#timer'); if (!timer || !round) return;
    const seconds = round.deadline ? Math.max(0, Math.ceil((round.deadline - clock()) / 1000)) : null;
    timer.textContent = round.status !== 'open' ? 'Ended' : clock() < round.opensAt ? 'Revealing' : seconds === null ? 'Waiting' : seconds === 0 ? 'Settling…' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    timer.classList.toggle('urgent', seconds !== null && seconds <= 10 && round.status === 'open');
    if (seconds === 0) $('#bid-form')?.querySelectorAll('button,input').forEach(element => { element.disabled = true; });
  }
  $('#sound-toggle').addEventListener('click', () => { sound.toggle(); render(); });
  document.addEventListener('pointerdown', () => sound.unlock(), true);
  $('#rating-toggle').addEventListener('click', () => action('ratings', { show: !showRatings }));
  $('#app').addEventListener('change', event => { if (event.target.id === 'my-formation') action('formation', { formation: event.target.value }); });
  $('#app').addEventListener('input', event => {
    if (event.target.id === 'bid-value') bidText = event.target.value;
    if (event.target.form?.id === 'rules-form') queueMicrotask(() => { const form = $('#rules-form'); if (!form) return; rulesDraft = readRules(form); form.querySelector('button.primary').disabled = matchesRoom(rulesDraft) || !connected || busy; });
    if (['season-from', 'season-to', 'rating-min', 'rating-max'].includes(event.target.id)) {
      const seasonInput = event.target.id.startsWith('season'), low = $(seasonInput ? '#season-from' : '#rating-min'), high = $(seasonInput ? '#season-to' : '#rating-max');
      if (+low.value > +high.value) (event.target === low ? high : low).value = event.target.value;
      $(seasonInput ? '#season-label' : '#rating-label').textContent = seasonInput ? `${seasons[+low.value]} – ${seasons[+high.value]}` : `${low.value} – ${high.value}`;
    }
  });
  $('#app').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.target;
    if (form.id === 'rules-form') { const { capacity, ...config } = readRules(form); await action('settings', { capacity, config }); if (rulesDraft && matchesRoom(rulesDraft)) rulesDraft = null; render(); return; }
    if (form.id === 'bid-form') {
      const value = $('#bid-value').value, price = Number(value);
      if (value === '' || !Number.isInteger(price) || price < 0) return toast('Bids are whole millions, e.g. 12 for £12m.');
      return action('bid', { price });
    }
    if (busy) return;
    const data = new FormData(form), displayName = String(data.get('name') || '').trim(); storage.set('name', displayName);
    let body;
    if (form.id === 'join-form') body = { name: displayName, code: String(data.get('code') || '') };
    else if (form.id === 'create-form') body = { name: displayName, capacity: +data.get('capacity'), config: { formation: data.get('formation'), mode: data.get('mode'), seasonFrom: seasons[+data.get('seasonFrom')], seasonTo: seasons[+data.get('seasonTo')], ratingMin: +data.get('ratingMin'), ratingMax: +data.get('ratingMax'), devMode: data.get('devMode') === 'on', competition: data.get('competition') === 'premier' ? 'premier' : 'friends' } };
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
    if (type === 'team') { teamId = id; tab = 'teams'; selectedSlot = null; render(); window.scrollTo({ top: 0 }); return; }
    if (type === 'select-player') {
      if (selectedSlot === null) { toast('Tap a position on the pitch first, or drag this player onto it.'); return; }
      const slot = selectedSlot; selectedSlot = null; return action('place', { playerId: id, slot });
    }
    if (type === 'slot') {
      // Position first: choose a spot, then a player. A second spot moves or swaps.
      const board = room.game.managers.find(manager => manager.id === teamId).board, slot = +id, from = selectedSlot;
      if (from === null || from === slot) { selectedSlot = from === slot ? null : slot; render(); return; }
      selectedSlot = null;
      if (board[from]) return action('place', { playerId: board[from], slot });
      if (board[slot]) return action('place', { playerId: board[slot], slot: from });
      selectedSlot = slot; render(); return;
    }
    if (type === 'unplace') { selectedSlot = null; return action(type, { playerId: id }); }
    if (type === 'clearBoard') { selectedSlot = null; return action(type); }
    if (type === 'increment') { const min = minBid(room), value = Math.floor(Number(bidText)); bidText = String(Number.isFinite(value) && value >= min ? value + +id : min + +id); $('#bid-value').value = bidText; return; }
    if (type === 'copy-code' || type === 'share') {
      const url = `${location.origin}/?code=${room.code}`;
      try { if (type === 'share' && navigator.share) await navigator.share({ title: 'Join my Touchline auction', text: `Room ${room.code}`, url }); else { await navigator.clipboard.writeText(type === 'share' ? url : room.code); toast(type === 'share' ? 'Invite link copied' : 'Room code copied'); } } catch (error) { if (error.name !== 'AbortError') toast(`Room ${room.code} · ${url}`); }
      return;
    }
    if (type === 'leave') { leaveRoom(); render(); return; }
    if (type === 'all-fixtures') { allFixtures = !allFixtures; render(); return; }
    if (type === 'resume' && resumable) { const id = resumable.id; busy = true; render(); try { await api(`/api/room/${id}`); connect(); } catch (error) { toast(error.message); storage.set('room', null); resumable = null; } finally { busy = false; render(); } return; }
    if (type === 'forget') { storage.set('room', null); resumable = null; render(); return; }
    if (type === 'discard-rules') { rulesDraft = null; render(); return; }
    if (type === 'watch') { watchFixture = id; shownMinute = -1; updateLive(); return; }
    if (type === 'matchView') return action('matchView', { view: id });
    if (type === 'rematch') {
      if (busy) return;
      busy = true; render();
      try { await api('/api/rematch', { roomId: room.id }); connect(); } catch (error) { toast(error.message); } finally { busy = false; render(); }
      return;
    }
    if (type === 'ready') return action(type, { ready: !room.members.find(member => member.managerId === room.me).ready });
    if (type === 'kick') return action(type, { managerId: id });
    if (type === 'transferHost') return action(type, { managerId: $('#next-host').value });
    return action(type);
  });
  function endDrag() {
    if (!drag) return;
    clearTimeout(drag.timer); drag.ghost?.remove(); document.querySelector('.drop-over')?.classList.remove('drop-over');
    document.body.classList.remove('dragging'); drag = null;
  }
  const dropTarget = event => { const element = document.elementFromPoint(event.clientX, event.clientY); return element?.closest('[data-drop-slot]') || element?.closest('[data-drop-squad]') || null; };
  // Pointer events cover mouse and touch. Re-renders can replace the dragged element, so track the player id.
  $('#app').addEventListener('pointerdown', event => {
    const source = event.target.closest('[data-drag-id]');
    if (!source || source.disabled || event.button > 0) return;
    endDrag();
    // Touch drags from the squad list need a short hold so the list can still scroll.
    const immediate = event.pointerType !== 'touch' || source.classList.contains('slot');
    drag = { id: source.dataset.dragId, label: source.dataset.dragLabel, line: source.dataset.dragLine, pointerId: event.pointerId, x: event.clientX, y: event.clientY, ready: immediate, active: false };
    if (!immediate) drag.timer = setTimeout(() => { if (drag) { drag.ready = true; navigator.vibrate?.(12); } }, 170);
  });
  window.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
      if (!drag.ready) { endDrag(); return; }
      drag.active = true; document.body.classList.add('dragging');
      drag.ghost = Object.assign(document.createElement('div'), { className: `drag-ghost line-${drag.line}`, textContent: drag.label });
      document.body.append(drag.ghost);
    }
    drag.ghost.style.left = `${event.clientX}px`; drag.ghost.style.top = `${event.clientY}px`;
    const over = dropTarget(event), previous = document.querySelector('.drop-over');
    if (previous !== over) { previous?.classList.remove('drop-over'); over?.classList.add('drop-over'); }
  });
  window.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { id, active } = drag, target = active && dropTarget(event);
    endDrag();
    if (!active) return;
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 60);
    const board = room?.game?.managers.find(manager => manager.id === room.me)?.board;
    if (!board || room.league) return;
    selectedSlot = null;
    if (target && target.dataset.dropSlot !== undefined) { const slot = +target.dataset.dropSlot; if (board[slot] !== id) action('place', { playerId: id, slot }); else render(); }
    else if (target && board.includes(id)) action('unplace', { playerId: id });
    else render();
  });
  window.addEventListener('pointercancel', endDrag);
  document.addEventListener('touchmove', event => { if (drag?.ready) event.preventDefault(); }, { passive: false });
  $('#app').addEventListener('click', event => { if (suppressClick) { suppressClick = false; event.stopPropagation(); event.preventDefault(); } }, true);
  // Play again moves the whole room: when anyone starts the rematch, everyone else joins its lobby.
  async function followNext() {
    if (!room?.next || !room.finished || busy) return;
    busy = true;
    try { await api('/api/rematch', { roomId: room.id }); connect(); toast('Everyone’s heading to the new lobby.'); }
    catch (error) { toast(error.message); } finally { busy = false; render(); }
  }
  function leaveRoom() {
    clearTimeout(reconnectTimer); if (socket) { socket.onclose = null; socket.close(); }
    socket = null; room = null; connected = false; storage.set('room', null); rulesDraft = null; resumable = null;
    try { sessionStorage.removeItem('touchline-online-tab-room'); } catch {} screen = 'home'; tab = 'auction'; liveKey = null; summaryPending = false;
    history.replaceState(null, '', '/');
  }
  // Look at a saved room without entering it, so the home screen can offer to rejoin.
  async function peek(id, code) {
    try {
      const response = await fetch(`/api/room/${id}`, { credentials: 'same-origin' });
      if ([403, 404].includes(response.status)) { storage.set('room', null); return; }
      const saved = (await response.json()).room;
      if (!saved) return;
      const stage = saved.status === 'lobby' ? 'Lobby' : saved.finished ? 'Season finished' : saved.league ? `League · matchday ${saved.league.round}` : saved.status === 'complete' ? 'Auction finished' : 'Auction in progress';
      resumable = { id, code: saved.code, label: `${stage} · ${saved.members.length}/${saved.capacity} managers` };
    } catch {}
  }
  async function init() {
    try {
      // Read the invite code first: restoring a saved room rewrites the address bar.
      const code = new URLSearchParams(location.search).get('code'), name = storage.get('name');
      const results = await Promise.all([api('/api/session', {}), api('/api/options')]); seasons = results[1].seasons;
      const id = storage.get('room');
      let tabRoom = null; try { tabRoom = sessionStorage.getItem('touchline-online-tab-room'); } catch {}
      if (id && tabRoom === id) { try { await api(`/api/room/${id}`); } catch (error) { if ([403, 404].includes(error.status)) storage.set('room', null); toast(error.message); } }
      else if (id) await peek(id, code);
      if (resumable && resumable.code === code) history.replaceState(null, '', '/');
      if (room?.finished && room.next && !code) { await followNext(); return; }
      // An invite link for a different room replaces the saved one, joining its lobby when we know the name.
      if (/^\d{4}$/.test(code || '') && room?.code !== code && resumable?.code !== code) {
        if (room) { leaveRoom(); history.replaceState(null, '', `/?code=${code}`); }
        if (name) { try { await api('/api/join', { name, code }); } catch (error) { toast(error.message); } }
      }
      if (room) connect();
      render();
    } catch (error) { $('#app').innerHTML = `<div class="panel stack error-panel"><h2>Couldn’t reach the game server</h2><p>${esc(error.message)}</p><p>Online play needs the Node server. Locally, run <strong>npm start</strong> and open <a href="http://localhost:4174">localhost:4174</a>.</p><button onclick="location.reload()">Try again</button></div>`; }
  }
  setInterval(updateTimer, 200);
  setInterval(() => { if (room && connected) api('/api/clock').catch(() => {}); }, 30000);
  window.addEventListener('online', () => { if (room && !connected) connect(); });
  init();
})();
