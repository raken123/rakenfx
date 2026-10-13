// Tores Musiklektion: the UI. Engine (engine.js) makes the sound; this file
// handles recording, the studio editors, GPT 6 Astra requests and groups.
'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};

const state = {
  me: '',
  song: Engine.defaultSong(),
  vocal: null,        // AudioBuffer
  vocalBlob: null,    // recorded file, uploaded when shared
  vocalId: null,      // id on the server once uploaded
  melody: [],
  rollBar: 0,
  groups: [],
  openGroup: null,
  shareGroup: null,   // last group you created or joined, preselected when sharing
};

try { state.me = localStorage.getItem('tml-name') || ''; } catch { /* storage blocked */ }

// ---------- small helpers ----------

let toastTimer;
function toast(msg, bad) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 3800);
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fel ${res.status}`);
  return data;
}
const postJson = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const HYPE = [
  'Dagens lektion: du sjunger, GPT 6 Astra spelar bandet.',
  'Ingen sång är för ful för ett bra beat.',
  'Tore säger: högre! (typ)',
  'Världsturné börjar i klassrummet.',
  'Varje hit började som en inspelning i mobilen.',
  'Bandet väntar. Mikrofonen är din.',
];
let hypeI = 0;
setInterval(() => {
  hypeI = (hypeI + 1) % HYPE.length;
  $('hype').textContent = HYPE[hypeI];
}, 7000);

// ---------- name ----------

function askName() {
  const d = $('name-dialog');
  $('name-input').value = state.me;
  d.showModal();
}
$('name-dialog').addEventListener('close', () => {
  const v = $('name-input').value.trim().slice(0, 40);
  if (v) {
    state.me = v;
    try { localStorage.setItem('tml-name', v); } catch { /* ignore */ }
  }
  renderMe();
});
$('me-btn').addEventListener('click', askName);
function renderMe() { $('me-name').textContent = state.me || 'Vem är du?'; }
function needName() {
  if (state.me) return true;
  askName();
  return false;
}

// ---------- tabs ----------

function showTab(name) {
  for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== 'view-' + name;
  if (name === 'groups' || name === 'studio') loadGroups();
}
for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => showTab(b.dataset.tab));

// ---------- status ----------

api('/api/status')
  .then((s) => {
    $('status').textContent = s.hasKey ? 'GPT 6 Astra redo' : 'Astra saknar nyckel';
    $('status').classList.toggle('ok', s.hasKey);
  })
  .catch(() => { $('status').textContent = 'Servern svarar inte'; });

// ============================================================
// SJUNG
// ============================================================

let recorder = null;
let recStream = null;
let recStart = 0;
let recRaf = 0;

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Mikrofonen kräver https eller localhost. Ladda upp en inspelning istället.', true);
    return;
  }
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } });
  } catch {
    toast('Fick inte använda mikrofonen.', true);
    return;
  }
  Engine.stop();
  const ctx = Engine.audio();
  const srcNode = ctx.createMediaStreamSource(recStream);
  const an = ctx.createAnalyser();
  an.fftSize = 2048;
  srcNode.connect(an);
  const buf = new Float32Array(an.fftSize);

  const chunks = [];
  recorder = new MediaRecorder(recStream);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = async () => {
    cancelAnimationFrame(recRaf);
    srcNode.disconnect();
    recStream.getTracks().forEach((t) => t.stop());
    $('rec-btn').classList.remove('on');
    $('meter').style.width = '0';
    await useTake(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
  };
  recorder.start();
  recStart = performance.now();
  $('rec-btn').classList.add('on');

  const loop = () => {
    an.getFloatTimeDomainData(buf);
    let rms = 0;
    for (const v of buf) rms += v * v;
    rms = Math.sqrt(rms / buf.length);
    $('meter').style.width = Math.min(100, rms * 400) + '%';
    const hz = Engine.yin(buf, ctx.sampleRate);
    $('rec-note').textContent = hz ? '♪ ' + Engine.midiName(Math.round(Engine.hzToMidi(hz))) : 'Sjung!';
    $('rec-time').textContent = fmtTime((performance.now() - recStart) / 1000);
    recRaf = requestAnimationFrame(loop);
  };
  loop();
}

$('rec-btn').addEventListener('click', () => {
  if (recorder && recorder.state === 'recording') recorder.stop();
  else startRecording();
});

$('upload').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) useTake(f);
  e.target.value = '';
});

async function useTake(blob) {
  try {
    const ctx = Engine.audio();
    state.vocal = await ctx.decodeAudioData(await blob.arrayBuffer());
  } catch {
    toast('Kunde inte läsa ljudet. Testa en annan fil.', true);
    return;
  }
  state.vocalBlob = blob;
  state.vocalId = null;
  state.melody = [];
  $('rec-note').textContent = 'Inspelat!';
  $('rec-time').textContent = fmtTime(state.vocal.duration);
  $('take-meta').textContent = `${state.vocal.duration.toFixed(1)} sekunder`;
  $('take').hidden = false;
  $('steps').hidden = true;
  $('take').scrollIntoView({ behavior: 'smooth', block: 'start' });
  refreshVocalUi();
}

let takeSrc = null;
$('take-play').addEventListener('click', () => {
  const ctx = Engine.audio();
  if (takeSrc) { takeSrc.stop(); takeSrc = null; $('take-play').textContent = '▶ Lyssna på din sång'; return; }
  takeSrc = ctx.createBufferSource();
  takeSrc.buffer = state.vocal;
  takeSrc.connect(ctx.destination);
  takeSrc.onended = () => { takeSrc = null; $('take-play').textContent = '▶ Lyssna på din sång'; };
  takeSrc.start();
  $('take-play').textContent = '■ Stoppa';
});

for (const c of document.querySelectorAll('#style-chips .chip')) {
  c.addEventListener('click', () => c.classList.toggle('on'));
}

function setStep(name, cls) {
  const li = document.querySelector(`#steps [data-step="${name}"]`);
  li.className = cls;
}

$('make-btn').addEventListener('click', async () => {
  if (!state.vocal) return;
  const btn = $('make-btn');
  btn.disabled = true;
  $('steps').hidden = false;
  for (const li of document.querySelectorAll('#steps li')) li.className = '';
  const styles = [...document.querySelectorAll('#style-chips .chip.on')].map((c) => c.textContent);
  const extra = $('style-extra').value.trim();
  try {
    setStep('melody', 'busy');
    await new Promise((r) => setTimeout(r, 30));
    state.melody = Engine.analyzeMelody(state.vocal);
    setStep('melody', 'done');

    setStep('lyrics', 'busy');
    let lyrics = '';
    try {
      lyrics = (await api('/api/transcribe', { method: 'POST', headers: { 'Content-Type': state.vocalBlob.type || 'audio/webm' }, body: state.vocalBlob })).text;
      setStep('lyrics', 'done');
    } catch (err) {
      setStep('lyrics', 'skip');
      toast('Texten gick inte att skriva ner, Astra kör på tonerna: ' + err.message, true);
    }

    setStep('astra', 'busy');
    const { song } = await postJson('/api/astra', {
      lyrics,
      melody: state.melody,
      duration: state.vocal.duration,
      style: [styles.join(', '), extra].filter(Boolean).join('. '),
    });
    setStep('astra', 'done');
    loadSong(song, true);
    setStep('done', 'done');
    setTimeout(() => { showTab('studio'); Engine.play(state.song); syncPlay(); }, 500);
  } catch (err) {
    for (const li of document.querySelectorAll('#steps li.busy')) li.className = 'fail';
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('idea-btn').addEventListener('click', async () => {
  const idea = $('idea').value.trim();
  if (!idea) { $('idea').focus(); return; }
  const btn = $('idea-btn');
  btn.disabled = true;
  btn.textContent = 'Astra jobbar…';
  try {
    const { song } = await postJson('/api/astra', { idea });
    loadSong(song, false);
    showTab('studio');
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Skapa';
  }
});

// ============================================================
// STUDIO
// ============================================================

function loadSong(raw, fit) {
  const song = Engine.normalizeSong(raw, state.song.mix);
  if (fit && state.vocal) Engine.fitToVocal(song, state.vocal.duration);
  state.song = song;
  state.rollBar = 0;
  renderStudio();
  if (song.hype) {
    $('hype').textContent = song.hype;
    $('astra-says').textContent = '“' + song.hype + '”';
    $('astra-says').hidden = false;
  }
}

// Every manual edit goes through here so playback picks it up immediately.
function changed() {
  if (Engine.player.playing) Engine.update(state.song);
}

function renderStudio() {
  const s = state.song;
  $('title').value = s.title;
  $('key').value = s.key;
  $('intro').value = s.introBars;
  $('bpm').value = s.bpm;
  $('bpm-out').textContent = s.bpm;
  $('inst-bass').value = s.instruments.bass;
  $('inst-chords').value = s.instruments.chords;
  $('inst-lead').value = s.instruments.lead;
  renderChords();
  renderBeat();
  renderRoll();
  renderMixer();
  refreshVocalUi();
}

function refreshVocalUi() {
  const has = Boolean(state.vocal);
  $('vocal-toggle-wrap').hidden = !has;
  $('offset-wrap').hidden = !has;
  $('export-full').hidden = !has;
  Engine.player.vocal = state.vocal;
}

$('title').addEventListener('input', (e) => { state.song.title = e.target.value; });
$('key').addEventListener('change', (e) => { state.song.key = e.target.value.trim() || 'C major'; renderRoll(); });
$('intro').addEventListener('change', (e) => {
  state.song.introBars = Math.max(0, Math.min(4, Number(e.target.value) || 0));
  e.target.value = state.song.introBars;
  changed();
});
$('bpm').addEventListener('input', (e) => {
  state.song.bpm = Number(e.target.value);
  $('bpm-out').textContent = state.song.bpm;
  changed();
});
$('offset').addEventListener('input', (e) => {
  Engine.player.vocalOffset = Number(e.target.value);
  $('offset-out').textContent = Number(e.target.value).toFixed(2) + ' s';
});
$('loop').addEventListener('change', (e) => { Engine.player.loop = e.target.checked; });
$('vocal-on').addEventListener('change', (e) => { Engine.player.vocalOn = e.target.checked; });
for (const [id, key] of [['inst-bass', 'bass'], ['inst-chords', 'chords'], ['inst-lead', 'lead']]) {
  $(id).addEventListener('change', (e) => { state.song.instruments[key] = e.target.value; changed(); });
}

// ----- transport -----

function syncPlay() {
  $('play-btn').textContent = Engine.player.playing ? '■ Stopp' : '▶ Spela';
  $('play-btn').classList.toggle('on', Engine.player.playing);
}
$('play-btn').addEventListener('click', () => {
  if (Engine.player.playing) Engine.stop();
  else Engine.play(state.song);
  syncPlay();
});

Engine.player.onStep = (bar, step) => {
  for (const c of document.querySelectorAll('.now')) c.classList.remove('now');
  if (bar < 0) { syncPlay(); return; }
  for (const c of document.querySelectorAll(`#beat-grid [data-step="${step}"], #roll [data-step="${step}"]`)) {
    if (!c.closest('#roll') || bar === state.rollBar) c.classList.add('now');
  }
  document.querySelector(`#chords [data-bar="${bar}"]`)?.classList.add('now');
};

async function exportWav(withVocal) {
  const btn = withVocal ? $('export-full') : $('export-inst');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Renderar…';
  try {
    const blob = await Engine.render(state.song, state.vocal, withVocal, Engine.player.vocalOffset);
    const a = el('a', { href: URL.createObjectURL(blob), download: `${state.song.title || 'låt'}${withVocal ? '' : ' (instrumental)'}.wav` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (err) {
    toast('Exporten misslyckades: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}
$('export-full').addEventListener('click', () => exportWav(true));
$('export-inst').addEventListener('click', () => exportWav(false));

// ----- chords -----

function renderChords() {
  const box = $('chords');
  box.replaceChildren();
  state.song.chords.forEach((c, i) => {
    const inp = el('input', { className: 'chord', value: c, spellcheck: false });
    inp.dataset.bar = i;
    inp.setAttribute('aria-label', `Ackord takt ${i + 1}`);
    inp.addEventListener('change', () => {
      const v = inp.value.trim();
      if (Engine.parseChord(v)) {
        state.song.chords[i] = v;
        inp.classList.remove('bad');
        Engine.preview((ctx, b, t) => Engine.chordVoice(ctx, b, t, v, state.song.instruments.chords));
        changed();
      } else {
        inp.classList.add('bad');
        toast(`"${v}" är inget ackord jag känner igen. Testa t.ex. Am, F, C7, Dsus4.`, true);
      }
    });
    const wrap = el('label', { className: 'chord-cell' }, el('span', { textContent: i + 1 }), inp);
    if (i < state.song.introBars) wrap.classList.add('intro');
    box.append(wrap);
  });
}
$('bar-add').addEventListener('click', () => {
  const c = state.song.chords;
  c.push(c[c.length - 4] || c[c.length - 1] || 'C');
  renderChords();
  changed();
});
$('bar-del').addEventListener('click', () => {
  if (state.song.chords.length <= 1) return;
  state.song.chords.pop();
  state.song.lead = state.song.lead.filter((n) => n.bar < state.song.chords.length);
  state.rollBar = Math.min(state.rollBar, state.song.chords.length - 1);
  renderChords();
  renderRoll();
  changed();
});

// ----- beat grid -----

const BEAT_ROWS = [
  ['Kick', (s) => s.drums, 'kick', (ctx, b, t) => Engine.drums.kick(ctx, b.drums, t)],
  ['Virvel', (s) => s.drums, 'snare', (ctx, b, t) => Engine.drums.snare(ctx, b.drums, t)],
  ['Hihat', (s) => s.drums, 'hat', (ctx, b, t) => Engine.drums.hat(ctx, b.drums, t)],
  ['Clap', (s) => s.drums, 'clap', (ctx, b, t) => Engine.drums.clap(ctx, b.drums, t)],
  ['Bas', (s) => s, 'bass', null],
  ['Ackord', (s) => s, 'chordRhythm', (ctx, b, t) => Engine.chordVoice(ctx, b, t, state.song.chords[0], state.song.instruments.chords)],
];

function renderBeat() {
  const g = $('beat-grid');
  g.replaceChildren();
  for (const [label, holder, key, sound] of BEAT_ROWS) {
    g.append(el('div', { className: 'row-label', textContent: label }));
    const pat = holder(state.song)[key];
    for (let i = 0; i < 16; i++) {
      const cell = el('button', { type: 'button', className: 'cell' + (pat[i] === 'x' ? ' on' : '') + (i % 4 === 0 ? ' beat' : '') });
      cell.dataset.step = i;
      cell.setAttribute('aria-label', `${label} steg ${i + 1}`);
      cell.addEventListener('click', () => {
        const h = holder(state.song);
        const arr = h[key].split('');
        arr[i] = arr[i] === 'x' ? '.' : 'x';
        h[key] = arr.join('');
        cell.classList.toggle('on', arr[i] === 'x');
        if (arr[i] === 'x' && sound && !Engine.player.playing) Engine.preview(sound);
        changed();
      });
      g.append(cell);
    }
  }
}

// ----- melody piano roll -----

function rollRows() {
  const k = Engine.parseKey(state.song.key);
  const rows = new Set();
  for (let m = 55; m <= 84; m++) if (k.scale.includes((m - k.tonic + 120) % 12)) rows.add(m);
  for (const n of state.song.lead) rows.add(n.midi);
  return [...rows].sort((a, b) => b - a);
}

function renderRoll() {
  const roll = $('roll');
  roll.replaceChildren();
  const bar = state.rollBar;
  $('roll-bar-label').textContent = `${bar + 1} / ${state.song.chords.length} · ${state.song.chords[bar] || ''}`;
  const k = Engine.parseKey(state.song.key);
  const notes = state.song.lead.filter((n) => n.bar === bar);
  for (const midi of rollRows()) {
    const isTonic = (midi - k.tonic + 120) % 12 === 0;
    roll.append(el('div', { className: 'row-label' + (isTonic ? ' tonic' : ''), textContent: Engine.midiName(midi) }));
    for (let i = 0; i < 16; i++) {
      const start = notes.find((n) => n.midi === midi && n.step === i);
      const held = notes.find((n) => n.midi === midi && n.step < i && n.step + n.len > i);
      const cell = el('button', { type: 'button', className: 'cell' + (start ? ' on' : held ? ' held' : '') + (i % 4 === 0 ? ' beat' : '') });
      cell.dataset.step = i;
      cell.setAttribute('aria-label', `${Engine.midiName(midi)} steg ${i + 1}`);
      cell.addEventListener('click', () => {
        const hit = start || held;
        if (hit) {
          state.song.lead = state.song.lead.filter((n) => n !== hit);
        } else {
          const len = Math.min(Number($('roll-len').value), 16 - i);
          state.song.lead.push({ bar, step: i, midi, len });
          if (!Engine.player.playing) Engine.preview((ctx, b, t) => Engine.leadVoice(ctx, b, t, midi, state.song.instruments.lead));
        }
        renderRoll();
        changed();
      });
      roll.append(cell);
    }
  }
}
$('roll-prev').addEventListener('click', () => { state.rollBar = Math.max(0, state.rollBar - 1); renderRoll(); });
$('roll-next').addEventListener('click', () => { state.rollBar = Math.min(state.song.chords.length - 1, state.rollBar + 1); renderRoll(); });
$('roll-clear').addEventListener('click', () => {
  state.song.lead = state.song.lead.filter((n) => n.bar !== state.rollBar);
  renderRoll();
  changed();
});

// ----- mixer -----

const MIX_LABELS = { drums: 'Trummor', bass: 'Bas', chords: 'Ackord', lead: 'Melodi', vocal: 'Sång' };
function renderMixer() {
  const m = $('mixer');
  m.replaceChildren();
  for (const t of Engine.TRACKS) {
    const out = el('output', { textContent: Math.round(state.song.mix[t] * 100) });
    const r = el('input', { type: 'range', min: 0, max: 1.5, step: 0.01, value: state.song.mix[t] });
    r.addEventListener('input', () => {
      state.song.mix[t] = Number(r.value);
      out.textContent = Math.round(r.value * 100);
      Engine.setMix(state.song.mix);
    });
    m.append(el('label', { className: 'fader' }, el('span', { textContent: MIX_LABELS[t] }), r, out));
  }
}

// ----- ask Astra (one manual request per click, no agent loop) -----

$('ask-btn').addEventListener('click', askAstra);
$('ask').addEventListener('keydown', (e) => { if (e.key === 'Enter') askAstra(); });
async function askAstra() {
  const instruction = $('ask').value.trim();
  if (!instruction) { $('ask').focus(); return; }
  const btn = $('ask-btn');
  btn.disabled = true;
  btn.textContent = 'Astra tänker…';
  try {
    const { mix, ...song } = state.song;
    const res = await postJson('/api/astra', { song, instruction, duration: state.vocal?.duration, melody: state.melody });
    const wasPlaying = Engine.player.playing;
    loadSong(res.song, true);
    if (wasPlaying) Engine.update(state.song);
    $('ask').value = '';
    toast('Astra är klar!');
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Fråga Astra';
  }
}

// ----- share -----

$('share-group').addEventListener('change', (e) => { state.shareGroup = e.target.value || null; });
$('share-btn').addEventListener('click', async () => {
  if (!needName()) return;
  const gid = $('share-group').value;
  state.shareGroup = gid || null;
  if (!gid) { toast('Gå med i eller skapa en grupp först.', true); showTab('groups'); return; }
  const btn = $('share-btn');
  btn.disabled = true;
  try {
    if (state.vocalBlob && !state.vocalId) {
      state.vocalId = (await api('/api/audio', { method: 'POST', headers: { 'Content-Type': state.vocalBlob.type || 'audio/webm' }, body: state.vocalBlob })).id;
    }
    await postJson(`/api/groups/${gid}/songs`, { who: state.me, song: state.song, vocalId: state.vocalId, vocalOffset: Engine.player.vocalOffset });
    toast('Sparad i gruppen! 🎉');
    loadGroups();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ============================================================
// GRUPPER
// ============================================================

async function loadGroups() {
  try {
    state.groups = (await api('/api/groups')).groups;
    renderGroups();
  } catch { /* keep the old list */ }
}
setInterval(() => { if (!document.hidden && !$('view-groups').hidden) loadGroups(); }, 5000);

function renderGroups() {
  const mine = state.groups.filter((g) => g.members.includes(state.me));
  const sel = $('share-group');
  const keep = state.shareGroup || sel.value;
  sel.replaceChildren(...(mine.length ? mine : []).map((g) => el('option', { value: g.id, textContent: g.name })));
  if (!mine.length) sel.append(el('option', { value: '', textContent: 'Du är inte med i någon grupp än' }));
  if (mine.some((g) => g.id === keep)) sel.value = keep;

  const box = $('groups');
  box.replaceChildren();
  if (!state.groups.length) {
    box.append(el('p', { className: 'empty', textContent: 'Inga grupper än. Starta den första!' }));
    return;
  }
  for (const g of state.groups) {
    const isMember = g.members.includes(state.me);
    const open = state.openGroup === g.id;
    const card = el('article', { className: 'group' + (isMember ? ' mine' : '') });

    const join = el('button', { type: 'button', className: 'btn tiny' + (isMember ? '' : ' hot'), textContent: isMember ? 'Lämna' : 'Gå med' });
    join.addEventListener('click', async () => {
      if (!needName()) return;
      try {
        await postJson(`/api/groups/${g.id}/${isMember ? 'leave' : 'join'}`, { who: state.me });
        if (!isMember) { state.shareGroup = g.id; toast(`Välkommen till ${g.name}!`); }
        loadGroups();
      } catch (err) { toast(err.message, true); }
    });
    const toggle = el('button', { type: 'button', className: 'btn tiny ghost', textContent: open ? 'Dölj låtar' : `Låtar (${g.songs.length})` });
    toggle.addEventListener('click', () => { state.openGroup = open ? null : g.id; renderGroups(); });

    card.append(
      el('div', { className: 'group-head' },
        el('h3', { textContent: g.name }),
        el('div', { className: 'row tight' }, toggle, join)),
      el('p', { className: 'members', textContent: g.members.length ? g.members.join(' · ') : 'Inga medlemmar just nu' }),
    );

    if (open) {
      const list = el('ul', { className: 'songs' });
      if (!g.songs.length) list.append(el('li', { className: 'empty', textContent: 'Inga låtar än.' }));
      for (const s of g.songs) {
        const openBtn = el('button', { type: 'button', className: 'btn tiny', textContent: 'Öppna i studion' });
        openBtn.addEventListener('click', () => openShared(s, openBtn));
        const li = el('li', {}, el('div', {}, el('strong', { textContent: s.title }), el('span', { textContent: ` av ${s.by}${s.vocalId ? ' · med sång' : ''}` })), el('div', { className: 'row tight' }, openBtn));
        if (s.by === state.me) {
          const del = el('button', { type: 'button', className: 'btn tiny ghost', textContent: 'Ta bort' });
          del.addEventListener('click', async () => {
            if (!confirm(`Ta bort "${s.title}"?`)) return;
            try { await api(`/api/groups/${g.id}/songs/${s.id}`, { method: 'DELETE' }); loadGroups(); } catch (err) { toast(err.message, true); }
          });
          li.lastChild.append(del);
        }
        list.append(li);
      }
      card.append(list);
    }
    box.append(card);
  }
}

async function openShared(entry, btn) {
  btn.disabled = true;
  try {
    Engine.stop();
    state.vocal = null;
    state.vocalBlob = null;
    state.vocalId = null;
    state.melody = [];
    if (entry.vocalId) {
      const res = await fetch(`/api/audio/${entry.vocalId}`);
      if (res.ok) {
        state.vocalBlob = await res.blob();
        state.vocal = await Engine.audio().decodeAudioData(await state.vocalBlob.arrayBuffer());
        state.vocalId = entry.vocalId;
      }
    }
    Engine.player.vocalOffset = entry.vocalOffset || 0;
    $('offset').value = Engine.player.vocalOffset;
    $('offset-out').textContent = Engine.player.vocalOffset.toFixed(2) + ' s';
    state.song = Engine.normalizeSong(entry.song);
    state.rollBar = 0;
    renderStudio();
    $('astra-says').hidden = true;
    showTab('studio');
    syncPlay();
  } catch (err) {
    toast('Kunde inte öppna låten: ' + err.message, true);
  } finally {
    btn.disabled = false;
  }
}

$('group-create').addEventListener('click', async () => {
  if (!needName()) return;
  const name = $('group-name').value.trim();
  if (!name) { $('group-name').focus(); return; }
  try {
    const { group } = await postJson('/api/groups', { name, who: state.me });
    $('group-name').value = '';
    state.openGroup = group.id;
    state.shareGroup = group.id;
    toast(`Gruppen ${group.name} är startad!`);
    loadGroups();
  } catch (err) { toast(err.message, true); }
});

// ---------- start ----------

renderMe();
renderStudio();
loadGroups();
if (!state.me) askName();
