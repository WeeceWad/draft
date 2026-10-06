(function (scope) {
  // Beta 2D match view, in the spirit of Football Manager's highlights. The result is already decided;
  // this plays it out. Each goal, and a few chances, becomes a highlight simulated with simple player physics:
  // a team shape that moves with the ball, pressing, runs, passes, crosses, shots, saves and restarts.
  // The clock fast-forwards between highlights. Only + - * / and sqrt are used, so every device
  // simulates exactly the same match from the same seed.
  const draft = typeof module !== 'undefined' ? require('./draft-core.js') : scope.DraftCore;
  const leagueCore = typeof module !== 'undefined' ? require('./league-core.js') : scope.LeagueCore;
  const LENGTH = 105, WIDTH = 68, DT = .1, PLAYBACK = 1.5, END = 97, SECOND = 48.6, POST = 3.66, MARGIN = 4;
  const WIDE = new Set(['LW', 'RW', 'LM', 'RM', 'LB', 'RB', 'LWB', 'RWB']);
  const ATTACKING = { ST: 6, LW: 4, RW: 4, CAM: 4, LM: 2, RM: 2, CM: 2, CDM: 1, LWB: 1, RWB: 1, LB: .5, RB: .5, CB: .5 };
  const clamp = (value, low, high) => value < low ? low : value > high ? high : value;
  const gap = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); };
  const other = side => side === 'home' ? 'away' : 'home';
  const surname = name => String(name || '').split(' ').at(-1);
  const round = value => Math.round(value * 100) / 100;
  function seeded(seed) { let state = seed >>> 0; return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; }; }
  const dirsAt = abs => abs < SECOND ? { home: 1, away: -1 } : { home: -1, away: 1 };
  function weighted(items, weights, random) {
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let draw = random() * total;
    for (let index = 0; index < items.length; index++) if ((draw -= weights[index]) <= 0) return items[index];
    return items[items.length - 1];
  }

  function simulate(spec) {
    const { random, dirs, plan } = spec, players = [];
    for (const side of ['home', 'away']) spec.teams[side].slots.forEach((slot, index) => {
      const info = spec.teams[side].squad[index] || {};
      players.push({ side, index, slot, role: slot.position, keeper: slot.position === 'GK', name: info.name || '', id: info.id, x: 0, y: 0, vx: 0, vy: 0, top: 6.4 + clamp((info.rating || 70) - 60, -10, 35) * .045, wx: 0, wy: 0, task: null });
    });
    const ball = { x: LENGTH / 2, y: WIDTH / 2, z: 0, owner: null, flight: null }, frames = [], events = [], steps = [];
    let possession = plan.side, t = 0, climax = null, next = 0, waitUntil = 0, ended = false, deadBall = false;
    const teamOf = side => players.filter(p => p.side === side);
    const outfield = side => teamOf(side).filter(p => !p.keeper);
    const goalX = side => dirs[side] === 1 ? LENGTH : 0;
    const ownGoalX = side => dirs[side] === 1 ? 0 : LENGTH;
    const depth = (side, point) => dirs[side] === 1 ? point.x : LENGTH - point.x;
    const keeperOf = side => players.find(p => p.side === side && p.keeper);
    const find = (side, id) => players.find(p => p.side === side && p.id === id);
    const nearest = (list, point) => list.slice().sort((a, b) => gap(a, point) - gap(b, point))[0];
    const say = (text, extra = {}) => events.push({ t, text, ...extra });
    const within = (point, side) => ({ x: clamp(point.x, dirs[side] === 1 ? 3 : 6, dirs[side] === 1 ? LENGTH - 6 : LENGTH - 3), y: clamp(point.y, 2, WIDTH - 2) });
    // Team shape: lines step up and drop with the ball; the side without it stays compact and narrow.
    function shape(p) {
      const dir = dirs[p.side], u = depth(p.side, ball), attacking = possession === p.side, toX = value => dir === 1 ? value : LENGTH - value;
      if (p.keeper) {
        const goal = { x: ownGoalX(p.side), y: WIDTH / 2 }, distance = gap(goal, ball) || 1, reach = clamp(distance * .1, 1.5, 6);
        if (attacking && u > 55) return { x: toX(clamp(u * .22, 5, 18)), y: WIDTH / 2 };
        return { x: goal.x + (ball.x - goal.x) / distance * reach, y: goal.y + (ball.y - goal.y) / distance * reach };
      }
      const line = clamp((100 - p.slot.y - 25) / 65, 0, 1);
      const back = attacking ? clamp(u - 32, 16, 58) : clamp(u - 20, 7, 48), front = attacking ? clamp(u + 16, 42, 96) : clamp(back + 30, 30, 75);
      const middle = WIDTH / 2, base = p.slot.x / 100 * WIDTH, spread = attacking ? (WIDE.has(p.role) ? 1.15 : 1) : .72;
      return { x: toX(back + (front - back) * line) + p.wx, y: clamp(middle + (base - middle) * spread + (ball.y - middle) * (attacking ? .18 : .32) + p.wy, 2, WIDTH - 2) };
    }
    const aim = task => typeof task.point === 'function' ? task.point() : task.point;
    // The nearest defender presses the ball; the next one covers the space behind.
    function defend() {
      for (const p of players) if (p.task?.auto) p.task = null;
      if (!possession || deadBall || ball.flight?.kind === 'shot') return;
      const side = other(possession), target = ball.flight ? ball.flight.to : ball, goal = { x: ownGoalX(side), y: WIDTH / 2 };
      const free = outfield(side).filter(p => !p.task).sort((a, b) => gap(a, target) - gap(b, target));
      const towardGoal = distance => { const length = gap(goal, target) || 1; return { x: target.x + (goal.x - target.x) / length * distance, y: target.y + (goal.y - target.y) / length * distance }; };
      if (free[0] && gap(free[0], target) < 26) free[0].task = { auto: true, sprint: true, point: () => towardGoal(1.4) };
      if (free[1] && gap(free[1], target) < 30) free[1].task = { auto: true, sprint: false, point: () => towardGoal(9) };
    }
    function move() {
      for (const p of players) {
        if (random() < DT / 3) { p.wx = (random() - .5) * 7; p.wy = (random() - .5) * 7; }
        const target = p.task ? aim(p.task) : shape(p), sprint = !!p.task?.sprint;
        const top = p.top * (sprint ? 1 : .55) * (ball.owner === p ? .82 : 1);
        const dx = target.x - p.x, dy = target.y - p.y, distance = Math.sqrt(dx * dx + dy * dy), want = distance > .05 ? Math.min(top, distance * 1.5) / distance : 0;
        let ax = dx * want - p.vx, ay = dy * want - p.vy;
        const pull = Math.sqrt(ax * ax + ay * ay), limit = 9 * DT;
        if (pull > limit) { ax *= limit / pull; ay *= limit / pull; }
        p.vx += ax; p.vy += ay;
      }
      for (const p of players) { p.x += p.vx * DT; p.y += p.vy * DT; }
      for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
        const a = players[i], b = players[j], dx = b.x - a.x, dy = b.y - a.y, squared = dx * dx + dy * dy;
        if (squared > 0 && squared < 2.89) { const distance = Math.sqrt(squared), push = (1.7 - distance) / distance * .25; a.x -= dx * push; a.y -= dy * push; b.x += dx * push; b.y += dy * push; }
      }
      for (const p of players) { p.x = clamp(p.x, -2, LENGTH + 2); p.y = clamp(p.y, -1.5, WIDTH + 1.5); }
    }
    function updateBall() {
      if (ball.flight) {
        const flight = ball.flight, s = clamp((t - flight.t0) / flight.dur, 0, 1), eased = flight.height ? s : s * (1.35 - .35 * s);
        ball.x = flight.from.x + (flight.to.x - flight.from.x) * eased; ball.y = flight.from.y + (flight.to.y - flight.from.y) * eased;
        ball.z = flight.height * 4 * s * (1 - s);
        if (s >= 1) {
          ball.flight = null; ball.z = 0;
          if (flight.receiver) { ball.owner = flight.receiver; possession = flight.receiver.side; flight.receiver.task = null; }
          if (flight.arrive) flight.arrive();
        }
      } else if (ball.owner) {
        const owner = ball.owner, speed = Math.sqrt(owner.vx * owner.vx + owner.vy * owner.vy);
        ball.x = owner.x + (speed > .3 ? owner.vx / speed * .75 : dirs[owner.side] * .6); ball.y = owner.y + (speed > .3 ? owner.vy / speed * .75 : 0);
      }
    }
    function kick(to, speed, height, kind, receiver = null, arrive = null) {
      const from = { x: ball.x, y: ball.y }, kicker = ball.owner;
      let dur = gap(from, to) / speed + .12;
      if (receiver && !receiver.keeper && kind !== 'shot') dur = Math.max(dur, gap(receiver, to) / (receiver.top * .95) + .1);
      ball.owner = null; if (kicker) kicker.task = null;
      ball.flight = { from, to, t0: t, dur, height, kind, receiver, arrive };
      if (receiver) receiver.task = { point: to, sprint: true };
    }
    // Steps run in order; each waits for the ball to land, then for the seconds it returns.
    const insert = (...list) => steps.splice(next, 0, ...list);
    function waitFor(condition, limit) { let deadline = null; const step = () => { if (deadline === null) deadline = t + limit; if (condition() || t >= deadline) return 0; insert(step); return .2; }; return step; }
    const release = () => () => { for (const p of players) p.task = null; return 0; };
    const hold = seconds => () => { const owner = ball.owner; if (owner) owner.task = { point: () => ({ x: owner.x + dirs[owner.side] * 2.5, y: owner.y }) }; return seconds; };
    const carry = (seconds, target) => () => { const owner = ball.owner; if (owner) owner.task = { point: target(owner), sprint: true }; return seconds; };
    function chooseReceiver(side, from, { forward = true, min = 6, max = 36 } = {}) {
      const options = outfield(side).filter(p => p !== ball.owner), opponents = teamOf(other(side));
      return weighted(options, options.map(p => {
        const distance = gap(p, from), progress = depth(side, p) - depth(side, from), open = Math.min(...opponents.map(o => gap(o, p)));
        if (distance < min || distance > max) return .02;
        return Math.max(.05, 1 + progress / 15 * (forward ? 1 : .2)) * (.5 + Math.min(open, 10) / 6);
      }), random);
    }
    const pass = (choose, kind = 'ground') => () => {
      const owner = ball.owner; if (!owner) return 0;
      const receiver = choose(owner);
      if (!receiver || receiver === owner) return .3;
      const to = within({ x: receiver.x + receiver.vx * .7 + dirs[receiver.side] * (kind === 'long' ? 4 : 2.5), y: receiver.y + receiver.vy * .7 }, receiver.side);
      kick(to, kind === 'long' ? 21 : kind === 'throw' ? 11 : 15, kind === 'long' ? 8 : kind === 'throw' ? 2 : 0, kind, receiver);
      return 0;
    };
    // A pass deflected into touch: the attacking side takes the throw-in.
    const outForThrow = () => () => {
      const owner = ball.owner; if (!owner) return 0;
      const side = owner.side, line = owner.y < WIDTH / 2 ? .2 : WIDTH - .2, spot = { x: clamp(owner.x + dirs[side] * (6 + random() * 10), 6, LENGTH - 6), y: line };
      kick(spot, 13, 0, 'ground', null, () => {
        say('Throw-in', { side });
        const thrower = nearest(outfield(side), spot);
        thrower.task = { point: { x: spot.x, y: line < 1 ? -.4 : WIDTH + .4 } };
        insert(waitFor(() => gap(thrower, spot) < 1.3, 4), () => { ball.owner = thrower; possession = side; return .7; }, pass(o => chooseReceiver(side, o, { forward: false, max: 20 }), 'throw'));
      });
      return 0;
    };
    function buildUp(side, count, finalReceiver) {
      const list = [];
      for (let index = 0; index < count; index++) {
        list.push(random() < .45 ? carry(.8 + random() * 1.2, o => within({ x: o.x + dirs[side] * (5 + random() * 8), y: o.y + (random() - .5) * 10 }, side)) : hold(.4 + random() * .8));
        if (index === 1 && random() < .22) list.push(outForThrow());
        const last = index === count - 1;
        list.push(pass(last && finalReceiver ? () => finalReceiver : o => chooseReceiver(side, o), !last && random() < .15 ? 'long' : 'ground'));
      }
      return list;
    }
    function celebrate(scorer) {
      const side = scorer.side, flag = { x: goalX(side) - dirs[side] * 3, y: scorer.y < WIDTH / 2 ? 3 : WIDTH - 3 };
      return [() => {
        possession = null; ball.owner = null; scorer.task = { point: flag, sprint: true };
        outfield(side).filter(p => p !== scorer).forEach(p => { p.task = { point: () => ({ x: scorer.x - dirs[side] * 2, y: scorer.y }) }; });
        return 3.4;
      }];
    }
    function goalKick(side) {
      const keeper = keeperOf(side), spot = { x: ownGoalX(side) + dirs[side] * 5.5, y: WIDTH / 2 + (random() - .5) * 14 };
      return [
        release(),
        () => { possession = side; keeper.task = { point: spot }; return 1; },
        () => { ball.x = spot.x; ball.y = spot.y; ball.z = 0; deadBall = true; say('Goal kick', { side }); return 0; },
        waitFor(() => gap(keeper, spot) < 1, 4),
        () => { ball.owner = keeper; return 1.2; },
        () => { deadBall = false; return 0; },
        pass(o => chooseReceiver(side, o, { min: 25, max: 60 }), 'long'), () => 1.2,
      ];
    }
    // Corners: attackers attack the box, defenders mark them, then the delivery.
    function corner(side, taker, target, finish) {
      const gx = goalX(side), dir = dirs[side], flag = { x: gx - dir * .4, y: random() < .5 ? .4 : WIDTH - .4 };
      const attackers = outfield(side).filter(p => p !== taker).sort((a, b) => depth(side, b) - depth(side, a)).slice(0, 5);
      if (target && !attackers.includes(target)) attackers[4] = target;
      const defending = other(side), markers = outfield(defending);
      return [
        release(),
        () => {
          say('Corner', { side }); possession = side; ball.owner = null; taker.task = { point: flag, sprint: true };
          attackers.forEach((p, index) => { p.task = { point: { x: gx - dir * (5 + (index % 3) * 3.5), y: WIDTH / 2 + (index - 2) * 3.4 } }; });
          const used = new Set();
          attackers.forEach(attacker => { const marker = nearest(markers.filter(p => !used.has(p)), attacker); if (marker) { used.add(marker); marker.task = { point: () => ({ x: attacker.x + dir, y: attacker.y }) }; } });
          return .8;
        },
        () => { ball.x = flag.x; ball.y = flag.y; ball.z = 0; deadBall = true; return 0; },
        waitFor(() => gap(taker, flag) < 1.3, 5),
        () => { ball.owner = taker; return 1.4; },
        () => {
          const header = target || attackers[Math.floor(random() * attackers.length)], landing = { x: gx - dir * (6 + random() * 4), y: WIDTH / 2 + (random() - .5) * 10 };
          say(`${surname(taker.name)} swings it in`, { side }); deadBall = false;
          if (finish === 'goal') { kick(landing, 19, 5.5, 'cross', header); insert(shoot(header, 'goal', { header: true })); }
          else if (finish === 'claim') { const keeper = keeperOf(defending); kick(landing, 19, 5.5, 'cross', keeper, () => say(`${surname(keeper.name)} claims it`, { side: defending })); insert(hold(1.2), pass(o => chooseReceiver(defending, o, { min: 15, max: 45 }), 'long'), () => 1, release()); }
          else {
            const clearer = nearest(markers, landing);
            kick(landing, 19, 5.5, 'cross', clearer, () => { say(`${surname(clearer.name)} heads it clear`, { side: defending }); kick(within({ x: landing.x - dir * 30, y: WIDTH / 2 + (random() - .5) * 40 }, defending), 18, 7, 'long'); possession = defending; });
            insert(() => 1.4, release());
          }
          return 0;
        },
      ];
    }
    function shoot(shooter, outcome, { header = false, speed: strike = null, height = null } = {}) {
      return () => {
        const side = shooter.side, gx = goalX(side), dir = dirs[side], defending = other(side), keeper = keeperOf(defending);
        if (ball.owner !== shooter) ball.owner = shooter;
        if (outcome !== 'goal') climax ??= t;
        deadBall = false;
        const speed = strike ?? (header ? 16 : 26), sign = random() < .5 ? -1 : 1;
        if (outcome === 'goal') {
          const to = { x: gx + dir * 1.6, y: WIDTH / 2 + sign * (POST - .5 - random() * 1.4) };
          keeper.task = { point: { x: gx - dir * .8, y: WIDTH / 2 - sign * 1.6 }, sprint: true };
          kick(to, speed, height ?? (header ? 1.4 : .9), 'shot', null, () => { climax = t; say(`GOAL! ${shooter.name}`, { side, goal: true, assist: plan.assistName || null }); insert(...celebrate(shooter)); });
        } else if (outcome === 'saved') {
          const to = { x: gx - dir * 1.3, y: WIDTH / 2 + (random() - .5) * 4.5 };
          say(`${surname(shooter.name)} shoots`, { side });
          kick(to, speed, height ?? .8, 'shot', keeper, () => say(`Saved by ${surname(keeper.name)}`, { side: defending }));
          insert(hold(1.4), pass(o => chooseReceiver(defending, o, { forward: false, min: 10, max: 35 })), () => 1.2, release());
        } else if (outcome === 'wide') {
          const to = { x: gx + dir * 2.5, y: WIDTH / 2 + sign * (POST + 1 + random() * 5) };
          say(`${surname(shooter.name)} shoots`, { side });
          kick(to, speed, height ?? 1.6, 'shot', null, () => { say(`${surname(shooter.name)} fires wide`, { side }); insert(...goalKick(defending)); });
        } else {
          const to = { x: gx + dir, y: WIDTH / 2 + sign * (POST + 2 + random() * 6) };
          const blocker = nearest(outfield(defending), { x: (shooter.x + gx) / 2, y: (shooter.y + WIDTH / 2) / 2 });
          if (blocker) blocker.task = { point: { x: shooter.x + (gx - shooter.x) * .2, y: shooter.y + (WIDTH / 2 - shooter.y) * .2 }, sprint: true };
          say(`${surname(shooter.name)} shoots`, { side });
          kick(to, 20, 1, 'shot', null, () => {
            say(`Blocked by ${surname(blocker?.name)}`, { side: defending });
            const taker = outfield(side).find(p => WIDE.has(p.role) && p.role !== 'LB' && p.role !== 'RB') || outfield(side)[0];
            insert(...corner(side, taker, null, random() < .35 ? 'claim' : 'clear'));
          });
        }
        return 0;
      };
    }
    function setPiece(side, kind, taker, victim, outcome) {
      const gx = goalX(side), dir = dirs[side], defending = other(side), keeper = keeperOf(defending);
      const spot = kind === 'penalty' ? { x: gx - dir * 11, y: WIDTH / 2 } : { x: gx - dir * (20 + random() * 8), y: WIDTH / 2 + (random() - .5) * 24 };
      const foul = kind === 'penalty' ? { x: gx - dir * (8 + random() * 6), y: WIDTH / 2 + (random() - .5) * 18 } : spot;
      const toGoal = { x: gx - spot.x, y: WIDTH / 2 - spot.y }, length = Math.sqrt(toGoal.x * toGoal.x + toGoal.y * toGoal.y) || 1, ux = toGoal.x / length, uy = toGoal.y / length;
      return [
        carry(1.8, () => foul),
        () => { const fouler = nearest(outfield(defending), ball); fouler.task = { point: () => ({ x: ball.x, y: ball.y }), sprint: true }; return .8; },
        () => {
          say(`Foul on ${surname(victim.name)}`, { side });
          say(kind === 'penalty' ? 'Penalty!' : 'Free kick in a dangerous position', { side, setPiece: kind });
          ball.owner = null; possession = side; deadBall = true;
          for (const p of players) p.task = null;
          ball.x = spot.x; ball.y = spot.y; ball.z = 0;
          taker.task = { point: { x: spot.x - ux * 2.4, y: spot.y - uy * 2.4 } };
          keeper.task = { point: kind === 'penalty' ? { x: gx, y: WIDTH / 2 } : { x: gx - dir * .8, y: WIDTH / 2 + (spot.y < WIDTH / 2 ? 1.6 : -1.6) } };
          if (kind === 'penalty') {
            // Everyone else waits outside the box, level with or behind the spot.
            players.filter(p => p !== taker && !p.keeper).forEach((p, index) => { p.task = { point: { x: gx - dir * (18 + (index % 3) * 2.2), y: WIDTH / 2 + (index - 9) * 2.6 } }; });
          } else {
            const wall = outfield(defending).sort((a, b) => gap(a, spot) - gap(b, spot)).slice(0, 4);
            wall.forEach((p, index) => { p.task = { point: { x: spot.x + ux * 9.15 - uy * (index - 1.5) * .8, y: spot.y + uy * 9.15 + ux * (index - 1.5) * .8 } }; });
            const runners = outfield(side).filter(p => p !== taker).sort((a, b) => depth(side, b) - depth(side, a)).slice(0, 4);
            runners.forEach((p, index) => { p.task = { point: { x: gx - dir * (7 + (index % 2) * 4), y: WIDTH / 2 + (index - 1.5) * 4 } }; });
            const markers = outfield(defending).filter(p => !wall.includes(p));
            runners.forEach(runner => { const marker = nearest(markers.filter(p => !p.task), runner); if (marker) marker.task = { point: () => ({ x: runner.x + dir, y: runner.y }) }; });
          }
          return 2.8;
        },
        () => { taker.task = { point: { x: spot.x, y: spot.y } }; return .6; },
        () => { ball.owner = taker; ball.x = spot.x; ball.y = spot.y; return .5; },
        shoot(taker, outcome, kind === 'penalty' ? { speed: 24, height: .6 } : { speed: 22, height: 3.4 }),
        () => 1, release(),
      ];
    }
    function start(side, fromOwnGoal) {
      ball.x = dirs[side] === 1 ? fromOwnGoal : LENGTH - fromOwnGoal; ball.y = 10 + random() * 48; possession = side;
      for (const p of players) { const point = shape(p); p.x = point.x; p.y = point.y; }
      const owner = nearest(outfield(side), ball);
      ball.owner = owner; owner.x = ball.x - dirs[side] * .7; owner.y = ball.y;
    }
    function attack(side, finisher, assister, outcome) {
      const n = 1 + Math.floor(random() * 3), gx = goalX(side), dir = dirs[side];
      const style = plan.style || (assister ? (WIDE.has(assister.role) || random() < .35 ? 'cross' : 'through') : 'solo');
      if (style === 'penalty' || style === 'freekick') {
        const victim = style === 'penalty' ? finisher : outfield(side).filter(p => p !== finisher).sort((a, b) => (ATTACKING[b.role] || 0) - (ATTACKING[a.role] || 0))[0] || finisher;
        start(side, 40 + random() * 15);
        insert(...buildUp(side, 1 + Math.floor(random() * 2), victim), ...setPiece(side, style, finisher, victim, outcome));
        return;
      }
      if (style === 'corner') {
        // A shot deflected behind, then the real assister's corner and the real scorer's header.
        const shooter = outfield(side).find(p => p !== finisher && p !== assister) || finisher;
        start(side, 55 + random() * 15);
        insert(...buildUp(side, 1, shooter), carry(1, o => within({ x: gx - dir * 20, y: o.y }, side)), () => {
          say(`${surname(shooter.name)} shoots`, { side });
          kick({ x: gx + dir, y: WIDTH / 2 + (random() < .5 ? -1 : 1) * (POST + 3) }, 20, 1, 'shot', null, () => {
            say('Deflected behind', { side: other(side) });
            insert(...corner(side, assister || finisher, finisher, outcome === 'goal' ? 'goal' : 'clear'));
          });
          return 0;
        });
        return;
      }
      start(side, 25 + random() * 22);
      if (style === 'cross') {
        const run = { x: gx - dir * (6 + random() * 5), y: WIDTH / 2 + (random() - .5) * 8 };
        insert(...buildUp(side, n, assister),
          () => { const owner = ball.owner; if (owner) owner.task = { point: { x: gx - dir * 13, y: owner.y < WIDTH / 2 ? 6 : WIDTH - 6 }, sprint: true }; finisher.task = { point: run, sprint: true }; return 2.2; },
          () => { say(`${surname(ball.owner?.name)} crosses`, { side }); kick(run, 20, 5, 'cross', finisher); return 0; },
          shoot(finisher, outcome, { header: true }));
      } else if (style === 'through') {
        const run = { x: gx - dir * (14 + random() * 5), y: WIDTH / 2 + (random() - .5) * 18 };
        insert(...buildUp(side, n, assister),
          () => { finisher.task = { point: run, sprint: true }; return .7; },
          () => { say(`${surname(ball.owner?.name)} slides it through`, { side }); kick(run, 17, 0, 'through', finisher); return 0; },
          carry(.6, o => ({ x: o.x + dir * 4, y: o.y + (WIDTH / 2 - o.y) * .2 })),
          shoot(finisher, outcome));
      } else {
        insert(...buildUp(side, n, finisher),
          carry(2.4, () => ({ x: gx - dir * (17 + random() * 6), y: WIDTH / 2 + (random() - .5) * 16 })),
          shoot(finisher, outcome));
      }
    }
    // Plans: a kick-off, a real goal, or a chance that ends in a save, a goal kick or a corner.
    if (plan.kind === 'kickoff') {
      ball.x = LENGTH / 2; ball.y = WIDTH / 2;
      for (const p of players) { const point = shape(p), limit = LENGTH / 2 - .8; p.x = dirs[p.side] === 1 ? Math.min(point.x, limit) : Math.max(point.x, LENGTH - limit); p.y = point.y; }
      const kicker = nearest(outfield(plan.side), ball); kicker.x = LENGTH / 2 - dirs[plan.side] * .5; kicker.y = WIDTH / 2;
      ball.owner = kicker; say('Kick-off', { side: plan.side });
      insert(hold(.6), pass(o => chooseReceiver(plan.side, o, { forward: false, max: 20 })), ...buildUp(plan.side, 2), () => 1);
    } else {
      const side = plan.side, attackers = outfield(side);
      const finisher = (plan.scorerId && find(side, plan.scorerId)) || weighted(attackers, attackers.map(p => ATTACKING[p.role] || .5), random);
      const others = attackers.filter(p => p !== finisher);
      const assister = plan.assistId ? find(side, plan.assistId) : plan.kind === 'chance' && random() < .6 ? weighted(others, others.map(p => ATTACKING[p.role] || .5), random) : null;
      attack(side, finisher, assister === finisher ? null : assister, plan.kind === 'goal' ? 'goal' : plan.outcome);
    }
    const record = () => frames.push([round(ball.x), round(ball.y), round(ball.z), ball.owner ? players.indexOf(ball.owner) : -1, ...players.flatMap(p => [round(p.x), round(p.y)])]);
    record();
    for (let index = 0; index < 600 && !ended; index++) {
      while (!ended && !ball.flight && t >= waitUntil) {
        if (next >= steps.length) { ended = true; break; }
        waitUntil = t + (steps[next++]() || 0);
      }
      defend(); move(); t += DT; updateBall(); record();
    }
    return { frames, events, climax: climax ?? t / 2, length: (frames.length - 1) * DT, players: players.map(p => ({ side: p.side, keeper: p.keeper, name: p.name, number: p.keeper ? 1 : p.index + 2 })) };
  }

  // A fixture's highlights, placed on the 0–97 match clock and fitted into the matchday's real duration.
  function build({ result, home, away, seed, duration, from = 0, to = END }) {
    const random = seeded(seed ^ 0x5eedba11);
    const slotsOf = team => draft.formations[team.formation] || draft.formations['4-3-3'];
    const teams = { home: { squad: home.squad, slots: slotsOf(home) }, away: { squad: away.squad, slots: slotsOf(away) } };
    const goals = [...result.homeScorers.map(goal => ({ ...goal, side: 'home' })), ...result.awayScorers.map(goal => ({ ...goal, side: 'away' }))].map(goal => ({ ...goal, abs: leagueCore.absoluteMinute(goal) }));
    // One half at a time in substitutes mode: only what happens between from and to is played out.
    const plans = [{ kind: 'kickoff', side: 'home', abs: 0, priority: 3 }, { kind: 'kickoff', side: 'away', abs: SECOND, priority: 3 }].filter(plan => plan.abs >= from && plan.abs < to);
    let penalties = 0;
    goals.filter(goal => goal.abs > from - (from ? 0 : 1) && goal.abs <= to).forEach(goal => {
      const roll = random();
      let style = goal.assistId ? (roll < .15 ? 'corner' : null) : roll < .25 && penalties < 2 ? 'penalty' : roll < .36 ? 'freekick' : null;
      if (style === 'penalty') penalties++;
      plans.push({ kind: 'goal', side: goal.side, abs: goal.abs, scorerId: goal.playerId, assistId: goal.assistId, assistName: goal.assistName, priority: 2, style });
    });
    const homeXg = result.homeXg || 1.4, awayXg = result.awayXg || 1.2;
    function chance(side, priority) {
      for (let attempt = 0; attempt < 30; attempt++) {
        const abs = from + 4 + random() * (to - from - 7);
        if (Math.abs(abs - SECOND) < 2.5 || plans.some(item => Math.abs(item.abs - abs) < 3.5)) continue;
        const roll = random(), set = random(), style = set < .015 && penalties === 0 ? 'penalty' : set < .11 ? 'freekick' : null;
        if (style === 'penalty') penalties++;
        const outcome = style ? (roll < .55 ? 'saved' : 'wide') : roll < .4 ? 'saved' : roll < .72 ? 'wide' : 'blocked';
        const plan = { kind: 'chance', side, abs, outcome, style, priority: priority - attempt * .001 };
        plans.push(plan); return plan;
      }
      return null;
    }
    for (const side of ['home', 'away']) {
      const count = clamp(Math.floor((side === 'home' ? homeXg : awayXg) * 1.3 + random() * 1.6), 1, 4);
      for (let index = 0; index < count; index++) chance(side, 1 - index * .1);
    }
    const play = (plan, index) => {
      const run = simulate({ plan, dirs: dirsAt(plan.abs), teams, random: seeded((seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0) });
      return { ...run, plan, cut: plan.kind === 'kickoff' ? 0 : Math.max(0, run.climax - 16) };
    };
    let highlights = plans.map(play);
    const real = speed => highlights.reduce((sum, item) => sum + (item.length - item.cut) / speed, 0);
    // Quiet matches get extra chances, mostly for the stronger side, so the matchday is mostly football.
    for (let extra = 0; extra < 12 && real(PLAYBACK) < duration * .62; extra++) {
      const plan = chance(random() < homeXg / (homeXg + awayXg) ? 'home' : 'away', .5 - extra * .01);
      if (!plan) break;
      highlights.push(play(plan, plans.length - 1));
    }
    // Drop the least important chances until everything fits; speed up only if goals alone would not.
    highlights.sort((a, b) => b.plan.priority - a.plan.priority);
    while (real(PLAYBACK) > duration * .8 && highlights.at(-1).plan.kind === 'chance') highlights.pop();
    const speed = Math.max(PLAYBACK, highlights.reduce((sum, item) => sum + item.length - item.cut, 0) / (duration * .85));
    highlights.sort((a, b) => a.plan.abs - b.plan.abs);
    let previousEnd = 0;
    const place = item => item.plan.kind === 'kickoff' ? item.plan.abs : item.plan.abs - (item.climax - item.cut) / 60;
    for (const item of highlights) {
      item.a0 = place(item);
      if (item.a0 < previousEnd) { item.cut = Math.min(item.cut + (previousEnd - item.a0) * 60, Math.max(item.cut, item.climax - 2)); item.a0 = place(item); }
      item.a1 = item.a0 + (item.length - item.cut) / 60; previousEnd = item.a1;
    }
    const highlightReal = real(speed);
    let gapsAbs = Math.max(0, to - highlights.at(-1).a1), last = highlights[0].a1;
    for (const item of highlights.slice(1)) { gapsAbs += Math.max(0, item.a0 - last); last = item.a1; }
    const budget = Math.max(0, duration - 1 - highlightReal), pieces = [];
    let r = 0, a = from, previous = null;
    for (const item of highlights) {
      const between = item.a0 - a;
      if (between > 0) { const length = gapsAbs ? budget * between / gapsAbs : 0; pieces.push({ r0: r, r1: r + length, a0: a, a1: item.a0, from: previous, to: item }); r += length; }
      const length = (item.length - item.cut) / speed;
      pieces.push({ r0: r, r1: r + length, a0: item.a0, a1: item.a1, item }); r += length; a = item.a1; previous = item;
    }
    pieces.push({ r0: r, r1: Math.max(r + .001, duration - 1), a0: Math.min(a, to), a1: to, from: previous, to: null });
    const events = highlights.flatMap(item => item.events.filter(event => event.t >= item.cut).map(event => ({ ...event, abs: event.goal ? item.plan.abs : item.a0 + (event.t - item.cut) / 60 })));
    if (from < 48 && to >= 48) events.push({ abs: 48, text: 'Half-time' });
    if (to === END) events.push({ abs: END, text: 'Full time' });
    return { pieces, events: events.sort((a, b) => a.abs - b.abs), speed, players: highlights[0].players, highlights };
  }
  const pieceAt = (timeline, r) => timeline.pieces.find(piece => r < piece.r1) || timeline.pieces.at(-1);
  function clockAt(timeline, r) {
    const piece = pieceAt(timeline, r);
    if (r >= piece.r1) return Math.min(END, piece.a1);
    return Math.min(END, piece.a0 + (piece.a1 - piece.a0) * clamp((r - piece.r0) / Math.max(.001, piece.r1 - piece.r0), 0, 1));
  }
  function frameOf(item, seconds) {
    const position = clamp(seconds / DT, 0, item.frames.length - 1), low = Math.floor(position), high = Math.min(item.frames.length - 1, low + 1), s = position - low;
    const a = item.frames[low], b = item.frames[high];
    return a.map((value, index) => index === 3 ? (s < .5 ? a[3] : b[3]) : value + (b[index] - value) * s);
  }
  function stateAt(timeline, r) {
    const piece = pieceAt(timeline, r);
    if (piece.item) return { frame: frameOf(piece.item, piece.item.cut + (r - piece.r0) * timeline.speed), fast: false };
    const from = piece.from ? frameOf(piece.from, piece.from.length) : null, to = piece.to ? frameOf(piece.to, piece.to.cut) : null;
    const s = clamp((r - piece.r0) / Math.max(.001, piece.r1 - piece.r0), 0, 1), smooth = s * s * (3 - 2 * s), start = from || to, end = to || from;
    return { frame: start.map((value, index) => index === 3 ? -1 : value + (end[index] - value) * smooth), fast: piece.r1 - piece.r0 > .4 && r < piece.r1 };
  }
  function intensity(timeline, r) {
    const { frame, fast } = stateAt(timeline, r), toGoal = Math.min(frame[0], LENGTH - frame[0]);
    return fast ? .15 : clamp(1.15 - toGoal / 40, .2, 1);
  }
  function draw(canvas, timeline, r, colours) {
    const context = canvas.getContext('2d'), scale = canvas.width / (LENGTH + 2 * MARGIN), px = value => (value + MARGIN) * scale;
    const { frame, fast } = stateAt(timeline, r), clock = clockAt(timeline, r);
    context.fillStyle = '#16492f'; context.fillRect(0, 0, canvas.width, canvas.height);
    for (let band = 0; band < 12; band++) { context.fillStyle = band % 2 ? '#1a5236' : '#1d5a3c'; context.fillRect(px(band * LENGTH / 12), px(0), LENGTH / 12 * scale + 1, WIDTH * scale); }
    context.strokeStyle = 'rgba(255,255,255,.6)'; context.lineWidth = Math.max(1, scale * .18);
    context.strokeRect(px(0), px(0), LENGTH * scale, WIDTH * scale);
    context.beginPath(); context.moveTo(px(LENGTH / 2), px(0)); context.lineTo(px(LENGTH / 2), px(WIDTH)); context.stroke();
    context.beginPath(); context.arc(px(LENGTH / 2), px(WIDTH / 2), 9.15 * scale, 0, Math.PI * 2); context.stroke();
    for (const end of [0, LENGTH]) {
      const dir = end === 0 ? 1 : -1;
      context.strokeRect(Math.min(px(end), px(end + dir * 16.5)), px(WIDTH / 2 - 20.16), 16.5 * scale, 40.32 * scale);
      context.strokeRect(Math.min(px(end), px(end + dir * 5.5)), px(WIDTH / 2 - 9.16), 5.5 * scale, 18.32 * scale);
      context.beginPath(); context.arc(px(end + dir * 11), px(WIDTH / 2), 9.15 * scale, dir === 1 ? -.93 : Math.PI - .93, dir === 1 ? .93 : Math.PI + .93); context.stroke();
      context.fillStyle = 'rgba(255,255,255,.9)'; context.fillRect(Math.min(px(end), px(end - dir * 1.8)), px(WIDTH / 2 - POST), 1.8 * scale, POST * 2 * scale);
    }
    const radius = 1.2 * scale;
    context.textAlign = 'center'; context.textBaseline = 'middle';
    timeline.players.forEach((player, index) => {
      const x = px(frame[4 + index * 2]), y = px(frame[5 + index * 2]);
      context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2);
      context.fillStyle = player.keeper ? colours[player.side + 'Keeper'] : colours[player.side]; context.fill();
      context.lineWidth = Math.max(1, scale * .2); context.strokeStyle = '#0c1018'; context.stroke();
      context.fillStyle = '#0c1018'; context.font = `800 ${Math.max(8, radius * 1.1)}px system-ui, sans-serif`; context.fillText(String(player.number), x, y + .5);
    });
    const owner = frame[3] >= 0 ? timeline.players[frame[3]] : null;
    if (owner && !fast) {
      const x = px(frame[4 + frame[3] * 2]), y = px(frame[5 + frame[3] * 2]) - radius - 2.2 * scale, label = surname(owner.name);
      context.font = `700 ${Math.max(10, 2.3 * scale)}px system-ui, sans-serif`;
      const width = context.measureText(label).width + 10;
      context.fillStyle = 'rgba(12,16,24,.8)'; context.fillRect(x - width / 2, y - 1.4 * scale, width, 2.8 * scale);
      context.fillStyle = '#fff'; context.fillText(label, x, y);
    }
    const ballX = px(frame[0]), ballY = px(frame[1]), height = frame[2];
    context.fillStyle = 'rgba(0,0,0,.35)'; context.beginPath(); context.ellipse(ballX, ballY, .7 * scale, .45 * scale, 0, 0, Math.PI * 2); context.fill();
    context.beginPath(); context.arc(ballX, ballY - height * .55 * scale, (.6 + height * .035) * scale, 0, Math.PI * 2);
    context.fillStyle = '#fff'; context.fill(); context.lineWidth = 1; context.strokeStyle = '#111'; context.stroke();
    if (fast) {
      context.fillStyle = 'rgba(12,16,24,.25)'; context.fillRect(0, 0, canvas.width, canvas.height);
      const label = '⏩  Fast-forward', size = Math.round(canvas.height * .04);
      context.font = `800 ${size}px system-ui, sans-serif`;
      const width = context.measureText(label).width + size * 1.6;
      context.fillStyle = 'rgba(12,16,24,.75)'; context.fillRect(canvas.width / 2 - width / 2, px(1.5), width, size * 1.8);
      context.fillStyle = '#fff'; context.fillText(label, canvas.width / 2, px(1.5) + size * .9);
    }
    const goal = [...timeline.events].reverse().find(event => event.goal && event.abs <= clock && clock - event.abs < .045);
    if (goal) {
      context.fillStyle = 'rgba(12,16,24,.6)'; context.fillRect(0, canvas.height * .36, canvas.width, canvas.height * .28);
      context.fillStyle = colours[goal.side]; context.font = `900 ${Math.round(canvas.height * .12)}px system-ui, sans-serif`; context.fillText('GOAL!', canvas.width / 2, canvas.height * .47);
      context.fillStyle = '#fff'; context.font = `700 ${Math.round(canvas.height * .05)}px system-ui, sans-serif`;
      context.fillText(goal.text.replace('GOAL! ', '') + (goal.assist ? ` · assist ${goal.assist}` : ''), canvas.width / 2, canvas.height * .58);
    }
  }
  const api = { build, simulate, clockAt, stateAt, intensity, draw, ASPECT: (WIDTH + 2 * MARGIN) / (LENGTH + 2 * MARGIN), END };
  if (typeof module !== 'undefined') module.exports = api; else scope.MatchView = api;
})(globalThis);
