# Object detection prototype

Pulls frames from a USB webcam via OpenCV and runs a YOLOv8n model exported
for NCNN. The project uses the checked-in model under
`yolov8n_ncnn_model/` and reads labels from that directory's `metadata.yaml`.

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
- `yolov8n_ncnn_model/` — exported YOLOv8n NCNN model files and metadata labels
- `export_model.py` — exports a different YOLOv8n NCNN model from Ultralytics weights (dev-only, not needed to run detect.py)

## ML inference on the Raspberry Pi 4B

The same `detect.py` and exported model should run unchanged on a Pi 4B.
The current export targets the NCNN runtime, so installation is based on the
`ncnn` Python package and the model files in `yolov8n_ncnn_model/`.

If you need to tune throughput, start by lowering capture resolution
(`--width 320 --height 240`) before trying a smaller model or disabling
Vulkan compute on the Pi.
