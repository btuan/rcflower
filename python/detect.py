"""Run live YOLOv8n detection from a USB webcam and publish its results."""

import argparse
import time
from pathlib import Path

import cv2

from camera import LatestFrameGrabber, draw_detections, roi_from_fit
from ipc import build_state, post_state, utc_ts, write_snapshot, write_state
from vision import Detector, load_export_imgsz, load_labels

MODEL_PATH = Path(__file__).parent / "yolov8n_ncnn_model" / "model.ncnn.param"
LABELS_PATH = Path(__file__).parent / "yolov8n_ncnn_model" / "metadata.yaml"
STATE_PATH = Path(__file__).parent.parent / "state" / "detections.json"
SNAPSHOT_PATH = Path(__file__).parent.parent / "state" / "frame.jpg"
BACKEND_URL = "http://127.0.0.1:3000/api/detections"


def parse_args() -> argparse.Namespace:
    """Parse and validate detector command-line options."""
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
        "--input-size", type=int, default=None,
        help="Model input size in pixels (square). Defaults to the size the NCNN model was "
        "exported at (metadata.yaml imgsz). The exported graph bakes its anchor grid for that "
        "size, so any other value produces garbage boxes -- to change it, re-export the model "
        "with dev/export_model.py --imgsz N and point --model/--labels at it.",
    )
    parser.add_argument(
        "--fit", type=str, default="crop", choices=["crop", "squish", "letterbox"],
        help="Strategy for fitting the camera frame into --input-size: "
        "crop (center-crop to a square, then resize), squish (resize directly, ignoring "
        "aspect ratio), or letterbox (resize preserving aspect, pad with gray).",
    )
    parser.add_argument("--state-path", type=Path, default=STATE_PATH, help="Detection state JSON output path")
    parser.add_argument(
        "--snapshot-path", type=str, default="",
        help="JPEG snapshot output path for debugging, resized to 320px wide. Off by default: "
        "the Pi is reachable over tailscale funnel and anything under state/ that the backend "
        f"serves would be public. e.g. {SNAPSHOT_PATH}",
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

    exported_size = load_export_imgsz(args.labels)
    if args.input_size is None:
        args.input_size = exported_size or 320
    if args.input_size % 32 != 0:
        raise ValueError(f"--input-size must be a multiple of 32, got {args.input_size}")
    if exported_size is not None and args.input_size != exported_size:
        raise ValueError(
            f"--input-size {args.input_size} does not match the model's exported imgsz "
            f"{exported_size} ({args.labels}). The NCNN export bakes its anchor grid for the "
            "export size; re-export with dev/export_model.py --imgsz N instead."
        )
    return args


def class_ids_for(labels: list[str], classes: str) -> set[int] | None:
    """Return the requested label IDs, or None when all classes are requested."""
    if not classes.strip():
        return None
    wanted = {label.strip() for label in classes.split(",") if label.strip()}
    unknown = wanted - set(labels)
    if unknown:
        raise ValueError(f"Unknown class label(s): {', '.join(sorted(unknown))}")
    return {labels.index(label) for label in wanted}


def main() -> None:
    """Capture frames, run inference, and publish state until interrupted."""
    args = parse_args()
    labels = load_labels(args.labels)
    class_ids_filter = class_ids_for(labels, args.classes)
    detector = Detector(args.model, args.use_vulkan, args.threads)

    cap = cv2.VideoCapture(args.camera)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open camera index {args.camera}")

    grabber = LatestFrameGrabber(cap).start()
    print(
        f"[{utc_ts()}] [detect] started: model={args.model}, labels={args.labels}, "
        f"camera={args.camera}, backend={args.backend_url or 'disabled'}, "
        f"use_vulkan={args.use_vulkan:1}, input_size={args.input_size}, fit={args.fit}"
    )

    fps = 0.0
    previous_time = time.time()
    last_diagnostic_time = 0.0

    try:
        while True:
            got = grabber.latest()
            if got is None:
                print(f"[{utc_ts()}] [detect] failed to read frame from camera")
                break
            frame, captured_at = got
            infer_started_at = time.time()  # captured_at -> here is frame age.

            boxes, confidences, class_ids, fit = detector.infer(
                frame, args.input_size, args.fit, args.conf, args.iou, class_ids_filter
            )
            inferred_at = time.time()
            frame_height, frame_width = frame.shape[:2]
            state = build_state(
                boxes,
                confidences,
                class_ids,
                labels,
                captured_at,
                infer_started_at,
                inferred_at,
                frame_size=(frame_width, frame_height),
                roi=roi_from_fit(fit, frame_width, frame_height, args.input_size),
            )
            write_state(args.state_path, state)
            if args.backend_url:
                post_state(args.backend_url, state)
            if args.snapshot_path:
                write_snapshot(Path(args.snapshot_path), frame, args.snapshot_interval)

            now = time.time()
            fps = 0.9 * fps + 0.1 * (1.0 / max(now - previous_time, 1e-6))
            previous_time = now

            # Heartbeat log: print diagnostics every 1.0 seconds
            if now - last_diagnostic_time >= 1.0:
                print(
                    f"[{utc_ts()}] [detect] fps={fps:.1f} detections={len(state['detections'])} "
                    f"backend={args.backend_url or 'disabled'} use_vulkan={args.use_vulkan:1}"
                )
                last_diagnostic_time = now

            if not args.headless:
                draw_detections(frame, boxes, confidences, class_ids, labels)
                cv2.putText(frame, f"FPS: {fps:.1f}", (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2, cv2.LINE_AA)
                cv2.imshow("YOLOv8n NCNN - press q to quit", frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
    finally:
        cap.release()
        if not args.headless:
            cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
