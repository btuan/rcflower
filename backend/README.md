# backend

Bun HTTP server. Single entry point for the app.

- `GET /api/health` — `{ ok, dev }`
- `GET /api/detections` — current detection state (from the Python vision service via `state/detections.json`)
- `GET /api/events` — SSE stream; emits `person` events `{ inFrame: boolean }` on change
- everything else — in dev, reverse-proxied to Vite; in prod, served from `frontend/dist` (SPA fallback)

Detection itself lives in a separate Python service; this server only reads the
state file it writes. A proper IPC channel replaces the file poll later.

## Run

```sh
bun install

# dev: spawns Vite as a child and proxies to it (HMR intact). One command.
bun run dev            # http://localhost:3000

# prod: build the frontend, then serve it
bun run build:frontend
bun run start
```

Config is in `.env` (committed defaults); override per-machine in `.env.local`
(gitignored). TLS is expected to be terminated by a reverse proxy in front
(e.g. `tailscale serve` on the Pi).
