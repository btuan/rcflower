# Camera

Status: **reference** — the webcam used with every supported device (see
[overview.md](overview.md)).

A **USB webcam** — [Arducam 1080P Low Light WDR USB Camera Module](https://www.amazon.com/dp/B07ZS75KZR)
(Sony IMX291 sensor, 2MP, 160° fisheye lens, USB2.0 UVC).
[IMX291 datasheet (Arducam)](https://blog.arducam.com/downloads/modules/IMX291/B0261_IMX291_Fisheye_Camera_Datasheet.pdf).
Captured via OpenCV's `cv2.VideoCapture` (`python/camera.py`) — **not** the
Pi Camera Module / libcamera stack. This matters beyond trivia: the Pi 4B's
SoC has a hardware H.264 encoder (see [raspberry-pi-4b.md](raspberry-pi-4b.md))
that is normally reached through `rpicam-vid`/libcamera tooling built around
that other camera stack. Getting a USB-webcam frame buffer into it instead
needs V4L2 M2M plumbing (GStreamer's `v4l2h264enc`, ffmpeg's
`-c:v h264_v4l2m2m`) — not something `cv2` hands you directly. See
`docs/design/video-and-annotation-pipeline.md`.

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

## See also

- [raspberry-pi-4b.md](raspberry-pi-4b.md) — reference device; has the H.264
  encoder facts referenced above.
- [arduino-uno-q.md](arduino-uno-q.md)
- `python/README.md` — the `camera.source` setting and troubleshooting a
  missing `/dev/video*` device.
