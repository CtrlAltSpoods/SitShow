// Scripted playthrough against a running server: BASE=localhost:3000 node test/play.js
// (optional RECONNECT_GRACE_MS=<same as server> also checks that abandoned rooms close)
// Covers rooms, passwords, host settings, music categories, manual rounds, every challenge type
// the bot can solve, host hand-back after a dropped connection, kicking, and the avatar API.
const BASE = process.env.BASE || 'localhost:3000';
const crypto = require('crypto');
const assert = require('assert');
const { TRIVIA } = require('../puzzles');
const INK = { '#ff4d5e': 'RED', '#4d8dff': 'BLUE', '#3ddc84': 'GREEN', '#ffd93d': 'YELLOW', '#ff7ad9': 'PINK', '#ff9a3d': 'ORANGE' };
const TRIV = new Map(Object.values(TRIVIA).flat().map((q) => [q[0], typeof q[1] === 'boolean' ? (q[1] ? 'True' : 'False') : q[1]]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(label, token = crypto.randomBytes(16).toString('hex')) {
  const ws = new WebSocket(`ws://${BASE}/ws`);
  const c = { label, token, ws, room: null, me: null, events: [], waiters: [] };
  c.send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  c.wait = (pred, ms = 60000) => new Promise((res, rej) => {
    const hit = c.events.find(pred); if (hit) return res(hit);
    const w = { pred, res }; c.waiters.push(w);
    setTimeout(() => rej(new Error(label + ' timed out waiting for ' + pred)), ms);
  });
  c.fresh = () => { c.events.length = 0; };
  ws.onopen = () => c.send({ t: 'hello', token, name: label });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data); c.events.push(m);
    if (m.t === 'welcome' || m.t === 'me' || m.t === 'xp') c.me = m.me;
    if (m.t === 'room') { c.room = m; c.onRoom && c.onRoom(m); }
    c.waiters = c.waiters.filter((w) => { if (w.pred(m)) { w.res(m); return false; } return true; });
  };
  return c;
}
function solve(pz) { // answers for every challenge that can be worked out from public data
  const p = pz.prompt || '';
  if (pz.kind === 'grid') { const cnt = {}; pz.colors.forEach((c) => (cnt[c] = (cnt[c] || 0) + 1)); return String(pz.colors.findIndex((c) => cnt[c] === 1)); }
  if (pz.kind === 'order') { const o = []; for (let k = 1; k <= pz.nums.length; k++) o.push(pz.nums.indexOf(k)); return o.join(','); }
  if (pz.kind === 'memory') return pz.seq.join(',');
  if (pz.title === 'Quick maths!') return String(eval(p.replace(' = ?', '').replace(/×/g, '*').replace(/−/g, '-')));
  if (pz.title === 'What comes next?') {
    const s = p.replace(', ?', '').split(', ').map(Number);
    if (s[1] - s[0] === s[2] - s[1] && s[2] - s[1] === s[3] - s[2]) return String(s[3] + s[1] - s[0]);
    if (s[1] / s[0] === s[2] / s[1] && s[2] / s[1] === s[3] / s[2]) return String(s[3] * s[1] / s[0]);
    if (s[2] === s[0] + s[1] && s[3] === s[1] + s[2]) return String(s[2] + s[3]);
    return String((Math.sqrt(s[3]) + 1) ** 2);
  }
  if (pz.title === 'Type it backwards!') return [...p.toLowerCase()].reverse().join('');
  if (pz.title.startsWith('Type this')) return p.toLowerCase();
  if (pz.title.startsWith('How many')) { const e = pz.title.replace('How many ', '').replace(' ?', ''); return String(p.split(' ').filter((x) => x === e).length); }
  if (pz.title.startsWith('Which is the BIGGEST')) return pz.choices.map((c) => [c, eval(c.replace('×', '*'))]).sort((a, b) => b[1] - a[1])[0][0];
  if (pz.ink) return INK[pz.ink];
  if (pz.cat && pz.cat.startsWith('Trivia')) return TRIV.get(pz.tf ? p : pz.title);
  return null;
}
function autoplay(c, stats) {
  c.onRoom = (m) => {
    if (m.phase !== 'scramble') { c.busy = null; return; }
    const me = m.players.find((p) => p.id === c.me.id);
    if (!me || !me.alive || me.seat != null) return;
    const free = m.chairs.map((ch, i) => [ch, i]).filter(([ch]) => !ch.owner && ch.puzzle);
    const tapGame = free.find(([ch]) => ch.puzzle.kind === 'reaction' || ch.puzzle.kind === 'mash');
    const pickOne = tapGame || free.find(([ch]) => solve(ch.puzzle) != null);
    if (!pickOne) return;
    const [ch, i] = pickOne, pz = ch.puzzle, key = m.round + ':' + i + ':' + (pz.go ? 'go' : '');
    if (c.busy === key) return;
    c.busy = key;
    c.send({ t: 'pick', chair: i });
    stats.kinds.add(pz.kind + (pz.cat ? ':' + pz.cat.split(' · ')[0] : ''));
    if (pz.kind === 'reaction') {
      if (!pz.go) { if (!stats.falseStart) { stats.falseStart = true; c.send({ t: 'tap', chair: i }); } return; }
      setTimeout(() => c.send({ t: 'tap', chair: i }), 2100);
    } else if (pz.kind === 'mash') {
      let n = 0; const iv = setInterval(() => { if (++n > pz.need + 5 || c.room.phase !== 'scramble') clearInterval(iv); c.send({ t: 'tap', chair: i }); }, 65);
    } else {
      if (!stats.wrongTried) { stats.wrongTried = true; c.send({ t: 'answer', chair: i, a: 'definitely wrong' }); }
      setTimeout(() => c.send({ t: 'answer', chair: i, a: solve(pz) }), 2200);
    }
  };
}

(async () => {
  const A = client('Alice'), B = client('Bob');
  const wa = await A.wait((m) => m.t === 'welcome'); await B.wait((m) => m.t === 'welcome');
  console.log('music categories:', wa.music.cats.map((c) => `${c.name || '(root)'}=${c.n}`).join(', '), '| stream safe:', wa.music.streamSafe.length);
  assert.ok(wa.groups.length >= 10);

  // avatar API
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64)]);
  let r = await fetch(`http://${BASE}/api/avatar`, { method: 'POST', headers: { 'x-token': A.token }, body: png });
  assert.equal(r.status, 200);
  r = await fetch(`http://${BASE}/api/avatar`, { method: 'POST', headers: { 'x-token': A.token }, body: 'not an image' }); assert.equal(r.status, 415);

  // password room + invite peek
  A.send({ t: 'createRoom', name: 'Test Show', vis: 'private', password: 'hunter2', max: 6 });
  const room = await A.wait((m) => m.t === 'room');
  B.send({ t: 'peek', code: room.code });
  const peek = await B.wait((m) => m.t === 'peek');
  assert.ok(peek.found && peek.locked && !peek.member && peek.host === 'Alice');
  B.send({ t: 'joinRoom', code: room.code, password: 'nope' }); assert.equal((await B.wait((m) => m.t === 'joinfail')).reason, 'badpw');
  B.send({ t: 'joinRoom', code: room.code, password: 'hunter2' }); await B.wait((m) => m.t === 'joined');
  console.log('password + invite peek ok');

  // settings: host only, validated
  B.send({ t: 'settings', manual: true });
  A.send({ t: 'settings', category: 'Dubstep', musicMin: 1, musicMax: 4, speed: true, manual: true, scramble: 12,
    puzzles: { words: false, geo: false, sci: false, space: false, music: false, food: false, sport: false, animals: false } });
  const st = (await A.wait((m) => m.t === 'room' && m.settings.category === 'Dubstep')).settings;
  assert.deepEqual([st.musicMin, st.musicMax, st.speed, st.manual, st.scramble], [3, 4, true, true, 12]);
  A.send({ t: 'settings', category: 'Nope' }); A.send({ t: 'settings', song: 'short.mp3' }); // not in Dubstep → ignored
  await sleep(200); assert.equal(A.room.settings.category, 'Dubstep'); assert.equal(A.room.settings.song, 'random');
  console.log('settings ok');

  // host drops and comes back → control returns to the original host
  A.ws.close();
  await B.wait((m) => m.t === 'room' && m.hostId === B.me.id && m.players.find((p) => p.id === A.me.id)?.away);
  const A2 = client('Alice', A.token);
  await A2.wait((m) => m.t === 'welcome');
  A2.send({ t: 'peek', code: room.code }); assert.ok((await A2.wait((m) => m.t === 'peek')).member);
  A2.send({ t: 'joinRoom', code: room.code });
  await B.wait((m) => m.t === 'room' && m.hostId === A2.me.id && !m.players.find((p) => p.id === A2.me.id).away);
  console.log('host hand-back after reconnect ok');

  // same player opening a second connection takes over the seat
  const A3 = client('Alice', A.token);
  await A2.wait((m) => m.t === 'replaced');
  await A3.wait((m) => m.t === 'room' && m.code === room.code);
  console.log('takeover by newest connection ok');
  const H = A3;

  H.send({ t: 'addBot' }); H.send({ t: 'addBot' });
  await H.wait((m) => m.t === 'room' && m.players.length === 4);

  const stats = { kinds: new Set(), music: [], readies: 0 };
  autoplay(H, stats); autoplay(B, stats);
  const hostWatch = H.onRoom;
  let musicAt = 0;
  H.onRoom = (m) => {
    hostWatch(m);
    if (m.phase === 'music' && !musicAt) { musicAt = Date.now(); assert.ok(m.current.startsWith('Dubstep/')); assert.ok(m.chairs.every((x) => !x.puzzle)); }
    if (m.phase === 'scramble' && musicAt) { stats.music.push(Date.now() - musicAt); musicAt = 0; }
    if (m.phase === 'ready' && stats.lastReady !== m.round) { stats.lastReady = m.round; stats.readies++; setTimeout(() => H.send({ t: 'nextRound' }), 600); }
  };
  H.send({ t: 'start' });
  const over = await H.wait((m) => m.t === 'room' && m.phase === 'gameover', 300000);
  console.log('winner:', over.standings[0].name, '| order:', over.standings.map((s) => s.name).join(' > '));
  console.log('music seconds:', stats.music.map((x) => (x / 1000).toFixed(1)).join(', '), '| manual pauses:', stats.readies);
  console.log('challenges played:', [...stats.kinds].join(', '));
  assert.ok(stats.music.every((x) => x >= 2900 && x <= 4300), 'music within host range');
  assert.ok(stats.readies >= 1, 'manual mode paused between rounds');
  assert.ok(H.events.some((m) => m.t === 'wrong') || B.events.some((m) => m.t === 'wrong'), 'wrong answers lock');
  await H.wait((m) => m.t === 'room' && m.phase === 'lobby', 20000);

  // leaderboards, player card and achievements are keyed by player ID
  H.send({ t: 'leaderboard' });
  const lb = await H.wait((m) => m.t === 'leaderboard');
  const mine = lb.daily.find((r) => r.id === H.me.id);
  assert.ok(mine && mine.points > 0 && mine.games >= 1, 'host is on today\'s board');
  assert.ok(lb.levels.some((r) => r.id === H.me.id), 'host is on the level board');
  assert.ok(H.events.some((m) => m.t === 'achievements' && m.ids.includes('first_show')), 'Opening Night unlocked');
  H.send({ t: 'setName', name: 'Alice Renamed' });
  await H.wait((m) => m.t === 'me' && m.me.name === 'Alice Renamed');
  H.send({ t: 'leaderboard' });
  const lb2 = await H.wait((m) => m.t === 'leaderboard' && m.daily.some((r) => r.id === H.me.id && r.name === 'Alice Renamed'));
  B.send({ t: 'card', id: H.me.id });
  const card = await B.wait((m) => m.t === 'card' && m.id === H.me.id);
  assert.equal(card.name, 'Alice Renamed'); assert.ok(card.stats.games >= 1 && card.stats.hosted >= 1 && card.achievements.length >= 1);
  console.log('leaderboards + card ok:', `today #${lb2.me.dayRank} (${lb2.me.dayPoints} pts),`, 'achievements:', card.achievements.map((a) => a.ach_id).join(', '));

  // skip music + end show
  H.send({ t: 'settings', manual: false, musicMin: 30, musicMax: 30 });
  H.send({ t: 'start' });
  await H.wait((m) => m.t === 'room' && m.phase === 'music', 10000);
  H.send({ t: 'skipMusic' });
  await H.wait((m) => m.t === 'room' && m.phase === 'scramble' && Date.now(), 3000);
  H.send({ t: 'endShow' });
  await H.wait((m) => m.t === 'room' && m.phase === 'lobby' && m.round === 0, 5000);
  console.log('skip music + end show ok');

  // kick
  B.fresh(); H.send({ t: 'kick', id: B.me.id });
  await B.wait((m) => m.t === 'kicked');
  B.send({ t: 'joinRoom', code: room.code, password: 'hunter2' });
  assert.equal((await B.wait((m) => m.t === 'joinfail')).reason, 'kicked');
  console.log('kick ok');

  H.ws.close(); B.ws.close();
  const grace = +process.env.RECONNECT_GRACE_MS || 0; // set it to match the server to check room clean-up
  if (grace) {
    await sleep(grace + 500);
    const h = await (await fetch(`http://${BASE}/api/health`)).json();
    assert.equal(h.rooms, 0, 'room cleaned up after reconnect grace');
  }
  console.log('ALL OK');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
