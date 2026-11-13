// Scripted playthrough: 2 humans + 2 bots, password room, avatar lifecycle.
const BASE = process.env.BASE || 'localhost:3111';
const crypto = require('crypto');
const assert = require('assert');
function client(label) {
  const token = crypto.randomBytes(16).toString('hex');
  const ws = new WebSocket(`ws://${BASE}/ws`);
  const c = { label, token, ws, room: null, me: null, log: [], events: [], waiters: [] };
  c.send = (o) => ws.send(JSON.stringify(o));
  c.wait = (pred, ms = 60000) => new Promise((res, rej) => {
    const hit = c.events.find(pred); if (hit) return res(hit);
    const w = { pred, res }; c.waiters.push(w);
    setTimeout(() => rej(new Error(label + ' timeout waiting')), ms);
  });
  ws.onopen = () => c.send({ t: 'hello', token, name: label });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data); c.events.push(m);
    if (m.t === 'welcome' || m.t === 'me' || m.t === 'xp') c.me = m.me;
    if (m.t === 'room') { c.room = m; c.onRoom && c.onRoom(m); }
    c.waiters = c.waiters.filter((w) => { if (w.pred(m)) { w.res(m); return false; } return true; });
  };
  return c;
}
function solve(pz) { // the test knows how to solve every puzzle type from its public data
  const p = pz.prompt;
  if (pz.title === 'Quick maths!') return String(eval(p.replace(' = ?', '').replace(/×/g, '*').replace(/−/g, '-')));
  if (pz.title === 'What comes next?') {
    const s = p.replace(', ?', '').split(', ').map(Number);
    if (s[1] - s[0] === s[2] - s[1] && s[2] - s[1] === s[3] - s[2]) return String(s[3] + s[1] - s[0]);
    if (s[1] / s[0] === s[2] / s[1] && s[2] / s[1] === s[3] / s[2]) return String(s[3] * s[1] / s[0]);
    if (s[2] === s[0] + s[1] && s[3] === s[1] + s[2]) return String(s[2] + s[3]);
    const r = Math.sqrt(s[3]); return String((r + 1) ** 2);
  }
  if (pz.title === 'Type it backwards!') return [...p.toLowerCase()].reverse().join('');
  if (pz.title.startsWith('How many')) { const e = pz.title.replace('How many ', '').replace(' ?', ''); return String(p.split(' ').filter((x) => x === e).length); }
  if (pz.title.startsWith('Which is the BIGGEST')) return pz.choices.map((c) => [c, eval(c.replace('×', '*'))]).sort((a, b) => b[1] - a[1])[0][0];
  return null; // unscramble / stroop / odd-one-out: can't solve blind
}
(async () => {
  const A = client('Alice'), B = client('Bob');
  await A.wait((m) => m.t === 'welcome'); await B.wait((m) => m.t === 'welcome');
  assert.equal(A.me.level, 1);
  // avatar upload (tiny valid PNG header + padding), fetch, bad type rejected
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64)]);
  let r = await fetch(`http://${BASE}/api/avatar`, { method: 'POST', headers: { 'x-token': A.token }, body: png });
  assert.equal(r.status, 200); const { hash } = await r.json();
  r = await fetch(`http://${BASE}/avatar/${A.me.id}`); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png');
  r = await fetch(`http://${BASE}/api/avatar`, { method: 'POST', headers: { 'x-token': A.token }, body: 'hello not an image' }); assert.equal(r.status, 415);
  r = await fetch(`http://${BASE}/api/avatar`, { method: 'POST', headers: { 'x-token': 'ab'.repeat(16) }, body: png }); assert.equal(r.status, 401);
  r = await fetch(`http://${BASE}/api/avatar`, { method: 'POST', headers: { 'x-token': A.token }, body: Buffer.concat([png, Buffer.alloc(300 * 1024)]) }).catch(() => ({ status: 413 })); assert.equal(r.status, 413);
  console.log('avatar ok', hash);

  A.send({ t: 'createRoom', name: 'Test <b>Show</b>', vis: 'private', password: 'hunter2', max: 4 });
  const room = await A.wait((m) => m.t === 'room');
  assert.equal(room.locked, true); assert.equal(room.name, 'Test bShow/b');
  assert.ok(!B.events.find((m) => m.t === 'rooms' && m.rooms.length), 'private room must not be listed');
  B.send({ t: 'joinRoom', code: room.code }); assert.equal((await B.wait((m) => m.t === 'joinfail')).reason, 'password');
  B.events.length = 0;
  B.send({ t: 'joinRoom', code: room.code, password: 'nope' }); assert.equal((await B.wait((m) => m.t === 'joinfail')).reason, 'badpw');
  B.send({ t: 'joinRoom', code: room.code.toLowerCase(), password: 'hunter2' }); await B.wait((m) => m.t === 'joined');
  B.send({ t: 'setName', name: '  Bobby   Tables  ' });
  await A.wait((m) => m.t === 'room' && m.players.some((p) => p.name === 'Bobby Tables'));
  assert.ok(A.room.players.find((p) => p.id === A.me.id).av === hash);
  // permissions
  B.send({ t: 'start' }); B.send({ t: 'addBot' }); B.send({ t: 'equip', dance: 'floss' }); B.send({ t: 'emote', id: 'goat' });
  A.send({ t: 'emote', id: 'wave' }); await B.wait((m) => m.t === 'emote' && m.e === '👋');
  A.send({ t: 'addBot' }); A.send({ t: 'addBot' }); A.send({ t: 'addBot' });
  A.send({ t: 'setSong', song: 'short.mp3' });
  await A.wait((m) => m.t === 'room' && m.players.length === 4 && m.song === 'short.mp3');
  assert.equal(A.room.phase, 'lobby'); assert.equal(B.me.dance, 'strut'); assert.ok(!A.events.find((m) => m.t === 'emote' && m.e === '🐐'));
  console.log('room/permissions ok');

  const stats = { rounds: 0, music: [], solved: 0 };
  let musicAt = 0;
  for (const c of [A, B]) c.onRoom = (m) => {
    if (c === A && m.phase === 'music' && !musicAt) { musicAt = Date.now(); assert.equal(m.current, 'short.mp3'); assert.equal(m.remain, 0); assert.ok(m.chairs.every((x) => !x.puzzle)); }
    if (c === A && m.phase === 'scramble' && musicAt) { stats.music.push(Date.now() - musicAt); musicAt = 0; stats.rounds++; }
    if (m.phase !== 'scramble') { c.tried = null; return; }
    const me = m.players.find((p) => p.id === c.me.id);
    if (!me.alive || me.seat != null || c.tried === m.round) return;
    c.tried = m.round;
    const i = m.chairs.findIndex((ch) => !ch.owner && ch.puzzle && solve(ch.puzzle) != null);
    if (i < 0) return;
    setTimeout(() => { c.send({ t: 'answer', chair: i, a: 'definitely wrong' }); }, 100);            // lockout check
    setTimeout(() => { c.send({ t: 'answer', chair: i, a: solve(m.chairs[i].puzzle) }); }, 400);      // ignored: locked
    setTimeout(() => { c.send({ t: 'answer', chair: i, a: solve(m.chairs[i].puzzle).toUpperCase() + ' ' }); stats.solved++; }, 2200);
  };
  A.send({ t: 'start' });
  const over = await A.wait((m) => m.t === 'room' && m.phase === 'gameover', 240000);
  console.log('game over. winner:', over.standings[0].name, '| standings:', over.standings.map((s) => s.name).join(' > '));
  console.log('rounds:', stats.rounds, 'music secs:', stats.music.map((x) => (x / 1000).toFixed(1)).join(', '));
  assert.ok(stats.music.every((x) => x >= 6900 && x <= 30300), 'music 7-30s');
  assert.equal(over.standings.length, 4);
  const xpA = await A.wait((m) => m.t === 'xp'); console.log('Alice xp', xpA.gained, 'level', xpA.me.level, xpA.unlocked.map((u) => u.name).join(','));
  assert.ok(A.events.some((m) => m.t === 'wrong'), 'wrong answer locks');
  await A.wait((m) => m.t === 'room' && m.phase === 'lobby', 20000);
  // host migration + cleanup
  A.ws.close();
  await B.wait((m) => m.t === 'room' && m.hostId === B.me.id);
  r = await fetch(`http://${BASE}/avatar/${A.me.id}`); assert.equal(r.status, 200, 'avatar kept during grace period');
  B.ws.close(); await new Promise((r) => setTimeout(r, 300));
  const h = await (await fetch(`http://${BASE}/api/health`)).json(); assert.equal(h.rooms, 0); assert.equal(h.players, 0);
  console.log('ALL OK');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
