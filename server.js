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
const { GROUPS, makePuzzles } = require('./puzzles');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MUSIC_DIR = path.resolve(process.env.MUSIC_DIR || path.join(DATA_DIR, 'music'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROFILE_FILE = path.join(DATA_DIR, 'profiles.json');

const AVATAR_GRACE_MS = +process.env.AVATAR_GRACE_MS || 5 * 60 * 1000; // avatars survive 5 minutes after disconnect
const RECONNECT_GRACE_MS = +process.env.RECONNECT_GRACE_MS || 60 * 1000; // a dropped player keeps their spot this long
const AVATAR_MAX_BYTES = 200 * 1024;
const WS_MAX_PAYLOAD = 16 * 1024;
const MAX_ROOMS = 200;

const T_INTRO = 3500;
const T_RESULTS = 5200;
const T_GAMEOVER = 10000;
const WRONG_LOCK = 2000;
const MASH_GAP = 50; // ms between counted taps

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
try { fs.mkdirSync(MUSIC_DIR, { recursive: true }); } catch {}

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
const clampInt = (v, a, b, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : d; };
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

// ───────────────────────────── music (folders = categories) ─────────────────────────────
const STREAM_SAFE_RE = /^stream[\s_-]*safe$/i;
let songCache = { at: 0, list: [] };
function listSongs() {
  if (Date.now() - songCache.at < 3000) return songCache.list;
  const out = [];
  const walk = (dir, rel, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      if (out.length >= 5000) return;
      if (d.name.startsWith('.') || d.name.startsWith('@')) continue; // hidden, Synology @eaDir etc.
      const r = rel ? rel + '/' + d.name : d.name;
      let isDir = d.isDirectory(), isFile = d.isFile();
      if (d.isSymbolicLink()) { try { const st = fs.statSync(path.join(dir, d.name)); isDir = st.isDirectory(); isFile = st.isFile(); } catch { continue; } }
      if (isDir) { if (depth < 4) walk(path.join(dir, d.name), r, depth + 1); }
      else if (isFile && /\.mp3$/i.test(d.name)) out.push(r);
    }
  };
  walk(MUSIC_DIR, '', 0);
  out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  songCache = { at: Date.now(), list: out };
  return out;
}
const songCat = (s) => (s.includes('/') ? s.slice(0, s.indexOf('/')) : '');
function musicInfo() {
  const songs = listSongs();
  const counts = new Map();
  for (const s of songs) counts.set(songCat(s), (counts.get(songCat(s)) || 0) + 1);
  return {
    songs,
    cats: [...counts].map(([name, n]) => ({ name, n })).sort((a, b) => a.name.localeCompare(b.name)),
    streamSafe: songs.filter((s) => STREAM_SAFE_RE.test(songCat(s))),
  };
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
const normAnswer = (a) => String(a == null ? '' : a).trim().toLowerCase().replace(/\s+/g, '').slice(0, 80);

// ───────────────────────────── rooms ─────────────────────────────
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
const defaultSettings = () => ({
  category: 'all', song: 'random', musicMin: 7, musicMax: 30, speed: false,
  manual: false, scramble: 25, puzzles: Object.fromEntries(GROUPS.map((g) => [g.id, true])),
});
function applySettings(room, m) {
  const s = room.settings;
  if ('category' in m) {
    const c = String(m.category);
    if (c === 'all' || musicInfo().cats.some((x) => x.name === c)) { if (c !== s.category) s.song = 'random'; s.category = c; }
  }
  if ('song' in m) {
    const v = String(m.song);
    if (v === 'random' || (listSongs().includes(v) && (s.category === 'all' || songCat(v) === s.category))) s.song = v;
  }
  if ('musicMin' in m) { s.musicMin = clampInt(m.musicMin, 3, 90, s.musicMin); if (s.musicMax < s.musicMin) s.musicMax = s.musicMin; }
  if ('musicMax' in m) { s.musicMax = clampInt(m.musicMax, 3, 90, s.musicMax); if (s.musicMin > s.musicMax) s.musicMin = s.musicMax; }
  if ('speed' in m) s.speed = !!m.speed;
  if ('manual' in m) s.manual = !!m.manual;
  if ('scramble' in m) s.scramble = clampInt(m.scramble, 10, 60, s.scramble);
  if (m.puzzles && typeof m.puzzles === 'object') {
    for (const g of GROUPS) if (g.id in m.puzzles) s.puzzles[g.id] = !!m.puzzles[g.id];
    if (!GROUPS.some((g) => s.puzzles[g.id])) s.puzzles.brain = true;
  }
}

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
function pubPlayer(p) {
  const prof = p.prof;
  return {
    id: p.id, name: prof.name, level: p.bot ? p.level : levelForXp(prof.xp),
    av: p.bot ? null : avatars.get(p.id)?.hash || null, face: p.face || null,
    dance: prof.dance, death: prof.death, ring: prof.ring,
    inGame: p.inGame, alive: p.alive, seat: p.seat, pick: p.pick, bot: !!p.bot, away: !p.bot && !p.conn,
  };
}
function roomState(room) {
  const now = Date.now();
  return {
    t: 'room', code: room.code, name: room.name, vis: room.vis, locked: !!room.pw, max: room.max,
    hostId: room.hostId, ownerId: room.ownerId, phase: room.phase, round: room.round, current: room.currentSong,
    settings: room.settings,
    remain: room.phase !== 'music' && room.phaseEnds ? Math.max(0, room.phaseEnds - now) : 0,
    elapsed: room.phase === 'music' ? now - room.musicStart : 0,
    chairs: room.chairs.map((c) => ({
      owner: c.owner,
      puzzle: room.phase === 'scramble' && !c.owner ? (c.kind === 'reaction' ? { ...c.pub, go: now >= c.goAt } : c.pub) : null,
    })),
    players: [...room.players.values()].map(pubPlayer),
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
function clearChairTimers(room) { for (const t of room.chairTimers) clearTimeout(t); room.chairTimers = []; }
const alivePlayers = (room) => [...room.players.values()].filter((p) => p.inGame && p.alive);
const humans = (room) => [...room.players.values()].filter((p) => !p.bot);
function passHost(room) { // give control to someone who is actually connected
  const next = humans(room).find((h) => h.conn) || humans(room)[0];
  if (next) room.hostId = next.id;
}
function resetSeats(room) {
  for (const p of room.players.values()) { p.seat = null; p.pick = null; p.lockUntil = 0; if (p.bot) clearTimeout(p.timer); }
}

function resetToLobby(room) {
  clearTimeout(room.timer); clearChairTimers(room);
  room.phase = 'lobby'; room.round = 0; room.chairs = []; room.currentSong = null; room.phaseEnds = 0;
  room.lastOut = []; room.nobody = false; room.winner = null; room.standings = null;
  resetSeats(room);
  for (const p of room.players.values()) { p.inGame = false; p.alive = false; }
  pushState(room); pushLobby();
}
function startGame(room) {
  if (room.phase !== 'lobby' || room.players.size < 2) return;
  room.outOrder = []; room.winner = null; room.standings = null; room.round = 0; room.lastSong = null;
  for (const p of room.players.values()) { p.inGame = true; p.alive = true; p.seats = 0; }
  resetSeats(room);
  pushLobby();
  beginRound(room);
}
function pickSong(room) {
  const s = room.settings, songs = listSongs();
  const pool = s.category === 'all' ? songs : songs.filter((x) => songCat(x) === s.category);
  if (s.song !== 'random' && pool.includes(s.song)) return s.song;
  if (!pool.length) return null; // the client's built-in House Band plays instead
  const fresh = pool.length > 1 ? pool.filter((x) => x !== room.lastSong) : pool;
  return pick(fresh);
}
function beginRound(room) {
  const alive = alivePlayers(room);
  if (alive.length <= 1) return endGame(room);
  room.round++;
  room.lastOut = []; room.nobody = false;
  resetSeats(room);
  const drop = alive.length >= 8 ? 2 : 1;
  room.chairs = Array.from({ length: Math.max(1, alive.length - drop) }, () => ({ owner: null, pub: null, answer: null, kind: 'answer' }));
  room.currentSong = room.lastSong = pickSong(room);
  room.phase = 'intro';
  setPhaseTimer(room, T_INTRO, () => startMusic(room));
  pushState(room);
}
function startMusic(room) {
  room.phase = 'music';
  room.musicStart = Date.now();
  // the stop time is secret: clients are never told how long the music will run
  const { musicMin, musicMax } = room.settings;
  setPhaseTimer(room, (musicMin + Math.random() * (musicMax - musicMin)) * 1000, () => startScramble(room));
  pushState(room);
}
function startScramble(room) {
  if (room.phase !== 'music') return;
  room.phase = 'scramble';
  const now = Date.now();
  const puzzles = makePuzzles(room.chairs.length, room.settings.puzzles, room.usedQ);
  clearChairTimers(room);
  room.chairs.forEach((c, i) => {
    const p = puzzles[i];
    Object.assign(c, { pub: p.pub, kind: p.kind, answer: p.answer != null ? normAnswer(p.answer) : null, need: p.need || 0, taps: new Map(), goAt: 0 });
    if (c.kind === 'reaction') {
      c.goAt = now + 1500 + rnd(3500);
      room.chairTimers.push(setTimeout(() => pushState(room), c.goAt - now));
    }
  });
  setPhaseTimer(room, room.settings.scramble * 1000, () => endScramble(room));
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
function wrongAnswer(room, p, i) {
  p.lockUntil = Date.now() + WRONG_LOCK;
  if (p.conn) p.conn.send({ t: 'wrong', lock: WRONG_LOCK, chair: i });
  sendRoom(room, { t: 'miss', id: p.id });
}
function checkScrambleDone(room) {
  if (room.phase !== 'scramble') return;
  const waiting = alivePlayers(room).filter((p) => p.seat == null);
  if (!waiting.length || room.chairs.every((c) => c.owner)) endScramble(room);
}
function endScramble(room) {
  if (room.phase !== 'scramble') return;
  clearChairTimers(room);
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
  setPhaseTimer(room, room.lastOut.length ? T_RESULTS : 2600, () => afterResults(room));
  pushState(room);
}
function afterResults(room) {
  if (alivePlayers(room).length <= 1) return endGame(room);
  if (room.settings.manual) { // wait for the host to press "Start round"
    clearTimeout(room.timer);
    room.phase = 'ready'; room.phaseEnds = 0; room.chairs = []; room.lastOut = [];
    resetSeats(room);
    return pushState(room);
  }
  beginRound(room);
}
function endGame(room) {
  clearTimeout(room.timer); clearChairTimers(room);
  const winner = alivePlayers(room)[0] || null;
  room.phase = 'gameover';
  room.winner = winner ? winner.id : null;
  room.standings = [...(winner ? [{ id: winner.id, name: winner.prof.name }] : []), ...room.outOrder.slice().reverse()].slice(0, 12);
  room.chairs = [];
  for (const p of room.players.values()) {
    if (p.bot || !p.inGame) continue;
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
    if (p.conn) p.conn.send({ t: 'xp', gained, leveled: after > before, unlocked, me: meInfo(p.conn) });
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
    bot.timer = setTimeout(function attempt() {
      if (room.dead || room.phase !== 'scramble' || bot.seat != null) return;
      const ch = room.chairs[i];
      if (ch.owner) return botThink(room, bot, 500 + Math.random() * 900);
      if (ch.kind === 'reaction' && Date.now() < ch.goAt + 250) { bot.timer = setTimeout(attempt, ch.goAt + 250 + rnd(500) - Date.now()); return; }
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
  clearTimeout(room.timer); clearChairTimers(room);
  for (const p of room.players.values()) { clearTimeout(p.timer); clearTimeout(p.awayTimer); }
  rooms.delete(room.code);
  pushLobby();
}
function removePlayer(room, p) {
  if (!p) return;
  clearTimeout(p.timer); clearTimeout(p.awayTimer);
  room.players.delete(p.id);
  if (p.conn && p.conn.room === room) p.conn.room = null;
  if (p.inGame && p.alive && room.phase !== 'lobby' && room.phase !== 'gameover') {
    p.alive = false;
    room.outOrder.push({ id: p.id, name: p.prof.name });
  }
  if (!humans(room).length) return destroyRoom(room);
  if (room.hostId === p.id) passHost(room);
  pushState(room); pushLobby();
  if (room.phase === 'lobby' || room.phase === 'gameover') return;
  if (alivePlayers(room).length <= 1 && room.phase !== 'results') return endGame(room);
  checkScrambleDone(room);
}
function attach(conn, room, p) { // (re)connect a socket to its seat in a room
  clearTimeout(p.awayTimer); p.awayTimer = null;
  p.conn = conn; conn.room = room;
  if (room.ownerId === conn.pid) room.hostId = conn.pid; // the original host always gets control back
  conn.send({ t: 'joined', code: room.code });
  conn.send(roomState(room));
  pushState(room); pushLobby();
}
function joinRoom(conn, room) {
  if (conn.room && conn.room !== room) removePlayer(conn.room, conn.room.players.get(conn.pid));
  const p = { id: conn.pid, conn: null, prof: conn.prof, inGame: false, alive: false, seat: null, pick: null, seats: 0, lockUntil: 0, awayTimer: null };
  room.players.set(conn.pid, p);
  attach(conn, room, p);
}
const hostOf = (conn) => (conn.room && conn.room.hostId === conn.pid ? conn.room : null);

// ───────────────────────────── message handling ─────────────────────────────
const handlers = {
  createRoom(conn, m) {
    if (rooms.size >= MAX_ROOMS) return conn.send({ t: 'toast', msg: 'The studio is full — try again later.' });
    const pw = String(m.password || '').slice(0, 64);
    const room = {
      code: newRoomCode(), name: cleanText(m.name, 28) || `${conn.prof.name}'s show`,
      vis: m.vis === 'private' ? 'private' : 'public', pw: null,
      max: Math.min(12, Math.max(2, m.max | 0 || 8)), players: new Map(), hostId: conn.pid, ownerId: conn.pid,
      phase: 'lobby', round: 0, chairs: [], currentSong: null, lastSong: null, settings: defaultSettings(),
      lastOut: [], outOrder: [], nobody: false, winner: null, standings: null, phaseEnds: 0, musicStart: 0,
      banned: new Set(), usedQ: new Set(), chairTimers: [],
    };
    if (pw) { const salt = crypto.randomBytes(16); room.pw = { salt, hash: hashPw(pw, salt) }; }
    rooms.set(room.code, room);
    joinRoom(conn, room);
  },
  peek(conn, m) { // invite-link landing page: show the room before joining
    const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const room = rooms.get(code);
    if (!room) return conn.send({ t: 'peek', code, found: false });
    conn.send({
      t: 'peek', code, found: true, name: room.name, players: room.players.size, max: room.max,
      locked: !!room.pw && conn.pid !== room.ownerId, playing: room.phase !== 'lobby',
      host: room.players.get(room.hostId)?.prof.name || '', member: room.players.has(conn.pid),
    });
  },
  joinRoom(conn, m) {
    const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const room = rooms.get(code);
    if (!room) return conn.send({ t: 'joinfail', reason: 'notfound', code });
    if (conn.room === room) return conn.send(roomState(room));
    const existing = room.players.get(conn.pid);
    if (existing && !existing.bot) { // coming back after a dropped connection
      if (conn.room) removePlayer(conn.room, conn.room.players.get(conn.pid));
      return attach(conn, room, existing);
    }
    if (room.banned.has(conn.pid)) return conn.send({ t: 'joinfail', reason: 'kicked', code });
    if (room.players.size >= room.max) return conn.send({ t: 'joinfail', reason: 'full', code });
    if (room.pw && conn.pid !== room.ownerId) {
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
  songs(conn) { songCache.at = 0; conn.send({ t: 'music', ...musicInfo() }); },

  // ── host controls ──
  settings(conn, m) { const room = hostOf(conn); if (room) { applySettings(room, m); pushState(room); } },
  addBot(conn) { const room = hostOf(conn); if (room) addBot(room); },
  removeBot(conn) {
    const room = hostOf(conn); if (!room || room.phase !== 'lobby') return;
    const bots = [...room.players.values()].filter((p) => p.bot);
    if (bots.length) removePlayer(room, bots[bots.length - 1]);
  },
  kick(conn, m) {
    const room = hostOf(conn); if (!room) return;
    const id = String(m.id || '');
    const p = room.players.get(id);
    if (!p || id === conn.pid || id === room.ownerId) return;
    if (!p.bot) room.banned.add(id);
    if (p.conn) p.conn.send({ t: 'kicked' });
    removePlayer(room, p);
  },
  start(conn) { const room = hostOf(conn); if (room) startGame(room); },
  nextRound(conn) { const room = hostOf(conn); if (room && room.phase === 'ready') beginRound(room); },
  skipMusic(conn) { const room = hostOf(conn); if (room && room.phase === 'music') { clearTimeout(room.timer); startScramble(room); } },
  endShow(conn) { const room = hostOf(conn); if (room && room.phase !== 'lobby') resetToLobby(room); },

  // ── playing ──
  pick(conn, m) {
    const room = conn.room; if (!room || room.phase !== 'scramble') return;
    const p = room.players.get(conn.pid); const i = m.chair | 0;
    if (!p || !p.alive || p.seat != null || !room.chairs[i] || room.chairs[i].owner || p.pick === i) return;
    p.pick = i; pushState(room);
  },
  answer(conn, m) {
    const room = conn.room; if (!room || room.phase !== 'scramble') return;
    const p = room.players.get(conn.pid); const i = m.chair | 0; const chair = room.chairs[i];
    if (!p || !p.alive || p.seat != null || !chair || chair.owner || chair.kind !== 'answer') return;
    if (Date.now() < p.lockUntil) return;
    if (normAnswer(m.a) === chair.answer) return void claimChair(room, p, i);
    wrongAnswer(room, p, i);
  },
  tap(conn, m) { // reaction + button-mash games
    const room = conn.room; if (!room || room.phase !== 'scramble') return;
    const p = room.players.get(conn.pid); const i = m.chair | 0; const chair = room.chairs[i];
    if (!p || !p.alive || p.seat != null || !chair || chair.owner) return;
    const now = Date.now();
    if (now < p.lockUntil) return;
    if (chair.kind === 'reaction') {
      if (now < chair.goAt) return wrongAnswer(room, p, i); // false start
      return void claimChair(room, p, i);
    }
    if (chair.kind === 'mash') {
      let t = chair.taps.get(p.id);
      if (!t) chair.taps.set(p.id, (t = { n: 0, last: 0 }));
      if (now - t.last < MASH_GAP) return;
      t.last = now;
      if (++t.n >= chair.need) claimChair(room, p, i);
    }
  },
};

function onMessage(conn, text) {
  let m;
  try { m = JSON.parse(text); } catch { return; }
  if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
  const now = Date.now();
  if (now - conn.rateAt > 1000) { conn.rateAt = now; conn.rateN = 0; }
  if (++conn.rateN > 60) return conn.close();

  if (!conn.pid) {
    if (m.t !== 'hello') return;
    const token = String(m.token || '');
    if (!/^[a-f0-9]{32,64}$/.test(token)) return conn.close();
    const pid = sha('pid:' + token).slice(0, 12);
    const old = byPid.get(pid);
    if (old) { // same player opened a new connection (refresh, network change, other tab): the newest wins
      byPid.delete(pid);
      old.send({ t: 'replaced' });
      old.end();
    }
    const key = sha('profile:' + token);
    let prof = profiles[key];
    if (!prof) prof = profiles[key] = { name: cleanText(m.name, 16) || 'Contestant ' + (1000 + rnd(9000)), xp: 0, dance: 'strut', death: 'poof', ring: 'none' };
    prof.seen = now; saveProfiles();
    conn.pid = pid; conn.prof = prof;
    byPid.set(pid, conn);
    const av = avatars.get(pid);
    if (av) clearTimeout(av.timer); // reconnected inside the grace period
    conn.send({ t: 'welcome', me: meInfo(conn), catalog: CATALOG, groups: GROUPS, music: musicInfo() });
    conn.send(lobbyList());
    if (old && old.room && !old.room.dead) {
      const p = old.room.players.get(pid);
      if (p) attach(conn, old.room, p);
    }
    return;
  }
  if (m.t === 'hello' || !Object.prototype.hasOwnProperty.call(handlers, m.t)) return;
  handlers[m.t](conn, m);
}
function onClose(conn) {
  conns.delete(conn);
  if (!conn.pid || byPid.get(conn.pid) !== conn) return; // replaced by a newer connection
  byPid.delete(conn.pid);
  const room = conn.room;
  const p = room && room.players.get(conn.pid);
  if (p && p.conn === conn) { // keep their spot for a while in case they come back
    p.conn = null;
    clearTimeout(p.awayTimer);
    p.awayTimer = setTimeout(() => { if (!p.conn && room.players.get(p.id) === p && !room.dead) removePlayer(room, p); }, RECONNECT_GRACE_MS);
    if (room.hostId === p.id) passHost(room);
    pushState(room);
  }
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
  end() { if (!this.open) return; this.open = false; this.socket.end(); setTimeout(() => this.socket.destroy(), 200); onClose(this); }
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
}, 20000).unref();

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
      const now = tokenConn(req);
      if (!now) return sendJson(res, 401, { error: 'not connected' });
      const old = avatars.get(now.pid);
      if (old) clearTimeout(old.timer);
      const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
      avatars.set(now.pid, { buf, type, hash, timer: null });
      avatarChanged(now);
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
  const m = musicInfo();
  console.log(`SIT SHOW is on air → http://localhost:${PORT}`);
  console.log(`Music directory: ${MUSIC_DIR} (${m.songs.length} MP3s in ${m.cats.length} categories)`);
});
