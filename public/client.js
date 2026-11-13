/* SIT SHOW — browser client */
(() => {
'use strict';

// ───────────────────────────── utilities ─────────────────────────────
const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => 1 - (1 - t) ** 3;
const sr = (seed, i) => { const x = Math.sin(seed * 127.1 + i * 311.7) * 43758.5453; return x - Math.floor(x); };
const strHash = (s) => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
const hueOf = (id) => strHash(id) % 360;
const songTitle = (f) => (f ? f.replace(/\.mp3$/i, '') : 'The House Band');
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) n.append(kid);
  return n;
}
function toast(msg, cls = '', ms = 3800) {
  const t = el('div', { class: 'toast ' + cls });
  if (typeof msg === 'string') t.textContent = msg; else t.append(msg);
  $('toasts').append(t);
  setTimeout(() => t.remove(), ms);
}
function newToken() {
  const a = new Uint8Array(16); crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ───────────────────────────── state ─────────────────────────────
const S = { me: null, catalog: null, songs: [], rooms: [], room: null, myPick: null, lockUntil: 0, pw: {}, pendingCode: null };
let token = null;
try { token = sessionStorage.getItem('sitshow.guest'); } catch {}
if (!token) { token = LS.get('sitshow.token'); if (!token) { token = newToken(); LS.set('sitshow.token', token); } }

const url = new URL(location.href);
let wantRoom = (url.searchParams.get('room') || '').toUpperCase() || null;
if (wantRoom && location.hash.startsWith('#k=')) {
  try { S.pw[wantRoom] = decodeURIComponent(location.hash.slice(3)); } catch {}
  history.replaceState(null, '', '/?room=' + wantRoom); // keep the password out of the address bar
}

// ───────────────────────────── network ─────────────────────────────
let ws = null, retry = 0, dupTries = 0, fastReconnect = false;
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => { retry = 0; send({ t: 'hello', token, name: LS.get('sitshow.name') || '' }); };
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (on[m.t]) on[m.t](m); };
  ws.onclose = () => {
    if (fastReconnect) { fastReconnect = false; return setTimeout(connect, 600); }
    $('reconnect').hidden = false;
    setTimeout(connect, Math.min(5000, 400 * 2 ** retry++));
  };
}
const on = {
  dup() { // this profile is already connected (another tab) — play as a guest in this tab
    if (++dupTries > 2) {
      token = newToken();
      try { sessionStorage.setItem('sitshow.guest', token); } catch {}
      toast('This profile is open in another tab, so this tab is playing as a separate guest.', '', 6000);
    }
    fastReconnect = true; ws.close();
  },
  welcome(m) {
    dupTries = 0;
    S.me = m.me; S.catalog = m.catalog; S.songs = m.songs;
    $('reconnect').hidden = true;
    renderMe(); syncAvatar();
    if (wantRoom) joinRoom(wantRoom); else showHome();
  },
  me(m) { S.me = m.me; renderMe(); },
  rooms(m) { S.rooms = m.rooms; renderRoomList(); },
  songs(m) { S.songs = m.songs; hostKey = ''; renderHost(); },
  toast(m) { toast(String(m.msg)); },
  joined(m) { wantRoom = m.code; closeModals(); history.replaceState(null, '', '/?room=' + m.code); },
  left() { leaveLocal(); },
  joinfail(m) {
    if (m.reason === 'password' || m.reason === 'badpw') {
      delete S.pw[m.code];
      S.pendingCode = m.code;
      $('pwTitle').textContent = m.name || 'This show is password protected';
      $('pwHint').textContent = m.reason === 'badpw' ? 'Wrong password — try again.' : 'Ask the host for the password.';
      $('pwInput').value = '';
      openModal('pwModal'); $('pwInput').focus();
      if (!S.room) showHome(true);
      return;
    }
    toast(m.reason === 'full' ? 'That studio is full.' : 'That show has ended or the code is wrong.');
    leaveLocal();
  },
  room(m) {
    const prev = S.room;
    m.at = performance.now();
    m.byId = new Map(m.players.map((p) => [p.id, p]));
    for (const p of m.players) p.hue = hueOf(p.id);
    S.room = m;
    showRoom();
    if (!prev || prev.code !== m.code || prev.phase !== m.phase || prev.round !== m.round) onPhase(m);
    onRoomUpdate(m);
  },
  emote(m) { const e = ents.get(m.id); if (e) { e.emotes.push({ e: m.e, at: performance.now() }); if (e.emotes.length > 4) e.emotes.shift(); } Snd.sfx('blip'); },
  miss(m) { const e = ents.get(m.id); if (e) e.missAt = performance.now(); },
  claim(m) {
    Snd.sfx(m.id === S.me.id ? 'win' : 'ding');
    const e = ents.get(m.id); if (e) e.claimAt = performance.now();
  },
  wrong(m) {
    S.lockUntil = performance.now() + m.lock;
    Snd.sfx('buzz');
    const p = $('puzzle');
    p.classList.remove('shake', 'locked'); void p.offsetWidth; p.classList.add('shake', 'locked');
    const inp = p.querySelector('input'); if (inp) inp.value = '';
    setTimeout(() => { if (performance.now() >= S.lockUntil - 30) { p.classList.remove('locked', 'shake'); const i = p.querySelector('input'); if (i) i.focus(); } }, m.lock);
  },
  xp(m) {
    S.me = m.me; renderMe();
    const box = el('div');
    box.append(el('b', { text: `+${m.gained} XP` }));
    if (m.leveled) {
      box.append(document.createTextNode(` — LEVEL UP! You are now level ${m.me.level}.`));
      if (m.unlocked.length) box.append(el('div', { text: 'Unlocked: ' + m.unlocked.map((u) => u.name).join(', ') }));
      Snd.sfx('level');
    }
    toast(box, 'good', m.leveled ? 8000 : 4500);
  },
};
function joinRoom(code, pw) {
  code = String(code).toUpperCase();
  if (pw != null) S.pw[code] = pw;
  send({ t: 'joinRoom', code, password: S.pw[code] || '' });
}
function leaveLocal() {
  S.room = null; wantRoom = null; ents.clear(); Snd.stop();
  history.replaceState(null, '', '/');
  showHome();
}

// ───────────────────────────── screens ─────────────────────────────
function showHome() {
  if (S.room) return;
  $('home').hidden = false; $('room').hidden = true;
  document.title = 'Sit Show — Musical Chairs Royale';
}
function showRoom() {
  if (!$('room').hidden) return;
  $('home').hidden = true; $('room').hidden = false;
  hostKey = ''; pzKey = '';
  resize();
}
function openModal(id) { $(id).hidden = false; }
function closeModals() { for (const m of document.querySelectorAll('.modal')) m.hidden = true; preview.open = false; }
document.addEventListener('click', (e) => {
  if (e.target.matches('[data-close]') || e.target.classList.contains('modal')) closeModals();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

function setAvatarEl(node, p, localUrl) {
  node.style.setProperty('--hue', hueOf(p.id));
  const src = localUrl || (p.av ? `/avatar/${p.id}?v=${p.av}` : null);
  node.style.backgroundImage = src ? `url("${src}")` : '';
  node.textContent = src ? '' : (p.face || [...(p.name || '?')][0].toUpperCase());
}
function renderMe() {
  const me = S.me; if (!me) return;
  const local = LS.get('sitshow.avatar');
  setAvatarEl($('homeAvatar'), me, local); setAvatarEl($('sideAvatar'), me, local);
  $('avatarRemove').hidden = !local;
  if (document.activeElement !== $('homeName')) $('homeName').value = me.name;
  $('sideName').textContent = me.name;
  const pct = clamp((me.xp - me.levelXp) / (me.nextXp - me.levelXp), 0, 1) * 100;
  for (const pre of ['home', 'side']) { $(pre + 'Level').textContent = 'Lv ' + me.level; $(pre + 'XpFill').style.width = pct + '%'; }
  $('homeXpText').textContent = `${me.xp - me.levelXp} / ${me.nextXp - me.levelXp} XP`;
  renderEmoteBar();
  if (!$('wardrobeModal').hidden) renderWardrobe();
}
function renderRoomList() {
  const list = $('roomList'); list.textContent = '';
  if (!S.rooms.length) { list.append(el('div', { class: 'empty', text: 'No public shows right now. Be the first to go live!' })); return; }
  for (const r of S.rooms) {
    list.append(el('div', { class: 'room-item' },
      el('div', { class: 'ri-main' },
        el('strong', { text: (r.locked ? '🔒 ' : '') + r.name }),
        el('small', { text: `Host: ${r.host} · ${r.players}/${r.max} · ${r.playing ? 'show in progress' : 'in the green room'}` })),
      el('button', { class: 'btn small gold', text: r.players >= r.max ? 'Full' : 'Join', disabled: r.players >= r.max, onclick: () => joinRoom(r.code) })));
  }
}

// home form wiring
$('homeName').addEventListener('change', () => { const v = $('homeName').value.trim(); if (v) { LS.set('sitshow.name', v); send({ t: 'setName', name: v }); } });
$('createForm').addEventListener('submit', (e) => {
  e.preventDefault(); Snd.unlock();
  const pw = $('createPw').value;
  send({ t: 'createRoom', name: $('createName').value, vis: new FormData(e.target).get('vis'), password: pw, max: +$('createMax').value });
  S.createPw = pw;
});
for (const r of document.querySelectorAll('input[name=vis]')) r.addEventListener('change', () => {
  $('visHint').textContent = r.value === 'private' && r.checked ? 'Private shows are unlisted — only people with the invite link or code can join.' : 'Public shows are listed for everyone.';
});
$('codeForm').addEventListener('submit', (e) => { e.preventDefault(); Snd.unlock(); const c = $('codeInput').value.trim(); if (c) joinRoom(c); });
$('pwForm').addEventListener('submit', (e) => { e.preventDefault(); if (S.pendingCode) joinRoom(S.pendingCode, $('pwInput').value); });
$('leaveBtn').addEventListener('click', () => send({ t: 'leaveRoom' }));
$('nameBtn').addEventListener('click', () => { $('nameInput').value = S.me.name; openModal('nameModal'); $('nameInput').select(); });
$('nameForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('nameInput').value.trim();
  if (v) { LS.set('sitshow.name', v); send({ t: 'setName', name: v }); }
  closeModals();
});
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = el('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text; document.body.append(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch {} ta.remove();
  if (!ok) window.prompt('Copy this invite link:', text);
  return ok;
}
function inviteLink(withPw) {
  const r = S.room; let link = `${location.origin}/?room=${r.code}`;
  if (withPw && S.pw[r.code]) link += '#k=' + encodeURIComponent(S.pw[r.code]);
  return link;
}
$('inviteBtn').addEventListener('click', async () => { if (await copyText(inviteLink(false))) toast('Invite link copied!', 'good'); });
$('invitePwBtn').addEventListener('click', async () => { if (await copyText(inviteLink(true))) toast('Invite link with password copied!', 'good'); });

// ───────────────────────────── avatar upload (resized + cached locally) ─────────────────────────────
const AVATAR_SIZE = 256;
function loadImage(file) {
  if (window.createImageBitmap) {
    return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  }
  return new Promise((res, rej) => {
    const u = URL.createObjectURL(file); const img = new Image();
    img.onload = () => { URL.revokeObjectURL(u); res(img); }; img.onerror = rej; img.src = u;
  });
}
async function handleAvatarFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) return toast('That file is not an image.');
  if (file.size > 40e6) return toast('That image is enormous — try one under 40 MB.');
  try {
    const img = await loadImage(file);
    const side = Math.min(img.width, img.height);           // centre-crop to a square…
    const out = Math.min(AVATAR_SIZE, side);                // …and shrink anything bigger than 256px
    const c = el('canvas'); c.width = c.height = out;
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
    g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, out, out);
    if (img.close) img.close();
    let data = c.toDataURL('image/webp', 0.82);
    if (!data.startsWith('data:image/webp')) data = c.toDataURL('image/jpeg', 0.85);
    if (!LS.set('sitshow.avatar', data)) toast('Could not cache the avatar in this browser.');
    LS.del('sitshow.avatarHash');
    renderMe();
    await uploadAvatar(data);
  } catch { toast('Could not read that image.'); }
}
async function uploadAvatar(data) {
  data = data || LS.get('sitshow.avatar'); if (!data) return;
  const m = /^data:(image\/\w+);base64,(.*)$/.exec(data); if (!m) return;
  const bin = atob(m[2]); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  try {
    const res = await fetch('/api/avatar', { method: 'POST', headers: { 'x-token': token, 'content-type': m[1] }, body: bytes });
    if (res.ok) LS.set('sitshow.avatarHash', (await res.json()).hash);
  } catch {}
}
function syncAvatar() { // the server forgets avatars 5 minutes after you disconnect, so re-send from the local cache when needed
  if (LS.get('sitshow.avatar') && S.me.av !== LS.get('sitshow.avatarHash')) uploadAvatar();
}
$('avatarBtn').addEventListener('click', () => $('avatarFile').click());
$('sideAvatar').addEventListener('click', () => $('avatarFile').click());
$('sideAvatar').style.cursor = 'pointer'; $('sideAvatar').title = 'Upload an avatar';
$('avatarFile').addEventListener('change', (e) => { handleAvatarFile(e.target.files[0]); e.target.value = ''; });
$('avatarRemove').addEventListener('click', () => {
  LS.del('sitshow.avatar'); LS.del('sitshow.avatarHash'); renderMe();
  fetch('/api/avatar', { method: 'DELETE', headers: { 'x-token': token } }).catch(() => {});
});

// ───────────────────────────── audio ─────────────────────────────
const Snd = (() => {
  let ac = null, master = null, gen = 0, bandTimer = null;
  let vol = +(LS.get('sitshow.vol') ?? 70) / 100;
  const music = new Audio(); music.preload = 'auto'; music.loop = true; music.volume = vol;
  function unlock() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    try { ac = new (window.AudioContext || window.webkitAudioContext)(); master = ac.createGain(); master.gain.value = vol; master.connect(ac.destination); } catch {}
  }
  function tone(f, t0, dur, type = 'sine', g = 0.2, slideTo) {
    const o = ac.createOscillator(), a = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    a.gain.setValueAtTime(0.0001, t0); a.gain.exponentialRampToValueAtTime(g, t0 + 0.012); a.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(a).connect(master); o.start(t0); o.stop(t0 + dur + 0.03);
  }
  function noise(t0, dur, f0, f1, g = 0.3) {
    const len = Math.max(1, Math.floor(ac.sampleRate * dur)), buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const s = ac.createBufferSource(); s.buffer = buf;
    const flt = ac.createBiquadFilter(); flt.type = 'bandpass'; flt.Q.value = 1.2;
    flt.frequency.setValueAtTime(f0, t0); flt.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const a = ac.createGain(); a.gain.setValueAtTime(g, t0); a.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(flt).connect(a).connect(master); s.start(t0);
  }
  const FX = {
    blip: (t) => tone(880, t, 0.08, 'triangle', 0.08, 1320),
    ding: (t) => { tone(1046, t, 0.25, 'sine', 0.16); tone(1568, t + 0.07, 0.3, 'sine', 0.12); },
    win: (t) => [523, 659, 784, 1046].forEach((f, i) => tone(f, t + i * 0.07, 0.3, 'triangle', 0.2)),
    buzz: (t) => { tone(110, t, 0.38, 'sawtooth', 0.22); tone(117, t, 0.38, 'square', 0.1); },
    scratch: (t) => { noise(t, 0.45, 3200, 180, 0.5); tone(700, t, 0.4, 'sawtooth', 0.12, 60); },
    drum: (t) => { for (let i = 0; i < 16; i++) noise(t + i * 0.075, 0.06, 240, 180, 0.12 + i * 0.012); noise(t + 1.25, 0.5, 6000, 3000, 0.25); },
    out: (t) => { [392, 370, 349, 233].forEach((f, i) => tone(f, t + i * 0.32, i === 3 ? 0.9 : 0.3, 'sawtooth', 0.13, i === 3 ? 200 : f * 0.97)); noise(t, 0.5, 400, 60, 0.4); },
    fanfare: (t) => [[523, 0], [523, 0.15], [523, 0.3], [698, 0.45], [659, 0.75], [784, 0.9], [1046, 1.2]].forEach(([f, d], i) => { tone(f, t + d, i === 6 ? 0.9 : 0.25, 'square', 0.1); tone(f / 2, t + d, i === 6 ? 0.9 : 0.25, 'sawtooth', 0.08); }),
    level: (t) => [659, 784, 988, 1319, 1568].forEach((f, i) => tone(f, t + i * 0.09, 0.35, 'triangle', 0.16)),
  };
  function sfx(name) { if (!ac || ac.state !== 'running' || !FX[name]) return; FX[name](ac.currentTime + 0.01); }

  // "The House Band": a tiny synth groove used when the data directory has no MP3s (or playback fails)
  function stopBand() { clearInterval(bandTimer); bandTimer = null; }
  function startBand() {
    stopBand(); if (!ac) return;
    const root = [220, 196, 246.9, 261.6][Math.floor(Math.random() * 4)], scale = [0, 3, 5, 7, 10, 12, 15];
    const mel = Array.from({ length: 32 }, () => (Math.random() < 0.3 ? -1 : Math.floor(Math.random() * scale.length)));
    const st = 60 / 132 / 2; let step = 0, next = ac.currentTime + 0.05;
    bandTimer = setInterval(() => {
      while (next < ac.currentTime + 0.25) {
        const b = step % 16;
        if (b % 4 === 0) tone(120, next, 0.16, 'sine', 0.5, 40);
        if (b % 4 === 2) noise(next, 0.05, 8000, 6000, 0.12);
        if (b % 8 === 4) noise(next, 0.14, 1800, 900, 0.25);
        if (b % 2 === 0) tone((root / 2) * 2 ** ([0, 0, 5, 7][(step >> 4) % 4] / 12), next, st * 1.7, 'triangle', 0.22);
        const n = mel[step % 32]; if (n >= 0) tone(root * 2 ** (scale[n] / 12), next, st * 0.9, 'square', 0.055);
        step++; next += st;
      }
    }, 60);
  }
  function srcFor(file) { return '/music/' + encodeURIComponent(file); }
  function prep(file) { // preload during the round intro so the music starts on cue
    if (!file) return;
    const s = srcFor(file);
    if (!music.src.endsWith(s)) { music.src = s; music.load(); }
  }
  function play(file, elapsedMs) {
    const my = ++gen; stopBand(); music.pause();
    if (!file) return startBand();
    prep(file);
    const begin = () => {
      if (my !== gen) return;
      // every round starts 30 seconds into the track (short tracks start as late as they can)
      let off = 30; const d = music.duration;
      if (isFinite(d) && d < 62) off = clamp(d - 32, 0, 30);
      try { music.currentTime = off + elapsedMs / 1000; } catch {}
      music.volume = vol;
      music.play().catch(() => { if (my === gen) startBand(); });
    };
    music.onerror = () => { if (my === gen) startBand(); };
    if (music.readyState >= 1) begin(); else music.addEventListener('loadedmetadata', begin, { once: true });
  }
  function stop(scratch) {
    const was = !music.paused || bandTimer; gen++;
    music.pause(); stopBand();
    if (scratch && was) sfx('scratch');
  }
  function setVol(v) { vol = v; music.volume = v; if (master) master.gain.value = v; LS.set('sitshow.vol', Math.round(v * 100)); }
  return { unlock, sfx, play, prep, stop, setVol, get vol() { return vol; } };
})();
addEventListener('pointerdown', Snd.unlock, { capture: true });
addEventListener('keydown', Snd.unlock, { capture: true });
$('volume').value = Math.round(Snd.vol * 100);
$('volume').addEventListener('input', (e) => Snd.setVol(e.target.value / 100));

// ───────────────────────────── phase flow ─────────────────────────────
function banner(main, sub = '', cls = '') {
  const b = $('bannerMain');
  b.className = 'banner-main ' + cls; b.textContent = main;
  if (main) { void b.offsetWidth; b.classList.add('pop'); }
  $('bannerSub').textContent = sub;
}
const nameOf = (r, id) => r.byId.get(id)?.name || r.standings?.find((s) => s.id === id)?.name || 'Someone';
function onPhase(r) {
  const alive = r.players.filter((p) => p.inGame && p.alive);
  $('stageWrap').classList.toggle('cinema', r.phase === 'results' && r.out.length > 0);
  $('onAir').classList.toggle('live', r.phase !== 'lobby');
  $('room').classList.toggle('scrambling', r.phase === 'scramble');
  S.myPick = null; S.lockUntil = 0; pzKey = '';
  $('puzzle').classList.remove('locked', 'shake');
  switch (r.phase) {
    case 'lobby':
      Snd.stop(); confetti.length = 0;
      banner('', r.players.length < 2 ? 'Waiting for contestants — share the invite link!' : 'Waiting for the host to start the show…');
      break;
    case 'intro':
      Snd.stop(); Snd.prep(r.current); Snd.sfx('drum');
      banner(alive.length === 2 ? 'THE FINAL!' : 'ROUND ' + r.round, `${alive.length} contestants · ${r.chairs.length} chair${r.chairs.length > 1 ? 's' : ''}`);
      break;
    case 'music':
      Snd.play(r.current, r.elapsed);
      banner('', '♪ ' + songTitle(r.current) + ' — keep moving!');
      break;
    case 'scramble':
      Snd.stop(true);
      banner('GRAB A SEAT!', '', 'red');
      break;
    case 'results': {
      Snd.stop();
      if (r.nobody) { banner('NOBODY SAT DOWN!', "Let's try that again…", 'teal'); break; }
      const now = performance.now();
      for (const id of r.out) { const e = ents.get(id); if (e) { e.deathAt = now; e.deathKind = r.byId.get(id)?.death || 'poof'; } }
      if (r.out.length) { Snd.sfx('out'); banner(r.out.map((id) => nameOf(r, id)).join(' & ') + (r.out.length > 1 ? ' ARE OUT!' : ' IS OUT!'), '', 'red'); }
      else banner('EVERYBODY SURVIVES!', '', 'teal');
      break;
    }
    case 'gameover':
      Snd.stop(); Snd.sfx('fanfare');
      banner(r.winner ? `🏆 ${nameOf(r, r.winner)} WINS!` : 'NOBODY WINS!', (r.standings || []).slice(1, 3).map((s, i) => `${i + 2}. ${s.name}`).join('  ·  '));
      spawnConfetti();
      break;
  }
}
function onRoomUpdate(r) {
  $('roomName').textContent = r.name; $('roomCode').textContent = r.code;
  document.title = `${r.name} — Sit Show`;
  if (S.createPw && r.hostId === S.me.id && !S.pw[r.code]) S.pw[r.code] = S.createPw;
  S.createPw = null;
  $('invitePwBtn').hidden = !(r.locked && S.pw[r.code]);
  const me = r.byId.get(S.me.id);
  if (r.phase === 'scramble' && me && me.alive && me.seat == null && (S.myPick == null || r.chairs[S.myPick]?.owner)) autoPick();
  renderPlayers(r); renderHost(); renderPuzzle();
}

function renderPlayers(r) {
  const ul = $('playerList'); ul.textContent = '';
  $('playerCount').textContent = `${r.players.length}/${r.max}`;
  const playing = r.phase !== 'lobby';
  for (const p of r.players) {
    let status = '';
    if (p.id === r.winner) status = '🏆';
    else if (playing && p.inGame) status = p.alive ? (p.seat != null ? '🪑' : '') : '💀';
    else if (playing) status = '👀';
    const av = el('span', { class: 'avatar' }); setAvatarEl(av, p, p.id === S.me.id ? LS.get('sitshow.avatar') : null);
    ul.append(el('li', { class: (p.id === S.me.id ? 'me ' : '') + (playing && p.inGame && !p.alive ? 'out' : '') },
      av, el('span', { class: 'pn', text: (p.id === r.hostId ? '👑 ' : '') + p.name }),
      el('span', { class: 'lv', text: 'Lv ' + p.level }), el('span', { text: status })));
  }
}

let hostKey = '';
function renderHost() {
  const r = S.room; if (!r) return;
  const box = $('hostBox'); const amHost = r.hostId === S.me.id;
  const bots = r.players.filter((p) => p.bot).length;
  const key = [amHost, r.phase === 'lobby', r.song, S.songs.length, r.players.length, bots, r.max, r.current, r.round, r.hostId].join('|');
  if (key === hostKey) return;
  hostKey = key; box.textContent = '';
  if (!amHost) {
    box.append(el('h3', { text: 'Tonight\'s show' }),
      el('div', { class: 'now', text: `Host: ${nameOf(r, r.hostId)}` }),
      el('div', { class: 'now', text: '♪ ' + (r.phase !== 'lobby' ? songTitle(r.current) : r.song === 'random' ? 'Random song each round' : songTitle(r.song)) }));
    return;
  }
  box.append(el('h3', { text: '👑 Host controls' }));
  const sel = el('select', { 'aria-label': 'Song', onchange: (e) => send({ t: 'setSong', song: e.target.value }) });
  sel.append(el('option', { value: 'random', text: '🎲 Random song each round' }));
  for (const s of S.songs) sel.append(el('option', { value: s, text: songTitle(s) }));
  sel.value = r.song;
  box.append(el('div', { class: 'row', style: 'flex-wrap:nowrap' }, sel, el('button', { class: 'btn small ghost', title: 'Rescan the music folder', text: '↻', onclick: () => send({ t: 'songs' }) })));
  if (!S.songs.length) box.append(el('p', { class: 'hint', text: 'No MP3s found in the music folder yet — the House Band will play instead.' }));
  if (r.phase === 'lobby') {
    box.append(el('div', { class: 'row' },
      el('button', { class: 'btn small', text: '+ Bot', disabled: r.players.length >= r.max, onclick: () => send({ t: 'addBot' }) }),
      el('button', { class: 'btn small ghost', text: '− Bot', disabled: !bots, onclick: () => send({ t: 'removeBot' }) })),
      el('button', { class: 'btn gold wide', text: '▶ Start the show', disabled: r.players.length < 2, onclick: () => send({ t: 'start' }) }));
    if (r.players.length < 2) box.append(el('p', { class: 'hint', text: 'You need at least 2 contestants. Invite someone or add a bot.' }));
  } else box.append(el('div', { class: 'now', text: `Round ${r.round} · now playing: ${songTitle(r.current)}` }));
}

// ───────────────────────────── puzzle panel ─────────────────────────────
let pzKey = '';
function pickChair(i) {
  const r = S.room; if (!r || r.phase !== 'scramble' || !r.chairs[i] || r.chairs[i].owner) return;
  if (S.myPick === i) return;
  S.myPick = i; send({ t: 'pick', chair: i }); renderPuzzle();
}
function autoPick() {
  const r = S.room; const e = ents.get(S.me.id);
  let best = null, bd = Infinity;
  r.chairs.forEach((c, i) => {
    if (c.owner) return;
    const pos = chairPos(i, r.chairs.length); const d = e ? Math.hypot(pos.x - e.x, pos.y - e.y) : i;
    if (d < bd) { bd = d; best = i; }
  });
  if (best != null) { S.myPick = best; send({ t: 'pick', chair: best }); }
}
function submitAnswer(a) {
  if (performance.now() < S.lockUntil || S.myPick == null || a === '') return;
  send({ t: 'answer', chair: S.myPick, a });
}
function renderPuzzle() {
  const r = S.room, box = $('puzzle'); const me = r?.byId.get(S.me.id);
  if (!r || r.phase !== 'scramble' || !me || !me.alive) { box.hidden = true; pzKey = ''; return; }
  box.hidden = false;
  const key = me.seat != null ? 'safe' : r.round + ':' + S.myPick;
  if (key !== pzKey) {
    pzKey = key; box.textContent = '';
    if (me.seat != null) {
      box.append(el('div', { class: 'pz-status', text: `🪑 SAFE! You grabbed chair ${me.seat + 1}.` }));
      return;
    }
    const pz = r.chairs[S.myPick]?.puzzle;
    box.append(el('div', { class: 'chair-tabs', id: 'chairTabs' }));
    if (pz) {
      box.append(el('div', { class: 'pz-title', text: pz.title }));
      if (pz.prompt) {
        const pr = el('div', { class: 'pz-prompt' + (pz.ink ? ' inked' : pz.kind === 'choice' ? ' small' : ''), text: pz.prompt });
        if (pz.ink) pr.style.color = pz.ink;
        box.append(pr);
      }
      if (pz.kind === 'choice') {
        const grid = el('div', { class: 'pz-choices' + (pz.big ? ' big' : '') });
        pz.choices.forEach((ch, i) => grid.append(el('button', { type: 'button', onclick: () => submitAnswer(ch) }, el('i', { text: String(i + 1) }), document.createTextNode(ch))));
        box.append(grid);
      } else {
        const inp = el('input', { maxlength: 24, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', inputmode: pz.numeric ? 'numeric' : 'text', 'aria-label': 'Your answer', placeholder: 'Type your answer' });
        const form = el('form', { class: 'pz-type', onsubmit: (e) => { e.preventDefault(); submitAnswer(inp.value.trim()); } }, inp, el('button', { class: 'btn primary', text: 'SIT!' }));
        box.append(form);
        setTimeout(() => inp.focus(), 30);
      }
      box.append(el('div', { class: 'pz-lock' }, el('i')));
    }
  }
  const tabs = $('chairTabs');
  if (tabs) {
    tabs.textContent = '';
    r.chairs.forEach((c, i) => {
      const rivals = r.players.filter((p) => p.pick === i && p.seat == null && p.alive && p.id !== S.me.id).length;
      const b = el('button', { type: 'button', class: (i === S.myPick ? 'sel ' : '') + (c.owner ? 'taken' : ''), text: '🪑 ' + (i + 1), onclick: () => pickChair(i) });
      if (rivals && !c.owner) b.append(el('span', { class: 'rivals', text: ' ×' + rivals }));
      tabs.append(b);
    });
  }
}
document.addEventListener('keydown', (e) => {
  const r = S.room; if (!r || r.phase !== 'scramble' || $('puzzle').hidden || document.querySelector('.modal:not([hidden])')) return;
  const me = r.byId.get(S.me.id); if (!me || me.seat != null) return;
  if (e.key === 'Tab') {
    e.preventDefault();
    const n = r.chairs.length;
    for (let k = 1; k <= n; k++) { const i = ((S.myPick ?? -1) + (e.shiftKey ? -k : k) + n * 2) % n; if (!r.chairs[i].owner) { pickChair(i); break; } }
  } else if (/^[1-4]$/.test(e.key) && e.target.tagName !== 'INPUT') {
    const pz = r.chairs[S.myPick]?.puzzle;
    if (pz && pz.kind === 'choice' && pz.choices[+e.key - 1] != null) submitAnswer(pz.choices[+e.key - 1]);
  }
});

// ───────────────────────────── emotes & wardrobe ─────────────────────────────
let emoteKey = '';
function renderEmoteBar() {
  if (!S.catalog) return;
  const key = String(S.me.level); if (key === emoteKey) return; emoteKey = key;
  const bar = $('emoteBar'); bar.textContent = '';
  for (const em of S.catalog.emotes) {
    if (em.level > S.me.level) { bar.append(el('button', { class: 'locked', title: `Next emote ${em.e} unlocks at level ${em.level}`, text: '🔒' + em.level, onclick: openWardrobe })); break; }
    bar.append(el('button', { title: 'Emote', text: em.e, onclick: () => send({ t: 'emote', id: em.id }) }));
  }
}
const preview = { open: false, dance: 'strut', death: null, deathAt: 0, ring: 'none' };
function renderWardrobe() {
  const me = S.me, box = $('wardrobeLists'); box.textContent = '';
  const groups = [['dances', 'dance', '💃 Dances — how you move around the chairs'], ['deaths', 'death', '💥 Dramatic exits — how you go out'], ['rings', 'ring', '⭕ Frames']];
  for (const [kind, field, title] of groups) {
    const items = el('div', { class: 'items' });
    for (const it of S.catalog[kind]) {
      const locked = it.level > me.level;
      const b = el('button', { type: 'button', class: 'item' + (me[field] === it.id ? ' on' : '') + (locked ? ' locked' : ''), onclick: () => {
        preview[field] = it.id;
        if (field === 'death') preview.deathAt = performance.now();
        $('previewHint').textContent = locked ? `${it.name} unlocks at level ${it.level}.` : `${it.name} equipped.`;
        if (!locked) send({ t: 'equip', [field]: it.id });
      } }, document.createTextNode(it.name));
      if (locked) b.append(el('small', { text: '🔒 Lv ' + it.level }));
      items.append(b);
    }
    box.append(el('div', null, el('h3', { text: title }), items));
  }
  const emo = el('div', { class: 'items' });
  for (const em of S.catalog.emotes) {
    const locked = em.level > me.level;
    const b = el('span', { class: 'item emo' + (locked ? ' locked' : ''), text: em.e });
    if (locked) b.append(el('small', { text: 'Lv ' + em.level }));
    emo.append(b);
  }
  box.append(el('div', null, el('h3', { text: '😎 Emotes' }), emo));
}
function openWardrobe() {
  Object.assign(preview, { open: true, dance: S.me.dance, ring: S.me.ring, death: S.me.death, deathAt: 0 });
  $('previewHint').textContent = 'Click anything to preview it — even the locked stuff.';
  renderWardrobe(); openModal('wardrobeModal');
}
$('wardrobeBtn').addEventListener('click', openWardrobe);
$('homeWardrobe').addEventListener('click', openWardrobe);

// ───────────────────────────── stage rendering ─────────────────────────────
const cv = $('stage'), g = cv.getContext('2d');
const wrap = $('stageWrap');
let W = 0, H = 0, DPR = 1, L = { cx: 0, cy: 0, RX: 1, RY: 1, s: 1 }, bg = null, spin = 0, lastT = performance.now();
const ents = new Map(); // id -> render entity
const confetti = [];
const imgCache = new Map();
const DEATH_MS = 2500;
const FONT_D = 'Impact, "Arial Black", sans-serif', FONT_B = '"Trebuchet MS", system-ui, sans-serif';

function resize() {
  const r = wrap.getBoundingClientRect(); if (!r.width || !r.height) return;
  DPR = Math.min(2, devicePixelRatio || 1); W = r.width; H = r.height;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  const RY = Math.min(H * 0.2, W * 0.38 * 0.45), RX = Math.min(W * 0.38, RY * 2.7);
  L = { cx: W / 2, cy: H * 0.46, RX, RY, s: clamp(RY / 130, 0.5, 1.15) };
  bg = renderBg();
}
new ResizeObserver(resize).observe(wrap);

function ellipse(c, x, y, rx, ry) { c.beginPath(); c.ellipse(x, y, Math.max(0, rx), Math.max(0, ry), 0, 0, TAU); }
function rrect(c, x, y, w, h, r) {
  c.beginPath();
  if (c.roundRect) c.roundRect(x, y, w, h, r);
  else { c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
}
function renderBg() {
  const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height;
  const b = c.getContext('2d'); b.scale(DPR, DPR);
  const { cx, cy, RX, RY } = L, horizon = cy - RY * 0.5;
  let gr = b.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, '#3d0d33'); gr.addColorStop(0.55, '#22093a'); gr.addColorStop(1, '#0a0416');
  b.fillStyle = gr; b.fillRect(0, 0, W, H);
  for (let x = 0; x < W; x += 28) { // velvet curtain folds
    const sh = 0.5 + 0.5 * Math.sin(x * 0.37);
    b.fillStyle = `rgba(${(130 + 70 * sh) | 0},${(18 + 22 * sh) | 0},${(56 + 30 * sh) | 0},.6)`; b.fillRect(x, 0, 15, horizon + 30);
    b.fillStyle = 'rgba(0,0,0,.28)'; b.fillRect(x + 15, 0, 13, horizon + 30);
  }
  gr = b.createLinearGradient(0, horizon - 60, 0, horizon + 40);
  gr.addColorStop(0, 'rgba(10,4,22,0)'); gr.addColorStop(1, 'rgba(10,4,22,1)');
  b.fillStyle = gr; b.fillRect(0, horizon - 60, W, 100);
  b.fillStyle = '#0a0416'; b.fillRect(0, horizon + 30, W, H);
  // stage floor
  gr = b.createRadialGradient(cx, cy, 10, cx, cy, RX * 1.25);
  gr.addColorStop(0, '#8436c9'); gr.addColorStop(0.55, '#3c1568'); gr.addColorStop(1, '#170a2c');
  b.fillStyle = gr; ellipse(b, cx, cy, RX * 1.22, RY * 1.6); b.fill();
  b.lineWidth = 3;
  for (const [f, a] of [[1.22, 0.9], [1.0, 0.25], [0.55, 0.3]]) { b.strokeStyle = `rgba(255,200,61,${a})`; ellipse(b, cx, cy, RX * f, RY * f * (f > 1.2 ? 1.6 / 1.22 : 1)); b.stroke(); }
  b.fillStyle = 'rgba(255,200,61,.22)'; b.beginPath(); // centre star
  for (let i = 0; i < 10; i++) { const r = i % 2 ? 0.16 : 0.4, a = -Math.PI / 2 + (i * TAU) / 10; b.lineTo(cx + Math.cos(a) * RX * r, cy + Math.sin(a) * RY * r); }
  b.closePath(); b.fill();
  return c;
}
function chairPos(i, n) {
  const f = n <= 1 ? 0 : n === 2 ? 0.28 : n <= 4 ? 0.42 : 0.56;
  const a = -Math.PI / 2 + (i * TAU) / n + (n === 2 ? Math.PI / 2 : 0);
  return { x: L.cx + Math.cos(a) * L.RX * f, y: L.cy + Math.sin(a) * L.RY * f, a };
}
function getImg(p) {
  if (!p.av) return null;
  const key = p.id + p.av; let im = imgCache.get(key);
  if (!im) { im = new Image(); im.src = `/avatar/${p.id}?v=${p.av}`; imgCache.set(key, im); if (imgCache.size > 80) imgCache.delete(imgCache.keys().next().value); }
  return im.complete && im.naturalWidth ? im : null;
}

// dance → limb offsets
const Z = { x: 0, y: 0 };
function dancePose(id, t) {
  const s = Math.sin, c = Math.cos, a = Math.abs;
  switch (id) {
    case 'bounce': { const h = a(s(t * 7)); return { dy: -h * 20, hl: { x: -4, y: -18 - h * 10 }, hr: { x: 4, y: -18 - h * 10 }, fl: { x: 0, y: h * 3 }, fr: { x: 0, y: h * 3 } }; }
    case 'wiggle': return { rot: s(t * 10) * 0.22, bx: s(t * 10) * 4, hl: { x: s(t * 10) * 5, y: -6 }, hr: { x: s(t * 10) * 5, y: -6 }, fl: { x: -s(t * 10) * 2, y: 0 }, fr: { x: -s(t * 10) * 2, y: 0 } };
    case 'conga': { const k = Math.max(0, s(t * 6)), k2 = Math.max(0, -s(t * 6)); return { dy: -a(s(t * 12)) * 3, hl: { x: 6, y: -10 }, hr: { x: -6, y: -10 }, fl: { x: -k2 * 16, y: -k2 * 6 }, fr: { x: k * 16, y: -k * 6 }, rot: (k - k2) * 0.08 }; }
    case 'spin': return { sx: c(t * 6), dy: -a(s(t * 6)) * 5, hl: { x: -10, y: -8 }, hr: { x: 10, y: -8 }, fl: Z, fr: Z };
    case 'moonwalk': { const p = (t * 1.6) % 1, q = (t * 1.6 + 0.5) % 1; return { rot: -0.12, bx: s(t * 10) * 1.5, hl: { x: 4, y: 4 }, hr: { x: -12, y: -34 }, fl: { x: (p - 0.5) * 18, y: p > 0.8 ? -4 : 0 }, fr: { x: (q - 0.5) * 18, y: q > 0.8 ? -4 : 0 } }; }
    case 'robot': { const q = Math.floor(t * 4) % 4; return { rot: [0.1, 0, -0.1, 0][q], dy: q % 2 ? -3 : 0, hl: { x: -4, y: [-22, 0, 6, 0][q] }, hr: { x: 4, y: [6, 0, -22, 0][q] }, fl: { x: 0, y: q === 1 ? -5 : 0 }, fr: { x: 0, y: q === 3 ? -5 : 0 } }; }
    case 'floss': { const w = s(t * 13); return { bx: -w * 6, hl: { x: w * 20 + 14, y: 8 }, hr: { x: w * 20 - 14, y: 8 }, fl: Z, fr: Z, rot: -w * 0.05 }; }
    case 'idle': return { dy: s(t * 2.2) * 1.5, hl: Z, hr: Z, fl: Z, fr: Z };
    default: { const w = s(t * 9); return { dy: -a(w) * 4, rot: w * 0.04, hl: { x: 0, y: w * 9 }, hr: { x: 0, y: -w * 9 }, fl: { x: 0, y: Math.min(0, w) * 6 }, fr: { x: 0, y: Math.min(0, -w) * 6 } }; }
  }
}
function drawAvatar(c, x, y, k, p, t, o = {}) {
  const d = dancePose(o.moving ? p.dance : 'idle', t + (strHash(p.id) % 100) / 10);
  const scale = k * (o.scale ?? 1);
  if (scale <= 0.01) return;
  const dark = o.dark, hue = p.hue ?? hueOf(p.id);
  c.save();
  c.globalAlpha *= o.alpha ?? 1;
  c.translate(x + (o.dx || 0), y + (o.dy || 0)); c.scale(scale, scale);
  if (!o.noShadow) { c.fillStyle = 'rgba(0,0,0,.38)'; ellipse(c, 0, 0, 24, 7); c.fill(); }
  c.translate(d.bx || 0, d.dy || 0);
  c.translate(0, -40); c.rotate((o.rot || 0) + (d.rot || 0)); c.scale(d.sx ?? 1, 1); c.translate(0, 40);
  const bodyCol = dark ? '#111' : `hsl(${hue} 72% 52%)`, bodyDark = dark ? '#000' : `hsl(${hue} 72% 34%)`;
  if (!o.sit) { // feet
    c.fillStyle = dark ? '#000' : '#1b0b33';
    ellipse(c, -9 + d.fl.x, -3 + d.fl.y, 8, 5); c.fill(); ellipse(c, 9 + d.fr.x, -3 + d.fr.y, 8, 5); c.fill();
  }
  c.fillStyle = bodyCol; rrect(c, -15, -46, 30, o.sit ? 32 : 42, 12); c.fill();
  c.fillStyle = bodyDark; rrect(c, -15, -18 - (o.sit ? 10 : 0), 30, 14, 8); c.fill();
  c.fillStyle = dark ? '#111' : `hsl(${hue} 80% 70%)`; // hands
  ellipse(c, -21 + d.hl.x, -28 + d.hl.y, 6, 6); c.fill(); ellipse(c, 21 + d.hr.x, -28 + d.hr.y, 6, 6); c.fill();
  // head
  const hy = -64, hr = 22, ring = p.ring || 'none';
  if (!dark && ring !== 'none') {
    c.save();
    if (ring === 'gold') { c.shadowColor = '#ffc83d'; c.shadowBlur = 12; c.strokeStyle = '#ffc83d'; }
    else if (ring === 'neon') { c.shadowColor = '#19e3c9'; c.shadowBlur = 10 + 8 * Math.sin(t * 6); c.strokeStyle = '#19e3c9'; }
    else if (ring === 'rainbow' && c.createConicGradient) { const cg = c.createConicGradient(t * 2, 0, hy); ['#ff3d81', '#ffc83d', '#3ddc84', '#19e3c9', '#4d8dff', '#b46bff', '#ff3d81'].forEach((col, i) => cg.addColorStop(i / 6, col)); c.strokeStyle = cg; }
    else c.strokeStyle = '#ffc83d';
    c.lineWidth = 6; c.beginPath(); c.arc(0, hy, hr + 2, 0, TAU); c.stroke(); c.restore();
  }
  c.save(); c.beginPath(); c.arc(0, hy, hr, 0, TAU); c.clip();
  const im = dark ? null : getImg(p);
  if (im) c.drawImage(im, -hr, hy - hr, hr * 2, hr * 2);
  else {
    c.fillStyle = dark ? '#151515' : `hsl(${hue} 70% 62%)`; c.fillRect(-hr, hy - hr, hr * 2, hr * 2);
    c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = (dark || p.face ? '28px ' : '26px ') + (dark || p.face ? FONT_B : FONT_D);
    c.fillText(dark ? '💀' : p.face || [...(p.name || '?')][0].toUpperCase(), 0, hy + 2);
  }
  c.restore();
  if (ring === 'none' || dark) { c.strokeStyle = dark ? '#333' : '#fff'; c.lineWidth = 3; c.beginPath(); c.arc(0, hy, hr, 0, TAU); c.stroke(); }
  if (ring === 'crown' && !dark) { c.font = '26px ' + FONT_B; c.textAlign = 'center'; c.textBaseline = 'alphabetic'; c.fillText('👑', 0, hy - hr + 4); }
  c.restore();
}
function drawTag(c, x, y, k, p, isMe) {
  const fs = clamp(12 * k, 9, 14); c.font = `700 ${fs}px ${FONT_B}`; c.textAlign = 'center'; c.textBaseline = 'middle';
  const label = p.name, w = c.measureText(label).width + 12;
  c.fillStyle = isMe ? '#ffc83d' : 'rgba(10,4,24,.78)'; rrect(c, x - w / 2, y + 5, w, fs + 6, 6); c.fill();
  c.fillStyle = isMe ? '#1b0b33' : '#fff3d6'; c.fillText(label, x, y + 5 + (fs + 6) / 2 + 0.5);
}
function drawChair(c, x, y, k, i, st, t) {
  c.save(); c.translate(x, y); c.scale(k, k);
  c.fillStyle = 'rgba(0,0,0,.35)'; ellipse(c, 0, 0, 26, 8); c.fill();
  if (st.free) { c.shadowColor = st.sel ? '#19e3c9' : '#ffc83d'; c.shadowBlur = 14 + (0.5 + 0.5 * Math.sin(t * 7 + i)) * 16; }
  c.fillStyle = '#6b3d12'; c.fillRect(-18, -22, 5, 22); c.fillRect(13, -22, 5, 22);
  c.fillStyle = '#c2183f'; rrect(c, -20, -68, 40, 44, 9); c.fill();
  c.shadowBlur = 0;
  c.strokeStyle = '#ffc83d'; c.lineWidth = 3; rrect(c, -20, -68, 40, 44, 9); c.stroke();
  c.fillStyle = '#ffc83d'; for (const [bx, by] of [[-10, -56], [10, -56], [0, -46], [-10, -36], [10, -36]]) { ellipse(c, bx, by, 2, 2); c.fill(); }
  c.fillStyle = '#ff4d6d'; ellipse(c, 0, -22, 24, 9); c.fill(); c.stroke();
  if (st.free) {
    const bob = Math.sin(t * 5 + i) * 4;
    c.fillStyle = st.sel ? '#19e3c9' : '#fff3d6'; ellipse(c, 0, -92 + bob, 15, 15); c.fill();
    c.fillStyle = '#1b0b33'; c.font = '20px ' + FONT_D; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(String(i + 1), 0, -91 + bob);
    if (st.sel) { c.fillStyle = '#19e3c9'; c.beginPath(); c.moveTo(-8, -74 + bob); c.lineTo(8, -74 + bob); c.lineTo(0, -66 + bob); c.fill(); }
  }
  c.restore();
}

// cinematic exits. a = { x, y, sc, seed, draw(opts) }, k = progress 0..1, E = { top, right, w, h }
const DEATHS = {
  poof(c, a, k) {
    if (k < 0.3) a.draw({ scale: 1 + k * 2, alpha: 1 - k / 0.3 });
    for (let i = 0; i < 11; i++) {
      const an = (i / 11) * TAU + a.seed, r = (18 + ease(k) * 80) * a.sc;
      c.globalAlpha = Math.max(0, 1 - k) * 0.85; c.fillStyle = i % 2 ? '#fff' : '#d9c7ff';
      ellipse(c, a.x + Math.cos(an) * r, a.y - 45 * a.sc + Math.sin(an) * r * 0.7, (18 - k * 12) * a.sc, (18 - k * 12) * a.sc); c.fill();
    }
    c.globalAlpha = 1;
  },
  hook(c, a, k, E) {
    const grab = a.x + 4 * a.sc, hy = a.y - 60 * a.sc;
    const hx = k < 0.35 ? lerp(E.right + 40, grab, ease(k / 0.35)) : lerp(grab, E.right + 260, ((k - 0.35) / 0.45) ** 2);
    if (k < 0.82) a.draw(k < 0.35 ? { dx: Math.sin(k * 60) * 2 } : { dx: hx - grab, rot: 0.4, dy: -8 * a.sc });
    c.strokeStyle = '#f5e6c8'; c.lineWidth = 7 * a.sc; c.lineCap = 'round'; c.beginPath();
    c.moveTo(E.right + 400, hy + 16 * a.sc); c.lineTo(hx, hy + 16 * a.sc); c.arc(hx, hy, 16 * a.sc, Math.PI / 2, Math.PI * 1.5); c.stroke();
  },
  trapdoor(c, a, k) {
    const open = k < 0.15 ? k / 0.15 : k > 0.85 ? (1 - k) / 0.15 : 1;
    c.fillStyle = '#000'; ellipse(c, a.x, a.y, 36 * a.sc * open, 13 * a.sc * open); c.fill();
    c.strokeStyle = '#ffc83d'; c.lineWidth = 2; c.stroke();
    if (k < 0.75) {
      const f = k < 0.22 ? 0 : (k - 0.22) / 0.5;
      c.save(); c.beginPath(); c.rect(a.x - 90 * a.sc, a.y - 320 * a.sc, 180 * a.sc, 320 * a.sc + 3); c.clip();
      a.draw({ dy: f * f * 170 * a.sc, rot: f * 0.5, noShadow: true, dx: k < 0.22 ? Math.sin(k * 90) * 3 : 0 });
      c.restore();
    }
  },
  confetti(c, a, k) {
    if (k < 0.12) return a.draw({ scale: 1 + k * 3.5 });
    const t = (k - 0.12) * 2.2, cols = ['#ff3d81', '#ffc83d', '#19e3c9', '#4d8dff', '#fff', '#b46bff'];
    c.globalAlpha = Math.max(0, 1 - k ** 3);
    for (let i = 0; i < 54; i++) {
      const an = sr(a.seed, i) * TAU, sp = 0.3 + sr(a.seed, i + 99);
      const px = a.x + Math.cos(an) * sp * t * 170 * a.sc, py = a.y - 45 * a.sc + Math.sin(an) * sp * t * 150 * a.sc + 230 * t * t * a.sc;
      c.save(); c.translate(px, py); c.rotate(t * 9 * (sr(a.seed, i + 7) - 0.5) + i); c.fillStyle = cols[i % cols.length];
      c.fillRect(-4 * a.sc, -2.5 * a.sc, 8 * a.sc, 5 * a.sc); c.restore();
    }
    c.globalAlpha = 1;
  },
  lightning(c, a, k, E) {
    if (k < 0.24) {
      c.fillStyle = `rgba(255,255,255,${(0.24 - k) * 2.2})`; c.fillRect(0, 0, E.w, E.h);
      c.strokeStyle = '#fff'; c.shadowColor = '#9cc8ff'; c.shadowBlur = 20; c.lineWidth = 5 * a.sc; c.lineJoin = 'bevel'; c.beginPath();
      const ty = a.y - 84 * a.sc; let px = a.x + (Math.random() - 0.5) * 120; c.moveTo(px, E.top);
      for (let i = 1; i < 8; i++) { px = lerp(px, a.x, 0.3) + (Math.random() - 0.5) * 44; c.lineTo(px, lerp(E.top, ty, i / 8)); }
      c.lineTo(a.x, ty); c.stroke(); c.shadowBlur = 0;
    }
    if (k < 0.55) a.draw({ dark: k > 0.06 && Math.floor(k * 40) % 3 !== 0, dx: (Math.random() - 0.5) * 7 * a.sc });
    else {
      const f = (k - 0.55) / 0.45;
      c.globalAlpha = 1 - f; c.fillStyle = '#4a4458'; ellipse(c, a.x, a.y - 4 * a.sc, 26 * a.sc, 10 * a.sc * (1 - f * 0.5)); c.fill();
      for (let i = 0; i < 12; i++) { c.fillStyle = '#8a8499'; ellipse(c, a.x + (sr(a.seed, i) - 0.5) * 60 * a.sc, a.y - (1 - f) * sr(a.seed, i + 5) * 70 * a.sc, 2.5 * a.sc, 2.5 * a.sc); c.fill(); }
      c.globalAlpha = 1;
    }
  },
  rocket(c, a, k, E) {
    const f = k < 0.3 ? 0 : (k - 0.3) / 0.7, dy = -f * f * (a.y - E.top + 180 * a.sc), dx = k < 0.3 ? (Math.random() - 0.5) * 5 * a.sc : 0;
    const len = (k < 0.3 ? (k / 0.3) * 28 : 58 + Math.random() * 26) * a.sc, fy = a.y + dy;
    for (let i = 0; i < 7 && f > 0; i++) { const s = (f * 3 + i / 7) % 1; c.fillStyle = `rgba(230,225,240,${0.4 * (1 - s) * (1 - f)})`; ellipse(c, a.x + (sr(a.seed, i) - 0.5) * 90 * a.sc * s, a.y - s * 20 * a.sc, (10 + s * 26) * a.sc, (8 + s * 18) * a.sc); c.fill(); }
    const gr = c.createLinearGradient(0, fy, 0, fy + len); gr.addColorStop(0, '#fff7c2'); gr.addColorStop(0.4, '#ffb02e'); gr.addColorStop(1, 'rgba(255,60,30,0)');
    c.fillStyle = gr; c.beginPath(); c.moveTo(a.x + dx - 13 * a.sc, fy - 4 * a.sc); c.lineTo(a.x + dx + 13 * a.sc, fy - 4 * a.sc); c.lineTo(a.x + dx, fy + len); c.fill();
    a.draw({ dx, dy, noShadow: f > 0 });
    if (k > 0.88) { const s = Math.sin(((k - 0.88) / 0.12) * Math.PI) * 16 * a.sc; c.fillStyle = '#fff'; c.beginPath(); for (let i = 0; i < 8; i++) { const r = i % 2 ? s * 0.25 : s, an = (i * TAU) / 8; c.lineTo(a.x + Math.cos(an) * r, E.top + 30 + Math.sin(an) * r); } c.fill(); }
  },
  ufo(c, a, k, E) {
    const hover = a.y - 185 * a.sc;
    const uy = k < 0.2 ? lerp(E.top - 70, hover, ease(k / 0.2)) : k > 0.8 ? lerp(hover, E.top - 90, ((k - 0.8) / 0.2) ** 2) : hover + Math.sin(k * 40) * 3;
    const ux = k > 0.8 ? a.x + ((k - 0.8) / 0.2) ** 2 * 240 * a.sc : a.x;
    if (k > 0.2 && k < 0.8) {
      c.fillStyle = `rgba(140,255,205,${0.22 + 0.1 * Math.sin(k * 80)})`; c.beginPath();
      c.moveTo(ux - 18 * a.sc, uy); c.lineTo(ux + 18 * a.sc, uy); c.lineTo(a.x + 48 * a.sc, a.y + 4); c.lineTo(a.x - 48 * a.sc, a.y + 4); c.fill();
    }
    const f = clamp((k - 0.26) / 0.5, 0, 1);
    if (f < 1) a.draw({ dy: -f * 150 * a.sc, scale: 1 - f * 0.8, rot: Math.sin(k * 30) * 0.25 * f, noShadow: f > 0 });
    c.fillStyle = '#8fe9ff'; ellipse(c, ux, uy - 9 * a.sc, 21 * a.sc, 15 * a.sc); c.fill();
    c.fillStyle = '#9aa7c7'; ellipse(c, ux, uy, 48 * a.sc, 13 * a.sc); c.fill();
    for (let i = 0; i < 5; i++) { c.fillStyle = Math.floor(k * 30 + i) % 2 ? '#ffc83d' : '#ff3d81'; ellipse(c, ux + (i - 2) * 17 * a.sc, uy + 2 * a.sc, 3.5 * a.sc, 3.5 * a.sc); c.fill(); }
  },
  blackhole(c, a, k) {
    const hx = a.x, hy = a.y - 50 * a.sc, gsz = k < 0.15 ? k / 0.15 : k > 0.85 ? (1 - k) / 0.15 : 1;
    c.lineWidth = 4 * a.sc;
    for (let i = 0; i < 5; i++) { c.strokeStyle = `hsla(${265 + i * 22},95%,66%,.75)`; c.beginPath(); c.arc(hx, hy, (16 + i * 9) * a.sc * gsz, k * 22 + i * 1.3, k * 22 + i * 1.3 + 4); c.stroke(); }
    c.fillStyle = '#000'; ellipse(c, hx, hy, 15 * a.sc * gsz, 15 * a.sc * gsz); c.fill();
    const f = clamp((k - 0.1) / 0.65, 0, 1);
    if (f < 1) a.draw({ dx: Math.cos(f * 15) * (1 - f) * 38 * a.sc, dy: -10 * a.sc * f + Math.sin(f * 15) * (1 - f) * 18 * a.sc, scale: 1 - f, rot: f * 15, noShadow: true });
  },
};

function spawnConfetti() {
  confetti.length = 0;
  const cols = ['#ff3d81', '#ffc83d', '#19e3c9', '#4d8dff', '#fff', '#b46bff'];
  for (let i = 0; i < 160; i++) confetti.push({ x: Math.random() * W, y: -Math.random() * H, vx: (Math.random() - 0.5) * 60, vy: 90 + Math.random() * 160, r: Math.random() * TAU, vr: (Math.random() - 0.5) * 10, c: cols[i % cols.length] });
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
  const t = now / 1000;
  if (preview.open) drawPreview(now, t);
  const r = S.room;
  if (!r || $('room').hidden || !bg) return;

  // countdown clock
  const tm = $('timer');
  if (r.phase === 'scramble') {
    const left = Math.max(0, Math.ceil((r.remain - (now - r.at)) / 1000));
    tm.hidden = false; tm.textContent = left; tm.classList.toggle('low', left <= 5);
  } else tm.hidden = true;

  const idle = r.phase === 'lobby' || r.phase === 'gameover';
  if (r.phase === 'music') spin += dt * 0.6; else if (idle) spin += dt * 0.14;

  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  g.drawImage(bg, 0, 0, W, H);
  const { cx, cy, RX, RY, s } = L;

  // marquee bulbs around the floor
  const NB = 44, chase = Math.floor(t * (r.phase === 'music' ? 9 : r.phase === 'scramble' ? 14 : 2.5));
  for (let i = 0; i < NB; i++) {
    const a = (i / NB) * TAU, lit = r.phase === 'scramble' ? (i + chase) % 2 === 0 : (i + chase) % 4 === 0;
    g.fillStyle = lit ? (r.phase === 'scramble' ? '#ff5a6e' : '#fff3b0') : '#7a5a14';
    if (lit) { g.shadowColor = g.fillStyle; g.shadowBlur = 12; }
    ellipse(g, cx + Math.cos(a) * RX * 1.22, cy + Math.sin(a) * RY * 1.6, 4.5 * s, 4.5 * s); g.fill(); g.shadowBlur = 0;
  }
  // sweeping spotlights
  g.save(); g.globalCompositeOperation = 'lighter';
  const spots = [['255,200,61', 0], ['255,61,129', 2.1], ['25,227,201', 4.2]];
  spots.forEach(([col, ph], i) => {
    const sp = r.phase === 'music' ? 1.4 : 0.45;
    const tx = cx + Math.sin(t * sp * 0.7 + ph) * RX * 0.95, ty = cy + Math.cos(t * sp * 0.5 + ph) * RY * 0.7, x0 = W * (0.2 + i * 0.3);
    const gr = g.createLinearGradient(x0, 0, tx, ty); gr.addColorStop(0, `rgba(${col},.28)`); gr.addColorStop(1, `rgba(${col},.05)`);
    g.fillStyle = gr; g.beginPath(); g.moveTo(x0 - 8, -5); g.lineTo(x0 + 8, -5); g.lineTo(tx + 70 * s, ty); g.lineTo(tx - 70 * s, ty); g.fill();
    g.fillStyle = `rgba(${col},.13)`; ellipse(g, tx, ty, 72 * s, 24 * s); g.fill();
  });
  g.restore();

  // work out where everyone should be
  const onStage = r.players.filter((p) => (idle ? true : p.inGame && p.alive));
  const audience = r.players.filter((p) => !onStage.includes(p));
  const nCh = r.chairs.length, items = [];
  const seen = new Set();
  const place = (p, tx, ty, mode, sc) => {
    seen.add(p.id);
    let e = ents.get(p.id);
    if (!e) { e = { x: tx, y: ty, emotes: [], deathAt: 0, missAt: 0, claimAt: 0, sc }; ents.set(p.id, e); }
    const dying = e.deathAt && now - e.deathAt < DEATH_MS;
    if (!dying) {
      if (e.deathAt) { e.deathAt = 0; e.x = tx; e.y = ty; } // exit finished: hop to the audience
      const f = Math.min(1, dt * (mode === 'ring' ? 9 : 6));
      e.x += (tx - e.x) * f; e.y += (ty - e.y) * f; e.sc = sc; e.mode = mode;
    }
    items.push({ y: e.y + (mode === 'sit' ? 19 * L.s : 0), p, e, dying });
  };
  onStage.forEach((p, i) => {
    if (r.phase === 'gameover' && p.id === r.winner) return place(p, cx, cy + 6 * s, 'ring', s * 1.25);
    if (p.seat != null && nCh) { const c = chairPos(p.seat, nCh); return place(p, c.x, c.y - 18 * s, 'sit', s); }
    if (r.phase === 'scramble' && p.pick != null && nCh && r.chairs[p.pick]) {
      const c = chairPos(p.pick, nCh), a = (nCh <= 1 ? 0 : c.a) + (sr(strHash(p.id), 1) - 0.5) * (nCh <= 1 ? TAU : 2.2);
      return place(p, c.x + Math.cos(a) * 54 * s, c.y + Math.sin(a) * 30 * s, 'pick', s);
    }
    const a = (i / onStage.length) * TAU + spin, y = cy + Math.sin(a) * RY;
    place(p, cx + Math.cos(a) * RX, y, 'ring', s * (0.86 + 0.28 * ((y - (cy - RY)) / (2 * RY))));
  });
  audience.forEach((p, i) => place(p, W - 34 - i * 46, H - 26, 'aud', 0.55));
  for (const id of ents.keys()) if (!seen.has(id)) ents.delete(id);

  r.chairs.forEach((c, i) => {
    const pos = chairPos(i, nCh);
    items.push({ y: pos.y, chair: i, pos, st: { free: r.phase === 'scramble' && !c.owner, sel: r.phase === 'scramble' && S.myPick === i && !c.owner } });
  });
  items.sort((a, b) => a.y - b.y);

  const E = { top: 0, right: W, w: W, h: H };
  for (const it of items) {
    if (it.chair != null) { drawChair(g, it.pos.x, it.pos.y, s, it.chair, it.st, t); continue; }
    const { p, e } = it, isMe = p.id === S.me.id;
    if (it.dying) {
      const k = (now - e.deathAt) / DEATH_MS;
      const a = { x: e.x, y: e.y, sc: e.sc, seed: strHash(p.id) % 1000, draw: (o) => drawAvatar(g, e.x, e.y, e.sc, p, t, o) };
      (DEATHS[e.deathKind] || DEATHS.poof)(g, a, clamp(k, 0, 1), E);
      continue;
    }
    const moving = e.mode === 'ring' && (idle || r.phase === 'music');
    const hop = e.claimAt && now - e.claimAt < 500 ? -Math.sin(((now - e.claimAt) / 500) * Math.PI) * 18 * s : 0;
    drawAvatar(g, e.x, e.y, e.sc, p, t, { moving, sit: e.mode === 'sit', dy: hop, alpha: e.mode === 'aud' ? 0.9 : 1 });
    if (e.mode !== 'aud') drawTag(g, e.x, e.y, e.sc, p, isMe);
    if (e.missAt && now - e.missAt < 800) {
      const k = (now - e.missAt) / 800;
      g.globalAlpha = 1 - k; g.fillStyle = '#ff3b53'; g.font = `${30 * e.sc}px ${FONT_D}`; g.textAlign = 'center';
      g.fillText('✗', e.x + Math.sin(k * 30) * 4, e.y - 96 * e.sc - k * 14); g.globalAlpha = 1;
    }
  }
  // emote bubbles float above everything
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const e of ents.values()) {
    e.emotes = e.emotes.filter((m) => now - m.at < 2300);
    e.emotes.forEach((m) => {
      const k = (now - m.at) / 2300, pop = Math.min(1, k * 8), sz = Math.max(22, 34 * e.sc) * (0.4 + 0.6 * pop);
      const ex = e.x + Math.sin(k * 9 + m.at) * 8, ey = e.y - 104 * e.sc - k * 46;
      g.globalAlpha = k > 0.75 ? (1 - k) / 0.25 : 1;
      g.fillStyle = '#fff'; ellipse(g, ex, ey, sz * 0.72, sz * 0.72); g.fill();
      g.font = `${sz}px ${FONT_B}`; g.fillText(m.e, ex, ey + 2);
    });
    g.globalAlpha = 1;
  }
  if (audience.length) { g.font = `700 11px ${FONT_B}`; g.textAlign = 'right'; g.fillStyle = 'rgba(255,243,214,.6)'; g.fillText('AUDIENCE', W - 12, H - 70); }

  if (confetti.length) {
    for (const c of confetti) {
      c.x += c.vx * dt; c.y += c.vy * dt; c.r += c.vr * dt;
      if (c.y > H + 20) { c.y = -20; c.x = Math.random() * W; }
      g.save(); g.translate(c.x, c.y); g.rotate(c.r); g.fillStyle = c.c; g.fillRect(-5, -3, 10, 6); g.restore();
    }
  }
}
cv.addEventListener('pointerdown', (ev) => {
  const r = S.room; if (!r || r.phase !== 'scramble') return;
  const b = cv.getBoundingClientRect(), x = ev.clientX - b.left, y = ev.clientY - b.top;
  let best = null, bd = 70 * L.s;
  r.chairs.forEach((c, i) => { if (c.owner) return; const p = chairPos(i, r.chairs.length), d = Math.hypot(p.x - x, p.y - 40 * L.s - y); if (d < bd) { bd = d; best = i; } });
  if (best != null) pickChair(best);
});

// wardrobe preview stage
const pcv = $('previewCanvas'), pg = pcv.getContext('2d');
function drawPreview(now, t) {
  const w = 260, h = 300, dpr = Math.min(2, devicePixelRatio || 1);
  if (pcv.width !== w * dpr) { pcv.width = w * dpr; pcv.height = h * dpr; }
  pg.setTransform(dpr, 0, 0, dpr, 0, 0); pg.clearRect(0, 0, w, h);
  const p = { ...S.me, dance: preview.dance, ring: preview.ring, hue: hueOf(S.me.id) };
  const x = w / 2, y = h * 0.8, sc = 1.7;
  pg.fillStyle = 'rgba(255,200,61,.18)'; ellipse(pg, x, y, 90, 26); pg.fill();
  const age = now - preview.deathAt;
  if (preview.deathAt && age < DEATH_MS) {
    const a = { x, y, sc, seed: 42, draw: (o) => drawAvatar(pg, x, y, sc, p, t, o) };
    DEATHS[preview.death](pg, a, age / DEATH_MS, { top: 0, right: w, w, h });
  } else if (!preview.deathAt || age > DEATH_MS + 500) drawAvatar(pg, x, y, sc, p, t, { moving: true });
}

addEventListener('beforeunload', () => { try { ws.close(); } catch {} });
requestAnimationFrame(frame);
connect();
})();
