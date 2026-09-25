# Hardware & deployment environment

Status: **reference** — physical facts about the deployed device and
measured baselines, not proposals. Update this file when a fact here goes
stale; don't let it drift the way "Raspberry Pi 4B" (with no other specifics)
had drifted into being the only hardware fact written down anywhere.

## Device

- Raspberry Pi 4 Model B (4B).
  - SoC: Broadcom BCM2711, quad-core Cortex-A72 (ARMv8-A, 64-bit) @ 1.8GHz.
  - GPU: Broadcom VideoCore VI (VC6).
    - Compute/graphics: Vulkan 1.0, OpenGL ES 3.1.
    - Video: H.264 hardware decode (1080p60) and encode (1080p30); H.265
      decode (4Kp60).
  - The Hailo AI HAT+ is **not compatible** with the 4B (it needs a 5) —
    already ruled out, no need to re-investigate.
- Camera: a **USB webcam**, captured via OpenCV's `cv2.VideoCapture`
  (`python/camera.py`) — **not** the Pi Camera Module / libcamera stack.
  This matters beyond trivia: the SoC's hardware H.264 encoder above is
  normally reached through `rpicam-vid`/libcamera tooling built around that
  other camera stack. Getting a USB-webcam frame buffer into it instead
  needs V4L2 M2M plumbing (GStreamer's `v4l2h264enc`, ffmpeg's
  `-c:v h264_v4l2m2m`) — not something `cv2` hands you directly. See
  `docs/design/video-and-annotation-pipeline.md`.

## Deployment host

- Hostname `kirwinpi`, physically at the RC Hub, repo at
  `/home/pi/code/rcflower`. Reachable publicly over a Tailscale funnel (see
  root `AGENTS.md`).
- Two systemd services:
  - `rcflower-backend` — the Bun web server
    (`deploy/systemd/rcflower-backend.service`).
  - `rcflower-detect` — the Python vision service
    (`deploy/systemd/rcflower-detect.service`).

## Known resource baseline

- `rcflower-detect` runs at roughly **300% CPU** (~3 of 4 cores) in its
  current configuration (CPU inference, float32, NCNN). That leaves little
  headroom: attempting to also run Chromium on the Pi, to display the flower
  on a monitor, crashed before the page even loaded.
- NCNN CPU thread-count scaling is poor, not linear (`python/detect.py`'s
  own bench note, 320px input, measured 2026-09-15): 1 thread = 189ms/frame
  at ~1.0 core; 3 threads = 127ms/frame at ~2.8 cores. `detect.py` defaults
  to 1 thread for this reason, leaving cores free for everything else.
- GPU (Vulkan) inference was tried and is *slower* than CPU: ~0.9 fps vs.
  ~7.6 fps. Disabled by default (`--use-vulkan` still exists as an opt-in
  flag). See `docs/design/ml-inference-optimization.md` for the
  FLOP-throughput analysis behind why.
- Upgrading the Mesa driver, hoping newer arithmetic-subgroup-op support
  would help GPU inference, was tried on real hardware and made no
  measurable difference. See `docs/design/ml-inference-optimization.md`.

## See also

- `docs/design/ml-inference-optimization.md` — CV pipeline optimization
  ideas and experiment history.
- `docs/design/video-and-annotation-pipeline.md` — video/annotation
  transport proposal; shares the GPU/encoder facts above.
- `python/README.md` — running `detect.py`, NCNN model files.
- Root `AGENTS.md` — repo layout, deployment/systemd mechanics.
