# Object detection prototype

Pulls frames from a USB webcam via OpenCV and runs a YOLOv8n model
(quantized-free float32 TFLite, 320x320 input) through the TFLite
interpreter. This is the Mac dev stand-in for the eventual Raspberry Pi 4B
deployment target (~10 FPS goal).

## Setup

This project uses uv for dependency management and a local virtual environment.

```bash
cd python
uv sync
```

To run commands inside the managed environment:

```bash
uv run python detect.py
```

## Run

```bash
python detect.py
```

Press `q` in the video window to quit. Useful flags:

- `--camera N` — webcam device index (default 0)
- `--conf 0.4` — confidence threshold
- `--classes person` — comma-separated COCO labels to detect (default `person`
  -- that's all we care about right now). Empty string (`--classes ''`)
  detects all 80 COCO classes.
- `--width` / `--height` — capture resolution
- `--backend-url` — where to POST detection state (default `http://127.0.0.1:3000/api/detections`); set to `''` to disable
- `--headless` — no GUI window; just runs detection and writes `--state-path` (Ctrl+C to quit). Useful when running on the Pi without a display attached.

## Detection state

Every frame, `detect.py` builds a state payload:

```json
{"timestamp": 1734000000.12, "detections": [{"label": "person", "confidence": 0.87, "box": [10.0, 20.0, 100.0, 150.0]}]}
```

`box` is `[x1, y1, x2, y2]` in source-frame pixel coordinates. It's both:

- **POSTed to the backend** at `--backend-url` (`POST /api/detections`),
  best-effort -- a failed request is logged and the loop keeps running.
- **atomically written to a JSON file** at `--state-path` (default
  `../state/detections.json`, relative to this directory), for local
  debugging without a backend running.

The two are independent, so you can test the backend side without a camera
or model at all -- just POST the same shape yourself:

```sh
curl -i localhost:3000/api/detections \
  -H 'Content-Type: application/json' \
  -d '{"timestamp": 1734000000.12, "detections": [{"label": "person", "confidence": 0.87, "box": [10.0, 20.0, 100.0, 150.0]}]}'
```

## Web viewer

To view the annotated stream in a browser instead of an OpenCV window:

```bash
python web_stream.py
```

Then open `http://<host>:8000/` (use `localhost` if running on your own
machine, or the Pi's IP/hostname if running remotely). Same flags as
`detect.py`, plus `--host` / `--port` for the web server bind address.

## Files

- `detect.py` — capture/inference/NMS/draw loop
- `web_stream.py` — serves the same annotated feed as an MJPEG stream over HTTP
- `models/yolov8n.tflite` — YOLOv8n exported to TFLite, 320x320 input, float32
- `models/coco.names` — the 80 COCO class labels the model predicts
- `export_model.py` — regenerates the TFLite model from Ultralytics weights (dev-only, not needed to run detect.py)

## Porting to the Raspberry Pi 4B

Same `detect.py` and model should run unchanged. On Bookworm (Python 3.11)
`ai-edge-litert` publishes aarch64 wheels, so `uv sync` should work as-is. If
not, swap the interpreter import in `detect.py` for
`tflite_runtime.interpreter.Interpreter` (API-compatible) and install
`tflite-runtime` instead.

To hit ~10 FPS on a Pi 4B, first try lowering capture resolution
(`--width 320 --height 240`) before reaching for a smaller model.
