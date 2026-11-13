'use strict';
/*
 * SIT SHOW — Musical Chairs Royale
 * Zero-dependency Node server: static files, WebSocket game server,
 * MP3 streaming from the data directory, temporary avatar storage.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MUSIC_DIR = path.resolve(process.env.MUSIC_DIR || path.join(DATA_DIR, 'music'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROFILE_FILE = path.join(DATA_DIR, 'profiles.json');

const AVATAR_GRACE_MS = +process.env.AVATAR_GRACE_MS || 5 * 60 * 1000; // avatars survive 5 minutes after disconnect
const AVATAR_MAX_BYTES = 200 * 1024;
const WS_MAX_PAYLOAD = 16 * 1024;
const MAX_ROOMS = 200;

const T_INTRO = 3500;
const T_MUSIC_MIN = 7000;
const T_MUSIC_MAX = 30000;
const T_SCRAMBLE = 25000;
const T_RESULTS = 5200;
const T_GAMEOVER = 10000;
const WRONG_LOCK = 2000;

// When started as root (Docker/Unraid), fix ownership of the data folder and drop to PUID/PGID
// (Unraid's convention is 99:100 = nobody:users), so host-mounted appdata just works.
if (typeof process.getuid === 'function' && process.getuid() === 0 && process.env.PUID) {
  const uid = +process.env.PUID, gid = +(process.env.PGID || process.env.PUID);
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  try { fs.mkdirSync(MUSIC_DIR, { recursive: true }); } catch {}
  for (const p of [DATA_DIR, PROFILE_FILE, PROFILE_FILE + '.tmp', MUSIC_DIR]) {
    try { if (fs.existsSync(p)) fs.chownSync(p, uid, gid); } catch {} // read-only music mounts are fine
  }
  try { process.setgid(gid); process.setuid(uid); console.log(`Running as ${uid}:${gid}`); }
  catch (e) { console.warn('Could not drop privileges:', e.message); }
}
try { fs.mkdirSync(MUSIC_DIR, { recursive: true }); } catch (e) { console.warn('Could not create music dir:', e.message); }

// ───────────────────────────── catalog (unlockables) ─────────────────────────────
const CATALOG = {
  dances: [
    { id: 'strut', name: 'The Strut', level: 1 },
    { id: 'bounce', name: 'Pogo', level: 2 },
    { id: 'wiggle', name: 'Wiggle', level: 3 },
    { id: 'conga', name: 'Conga Kick', level: 5 },
    { id: 'spin', name: 'Twirl', level: 7 },
    { id: 'moonwalk', name: 'Moonwalk', level: 10 },
    { id: 'robot', name: 'The Robot', level: 13 },
    { id: 'floss', name: 'Floss', level: 16 },
  ],
  deaths: [
    { id: 'poof', name: 'Poof', level: 1 },
    { id: 'hook', name: 'Stage Hook', level: 2 },
    { id: 'trapdoor', name: 'Trapdoor', level: 4 },
    { id: 'confetti', name: 'Confetti Bomb', level: 6 },
    { id: 'lightning', name: 'Lightning Strike', level: 9 },
    { id: 'rocket', name: 'Blast Off', level: 12 },
    { id: 'ufo', name: 'Abduction', level: 15 },
    { id: 'blackhole', name: 'Black Hole', level: 18 },
  ],
  rings: [
    { id: 'none', name: 'Classic', level: 1 },
    { id: 'gold', name: 'Gold Leaf', level: 3 },
    { id: 'neon', name: 'Neon Buzz', level: 8 },
    { id: 'rainbow', name: 'Rainbow', level: 14 },
    { id: 'crown', name: 'Champion Crown', level: 20 },
  ],
  emotes: [
    { id: 'wave', e: '👋', level: 1 }, { id: 'lol', e: '😂', level: 1 },
    { id: 'clap', e: '👏', level: 1 }, { id: 'gasp', e: '😱', level: 1 },
    { id: 'fire', e: '🔥', level: 2 }, { id: 'cool', e: '😎', level: 3 },
    { id: 'cry', e: '😭', level: 4 }, { id: 'skull', e: '💀', level: 5 },
    { id: 'chicken', e: '🐔', level: 6 }, { id: 'party', e: '🎉', level: 8 },
    { id: 'crown', e: '👑', level: 11 }, { id: 'clown', e: '🤡', level: 13 },
    { id: 'chair', e: '🪑', level: 17 }, { id: 'goat', e: '🐐', level: 20 },
  ],
};
const XP_BASE = 30;
const xpForLevel = (L) => XP_BASE * L * (L - 1);
const levelForXp = (xp) => Math.max(1, Math.floor((1 + Math.sqrt(1 + (4 * xp) / XP_BASE)) / 2));
const catalogItem = (kind, id) => CATALOG[kind].find((x) => x.id === id);

// ───────────────────────────── helpers ─────────────────────────────
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rnd(arr.length)];
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function cleanText(v, max) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, max).join('');
}

// ───────────────────────────── profiles (levels persist on the data volume) ─────────────────────────────
let profiles = {};
try { profiles = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')) || {}; } catch { profiles = {}; }
{ // prune throwaway profiles that never earned anything
  const cutoff = Date.now() - 30 * 86400e3;
  for (const k of Object.keys(profiles)) if (!profiles[k].xp && (profiles[k].seen || 0) < cutoff) delete profiles[k];
}
let saveTimer = null;
let saveWarned = false;
function saveProfiles() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = PROFILE_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(profiles), (e) => {
      if (e) { if (!saveWarned) { saveWarned = true; console.warn('Cannot save profiles:', e.message); } return; }
      fs.rename(tmp, PROFILE_FILE, () => {});
    });
  }, 1500);
}
function flushProfiles() { try { fs.writeFileSync(PROFILE_FILE, JSON.stringify(profiles)); } catch {} }
process.on('SIGTERM', () => { flushProfiles(); process.exit(0); });
process.on('SIGINT', () => { flushProfiles(); process.exit(0); });

// ───────────────────────────── music ─────────────────────────────
let songCache = { at: 0, list: [] };
function listSongs() {
  if (Date.now() - songCache.at < 3000) return songCache.list;
  let list = [];
  try {
    list = fs.readdirSync(MUSIC_DIR, { withFileTypes: true })
      .filter((d) => d.isFile() && /\.mp3$/i.test(d.name) && !d.name.startsWith('.'))
      .map((d) => d.name).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  } catch {}
  songCache = { at: Date.now(), list };
  return list;
}

// ───────────────────────────── avatars (memory only, removed 5 min after disconnect) ─────────────────────────────
const avatars = new Map(); // pid -> { buf, type, hash, timer }
function sniffImage(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 12 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
function scheduleAvatarRemoval(pid) {
  const av = avatars.get(pid);
  if (!av) return;
  clearTimeout(av.timer);
  av.timer = setTimeout(() => { if (!byPid.has(pid)) avatars.delete(pid); }, AVATAR_GRACE_MS);
}

// ───────────────────────────── puzzles ─────────────────────────────
const WORDS = ['chair', 'music', 'dance', 'prize', 'lucky', 'buzzer', 'winner', 'encore', 'jingle', 'trophy', 'podium',
  'wizard', 'banjo', 'disco', 'funky', 'groove', 'rhythm', 'tempo', 'cushion', 'velvet', 'glitter', 'jackpot', 'sparkle',
  'wobble', 'giggle', 'panic', 'hurry', 'sofa', 'stool', 'bench', 'throne', 'rocket', 'zebra', 'pickle', 'waffle',
  'noodle', 'muffin', 'banana', 'cactus', 'dragon', 'pirate', 'ninja', 'robot', 'yodel', 'kazoo', 'tuba', 'confetti'];
const EMOJI_SETS = [
  ['🍎', '🍌', '🍇', '🍓', '🍑', '🍍', '🥝', '🍒'],
  ['🐶', '🐱', '🐸', '🐵', '🦊', '🐼', '🐷', '🐮'],
  ['🚗', '🚕', '🚌', '🚲', '🚀', '🚂', '🛵', '🚁'],
  ['⚽', '🏀', '🏈', '🎾', '🏐', '🎱', '🏓', '🥊'],
  ['🍕', '🍔', '🌭', '🌮', '🍟', '🍩', '🥨', '🧀'],
  ['🎸', '🎺', '🎻', '🥁', '🎹', '🎷', '🪗', '🪘'],
];
const INKS = [['RED', '#ff4d5e'], ['BLUE', '#4d8dff'], ['GREEN', '#3ddc84'], ['YELLOW', '#ffd93d'], ['PINK', '#ff7ad9'], ['ORANGE', '#ff9a3d']];

const PUZZLES = [
  function maths() {
    const v = rnd(3);
    let prompt, ans;
    if (v === 0) { const a = 3 + rnd(9), b = 3 + rnd(9); prompt = `${a} × ${b}`; ans = a * b; }
    else if (v === 1) { const a = 20 + rnd(60), b = 10 + rnd(40), c = 2 + rnd(18); prompt = `${a} + ${b} − ${c}`; ans = a + b - c; }
    else { const a = 2 + rnd(8), b = 2 + rnd(8), c = 1 + rnd(20); prompt = `${a} × ${b} + ${c}`; ans = a * b + c; }
    return { pub: { kind: 'type', numeric: true, title: 'Quick maths!', prompt: prompt + ' = ?' }, answer: String(ans) };
  },
  function unscramble() {
    const w = pick(WORDS);
    let s = w;
    for (let i = 0; i < 10 && s === w; i++) s = shuffle([...w]).join('');
    return { pub: { kind: 'type', title: 'Unscramble the word', prompt: s.toUpperCase().split('').join(' ') }, answer: w };
  },
  function sequence() {
    const v = rnd(4);
    let seq;
    if (v === 0) { const a = 1 + rnd(20), d = 2 + rnd(9); seq = [0, 1, 2, 3, 4].map((i) => a + d * i); }
    else if (v === 1) { const a = 1 + rnd(4), r = 2 + rnd(2); seq = [0, 1, 2, 3, 4].map((i) => a * r ** i); }
    else if (v === 2) { const a = 1 + rnd(5); seq = [0, 1, 2, 3, 4].map((i) => (a + i) ** 2); }
    else { const a = 1 + rnd(5), b = 1 + rnd(5); seq = [a, b]; while (seq.length < 5) seq.push(seq[seq.length - 1] + seq[seq.length - 2]); }
    return { pub: { kind: 'type', numeric: true, title: 'What comes next?', prompt: seq.slice(0, 4).join(', ') + ', ?' }, answer: String(seq[4]) };
  },
  function oddOne() {
    const [a, b] = shuffle(EMOJI_SETS);
    const odd = pick(b);
    return { pub: { kind: 'choice', title: 'Which one is the odd one out?', prompt: '', choices: shuffle([...shuffle(a).slice(0, 3), odd]), big: true }, answer: odd };
  },
  function count() {
    const set = shuffle(pick(EMOJI_SETS));
    const n = 3 + rnd(6);
    const cells = Array(n).fill(set[0]);
    const total = 13 + rnd(5);
    while (cells.length < total) cells.push(set[1 + rnd(3)]);
    const opts = new Set([n]);
    while (opts.size < 4) { const o = n + rnd(5) - 2; if (o > 0) opts.add(o); }
    return { pub: { kind: 'choice', title: `How many ${set[0]} ?`, prompt: shuffle(cells).join(' '), choices: shuffle([...opts]).map(String) }, answer: String(n) };
  },
  function stroop() {
    const [word, ink, x, y] = shuffle(INKS);
    return { pub: { kind: 'choice', title: 'What COLOUR is the ink? (not the word!)', prompt: word[0], ink: ink[1], choices: shuffle([word[0], ink[0], x[0], y[0]]) }, answer: ink[0] };
  },
  function biggest() {
    const seen = new Set(); const items = [];
    while (items.length < 4) {
      const a = 2 + rnd(9), b = 2 + rnd(9), plus = rnd(2);
      const val = plus ? a * 6 + b : a * b;
      if (seen.has(val)) continue;
      seen.add(val);
      items.push({ label: plus ? `${a * 6} + ${b}` : `${a} × ${b}`, val });
    }
    const best = items.reduce((m, i) => (i.val > m.val ? i : m));
    return { pub: { kind: 'choice', title: 'Which is the BIGGEST?', prompt: '', choices: items.map((i) => i.label) }, answer: best.label };
  },
  function backwards() {
    const w = pick(WORDS.filter((x) => x.length <= 6));
    return { pub: { kind: 'type', title: 'Type it backwards!', prompt: w.toUpperCase() }, answer: [...w].reverse().join('') };
  },
];
function makePuzzles(n) {
  const order = shuffle(PUZZLES);
  return Array.from({ length: n }, (_, i) => order[i % order.length]());
}
const normAnswer = (a) => String(a == null ? '' : a).trim().toLowerCase().replace(/\s+/g, '').slice(0, 40);

// ───────────────────────────── connections / rooms ─────────────────────────────
const conns = new Set();
const byPid = new Map();
const rooms = new Map();

const BOT_NAMES = ['Sir Sits-a-Lot', 'Stool Pigeon', 'Recliner Rex', 'Cushion Crusher', 'Wobbly Wanda', 'Beanbag Bob',
  'Ottoman Empire', 'Lazy Susan', 'Deck Chair Dave', 'Throne Ranger', 'Squeaky Hinge', 'Pouffe Daddy'];
const BOT_FACES = ['🐙', '🦄', '🐸', '🦖', '🐧', '🦊', '🐼', '🐵', '🦁', '🐯', '🐨', '🐔'];
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newRoomCode() {
  for (;;) {
    let c = '';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) c += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (!rooms.has(c)) return c;
  }
}
function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 32); }

function meInfo(conn) {
  const p = conn.prof;
  const level = levelForXp(p.xp);
  return {
    id: conn.pid, name: p.name, xp: p.xp, level,
    levelXp: xpForLevel(level), nextXp: xpForLevel(level + 1),
    dance: p.dance, death: p.death, ring: p.ring,
    av: avatars.get(conn.pid)?.hash || null,
  };
}
function pubPlayer(room, p) {
  const prof = p.prof;
  return {
    id: p.id, name: prof.name, level: p.bot ? p.level : levelForXp(prof.xp),
    av: p.bot ? null : avatars.get(p.id)?.hash || null, face: p.face || null,
    dance: prof.dance, death: prof.death, ring: prof.ring,
    inGame: p.inGame, alive: p.alive, seat: p.seat, pick: p.pick, bot: !!p.bot,
  };
}
function roomState(room) {
  const now = Date.now();
  return {
    t: 'room', code: room.code, name: room.name, vis: room.vis, locked: !!room.pw, max: room.max,
    hostId: room.hostId, phase: room.phase, round: room.round, song: room.song, current: room.currentSong,
    remain: room.phase !== 'music' && room.phaseEnds ? Math.max(0, room.phaseEnds - now) : 0,
    elapsed: room.phase === 'music' ? now - room.musicStart : 0,
    chairs: room.chairs.map((c) => ({ owner: c.owner, puzzle: room.phase === 'scramble' && !c.owner ? c.pub : null })),
    players: [...room.players.values()].map((p) => pubPlayer(room, p)),
    out: room.lastOut, nobody: room.nobody, winner: room.winner, standings: room.standings,
  };
}
function sendRoom(room, obj) {
  const frame = encodeFrame(JSON.stringify(obj));
  for (const p of room.players.values()) if (p.conn) p.conn.sendRaw(frame);
}
function pushState(room) {
  if (room.dirty || room.dead) return;
  room.dirty = true;
  setImmediate(() => { room.dirty = false; if (!room.dead) sendRoom(room, roomState(room)); });
}
let lobbyDirty = false;
function lobbyList() {
  return {
    t: 'rooms',
    rooms: [...rooms.values()].filter((r) => r.vis === 'public').map((r) => ({
      code: r.code, name: r.name, locked: !!r.pw, players: r.players.size, max: r.max,
      playing: r.phase !== 'lobby', host: r.players.get(r.hostId)?.prof.name || '',
    })),
  };
}
function pushLobby() {
  if (lobbyDirty) return;
  lobbyDirty = true;
  setTimeout(() => {
    lobbyDirty = false;
    const frame = encodeFrame(JSON.stringify(lobbyList()));
    for (const c of conns) if (c.pid && !c.room) c.sendRaw(frame);
  }, 150);
}

function setPhaseTimer(room, ms, fn) {
  clearTimeout(room.timer);
  room.phaseEnds = Date.now() + ms;
  room.timer = setTimeout(() => { if (!room.dead) fn(); }, ms);
}
const alivePlayers = (room) => [...room.players.values()].filter((p) => p.inGame && p.alive);
const humans = (room) => [...room.players.values()].filter((p) => !p.bot);

function resetToLobby(room) {
  clearTimeout(room.timer);
  room.phase = 'lobby'; room.round = 0; room.chairs = []; room.currentSong = null; room.phaseEnds = 0;
  room.lastOut = []; room.nobody = false; room.winner = null; room.standings = null;
  for (const p of room.players.values()) { p.inGame = false; p.alive = false; p.seat = null; p.pick = null; clearTimeout(p.timer); }
  pushState(room); pushLobby();
}
function startGame(room) {
  if (room.phase !== 'lobby' || room.players.size < 2) return;
  room.outOrder = []; room.winner = null; room.standings = null; room.round = 0; room.lastSong = null;
  for (const p of room.players.values()) { p.inGame = true; p.alive = true; p.seat = null; p.pick = null; p.seats = 0; p.lockUntil = 0; }
  pushLobby();
  nextRound(room);
}
function nextRound(room) {
  const alive = alivePlayers(room);
  if (alive.length <= 1) return endGame(room);
  room.round++;
  room.lastOut = []; room.nobody = false;
  for (const p of room.players.values()) { p.seat = null; p.pick = null; p.lockUntil = 0; clearTimeout(p.timer); }
  const drop = alive.length >= 8 ? 2 : 1;
  room.chairs = Array.from({ length: Math.max(1, alive.length - drop) }, () => ({ owner: null, pub: null, answer: null }));
  const songs = listSongs();
  if (room.song !== 'random' && songs.includes(room.song)) room.currentSong = room.song;
  else if (songs.length) {
    const pool = songs.length > 1 ? songs.filter((s) => s !== room.lastSong) : songs;
    room.currentSong = pick(pool);
  } else room.currentSong = null; // client falls back to the built-in house band
  room.lastSong = room.currentSong;
  room.phase = 'intro';
  setPhaseTimer(room, T_INTRO, () => startMusic(room));
  pushState(room);
}
function startMusic(room) {
  room.phase = 'music';
  room.musicStart = Date.now();
  // the stop time is secret: clients are never told how long the music will run
  const dur = T_MUSIC_MIN + Math.random() * (T_MUSIC_MAX - T_MUSIC_MIN);
  setPhaseTimer(room, dur, () => startScramble(room));
  pushState(room);
}
function startScramble(room) {
  room.phase = 'scramble';
  const puzzles = makePuzzles(room.chairs.length);
  room.chairs.forEach((c, i) => { c.pub = puzzles[i].pub; c.answer = normAnswer(puzzles[i].answer); });
  setPhaseTimer(room, T_SCRAMBLE, () => endScramble(room));
  pushState(room);
  for (const p of room.players.values()) if (p.bot && p.alive) botThink(room, p, 900 + Math.random() * 1200);
}
function claimChair(room, p, i) {
  const chair = room.chairs[i];
  if (!chair || chair.owner || p.seat != null) return false;
  chair.owner = p.id; p.seat = i; p.pick = i; p.seats++;
  sendRoom(room, { t: 'claim', id: p.id, chair: i });
  pushState(room);
  checkScrambleDone(room);
  return true;
}
function checkScrambleDone(room) {
  if (room.phase !== 'scramble') return;
  const waiting = alivePlayers(room).filter((p) => p.seat == null);
  if (!waiting.length || room.chairs.every((c) => c.owner)) endScramble(room);
}
function endScramble(room) {
  if (room.phase !== 'scramble') return;
  const alive = alivePlayers(room);
  const seated = alive.filter((p) => p.seat != null);
  room.phase = 'results';
  if (!seated.length) { // nobody solved anything: replay the round
    room.nobody = true; room.lastOut = []; room.round--;
  } else {
    const losers = alive.filter((p) => p.seat == null);
    for (const p of losers) { p.alive = false; p.pick = null; room.outOrder.push({ id: p.id, name: p.prof.name }); }
    room.lastOut = losers.map((p) => p.id);
  }
  setPhaseTimer(room, room.lastOut.length ? T_RESULTS : 2600, () => nextRound(room));
  pushState(room);
}
function endGame(room) {
  clearTimeout(room.timer);
  const winner = alivePlayers(room)[0] || null;
  room.phase = 'gameover';
  room.winner = winner ? winner.id : null;
  room.standings = [...(winner ? [{ id: winner.id, name: winner.prof.name }] : []), ...room.outOrder.slice().reverse()].slice(0, 12);
  room.chairs = [];
  for (const p of room.players.values()) {
    if (p.bot || !p.inGame || !p.conn) continue;
    const before = levelForXp(p.prof.xp);
    const gained = 15 + 12 * (p.seats || 0) + (winner === p ? 50 : 0);
    p.prof.xp += gained;
    const after = levelForXp(p.prof.xp);
    const unlocked = [];
    if (after > before) {
      for (const kind of Object.keys(CATALOG)) for (const it of CATALOG[kind]) {
        if (it.level > before && it.level <= after) unlocked.push({ kind, name: it.name || it.e });
      }
    }
    p.conn.send({ t: 'xp', gained, leveled: after > before, unlocked, me: meInfo(p.conn) });
  }
  saveProfiles();
  setPhaseTimer(room, T_GAMEOVER, () => resetToLobby(room));
  pushState(room);
}

function botThink(room, bot, delay) {
  clearTimeout(bot.timer);
  bot.timer = setTimeout(() => {
    if (room.dead || room.phase !== 'scramble' || !bot.alive || bot.seat != null) return;
    const free = room.chairs.map((c, i) => (c.owner ? -1 : i)).filter((i) => i >= 0);
    if (!free.length) return;
    const i = pick(free);
    bot.pick = i; pushState(room);
    bot.timer = setTimeout(() => {
      if (room.dead || room.phase !== 'scramble' || bot.seat != null) return;
      if (room.chairs[i].owner) return botThink(room, bot, 500 + Math.random() * 900);
      if (Math.random() < 0.2) { sendRoom(room, { t: 'miss', id: bot.id }); return botThink(room, bot, WRONG_LOCK); }
      claimChair(room, bot, i);
    }, 2600 + Math.random() * 6000);
  }, delay);
}
function addBot(room) {
  if (room.players.size >= room.max || room.phase !== 'lobby') return;
  const used = new Set([...room.players.values()].map((p) => p.prof.name));
  const name = BOT_NAMES.find((n) => !used.has(n)) || 'Bot ' + (1 + rnd(999));
  const id = 'bot' + crypto.randomBytes(4).toString('hex');
  const level = 1 + rnd(18);
  const avail = (kind) => pick(CATALOG[kind].filter((x) => x.level <= level)).id;
  room.players.set(id, {
    id, bot: true, conn: null, level, face: BOT_FACES[BOT_NAMES.indexOf(name)] || '🤖',
    prof: { name, xp: 0, dance: avail('dances'), death: avail('deaths'), ring: avail('rings') },
    inGame: false, alive: false, seat: null, pick: null, seats: 0,
  });
  pushState(room); pushLobby();
}

function destroyRoom(room) {
  room.dead = true;
  clearTimeout(room.timer);
  for (const p of room.players.values()) clearTimeout(p.timer);
  rooms.delete(room.code);
  pushLobby();
}
function removePlayer(room, p) {
  clearTimeout(p.timer);
  room.players.delete(p.id);
  if (p.conn) p.conn.room = null;
  if (p.inGame && p.alive && room.phase !== 'lobby' && room.phase !== 'gameover') room.outOrder.push({ id: p.id, name: p.prof.name });
  if (!humans(room).length) return destroyRoom(room);
  if (room.hostId === p.id) room.hostId = humans(room)[0].id;
  pushState(room); pushLobby();
  if (room.phase === 'lobby' || room.phase === 'gameover') return;
  if (alivePlayers(room).length <= 1 && room.phase !== 'results') return endGame(room);
  checkScrambleDone(room);
}
function joinRoom(conn, room) {
  if (conn.room) removePlayer(conn.room, conn.room.players.get(conn.pid));
  room.players.set(conn.pid, { id: conn.pid, conn, prof: conn.prof, inGame: false, alive: false, seat: null, pick: null, seats: 0, lockUntil: 0 });
  conn.room = room;
  conn.send({ t: 'joined', code: room.code });
  conn.send(roomState(room));
  pushState(room); pushLobby();
}

// ───────────────────────────── message handling ─────────────────────────────
const handlers = {
  createRoom(conn, m) {
    if (rooms.size >= MAX_ROOMS) return conn.send({ t: 'toast', msg: 'The studio is full — try again later.' });
    const pw = String(m.password || '').slice(0, 64);
    const room = {
      code: newRoomCode(), name: cleanText(m.name, 28) || `${conn.prof.name}'s show`,
      vis: m.vis === 'private' ? 'private' : 'public', pw: null,
      max: Math.min(12, Math.max(2, m.max | 0 || 8)), players: new Map(), hostId: conn.pid,
      phase: 'lobby', round: 0, chairs: [], song: 'random', currentSong: null, lastSong: null,
      lastOut: [], outOrder: [], nobody: false, winner: null, standings: null, phaseEnds: 0, musicStart: 0,
    };
    if (pw) { const salt = crypto.randomBytes(16); room.pw = { salt, hash: hashPw(pw, salt) }; }
    rooms.set(room.code, room);
    joinRoom(conn, room);
  },
  joinRoom(conn, m) {
    const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const room = rooms.get(code);
    if (!room) return conn.send({ t: 'joinfail', reason: 'notfound', code });
    if (conn.room === room) return conn.send(roomState(room));
    if (room.players.size >= room.max) return conn.send({ t: 'joinfail', reason: 'full', code });
    if (room.pw) {
      const pw = String(m.password || '').slice(0, 64);
      if (!pw) return conn.send({ t: 'joinfail', reason: 'password', code, name: room.name });
      if (++conn.pwFails > 12) return conn.close();
      if (!crypto.timingSafeEqual(hashPw(pw, room.pw.salt), room.pw.hash)) return conn.send({ t: 'joinfail', reason: 'badpw', code, name: room.name });
      conn.pwFails = 0;
    }
    joinRoom(conn, room);
  },
  leaveRoom(conn) {
    if (!conn.room) return;
    removePlayer(conn.room, conn.room.players.get(conn.pid));
    conn.send({ t: 'left' });
    conn.send(lobbyList());
  },
  setName(conn, m) {
    const name = cleanText(m.name, 16);
    if (!name) return;
    conn.prof.name = name; saveProfiles();
    conn.send({ t: 'me', me: meInfo(conn) });
    if (conn.room) { pushState(conn.room); pushLobby(); }
  },
  equip(conn, m) {
    const level = levelForXp(conn.prof.xp);
    for (const [field, kind] of [['dance', 'dances'], ['death', 'deaths'], ['ring', 'rings']]) {
      if (m[field] == null) continue;
      const it = catalogItem(kind, String(m[field]));
      if (it && it.level <= level) conn.prof[field] = it.id;
    }
    saveProfiles();
    conn.send({ t: 'me', me: meInfo(conn) });
    if (conn.room) pushState(conn.room);
  },
  emote(conn, m) {
    const room = conn.room; if (!room) return;
    const now = Date.now();
    if (now - conn.lastEmote < 350) return;
    const it = catalogItem('emotes', String(m.id));
    if (!it || it.level > levelForXp(conn.prof.xp)) return;
    conn.lastEmote = now;
    sendRoom(room, { t: 'emote', id: conn.pid, e: it.e });
  },
  songs(conn) { songCache.at = 0; conn.send({ t: 'songs', songs: listSongs() }); },
  setSong(conn, m) {
    const room = conn.room; if (!room || room.hostId !== conn.pid) return;
    const s = String(m.song || 'random');
    room.song = s === 'random' || listSongs().includes(s) ? s : 'random';
    pushState(room);
  },
  addBot(conn) { const room = conn.room; if (room && room.hostId === conn.pid) addBot(room); },
  removeBot(conn) {
    const room = conn.room; if (!room || room.hostId !== conn.pid || room.phase !== 'lobby') return;
    const bots = [...room.players.values()].filter((p) => p.bot);
    if (bots.length) removePlayer(room, bots[bots.length - 1]);
  },
  start(conn) { const room = conn.room; if (room && room.hostId === conn.pid) startGame(room); },
  pick(conn, m) {
    const room = conn.room; if (!room || room.phase !== 'scramble') return;
    const p = room.players.get(conn.pid); const i = m.chair | 0;
    if (!p || !p.alive || p.seat != null || !room.chairs[i] || room.chairs[i].owner || p.pick === i) return;
    p.pick = i; pushState(room);
  },
  answer(conn, m) {
    const room = conn.room; if (!room || room.phase !== 'scramble') return;
    const p = room.players.get(conn.pid); const i = m.chair | 0; const chair = room.chairs[i];
    if (!p || !p.alive || p.seat != null || !chair || chair.owner) return;
    const now = Date.now();
    if (now < p.lockUntil) return;
    if (normAnswer(m.a) === chair.answer) return void claimChair(room, p, i);
    p.lockUntil = now + WRONG_LOCK;
    conn.send({ t: 'wrong', lock: WRONG_LOCK, chair: i });
    sendRoom(room, { t: 'miss', id: p.id });
  },
};

function onMessage(conn, text) {
  let m;
  try { m = JSON.parse(text); } catch { return; }
  if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
  const now = Date.now();
  if (now - conn.rateAt > 1000) { conn.rateAt = now; conn.rateN = 0; }
  if (++conn.rateN > 40) return conn.close();

  if (!conn.pid) {
    if (m.t !== 'hello') return;
    const token = String(m.token || '');
    if (!/^[a-f0-9]{32,64}$/.test(token)) return conn.close();
    const pid = sha('pid:' + token).slice(0, 12);
    if (byPid.has(pid)) return conn.send({ t: 'dup' });
    const key = sha('profile:' + token);
    let prof = profiles[key];
    if (!prof) prof = profiles[key] = { name: cleanText(m.name, 16) || 'Contestant ' + (1000 + rnd(9000)), xp: 0, dance: 'strut', death: 'poof', ring: 'none' };
    prof.seen = now; saveProfiles();
    conn.pid = pid; conn.prof = prof;
    byPid.set(pid, conn);
    const av = avatars.get(pid);
    if (av) clearTimeout(av.timer); // reconnected inside the grace period
    conn.send({ t: 'welcome', me: meInfo(conn), catalog: CATALOG, songs: listSongs() });
    conn.send(lobbyList());
    return;
  }
  if (m.t === 'hello' || !Object.prototype.hasOwnProperty.call(handlers, m.t)) return;
  handlers[m.t](conn, m);
}
function onClose(conn) {
  conns.delete(conn);
  if (!conn.pid || byPid.get(conn.pid) !== conn) return;
  byPid.delete(conn.pid);
  if (conn.room) removePlayer(conn.room, conn.room.players.get(conn.pid));
  scheduleAvatarRemoval(conn.pid);
}

// ───────────────────────────── minimal WebSocket (RFC 6455) ─────────────────────────────
function encodeFrame(data, opcode = 1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.allocUnsafe(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.allocUnsafe(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.allocUnsafe(10); head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, payload]);
}
class Conn {
  constructor(socket) {
    this.socket = socket; this.buf = Buffer.alloc(0); this.parts = null; this.partsLen = 0;
    this.open = true; this.alive = true;
    this.pid = null; this.prof = null; this.room = null;
    this.rateAt = 0; this.rateN = 0; this.lastEmote = 0; this.pwFails = 0;
    socket.setNoDelay(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.end());
    socket.on('error', () => this.end());
  }
  end() { if (!this.open) return; this.open = false; this.socket.destroy(); onClose(this); }
  close() { if (!this.open) return; try { this.socket.write(encodeFrame(Buffer.alloc(0), 8)); } catch {} this.end(); }
  sendRaw(frame) { if (this.open && this.socket.writable) this.socket.write(frame); }
  send(obj) { this.sendRaw(encodeFrame(JSON.stringify(obj))); }
  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.open) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) return this.close();
      if (!masked || len > WS_MAX_PAYLOAD) return this.close();
      if (b.length < off + 4 + len) return;
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = b[off + 4 + i] ^ b[off + (i & 3)];
      this.buf = b.subarray(off + 4 + len);
      if (op === 8) return this.close();
      if (op === 9) { this.sendRaw(encodeFrame(payload, 10)); continue; }
      if (op === 10) { this.alive = true; continue; }
      if (op === 1 || op === 0) {
        if (op === 1) { this.parts = []; this.partsLen = 0; }
        if (!this.parts) return this.close();
        this.parts.push(payload); this.partsLen += len;
        if (this.partsLen > WS_MAX_PAYLOAD) return this.close();
        if (fin) {
          const text = Buffer.concat(this.parts).toString('utf8');
          this.parts = null;
          try { onMessage(this, text); } catch (e) { console.error('handler error', e); }
        }
      } // binary frames are ignored
    }
  }
}
setInterval(() => {
  const ping = encodeFrame(Buffer.alloc(0), 9);
  for (const c of conns) { if (!c.alive) { c.end(); continue; } c.alive = false; c.sendRaw(ping); }
}, 25000).unref();

// ───────────────────────────── HTTP ─────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function sendJson(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
function tokenConn(req) {
  const token = String(req.headers['x-token'] || '');
  if (!/^[a-f0-9]{32,64}$/.test(token)) return null;
  return byPid.get(sha('pid:' + token).slice(0, 12)) || null;
}
function avatarChanged(conn) {
  conn.send({ t: 'me', me: meInfo(conn) });
  if (conn.room) pushState(conn.room);
}
function serveFile(req, res, file, type, extraHeaders = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const headers = { 'content-type': type, 'accept-ranges': 'bytes', ...extraHeaders };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? parseInt(range[1], 10) : Math.max(0, st.size - parseInt(range[2], 10));
      let end = range[1] && range[2] ? Math.min(parseInt(range[2], 10), st.size - 1) : st.size - 1;
      if (start >= st.size || start > end) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
    }
    res.writeHead(200, { ...headers, 'content-length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  res.setHeader('x-content-type-options', 'nosniff');

  if (pathname === '/api/health') return sendJson(res, 200, { ok: true, rooms: rooms.size, players: byPid.size });

  if (pathname === '/api/avatar') {
    const conn = tokenConn(req);
    if (!conn) return sendJson(res, 401, { error: 'not connected' });
    if (req.method === 'DELETE') {
      const av = avatars.get(conn.pid);
      if (av) { clearTimeout(av.timer); avatars.delete(conn.pid); }
      avatarChanged(conn);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
    const chunks = []; let size = 0; let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > AVATAR_MAX_BYTES) { aborted = true; sendJson(res, 413, { error: 'too large' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const buf = Buffer.concat(chunks);
      const type = sniffImage(buf);
      if (!type) return sendJson(res, 415, { error: 'unsupported image' });
      if (byPid.get(conn.pid) !== conn) return sendJson(res, 401, { error: 'not connected' });
      const old = avatars.get(conn.pid);
      if (old) clearTimeout(old.timer);
      const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
      avatars.set(conn.pid, { buf, type, hash, timer: null });
      avatarChanged(conn);
      sendJson(res, 200, { hash });
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }

  if (pathname.startsWith('/avatar/')) {
    const av = avatars.get(pathname.slice(8));
    if (!av) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': av.type, 'content-length': av.buf.length, 'cache-control': 'private, max-age=300' });
    return res.end(req.method === 'HEAD' ? undefined : av.buf);
  }
  if (pathname.startsWith('/music/')) {
    const name = pathname.slice(7);
    if (!listSongs().includes(name)) { res.writeHead(404); return res.end(); } // only files from the scanned list
    return serveFile(req, res, path.join(MUSIC_DIR, name), 'audio/mpeg', { 'cache-control': 'public, max-age=3600' });
  }
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  serveFile(req, res, file, MIME[path.extname(file)] || 'application/octet-stream', { 'cache-control': 'no-cache' });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !req.url.startsWith('/ws')) return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  conns.add(new Conn(socket));
});

server.listen(PORT, () => {
  console.log(`SIT SHOW is on air → http://localhost:${PORT}`);
  console.log(`Music directory: ${MUSIC_DIR} (${listSongs().length} MP3s)`);
});
