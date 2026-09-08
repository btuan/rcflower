# AGENTS.md

Notes for agents (and humans) working in this repo.

## Repo layout

| Dir | What it is | Runtime |
| --- | --- | --- |
| `backend/` | Bun + TypeScript HTTP server. **The app**, on :3000. Single entry point, dev and prod. | Bun |
| `frontend/` | React 19 SPA (React Router, Tailwind v4, React Compiler). Vite is its compiler, not a server you talk to. | Vite (dev child process / one-shot build) |
| `python/` | Vision service: TFLite YOLOv8n object detection from a webcam. Separate process. | Python 3 |
| `state/` | Runtime scratch. `state/detections.json` is written by `python/detect.py` and read by the backend. Gitignored. | — |
| `assets/` | Source art / model inputs. | — |

## How the pieces talk

```
python/detect.py --headless  ->  POST /api/detections  ->  backend  ->  GET /api/events (SSE)  ->  frontend
```

- `python/detect.py` POSTs its per-frame detection state straight to the
  backend (`POST /api/detections`, best-effort -- logs and continues on
  failure). It also still writes `state/detections.json` for local
  inspection, but nothing reads that file anymore; the HTTP POST is the real
  IPC channel.
- The backend ingests each POST (`ingestDetectionState` in
  `backend/src/detections.ts`) and pushes a `person` SSE event
  (`{ inFrame: boolean, t: {...} }`) only when `person_in_frame` flips.
- Detection always stays a separate Python service. The backend never runs CV.
- Latency across the pipeline (capture -> infer -> sent -> received ->
  broadcast -> browser) is tracked in `backend/src/latency.ts` (in-memory ring
  buffer) and surfaced at `/debug` in the frontend
  (`GET /api/debug/latency`, `GET /api/time`). Python and the backend share a
  clock (same Pi); the browser is a separate device, so `/debug` estimates
  the clock offset itself (NTP-style probe of `/api/time`).

## Backend

- Entry: `backend/src/index.ts`. Routes: `/api/health`, `/api/time`,
  `/api/detections`, `/api/events` (SSE), `/api/water`, `/api/debug/latency`.
  See `backend/README.md` for the full route list. Anything else: dev ->
  reverse-proxy to Vite; prod -> serve `frontend/dist` with SPA fallback.
- Config: `backend/.env` (committed defaults), override per-machine in
  `backend/.env.local` (gitignored). Bun auto-loads both from the cwd, so run
  bun commands from `backend/`.
- **One port.** `http://localhost:3000` is the app in both modes. Dev is one
  command: `bun run dev` spawns Vite as an internal child (`127.0.0.1:5173`,
  `--logLevel warn`, so it prints no banner) and proxies every non-`/api`
  request to it. Never point a browser, curl, or a doc at 5173 -- it has no
  `/api` routes. The only thing that talks to Vite directly is its own HMR
  websocket in the browser (`HMR_CLIENT_PORT`), because Bun doesn't proxy
  websockets.
- Prod (`bun run start`) has no Vite process: `bun run build:frontend` runs
  `vite build` once and Bun serves `frontend/dist`. The Pi runs prod.
- `bun run typecheck` before committing backend changes.

```sh
cd backend
bun install
bun run dev                              # dev, :3000
bun run build:frontend && bun run start  # prod, :3000
```

## Frontend

- Vite is the frontend compiler (TSX, Tailwind v4, React Compiler, hot
  reload), not a runtime and not a server developers interact with. See
  "One server, one port" in the root README before touching anything here.
- Don't add API middleware to `vite.config.ts` — API code lives in `backend/`.
  (There used to be a `vite-plugin-sse.ts`; it was removed.)
- `frontend/.env` holds `ALLOWED_HOSTS` (comma-separated) for Vite's dev-server
  host check; per-machine values go in `frontend/.env.local`.
- No HTTPS in the dev toolchain (mkcert was removed). iOS device-orientation
  needs a secure context — terminate TLS with a reverse proxy in front
  (e.g. `tailscale serve` on the Pi).

## Deployment

- Runs on a Raspberry Pi (`kirwinpi`), repo at `/home/pi/code/rcflower`,
  kept in sync with `origin/main` via `git pull`. Deploy = `git pull &&
  ./deploy/install-systemd.sh` (builds `frontend/dist`, restarts the units).
  The backend unit runs prod mode, so a frontend change is not live until
  that script has rebuilt it.
- Bun is installed at `~/.bun/bin/bun`. `~/.bashrc` only loads for interactive
  shells, so systemd units / `ssh pi@kirwinpi 'bun ...'` must use the full path
  or set `PATH` explicitly.
- Target for detection is a Raspberry Pi 4B; `python/detect.py` runs on Mac as
  a stand-in (swap `ai_edge_litert` for `tflite_runtime` on the Pi).

## Conventions

- Match the surrounding code's style: 2-space indent, TS throughout the JS side,
  `.ts` extensions in relative imports (backend uses `verbatimModuleSyntax` +
  `allowImportingTsExtensions`).
- Commit messages: Conventional Commits (`feat(backend): ...`).
