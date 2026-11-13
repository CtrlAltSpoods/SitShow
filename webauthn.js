'use strict';
/*
 * SIT SHOW — minimal WebAuthn (passkey) verification with no dependencies.
 * Registration: checks clientData + authenticator data and extracts the public key
 *               (attestation statements are not checked: "none" attestation, like most sites).
 * Login:        checks clientData, authenticator data and the signature with the stored key.
 * Supported keys: ES256 / ES384 / ES512 (EC2), RS256 (RSA), EdDSA (Ed25519).
 */
const crypto = require('crypto');

const b64u = {
  enc: (b) => Buffer.from(b).toString('base64url'),
  dec: (s) => Buffer.from(String(s || ''), 'base64url'),
};
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

// ── tiny CBOR decoder (enough for attestation objects and COSE keys) ──
function cborDecode(buf) {
  let i = 0;
  const need = (n) => { if (i + n > buf.length) throw new Error('CBOR: truncated'); };
  const len = (ai) => {
    if (ai < 24) return ai;
    if (ai === 24) { need(1); return buf[i++]; }
    if (ai === 25) { need(2); const v = buf.readUInt16BE(i); i += 2; return v; }
    if (ai === 26) { need(4); const v = buf.readUInt32BE(i); i += 4; return v; }
    if (ai === 27) { need(8); const v = Number(buf.readBigUInt64BE(i)); i += 8; return v; }
    throw new Error('CBOR: indefinite lengths not supported');
  };
  let depth = 0;
  const item = () => {
    need(1);
    if (++depth > 32) throw new Error('CBOR: too deep');
    const b = buf[i++], mt = b >> 5, ai = b & 31;
    let out;
    switch (mt) {
      case 0: out = len(ai); break;
      case 1: out = -1 - len(ai); break;
      case 2: { const n = len(ai); need(n); out = buf.subarray(i, i + n); i += n; break; }
      case 3: { const n = len(ai); need(n); out = buf.toString('utf8', i, i + n); i += n; break; }
      case 4: { const n = len(ai); out = []; for (let k = 0; k < n; k++) out.push(item()); break; }
      case 5: { const n = len(ai); out = new Map(); for (let k = 0; k < n; k++) { const key = item(); out.set(key, item()); } break; }
      case 6: len(ai); out = item(); break; // tag: ignore it, keep the value
      case 7:
        if (ai === 20) out = false; else if (ai === 21) out = true; else if (ai === 22 || ai === 23) out = null;
        else if (ai === 26) { need(4); out = buf.readFloatBE(i); i += 4; }
        else if (ai === 27) { need(8); out = buf.readDoubleBE(i); i += 8; }
        else throw new Error('CBOR: unsupported simple value');
        break;
    }
    depth--;
    return out;
  };
  const value = item();
  return { value, end: i };
}

function parseAuthData(ad) {
  if (!Buffer.isBuffer(ad) || ad.length < 37) throw new Error('authenticator data too short');
  const flags = ad[32];
  const out = { rpIdHash: ad.subarray(0, 32), flags, up: !!(flags & 0x01), uv: !!(flags & 0x04), signCount: ad.readUInt32BE(33) };
  if (flags & 0x40) { // attested credential data
    let o = 37 + 16; // skip AAGUID
    if (ad.length < o + 2) throw new Error('bad attested credential data');
    const L = ad.readUInt16BE(o); o += 2;
    if (ad.length < o + L) throw new Error('bad credential id');
    out.credId = ad.subarray(o, o + L); o += L;
    out.cose = cborDecode(ad.subarray(o)).value;
  }
  return out;
}

const HASH = { '-7': 'sha256', '-35': 'sha384', '-36': 'sha512', '-257': 'sha256', '-8': null };
function coseToJwk(m) {
  if (!(m instanceof Map)) throw new Error('bad public key');
  const kty = m.get(1), alg = m.get(3);
  if (kty === 2) {
    const crv = { 1: 'P-256', 2: 'P-384', 3: 'P-521' }[m.get(-1)];
    if (!crv) throw new Error('unsupported curve');
    return { jwk: { kty: 'EC', crv, x: b64u.enc(m.get(-2)), y: b64u.enc(m.get(-3)) }, alg: alg ?? { 'P-256': -7, 'P-384': -35, 'P-521': -36 }[crv] };
  }
  if (kty === 3) return { jwk: { kty: 'RSA', n: b64u.enc(m.get(-1)), e: b64u.enc(m.get(-2)) }, alg: alg ?? -257 };
  if (kty === 1 && m.get(-1) === 6) return { jwk: { kty: 'OKP', crv: 'Ed25519', x: b64u.enc(m.get(-2)) }, alg: -8 };
  throw new Error('unsupported key type');
}

function checkClientData(raw, type, expect) {
  let cd;
  try { cd = JSON.parse(raw.toString('utf8')); } catch { throw new Error('bad client data'); }
  if (cd.type !== type) throw new Error('wrong ceremony type');
  if (cd.challenge !== expect.challenge) throw new Error('challenge mismatch');
  if (cd.origin !== expect.origin) throw new Error(`origin mismatch (${cd.origin})`);
  return cd;
}
function checkAuthData(ad, expect) {
  if (!crypto.timingSafeEqual(ad.rpIdHash, sha256(expect.rpId))) throw new Error('relying party mismatch');
  if (!ad.up) throw new Error('user presence not confirmed');
}

/** Verify navigator.credentials.create() output. Returns the credential to store. */
function verifyRegistration(body, expect) {
  const r = body && body.response; if (!r) throw new Error('missing response');
  const cdj = b64u.dec(r.clientDataJSON);
  checkClientData(cdj, 'webauthn.create', expect);
  const att = cborDecode(b64u.dec(r.attestationObject)).value;
  if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) throw new Error('bad attestation object');
  const ad = parseAuthData(att.get('authData'));
  checkAuthData(ad, expect);
  if (!ad.credId || !ad.cose) throw new Error('no credential in response');
  const { jwk, alg } = coseToJwk(ad.cose);
  if (!(String(alg) in HASH)) throw new Error('unsupported algorithm');
  crypto.createPublicKey({ key: jwk, format: 'jwk' }); // throws if the key is malformed
  const transports = Array.isArray(body.transports) ? body.transports.filter((t) => typeof t === 'string').slice(0, 6) : null;
  return { id: b64u.enc(ad.credId), jwk, alg, signCount: ad.signCount, transports };
}

/** Verify navigator.credentials.get() output against a stored credential. Returns the new sign count. */
function verifyAssertion(body, stored, expect) {
  const r = body && body.response; if (!r) throw new Error('missing response');
  const cdj = b64u.dec(r.clientDataJSON), adRaw = b64u.dec(r.authenticatorData), sig = b64u.dec(r.signature);
  checkClientData(cdj, 'webauthn.get', expect);
  const ad = parseAuthData(adRaw);
  checkAuthData(ad, expect);
  const key = crypto.createPublicKey({ key: JSON.parse(stored.jwk), format: 'jwk' });
  const data = Buffer.concat([adRaw, sha256(cdj)]);
  const alg = String(stored.alg);
  if (!(alg in HASH)) throw new Error('unsupported algorithm');
  const ok = key.asymmetricKeyType === 'ec'
    ? crypto.verify(HASH[alg], data, { key, dsaEncoding: 'der' }, sig)
    : crypto.verify(HASH[alg], data, key, sig);
  if (!ok) throw new Error('signature check failed');
  if (ad.signCount && stored.sign_count && ad.signCount <= stored.sign_count) throw new Error('passkey counter went backwards (possible clone)');
  return ad.signCount;
}

/** The challenge a client signed, so the server can find the matching pending login. */
function challengeOf(body) {
  try { return JSON.parse(b64u.dec(body.response.clientDataJSON).toString('utf8')).challenge || null; } catch { return null; }
}

module.exports = { b64u, cborDecode, parseAuthData, coseToJwk, verifyRegistration, verifyAssertion, challengeOf };
