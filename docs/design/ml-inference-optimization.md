# Design doc: ML optimization

Status: **living notes** — some items below are tried-and-concluded
experiments, some are still-open ideas. Exported from a Google Doc and
reorganized; update the relevant bullet in place when an idea gets tried
rather than leaving it looking open. See `docs/hardware.md` for the device
specs referenced throughout, and
`docs/design/video-and-annotation-pipeline.md` for the video/annotation
transport work, which shares the same GPU/H.264-encoder facts.

## System background

- Device: Raspberry Pi 4 Model B — see `docs/hardware.md` for the full
  chipset/GPU/camera specs.
- RC Flower runs as two systemd services:
  - `rcflower-backend` — web server (Bun/TypeScript).
  - `rcflower-detect` — object detection microservice (Python).

## Problem

- `rcflower-detect` consumes a lot of CPU, and possibly a lot of RAM too —
  see `docs/hardware.md` for the current measured baseline (numbers below
  are what originally motivated this doc; check that file for what's true
  now before relying on a specific figure).
- At the original ~300%-CPU baseline, this made it hard to run other heavy
  processes on the Pi — e.g. Chromium, tried to display the flower on a
  monitor, crashed before the page even loaded. Preprocessing changes since
  then (center-crop + resize to 224px square, pinned to one core) have cut
  that to 108-126%, and opening Chromium alongside the backend and detect
  processes now works.
- It may also increase power draw (CPUs reduce power consumption at low
  utilization), which is bad for the environment and doesn't spark joy 🙁 —
  see the preliminary temperature comparison in `docs/hardware.md`.

## Approaches we've investigated

### Hardware optimization

- **Running model inference on the GPU** (see PR #5):
  - Added an option to run the YOLOv8n object detection model on Vulkan.
    This involved replacing LiteRT with NCNN as the ML inference runtime,
    since NCNN supports Vulkan out of the box, whereas in LiteRT/TFLite it
    must be enabled via a delegate, which is complicated to build.
  - **Result: the GPU path is consistently slower than CPU**, in every
    config tested so far — most recently 1.7 fps GPU vs. 9-10 fps CPU (see
    `docs/hardware.md`, "Known resource baseline", for the current numbers
    and an earlier config's numbers for comparison). Some hypotheses on why:
    - Unsupported arithmetic subgroup ops may force layers that need them
      (e.g. maxpool, softmax) either to fall back to a CPU implementation
      mid-inference, or to run a less efficient implementation on the GPU.
      The CPU-fallback case is the more costly one: even on an integrated
      GPU sharing system RAM with the CPU, moving data between them still
      needs cache/memory synchronization for every affected layer, not just
      once per frame.
      - We tried upgrading the Mesa driver to a version that supports
        arithmetic subgroup ops — see below.
    - Lower raw throughput: VideoCore GPUs have fewer ALUs for general-purpose
      compute relative to other GPUs — the VC6 has 8 QPUs containing 2 ALUs
      each, for a peak of 32 GFLOP/s at 500MHz. The GPU code path stayed in
      the codebase but disabled by default. See `docs/hardware.md`, "Compute
      capability limits", for detailed CPU and GPU performance estimates.
    - Preliminary evidence the GPU may still win on performance-per-watt
      despite being slower: `docs/hardware.md` has an early, not-yet-
      controlled temperature comparison (~54°C CPU vs. ~45°C GPU).
  - **Update, tested on hardware: upgrading the Mesa driver did not help.**
    The original hypothesis was that Mesa 25.3.0+ adds arithmetic subgroup
    ops (needed for reduction-based ML layers like maxpool/softmax) and
    might close the GPU/CPU gap above. `feat/new-mesa-vulkan-driver` wired
    up a custom Mesa install (`VK_ICD_FILENAMES`/`LD_LIBRARY_PATH` pointing
    at `/home/pi/mesa-install/...`) to test this — no measurable improvement
    in inference speed was observed, and the VC6 still doesn't appear to
    support arithmetic subgroup ops even with the upgraded driver (see
    `docs/hardware.md`, "Compute capability limits"). GPU inference stays
    disabled by default; no need to re-test this specific hypothesis without
    new evidence.
- **AI hardware accelerator**: the Hailo AI HAT+ is not compatible with our
  current device (4B) — see `docs/hardware.md`.

### Software-level model optimization

- 🌟 **Model quantization**:
  - The Ultralytics YOLOv8 model can be exported as float32, float16, or
    int8.
    - **Float32** is the default and what we currently use. ARMv8.0 (Cortex-A72)
      supports the SIMD vector types `float32x2_t`/`float32x4_t`, which NCNN
      should be using under the hood.
    - **Float16** would ideally double inference speed (2x elements per CPU
      cycle), but Cortex-A72 has no fp16 SIMD support (see `docs/hardware.md`,
      "Compute capability limits") — values would be silently promoted to
      float32, negating the benefit.
    - **Int8** is the only viable quantized format: supported by ARMv8.0 and
      by the [Hailo AI HAT+](https://docs.ultralytics.com/integrations/hailo).
      Worth doing even without an AI accelerator — could speed up inference
      2–4x (depends on whether int16 activations are used; Hailo typically
      uses int8 weights and int8 or int16 activations).
  - **Calibration and HEF compilation**: compiling to Hailo Executable
    Format (HEF) requires calibration on a representative sample of
    production-like images — Ultralytics recommends at least 1,024 diverse
    images. The HEF model must be compiled on x86 (might work via the
    [WinARM Prism x86 emulator](https://learn.microsoft.com/en-us/windows/arm/apps-on-arm-x86-emulation)),
    and Ultralytics recommends a GPU for compilation, so a cloud VM may be
    necessary.
    - Training/calibrating on images of actual people at the RC Hub raises
      privacy/ethics concerns — handle with care, per
      [RC's guideline on using RC data in AI projects](https://www.recurse.com/manual#rc-data-ai-projects).
- **Pruning**: we don't need logits for all 80 YOLOv8 classes — just
  `person`.
- **Distillation**: not yet explored.

### Vision pipeline

- **Already implemented:** use smaller input images, and crop to a square
  rather than "letterboxing" (padding an oblong image to a square).
  Letterboxing adds pixels that don't contribute to model outputs, and
  inference scales roughly as `O(width * height)` in the input size — i.e.
  `O(n^2)` for a square `n * n` crop. Currently done in software; see the
  ISP-resize idea below for a possible further optimization.
- Combine object detection (YOLOv8, already in use) on keyframes with
  lightweight object tracking between them (suggested by Brian):
  - Could increase effective frame rate.
  - Could also reduce CPU utilization at a constant frame rate (e.g. sleep
    between frames).
- Idea, not yet started: resize/crop on the camera's own ISP instead of
  `cv2.resize` in `camera.py`'s `preprocess()`, to leverage the ISP's own
  parallelism and reduce CPU↔GPU data transfer when running on the GPU path
  (Vulkan). Performance gains are unconfirmed and may be small — worth
  measuring before investing effort.
- Idea, not yet started: request a smaller uncompressed resolution directly
  from the camera (UVC format negotiation) instead of always capturing at
  640×480 — the camera's max uncompressed resolution, see `docs/hardware.md`
  — and downscaling to the model input size in software. Would cut both USB
  bandwidth and `cv2.resize` cost, independent of which inference backend
  (CPU/GPU) is used.
- Nuclear option: ditch the CV model and use near-field communication
  instead. [Not currently supported in any major browser](https://caniuse.com/webnfc) 😕.

## Phase 2: Camera instrumentation

Related unmerged work: the `calib-dataset-instrumentation` branch already
writes a JPEG snapshot every 60 seconds — a starting point for the capture
cadence below, not something to build from scratch.

Don't confuse this with `write_snapshot()` in `python/ipc.py`, which already
exists on `main` — it was built independently, for the `/debug` page's
camera-snapshot view (throttled, resized to 320px, JPEG quality 70), not for
calibration data collection. It doesn't meet the goals below (minimal
compression, minimal chroma subsampling) as-is.

### Goals

- Capture a representative sample of images for model calibration:
  images the Pi would actually see in typical operation — various lighting
  conditions, scenes (other objects in frame), and people (clothing, skin
  tone, hair, etc.).

### Things to decide

- How will we notify people near the camera that they're being recorded,
  and why? (e.g. a notice on the screen below the flower.)
- How to store/compress the images:
  - Goals: minimize CPU overhead; ideally lossless, minimal chroma subsampling
    (4:2:2).
  - Candidate formats:
    - JPEG (4:2:2) — simpler, widely supported codec. Note that the camera
      already transmits images to the Pi as [YUY2](https://www.loc.gov/preservation/digital/formats/fdd/fdd000364.shtml),
      which is inherently 4:2:2.
    - AVCI (H.264-in-HEIF) — could use the Pi's hardware encoder; may be
      4:2:0 only.
- When to capture images, over a 24-hour period:
  - Person in frame: every 1 second (real-world data may be class-imbalanced
    otherwise).
  - No person in frame: every 1 minute (~1,440 images/day).
- What to store: still images (individual dataset samples) vs. video (for
  multiple consecutively captured images).
- Data retention/access: only trusted team members should have access to
  the dataset.
