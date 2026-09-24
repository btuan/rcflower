# Video + annotation pipeline redesign

Status: **Draft — proposed, not yet implemented** (as of 2026-09-24)

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

## Recommended sequencing

1. **Ship the OAuth2 gate first, as its own PR**, independent of the video
   work. It's the thing already named as the blocker on serving pixels at
   all, it's smaller to review in isolation, and it unblocks even a trivial
   `frame.jpg`-style endpoint on its own.
2. Land the video/annotation transport on top, once the gate exists.

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
- **Hardware H.264 encode feasibility is unverified for a USB webcam.** The
  Pi 4's HW encoder path (`rpicam-vid`/libcamera) is built around the Pi
  camera stack; `camera.py` captures via plain `cv2.VideoCapture`, which
  hands back decoded frames in userspace, not a camera-stack handle. Getting
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
- **Auth scope.** Gate the new video/annotation endpoint the same way as
  `/api/debug/*` — but leave `GET /api/events` alone; it also backs the
  public `/live` display and must stay open.

## References

- `python/ipc.py`, `python/detect.py`, `python/camera.py`
- `backend/src/detections.ts`, `backend/src/index.ts`, `backend/src/latency.ts`
- Prior commits: `2eeeb3a` (remove camera snapshot route), `fba33d0`
  (temporarily hide `DetectionView`), `0f051fb` / `7f312ce` (remove
  `web_stream.py`)
