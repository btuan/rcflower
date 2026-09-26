"""Run live YOLOv8n detection from a USB webcam and publish its results."""

import argparse
import time
from pathlib import Path

import cv2

from camera import LatestFrameGrabber, draw_detections, roi_from_fit
from config import load_config
from ipc import build_state, post_state, utc_ts, write_snapshot, write_state
from vision import Detector, load_labels

CONFIG_PATH = Path(__file__).parent / "detect-config.yaml"


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        type=Path,
        default=CONFIG_PATH,
        help=f"Path to a YAML config file (default: {CONFIG_PATH.name}). A config only needs "
        "to list the keys it overrides -- anything else falls back to the built-in default.",
    )
    return parser.parse_args()


def class_ids_for(labels: list[str], classes: list[str]) -> set[int] | None:
    """Return the requested label IDs, or None when all classes are requested."""
    wanted = {label.strip() for label in classes if label.strip()}
    if not wanted:
        return None
    unknown = wanted - set(labels)
    if unknown:
        raise ValueError(f"Unknown class label(s): {', '.join(sorted(unknown))}")
    return {labels.index(label) for label in wanted}


def main() -> None:
    """Capture frames, run inference, and publish state until interrupted."""
    args = parse_args()
    config = load_config(args.config)
    assert config.model.input_size is not None  # load_config always resolves this
    labels = load_labels(config.model.labels_path)
    class_ids_filter = class_ids_for(labels, config.detection.classes)
    detector = Detector(
        config.model.path, config.model.use_vulkan, config.model.cpu_threads
    )

    cap = cv2.VideoCapture(config.camera.source)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, config.camera.width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, config.camera.height)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open camera index {config.camera.source}")

    grabber = LatestFrameGrabber(cap).start()
    print(
        f"[{utc_ts()}] [detect] started: model={config.model.path}, "
        f"labels={config.model.labels_path}, camera={config.camera.source}, "
        f"backend={config.output.backend_url or 'disabled'}, "
        f"use_vulkan={config.model.use_vulkan:1}, input_size={config.model.input_size}, "
        f"fit={config.model.fit}"
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
                frame,
                config.model.input_size,
                config.model.fit,
                config.detection.confidence_threshold,
                config.detection.nms_iou_threshold,
                class_ids_filter,
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
                roi=roi_from_fit(
                    fit, frame_width, frame_height, config.model.input_size
                ),
            )
            write_state(config.output.state_path, state)
            if config.output.backend_url:
                post_state(config.output.backend_url, state)
            if config.output.snapshot_path:
                write_snapshot(
                    Path(config.output.snapshot_path),
                    frame,
                    config.output.snapshot_interval,
                )

            now = time.time()
            fps = 0.9 * fps + 0.1 * (1.0 / max(now - previous_time, 1e-6))
            previous_time = now

            # Heartbeat log: print diagnostics on startup and every 1.0 second thereafter
            if now - last_diagnostic_time >= 1.0:
                print(
                    f"[{utc_ts()}] [detect] fps={fps:.1f} detections={len(state['detections'])} "
                    f"backend={config.output.backend_url or 'disabled'} "
                    f"use_vulkan={config.model.use_vulkan:1}"
                )
                last_diagnostic_time = now

            if not config.headless:
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
        if not config.headless:
            cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
