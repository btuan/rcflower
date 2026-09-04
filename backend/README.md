# backend

Bun HTTP server. Single entry point for the app.

- `GET /api/health` — `{ ok, dev }`
- `GET /api/detections` — current detection state
- `POST /api/detections` — ingest a detection state update; body
  `{ timestamp: number, detections: { label: string, confidence?: number, box?: number[] }[] }`.
  Records a `state_changes` row and broadcasts over SSE when `person_in_frame`
  flips. Returns `202 { ok: true, personInFrame }`, or `400` if the body
  doesn't match the shape above.
- `GET /api/events` — SSE stream; emits `person` events `{ inFrame: boolean }` on change
- everything else — in dev, reverse-proxied to Vite; in prod, served from `frontend/dist` (SPA fallback)

Detection itself lives in a separate Python service (`python/detect.py`),
which POSTs its per-frame state to `/api/detections`. The two are decoupled
over plain HTTP, so each can be tested independently -- e.g. fake a person
walking into frame without running the vision service at all:

```sh
curl -i localhost:3000/api/detections \
  -H 'Content-Type: application/json' \
  -d '{"timestamp": 1734000000.0, "detections": [{"label": "person", "confidence": 0.9, "box": [10, 20, 100, 150]}]}'

# and back out of frame
curl -i localhost:3000/api/detections \
  -H 'Content-Type: application/json' \
  -d '{"timestamp": 1734000001.0, "detections": []}'
```

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
