'use strict';
/*
 * SIT SHOW — achievements. `check(stats, level, ctx)` is evaluated after a seat, an emote,
 * or the end of a show; ctx carries one-off facts about that moment.
 * stats: games wins seats streak bestStreak fastest(ms) trivia action emotes hosted finals flawless topDay
 */
const ACHIEVEMENTS = [
  { id: 'first_show', icon: '🎬', name: 'Opening Night', desc: 'Play your first show', check: (s) => s.games >= 1 },
  { id: 'first_seat', icon: '🪑', name: 'Take a Seat', desc: 'Grab your first chair', check: (s) => s.seats >= 1 },
  { id: 'first_win', icon: '🏆', name: 'Champion', desc: 'Win a show', check: (s) => s.wins >= 1 },
  { id: 'final_two', icon: '⚔️', name: 'Final Two', desc: 'Make it to the final', check: (s) => s.finals >= 1 },
  { id: 'quick_draw', icon: '⚡', name: 'Quick Draw', desc: 'Grab a chair within 3 seconds of the music stopping', check: (s) => s.fastest > 0 && s.fastest <= 3000 },
  { id: 'lightning', icon: '🌩️', name: 'Lightning Bottom', desc: 'Grab a chair within 1.5 seconds', check: (s) => s.fastest > 0 && s.fastest <= 1500 },
  { id: 'flawless', icon: '💎', name: 'Flawless', desc: 'Win a show without a single wrong answer', check: (s) => s.flawless >= 1 },
  { id: 'hat_trick', icon: '🎩', name: 'Hat Trick', desc: 'Win 3 shows in a row', check: (s) => s.bestStreak >= 3 },
  { id: 'packed_house', icon: '🏟️', name: 'Packed House', desc: 'Win a show with 16 or more contestants', check: (s, l, c) => !!(c && c.won && c.field >= 16) },
  { id: 'wins_10', icon: '👑', name: 'Royalty', desc: 'Win 10 shows', check: (s) => s.wins >= 10 },
  { id: 'wins_50', icon: '🌟', name: 'Hall of Fame', desc: 'Win 50 shows', check: (s) => s.wins >= 50 },
  { id: 'seats_50', icon: '🛋️', name: 'Chair-ish the Moment', desc: 'Grab 50 chairs', check: (s) => s.seats >= 50 },
  { id: 'seats_250', icon: '🏭', name: 'Furniture Mogul', desc: 'Grab 250 chairs', check: (s) => s.seats >= 250 },
  { id: 'trivia_25', icon: '🧠', name: 'Know-It-All', desc: 'Win 25 chairs with trivia', check: (s) => s.trivia >= 25 },
  { id: 'action_25', icon: '🕹️', name: 'Button Masher', desc: 'Win 25 chairs in action games', check: (s) => s.action >= 25 },
  { id: 'games_25', icon: '📺', name: 'Regular', desc: 'Play 25 shows', check: (s) => s.games >= 25 },
  { id: 'games_100', icon: '🎟️', name: 'Season Ticket', desc: 'Play 100 shows', check: (s) => s.games >= 100 },
  { id: 'hosted_10', icon: '🎙️', name: 'Showrunner', desc: 'Host 10 shows', check: (s) => s.hosted >= 10 },
  { id: 'emotes_100', icon: '📣', name: 'Hype Machine', desc: 'Send 100 emotes', check: (s) => s.emotes >= 100 },
  { id: 'level_10', icon: '⭐', name: 'Rising Star', desc: 'Reach level 10', check: (s, level) => level >= 10 },
  { id: 'level_20', icon: '💫', name: 'Superstar', desc: 'Reach level 20', check: (s, level) => level >= 20 },
  { id: 'top_day', icon: '🥇', name: 'Star of the Day', desc: 'Top the daily leaderboard', check: (s) => s.topDay >= 1 },
];
const STAT_KEYS = ['games', 'wins', 'seats', 'streak', 'bestStreak', 'fastest', 'trivia', 'action', 'emotes', 'hosted', 'finals', 'flawless', 'topDay'];
function normStats(raw) {
  let s = raw;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch { s = {}; } }
  const out = {};
  for (const k of STAT_KEYS) out[k] = Number.isFinite(+s?.[k]) ? +s[k] : 0;
  return out;
}
const catalog = ACHIEVEMENTS.map(({ id, icon, name, desc }) => ({ id, icon, name, desc }));
module.exports = { ACHIEVEMENTS, catalog, normStats };
