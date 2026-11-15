// Team shows and spectators against a running server: BASE=localhost:3000 node test/teams.js
// Covers: spectating from the lobby list, spectators never playing but voting in the final, creating /
// joining / renaming teams, only the leader switching chairs, a teammate's solve seating the whole team,
// teams being knocked out (and winning) together, and switching between playing and watching.
const BASE = process.env.BASE || 'localhost:3000';
const crypto = require('crypto');
const assert = require('assert');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(label) {
  const token = crypto.randomBytes(16).toString('hex'), ws = new WebSocket(`ws://${BASE}/ws`);
  const c = { label, ws, room: null, me: null, events: [], waiters: [] };
  c.send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  c.wait = (pred, ms = 60000) => new Promise((res, rej) => {
    const hit = c.events.find(pred); if (hit) return res(hit);
    c.waiters.push({ pred, res });
    setTimeout(() => rej(new Error(label + ' timed out waiting for ' + pred)), ms);
  });
  c.next = (pred, ms) => { c.events.length = 0; return c.wait(pred, ms); };
  ws.onopen = () => c.send({ t: 'hello', token, name: label });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data); c.events.push(m); if (c.events.length > 400) c.events.shift();
    if (m.t === 'welcome' || m.t === 'me' || m.t === 'xp') c.me = m.me;
    if (m.t === 'room') { c.room = m; c.onRoom && c.onRoom(m); }
    c.waiters = c.waiters.filter((w) => { if (w.pred(m)) { w.res(m); return false; } return true; });
  };
  return c;
}
function solve(pz) { // brain teasers only
  const p = pz.prompt || '';
  if (pz.kind === 'dice') return String(pz.dice.reduce((a, b) => a + b));
  if (pz.title.startsWith('Roman')) { const v = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }; let n = 0; for (let i = 0; i < p.length; i++) n += v[p[i]] < (v[p[i + 1]] || 0) ? -v[p[i]] : v[p[i]]; return String(n); }
  if (pz.title === 'Quick maths!') return String(eval(p.replace(' = ?', '').replace(/×/g, '*').replace(/−/g, '-')));
  if (pz.title === 'Which one is a prime number?') return pz.choices.find((c) => { for (let d = 2; d * d <= +c; d++) if (+c % d === 0) return false; return true; });
  if (pz.title.startsWith('Which is the BIGGEST')) return pz.choices.map((c) => [c, eval(c.replace('×', '*'))]).sort((a, b) => b[1] - a[1])[0][0];
  if (pz.title.startsWith('How many')) { const e = pz.title.replace('How many ', '').replace(' ?', ''); return String(p.split(' ').filter((x) => x === e).length); }
  return null;
}

(async () => {
  const H = client('Hana'), B = client('Ben'), C = client('Cleo'), V = client('Viv');
  for (const c of [H, B, C, V]) await c.wait((m) => m.t === 'welcome');

  // a public show; Viv spectates it from the lobby list
  H.send({ t: 'createRoom', name: 'Team Night', vis: 'public', max: 8 });
  const room = await H.wait((m) => m.t === 'room');
  const listed = await V.wait((m) => m.t === 'rooms' && m.rooms.some((r) => r.code === room.code));
  assert.ok(listed);
  V.send({ t: 'joinRoom', code: room.code, spectate: true }); await V.wait((m) => m.t === 'joined');
  B.send({ t: 'joinRoom', code: room.code }); await B.wait((m) => m.t === 'joined');
  C.send({ t: 'joinRoom', code: room.code }); await C.wait((m) => m.t === 'joined');
  let st = await H.wait((m) => m.t === 'room' && m.players.length === 4);
  assert.ok(st.players.find((p) => p.id === V.me.id).spec, 'Viv is a spectator');
  console.log('spectator joined from the lobby list ok');

  // spectators can't form teams; players can create, join and rename them
  H.send({ t: 'settings', teams: true, musicMin: 3, musicMax: 3, scramble: 15, puzzles: { brain: true, words: false, eyes: false, action: false, geo: false, sci: false, space: false, music: false, food: false, animals: false, sport: false, general: false } });
  V.send({ t: 'teamCreate', name: 'Watchers' });
  H.send({ t: 'teamCreate', name: 'Chair Force' });
  st = await H.wait((m) => m.t === 'room' && m.teams.length === 1);
  const team = st.teams[0];
  assert.equal(team.leader, H.me.id); assert.equal(team.name, 'Chair Force');
  B.send({ t: 'teamJoin', id: team.id });
  await H.wait((m) => m.t === 'room' && m.teams[0]?.members.length === 2);
  B.send({ t: 'teamRename', name: 'Not the leader' }); await sleep(200);
  H.send({ t: 'teamRename', name: 'Sit Happens' });
  st = await H.wait((m) => m.t === 'room' && m.teams[0]?.name === 'Sit Happens');
  assert.equal(st.teams.length, 1, 'spectator could not make a team');
  console.log('teams: create, join, leader-only rename ok');

  // switching between watching and playing (green room only)
  C.send({ t: 'spectate', on: true });
  await H.wait((m) => m.t === 'room' && m.players.find((p) => p.id === C.me.id)?.spec);
  C.send({ t: 'spectate', on: false }); await sleep(300);
  assert.ok(!H.room.players.find((p) => p.id === C.me.id)?.spec);
  console.log('play / just watch toggle ok');

  H.send({ t: 'addBot' }); await sleep(300);
  assert.equal(H.room.players.length, 5);

  // play. Hana (leader) picks; Ben (teammate) solves instantly; Hana only tries later, so Ben's solves seat both
  const log = { benClaims: 0, rejected: false, picksFollow: 0, rounds: 0 };
  const play = (c, role) => {
    c.onRoom = (m) => {
      if (m.phase !== 'scramble') { c.busy = null; return; }
      const me = m.players.find((p) => p.id === c.me.id);
      if (!me || !me.alive || me.seat != null) return;
      if (role === 'leader' || role === 'solo') {
        if (c.busy === m.round) return;
        const i = m.chairs.findIndex((ch) => !ch.owner && ch.puzzle && solve(ch.puzzle) != null); if (i < 0) return;
        c.busy = m.round;
        c.send({ t: 'pick', chair: i });
        setTimeout(() => { const ch = c.room.chairs[i]; if (ch && ch.puzzle) c.send({ t: 'answer', chair: i, a: solve(ch.puzzle) }); }, role === 'leader' ? 3500 : 1500 + Math.random() * 1500);
      } else { // teammate: follows the leader's chair
        if (me.pick == null) return;
        if (!c.triedPick) { c.triedPick = true; c.send({ t: 'pick', chair: me.pick === 0 ? 1 : 0 }); }
        if (me.pick == null || c.busy === m.round + ':' + me.pick) return;
        c.busy = m.round + ':' + me.pick; log.picksFollow++;
        const pz = m.chairs[me.pick]?.puzzle; if (pz) setTimeout(() => c.send({ t: 'answer', chair: me.pick, a: solve(pz) }), 300);
      }
    };
  };
  play(H, 'leader'); play(B, 'member'); play(C, 'solo');
  B.events.length = 0;
  H.send({ t: 'start' });
  const started = await H.wait((m) => m.t === 'room' && m.phase === 'intro');
  assert.ok(started.teamShow, 'team show on');
  assert.ok(!started.players.find((p) => p.id === V.me.id).inGame, 'spectator is not playing');
  await B.wait((m) => m.t === 'toast' && /team leader/.test(m.msg), 60000);
  log.rejected = true;
  const claim = await H.wait((m) => m.t === 'claim' && m.ids && m.ids.includes(H.me.id), 60000);
  assert.ok(claim.ids.includes(B.me.id), 'whole team seated'); assert.equal(claim.id, H.me.id, 'chair is owned by the leader');
  console.log(`team claim ok (solved by ${claim.by === B.me.id ? 'Ben for both' : 'Hana'})`);

  // vote (if anyone's watching when 2 units are left — Viv always is)
  V.onRoom = (m) => { if (m.phase === 'vote' && !V.voted) { V.voted = true; V.send({ t: 'vote', id: m.vote.candidates[0] }); } };
  const over = await H.wait((m) => m.t === 'room' && m.phase === 'gameover', 300000);
  const hp = over.players.find((p) => p.id === H.me.id), bp = over.players.find((p) => p.id === B.me.id);
  assert.equal(hp.alive, bp.alive, 'teammates share their fate');
  console.log('winner:', over.winnerName, '| standings:', over.standings.map((s) => s.name).join(' > '));
  assert.ok(over.standings.every((s) => s.name !== 'Hana' && s.name !== 'Ben'), 'the team is listed under its name');
  if (over.winnerName === 'Sit Happens') assert.equal(over.winner, H.me.id);
  assert.ok(over.voteResult && over.voteResult.voters >= 1, 'spectator voted in the final');
  const xpH = await H.wait((m) => m.t === 'xp'), xpB = await B.wait((m) => m.t === 'xp');
  console.log(`spectator vote ok (${over.voteResult.correct.some((c) => c.id === V.me.id) ? 'called it' : 'wrong guess'}) | team XP: Hana +${xpH.gained}, Ben +${xpB.gained}`);
  assert.ok(Math.abs(xpH.gained - xpB.gained) <= 30, 'teammates earn the same (apart from prediction bonus)');
  assert.ok(log.rejected && log.picksFollow > 0);

  // when every player leaves, spectators are sent back to the lobby
  for (const c of [H, B, C]) c.send({ t: 'leaveRoom' });
  await V.wait((m) => m.t === 'left', 5000);
  console.log('spectators sent home when the players leave ok');
  console.log('ALL OK');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
