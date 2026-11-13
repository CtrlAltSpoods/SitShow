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
(Node 18+, no dependencies to install): `node server.js`.

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
├── Dubstep/        → category "Dubstep"
├── 80s/            → category "80s"
├── Stream Safe/    → used by streamer mode (also a normal category)
└── loose.mp3       → category "Unsorted"
```

Each round the track starts **30 seconds in** and plays for a random time inside the
host's range (default **7–30 seconds**; the server keeps the stop time secret). The
host can also speed the music up by 10%. Tracks shorter than about a minute start as
late as they can. With no MP3s at all, a built-in synth "House Band" plays.

**Streamer mode** (🎥, per player) ignores the host's song and plays a track from a
folder called `Stream Safe` instead — everyone in streamer mode hears the same one — or
the House Band if that folder doesn't exist. It also hides the room code on screen.

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
- Late joiners watch from the audience. Volume starts at 10%.

## Controls

Click a chair (or press `Tab`) to switch which chair you're going for. Answer with
the buttons, keys `1`–`4`, by typing and pressing `Enter`, or `Space` for the tap
games. A wrong answer (or jumping the gun on the reaction game) freezes you for 2 seconds.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP/WebSocket port |
| `DATA_DIR` | `./data` (`/data` in Docker) | Holds `music/` and `profiles.json` (levels) |
| `MUSIC_DIR` | `$DATA_DIR/music` | Where MP3s are read from |
| `AVATAR_GRACE_MS` | `300000` | How long an avatar is kept after disconnect |
| `RECONNECT_GRACE_MS` | `60000` | How long a dropped player keeps their spot |
| `PUID` / `PGID` | `99` / `100` (Docker) | User and group the server runs as |

Progress is tied to a random ID stored in each player's browser; there are no accounts.
Behind a reverse proxy, forward WebSocket upgrades for `/ws`.
In Docker the server starts as root only to fix ownership of `/data`, then runs as
`PUID`:`PGID` (default `99`:`100`).

## Test

`BASE=localhost:3000 node test/play.js` runs a scripted two-player + bots game against a running server (Node 22+). It expects a `Dubstep` folder with at least one MP3 in the music folder.
