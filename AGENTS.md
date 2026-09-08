# AGENTS.md

Notes for agents (and humans) working in this repo.

## Repo layout

| Dir | What it is | Runtime |
| --- | --- | --- |
| `backend/` | Bun + TypeScript HTTP server. Single entry point for the app. | Bun |
| `frontend/` | React 19 + Vite 8 SPA (React Router, Tailwind v4, React Compiler). | Vite (dev/build only) |
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
- Dev is one command: `bun run dev` spawns Vite as a child process and proxies
  to it. Vite's HMR websocket connects straight to Vite (via `HMR_CLIENT_PORT`)
  because Bun doesn't proxy websockets.
- `bun run typecheck` before committing backend changes.

```sh
cd backend
bun install
bun run dev                              # dev, :3000
bun run build:frontend && bun run start  # prod
```

## Frontend

- Vite is a build/dev tool, not a production runtime. `vite build` emits static
  files to `frontend/dist/`; in prod the backend serves those and no Vite
  process runs.
- Don't add API middleware to `vite.config.ts` — API code lives in `backend/`.
  (There used to be a `vite-plugin-sse.ts`; it was removed.)
- `frontend/.env` holds `ALLOWED_HOSTS` (comma-separated) for Vite's dev-server
  host check; per-machine values go in `frontend/.env.local`.
- No HTTPS in the dev toolchain (mkcert was removed). iOS device-orientation
  needs a secure context — terminate TLS with a reverse proxy in front
  (e.g. `tailscale serve` on the Pi).

## Deployment

- Runs on a Raspberry Pi (`kirwinpi`), repo at `/home/pi/code/rcflower`,
  kept in sync with `origin/main` via `git pull`.
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
