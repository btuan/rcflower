# Object detection prototype

Pulls frames from a USB webcam via OpenCV and runs a YOLOv8n model
(quantized-free float32 TFLite, 320x320 input) through the TFLite
interpreter. This is the Mac dev stand-in for the eventual Raspberry Pi 4B
deployment target (~10 FPS goal).

## Setup

```bash
cd python
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
python detect.py
```

Press `q` in the video window to quit. Useful flags:

- `--camera N` — webcam device index (default 0)
- `--conf 0.4` — confidence threshold
- `--width` / `--height` — capture resolution
- `--headless` — no GUI window; just runs detection and writes `--state-path` (Ctrl+C to quit). Useful when running on the Pi without a display attached.

## Detection state

Every frame, `detect.py` atomically writes the current detections to
`../state/detections.json` (relative to this directory), for other
processes to read:

```json
{"timestamp": 1734000000.12, "detections": [{"label": "person", "confidence": 0.87, "box": [10.0, 20.0, 100.0, 150.0]}]}
```

`box` is `[x1, y1, x2, y2]` in source-frame pixel coordinates. Override the
path with `--state-path`.

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
`ai-edge-litert` publishes aarch64 wheels, so `pip install -r
requirements.txt` should work as-is. If not, swap the interpreter import in
`detect.py` for `tflite_runtime.interpreter.Interpreter` (API-compatible) and
install `tflite-runtime` instead.

To hit ~10 FPS on a Pi 4B, first try lowering capture resolution
(`--width 320 --height 240`) before reaching for a smaller model.
