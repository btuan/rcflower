# backend

Bun HTTP server. Single entry point for the app.

- `GET /api/health` — `{ ok, dev, commit, startedAt }`
- `GET /api/time` — `{ now: <ms epoch> }`; used by `/debug` to estimate the
  browser<->server clock offset (NTP-style probe)
- `GET /api/detections` — current detection state
- `POST /api/detections` — ingest a detection state update; body
  `{ timestamp: number, detections: { label: string, confidence?: number, box?: number[] }[], capturedAt?: number, inferredAt?: number, sentAt?: number, frameSize?: [w, h], roi?: [x1, y1, x2, y2] }`.
  The three timing fields are unix seconds (float) stamped by
  `python/detect.py` around frame capture / inference / just-before-POST;
  they're optional (old clients / `curl` just show up as missing stages on
  `/debug`). `frameSize` is the raw camera frame dims and `roi` is the
  frame-pixel rectangle the model actually saw (after `--fit`), both also
  optional. Records a `state_changes` row and broadcasts over SSE when
  `person_in_frame` flips. Also records a latency sample (see below) on every
  POST, not just transitions. Returns `202 { ok: true, personInFrame }`, or
  `400` if the body doesn't match the shape above.
- `GET /api/detections/latest` — `{ frameSize, roi, detections, capturedAt }`
  from the current state (nulls if nothing ingested yet). For the debug page.
- `GET /api/debug/frame.jpg` — latest 320px-wide JPEG snapshot written by
  `python/detect.py` (`state/frame.jpg`), `no-store`. `404` if it doesn't
  exist yet.
- `GET /api/events` — SSE stream; emits `person` events on change:
  `{ inFrame: boolean, t: { capturedAt, inferredAt, sentAt, receivedAt, broadcastAt } }`
  (all ms epoch, null for any stage the POST didn't include); `mood` events
  `{ mood, health, wateredAt }` on mood change and every 5s (health decays
  continuously); `track` events `{ n, primary: { cx, cy, w, h, conf, id } | null, capturedAt }`
  (primary box normalized 0..1 relative to `frameSize`) on every ingested
  frame while `n > 0`, and once with `n: 0, primary: null` on the transition
  to zero persons. `n` is the raw per-frame person count; `primary` comes
  from a small IoU-based tracker (`PrimaryTracker` in `src/detections.ts`)
  that keeps the same person "primary" across frames instead of re-picking
  the largest box every frame -- it only switches primary when the current
  one hasn't been seen for 700ms, and only promotes a new detection once
  it's matched across 2+ frames (filters single-frame spurious boxes).
- `GET /api/debug/latency` — `{ samples, stats }` for the frame
  capture→infer→sent→received→broadcast pipeline: `samples` is the last 300
  ingested detection POSTs (ring buffer, in-memory only), `stats` is
  p50/p95/max per stage. Backs the `/debug` frontend page
  (`frontend/src/Debug.tsx`), which also opens its own SSE connection and
  layers on the browser-side leg (broadcast→browser) using an estimated
  clock offset, since the browser is a separate device from the Pi running
  Python + this backend.
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

Both modes: the app is `http://localhost:3000`. That is the only port you open.

```sh
bun install

# dev: :3000. Spawns Vite as an internal child (127.0.0.1:5173, silent) purely
# to compile the frontend + hot reload; every non-/api request is proxied to
# it. Don't open 5173 -- there are no /api routes there.
bun run dev

# prod: :3000, no Vite process. Build the static frontend once, then serve it.
bun run build:frontend
bun run start
```

See "One server, one port" in the root README for the why.

Config is in `.env` (committed defaults); override per-machine in `.env.local`
(gitignored). TLS is expected to be terminated by a reverse proxy in front
(e.g. `tailscale serve` on the Pi).
