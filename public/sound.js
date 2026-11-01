'use strict';

/*
 * Звуки дома без файлов: всё синтезируется WebAudio.
 *   GHSound.create(getContext) → { update(state), play(kind), stop() }
 * state: { place, technical, dark, fogLeak, fogOutside, steps, climate, night }
 * Фоновые слои плавно появляются и гаснут; разовые звуки ЖЭК — play('bang' | 'scrape' | 'cry' | 'steps' | 'whisper').
 */
(function (global) {
  function create(getCtx) {
    let a = null;
    let master = null;
    let noise = null;
    const layers = {};
    let dripTimer = null;
    let stepTimer = null;
    let clatterTimer = null;
    let state = {};

    function ctx() {
      const c = getCtx();
      if (!c) return null;
      if (c !== a) {
        a = c;
        master = a.createGain();
        master.gain.value = 0.9;
        master.connect(a.destination);
        noise = makeNoise(a);
        for (const k of Object.keys(layers)) delete layers[k];
      }
      return a;
    }

    function makeNoise(c) {
      const buf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return buf;
    }

    function noiseSource() {
      const src = a.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      src.start();
      return src;
    }

    /** Слой: создаётся один раз, громкость меняется плавно. */
    function layer(name, build) {
      if (!layers[name]) {
        const g = a.createGain();
        g.gain.value = 0;
        g.connect(master);
        build(g);
        layers[name] = g;
      }
      return layers[name];
    }

    function setLevel(name, build, level) {
      if (!level && !layers[name]) return;
      const g = layer(name, build);
      g.gain.setTargetAtTime(level, a.currentTime, 0.8);
    }

    // --- постоянные слои ---
    const buildHum = (g) => {
      // «дыхание» ламп — на своём узле: громкость слоя (g) остаётся только за setLevel,
      // иначе колебание складывалось бы с ней, гул гремел и не затихал при уходе из коридора
      const breath = a.createGain();
      breath.gain.value = 0.7;
      breath.connect(g);
      for (const [f, v] of [[100, 1], [150, 0.5], [50, 0.7]]) {
        const o = a.createOscillator();
        const og = a.createGain();
        o.frequency.value = f;
        og.gain.value = v;
        o.connect(og).connect(breath);
        o.start();
      }
      const lfo = a.createOscillator();
      const lg = a.createGain();
      lfo.frequency.value = 0.3;
      lg.gain.value = 0.3;
      lfo.connect(lg).connect(breath.gain);
      lfo.start();
    };
    const buildMachines = (g) => {
      const src = noiseSource();
      const bp = a.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 220;
      bp.Q.value = 2;
      const am = a.createGain();
      am.gain.value = 0.6;
      const lfo = a.createOscillator();
      const lg = a.createGain();
      lfo.frequency.value = 2.2;
      lg.gain.value = 0.4;
      lfo.connect(lg).connect(am.gain);
      lfo.start();
      src.connect(bp).connect(am).connect(g);
    };
    const buildWind = (g) => {
      const src = noiseSource();
      const bp = a.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900;
      bp.Q.value = 6;
      const lfo = a.createOscillator();
      const lg = a.createGain();
      lfo.frequency.value = 0.12;
      lg.gain.value = 500;
      lfo.connect(lg).connect(bp.frequency);
      lfo.start();
      src.connect(bp).connect(g);
    };
    const buildMurmur = (g) => {
      const src = noiseSource();
      const lp = a.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 380;
      src.connect(lp).connect(g);
    };
    const buildHeat = (g) => {
      const o = a.createOscillator();
      o.frequency.value = 60;
      o.type = 'triangle';
      o.connect(g);
      o.start();
    };

    // --- короткие звуки ---
    function blip(freq, dur, vol, type = 'sine', slideTo = null, delay = 0, dest = master) {
      const t = a.currentTime + delay;
      const o = a.createOscillator();
      const g = a.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(dest);
      o.start(t);
      o.stop(t + dur + 0.05);
    }

    function thump(vol, delay = 0, cutoff = 140) {
      const t = a.currentTime + delay;
      const src = a.createBufferSource();
      src.buffer = noise;
      const lp = a.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = cutoff;
      const g = a.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      src.connect(lp).connect(g).connect(master);
      src.start(t);
      src.stop(t + 0.25);
      blip(55, 0.2, vol * 0.6, 'sine', 40, delay);
    }

    function scheduleDrips() {
      clearTimeout(dripTimer);
      const s = state;
      const wet = s.technical || s.place === 'medpost' || s.climate === 'damp' || (s.place === 'home' && s.night);
      if (!wet) return;
      dripTimer = setTimeout(() => {
        if (ctx()) blip(1300 + Math.random() * 500, 0.12, 0.03, 'sine', 600);
        scheduleDrips();
      }, 1500 + Math.random() * 3500);
    }

    function scheduleSteps() {
      clearTimeout(stepTimer);
      if (!state.steps) return;
      stepTimer = setTimeout(() => {
        if (ctx()) thump(Math.min(0.05, 0.015 * state.steps), 0, 110);
        scheduleSteps();
      }, 420 + Math.random() * 120);
    }

    function scheduleClatter() {
      clearTimeout(clatterTimer);
      if (state.place !== 'canteen') return;
      clatterTimer = setTimeout(() => {
        if (ctx()) blip(2400 + Math.random() * 800, 0.06, 0.012, 'triangle');
        scheduleClatter();
      }, 2000 + Math.random() * 4000);
    }

    function update(next) {
      const prev = state;
      state = next || {};
      if (!ctx()) return;
      const s = state;
      const lit = !s.dark;
      setLevel('hum', buildHum, (s.place === 'corridor' || s.place === 'factory' || s.place === 'medpost') && lit ? 0.006 : 0);
      setLevel('machines', buildMachines, s.place === 'factory' && lit ? 0.05 : 0);
      setLevel('wind', buildWind, s.fogLeak ? 0.05 : s.fogOutside || s.climate === 'draft' ? 0.025 : s.climate === 'cold' ? 0.015 : 0);
      setLevel('murmur', buildMurmur, s.place === 'canteen' ? 0.02 : 0);
      setLevel('heat', buildHeat, s.climate === 'heat' ? 0.012 : 0);
      const changed = (k) => prev[k] !== s[k];
      if (changed('place') || changed('technical') || changed('climate') || changed('night')) scheduleDrips();
      if (changed('steps')) scheduleSteps();
      if (changed('place')) scheduleClatter();
    }

    /** Разовый звук «в доме» из Пульта. */
    function play(kind) {
      if (!ctx()) return;
      if (kind === 'bang') {
        for (let i = 0; i < 3; i++) thump(0.25, i * 0.55, 160);
      } else if (kind === 'scrape') {
        const t = a.currentTime;
        const o = a.createOscillator();
        const g = a.createGain();
        const bp = a.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 400;
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(190, t);
        o.frequency.linearRampToValueAtTime(110, t + 1.8);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.05, t + 0.2);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.9);
        o.connect(bp).connect(g).connect(master);
        o.start(t);
        o.stop(t + 2);
      } else if (kind === 'cry') {
        // приглушённый плач «за стеной»: дрожащий тон через низкочастотный фильтр
        const lp = a.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 650;
        lp.connect(master);
        for (let i = 0; i < 4; i++) {
          const t = a.currentTime + i * 0.9;
          const o = a.createOscillator();
          const g = a.createGain();
          const vib = a.createOscillator();
          const vg = a.createGain();
          o.type = 'triangle';
          o.frequency.setValueAtTime(420 + Math.random() * 40, t);
          o.frequency.linearRampToValueAtTime(330, t + 0.7);
          vib.frequency.value = 7;
          vg.gain.value = 14;
          vib.connect(vg).connect(o.frequency);
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.03, t + 0.1);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
          o.connect(g).connect(lp);
          o.start(t);
          vib.start(t);
          o.stop(t + 0.8);
          vib.stop(t + 0.8);
        }
      } else if (kind === 'steps') {
        for (let i = 0; i < 8; i++) thump(0.09, i * 0.62, 90);
      } else if (kind === 'whisper') {
        const t = a.currentTime;
        const src = a.createBufferSource();
        src.buffer = noise;
        const bp = a.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 3200;
        bp.Q.value = 1.5;
        const g = a.createGain();
        g.gain.setValueAtTime(0.0001, t);
        for (let i = 0; i < 6; i++) {
          g.gain.exponentialRampToValueAtTime(0.03 + Math.random() * 0.03, t + i * 0.3 + 0.1);
          g.gain.exponentialRampToValueAtTime(0.002, t + i * 0.3 + 0.28);
        }
        src.connect(bp).connect(g).connect(master);
        src.start(t);
        src.stop(t + 2);
      }
    }

    function stop() {
      update({});
      clearTimeout(dripTimer);
      clearTimeout(stepTimer);
      clearTimeout(clatterTimer);
    }

    return { update, play, stop };
  }

  global.GHSound = { create };
})(typeof window !== 'undefined' ? window : globalThis);
