# 🪑 SIT SHOW — Musical Chairs Royale

A multiplayer browser game show. Avatars circle the chairs while the music plays.
When it stops, every chair shows a mini-puzzle — the first contestant to solve a
chair's puzzle sits in it. Whoever is left standing makes a dramatic exit.
Last one seated wins.

## Run it

```bash
docker compose up -d --build
# open http://localhost:3000
```

Or without Docker (Node 18+, no dependencies to install):

```bash
node server.js
```

## Music

Drop `.mp3` files into `./data/music` (mounted into the container at `/data/music`).
The host picks a track from the list in the room, or leaves it on
**Random song each round**. Press ↻ in the host controls to rescan the folder —
no restart needed.

Each round the track starts **30 seconds in** and plays for a random
**7–30 seconds** (the server keeps the stop time secret). Tracks shorter than
about a minute start as late as they can. With no MP3s in the folder, a built-in
synth "House Band" plays so the game still works.

## Features

- **Public and private shows** — public ones are listed on the home page, private
  ones are reachable only by invite link or 6-character code. Either can have a password.
- **Invite links** — `Copy invite` in the room. If the show has a password,
  `+ password` copies a link that lets guests straight in.
- **Rename in the room** — click your name in the side panel.
- **Avatars** — uploaded photos are centre-cropped and shrunk to 256×256 in the
  browser, cached in the browser's local storage, and held by the server in memory
  only while you are connected, plus a 5-minute grace period after you disconnect.
- **Emotes**, **levels and XP**, and unlockable **dances**, **dramatic exits**,
  **avatar frames** and more emotes (see the 🎭 Wardrobe — you can preview locked items).
- **Bots** — the host can add bots to fill seats or to try the game solo.
- Host migrates automatically if the host leaves; late joiners watch from the audience.

## Controls

Click a chair (or press `Tab`) to switch which chair you're going for. Answer with
the buttons, keys `1`–`4`, or by typing and pressing `Enter`. A wrong answer locks
you out for 2 seconds.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP/WebSocket port |
| `DATA_DIR` | `./data` (`/data` in Docker) | Holds `music/` and `profiles.json` (levels) |
| `MUSIC_DIR` | `$DATA_DIR/music` | Where MP3s are read from |
| `AVATAR_GRACE_MS` | `300000` | How long an avatar is kept after disconnect |

Progress is tied to a random ID stored in each player's browser; there are no accounts.
Behind a reverse proxy, forward WebSocket upgrades for `/ws`.
If the container can't write `./data/profiles.json` (levels not saving), make the
folder writable by UID 1000: `sudo chown -R 1000:1000 data`.

## Test

`BASE=localhost:3000 node test/play.js` runs a scripted two-player + bots game against a running server (Node 22+). It expects a track called `short.mp3` in the music folder.
