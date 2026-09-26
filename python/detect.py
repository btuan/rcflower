"""Run live YOLOv8n detection from a USB webcam and publish its results."""

import argparse
import time
from pathlib import Path
from types import SimpleNamespace

import cv2
import yaml

from camera import LatestFrameGrabber, draw_detections, roi_from_fit
from ipc import build_state, post_state, utc_ts, write_snapshot, write_state
from vision import Detector, load_export_imgsz, load_labels

MODEL_PATH = Path(__file__).parent / "yolov8n_ncnn_model" / "model.ncnn.param"
LABELS_PATH = Path(__file__).parent / "yolov8n_ncnn_model" / "metadata.yaml"
STATE_PATH = Path(__file__).parent.parent / "state" / "detections.json"
BACKEND_URL = "http://127.0.0.1:3000/api/detections"
CONFIG_PATH = Path(__file__).parent / "detect.yaml"

# Built-in fallback for every key a config file may omit. See detect.yaml for
# what each key does; production overrides live in detect.prod.yaml, used by
# deploy/systemd/rcflower-detect.service.
DEFAULTS = {
    "camera": 0,
    "model": str(MODEL_PATH),
    "labels": str(LABELS_PATH),
    "conf": 0.4,
    "iou": 0.45,
    "classes": "person",
    "width": 640,
    "height": 480,
    "use_vulkan": False,
    "threads": 1,
    "input_size": None,
    "fit": "crop",
    "state_path": str(STATE_PATH),
    "snapshot_path": "",
    "snapshot_interval": 1.0,
    "backend_url": BACKEND_URL,
    "headless": False,
}
FIT_CHOICES = ("crop", "squish", "letterbox")


def parse_args() -> SimpleNamespace:
    """Parse --config and load/validate detector options from its YAML."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        type=Path,
        default=CONFIG_PATH,
        help=f"Path to a YAML config file (default: {CONFIG_PATH.name}). A config only needs "
        "to list the keys it overrides -- anything else falls back to the built-in default.",
    )
    cli_args = parser.parse_args()

    if not cli_args.config.exists():
        raise FileNotFoundError(f"Config file not found: {cli_args.config}")
    loaded = yaml.safe_load(cli_args.config.read_text()) or {}
    unknown = set(loaded) - set(DEFAULTS)
    if unknown:
        raise ValueError(
            f"Unknown config key(s) in {cli_args.config}: {', '.join(sorted(unknown))}"
        )
    args = SimpleNamespace(**{**DEFAULTS, **loaded})
    args.model = Path(args.model)
    args.labels = Path(args.labels)
    args.state_path = Path(args.state_path)

    if args.fit not in FIT_CHOICES:
        raise ValueError(f"fit must be one of {FIT_CHOICES}, got {args.fit!r}")

    exported_size = load_export_imgsz(args.labels)
    if args.input_size is None:
        args.input_size = exported_size or 320
    if args.input_size % 32 != 0:
        raise ValueError(f"input_size must be a multiple of 32, got {args.input_size}")
    if exported_size is not None and args.input_size != exported_size:
        raise ValueError(
            f"input_size {args.input_size} does not match the model's exported imgsz "
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

            # Heartbeat log: print diagnostics on startup and every 1.0 second thereafter
            if now - last_diagnostic_time >= 1.0:
                print(
                    f"[{utc_ts()}] [detect] fps={fps:.1f} detections={len(state['detections'])} "
                    f"backend={args.backend_url or 'disabled'} use_vulkan={args.use_vulkan:1}"
                )
                last_diagnostic_time = now

            if not args.headless:
                draw_detections(frame, boxes, confidences, class_ids, labels)
                cv2.putText(
                    frame,
                    f"FPS: {fps:.1f}",
                    (10, 24),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.7,
                    (0, 0, 255),
                    2,
                    cv2.LINE_AA,
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
