'use strict';
/*
 * SIT SHOW — chair challenges.
 * Each generator returns { pub, answer?, kind } where `pub` is sent to every player and
 * `answer` stays on the server. kind: 'answer' (checked text), 'reaction' or 'mash' (tap games).
 */

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rnd(arr.length)];
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ───────────────────────────── data ─────────────────────────────
const WORDS = ['chair', 'music', 'dance', 'prize', 'lucky', 'buzzer', 'winner', 'encore', 'jingle', 'trophy', 'podium',
  'wizard', 'banjo', 'disco', 'funky', 'groove', 'rhythm', 'tempo', 'cushion', 'velvet', 'glitter', 'jackpot', 'sparkle',
  'wobble', 'giggle', 'panic', 'hurry', 'sofa', 'stool', 'bench', 'throne', 'rocket', 'zebra', 'pickle', 'waffle',
  'noodle', 'muffin', 'banana', 'cactus', 'dragon', 'pirate', 'ninja', 'robot', 'yodel', 'kazoo', 'tuba', 'confetti',
  'spotlight', 'curtain', 'applause', 'microphone', 'trumpet', 'popcorn', 'marshmallow', 'penguin', 'volcano'];
const EMOJI_SETS = [
  ['🍎', '🍌', '🍇', '🍓', '🍑', '🍍', '🥝', '🍒'],
  ['🐶', '🐱', '🐸', '🐵', '🦊', '🐼', '🐷', '🐮'],
  ['🚗', '🚕', '🚌', '🚲', '🚀', '🚂', '🛵', '🚁'],
  ['⚽', '🏀', '🏈', '🎾', '🏐', '🎱', '🏓', '🥊'],
  ['🍕', '🍔', '🌭', '🌮', '🍟', '🍩', '🥨', '🧀'],
  ['🎸', '🎺', '🎻', '🥁', '🎹', '🎷', '🪗', '🪘'],
];
const INKS = [['RED', '#ff4d5e'], ['BLUE', '#4d8dff'], ['GREEN', '#3ddc84'], ['YELLOW', '#ffd93d'], ['PINK', '#ff7ad9'], ['ORANGE', '#ff9a3d']];
const SPELLING = [
  ['necessary', 'neccessary', 'necesary', 'neccesary'],
  ['separate', 'seperate', 'separete', 'seprate'],
  ['definitely', 'definately', 'definitly', 'defenitely'],
  ['rhythm', 'rythm', 'rhythym', 'rhytm'],
  ['accommodate', 'accomodate', 'acommodate', 'accommadate'],
  ['embarrass', 'embarass', 'embarras', 'embaress'],
  ['calendar', 'calender', 'calandar', 'callendar'],
  ['tomorrow', 'tommorow', 'tomorow', 'tommorrow'],
  ['occasion', 'ocassion', 'occassion', 'ocasion'],
  ['restaurant', 'restaraunt', 'resturant', 'restuarant'],
  ['committee', 'commitee', 'comittee', 'committe'],
  ['millennium', 'millenium', 'milennium', 'millenniun'],
];
const PHRASES = ['sit down quick', 'musical chairs', 'the music stopped', 'grab a seat', 'nobody move', 'take a bow',
  'encore encore', 'hold that pose', 'pull up a chair', 'keep on dancing', 'last one standing', 'spin to win',
  'save me a seat', 'the crowd goes wild', 'lights camera action'];

// [target word, the one that rhymes, three that don't]
const RHYMES = [
  ['chair', 'bear', 'cheer', 'chain', 'chart'],
  ['show', 'glow', 'shoe', 'shout', 'cow'],
  ['seat', 'sheet', 'set', 'sit', 'sweat'],
  ['dance', 'chance', 'dunce', 'dense', 'danger'],
  ['clap', 'snap', 'clip', 'clop', 'club'],
  ['prize', 'surprise', 'press', 'price', 'prism'],
  ['stage', 'cage', 'stag', 'stagger', 'stack'],
  ['crowd', 'cloud', 'crown', 'crow', 'cord'],
  ['light', 'kite', 'lift', 'left', 'lit'],
  ['star', 'guitar', 'stair', 'store', 'stir'],
  ['beat', 'treat', 'bet', 'bit', 'boat'],
  ['song', 'strong', 'sung', 'sign', 'sang'],
];
// [first part, the word that completes it, three that don't]
const COMPOUNDS = [
  ['FOOT', 'BALL', 'CHAIR', 'CLOUD', 'SPOON'],
  ['SUN', 'FLOWER', 'TABLE', 'PENCIL', 'CARPET'],
  ['RAIN', 'BOW', 'FORK', 'CHAIR', 'BOTTLE'],
  ['TOOTH', 'BRUSH', 'CHAIR', 'LAMP', 'SOCK'],
  ['ARM', 'CHAIR', 'CLOUD', 'SPOON', 'GRASS'],
  ['BUTTER', 'FLY', 'CHAIR', 'MOON', 'BRICK'],
  ['POP', 'CORN', 'STAIR', 'BENCH', 'FLOOR'],
  ['STAR', 'FISH', 'PILLOW', 'KETTLE', 'SOCK'],
  ['SNOW', 'MAN', 'CUP', 'DESK', 'FORK'],
  ['DOOR', 'BELL', 'SPOON', 'GRAPE', 'CLOUD'],
  ['HIGH', 'CHAIR', 'SPOON', 'CARPET', 'GRAPE'],
  ['MOON', 'LIGHT', 'FORK', 'BRICK', 'SOCK'],
];
const ROMAN = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
const toRoman = (n) => { let s = ''; for (const [v, r] of ROMAN) while (n >= v) { s += r; n -= v; } return s; };
const SIMON = 4; // coloured pads

// Trivia: [question, correct, wrong, wrong, wrong]  or  [statement, true|false]
const TRIVIA = {
  geo: [
    ['What is the capital of Australia?', 'Canberra', 'Sydney', 'Melbourne', 'Perth'],
    ['What is the capital of Canada?', 'Ottawa', 'Toronto', 'Vancouver', 'Montreal'],
    ['What is the capital of New Zealand?', 'Wellington', 'Auckland', 'Christchurch', 'Queenstown'],
    ['What is the capital of Japan?', 'Tokyo', 'Kyoto', 'Osaka', 'Hiroshima'],
    ['What is the capital of Brazil?', 'Brasília', 'Rio de Janeiro', 'São Paulo', 'Salvador'],
    ['Which is the largest ocean?', 'Pacific', 'Atlantic', 'Indian', 'Arctic'],
    ['Mount Everest sits on the border of Nepal and which country?', 'China', 'India', 'Bhutan', 'Pakistan'],
    ['What is the smallest country in the world?', 'Vatican City', 'Monaco', 'San Marino', 'Malta'],
    ['What is the largest hot desert in the world?', 'Sahara', 'Gobi', 'Kalahari', 'Arabian'],
    ['Uluru is in which part of Australia?', 'Northern Territory', 'Queensland', 'South Australia', 'Western Australia'],
    ['Which country is shaped like a boot?', 'Italy', 'Greece', 'Spain', 'Portugal'],
    ['Most of Egypt is on which continent?', 'Africa', 'Asia', 'Europe', 'Oceania'],
    ['Which river is the longest in South America?', 'Amazon', 'Paraná', 'Orinoco', 'Magdalena'],
    ['Africa has more countries than any other continent.', true],
    ['The Nile flows into the Red Sea.', false],
  ],
  sci: [
    ['What is the chemical symbol for gold?', 'Au', 'Ag', 'Gd', 'Go'],
    ['Which element has the symbol Na?', 'Sodium', 'Nitrogen', 'Neon', 'Nickel'],
    ['Which gas do plants absorb from the air?', 'Carbon dioxide', 'Oxygen', 'Nitrogen', 'Helium'],
    ['How many bones are in an adult human body?', '206', '186', '212', '250'],
    ['What is the hardest natural substance?', 'Diamond', 'Quartz', 'Granite', 'Iron'],
    ['At sea level, water boils at how many °C?', '100', '90', '110', '120'],
    ['What is the largest organ of the human body?', 'Skin', 'Liver', 'Brain', 'Lungs'],
    ['What do bees collect from flowers to make honey?', 'Nectar', 'Pollen', 'Sap', 'Dew'],
    ['Which blood cells fight infection?', 'White blood cells', 'Red blood cells', 'Platelets', 'Plasma'],
    ['What is the most common gas in Earth\'s air?', 'Nitrogen', 'Oxygen', 'Carbon dioxide', 'Argon'],
    ['Roughly how fast does light travel?', '300,000 km/s', '30,000 km/s', '3,000 km/s', '3,000,000 km/s'],
    ['Lightning is hotter than the surface of the Sun.', true],
    ['Sound travels faster than light.', false],
  ],
  space: [
    ['Which planet is known as the Red Planet?', 'Mars', 'Jupiter', 'Venus', 'Mercury'],
    ['What is the largest planet in our Solar System?', 'Jupiter', 'Saturn', 'Neptune', 'Earth'],
    ['What is the closest star to Earth?', 'The Sun', 'Proxima Centauri', 'Sirius', 'Polaris'],
    ['Who was the first person to walk on the Moon?', 'Neil Armstrong', 'Buzz Aldrin', 'Yuri Gagarin', 'Michael Collins'],
    ['Who was the first human in space?', 'Yuri Gagarin', 'Neil Armstrong', 'John Glenn', 'Alan Shepard'],
    ['Which planet is famous for its bright rings?', 'Saturn', 'Mars', 'Mercury', 'Venus'],
    ['How many planets are in our Solar System?', '8', '7', '9', '10'],
    ['Which planet is closest to the Sun?', 'Mercury', 'Venus', 'Mars', 'Earth'],
    ['What is our galaxy called?', 'The Milky Way', 'Andromeda', 'Whirlpool', 'Sombrero'],
    ['Which is the hottest planet?', 'Venus', 'Mercury', 'Mars', 'Jupiter'],
    ['A day on Venus is longer than its year.', true],
    ['The Moon makes its own light.', false],
  ],
  music: [
    ['How many strings does a standard guitar have?', '6', '4', '5', '8'],
    ['How many keys are on a standard piano?', '88', '76', '92', '100'],
    ['How many lines are in a musical staff?', '5', '4', '6', '7'],
    ['Which composer kept writing music after going deaf?', 'Beethoven', 'Mozart', 'Bach', 'Chopin'],
    ['Which band released "Bohemian Rhapsody"?', 'Queen', 'ABBA', 'The Beatles', 'Led Zeppelin'],
    ['Which Australian band recorded "Highway to Hell"?', 'AC/DC', 'INXS', 'Midnight Oil', 'Men at Work'],
    ['In music, what does "forte" mean?', 'Loud', 'Soft', 'Fast', 'Slow'],
    ['Which instrument family does the trumpet belong to?', 'Brass', 'Woodwind', 'Percussion', 'Strings'],
    ['The didgeridoo comes from which country?', 'Australia', 'New Zealand', 'Kenya', 'Peru'],
    ['How many musicians are in a quartet?', '4', '3', '5', '8'],
    ['Elvis Presley was called the King of what?', 'Rock and Roll', 'Pop', 'Jazz', 'Country'],
    ['A saxophone is a woodwind instrument.', true],
    ['The Beatles came from Liverpool.', true],
  ],
  food: [
    ['What is the main ingredient in guacamole?', 'Avocado', 'Pea', 'Cucumber', 'Lime'],
    ['Sushi traditionally comes from which country?', 'Japan', 'China', 'Korea', 'Thailand'],
    ['Pavlova is mostly made from what?', 'Egg whites', 'Cream cheese', 'Flour', 'Butter'],
    ['Which nut is used to make marzipan?', 'Almond', 'Peanut', 'Cashew', 'Walnut'],
    ['Paella comes from which country?', 'Spain', 'Italy', 'Mexico', 'Portugal'],
    ['Which fruit wears its seeds on the outside?', 'Strawberry', 'Raspberry', 'Kiwi fruit', 'Banana'],
    ['Tofu is made from which bean?', 'Soybeans', 'Chickpeas', 'Kidney beans', 'Lentils'],
    ['What is the main ingredient in hummus?', 'Chickpeas', 'Lentils', 'Peas', 'Kidney beans'],
    ['A lamington is coated in chocolate and what?', 'Coconut', 'Sprinkles', 'Nuts', 'Caramel'],
    ['Saffron comes from which part of a plant?', 'Flower', 'Bark', 'Root', 'Seed'],
    ['Which country is pizza originally from?', 'Italy', 'Greece', 'USA', 'France'],
    ['Peanuts are legumes, not true nuts.', true],
    ['White chocolate contains cocoa solids.', false],
  ],
  animals: [
    ['What is the fastest land animal?', 'Cheetah', 'Lion', 'Horse', 'Pronghorn'],
    ['What is the largest mammal?', 'Blue whale', 'Elephant', 'Giraffe', 'Sperm whale'],
    ['How many legs does a spider have?', '8', '6', '10', '12'],
    ['What is a baby kangaroo called?', 'Joey', 'Kit', 'Cub', 'Calf'],
    ['Which mammal can truly fly?', 'Bat', 'Flying squirrel', 'Sugar glider', 'Colugo'],
    ['Which of these Australian animals lays eggs?', 'Platypus', 'Koala', 'Wombat', 'Kangaroo'],
    ['What do giant pandas mostly eat?', 'Bamboo', 'Eucalyptus', 'Fish', 'Berries'],
    ['How many hearts does an octopus have?', '3', '1', '2', '4'],
    ['What is the largest bird?', 'Ostrich', 'Emu', 'Albatross', 'Condor'],
    ['What is a group of lions called?', 'Pride', 'Pack', 'Herd', 'Flock'],
    ['What do koalas mainly eat?', 'Eucalyptus leaves', 'Bamboo', 'Grass', 'Insects'],
    ['Dolphins are mammals.', true],
    ['A starfish is a fish.', false],
  ],
  sport: [
    ['How many players does a soccer team have on the field?', '11', '9', '10', '12'],
    ['How often are the Summer Olympics held?', 'Every 4 years', 'Every 2 years', 'Every 3 years', 'Every 5 years'],
    ['In tennis, what is a score of zero called?', 'Love', 'Nil', 'Duck', 'Zip'],
    ['How many balls are in a standard cricket over?', '6', '5', '8', '10'],
    ['Which sport uses a shuttlecock?', 'Badminton', 'Squash', 'Tennis', 'Table tennis'],
    ['In AFL, how many points is a goal worth?', '6', '1', '3', '4'],
    ['How many points is a touchdown worth in American football?', '6', '3', '5', '7'],
    ['How many players per team are on a basketball court?', '5', '4', '6', '7'],
    ['Roughly how long is a marathon?', '42.2 km', '26.2 km', '40 km', '50 km'],
    ['In golf, one stroke under par is called a…', 'Birdie', 'Eagle', 'Bogey', 'Albatross'],
    ['Which country hosts the Tour de France?', 'France', 'Italy', 'Spain', 'Belgium'],
    ['A rugby union team has 15 players on the field.', true],
    ['In ten-pin bowling, three strikes in a row is called a turkey.', true],
  ],
  general: [
    ['How many days are in a leap year?', '366', '365', '364', '367'],
    ['How many sides does a hexagon have?', '6', '5', '7', '8'],
    ['Mixing blue and yellow paint makes which colour?', 'Green', 'Purple', 'Orange', 'Brown'],
    ['How many minutes are in a day?', '1440', '1240', '1600', '1080'],
    ['Who painted the Mona Lisa?', 'Leonardo da Vinci', 'Michelangelo', 'Raphael', 'Van Gogh'],
    ['"Bonjour" means hello in which language?', 'French', 'Spanish', 'Italian', 'Portuguese'],
    ['How many zeros are in one million?', '6', '5', '7', '9'],
    ['What is the Roman numeral for 50?', 'L', 'C', 'D', 'X'],
    ['A word that reads the same backwards is a…', 'Palindrome', 'Anagram', 'Acronym', 'Homonym'],
    ['How many cards are in a standard deck (no jokers)?', '52', '48', '54', '56'],
    ['How many degrees are in a right angle?', '90', '45', '180', '100'],
    ['Glass is made mainly from sand.', true],
    ['The Great Wall of China is visible from the Moon with the naked eye.', false],
  ],
};

// ───────────────────────────── generators ─────────────────────────────
const G = {
  maths() {
    const v = rnd(3);
    let prompt, ans;
    if (v === 0) { const a = 3 + rnd(9), b = 3 + rnd(9); prompt = `${a} × ${b}`; ans = a * b; }
    else if (v === 1) { const a = 20 + rnd(60), b = 10 + rnd(40), c = 2 + rnd(18); prompt = `${a} + ${b} − ${c}`; ans = a + b - c; }
    else { const a = 2 + rnd(8), b = 2 + rnd(8), c = 1 + rnd(20); prompt = `${a} × ${b} + ${c}`; ans = a * b + c; }
    return { pub: { kind: 'type', numeric: true, title: 'Quick maths!', prompt: prompt + ' = ?' }, answer: String(ans) };
  },
  sequence() {
    const v = rnd(4);
    let seq;
    if (v === 0) { const a = 1 + rnd(20), d = 2 + rnd(9); seq = [0, 1, 2, 3, 4].map((i) => a + d * i); }
    else if (v === 1) { const a = 1 + rnd(4), r = 2 + rnd(2); seq = [0, 1, 2, 3, 4].map((i) => a * r ** i); }
    else if (v === 2) { const a = 1 + rnd(5); seq = [0, 1, 2, 3, 4].map((i) => (a + i) ** 2); }
    else { const a = 1 + rnd(5), b = 1 + rnd(5); seq = [a, b]; while (seq.length < 5) seq.push(seq[seq.length - 1] + seq[seq.length - 2]); }
    return { pub: { kind: 'type', numeric: true, title: 'What comes next?', prompt: seq.slice(0, 4).join(', ') + ', ?' }, answer: String(seq[4]) };
  },
  biggest() {
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
  count() {
    const set = shuffle(pick(EMOJI_SETS));
    const n = 3 + rnd(6);
    const cells = Array(n).fill(set[0]);
    const total = 13 + rnd(5);
    while (cells.length < total) cells.push(set[1 + rnd(3)]);
    const opts = new Set([n]);
    while (opts.size < 4) { const o = n + rnd(5) - 2; if (o > 0) opts.add(o); }
    return { pub: { kind: 'choice', title: `How many ${set[0]} ?`, prompt: shuffle(cells).join(' '), choices: shuffle([...opts]).map(String) }, answer: String(n) };
  },
  unscramble() {
    const w = pick(WORDS.filter((x) => x.length <= 9));
    let s = w;
    for (let i = 0; i < 10 && s === w; i++) s = shuffle([...w]).join('');
    return { pub: { kind: 'type', title: 'Unscramble the word', prompt: s.toUpperCase().split('').join(' ') }, answer: w };
  },
  backwards() {
    const w = pick(WORDS.filter((x) => x.length <= 7));
    return { pub: { kind: 'type', title: 'Type it backwards!', prompt: w.toUpperCase() }, answer: [...w].reverse().join('') };
  },
  vowels() {
    const w = pick(WORDS.filter((x) => x.length >= 5 && /[aeiou].*[aeiou]/.test(x)));
    return { pub: { kind: 'type', title: 'Fill in the missing vowels', prompt: w.toUpperCase().replace(/[AEIOU]/g, '_').split('').join(' ') }, answer: w };
  },
  spelling() {
    const [ok, ...bad] = pick(SPELLING);
    return { pub: { kind: 'choice', title: 'Which one is spelled correctly?', prompt: '', choices: shuffle([ok, ...bad]) }, answer: ok };
  },
  speedType() {
    const p = pick(PHRASES);
    return { pub: { kind: 'type', title: 'Type this — fast!', prompt: p.toUpperCase() }, answer: p };
  },
  oddOne() {
    const [a, b] = shuffle(EMOJI_SETS);
    const odd = pick(b);
    return { pub: { kind: 'choice', title: 'Which one is the odd one out?', prompt: '', choices: shuffle([...shuffle(a).slice(0, 3), odd]), big: true }, answer: odd };
  },
  stroop() {
    const [word, ink, x, y] = shuffle(INKS);
    return { pub: { kind: 'choice', title: 'What COLOUR is the ink? (not the word!)', prompt: word[0], ink: ink[1], choices: shuffle([word[0], ink[0], x[0], y[0]]) }, answer: ink[0] };
  },
  shade() {
    const h = rnd(360), s = 55 + rnd(30), l = 42 + rnd(16), d = (rnd(2) ? 1 : -1) * (7 + rnd(4));
    const n = 25, odd = rnd(n);
    const colors = Array.from({ length: n }, (_, i) => `hsl(${h} ${s}% ${i === odd ? l + d : l}%)`);
    return { pub: { kind: 'grid', title: 'Tap the tile that\'s a different shade', cols: 5, colors }, answer: String(odd) };
  },
  hunt() {
    const n = 12;
    const nums = shuffle(Array.from({ length: n }, (_, i) => i + 1));
    const order = [];
    for (let k = 1; k <= n; k++) order.push(nums.indexOf(k));
    return { pub: { kind: 'order', title: 'Tap 1 to 12 in order — fast!', cols: 4, nums }, answer: order.join(',') };
  },
  memory() {
    const set = shuffle(pick(EMOJI_SETS));
    const len = 4 + rnd(2);
    const seq = set.slice(0, len);
    return { pub: { kind: 'memory', title: 'Remember the order, then tap it back', seq, pool: shuffle(set.slice(0, 6)) }, answer: seq.join(',') };
  },
  emojiMath() { // a little algebra: 🍎 + 🍎 = 10, 🍎 + 🍌 = 8, 🍌 + 🍇 = ?
    const [a, b, c] = shuffle(pick(EMOJI_SETS)).slice(0, 3);
    const va = 2 + rnd(9), vb = 1 + rnd(9), vc = 1 + rnd(9);
    const ans = vb + vc;
    const opts = new Set([ans]);
    while (opts.size < 4) { const o = ans + rnd(7) - 3; if (o > 0) opts.add(o); }
    const prompt = [`${a} + ${a} = ${va * 2}`, `${a} + ${b} = ${va + vb}`, `${c} + ${c} = ${vc * 2}`, `${b} + ${c} = ?`].join('\n');
    return { pub: { kind: 'choice', title: 'Emoji maths — solve the last line', prompt, multiline: true, choices: shuffle([...opts]).map(String) }, answer: String(ans) };
  },
  roman() {
    const n = 4 + rnd(96);
    return { pub: { kind: 'type', numeric: true, title: 'Roman numerals — what number is this?', prompt: toRoman(n) }, answer: String(n) };
  },
  dice() {
    const dice = Array.from({ length: 3 + rnd(2) }, () => 1 + rnd(6));
    return { pub: { kind: 'dice', numeric: true, title: 'Add up the dice!', dice }, answer: String(dice.reduce((x, y) => x + y)) };
  },
  rhyme() {
    const [w, ok, ...bad] = pick(RHYMES);
    return { pub: { kind: 'choice', title: `Which word rhymes with ${w.toUpperCase()}?`, prompt: '', choices: shuffle([ok, ...bad]) }, answer: ok };
  },
  compound() {
    const [first, ok, ...bad] = pick(COMPOUNDS);
    return { pub: { kind: 'choice', title: 'Finish the word', prompt: `${first} + ?`, choices: shuffle([ok, ...bad]) }, answer: ok };
  },
  spotDiff() { // two 4×4 grids, one cell differs: tap it in the right-hand grid
    const set = pick(EMOJI_SETS), n = 16, left = Array.from({ length: n }, () => pick(set.slice(0, 5)));
    const right = left.slice(), i = rnd(n);
    right[i] = pick(set.filter((e) => e !== left[i]));
    return { pub: { kind: 'spotdiff', title: 'Spot the difference — tap it on the right', cols: 4, left, right }, answer: String(i) };
  },
  clock() {
    const h = 1 + rnd(12), m = rnd(12) * 5, fmt = (hh, mm) => `${hh}:${String(mm).padStart(2, '0')}`;
    const opts = new Set([fmt(h, m)]);
    const near = [[h, (m + 30) % 60], [(h % 12) + 1, m], [h, (m + 15) % 60], [m / 5 || 12, (h % 12) * 5]]; // classic mix-ups
    for (const [hh, mm] of shuffle(near)) { if (opts.size >= 4) break; opts.add(fmt(hh, mm)); }
    while (opts.size < 4) opts.add(fmt(1 + rnd(12), rnd(12) * 5));
    return { pub: { kind: 'clock', title: 'What time does the clock show?', h, m, choices: shuffle([...opts]) }, answer: fmt(h, m) };
  },
  simon() {
    const seq = Array.from({ length: 4 + rnd(2) }, () => rnd(SIMON));
    return { pub: { kind: 'simon', title: 'Simon says — watch, then repeat', seq }, answer: seq.join(',') };
  },
  stopwatch() {
    const target = (15 + rnd(26)) * 100; // 1.5–4.0 s
    return { pub: { kind: 'stopwatch', title: `Stop the clock at exactly ${(target / 1000).toFixed(1)} s`, target }, kind: 'stopwatch', target };
  },
  reaction() {
    return { pub: { kind: 'reaction', title: 'Wait for GREEN… then hit it!' }, kind: 'reaction' };
  },
  mash() {
    const need = 25 + rnd(11);
    return { pub: { kind: 'mash', title: `Mash the button ${need} times!`, need }, kind: 'mash', need };
  },
};

// Host-selectable groups. Trivia categories share one "trivia" slot so they don't crowd out the rest.
const GROUPS = [
  { id: 'brain', name: 'Brain teasers', gens: ['maths', 'sequence', 'biggest', 'count', 'emojiMath', 'roman', 'dice'] },
  { id: 'words', name: 'Word games', gens: ['unscramble', 'backwards', 'vowels', 'spelling', 'speedType', 'rhyme', 'compound'] },
  { id: 'eyes', name: 'Sharp eyes', gens: ['oddOne', 'stroop', 'shade', 'hunt', 'spotDiff', 'clock'] },
  { id: 'action', name: 'Action games', gens: ['reaction', 'mash', 'memory', 'simon', 'stopwatch'] },
  { id: 'geo', name: 'Geography', trivia: true },
  { id: 'sci', name: 'Science', trivia: true },
  { id: 'space', name: 'Space', trivia: true },
  { id: 'music', name: 'Music', trivia: true },
  { id: 'food', name: 'Food & Drink', trivia: true },
  { id: 'animals', name: 'Animals', trivia: true },
  { id: 'sport', name: 'Sport', trivia: true },
  { id: 'general', name: 'General Knowledge', trivia: true },
];

function trivia(group, used) {
  const bank = TRIVIA[group.id];
  let avail = bank.map((_, i) => i).filter((i) => !used.has(group.id + i));
  if (!avail.length) { for (let i = 0; i < bank.length; i++) used.delete(group.id + i); avail = bank.map((_, i) => i); }
  const i = pick(avail);
  used.add(group.id + i);
  const [q, ...rest] = bank[i];
  if (typeof rest[0] === 'boolean') {
    return { pub: { kind: 'choice', title: 'True or false?', prompt: q, choices: ['True', 'False'], tf: true }, answer: rest[0] ? 'True' : 'False' };
  }
  return { pub: { kind: 'choice', title: q, prompt: '', choices: shuffle(rest) }, answer: rest[0] };
}

/** Build `n` chair challenges from the enabled groups. `used` remembers trivia already asked this show. */
function makePuzzles(n, enabled, used) {
  const on = GROUPS.filter((g) => enabled[g.id]);
  const games = on.filter((g) => !g.trivia);
  const triv = on.filter((g) => g.trivia);
  const slots = [...games, ...(triv.length ? ['trivia'] : [])];
  if (!slots.length) slots.push(GROUPS[0]);
  const order = [];
  while (order.length < n) order.push(...shuffle(slots));
  const usedGens = new Set();
  return order.slice(0, n).map((slot) => {
    let p, cat;
    if (slot === 'trivia') {
      const g = pick(triv);
      p = trivia(g, used); cat = 'Trivia · ' + g.name;
    } else {
      let gen = pick(slot.gens);
      for (let k = 0; k < 5 && usedGens.has(gen); k++) gen = pick(slot.gens);
      usedGens.add(gen);
      p = G[gen](); cat = slot.name;
    }
    p.pub.cat = cat;
    p.kind = p.kind || 'answer';
    return p;
  });
}

module.exports = { GROUPS: GROUPS.map(({ id, name, trivia: t }) => ({ id, name, trivia: !!t })), makePuzzles, G, TRIVIA };
