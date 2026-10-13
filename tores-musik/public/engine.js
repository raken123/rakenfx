// Ljudmotorn: music theory, synths, playback, WAV export and pitch detection.
// Everything is synthesized with the Web Audio API, so no samples are needed.
'use strict';

const Engine = (() => {
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const TRACKS = ['drums', 'bass', 'chords', 'lead', 'vocal'];

  const midiName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function pitchClass(letter, acc) {
    let pc = PC[letter.toUpperCase()];
    if (acc === '#') pc += 1;
    if (acc === 'b') pc -= 1;
    return (pc + 12) % 12;
  }

  const QUALITIES = [
    ['maj9', [0, 4, 7, 11, 14]], ['maj7', [0, 4, 7, 11]], ['maj', [0, 4, 7]],
    ['m7b5', [0, 3, 6, 10]], ['m9', [0, 3, 7, 10, 14]], ['m7', [0, 3, 7, 10]], ['m6', [0, 3, 7, 9]],
    ['madd9', [0, 3, 7, 14]], ['min', [0, 3, 7]], ['m', [0, 3, 7]],
    ['dim7', [0, 3, 6, 9]], ['dim', [0, 3, 6]], ['aug', [0, 4, 8]], ['+', [0, 4, 8]],
    ['sus2', [0, 2, 7]], ['sus4', [0, 5, 7]], ['sus', [0, 5, 7]], ['add9', [0, 4, 7, 14]],
    ['9', [0, 4, 7, 10, 14]], ['7', [0, 4, 7, 10]], ['6', [0, 4, 7, 9]], ['5', [0, 7]], ['', [0, 4, 7]],
  ];

  // "Am7" -> { root: 9, bass: 9, intervals: [0,3,7,10] }; "C/E" puts E in the bass.
  function parseChord(sym) {
    const s = String(sym || '').trim();
    const m = s.match(/^([A-Ga-g])([#b]?)([^/]*)(?:\/([A-Ga-g])([#b]?))?$/);
    if (!m) return null;
    const root = pitchClass(m[1], m[2]);
    const q = m[3].trim();
    let intervals = (QUALITIES.find(([name]) => q.startsWith(name)) || [null, null])[1];
    if (!intervals) intervals = /^m(?!aj)/.test(q) ? [0, 3, 7] : [0, 4, 7];
    const bass = m[4] ? pitchClass(m[4], m[5]) : root;
    return { root, bass, intervals };
  }

  // "A minor", "Am", "F# moll", "C dur" -> { tonic, scale }
  function parseKey(k) {
    const s = String(k || '').trim();
    const m = s.match(/^([A-Ga-g])([#b]?)\s*(.*)$/);
    if (!m) return { tonic: 0, minor: false, scale: [0, 2, 4, 5, 7, 9, 11] };
    const rest = m[3].toLowerCase();
    const minor = /^(m(?!aj)|min|moll)/.test(rest);
    return { tonic: pitchClass(m[1], m[2]), minor, scale: minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11] };
  }

  // Chord tones voiced in a comfortable keyboard range around middle C.
  function voiceChord(ch) {
    let base = 48 + ch.root;
    if (base < 52) base += 12;
    return ch.intervals.map((iv) => base + iv);
  }

  // ---------- song model ----------

  const pattern = (p, fallback) => {
    const s = String(p || '').replace(/[^x.]/gi, '').toLowerCase().replace(/[^x]/g, '.');
    return s.length ? s.padEnd(16, '.').slice(0, 16) : fallback;
  };
  const clampInt = (v, lo, hi, d) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };

  function defaultSong() {
    return {
      title: 'Min låt',
      style: 'Pop',
      key: 'C major',
      bpm: 100,
      introBars: 1,
      chords: ['C', 'G', 'Am', 'F'],
      drums: { kick: 'x.......x.x.....', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', clap: '................' },
      bass: 'x.....x.x.......',
      chordRhythm: 'x.......x.......',
      lead: [],
      instruments: { chords: 'piano', bass: 'sub', lead: 'saw' },
      mix: { drums: 0.8, bass: 0.8, chords: 0.6, lead: 0.55, vocal: 1 },
      hype: '',
    };
  }

  function normalizeSong(input, keepMix) {
    const d = defaultSong();
    const s = input || {};
    const chords = (Array.isArray(s.chords) ? s.chords : []).map((c) => String(c).trim()).filter((c) => parseChord(c)).slice(0, 128);
    const bars = chords.length || d.chords.length;
    const drums = s.drums || {};
    const inst = s.instruments || {};
    const pick = (v, allowed, def) => (allowed.includes(v) ? v : def);
    return {
      title: String(s.title || d.title).slice(0, 80),
      style: String(s.style || d.style).slice(0, 60),
      key: String(s.key || d.key).slice(0, 20),
      bpm: clampInt(s.bpm, 60, 180, d.bpm),
      introBars: clampInt(s.introBars, 0, 4, d.introBars),
      chords: chords.length ? chords : d.chords.slice(),
      drums: {
        kick: pattern(drums.kick, d.drums.kick),
        snare: pattern(drums.snare, d.drums.snare),
        hat: pattern(drums.hat, d.drums.hat),
        clap: pattern(drums.clap, d.drums.clap),
      },
      bass: pattern(s.bass, d.bass),
      chordRhythm: pattern(s.chordRhythm, d.chordRhythm),
      lead: (Array.isArray(s.lead) ? s.lead : [])
        .map((n) => ({ bar: clampInt(n.bar, 0, 127, -1), step: clampInt(n.step, 0, 15, 0), midi: clampInt(n.midi, 36, 96, 72), len: clampInt(n.len, 1, 16, 2) }))
        .filter((n) => n.bar >= 0 && n.bar < bars)
        .slice(0, 2000),
      instruments: {
        chords: pick(inst.chords, ['piano', 'pad', 'organ', 'pluck'], d.instruments.chords),
        bass: pick(inst.bass, ['sub', 'pluck', 'synth'], d.instruments.bass),
        lead: pick(inst.lead, ['saw', 'square', 'bell', 'flute'], d.instruments.lead),
      },
      mix: { ...d.mix, ...(keepMix || s.mix || {}) },
      hype: String(s.hype || '').slice(0, 200),
    };
  }

  const barSeconds = (song) => (60 / song.bpm) * 4;

  // Repeat the progression so the band keeps playing for the whole vocal take.
  function fitToVocal(song, vocalSeconds) {
    if (!vocalSeconds) return song;
    const need = song.introBars + Math.ceil(vocalSeconds / barSeconds(song)) + 1;
    const prog = song.chords.slice();
    while (song.chords.length < need) song.chords.push(prog[song.chords.length % prog.length]);
    return song;
  }

  // ---------- synth voices ----------

  let noiseBuf = null;
  function noise(ctx) {
    if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
    const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return (noiseBuf = b);
  }

  function env(ctx, dest, t, peak, attack, decay, hold = 0) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    if (hold) g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + decay);
    g.connect(dest);
    return g;
  }

  function osc(ctx, type, freq, dest, t, end, detune = 0) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.detune.value = detune;
    o.connect(dest);
    o.start(t);
    o.stop(end);
    return o;
  }

  function noiseHit(ctx, dest, t, dur, filterType, freq, q = 1) {
    const src = ctx.createBufferSource();
    src.buffer = noise(ctx);
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    src.connect(f).connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur);
  }

  const drums = {
    kick(ctx, out, t) {
      const g = env(ctx, out, t, 1, 0.002, 0.42);
      const o = osc(ctx, 'sine', 150, g, t, t + 0.5);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
    },
    snare(ctx, out, t) {
      noiseHit(ctx, env(ctx, out, t, 0.55, 0.001, 0.18), t, 0.22, 'highpass', 1200);
      osc(ctx, 'triangle', 190, env(ctx, out, t, 0.4, 0.001, 0.09), t, t + 0.12);
    },
    hat(ctx, out, t) {
      noiseHit(ctx, env(ctx, out, t, 0.22, 0.001, 0.045), t, 0.06, 'highpass', 7500);
    },
    clap(ctx, out, t) {
      for (let i = 0; i < 3; i++) noiseHit(ctx, env(ctx, out, t + i * 0.012, 0.4, 0.001, i === 2 ? 0.16 : 0.02), t + i * 0.012, 0.2, 'bandpass', 1400, 0.8);
    },
  };

  function bassVoice(ctx, out, t, dur, midi, type) {
    const f = mtof(midi);
    if (type === 'sub') {
      const g = env(ctx, out, t, 0.9, 0.005, 0.08, Math.max(0, dur - 0.08));
      osc(ctx, 'sine', f, g, t, t + dur + 0.1);
      osc(ctx, 'triangle', f * 2, env(ctx, g, t, 0.15, 0.005, dur), t, t + dur + 0.1);
    } else {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = type === 'pluck' ? 6 : 2;
      lp.frequency.setValueAtTime(type === 'pluck' ? 1800 : 900, t);
      lp.frequency.exponentialRampToValueAtTime(type === 'pluck' ? 180 : 500, t + Math.min(dur, 0.3));
      lp.connect(env(ctx, out, t, 0.7, 0.004, 0.08, Math.max(0, dur - 0.08)));
      osc(ctx, type === 'pluck' ? 'sawtooth' : 'square', f, lp, t, t + dur + 0.1);
    }
  }

  function chordVoice(ctx, out, t, dur, notes, type) {
    const per = 0.32 / Math.sqrt(notes.length);
    for (const n of notes) {
      const f = mtof(n);
      if (type === 'piano') {
        const g = env(ctx, out, t, per, 0.004, Math.max(0.4, dur * 1.2));
        osc(ctx, 'triangle', f, g, t, t + dur * 1.2 + 0.5);
        osc(ctx, 'sine', f * 2, env(ctx, g, t, 0.3, 0.003, 0.25), t, t + 0.4);
      } else if (type === 'pad') {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 1600;
        lp.connect(env(ctx, out, t, per * 0.7, Math.min(0.25, dur / 2), 0.35, Math.max(0, dur - 0.25)));
        osc(ctx, 'sawtooth', f, lp, t, t + dur + 0.7, -8);
        osc(ctx, 'sawtooth', f, lp, t, t + dur + 0.7, 8);
      } else if (type === 'organ') {
        const g = env(ctx, out, t, per * 0.8, 0.01, 0.08, Math.max(0, dur - 0.05));
        osc(ctx, 'sine', f, g, t, t + dur + 0.2);
        osc(ctx, 'sine', f * 2, g, t, t + dur + 0.2);
        osc(ctx, 'sine', f * 3, env(ctx, g, t, 0.4, 0.01, dur), t, t + dur + 0.2);
      } else {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(3000, t);
        lp.frequency.exponentialRampToValueAtTime(400, t + 0.25);
        lp.connect(env(ctx, out, t, per, 0.003, 0.3));
        osc(ctx, 'square', f, lp, t, t + 0.4);
      }
    }
  }

  function leadVoice(ctx, out, t, dur, midi, type) {
    const f = mtof(midi);
    if (type === 'bell') {
      const g = env(ctx, out, t, 0.28, 0.002, Math.max(0.6, dur * 2));
      osc(ctx, 'sine', f, g, t, t + dur * 2 + 0.7);
      osc(ctx, 'sine', f * 3.01, env(ctx, g, t, 0.35, 0.002, 0.3), t, t + 0.4);
      return;
    }
    const g = env(ctx, out, t, type === 'flute' ? 0.3 : 0.22, type === 'flute' ? 0.05 : 0.01, 0.12, Math.max(0, dur - 0.08));
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = type === 'flute' ? 2200 : 2800;
    lp.connect(g);
    const o = osc(ctx, type === 'flute' ? 'sine' : type === 'square' ? 'square' : 'sawtooth', f, lp, t, t + dur + 0.2);
    if (type === 'flute' || dur > 0.3) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = 5.5;
      depth.gain.value = 9;
      lfo.connect(depth).connect(o.detune);
      lfo.start(t + 0.15);
      lfo.stop(t + dur + 0.2);
    }
  }

  // ---------- one step of the song onto any AudioContext ----------

  function nextHit(pat, step) {
    for (let i = 1; i <= 16; i++) if (pat[(step + i) % 16] === 'x') return i;
    return 16;
  }

  function scheduleStep(ctx, buses, song, leadIndex, bar, step, t) {
    const stepDur = 60 / song.bpm / 4;
    for (const name of ['kick', 'snare', 'hat', 'clap']) {
      if (song.drums[name][step] === 'x') drums[name](ctx, buses.drums, t);
    }
    const ch = parseChord(song.chords[bar]);
    if (ch && song.bass[step] === 'x') {
      const len = Math.min(4, nextHit(song.bass, step)) * stepDur * 0.92;
      bassVoice(ctx, buses.bass, t, len, 36 + ch.bass, song.instruments.bass);
    }
    if (ch && song.chordRhythm[step] === 'x') {
      const len = Math.min(16 - step, nextHit(song.chordRhythm, step)) * stepDur * 0.95;
      chordVoice(ctx, buses.chords, t, len, voiceChord(ch), song.instruments.chords);
    }
    for (const n of leadIndex.get(bar * 16 + step) || []) {
      leadVoice(ctx, buses.lead, t, n.len * stepDur * 0.95, n.midi, song.instruments.lead);
    }
  }

  function indexLead(song) {
    const map = new Map();
    for (const n of song.lead) {
      const k = n.bar * 16 + n.step;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(n);
    }
    return map;
  }

  function makeBuses(ctx, mix) {
    const master = ctx.createDynamicsCompressor();
    master.threshold.value = -14;
    master.ratio.value = 4;
    const out = ctx.createGain();
    out.gain.value = 0.9;
    master.connect(out).connect(ctx.destination);
    const buses = { master };
    for (const t of TRACKS) {
      buses[t] = ctx.createGain();
      buses[t].gain.value = mix[t];
      buses[t].connect(master);
    }
    return buses;
  }

  // ---------- live player ----------

  let ctx = null;
  let buses = null;
  const player = { playing: false, song: null, vocal: null, vocalOn: true, vocalOffset: 0, loop: true, onStep: null };
  let timer = null;
  let pos = 0;
  let nextTime = 0;
  let vocalSrc = null;
  let leadIndex = new Map();
  const uiQueue = [];

  function audio() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      buses = makeBuses(ctx, defaultSong().mix);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function setMix(mix) {
    if (!buses) return;
    for (const t of TRACKS) buses[t].gain.setTargetAtTime(mix[t], ctx.currentTime, 0.02);
  }

  function startVocal(t) {
    if (!player.vocal || !player.vocalOn) return;
    const at = t + player.song.introBars * barSeconds(player.song) + player.vocalOffset;
    const src = ctx.createBufferSource();
    src.buffer = player.vocal;
    src.connect(buses.vocal);
    if (at >= t) src.start(at);
    else src.start(t, Math.min(player.vocal.duration, t - at));
    vocalSrc = src;
  }

  function tick() {
    const song = player.song;
    const stepDur = 60 / song.bpm / 4;
    const total = song.chords.length * 16;
    while (nextTime < ctx.currentTime + 0.12) {
      if (pos >= total) {
        if (!player.loop) { stop(); return; }
        pos = 0;
      }
      if (pos === 0) startVocal(nextTime);
      scheduleStep(ctx, buses, song, leadIndex, Math.floor(pos / 16), pos % 16, nextTime);
      uiQueue.push({ pos, time: nextTime });
      pos += 1;
      nextTime += stepDur;
    }
  }

  function uiLoop() {
    if (!player.playing) return;
    while (uiQueue.length && uiQueue[0].time <= ctx.currentTime) {
      const { pos: p } = uiQueue.shift();
      if (player.onStep) player.onStep(Math.floor(p / 16), p % 16);
    }
    requestAnimationFrame(uiLoop);
  }

  function play(song) {
    audio();
    stop();
    player.song = song;
    leadIndex = indexLead(song);
    setMix(song.mix);
    pos = 0;
    nextTime = ctx.currentTime + 0.08;
    player.playing = true;
    timer = setInterval(tick, 25);
    tick();
    requestAnimationFrame(uiLoop);
  }

  // Pick up edits made while playing without restarting.
  function update(song) {
    player.song = song;
    leadIndex = indexLead(song);
    setMix(song.mix);
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    uiQueue.length = 0;
    if (vocalSrc) { try { vocalSrc.stop(); } catch { /* already stopped */ } vocalSrc = null; }
    const was = player.playing;
    player.playing = false;
    if (was && player.onStep) player.onStep(-1, -1);
  }

  function preview(fn) {
    const c = audio();
    fn(c, buses, c.currentTime + 0.01);
  }

  // ---------- offline render to WAV ----------

  async function render(song, vocal, withVocal, vocalOffset) {
    const sr = 44100;
    const stepDur = 60 / song.bpm / 4;
    const vocalAt = song.introBars * barSeconds(song) + vocalOffset;
    let length = song.chords.length * 16 * stepDur + 2;
    if (withVocal && vocal) length = Math.max(length, vocalAt + vocal.duration + 1);
    const off = new OfflineAudioContext(2, Math.ceil(length * sr), sr);
    const b = makeBuses(off, song.mix);
    const idx = indexLead(song);
    for (let p = 0; p < song.chords.length * 16; p++) scheduleStep(off, b, song, idx, Math.floor(p / 16), p % 16, 0.02 + p * stepDur);
    if (withVocal && vocal) {
      const src = off.createBufferSource();
      src.buffer = vocal;
      src.connect(b.vocal);
      if (vocalAt >= 0) src.start(0.02 + vocalAt);
      else src.start(0, -vocalAt);
    }
    return encodeWav(await off.startRendering());
  }

  function encodeWav(buf) {
    const ch = buf.numberOfChannels;
    const n = buf.length;
    const data = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); data.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
    data.setUint32(24, buf.sampleRate, true); data.setUint32(28, buf.sampleRate * ch * 2, true);
    data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true);
    str(36, 'data'); data.setUint32(40, n * ch * 2, true);
    const chans = [...Array(ch)].map((_, i) => buf.getChannelData(i));
    let o = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        const v = Math.max(-1, Math.min(1, chans[c][i]));
        data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
        o += 2;
      }
    }
    return new Blob([data], { type: 'audio/wav' });
  }

  // ---------- pitch detection (YIN) ----------

  // Returns a frequency in Hz, or 0 when the frame is silent or unpitched.
  function yin(x, sr, minHz = 70, maxHz = 1000) {
    let rms = 0;
    for (let i = 0; i < x.length; i++) rms += x[i] * x[i];
    if (Math.sqrt(rms / x.length) < 0.01) return 0;
    const minLag = Math.floor(sr / maxHz);
    const maxLag = Math.min(Math.floor(sr / minHz), Math.floor(x.length / 2));
    const w = x.length - maxLag;
    const d = new Float32Array(maxLag + 1);
    for (let tau = 1; tau <= maxLag; tau++) {
      let s = 0;
      for (let i = 0; i < w; i++) { const v = x[i] - x[i + tau]; s += v * v; }
      d[tau] = s;
    }
    let run = 0;
    for (let tau = 1; tau <= maxLag; tau++) {
      run += d[tau];
      d[tau] = run ? (d[tau] * tau) / run : 1;
    }
    for (let tau = minLag; tau < maxLag; tau++) {
      if (d[tau] < 0.15) {
        while (tau + 1 < maxLag && d[tau + 1] < d[tau]) tau++;
        const a = d[tau - 1], b = d[tau], c = d[tau + 1];
        const shift = (a - c) / (2 * (a - 2 * b + c)) || 0;
        return sr / (tau + shift);
      }
    }
    return 0;
  }

  const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);

  // The sung melody as notes: [{ t, dur, midi, name }].
  function analyzeMelody(buffer) {
    const factor = Math.max(1, Math.round(buffer.sampleRate / 12000));
    const sr = buffer.sampleRate / factor;
    const src = buffer.getChannelData(0);
    const mono = new Float32Array(Math.floor(src.length / factor));
    for (let i = 0; i < mono.length; i++) {
      let s = 0;
      for (let k = 0; k < factor; k++) s += src[i * factor + k];
      mono[i] = s / factor;
    }
    const win = 1024;
    const hop = Math.round(sr * 0.04);
    const frames = [];
    for (let i = 0; i + win < mono.length; i += hop) {
      const hz = yin(mono.subarray(i, i + win), sr);
      frames.push(hz ? Math.round(hzToMidi(hz)) : null);
    }
    // median of three removes single-frame octave jumps
    const smooth = frames.map((v, i) => {
      const a = [frames[i - 1], v, frames[i + 1]].filter((x) => x != null).sort((p, q) => p - q);
      return v == null ? null : a[Math.floor(a.length / 2)];
    });
    const notes = [];
    let start = 0;
    for (let i = 1; i <= smooth.length; i++) {
      if (i < smooth.length && smooth[i] === smooth[start]) continue;
      if (smooth[start] != null && i - start >= 2) {
        notes.push({ t: (start * hop) / sr, dur: ((i - start) * hop) / sr, midi: smooth[start], name: midiName(smooth[start]) });
      }
      start = i;
    }
    return notes;
  }

  return {
    TRACKS, midiName, parseChord, parseKey, defaultSong, normalizeSong, fitToVocal, barSeconds,
    audio, play, stop, update, setMix, preview, render, yin, hzToMidi, analyzeMelody, player, drums,
    chordVoice: (c, b, t, sym, type) => { const ch = parseChord(sym); if (ch) chordVoice(c, b.chords, t, 0.6, voiceChord(ch), type); },
    leadVoice: (c, b, t, midi, type) => leadVoice(c, b.lead, t, 0.25, midi, type),
  };
})();
