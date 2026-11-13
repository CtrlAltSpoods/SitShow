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
| `PUID` / `PGID` | `99` / `100` (Docker) | User and group the server runs as |

Progress is tied to a random ID stored in each player's browser; there are no accounts.
Behind a reverse proxy, forward WebSocket upgrades for `/ws`.
In Docker the server starts as root only to fix ownership of `/data`, then runs as
`PUID`:`PGID` (default `99`:`100`).

## Test

`BASE=localhost:3000 node test/play.js` runs a scripted two-player + bots game against a running server (Node 22+). It expects a track called `short.mp3` in the music folder.
