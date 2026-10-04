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
  const api = {
    get enabled() { return enabled; },
    unlock() { if (enabled) audio(); },
    toggle() {
      enabled = !enabled;
      try { localStorage.setItem(key, enabled ? 'on' : 'off'); } catch {}
      if (enabled) { audio(); tone(880, 0, .12, { type: 'triangle' }); }
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
    sold(mine = false) {
      [523, 659, 784, mine ? 1047 : 988].forEach((frequency, index) => tone(frequency, index * .09, .28, { type: 'triangle', volume: .13 }));
    },
  };
  scope.TouchlineSound = api;
})(globalThis);
