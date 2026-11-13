# 🪑 SIT SHOW — Musical Chairs Royale

A multiplayer browser game show. Avatars circle the chairs while the music plays.
When it stops, every chair shows a mini-puzzle — the first contestant to solve a
chair's puzzle sits in it. Whoever is left standing makes a dramatic exit.
Last one seated wins.

## Run it

Prebuilt image (amd64 and arm64), published on every push to `main`:

```bash
docker run -d --name sitshow -p 3000:3000 -v ./data:/data ghcr.io/ctrlaltspoods/sitshow:latest
# open http://localhost:3000
```

Or build it yourself with `docker compose up -d --build`, or run it without Docker
(Node 22.13+, no dependencies to install): `npm start`.

### Unraid

On the **Docker** tab choose **Add Container** and fill in:

| Field | Value |
| --- | --- |
| Name | `sitshow` |
| Repository | `ghcr.io/ctrlaltspoods/sitshow:latest` |
| Network Type | `Bridge` |
| WebUI | `http://[IP]:[PORT:3000]/` |
| Icon URL | `https://raw.githubusercontent.com/CtrlAltSpoods/SitShow/main/public/icon.png` |
| Port: container `3000` | host `3000` (or any free port) |
| Path: container `/data` | `/mnt/user/appdata/sitshow` (read/write) |
| Path: container `/data/music` *(optional)* | your MP3 folder (read only) |

`PUID`/`PGID` default to `99`/`100` (nobody:users), so no permission changes are needed.
A ready-made template is in [`unraid/sitshow.xml`](unraid/sitshow.xml).

## Music

Drop `.mp3` files into `./data/music` (mounted into the container at `/data/music`).
**Each sub-folder is a category**: `/data/music/Dubstep/song.mp3` shows up as
**Dubstep** in the host's category picker. The host picks a category (or all music),
then a specific song or **Random song each round**. Press ↻ to rescan — no restart needed.

```
music/
├── Dubstep/          → category "Dubstep"
├── 80s/              → category "80s"
├── Stream Safe/      → used by streamer mode (also a normal category)
├── Intro Music/      → optional: plays in the lobby and before each round
├── Thinking Music/   → optional: plays while players grab seats
└── loose.mp3         → category "Unsorted"
```

**Volume is evened out automatically.** The server measures each track's loudness once
with ffmpeg (included in the Docker image) and every player's browser turns loud tracks
down and quiet ones up, with a limiter so nothing clips. Results are cached in the
database; new or changed files are measured in the background.

**The stage reacts to the beat** while everyone circles the chairs: the floor flashes and
pulses, the lights and bulbs punch, the stage gives a small thump and the crowd bounces, and
the screen beside the stage shows the live spectrum. Each browser tracks the tempo itself:
it listens for hits (kick, snare, click) across four frequency bands, works out the tempo
from the last few seconds, and pulses on that beat grid — so it stays in time on loud,
compressed masters and stays still on tracks with no clear beat.

There's never dead air: between rounds a built-in game-show vamp plays, and while players
are solving a built-in ticking "thinking" loop plays (it speeds up in the last 5 seconds).
Put tracks in `Intro Music` / `Thinking Music` to use your own instead — those two folders
aren't offered as round-music categories, and streamer mode always uses the built-in ones.

Each round the track starts **30 seconds in** and plays for a random time inside the
host's range (default **7–30 seconds**; the server keeps the stop time secret). The
host can also speed the music up by 10%. Tracks shorter than about a minute start as
late as they can. With no MP3s at all, a built-in synth "House Band" plays.

**Streamer mode** (🎥, per player) ignores the host's song and plays a track from a
folder called `Stream Safe` instead — everyone in streamer mode hears the same one — or
the House Band if that folder doesn't exist. It also hides the room code on screen.

## Accounts (passkeys)

Everyone starts as a guest. In the profile panel, **Create account** makes a passkey
(Face ID, Touch ID, Windows Hello, a phone or a password manager) — there's no password.
An account:

- keeps your level, unlocks and name on any device — **Sign in** with the passkey there
- has a permanent **ID** (shown in the profile panel); your display name can change
- **reserves your name**: nobody else can use it, ignoring case, spaces and punctuation
  ("Jake", "JAKE" and "j.a.k.e" are the same name). Renaming moves the reservation.
- can have more than one passkey (**Add a passkey**) and can **Sign out**

Account holders get a ✓ next to their name in the player list.

**Passkeys only work over HTTPS with a domain name** (or on `localhost`). Browsers block
them on `http://` addresses and on IP addresses like `http://192.168.1.10:3000`. Put Sit
Show behind a reverse proxy (Nginx Proxy Manager, SWAG, Caddy, a Cloudflare Tunnel…) at
something like `https://sitshow.example.com`, with WebSockets enabled. Everything else
works without HTTPS; the account buttons just explain why they're unavailable.
If your proxy rewrites the `Host` header, set `PUBLIC_ORIGIN=https://sitshow.example.com`.

## Leaderboards, player cards and achievements

- **Leaderboards** (home page, and 🏆 in a show): **Levels** (all-time XP) and **Today**
  (points from today's shows: 15 per show, 12 per chair, 50 for a win). Today's board
  resets at midnight in the server's time zone (the container's `TZ` setting).
- Both boards are stored by **player ID**, so renamed players show their current name.
- **Player cards**: click any name in a leaderboard or the player list (or 🪪 My card)
  to see level, ranks, stats (shows, wins, win rate, chairs, best streak, fastest seat,
  finals, shows hosted) and achievements.
- **22 achievements**, from *Opening Night* and *Quick Draw* to *Hat Trick*, *Packed House*
  (win with 16+ players) and *Star of the Day*. Unlocks pop up during the show.

## Hosting a show

In the room's side panel the host can set:

- music category, song, how long it plays, and the 10% speed-up
- how long players get to grab a seat (10–60 s)
- **I'll start each round myself** — the show pauses after every round until the host
  presses **Start round**
- which **chair challenges** are used (see below)
- bots, and removing players (✕ next to their name; removed players can't rejoin that show)

During a show the host can also **Stop the music now** or **End show**.
If the host's connection drops, someone else stands in, and control goes straight back
to the original host when they reconnect. Anyone who drops keeps their spot for 60 seconds.

## Chair challenges

| Group | Challenges |
| --- | --- |
| Brain teasers | quick maths, what comes next, biggest sum, count the emoji |
| Word games | unscramble, type it backwards, missing vowels, spot the correct spelling, speed typing |
| Sharp eyes | odd one out, ink colour (Stroop), odd-shade tile, tap 1–12 in order |
| Action games | reaction (wait for green), button mash, memory sequence |
| Trivia | Geography, Science, Space, Music, Food & Drink, Animals, Sport, General Knowledge — multiple choice and true/false |

## Features

- **Public and private shows** — public ones are listed on the home page, private
  ones are reachable only by invite link or 6-character code. Either can have a password.
- **Invite links** — `Copy invite` in the room. If the show has a password,
  `+ password` copies a link that lets guests straight in. Guests arriving by link get
  a welcome screen where they set their name and profile picture before joining.
- **Rename in the room** — click your name in the side panel; click your picture to change it.
- **Avatars** — uploaded photos are centre-cropped and shrunk to 256×256 in the
  browser, cached in the browser's local storage, and held by the server in memory
  only while you are connected, plus a 5-minute grace period after you disconnect.
- **Emotes**, **levels and XP**, and unlockable **dances**, **dramatic exits**,
  **avatar frames** and more emotes. The wardrobe sits in the profile panel on the
  home page and behind 🎭 in a show; you can preview locked items.
- Up to **30 players** per show (bots included). Big shows use two rings of chairs and
  knock out about a sixth of the field each round, so a full studio finishes in ~12 rounds.
- **The gallery**: knocked-out players and late joiners watch from a stepped platform on
  the right of the stage until the next show.
- **Chat** (side panel): open in the green room, and in the gallery during a show. Players
  still in the show can read it but can't post until they're out or the show ends. It can be
  collapsed, and starts collapsed in streamer mode.
- Account holders have a blue ✓ next to their name. Volume starts at 10%.

## Controls

Click a chair (or press `Tab`) to switch which chair you're going for. Answer with
the buttons, keys `1`–`4`, by typing and pressing `Enter`, or `Space` for the tap
games. A wrong answer (or jumping the gun on the reaction game) freezes you for 2 seconds.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP/WebSocket port |
| `DATA_DIR` | `./data` (`/data` in Docker) | Holds `music/` and `sitshow.db` (players, accounts, passkeys) |
| `MUSIC_DIR` | `$DATA_DIR/music` | Where MP3s are read from |
| `PUBLIC_ORIGIN` | *(derived from the request)* | Your HTTPS address(es) for passkeys, comma-separated, e.g. `https://sitshow.example.com` |
| `RP_ID` | *(the domain of the address)* | Passkey domain — set it to a parent domain to share passkeys across sub-domains |
| `AVATAR_GRACE_MS` | `300000` | How long an avatar is kept after disconnect |
| `RECONNECT_GRACE_MS` | `60000` | How long a dropped player keeps their spot |
| `PUID` / `PGID` | `99` / `100` (Docker) | User and group the server runs as |

Players, sessions and passkeys (public keys only) live in `data/sitshow.db`, a SQLite file
(Node's built-in `node:sqlite`, so still no dependencies; needs Node 22.13+). Back it up by
copying it while the container is stopped. An old `profiles.json` is imported automatically
on first start and renamed to `profiles.json.migrated`; each player's progress moves over
the next time their browser connects. Guests keep their progress via a random token in
their browser.
Behind a reverse proxy, forward WebSocket upgrades for `/ws`.
In Docker the server starts as root only to fix ownership of `/data`, then runs as
`PUID`:`PGID` (default `99`:`100`).

## Test

`BASE=localhost:3000 node test/accounts.js` exercises accounts with a software passkey
(server on `localhost`, with a fresh data folder — it reserves the name "Jake").

`BASE=localhost:3000 node test/play.js` runs a scripted two-player + bots game against a running server (Node 22+). It expects a `Dubstep` folder with at least one MP3 in the music folder.
