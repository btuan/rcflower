# Object detection prototype

Pulls frames from a USB webcam via OpenCV and runs a YOLOv8n model exported
for NCNN. The project uses checked-in NCNN model directories; the deployed
service uses `yolov8n_ncnn_model_224/`.

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
uv run python detect.py
```

Press `q` in the video window to quit. Useful flags:

- `--camera N` -- webcam device index (default 0)
- `--conf 0.4` -- confidence threshold
- `--classes person` -- comma-separated COCO labels to detect (default `person`;
  use `--classes ''` to detect all 80 COCO classes)
- `--width` / `--height` -- capture resolution
- `--backend-url` -- where to POST detection state (default
  `http://127.0.0.1:3000/api/detections`); set to `''` to disable
- `--headless` -- no GUI window; runs detection and writes `--state-path`
  (Ctrl+C to quit). Useful on the Pi without a display.

## Detection state

Every frame, `detect.py` builds a state payload:

```json
{"timestamp": 1734000000.12, "detections": [{"label": "person", "confidence": 0.87, "box": [10.0, 20.0, 100.0, 150.0]}]}
```

`box` is `[x1, y1, x2, y2]` in source-frame pixel coordinates. The payload is:

- POSTed to `--backend-url` (`POST /api/detections`) on a best-effort basis.
- Atomically written to `--state-path` (default `../state/detections.json`) for
  local debugging without a backend.

The two are independent, so the backend side can be tested without a camera or
model:

```sh
curl -i localhost:3000/api/detections \
  -H 'Content-Type: application/json' \
  -d '{"timestamp": 1734000000.12, "detections": [{"label": "person", "confidence": 0.87, "box": [10.0, 20.0, 100.0, 150.0]}]}'
```

## Web viewer

The backend debug page displays bounding-box annotations at
`http://localhost:3000/debug`. Camera images are deliberately not streamed for
privacy.

## Files

- `detect.py` -- capture, inference, NMS, and drawing loop
- `dev/export_model.py` -- development-only NCNN export helper
- `dev/test_geometry.py` -- geometry tests for detection preprocessing and postprocessing
- `yolov8n_ncnn_model*/` -- exported YOLOv8n NCNN model files and metadata labels

## Development tools

The scripts under `dev/` support model development and are not part of the
runtime detection loop. Run them from the `python/` directory:

```bash
uv run pytest dev/test_geometry.py
uv run python dev/export_model.py --imgsz 224
```

Ultralytics' NCNN exporter derives its output directory from the weights
filename (for example, `yolov8n.pt` produces `yolov8n_ncnn_model/`) and does
not provide a separate output-directory argument. `export_model.py` resolves
relative weights paths from `python/` and temporarily runs from that directory,
so relative export artifacts are created beneath `python/`.

## ML inference on the Raspberry Pi 4B

The same `detect.py` and exported model run unchanged on a Pi 4B. The current
export targets the NCNN runtime, so installation is based on the `ncnn` Python
package and the selected model directory. The deployed service currently uses
`yolov8n_ncnn_model_224/`.

To tune throughput, start by lowering capture resolution (`--width 320 --height
240`) before trying a smaller model or disabling Vulkan compute on the Pi.
