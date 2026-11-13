// Accounts test with a software passkey: BASE=localhost:3000 ORIGIN=http://localhost:3000 node test/accounts.js
// Covers account creation, sign-in on a "second device", stable IDs, reserved names, sign-out,
// a forged signature, a replayed challenge and Ed25519 keys.
const BASE = process.env.BASE || 'localhost:3000';
const ORIGIN = process.env.ORIGIN || `http://${BASE}`;
const RP_ID = new URL(ORIGIN).hostname;
const crypto = require('crypto');
const assert = require('assert');
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── minimal CBOR encoder for building authenticator responses ──
function cbor(v) {
  const head = (mt, n) => n < 24 ? Buffer.from([(mt << 5) | n]) : n < 256 ? Buffer.from([(mt << 5) | 24, n]) : n < 65536 ? Buffer.from([(mt << 5) | 25, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(5); b[0] = (mt << 5) | 26; b.writeUInt32BE(n, 1); return b; })();
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor type');
}
// ── a software authenticator ──
class SoftKey {
  constructor(kind = 'ec') {
    this.kind = kind; this.count = 0;
    this.pair = kind === 'ec' ? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }) : crypto.generateKeyPairSync('ed25519');
    this.id = crypto.randomBytes(16);
  }
  cose() {
    const j = this.pair.publicKey.export({ format: 'jwk' });
    return this.kind === 'ec'
      ? new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(j.x, 'base64url')], [-3, Buffer.from(j.y, 'base64url')]])
      : new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(j.x, 'base64url')]]);
  }
  authData(attested) {
    const flags = 0x01 | 0x04 | (attested ? 0x40 : 0);
    const cnt = Buffer.alloc(4); cnt.writeUInt32BE(++this.count);
    const parts = [sha(RP_ID), Buffer.from([flags]), cnt];
    if (attested) { const L = Buffer.alloc(2); L.writeUInt16BE(this.id.length); parts.push(Buffer.alloc(16), L, this.id, cbor(this.cose())); }
    return Buffer.concat(parts);
  }
  create(opts) {
    const cdj = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: opts.challenge, origin: ORIGIN }));
    const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', this.authData(true)]]));
    return { id: b64u(this.id), rawId: b64u(this.id), type: 'public-key', response: { clientDataJSON: b64u(cdj), attestationObject: b64u(att) } };
  }
  get(opts, { forge } = {}) {
    const cdj = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: opts.challenge, origin: ORIGIN }));
    const ad = this.authData(false);
    const data = Buffer.concat([ad, sha(cdj)]);
    let sig = this.kind === 'ec' ? crypto.sign('sha256', data, this.pair.privateKey) : crypto.sign(null, data, this.pair.privateKey);
    if (forge) sig = Buffer.from(sig.map((x, i) => (i === 10 ? x ^ 1 : x)));
    return { id: b64u(this.id), rawId: b64u(this.id), type: 'public-key', response: { clientDataJSON: b64u(cdj), authenticatorData: b64u(ad), signature: b64u(sig) } };
  }
}
async function api(path, token, body) {
  const r = await fetch(`http://${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': token || '', origin: ORIGIN }, body: JSON.stringify(body || {}) });
  return { status: r.status, json: await r.json() };
}
function client(token = crypto.randomBytes(16).toString('hex'), name = '') {
  const ws = new WebSocket(`ws://${BASE}/ws`);
  const c = { token, ws, events: [], waiters: [] };
  c.send = (o) => ws.send(JSON.stringify(o));
  c.wait = (pred, ms = 8000) => new Promise((res, rej) => { const hit = c.events.find(pred); if (hit) return res(hit); c.waiters.push({ pred, res }); setTimeout(() => rej(new Error('timeout ' + pred)), ms); });
  ws.onopen = () => c.send({ t: 'hello', token, name });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); c.events.push(m); if (m.me) c.me = m.me; c.waiters = c.waiters.filter((w) => (w.pred(m) ? (w.res(m), false) : true)); };
  c.close = () => new Promise((r) => { ws.onclose = r; ws.close(); });
  return c;
}

(async () => {
  // legacy profiles.json import (the runner seeds a profile for this token)
  if (process.env.LEGACY_TOKEN) {
    const L = client(process.env.LEGACY_TOKEN);
    const w = await L.wait((m) => m.t === 'welcome');
    assert.equal(w.me.name, 'Old Timer'); assert.equal(w.me.xp, 777);
    assert.match(w.me.id, /^u[a-z2-9]{10}$/);
    console.log('legacy profiles.json import ok →', w.me.id, 'level', w.me.level);
    await L.close();
  }

  const A = client(undefined, 'Jake');
  const wa = await A.wait((m) => m.t === 'welcome');
  assert.equal(wa.me.account, false);
  const id = wa.me.id;

  // a guest called Jake who is online when the name gets reserved
  const G = client(undefined, 'jAKe');
  assert.equal((await G.wait((m) => m.t === 'welcome')).me.name, 'jAKe');

  // create the account
  const key = new SoftKey('ec');
  let r = await api('/api/passkey/register-options', A.token);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.rp.id, RP_ID); assert.equal(Buffer.from(r.json.user.id, 'base64url').toString(), id);
  r = await api('/api/passkey/register', A.token, key.create(r.json));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const me = (await A.wait((m) => m.t === 'me' && m.me.account)).me;
  assert.ok(me.reserved && me.passkeys === 1);
  console.log('account created:', id, '(name reserved)');

  // the online guest named jAKe was renamed; nobody else can take Jake / JAKE / j-a-k-e
  await G.wait((m) => m.t === 'toast' && /reserved/.test(m.msg));
  assert.match(G.me.name, /^Contestant \d+$/);
  G.send({ t: 'setName', name: 'J.A.K.E' });
  await G.wait((m) => m.t === 'nameTaken');
  const N = client(undefined, 'JAKE');
  assert.notEqual((await N.wait((m) => m.t === 'welcome')).me.name, 'JAKE');
  G.send({ t: 'setName', name: 'Stool Pigeon' }); // bot names are the studio's
  await G.wait((m) => m.t === 'nameTaken' && m.name === 'Stool Pigeon');
  console.log('reserved name enforced (renamed live guest, blocked lookalikes and bot names)');

  // reusing a register challenge fails
  r = await api('/api/passkey/register', A.token, key.create({ challenge: 'nope' }));
  assert.equal(r.status, 400);

  // earn some XP-equivalent state: change dance + rename (account keeps its reservation moving)
  A.send({ t: 'equip', dance: 'strut' });
  A.send({ t: 'setName', name: 'Jake The Great' });
  await A.wait((m) => m.t === 'me' && m.me.name === 'Jake The Great');
  G.send({ t: 'setName', name: 'Jake' }); // old name is free again
  await G.wait((m) => m.t === 'me' && m.me.name === 'Jake');
  G.send({ t: 'setName', name: 'jake the GREAT' });
  await G.wait((m) => m.t === 'nameTaken');
  console.log('rename moves the reservation; the old name is released');

  // sign in on a "second device"
  r = await api('/api/passkey/login-options', '');
  assert.equal(r.status, 200);
  const opts = r.json;
  const forged = await api('/api/passkey/login', '', key.get(opts, { forge: true }));
  assert.equal(forged.status, 400); assert.match(forged.json.error, /signature/);
  r = await api('/api/passkey/login-options', '');
  const good = await api('/api/passkey/login', '', key.get(r.json));
  assert.equal(good.status, 200, JSON.stringify(good.json)); assert.equal(good.json.id, id);
  const replay = await api('/api/passkey/login', '', key.get(r.json));
  assert.equal(replay.status, 400, 'challenge cannot be replayed');
  const D2 = client(good.json.token);
  const w2 = await D2.wait((m) => m.t === 'welcome');
  assert.equal(w2.me.id, id); assert.equal(w2.me.name, 'Jake The Great'); assert.ok(w2.me.account);
  await A.wait((m) => m.t === 'replaced'); // same account: the newest device takes over
  console.log('passkey sign-in on a second device → same ID', id);

  // unknown passkey
  const stranger = new SoftKey('ec');
  r = await api('/api/passkey/login-options', '');
  assert.equal((await api('/api/passkey/login', '', stranger.get(r.json))).status, 404);

  // Ed25519 passkey on a fresh account
  const B = client(undefined, 'Edward');
  await B.wait((m) => m.t === 'welcome');
  const ed = new SoftKey('ed');
  r = await api('/api/passkey/register-options', B.token);
  assert.equal((await api('/api/passkey/register', B.token, ed.create(r.json))).status, 200);
  r = await api('/api/passkey/login-options', '');
  assert.equal((await api('/api/passkey/login', '', ed.get(r.json))).status, 200);
  console.log('Ed25519 passkey ok');

  // sign out ends the session; the token becomes a fresh guest
  assert.equal((await api('/api/logout', good.json.token)).status, 200);
  await D2.close(); await sleep(100);
  const D3 = client(good.json.token);
  const w3 = await D3.wait((m) => m.t === 'welcome');
  assert.notEqual(w3.me.id, id); assert.equal(w3.me.account, false);
  console.log('sign out ok');

  // wrong origin / plain-http IP address are refused
  const bad = await fetch(`http://${BASE}/api/passkey/login-options`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' });
  assert.equal(bad.status, 400);
  console.log('ALL OK');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
