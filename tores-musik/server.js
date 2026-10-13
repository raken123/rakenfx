// Tores Musiklektion: a tiny Node server (no dependencies, Node 18+).
// It serves the app, stores groups and songs in data/, and talks to OpenAI
// so the API key stays on this machine and never reaches the students' browsers.
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const DB_FILE = path.join(DATA_DIR, 'db.json');

loadEnvFile(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT) || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ASTRA_MODEL = process.env.ASTRA_MODEL || 'gpt-6-astra';
const ASTRA_EFFORT = process.env.ASTRA_EFFORT || 'low';
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || 'gpt-4o-transcribe';
const MAX_BODY = 40 * 1024 * 1024;

fs.mkdirSync(AUDIO_DIR, { recursive: true });

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ---------- storage ----------

let db = { groups: [] };
if (fs.existsSync(DB_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = { groups: [] }; }
}
function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
const newId = () => crypto.randomBytes(6).toString('hex');
const cleanName = (s, max = 40) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, max);

// ---------- song schema shared with Astra ----------

const STEP_PATTERN = { type: 'string', description: '16 characters, x = hit, . = rest, one bar of sixteenth notes' };
const SONG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'style', 'key', 'bpm', 'introBars', 'chords', 'drums', 'bass', 'chordRhythm', 'lead', 'instruments', 'hype'],
  properties: {
    title: { type: 'string' },
    style: { type: 'string' },
    key: { type: 'string', description: 'e.g. "A minor" or "C major"' },
    bpm: { type: 'integer', description: '60 to 180' },
    introBars: { type: 'integer', description: '0 to 4 bars before the vocal starts' },
    chords: { type: 'array', items: { type: 'string' }, description: 'one chord symbol per bar, e.g. Am, F, C, G, Dm7, Esus4' },
    drums: {
      type: 'object',
      additionalProperties: false,
      required: ['kick', 'snare', 'hat', 'clap'],
      properties: { kick: STEP_PATTERN, snare: STEP_PATTERN, hat: STEP_PATTERN, clap: STEP_PATTERN },
    },
    bass: STEP_PATTERN,
    chordRhythm: STEP_PATTERN,
    lead: {
      type: 'array',
      description: 'instrumental melody notes; bar is 0-based, step 0-15, midi 48-96, len in sixteenths',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['bar', 'step', 'midi', 'len'],
        properties: {
          bar: { type: 'integer' }, step: { type: 'integer' }, midi: { type: 'integer' }, len: { type: 'integer' },
        },
      },
    },
    instruments: {
      type: 'object',
      additionalProperties: false,
      required: ['chords', 'bass', 'lead'],
      properties: {
        chords: { type: 'string', enum: ['piano', 'pad', 'organ', 'pluck'] },
        bass: { type: 'string', enum: ['sub', 'pluck', 'synth'] },
        lead: { type: 'string', enum: ['saw', 'square', 'bell', 'flute'] },
      },
    },
    hype: { type: 'string', description: 'one short, energetic line in Swedish for the class' },
  },
};

const ASTRA_SYSTEM = `Du är musikproducenten i appen "Tores Musiklektion". Elever i en musiklektion sjunger eller beskriver låtar, och du gör ett komplett instrumentalt arrangemang som appen spelar upp med sina egna syntar.
Regler:
- Svara bara med låt-JSON enligt schemat.
- Alla 16-stegsmönster är exakt 16 tecken av "x" och ".".
- "chords" har ett ackord per takt. Använd ackord som passar tonarten och sångmelodin.
- Om en sånginspelning finns ska antal takter i "chords" vara introBars plus det antal takter sången tar på det tempo du väljer, plus 1-2 takter outro.
- Om sångens toner finns: välj tonart och ackord som passar tonerna, och lägg "lead" som en motmelodi i pauserna, inte ovanpå sången.
- Om eleven bara ber om en ändring: behåll allt annat i låten och ändra det som efterfrågas.
- "hype" är en kort, peppig rad på svenska till klassen.`;

// ---------- OpenAI calls ----------

async function openai(pathname, init) {
  if (!OPENAI_API_KEY) {
    const err = new Error('Ingen API-nyckel. Lägg OPENAI_API_KEY i tores-musik/.env och starta om servern.');
    err.status = 500;
    throw err;
  }
  const res = await fetch('https://api.openai.com/v1' + pathname, {
    ...init,
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...(init.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error(body?.error?.message || `OpenAI svarade ${res.status}`);
    err.status = 502;
    throw err;
  }
  return body;
}

async function transcribe(audio, mime) {
  const ext = mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), `sang.${ext}`);
  form.append('model', TRANSCRIBE_MODEL);
  form.append('language', 'sv');
  const out = await openai('/audio/transcriptions', { method: 'POST', body: form });
  return out.text || '';
}

async function askAstra(userText) {
  const out = await openai('/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ASTRA_MODEL,
      reasoning: { effort: ASTRA_EFFORT },
      input: [
        { role: 'system', content: ASTRA_SYSTEM },
        { role: 'user', content: userText },
      ],
      text: { format: { type: 'json_schema', name: 'song', strict: true, schema: SONG_SCHEMA } },
    }),
  });
  const text = (out.output || [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content || [])
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text)
    .join('');
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('Astra skickade inget giltigt låt-svar. Försök igen.');
    err.status = 502;
    throw err;
  }
}

function arrangePrompt({ lyrics, melody, duration, style, idea, song, instruction }) {
  const parts = [];
  if (song) parts.push('Nuvarande låt (JSON):\n' + JSON.stringify(song));
  if (instruction) parts.push('Elevens ändring: ' + instruction);
  if (idea) parts.push('Elevens idé: ' + idea);
  if (style) parts.push('Önskad stil: ' + style);
  if (duration) parts.push(`Sånginspelningen är ${Number(duration).toFixed(1)} sekunder lång.`);
  if (lyrics) parts.push('Sångtext (transkriberad):\n' + lyrics);
  if (melody && melody.length) {
    parts.push('Sångens toner (sekund:ton):\n' + melody.slice(0, 400).map((n) => `${n.t.toFixed(2)}:${n.name}`).join(' '));
  }
  if (!parts.length) parts.push('Gör en peppig poplåt för klassen.');
  return parts.join('\n\n');
}

// ---------- HTTP helpers ----------

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Filen är för stor.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw Object.assign(new Error('Ogiltig JSON.'), { status: 400 }); }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('Hittades inte'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function groupView(g) {
  return { id: g.id, name: g.name, createdBy: g.createdBy, createdAt: g.createdAt, members: g.members, songs: g.songs };
}
function findGroup(id) {
  const g = db.groups.find((x) => x.id === id);
  if (!g) throw Object.assign(new Error('Gruppen finns inte.'), { status: 404 });
  return g;
}

// ---------- routes ----------

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  let match;

  if (p === '/api/status' && m === 'GET') {
    return send(res, 200, { hasKey: Boolean(OPENAI_API_KEY), model: ASTRA_MODEL, transcribeModel: TRANSCRIBE_MODEL });
  }

  if (p === '/api/transcribe' && m === 'POST') {
    const audio = await readBody(req);
    const text = await transcribe(audio, req.headers['content-type'] || 'audio/webm');
    return send(res, 200, { text });
  }

  if (p === '/api/astra' && m === 'POST') {
    const body = await readJson(req);
    const song = await askAstra(arrangePrompt(body));
    return send(res, 200, { song });
  }

  if (p === '/api/audio' && m === 'POST') {
    const audio = await readBody(req);
    const id = newId();
    const mime = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
    fs.writeFileSync(path.join(AUDIO_DIR, id), audio);
    fs.writeFileSync(path.join(AUDIO_DIR, id + '.type'), mime);
    return send(res, 200, { id });
  }
  if ((match = p.match(/^\/api\/audio\/([a-f0-9]{12})$/)) && m === 'GET') {
    const file = path.join(AUDIO_DIR, match[1]);
    if (!fs.existsSync(file)) return send(res, 404, { error: 'Ljudet finns inte.' });
    const type = fs.existsSync(file + '.type') ? fs.readFileSync(file + '.type', 'utf8') : 'audio/webm';
    res.writeHead(200, { 'Content-Type': type });
    return fs.createReadStream(file).pipe(res);
  }

  if (p === '/api/groups' && m === 'GET') {
    return send(res, 200, { groups: db.groups.map(groupView) });
  }
  if (p === '/api/groups' && m === 'POST') {
    const body = await readJson(req);
    const name = cleanName(body.name);
    const who = cleanName(body.who);
    if (!name || !who) return send(res, 400, { error: 'Gruppen behöver ett namn, och du behöver ett namn.' });
    const g = { id: newId(), name, createdBy: who, createdAt: Date.now(), members: [who], songs: [] };
    db.groups.unshift(g);
    save();
    return send(res, 200, { group: groupView(g) });
  }
  if ((match = p.match(/^\/api\/groups\/([a-f0-9]{12})\/(join|leave)$/)) && m === 'POST') {
    const g = findGroup(match[1]);
    const who = cleanName((await readJson(req)).who);
    if (!who) return send(res, 400, { error: 'Skriv ditt namn först.' });
    if (match[2] === 'join' && !g.members.includes(who)) g.members.push(who);
    if (match[2] === 'leave') g.members = g.members.filter((x) => x !== who);
    save();
    return send(res, 200, { group: groupView(g) });
  }
  if ((match = p.match(/^\/api\/groups\/([a-f0-9]{12})\/songs$/)) && m === 'POST') {
    const g = findGroup(match[1]);
    const body = await readJson(req);
    const who = cleanName(body.who);
    if (!who || !body.song) return send(res, 400, { error: 'Låten saknas.' });
    if (!g.members.includes(who)) g.members.push(who);
    const entry = {
      id: newId(),
      title: cleanName(body.song.title, 80) || 'Namnlös låt',
      by: who,
      at: Date.now(),
      song: body.song,
      vocalId: /^[a-f0-9]{12}$/.test(body.vocalId || '') ? body.vocalId : null,
      vocalOffset: Number(body.vocalOffset) || 0,
    };
    g.songs.unshift(entry);
    save();
    return send(res, 200, { group: groupView(g) });
  }
  if ((match = p.match(/^\/api\/groups\/([a-f0-9]{12})\/songs\/([a-f0-9]{12})$/)) && m === 'DELETE') {
    const g = findGroup(match[1]);
    g.songs = g.songs.filter((s) => s.id !== match[2]);
    save();
    return send(res, 200, { group: groupView(g) });
  }

  send(res, 404, { error: 'Okänd adress.' });
}

// Browsers only allow the microphone on https or localhost. To let students
// record from their own devices over the school network, point CERT_FILE and
// KEY_FILE at a certificate (see README).
const tls = process.env.CERT_FILE && process.env.KEY_FILE
  ? { cert: fs.readFileSync(process.env.CERT_FILE), key: fs.readFileSync(process.env.KEY_FILE) }
  : null;

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res);
  } catch (err) {
    if (!res.headersSent) send(res, err.status || 500, { error: err.message || 'Något gick fel.' });
    if (!err.status) console.error(err);
  }
}

(tls ? https.createServer(tls, handle) : http.createServer(handle)).listen(PORT, () => {
  console.log(`Tores Musiklektion kör på ${tls ? 'https' : 'http'}://localhost:${PORT}`);
  console.log(OPENAI_API_KEY ? `Astra: ${ASTRA_MODEL}` : 'OBS: ingen OPENAI_API_KEY, lägg den i tores-musik/.env');
});
