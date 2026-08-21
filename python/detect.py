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
from pathlib import Path

import cv2
import numpy as np

from ai_edge_litert.interpreter import Interpreter

MODEL_PATH = Path(__file__).parent / "models" / "yolov8n.tflite"
LABELS_PATH = Path(__file__).parent / "models" / "coco.names"
STATE_PATH = Path(__file__).parent.parent / "state" / "detections.json"


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
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """output: (1, 4 + num_classes, num_boxes) raw YOLOv8 head output."""
    preds = output[0].T  # (num_boxes, 4 + num_classes)
    boxes_xywh = preds[:, :4]
    class_scores = preds[:, 4:]

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


def write_state(
    path: Path,
    boxes: np.ndarray,
    confidences: np.ndarray,
    class_ids: np.ndarray,
    labels: list[str],
) -> None:
    """Atomically write current detections + a unix timestamp to a JSON file."""
    state = {
        "timestamp": time.time(),
        "detections": [
            {
                "label": labels[cls_id] if cls_id < len(labels) else str(cls_id),
                "confidence": round(float(conf), 4),
                "box": [round(float(v), 1) for v in box],
            }
            for box, conf, cls_id in zip(boxes, confidences, class_ids)
        ],
    }

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(state, f)
        os.replace(tmp_path, path)
    except BaseException:
        os.unlink(tmp_path)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--camera", type=int, default=0, help="Webcam device index")
    parser.add_argument("--model", type=Path, default=MODEL_PATH)
    parser.add_argument("--labels", type=Path, default=LABELS_PATH)
    parser.add_argument("--conf", type=float, default=0.4, help="Confidence threshold")
    parser.add_argument("--iou", type=float, default=0.45, help="NMS IoU threshold")
    parser.add_argument("--width", type=int, default=640, help="Capture width")
    parser.add_argument("--height", type=int, default=480, help="Capture height")
    parser.add_argument("--threads", type=int, default=2, help="Interpreter CPU threads")
    parser.add_argument("--state-path", type=Path, default=STATE_PATH, help="Detection state JSON output path")
    parser.add_argument(
        "--headless", action="store_true",
        help="No GUI window -- just run detection and write --state-path",
    )
    args = parser.parse_args()

    labels = load_labels(args.labels)

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
            if not ok:
                print("Failed to read frame from camera")
                break

            tensor, scale, pad_left, pad_top = preprocess(frame, input_size)
            interpreter.set_tensor(input_details["index"], tensor)
            interpreter.invoke()
            output = interpreter.get_tensor(output_details["index"])

            boxes, confidences, class_ids = postprocess(
                output, scale, pad_left, pad_top, args.conf, args.iou
            )
            write_state(args.state_path, boxes, confidences, class_ids, labels)

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
