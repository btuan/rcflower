# rcflower

Three pieces, running together on a Raspberry Pi 4B:

- **`python/`** — `detect.py` reads a USB webcam, runs a YOLOv8n TFLite model,
  and reports person detections. See [`python/README.md`](python/README.md).
- **`backend/`** — a Bun server that ingests those detections
  (`POST /api/detections`), persists state transitions + watering events to
  SQLite, and pushes live updates to the frontend over SSE. See
  [`backend/README.md`](backend/README.md).
- **`frontend/`** — the UI (React), compiled by Vite, served by the backend.

## One server, one port: `http://localhost:3000`

This trips people up, so to be explicit: **the app is the Bun server on port
3000.** Dev or prod, that is the only URL you open.

| | Bun (`backend/`) | Vite (`frontend/`) |
|---|---|---|
| What it is | The app server: `/api/*`, SSE, SQLite, serves the frontend | The frontend **compiler**: TSX, Tailwind, React Compiler, hot reload |
| Dev (`bun run dev`) | Listens on **:3000**. Proxies everything that isn't `/api` to Vite | Spawned by Bun as an internal child on `127.0.0.1:5173`. Loopback only, prints no banner. **Don't open it** -- it has no `/api` routes |
| Prod (`bun run start`) | Listens on **:3000**. Serves `frontend/dist` | **Not running.** `vite build` ran once (`bun run build:frontend`) and exited |

Why both? Bun is the runtime; Vite is the toolchain that turns TSX/Tailwind
into a browser bundle and hot-reloads it while you edit. Bun could bundle, but
not with Tailwind v4 + the React Compiler + Fast Refresh out of the box, and
in prod Vite isn't a process at all -- so there's little to gain from ripping
it out. The rule of thumb: **if you're typing `5173`, something is wrong.**

```sh
cd backend && bun install
bun run dev        # dev: :3000 (Vite child for hot reload; invisible)
bun run build:frontend && bun run start   # prod: :3000 only, no Vite
```

`bun` commands run from `backend/` because Bun loads `backend/.env` from the
cwd. The one Vite-only thing you'll touch is `frontend/.env`'s
`ALLOWED_HOSTS` when developing through a tunnel/proxy hostname.

## Running as services (systemd)

Both `python/detect.py` and the backend run as systemd units so they start on
boot and restart on failure. Unit files live in this repo at
`deploy/systemd/*.service` (not `/etc/systemd/system/` directly) so changes
go through git like everything else.

### Install / update

```sh
./deploy/install-systemd.sh
```

This is the deploy step. It builds the frontend (`frontend/dist`), copies the
unit files into `/etc/systemd/system/`, reloads systemd, and (re)starts both
services. Safe to re-run any time -- after `git pull`, or after hand-editing a
file in `deploy/systemd/`. Needs `sudo`. Pass `--no-build` to skip the
frontend build (e.g. only a unit file changed).

### Services

| Unit | What it runs | Notes |
|---|---|---|
| `rcflower-backend.service` | `bun run start` in `backend/` | **Prod mode**: API + prebuilt `frontend/dist` on :3000. No Vite process on the Pi. Frontend changes need a rebuild -- re-run `install-systemd.sh`. |
| `rcflower-detect.service` | `venv/bin/python3 -u detect.py --headless --camera 0 --classes person` in `python/` | Person-only detection. POSTs to the backend are best-effort, so this doesn't hard-depend on the backend being up. |

### Inspecting logs

stdout/stderr go straight to the journal (no more log files under `/tmp`):

```sh
journalctl -u rcflower-backend -f       # follow live
journalctl -u rcflower-detect -f
journalctl -u rcflower-detect -n 100 --no-pager   # last 100 lines, no pager
journalctl -u rcflower-backend --since "10 min ago"
```

Both logs are timestamped in UTC ISO 8601 (`2026-09-04T16:07:35.758Z`) in the
log message itself; `journalctl` also shows its own local-time prefix per line.

### Restart / stop / status

```sh
sudo systemctl restart rcflower-backend rcflower-detect
sudo systemctl stop rcflower-backend rcflower-detect
sudo systemctl start rcflower-backend rcflower-detect
sudo systemctl status rcflower-backend rcflower-detect   # state + last few log lines
```

### Boot behavior

Both are `enable`d (`WantedBy=multi-user.target`), so they start automatically
on boot, and `Restart=on-failure` (capped at 5 restarts / 60s) brings them
back if they crash -- e.g. `rcflower-detect` restarts on its own if the
camera is unplugged and replugged, since `detect.py` raises if it can't open
the camera.

To stop a service from starting on boot without touching the unit file:

```sh
sudo systemctl disable rcflower-backend   # or rcflower-detect
```

### Camera device

`detect.py` opens `--camera 0` (`/dev/video0`). If detection isn't seeing
anything, check the device is actually there and which index it landed at --
USB enumeration order can shift after a reboot or if other USB devices are
plugged in:

```sh
lsusb                        # confirm the webcam shows up
ls -la /dev/video*
```

If the index changes, update `--camera` in
`deploy/systemd/rcflower-detect.service` and re-run
`./deploy/install-systemd.sh`.
