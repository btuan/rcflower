# Hardware & deployment environment

Status: **reference** — physical facts about the deployed device and
measured baselines, not proposals. Update this file when a fact here goes
stale; don't let it drift the way "Raspberry Pi 4B" (with no other specifics)
had drifted into being the only hardware fact written down anywhere.

## Device

- [Raspberry Pi 4 Model B](https://www.raspberrypi.com/products/raspberry-pi-4-model-b/specifications/) (4B).
  - SoC: Broadcom BCM2711, quad-core Cortex-A72 (ARMv8-A, 64-bit) @ 1.8GHz.
  - GPU: Broadcom VideoCore VI (VC6).
    - Compute/graphics: Vulkan 1.0, OpenGL ES 3.1.
    - Video: H.264 hardware decode (1080p60) and encode (1080p30); H.265
      decode (4Kp60).
  - The Hailo AI HAT+ is **not compatible** with the 4B (it needs a 5) —
    already ruled out, no need to re-investigate.

## Camera

A **USB webcam** — [Arducam 1080P Low Light WDR USB Camera Module](https://www.amazon.com/dp/B07ZS75KZR)
(Sony IMX291 sensor, 2MP, 160° fisheye lens, USB2.0 UVC).
[IMX291 datasheet (Arducam)](https://blog.arducam.com/downloads/modules/IMX291/B0261_IMX291_Fisheye_Camera_Datasheet.pdf).
Captured via OpenCV's `cv2.VideoCapture` (`python/camera.py`) — **not** the
Pi Camera Module / libcamera stack. This matters beyond trivia: the SoC's
hardware H.264 encoder (above) is normally reached through
`rpicam-vid`/libcamera tooling built around that other camera stack. Getting
a USB-webcam frame buffer into it instead needs V4L2 M2M plumbing
(GStreamer's `v4l2h264enc`, ffmpeg's `-c:v h264_v4l2m2m`) — not something
`cv2` hands you directly. See `docs/design/video-and-annotation-pipeline.md`.

Per the datasheet, the camera can send **uncompressed YUY2 up to
640×480@30fps** over USB; reaching 1080p requires an on-camera compressed
format (MJPEG or H.264) instead. `detect.py`/`camera.py` currently request
640×480 — the max *uncompressed* resolution — and downscale to the model's
input size (224px or 320px, depending on the exported model) in software,
in `camera.py`'s `preprocess()`, rather than requesting a smaller
uncompressed resolution directly from the camera. Since the camera's own
ISP can likely output smaller YUY2 frames directly (standard UVC format
negotiation), this is a candidate optimization — less USB bandwidth and no
`cv2.resize` cost for a larger-than-needed frame. See
`docs/design/ml-inference-optimization.md`.

## Compute capability limits

The VC6 has no public architecture documentation from Broadcom. Community
knowledge of its internals is largely inferred from its predecessor, the
VC4, plus scattered reverse-engineering:

- [Broadcom VideoCore IV (VC4) 3D Architecture Reference Guide](https://docs.broadcom.com/doc/12358545)
  — the best public doc available, but for the *previous* generation.
- [Raspberry Pi forum thread on VC6 internals](https://forums.raspberrypi.com/viewtopic.php?t=244519)
- [V3DLib FAQ](https://github.com/wimrijnders/V3DLib/blob/main/Doc/FAQ.md) —
  describes its own VC6 info as "cobbled [together] from whatever I and
  others have found out."

So there's no spec sheet to check the limits below against — they're
confirmed by direct testing on this device instead. See
`docs/design/ml-inference-optimization.md` for how each was found:

- **Cortex-A72 has no fp16 SIMD support** (no ARMv8.2-A FP16 extension). A
  model exported as float16 doesn't get a speedup from this CPU — values
  are silently promoted back to float32 for NEON math, so there's no point
  re-testing a float16 export expecting a win from this alone.
- **VideoCore VI (VC6) does not support arithmetic subgroup operations**
  (needed for reduction-based layers like maxpool/softmax) — confirmed
  still absent even after upgrading the Mesa driver specifically to get
  this (Mesa 25.3.0+ claims to add it). Either the upgrade didn't actually
  expose it on this GPU, or the hardware itself lacks it; either way, don't
  re-attempt a Mesa upgrade expecting this to unlock it without new
  evidence.
- **Peak FLOP/s estimates** (theoretical, from clock speed × ALU/lane
  counts — not directly measured, so treat as an upper bound):
  - CPU: 4 cores × 1.8GHz × 16 FLOP/cycle/core = 115.2 GFLOP/s (28.8 GFLOP/s
    on one core) — [FLOP/cycle reference](https://en.wikipedia.org/wiki/Floating_point_operations_per_second#Floating-point_operations_per_clock_cycle_for_various_processors).
    16 FLOP/cycle/core = 4 lanes × 2 FMA ops/lane × 2 SIMD pipelines/core.
  - GPU: 500MHz × 2 slices × 4 QPU/slice × 4 physical cores/QPU × 2 ops/cycle
    = 32 GFLOP/s, per [py-videocore6](https://github.com/Idein/py-videocore6)'s
    README.

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

Numbers here go stale quickly as the preprocessing/inference config
changes — check the date on each before trusting it, and update in place
rather than appending a newer number alongside a stale one.

- **Current (measured ~2026-09-22)**: with input preprocessing changed to
  center-crop + resize to 224px square, and `rcflower-detect` pinned to a
  single CPU core (OS-level affinity, distinct from NCNN's own `--threads`
  setting below): **~100% CPU utilization**, **9-10 fps** on CPU, **1.7 fps**
  on GPU (Vulkan) inference.
  - *(Superseded, kept for context: an earlier config — larger input size,
    not pinned to one core — measured ~300% CPU (~3 of 4 cores) and ~7.6 fps
    CPU / ~0.9 fps GPU. That headroom problem is what originally motivated
    this doc, e.g. Chromium crashing before its page even loaded when run
    alongside detection; Chromium now runs fine alongside both processes at
    the current baseline.)*
- NCNN CPU thread-count scaling is poor, not linear (`python/detect.py`'s
  own bench note, 320px input, measured 2026-09-15): 1 thread = 189ms/frame
  at ~1.0 core; 3 threads = 127ms/frame at ~2.8 cores. `detect.py` defaults
  to 1 thread for this reason, leaving cores free for everything else.
- GPU (Vulkan) inference is consistently *slower* than CPU in every config
  tested so far (see current numbers above). Disabled by default
  (`--use-vulkan` still exists as an opt-in flag). See
  `docs/design/ml-inference-optimization.md` for the FLOP-throughput
  analysis behind why.
- Upgrading the Mesa driver, hoping newer arithmetic-subgroup-op support
  would help GPU inference, was tried on real hardware and made no
  measurable difference — see "Compute capability limits" above.
- Preliminary power/thermal comparison (`vcgencmd measure_temp`, not a
  controlled experiment — CPU and GPU runs were also at different frame
  rates): **~54°C running on CPU vs. ~45°C running on GPU**. Suggestive that
  GPU inference may be more power-efficient despite being slower, but needs
  a properly controlled re-test (matched frame rate or duty cycle) before
  treating it as a real finding.

## See also

- `docs/design/ml-inference-optimization.md` — CV pipeline optimization
  ideas and experiment history.
- `docs/design/video-and-annotation-pipeline.md` — video/annotation
  transport proposal; shares the GPU/encoder facts above.
- `python/README.md` — running `detect.py`, NCNN model files.
- Root `AGENTS.md` — repo layout, deployment/systemd mechanics.
