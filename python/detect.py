"""
Live object detection from a USB webcam using a TFLite YOLOv8n model.

Runs locally on Mac (via OpenCV + ai-edge-litert) as a stand-in for the
Raspberry Pi 4B deployment target. Swap `ai_edge_litert` for `tflite_runtime`
on the Pi if that's what's available there -- the Interpreter API is the same.
"""

import argparse
import json
import os
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

from ai_edge_litert.interpreter import Interpreter

MODEL_PATH = Path(__file__).parent / "models" / "yolov8n.tflite"
LABELS_PATH = Path(__file__).parent / "models" / "coco.names"
STATE_PATH = Path(__file__).parent.parent / "state" / "detections.json"
BACKEND_URL = "http://127.0.0.1:3000/api/detections"


def utc_ts() -> str:
    """Current time as an ISO 8601 UTC timestamp, e.g. 2026-09-04T15:43:06.123Z."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def load_labels(path: Path) -> list[str]:
    return path.read_text().strip().splitlines()


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


def preprocess(frame: np.ndarray, size: int) -> tuple[np.ndarray, float, int, int]:
    padded, scale, left, top = letterbox(frame, size)
    rgb = cv2.cvtColor(padded, cv2.COLOR_BGR2RGB)
    tensor = rgb.astype(np.float32) / 255.0
    tensor = np.expand_dims(tensor, axis=0)
    return tensor, scale, left, top


def postprocess(
    output: np.ndarray,
    scale: float,
    pad_left: int,
    pad_top: int,
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
    preds = output[0].T  # (num_boxes, 4 + num_classes)
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

    # Undo letterbox padding/scaling, in image pixel coordinates.
    cx, cy, w, h = boxes_xywh[:, 0], boxes_xywh[:, 1], boxes_xywh[:, 2], boxes_xywh[:, 3]
    x1 = (cx - w / 2 - pad_left) / scale
    y1 = (cy - h / 2 - pad_top) / scale
    box_w = w / scale
    box_h = h / scale
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


def build_state(
    boxes: np.ndarray,
    confidences: np.ndarray,
    class_ids: np.ndarray,
    labels: list[str],
    captured_at: float,
    inferred_at: float,
) -> dict:
    """Current detections + timing, as JSON-serializable state.

    `timestamp` is kept for backward compatibility (equal to `capturedAt`).
    `capturedAt`/`inferredAt` are stamped by the caller around `cap.read()`
    and postprocess; `sentAt` is stamped just before the POST in
    `post_state()`, since that's the last moment before it leaves this
    process -- all three are unix seconds (`time.time()`), same clock as the
    backend (Python + backend run on the same Pi).
    """
    return {
        "timestamp": captured_at,
        "capturedAt": captured_at,
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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--camera", type=int, default=0, help="Webcam device index")
    parser.add_argument("--model", type=Path, default=MODEL_PATH)
    parser.add_argument("--labels", type=Path, default=LABELS_PATH)
    parser.add_argument("--conf", type=float, default=0.4, help="Confidence threshold")
    parser.add_argument("--iou", type=float, default=0.45, help="NMS IoU threshold")
    parser.add_argument(
        "--classes", type=str, default="person",
        help="Comma-separated COCO labels to detect (see models/coco.names). "
        "Empty string detects all 80 classes.",
    )
    parser.add_argument("--width", type=int, default=640, help="Capture width")
    parser.add_argument("--height", type=int, default=480, help="Capture height")
    parser.add_argument("--threads", type=int, default=2, help="Interpreter CPU threads")
    parser.add_argument("--state-path", type=Path, default=STATE_PATH, help="Detection state JSON output path")
    parser.add_argument(
        "--backend-url", type=str, default=BACKEND_URL,
        help="Backend URL to POST detection state to. Set to '' to disable.",
    )
    parser.add_argument(
        "--headless", action="store_true",
        help="No GUI window -- just run detection and write --state-path",
    )
    args = parser.parse_args()

    labels = load_labels(args.labels)

    class_ids_filter: set[int] | None = None
    if args.classes.strip():
        wanted = {c.strip() for c in args.classes.split(",") if c.strip()}
        class_ids_filter = {labels.index(c) for c in wanted if c in labels}
        unknown = wanted - set(labels)
        if unknown:
            raise ValueError(f"Unknown class label(s): {', '.join(sorted(unknown))}")

    interpreter = Interpreter(model_path=str(args.model), num_threads=args.threads)
    interpreter.allocate_tensors()
    input_details = interpreter.get_input_details()[0]
    output_details = interpreter.get_output_details()[0]
    input_size = input_details["shape"][1]  # square model input, e.g. 320

    cap = cv2.VideoCapture(args.camera)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open camera index {args.camera}")

    fps = 0.0
    prev_time = time.time()

    try:
        while True:
            ok, frame = cap.read()
            captured_at = time.time()
            if not ok:
                print(f"[{utc_ts()}] [detect] Failed to read frame from camera")
                break

            tensor, scale, pad_left, pad_top = preprocess(frame, input_size)
            interpreter.set_tensor(input_details["index"], tensor)
            interpreter.invoke()
            output = interpreter.get_tensor(output_details["index"])

            boxes, confidences, class_ids = postprocess(
                output, scale, pad_left, pad_top, args.conf, args.iou, class_ids_filter
            )
            inferred_at = time.time()
            state = build_state(boxes, confidences, class_ids, labels, captured_at, inferred_at)
            write_state(args.state_path, state)
            if args.backend_url:
                post_state(args.backend_url, state)

            now = time.time()
            fps = 0.9 * fps + 0.1 * (1.0 / max(now - prev_time, 1e-6))
            prev_time = now

            if not args.headless:
                draw_detections(frame, boxes, confidences, class_ids, labels)
                cv2.putText(
                    frame, f"FPS: {fps:.1f}", (10, 24),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2, cv2.LINE_AA,
                )
                cv2.imshow("YOLOv8n TFLite - press q to quit", frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
    finally:
        cap.release()
        if not args.headless:
            cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
