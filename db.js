'use strict';
/*
 * SIT SHOW — player storage in a single SQLite file (Node's built-in node:sqlite).
 * players      one row per player; `id` is the permanent account/guest ID (names can change)
 * sessions     hashed browser tokens → player
 * credentials  passkeys (public keys only) → player
 * name_key     the reserved, normalised name of an account; unique across all players
 */
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function newPlayerId() {
  const b = crypto.randomBytes(10);
  let s = 'u';
  for (let i = 0; i < 10; i++) s += ID_ALPHABET[b[i] % ID_ALPHABET.length];
  return s;
}
/** Two names clash if they normalise to the same key: "Jake", "JAKE", "j a k e!" and "Ｊａｋｅ" are one name. */
function nameKey(name) {
  return String(name || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 32);
}
const tokenHash = (token) => crypto.createHash('sha256').update('session:' + token).digest('hex');
const legacyKey = (token) => crypto.createHash('sha256').update('profile:' + token).digest('hex');

function openDb(file, legacyJson) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS players (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      name_key  TEXT,
      xp        INTEGER NOT NULL DEFAULT 0,
      dance     TEXT NOT NULL DEFAULT 'strut',
      death     TEXT NOT NULL DEFAULT 'poof',
      ring      TEXT NOT NULL DEFAULT 'none',
      account   INTEGER NOT NULL DEFAULT 0,
      created   INTEGER NOT NULL,
      seen      INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS players_name_key ON players(name_key) WHERE name_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      created    INTEGER NOT NULL,
      seen       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_player ON sessions(player_id);
    CREATE TABLE IF NOT EXISTS credentials (
      id         TEXT PRIMARY KEY,
      player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      jwk        TEXT NOT NULL,
      alg        INTEGER NOT NULL,
      sign_count INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      created    INTEGER NOT NULL,
      last_used  INTEGER
    );
    CREATE INDEX IF NOT EXISTS credentials_player ON credentials(player_id);
    CREATE TABLE IF NOT EXISTS legacy_profiles (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS daily_scores (
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      day       TEXT NOT NULL,
      points    INTEGER NOT NULL DEFAULT 0,
      wins      INTEGER NOT NULL DEFAULT 0,
      games     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (player_id, day)
    );
    CREATE INDEX IF NOT EXISTS daily_scores_day ON daily_scores(day, points DESC);
    CREATE TABLE IF NOT EXISTS achievements (
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      ach_id    TEXT NOT NULL,
      at        INTEGER NOT NULL,
      PRIMARY KEY (player_id, ach_id)
    );
    CREATE TABLE IF NOT EXISTS music_gain (path TEXT PRIMARY KEY, size INTEGER, mtime INTEGER, lufs REAL, gain REAL);
  `);
  // columns added after the first release
  const cols = new Set(db.prepare('PRAGMA table_info(players)').all().map((c) => c.name));
  if (!cols.has('stats')) db.exec("ALTER TABLE players ADD COLUMN stats TEXT NOT NULL DEFAULT '{}'");

  // one-time import of the old profiles.json (rows are claimed when that browser next connects)
  if (legacyJson && fs.existsSync(legacyJson)) {
    try {
      const old = JSON.parse(fs.readFileSync(legacyJson, 'utf8')) || {};
      const ins = db.prepare('INSERT OR IGNORE INTO legacy_profiles (key, data) VALUES (?, ?)');
      db.exec('BEGIN');
      for (const [k, v] of Object.entries(old)) if (v && typeof v === 'object') ins.run(k, JSON.stringify(v));
      db.exec('COMMIT');
      fs.renameSync(legacyJson, legacyJson + '.migrated');
      console.log(`Imported ${Object.keys(old).length} profiles from ${legacyJson} into the database`);
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} console.warn('Could not import profiles.json:', e.message); }
  }

  const now = () => Date.now();
  // tidy up: guests who never earned anything and haven't been seen for 30 days
  db.prepare('DELETE FROM players WHERE account = 0 AND xp = 0 AND seen < ?').run(now() - 30 * 86400e3);
  db.prepare('DELETE FROM daily_scores WHERE day < ?').run(new Date(now() - 400 * 86400e3).toISOString().slice(0, 10));

  const q = {
    sessionPlayer: db.prepare('SELECT p.* FROM sessions s JOIN players p ON p.id = s.player_id WHERE s.token_hash = ?'),
    touchSession: db.prepare('UPDATE sessions SET seen = ? WHERE token_hash = ?'),
    addSession: db.prepare('INSERT OR REPLACE INTO sessions (token_hash, player_id, created, seen) VALUES (?, ?, ?, ?)'),
    delSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    legacy: db.prepare('SELECT data FROM legacy_profiles WHERE key = ?'),
    delLegacy: db.prepare('DELETE FROM legacy_profiles WHERE key = ?'),
    addPlayer: db.prepare('INSERT INTO players (id, name, xp, dance, death, ring, created, seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    savePlayer: db.prepare('UPDATE players SET name = ?, xp = ?, dance = ?, death = ?, ring = ?, stats = ?, seen = ? WHERE id = ?'),
    addScore: db.prepare(`INSERT INTO daily_scores (player_id, day, points, wins, games) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT (player_id, day) DO UPDATE SET points = points + excluded.points, wins = wins + excluded.wins, games = games + 1`),
    topLevels: db.prepare('SELECT id, name, xp, account FROM players WHERE xp > 0 ORDER BY xp DESC, created ASC LIMIT ?'),
    rankLevel: db.prepare('SELECT COUNT(*) + 1 AS r FROM players WHERE xp > ?'),
    topDay: db.prepare(`SELECT s.player_id AS id, p.name, p.account, p.xp, s.points, s.wins, s.games FROM daily_scores s
      JOIN players p ON p.id = s.player_id WHERE s.day = ? ORDER BY s.points DESC, s.wins DESC LIMIT ?`),
    dayRow: db.prepare('SELECT points, wins, games FROM daily_scores WHERE player_id = ? AND day = ?'),
    rankDay: db.prepare('SELECT COUNT(*) + 1 AS r FROM daily_scores WHERE day = ? AND points > ?'),
    achs: db.prepare('SELECT ach_id, at FROM achievements WHERE player_id = ? ORDER BY at'),
    unlock: db.prepare('INSERT OR IGNORE INTO achievements (player_id, ach_id, at) VALUES (?, ?, ?)'),
    gainGet: db.prepare('SELECT * FROM music_gain WHERE path = ?'),
    gainSet: db.prepare('INSERT OR REPLACE INTO music_gain (path, size, mtime, lufs, gain) VALUES (?, ?, ?, ?, ?)'),
    setAccount: db.prepare('UPDATE players SET account = 1, name_key = ? WHERE id = ?'),
    setNameKey: db.prepare('UPDATE players SET name_key = ? WHERE id = ?'),
    nameOwner: db.prepare('SELECT id FROM players WHERE name_key = ?'),
    creds: db.prepare('SELECT * FROM credentials WHERE player_id = ?'),
    cred: db.prepare('SELECT * FROM credentials WHERE id = ?'),
    addCred: db.prepare('INSERT INTO credentials (id, player_id, jwk, alg, sign_count, transports, created) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    useCred: db.prepare('UPDATE credentials SET sign_count = ?, last_used = ? WHERE id = ?'),
    player: db.prepare('SELECT * FROM players WHERE id = ?'),
  };

  return {
    db, nameKey, tokenHash, newPlayerId,
    /** Find (or create) the player behind a browser token. */
    playerForToken(token, wantName, nameOk) {
      const th = tokenHash(token);
      let row = q.sessionPlayer.get(th);
      if (row) { q.touchSession.run(now(), th); return row; }
      const lk = legacyKey(token), old = q.legacy.get(lk);
      const data = old ? JSON.parse(old.data) : {};
      const id = newPlayerId();
      let name = data.name || wantName || '';
      if (!name || !nameOk(name, id)) name = 'Contestant ' + (1000 + crypto.randomInt(9000));
      q.addPlayer.run(id, name, data.xp | 0, data.dance || 'strut', data.death || 'poof', data.ring || 'none', now(), now());
      q.addSession.run(th, id, now(), now());
      if (old) q.delLegacy.run(lk);
      return q.player.get(id);
    },
    newSession(playerId) {
      const token = crypto.randomBytes(16).toString('hex');
      q.addSession.run(tokenHash(token), playerId, now(), now());
      return token;
    },
    endSession(token) { q.delSession.run(tokenHash(token)); },
    save(p) { q.savePlayer.run(p.name, p.xp, p.dance, p.death, p.ring, JSON.stringify(p.stats || {}), now(), p.id); },
    addScore(id, day, points, won) { q.addScore.run(id, day, points, won ? 1 : 0); },
    topLevels(n) { return q.topLevels.all(n); },
    rankLevel(xp) { return q.rankLevel.get(xp).r; },
    topDay(day, n) { return q.topDay.all(day, n); },
    dayRow(id, day) { return q.dayRow.get(id, day) || null; },
    rankDay(day, points) { return q.rankDay.get(day, points).r; },
    achievements(id) { return q.achs.all(id); },
    unlock(id, ach) { return q.unlock.run(id, ach, now()).changes > 0; },
    gain(path) { return q.gainGet.get(path) || null; },
    setGain(path, size, mtime, lufs, gain) { q.gainSet.run(path, size, mtime, lufs, gain); },
    player(id) { return q.player.get(id); },
    nameOwner(key) { return key ? q.nameOwner.get(key)?.id || null : null; },
    /** Reserve `key` for an account. Returns false if another player holds it. */
    reserve(id, key) {
      try { q.setNameKey.run(key || null, id); return true; } catch { return false; }
    },
    makeAccount(id, key) {
      try { q.setAccount.run(key || null, id); return true; } catch { return false; }
    },
    credentials(playerId) { return q.creds.all(playerId); },
    credential(id) { return q.cred.get(id); },
    addCredential(c) { q.addCred.run(c.id, c.playerId, JSON.stringify(c.jwk), c.alg, c.signCount, c.transports ? JSON.stringify(c.transports) : null, now()); },
    useCredential(id, signCount) { q.useCred.run(signCount, now(), id); },
    close() { try { db.close(); } catch {} },
  };
}

module.exports = { openDb, nameKey };
