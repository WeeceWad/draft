(function (scope) {
  // Beta 2D match view. It never changes a result: it builds a seeded timeline of play that arrives at
  // each real goal, on its real minute, through its real assister and scorer. Same seed, same match on every device.
  const draft = typeof module !== 'undefined' ? require('./draft-core.js') : scope.DraftCore;
  const leagueCore = typeof module !== 'undefined' ? require('./league-core.js') : scope.LeagueCore;
  const L = 100, W = 64, M = 3, HALF = 48, SECOND = 48.6, END = 97; // Pitch units; times on the 0–97 match clock.
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const other = side => side === 'home' ? 'away' : 'home';
  const lerp = (a, b, p) => ({ x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p });
  const ease = p => p < .5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
  const surname = name => String(name).split(' ').at(-1);
  function seeded(seed) { let state = seed >>> 0; return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; }; }
  // Home attack to the right in the first half and to the left after half-time.
  const direction = (side, t) => (side === 'home') === (t < SECOND) ? 1 : -1;
  // Where a player stands: their formation spot, shifted with the ball and possession, plus a little drift.
  function spot(slot, index, side, t, ball, attacking) {
    const dir = direction(side, t), progress = dir === 1 ? ball.x : L - ball.x;
    let u = slot.position === 'GK' ? 3 + Math.max(0, progress - 45) * .1 : clamp(8 + (100 - slot.y) * .36 + (progress - 50) * .65 + (attacking ? 5 : -3), 7, 93);
    let v = slot.x * W / 100;
    v += (ball.y - v) * (slot.position === 'GK' ? .15 : .2);
    u += Math.sin(t * 1.7 + index * 1.9) * 1.3; v += Math.cos(t * 1.4 + index * 2.7) * 1.6;
    return { x: dir === 1 ? u : L - u, y: clamp(v, 1.5, W - 1.5) };
  }
  function build({ result, home, away, formation, seed }) {
    const slots = draft.formations[formation], next = seeded(seed ^ 0x5eedba11), squads = { home: home.squad, away: away.squad };
    const actions = [], events = [];
    let ball = { x: L / 2, y: W / 2 }, team = 'home', holder = null, t = 0;
    const at = (side, index, time) => spot(slots[index], index, side, time, ball, team === side);
    const keeper = side => slots.findIndex(slot => slot.position === 'GK');
    const name = (side, index) => squads[side][index]?.name || '';
    const pick = weights => { const total = weights.reduce((sum, weight) => sum + weight, 0); let draw = next() * total; for (let index = 0; index < weights.length; index++) if ((draw -= weights[index]) <= 0) return index; return weights.length - 1; };
    function push(action) {
      actions.push({ ...action, team: action.team ?? team });
      if (action.receiver) { holder = action.receiver; team = action.receiver.side; }
      ball = action.to; t = action.t1;
    }
    const move = (side, index, duration, to = null, kind = 'pass') => push({ t0: t, t1: t + duration, from: ball, to: to || at(side, index, t + duration), passer: holder, receiver: { side, index }, kind });
    const place = (point, side, index) => push({ t0: t, t1: t + .3, from: point, to: point, passer: null, receiver: { side, index }, kind: 'place' });
    function teammate(side, forward = true) {
      const dir = direction(side, t), progress = point => dir === 1 ? point.x : L - point.x;
      const options = slots.map((slot, index) => ({ index, point: at(side, index, t) })).filter(option => slots[option.index].position !== 'GK' && !(holder?.side === side && holder.index === option.index));
      return options[pick(options.map(option => Math.max(.05, forward ? 1 + (progress(option.point) - progress(ball)) / 25 : 1) / (1 + Math.hypot(option.point.x - ball.x, option.point.y - ball.y) / 30)))].index;
    }
    function nearest(side, point, excluding = -1) {
      let best = 0, distance = Infinity;
      slots.forEach((slot, index) => { if (index === excluding || slot.position === 'GK') return; const p = at(side, index, t), d = Math.hypot(p.x - point.x, p.y - point.y); if (d < distance) { distance = d; best = index; } });
      return best;
    }
    function step(stop) {
      const room = stop - t, duration = Math.min(room, .9 + next() * 1.3), dir = direction(team, t), progress = dir === 1 ? ball.x : L - ball.x, roll = next();
      const goalX = dir === 1 ? L : 0;
      if (progress > 58 && roll < .34 && room > 5) {
        const defending = other(team), shooter = holder;
        const outcome = next();
        if (outcome < .45) {
          push({ t0: t, t1: t + .7, from: ball, to: { x: goalX - dir * 2, y: W / 2 + (next() - .5) * 6 }, passer: shooter, receiver: { side: defending, index: keeper(defending) }, kind: 'shot' });
          events.push({ t, side: shooter.side, text: `Saved! ${surname(name(defending, keeper(defending)))} holds ${surname(name(shooter.side, shooter.index))}’s shot` });
          move(defending, teammate(defending), 1.4);
        } else if (outcome < .8) {
          push({ t0: t, t1: t + .7, from: ball, to: { x: goalX + dir * 2, y: W / 2 + (next() < .5 ? -1 : 1) * (5 + next() * 5) }, passer: shooter, receiver: null, kind: 'shot' });
          events.push({ t, side: shooter.side, text: `${surname(name(shooter.side, shooter.index))} shoots wide` });
          t += .5; place({ x: goalX - dir * 6, y: W / 2 }, defending, keeper(defending));
          events.push({ t, side: defending, text: 'Goal kick' });
          move(defending, teammate(defending), 1.6);
        } else {
          const flag = next() < .5 ? .4 : W - .4;
          push({ t0: t, t1: t + .7, from: ball, to: { x: goalX + dir * .8, y: flag < W / 2 ? 4 : W - 4 }, passer: shooter, receiver: null, kind: 'shot' });
          events.push({ t, side: shooter.side, text: `${surname(name(shooter.side, shooter.index))}’s shot is deflected wide` });
          const taker = slots.findIndex(slot => ['LW', 'RW', 'LM', 'RM', 'CAM', 'CM'].includes(slot.position));
          t += .4; place({ x: goalX, y: flag }, shooter.side, Math.max(0, taker));
          events.push({ t, side: shooter.side, text: 'Corner' });
          const target = { x: goalX - dir * 8, y: W / 2 + (next() - .5) * 8 };
          move(shooter.side, teammate(shooter.side), 1.1, target);
          const clearer = nearest(defending, ball);
          move(defending, clearer, .9, { x: goalX - dir * 24, y: W / 2 + (next() - .5) * 30 }, 'clear');
          events.push({ t, side: defending, text: `${surname(name(defending, clearer))} clears` });
        }
        return;
      }
      const play = next();
      if (play < .12 && room > duration + 1.5) {
        const to = { x: clamp(ball.x + dir * (4 + next() * 10), 4, 96), y: next() < .5 ? .3 : W - .3 };
        push({ t0: t, t1: t + duration, from: ball, to, passer: holder, receiver: null, kind: 'pass' });
        const side = other(team), taker = nearest(side, to);
        place(to, side, taker); team = side;
        events.push({ t, side, text: 'Throw-in' });
        move(side, teammate(side), 1);
        return;
      }
      if (play < .3) {
        const target = at(team, teammate(team), t + duration), point = lerp(ball, target, .4 + next() * .4), side = other(team), tackler = nearest(side, point);
        move(side, tackler, duration * .6, point, 'tackle');
        if (next() < .35) events.push({ t, side, text: `${surname(name(side, tackler))} wins it back` });
        return;
      }
      if (play < .45 && holder) {
        const runner = holder;
        if (next() < .3) events.push({ t, side: runner.side, text: `${surname(name(runner.side, runner.index))} drives forward` });
        move(runner.side, runner.index, duration, { x: clamp(ball.x + dir * (6 + next() * 8), 4, 96), y: clamp(ball.y + (next() - .5) * 10, 3, W - 3) }, 'dribble');
        return;
      }
      const passer = holder, receiver = teammate(team), side = team, start = t;
      move(side, receiver, duration);
      const reached = direction(side, t) === 1 ? ball.x : L - ball.x;
      if (passer && passer.side === side && reached > 70 && next() < .35) events.push({ t: start, side, text: `${surname(name(side, passer.index))} finds ${surname(name(side, receiver))} in the final third` });
    }
    function finale(goal) {
      const side = goal.side, dir = direction(side, goal.at), goalX = dir === 1 ? L : 0;
      const scorer = Math.max(0, squads[side].findIndex(player => player.id === goal.playerId));
      const assister = goal.assistId ? squads[side].findIndex(player => player.id === goal.assistId) : -1;
      const steps = (team !== side ? 1 : 0) + (assister >= 0 ? 2 : 1) + 1;
      t = Math.min(t, goal.at - .6);
      const each = (goal.at - t) / steps, shooting = { x: goalX - dir * (9 + next() * 9), y: W / 2 + (next() - .5) * 20 };
      if (team !== side) move(side, nearest(side, ball, scorer), each, null, 'tackle');
      if (assister >= 0) { move(side, assister, each); move(side, scorer, each, shooting); }
      else move(side, scorer, each, shooting, holder?.side === side && holder.index === scorer ? 'dribble' : 'pass');
      push({ t0: t, t1: goal.at, from: ball, to: { x: goalX + dir * 1.6, y: W / 2 + (next() - .5) * 5 }, passer: { side, index: scorer }, receiver: null, team: side, kind: 'goal' });
      events.push({ t: goal.at, side, goal: true, text: `GOAL! ${goal.name}`, assist: goal.assistName || null });
      team = other(side); holder = null;
    }
    function segment(start, stop, kicker, goal) {
      t = start; team = kicker; ball = { x: L / 2, y: W / 2 };
      const striker = slots.findIndex(slot => slot.position === 'ST');
      holder = { side: kicker, index: striker >= 0 ? striker : 10 };
      const reserve = goal ? Math.min(3.2, Math.max(.7, goal.at - start - 1.2)) : .4, limit = (goal ? goal.at : stop) - reserve;
      if (limit - t > 1.2) { events.push({ t, side: kicker, text: 'Kick-off' }); move(kicker, teammate(kicker, false), .9); }
      while (t + 1 < limit) step(limit);
      if (goal) finale(goal);
    }
    const goals = [...result.homeScorers.map(goal => ({ ...goal, side: 'home' })), ...result.awayScorers.map(goal => ({ ...goal, side: 'away' }))]
      .map(goal => ({ ...goal, at: leagueCore.absoluteMinute(goal) })).sort((a, b) => a.at - b.at);
    function half(start, stop, kicker, list) {
      let from = start, side = kicker;
      list.forEach((goal, index) => {
        segment(from, stop, side, goal);
        from = Math.min(goal.at + 1.2, (list[index + 1]?.at ?? Infinity) - .7); side = other(goal.side);
      });
      if (from < stop - .5) segment(from, stop, side, null);
      events.push({ t: stop, text: stop === END ? 'Full time' : 'Half-time' });
    }
    half(0, HALF, 'home', goals.filter(goal => goal.at <= HALF));
    half(SECOND, END, 'away', goals.filter(goal => goal.at > HALF));
    actions.sort((a, b) => a.t0 - b.t0);
    return { actions, events: events.sort((a, b) => a.t - b.t), slots, squads };
  }
  function current(timeline, t) {
    let low = 0, high = timeline.actions.length - 1, found = -1;
    while (low <= high) { const mid = (low + high) >> 1; if (timeline.actions[mid].t0 <= t) { found = mid; low = mid + 1; } else high = mid - 1; }
    return found >= 0 ? timeline.actions[found] : null;
  }
  function state(timeline, t) {
    const action = current(timeline, t), progress = action ? clamp((t - action.t0) / Math.max(.01, action.t1 - action.t0), 0, 1) : 0;
    const ball = !action ? { x: L / 2, y: W / 2 } : lerp(action.from, action.to, ease(progress)), team = action?.team || 'home';
    const players = [];
    for (const side of ['home', 'away']) timeline.slots.forEach((slot, index) => {
      let point = spot(slot, index, side, t, ball, team === side);
      const is = who => who && who.side === side && who.index === index;
      if (action && is(action.receiver)) point = progress >= 1 ? ball : lerp(point, action.to, Math.pow(progress, 1.5));
      else if (action && is(action.passer) && progress < 1) point = lerp(action.from, point, ease(progress));
      players.push({ side, index, keeper: slot.position === 'GK', x: point.x, y: point.y, name: timeline.squads[side][index]?.name || '', holder: action && is(action.receiver) && progress >= .95 });
    });
    return { ball, players, action };
  }
  function draw(canvas, timeline, t, colours) {
    const context = canvas.getContext('2d'), scale = canvas.width / (L + 2 * M), px = value => (value + M) * scale;
    context.fillStyle = '#16492f'; context.fillRect(0, 0, canvas.width, canvas.height);
    for (let band = 0; band < 10; band++) { context.fillStyle = band % 2 ? '#1a5236' : '#1d5a3c'; context.fillRect(px(band * L / 10), px(0), L / 10 * scale, W * scale); }
    context.strokeStyle = 'rgba(255,255,255,.55)'; context.lineWidth = Math.max(1, scale * .3);
    context.strokeRect(px(0), px(0), L * scale, W * scale);
    context.beginPath(); context.moveTo(px(L / 2), px(0)); context.lineTo(px(L / 2), px(W)); context.stroke();
    context.beginPath(); context.arc(px(L / 2), px(W / 2), 8.7 * scale, 0, Math.PI * 2); context.stroke();
    for (const end of [0, L]) {
      const dir = end === 0 ? 1 : -1;
      context.strokeRect(Math.min(px(end), px(end + dir * 16)), px(W / 2 - 20), 16 * scale, 40 * scale);
      context.strokeRect(Math.min(px(end), px(end + dir * 5.5)), px(W / 2 - 9), 5.5 * scale, 18 * scale);
      context.fillStyle = 'rgba(255,255,255,.85)'; context.fillRect(Math.min(px(end), px(end - dir * 1.6)), px(W / 2 - 3.6), 1.6 * scale, 7.2 * scale);
    }
    const now = state(timeline, t), radius = 1.25 * scale;
    for (const player of now.players) {
      context.beginPath(); context.arc(px(player.x), px(player.y), radius, 0, Math.PI * 2);
      context.fillStyle = player.keeper ? colours[player.side + 'Keeper'] : colours[player.side]; context.fill();
      context.lineWidth = Math.max(1, scale * .25); context.strokeStyle = '#0c1018'; context.stroke();
    }
    const holder = now.players.find(player => player.holder);
    if (holder) {
      context.font = `700 ${Math.max(10, 2.6 * scale)}px system-ui, sans-serif`; context.textAlign = 'center';
      context.fillStyle = 'rgba(12,16,24,.75)'; const label = surname(holder.name), width = context.measureText(label).width + 8;
      context.fillRect(px(holder.x) - width / 2, px(holder.y) - radius - 3.4 * scale - 2, width, 3.4 * scale);
      context.fillStyle = '#fff'; context.fillText(label, px(holder.x), px(holder.y) - radius - 1.2 * scale);
    }
    context.beginPath(); context.arc(px(now.ball.x), px(now.ball.y), .85 * scale, 0, Math.PI * 2);
    context.fillStyle = '#fff'; context.fill(); context.lineWidth = 1; context.strokeStyle = '#111'; context.stroke();
    const goal = [...timeline.events].reverse().find(event => event.goal && event.t <= t && t - event.t < 1.3);
    if (goal) {
      context.fillStyle = 'rgba(12,16,24,.6)'; context.fillRect(0, canvas.height * .36, canvas.width, canvas.height * .28);
      context.textAlign = 'center'; context.fillStyle = colours[goal.side];
      context.font = `900 ${Math.round(canvas.height * .12)}px system-ui, sans-serif`; context.fillText('GOAL!', canvas.width / 2, canvas.height * .5);
      context.fillStyle = '#fff'; context.font = `700 ${Math.round(canvas.height * .05)}px system-ui, sans-serif`;
      context.fillText(goal.text.replace('GOAL! ', '') + (goal.assist ? ` · assist ${goal.assist}` : ''), canvas.width / 2, canvas.height * .59);
    }
  }
  const api = { build, state, draw, ASPECT: (W + 2 * M) / (L + 2 * M), END };
  if (typeof module !== 'undefined') module.exports = api; else scope.MatchView = api;
})(globalThis);
