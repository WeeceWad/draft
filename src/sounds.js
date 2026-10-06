(function (scope) {
  // Synthesised effects: no audio files, and nothing plays until the first tap unlocks audio.
  const key = 'touchline-sound';
  let context = null, enabled = true;
  try { enabled = localStorage.getItem(key) !== 'off'; } catch {}
  function audio() {
    const Audio = scope.AudioContext || scope.webkitAudioContext;
    if (!Audio) return null;
    if (!context) context = new Audio();
    if (context.state === 'suspended') context.resume().catch(() => {});
    return context;
  }
  function tone(frequency, start, duration, { type = 'sine', volume = .14, slide = null } = {}) {
    const output = enabled && context && audio();
    if (!output) return;
    const at = output.currentTime + start, oscillator = output.createOscillator(), gain = output.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, at);
    if (slide) oscillator.frequency.exponentialRampToValueAtTime(slide, at + duration);
    gain.gain.setValueAtTime(.0001, at);
    gain.gain.exponentialRampToValueAtTime(volume, at + .01);
    gain.gain.exponentialRampToValueAtTime(.0001, at + duration);
    oscillator.connect(gain).connect(output.destination);
    oscillator.start(at); oscillator.stop(at + duration + .05);
  }
  // Crowd: filtered noise that murmurs, swells as attacks build, and roars for goals.
  let crowd = null;
  function noise(output, seconds) {
    const buffer = output.createBuffer(1, output.sampleRate * seconds, output.sampleRate), data = buffer.getChannelData(0);
    let brown = 0;
    for (let index = 0; index < data.length; index++) { brown = (brown + .02 * (Math.random() * 2 - 1)) / 1.02; data[index] = brown * 3.5; }
    return buffer;
  }
  function crowdLevel(level) {
    const output = enabled && context && audio();
    if (!output) return;
    if (!crowd) {
      const source = output.createBufferSource(), filter = output.createBiquadFilter(), gain = output.createGain();
      source.buffer = noise(output, 3); source.loop = true;
      filter.type = 'lowpass'; filter.frequency.value = 900; gain.gain.value = 0;
      source.connect(filter).connect(gain).connect(output.destination); source.start();
      crowd = { source, gain, filter, level: -1 };
    }
    if (Math.abs(level - crowd.level) < .03) return;
    crowd.level = level;
    crowd.gain.gain.setTargetAtTime(.04 + level * .2, output.currentTime, .6);
    crowd.filter.frequency.setTargetAtTime(700 + level * 900, output.currentTime, .6);
  }
  function crowdStop() {
    if (!crowd) return;
    const ending = crowd; crowd = null;
    try { ending.gain.gain.setTargetAtTime(0, context.currentTime, .4); ending.source.stop(context.currentTime + 2); } catch {}
  }
  function roar() {
    const output = enabled && context && audio();
    if (!output) return;
    const source = output.createBufferSource(), filter = output.createBiquadFilter(), gain = output.createGain(), at = output.currentTime;
    source.buffer = noise(output, 4); filter.type = 'bandpass'; filter.frequency.setValueAtTime(600, at); filter.frequency.linearRampToValueAtTime(1300, at + .6); filter.Q.value = .6;
    gain.gain.setValueAtTime(.0001, at); gain.gain.exponentialRampToValueAtTime(1.1, at + .35); gain.gain.exponentialRampToValueAtTime(.0001, at + 3.8);
    source.connect(filter).connect(gain).connect(output.destination); source.start(at); source.stop(at + 4);
  }
  const api = {
    crowd: crowdLevel, crowdStop, roar,
    get enabled() { return enabled; },
    unlock() { if (enabled) audio(); },
    toggle() {
      enabled = !enabled;
      try { localStorage.setItem(key, enabled ? 'on' : 'off'); } catch {}
      if (enabled) { audio(); tone(880, 0, .12, { type: 'triangle' }); } else crowdStop();
      return enabled;
    },
    // Wheel clicks that slow down like a decelerating spinner, then a reveal chime.
    spin(seconds) {
      let time = 0, gap = .04;
      while (time < seconds - .15) { tone(1500, time, .025, { type: 'square', volume: .04 }); time += gap; gap *= 1.11; }
      tone(523, seconds, .18, { type: 'triangle' }); tone(784, seconds + .09, .32, { type: 'triangle' });
    },
    bid(mine = false) {
      const base = mine ? 880 : 660;
      tone(base, 0, .1, { type: 'triangle', volume: .16 }); tone(base * 1.5, .07, .16, { type: 'triangle', volume: .14 });
    },
    goal() {
      [392, 523, 659, 784, 1047].forEach((frequency, index) => tone(frequency, index * .07, .35, { type: 'triangle', volume: .12 }));
    },
    // Two short referee blasts for kick-off and full time.
    whistle() {
      [0, .3].forEach(start => tone(2900, start, .2, { type: 'square', volume: .035, slide: 2700 }));
    },
    sold(mine = false) {
      [523, 659, 784, mine ? 1047 : 988].forEach((frequency, index) => tone(frequency, index * .09, .28, { type: 'triangle', volume: .13 }));
    },
  };
  scope.TouchlineSound = api;
})(globalThis);
