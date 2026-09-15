"""
Live object detection from a USB webcam using a YOLOv8n NCNN model on Vulkan.

This runs locally on a dev machine with OpenCV + NCNN, using the exported
`yolov8n_ncnn_model` files under the same Python project directory.
"""

import argparse
import json
import os
import tempfile
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, cast

import cv2
import ncnn
import numpy as np
import yaml

NCNN = cast(Any, ncnn)

MODEL_PATH = Path(__file__).parent / "yolov8n_ncnn_model" / "model.ncnn.param"
MODEL_BIN_PATH = Path(__file__).parent / "yolov8n_ncnn_model" / "model.ncnn.bin"
LABELS_PATH = Path(__file__).parent / "yolov8n_ncnn_model" / "metadata.yaml"
STATE_PATH = Path(__file__).parent.parent / "state" / "detections.json"
SNAPSHOT_PATH = Path(__file__).parent.parent / "state" / "frame.jpg"
BACKEND_URL = "http://127.0.0.1:3000/api/detections"


def utc_ts() -> str:
    """Current time as an ISO 8601 UTC timestamp, e.g. 2026-09-04T15:43:06.123Z."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def load_labels(path: Path) -> list[str]:
    """Load labels from a plain text list or from Ultralytics export metadata YAML."""
    if path.suffix.lower() in {".yaml", ".yml"}:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        names = data.get("names")
        if isinstance(names, dict):
            ordered = []
            for key in sorted(names, key=lambda item: int(item) if str(item).isdigit() else 999999):
                ordered.append(names[key])
            return ordered
        if isinstance(names, list):
            return names
        raise ValueError(f"No label names found in metadata file: {path}")

    return path.read_text(encoding="utf-8").strip().splitlines()


@dataclass
class Fit:
    """Maps model-space (preprocessed tensor) pixel coords back to frame-space.

    model_x = (frame_x - offset_x) * scale_x
    model_y = (frame_y - offset_y) * scale_y
    so frame_x = model_x / scale_x + offset_x, etc.
    """

    scale_x: float
    scale_y: float
    offset_x: float
    offset_y: float


def letterbox(frame: np.ndarray, size: int) -> tuple[np.ndarray, float, int, int]:
    """Resize + pad frame to a square (size, size) image, preserving aspect ratio."""
    h, w = frame.shape[:2]
    scale = size / max(h, w)
    nh, nw = int(round(h * scale)), int(round(w * scale))
    resized = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_LINEAR)

    padded = np.full((size, size, 3), 114, dtype=np.uint8)
    top = (size - nh) // 2
    left = (size - nw) // 2
    padded[top : top + nh, left : left + nw] = resized
    return padded, scale, left, top


def preprocess(frame: np.ndarray, size: int, fit: str = "crop") -> tuple[np.ndarray, Fit]:
    """Fit `frame` into a (size, size) model input using the given strategy.

    fit: "crop" (center-crop to a square, then resize -- no padding),
    "squish" (resize directly to (size, size), ignoring aspect ratio), or
    "letterbox" (resize preserving aspect, pad with 114 to a square).
    """
    h, w = frame.shape[:2]

    if fit == "crop":
        side = min(h, w)
        top = (h - side) // 2
        left = (w - side) // 2
        square = frame[top : top + side, left : left + side]
        resized = cv2.resize(square, (size, size), interpolation=cv2.INTER_LINEAR)
        scale = size / side
        geom = Fit(scale_x=scale, scale_y=scale, offset_x=left, offset_y=top)
    elif fit == "squish":
        resized = cv2.resize(frame, (size, size), interpolation=cv2.INTER_LINEAR)
        geom = Fit(scale_x=size / w, scale_y=size / h, offset_x=0.0, offset_y=0.0)
    elif fit == "letterbox":
        resized, scale, left, top = letterbox(frame, size)
        geom = Fit(scale_x=scale, scale_y=scale, offset_x=-left / scale, offset_y=-top / scale)
    else:
        raise ValueError(f"Unknown fit strategy: {fit}")

    rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
    tensor = rgb.astype(np.float32) / 255.0
    tensor = np.ascontiguousarray(np.transpose(tensor, (2, 0, 1)))  # HWC -> CHW
    return tensor, geom


def postprocess(
    output: np.ndarray,
    fit: Fit,
    conf_threshold: float,
    iou_threshold: float,
    class_ids_filter: set[int] | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """output: (1, 4 + num_classes, num_boxes) raw YOLOv8 head output.

    If `class_ids_filter` is given, only those classes are considered at all --
    a box is scored by the best of *those* classes' confidences, not by
    whichever class is highest overall. This is what we want when we only
    care about e.g. `person`: a box that's 60% person and 65% chair should
    still count as a person detection, not get dropped for not being the
    argmax class.
    """
    # NCNN exports a (84, 2100) tensor for YOLOv8: rows are features, columns are anchors.
    # Transpose to (num_boxes, 4 + num_classes) before running the same NMS pipeline.
    preds = output.T  # (num_boxes, 4 + num_classes)
    boxes_xywh = preds[:, :4]
    class_scores = preds[:, 4:]

    if class_ids_filter:
        cols = sorted(class_ids_filter)
        filtered_scores = class_scores[:, cols]
        best = np.argmax(filtered_scores, axis=1)
        confidences = filtered_scores[np.arange(len(filtered_scores)), best]
        class_ids = np.array(cols)[best]
    else:
        class_ids = np.argmax(class_scores, axis=1)
        confidences = class_scores[np.arange(len(class_scores)), class_ids]

    keep = confidences >= conf_threshold
    boxes_xywh = boxes_xywh[keep]
    confidences = confidences[keep]
    class_ids = class_ids[keep]

    if len(boxes_xywh) == 0:
        return np.empty((0, 4)), np.empty((0,)), np.empty((0,), dtype=int)

    # Map model-space coords back to original frame pixel coordinates:
    # frame_x = model_x / scale_x + offset_x (inverse of Fit's mapping).
    cx, cy, w, h = boxes_xywh[:, 0], boxes_xywh[:, 1], boxes_xywh[:, 2], boxes_xywh[:, 3]
    x1 = (cx - w / 2) / fit.scale_x + fit.offset_x
    y1 = (cy - h / 2) / fit.scale_y + fit.offset_y
    box_w = w / fit.scale_x
    box_h = h / fit.scale_y
    boxes_xywh_for_nms = np.stack([x1, y1, box_w, box_h], axis=1)

    indices = cv2.dnn.NMSBoxes(
        boxes_xywh_for_nms.tolist(),
        confidences.tolist(),
        conf_threshold,
        iou_threshold,
    )
    if len(indices) == 0:
        return np.empty((0, 4)), np.empty((0,)), np.empty((0,), dtype=int)
    indices = np.array(indices).flatten()

    final_boxes = boxes_xywh_for_nms[indices]
    final_boxes[:, 2] += final_boxes[:, 0]  # w -> x2
    final_boxes[:, 3] += final_boxes[:, 1]  # h -> y2
    return final_boxes, confidences[indices], class_ids[indices]


def draw_detections(
    frame: np.ndarray,
    boxes: np.ndarray,
    confidences: np.ndarray,
    class_ids: np.ndarray,
    labels: list[str],
) -> None:
    for (x1, y1, x2, y2), conf, cls_id in zip(boxes, confidences, class_ids):
        x1, y1, x2, y2 = map(int, (x1, y1, x2, y2))
        label = labels[cls_id] if cls_id < len(labels) else str(cls_id)
        text = f"{label} {conf:.2f}"
        cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
        cv2.putText(
            frame, text, (x1, max(0, y1 - 6)),
            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1, cv2.LINE_AA,
        )


class LatestFrameGrabber:
    """Background thread that drains the camera continuously and keeps only the newest frame.

    Why: with a plain `cap.read()` in the inference loop, V4L2 queues frames
    (4 deep on the Pi) faster than we consume them (~6 fps vs 30 fps), so
    `read()` returns instantly with the *oldest* buffered frame -- ~100-130 ms
    stale, and invisible to any timestamp taken after `read()` returns.
    `CAP_PROP_BUFFERSIZE` is ignored by the V4L2 backend, so the only robust
    fix is to read at sensor rate on a separate thread (OpenCV releases the
    GIL inside `read()`) and let inference grab whatever is newest. A frame is
    then at most ~one sensor period old when inference starts, and
    `captured_at` is stamped the moment the driver handed it over.
    """

    def __init__(self, cap: cv2.VideoCapture) -> None:
        self._cap = cap
        self._cond = threading.Condition()
        self._frame: np.ndarray | None = None
        self._captured_at = 0.0
        self._seq = 0
        self._consumed_seq = 0
        self._failed = False
        self.dropped = 0  # frames read but never inferred (expected: most of them)
        self._thread = threading.Thread(target=self._run, name="camera-grab", daemon=True)

    def start(self) -> "LatestFrameGrabber":
        self._thread.start()
        return self

    def _run(self) -> None:
        while True:
            ok, frame = self._cap.read()
            captured_at = time.time()
            with self._cond:
                if not ok:
                    self._failed = True
                    self._cond.notify_all()
                    return
                if self._seq != self._consumed_seq:
                    self.dropped += 1
                self._frame = frame
                self._captured_at = captured_at
                self._seq += 1
                self._cond.notify_all()

    def latest(self, timeout: float = 5.0) -> tuple[np.ndarray, float] | None:
        """Block until a frame newer than the last one returned is available.

        Returns (frame, captured_at), or None if the camera failed / timed out.
        """
        with self._cond:
            if not self._cond.wait_for(
                lambda: self._failed or self._seq != self._consumed_seq, timeout=timeout
            ):
                return None
            if self._failed or self._frame is None:
                return None
            self._consumed_seq = self._seq
            return self._frame, self._captured_at


def roi_from_fit(fit: Fit, frame_w: int, frame_h: int, size: int) -> list[float]:
    """Frame-pixel rectangle [x1, y1, x2, y2] the model actually saw.

    model_x = (frame_x - offset_x) * scale_x, so the model input spans
    frame_x in [offset_x, offset_x + size/scale_x), clamped to the frame.
    """
    x1 = max(0.0, fit.offset_x)
    y1 = max(0.0, fit.offset_y)
    x2 = min(float(frame_w), fit.offset_x + size / fit.scale_x)
    y2 = min(float(frame_h), fit.offset_y + size / fit.scale_y)
    return [x1, y1, x2, y2]


def build_state(
    boxes: np.ndarray,
    confidences: np.ndarray,
    class_ids: np.ndarray,
    labels: list[str],
    captured_at: float,
    infer_started_at: float,
    inferred_at: float,
    frame_size: tuple[int, int] | None = None,
    roi: list[float] | None = None,
) -> dict:
    """Current detections + timing, as JSON-serializable state.

    `timestamp` is kept for backward compatibility (equal to `capturedAt`).
    `capturedAt`/`inferredAt` are stamped by the caller around `cap.read()`
    and postprocess; `sentAt` is stamped just before the POST in
    `post_state()`, since that's the last moment before it leaves this
    process -- all three are unix seconds (`time.time()`), same clock as the
    backend (Python + backend run on the same Pi).

    `frame_size` ([w, h]) and `roi` ([x1, y1, x2, y2], frame pixels) describe
    the raw camera frame and the rectangle of it the model actually saw
    (post `--fit`), so the frontend can rotate/position a 3D flower relative
    to where the person is in the real frame.
    """
    state: dict = {
        "timestamp": captured_at,
        "capturedAt": captured_at,
        "inferStartedAt": infer_started_at,
        "inferredAt": inferred_at,
        "detections": [
            {
                "label": labels[cls_id] if cls_id < len(labels) else str(cls_id),
                "confidence": round(float(conf), 4),
                "box": [round(float(v), 1) for v in box],
            }
            for box, conf, cls_id in zip(boxes, confidences, class_ids)
        ],
    }
    if frame_size is not None:
        state["frameSize"] = [int(frame_size[0]), int(frame_size[1])]
    if roi is not None:
        state["roi"] = [round(float(v), 1) for v in roi]
    return state


def write_state(path: Path, state: dict) -> None:
    """Atomically write detection state to a JSON file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(state, f)
        os.replace(tmp_path, path)
    except BaseException:
        os.unlink(tmp_path)
        raise


# Log throttling for post_state(): a POST fires every frame, but printing every
# frame floods stdout. Log at most once/sec while detections are present, and
# much less often (a quiet heartbeat) while the frame is empty. Failures are
# never throttled -- those are worth seeing immediately.
LOG_INTERVAL_WITH_DETECTIONS = 1.0
LOG_INTERVAL_EMPTY = 30.0
_last_log_time = {"nonempty": 0.0, "empty": 0.0}


def post_state(url: str, state: dict, timeout: float = 1.0) -> None:
    """POST detection state to the backend. Best-effort: logs and continues on failure."""
    n = len(state["detections"])
    bucket = "nonempty" if n else "empty"
    interval = LOG_INTERVAL_WITH_DETECTIONS if n else LOG_INTERVAL_EMPTY
    now = time.time()
    should_log = now - _last_log_time[bucket] >= interval

    # Stamped right before serialization -- the last moment before this
    # state leaves the process, for the capture->infer->sent->received
    # latency breakdown surfaced on the /debug page.
    state = {**state, "sentAt": time.time()}

    req = urllib.request.Request(
        url,
        data=json.dumps(state).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if should_log:
                _last_log_time[bucket] = now
                print(
                    f"[{utc_ts()}] [detect] POST {url} -- {n} detection{'s' if n != 1 else ''} "
                    f"-> {resp.status} {resp.reason}"
                )
    except (urllib.error.URLError, OSError) as e:
        print(f"[{utc_ts()}] [detect] failed to POST state to {url}: {e}")


_last_snapshot_time = 0.0


def write_snapshot(path: Path, frame: np.ndarray, interval: float, width: int = 320) -> None:
    """At most once per `interval` seconds, write `frame` as a resized JPEG.

    Budget: this must stay cheap on a Pi 4 (<5ms/sec average), so most calls
    are a no-op timestamp check; the actual resize+encode only runs ~once a
    second regardless of camera fps. Atomic write, mirroring `write_state`.
    """
    global _last_snapshot_time
    now = time.time()
    if now - _last_snapshot_time < interval:
        return
    _last_snapshot_time = now

    h, w = frame.shape[:2]
    scale = width / w
    small = cv2.resize(frame, (width, max(1, int(round(h * scale)))), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 70])
    if not ok:
        return

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(buf.tobytes())
        os.replace(tmp_path, path)
    except BaseException:
        os.unlink(tmp_path)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--camera", type=int, default=0, help="Webcam device index")
    parser.add_argument("--model", type=Path, default=MODEL_PATH,
                        help="Path to the NCNN .param export (default: yolov8n_ncnn_model/model.ncnn.param)")
    parser.add_argument("--labels", type=Path, default=LABELS_PATH,
                        help="Path to the model metadata YAML (default: yolov8n_ncnn_model/metadata.yaml)")
    parser.add_argument("--conf", type=float, default=0.4, help="Confidence threshold")
    parser.add_argument("--iou", type=float, default=0.45, help="NMS IoU threshold")
    parser.add_argument(
        "--classes", type=str, default="person",
        help="Comma-separated COCO labels to detect (see models/coco.names). "
        "Empty string detects all 80 classes.",
    )
    parser.add_argument("--width", type=int, default=640, help="Capture width")
    parser.add_argument("--height", type=int, default=480, help="Capture height")
    parser.add_argument(
        "--use-vulkan", action="store_true",
        help="Use Vulkan for GPU inference"
    )
    parser.add_argument(
        "--threads", type=int, default=1,
        help="NCNN CPU thread count. Pi 4B bench (320px, 2026-09-15): 1 thread=189ms/frame at 1.0 core, 3 threads=127ms at 2.8 cores -- threads scale poorly, so default to 1 and leave cores for the UI.",
    )
    parser.add_argument(
        "--input-size", type=int, default=224,
        help="Model input size in pixels (square). Must be a multiple of 32.",
    )
    parser.add_argument(
        "--fit", type=str, default="crop", choices=["crop", "squish", "letterbox"],
        help="Strategy for fitting the camera frame into --input-size: "
        "crop (center-crop to a square, then resize), squish (resize directly, ignoring "
        "aspect ratio), or letterbox (resize preserving aspect, pad with gray).",
    )
    parser.add_argument("--state-path", type=Path, default=STATE_PATH, help="Detection state JSON output path")
    parser.add_argument(
        "--snapshot-path", type=str, default=str(SNAPSHOT_PATH),
        help="JPEG snapshot output path for debugging, resized to 320px wide. '' disables.",
    )
    parser.add_argument(
        "--snapshot-interval", type=float, default=1.0,
        help="Minimum seconds between snapshot writes.",
    )
    parser.add_argument(
        "--backend-url", type=str, default=BACKEND_URL,
        help="Backend URL to POST detection state to. Set to '' to disable.",
    )
    parser.add_argument(
        "--headless", action="store_true",
        help="No GUI window -- just run detection and write --state-path",
    )
    args = parser.parse_args()

    if args.input_size % 32 != 0:
        raise ValueError(f"--input-size must be a multiple of 32, got {args.input_size}")

    labels = load_labels(args.labels)

    class_ids_filter: set[int] | None = None
    if args.classes.strip():
        wanted = {c.strip() for c in args.classes.split(",") if c.strip()}
        class_ids_filter = {labels.index(c) for c in wanted if c in labels}
        unknown = wanted - set(labels)
        if unknown:
            raise ValueError(f"Unknown class label(s): {', '.join(sorted(unknown))}")

    if args.model.suffix.lower() == ".param":
        model_bin = args.model.with_suffix(".bin")
    else:
        model_bin = args.model.parent / f"{args.model.stem}.bin"

    net = NCNN.Net()
    net.opt.use_vulkan_compute = args.use_vulkan
    net.opt.num_threads = args.threads
    net.load_param(str(args.model))
    net.load_model(str(model_bin))
    cap = cv2.VideoCapture(args.camera)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open camera index {args.camera}")

    grabber = LatestFrameGrabber(cap).start()
    print(f"[{utc_ts()}] [detect] started successfully: model={args.model}, labels={args.labels}, camera={args.camera}, backend={args.backend_url or 'disabled'}, use_vulkan={args.use_vulkan:1}, input_size={args.input_size}, fit={args.fit}")

    fps = 0.0
    prev_time = time.time()
    last_diag_time = 0.0

    try:
        while True:
            got = grabber.latest()
            if got is None:
                print(f"[{utc_ts()}] [detect] Failed to read frame from camera")
                break
            frame, captured_at = got
            infer_started_at = time.time()  # captured_at -> here == frame age

            tensor, fit = preprocess(frame, args.input_size, args.fit)
            in_mat = NCNN.Mat(tensor).clone()
            ex = net.create_extractor()
            ex.input("in0", in_mat)
            _, out = ex.extract("out0")
            output = np.asarray(out)

            boxes, confidences, class_ids = postprocess(
                output, fit, args.conf, args.iou, class_ids_filter
            )
            inferred_at = time.time()
            frame_h, frame_w = frame.shape[:2]
            roi = roi_from_fit(fit, frame_w, frame_h, args.input_size)
            state = build_state(
                boxes, confidences, class_ids, labels, captured_at, infer_started_at, inferred_at,
                frame_size=(frame_w, frame_h), roi=roi,
            )
            write_state(args.state_path, state)
            if args.backend_url:
                post_state(args.backend_url, state)
            if args.snapshot_path:
                write_snapshot(Path(args.snapshot_path), frame, args.snapshot_interval)

            now = time.time()
            fps = 0.9 * fps + 0.1 * (1.0 / max(now - prev_time, 1e-6))
            prev_time = now

            # Heartbeat log: print diagnostics every 1.0 seconds
            if now - last_diag_time >= 1.0:
                print(f"[{utc_ts()}] [detect] fps={fps:.1f} detections={len(state['detections'])} backend={args.backend_url or 'disabled'} use_vulkan={args.use_vulkan:1}")
                last_diag_time = now

            if not args.headless:
                draw_detections(frame, boxes, confidences, class_ids, labels)
                cv2.putText(
                    frame, f"FPS: {fps:.1f}", (10, 24),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2, cv2.LINE_AA,
                )
                cv2.imshow("YOLOv8n NCNN - press q to quit", frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
    finally:
        cap.release()
        if not args.headless:
            cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
