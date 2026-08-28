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
python/detect.py --headless   ->  state/detections.json  ->  backend  ->  GET /api/events (SSE)  ->  frontend
```

- The backend polls `state/detections.json` (200 ms) and pushes a `person`
  event `{ inFrame: boolean }` on change. This file-poll IPC is a placeholder;
  a proper channel to the Python service replaces it later.
- Detection always stays a separate Python service. The backend never runs CV.

## Backend

- Entry: `backend/src/index.ts`. Routes: `/api/health`, `/api/detections`,
  `/api/events` (SSE). Anything else: dev -> reverse-proxy to Vite; prod ->
  serve `frontend/dist` with SPA fallback.
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
