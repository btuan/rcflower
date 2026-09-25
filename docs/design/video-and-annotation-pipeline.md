# Video + annotation pipeline redesign

Status: **Partially implemented** — the OAuth2 gate has landed; the video/
annotation transport itself is still proposed, not yet implemented (as of
2026-09-25)

## Context

`/debug` currently shows detection boxes with no live camera image. The image
path (`state/frame.jpg`, served at `GET /api/debug/frame.jpg`) was
deliberately removed in `2eeeb3a` / `fba33d0`: the Pi is reachable over a
public Tailscale funnel, and no camera pixels should leave it until `/debug`
sits behind auth. `DetectionView.tsx` is still mounted in `Debug.tsx` and
draws boxes/ROI/crosshair, but its background image request 404s.

Detection *annotations* are not file-based today and don't need to be
redesigned for that reason — `python/ipc.py`'s `post_state()` already POSTs
JSON straight to `POST /api/detections` over HTTP. `write_state()` still
writes `state/detections.json`, but per root `AGENTS.md`, nothing reads it
anymore. Only the snapshot image ever went through a file, and that path is
currently dead by design, not by omission.

## Proposal

- `detect.py` sends H.264 video (software or Pi 4 hardware encoded) and
  bounding-box annotations to the backend over a Unix domain socket,
  multiplexed with a binary, length-prefixed envelope (message type, frame
  ID, PTS) — not relying on NAL-unit or read() boundaries.
- The backend relays video + annotations to the debug client on request,
  over WebSocket or WebRTC.
- Video frames and annotations are kept in sync via presentation timestamps.
- `/debug` and its backing APIs (including the new video/annotation
  endpoint) are gated behind Recurse Center OAuth2. Restricting access to
  specific Recursers is out of scope for now — any valid RC account passes.

## Checklist

- [x] Ship the RC OAuth2 gate for `/debug` and its backing APIs, as its own
      PR independent of the video work — merged to `main` (`1636e57`).
- [ ] Spike H.264 encode feasibility on the Pi 4 (hardware V4L2 M2M vs.
      software) against a USB-webcam frame buffer.
- [ ] Settle the transport: WebSocket, and specifically what rides on it
      (MPEG-TS via a client-side demuxer is the current leading option — see
      below) vs. a WebRTC media gateway.
- [ ] Design the Unix-socket IPC framing between `detect.py` and the
      backend (message type, frame ID, PTS; explicit reconnect/backoff).
- [ ] Backend relay endpoint (WebSocket, gated by the existing
      `requireSession` from `src/auth.ts`).
- [ ] Frontend player: `<video>` + transparent `<canvas>` overlay, replacing
      or extending `DetectionView.tsx`.

## Open design decisions / feedback from review

- **WebRTC vs. WebSocket+MSE.** These aren't interchangeable — WebRTC needs
  SDP/ICE signaling, STUN/likely TURN, and a media gateway process (Bun
  can't speak RTP/DTLS/SRTP itself), which is a real new piece of
  infrastructure and CPU/memory budget on a Pi 4B that's already tight
  (`detect.py`'s own NCNN-thread bench notes: one thread costs a full core).
  WebSocket + fragmented-MP4/MSE needs none of that — one WebSocket, served
  straight out of Bun, no extra process. Recommendation: start with
  WebSocket + MSE given this is a Hub-local diagnostic view; reach for a
  WebRTC gateway only if sub-second glass-to-glass latency turns out to
  matter for a real use case beyond `/debug`.
- **MPEG-TS over WebSocket, for the video leg specifically, looks like a good
  fit within the WebSocket+MSE bucket above** — worth prototyping rather
  than hand-rolling a bespoke envelope for the video bytes themselves.
  MPEG-TS already solves exactly this problem (multiplexed elementary
  streams with PCR/PTS-based sync), `ffmpeg -f mpegts` produces it for free,
  and there's real prior art for this exact use case: `mpegts.js` (and
  `flv.js` before it) exist specifically for low-latency IP-camera-style
  streaming, demuxing MPEG-TS in JS and remuxing to fragmented MP4 for MSE.
  Two caveats worth being honest about before committing:
  - No browser's `MediaSource` accepts `video/mp2t` natively — you still
    need a JS demuxer/remuxer (`mpegts.js` or similar) in the browser, or an
    equivalent WebCodecs-based path. It's not a drop-in `<video src>`.
  - Don't mux the annotation JSON into the TS stream as a private PES
    stream — that means hand-writing custom PES packetization on the Python
    side and extending whatever demuxer you pick to not choke on/ignore an
    unrecognized stream type. Simpler and just as synchronized: send
    annotations as separate WebSocket messages on the same connection,
    timestamped from the same `capturedAt`/PTS domain the video uses. TS's
    resilience machinery (fixed 188-byte packets, repeated PAT/PMT, PCR
    clock recovery) exists to survive lossy broadcast/tuner delivery, which
    isn't the problem here — this is a reliable local Unix socket feeding a
    single WebSocket you already control end to end. Worth also weighing a
    plain WebCodecs path (feed raw H.264 access units straight to
    `VideoDecoder.decode()`, no container at all) against MPEG-TS+mpegts.js
    once the encode spike above lands — it sidesteps the demux step entirely
    and hands back per-frame timestamps directly.
- **Hardware H.264 encode feasibility is unverified for a USB webcam.** The
  SoC's VideoCore VI does have a hardware H.264 encoder (1080p30, see
  `docs/hardware.md`) — the open question is reachability, not existence.
  Its usual path (`rpicam-vid`/libcamera) is built around the Pi camera
  stack; `camera.py` captures via plain `cv2.VideoCapture`, which hands back
  decoded frames in userspace, not a camera-stack handle. Getting
  those into the V4L2 M2M encoder (e.g. `/dev/video11`) needs something like
  GStreamer's `v4l2h264enc` or ffmpeg's `-c:v h264_v4l2m2m` — not something
  `cv2` does directly. Spike this on real hardware (throughput, CPU cost of
  the hand-off) before committing to a GOP/framing design around it; a
  software encoder (libx264 ultrafast, or `openh264`) at 5-8 fps may be
  simpler and cheap enough to skip the integration cost entirely.
- **Frame sync should reuse the existing timestamp/clock-offset machinery,**
  not invent a new scheme. `ipc.py`'s `build_state()` already stamps
  `capturedAt` / `inferStartedAt` / `inferredAt` / `sentAt` (Unix seconds,
  shared Pi clock), and `backend/src/latency.ts` plus `/debug`'s NTP-style
  probe of `GET /api/time` already solve Pi-clock-vs-browser-clock skew.
  Encode the same frame buffer that was just run through inference (natural
  insertion point: right after `inferred_at = time.time()` in `detect.py`'s
  main loop, since `LatestFrameGrabber.latest()` already yields exactly one
  frame per inference cycle), and use `capturedAt` as that frame's PTS
  basis.
- **IPC reliability.** `post_state()`'s HTTP POST is best-effort — it logs
  and continues on failure, so the detect process tolerates backend restarts
  for free today. A persistent Unix socket won't get that behavior
  automatically: `detect.py` needs explicit reconnect/backoff, and the
  backend needs to `unlink()` a stale socket file before rebinding after a
  crash. Backend and detect run as independently-restartable systemd units
  (see root `AGENTS.md` deploy section) — preserve that independence.
- **Auth scope.** Gate only the endpoints `/debug` alone depends on —
  confirmed against actual frontend call sites, not assumption:
  - `GET /api/time` — Debug.tsx's NTP-style clock-offset probe.
  - `GET /api/detections/latest` — frame geometry (`frameSize`, `roi`) and
    the raw per-object detection boxes; polled by `DetectionView.tsx`.
  - `GET/POST /api/debug/latency` — the capture→infer→sent→received→
    broadcast timing ring buffer + percentile stats (`latency.ts`).
  - `GET/POST /api/debug/simulate-person` — forces `person_in_frame` for
    `{ seconds }` so the UI can be exercised without a live person.
  - `GET/POST /api/debug/simulate-sweep` — injects a synthetic person
    sweeping across the frame, through the same `ingestDetectionState` path
    a real camera frame uses.
  - The new video/annotation channel, once it exists.

  Leave everything else open: `GET /api/events` (SSE) is one shared stream —
  `person`/`mood`/`pour`/`watering`/`track` — consumed by `Debug.tsx`,
  `Flower.tsx`, *and* `FlowerLive.tsx`, so gating it would break `/live`.
  `POST/GET /api/pour` and `POST/GET /api/water` back `/watering-can` and
  must stay public too. `POST /api/detections` (Python → backend ingestion)
  is server-to-server, not a browser session, so RC OAuth doesn't apply to
  it at all.

## References

- `docs/hardware.md` — device specs (SoC, GPU, camera type) referenced above.
- `docs/design/ml-inference-optimization.md` — the CV pipeline optimization
  workstream; shares the same GPU/encoder hardware.
- `python/ipc.py`, `python/detect.py`, `python/camera.py`
- `backend/src/detections.ts`, `backend/src/index.ts`, `backend/src/latency.ts`
- Prior commits: `2eeeb3a` (remove camera snapshot route), `fba33d0`
  (temporarily hide `DetectionView`), `0f051fb` / `7f312ce` (remove
  `web_stream.py`)
