"""Run live YOLOv8n detection from a USB webcam and publish its results."""

import argparse
import threading
import time
from dataclasses import dataclass
from enum import Enum, auto
from pathlib import Path

import cv2
import numpy as np

from camera import LatestFrameGrabber, draw_detections, roi_from_fit
from config import Config, load_config
from ipc import build_state, post_state, utc_ts, write_snapshot, write_state
from vision import Detector, load_labels

CONFIG_PATH = Path(__file__).parent / "detect-config.yaml"


class Mode(Enum):
    """States of the detection loop."""

    DETECT = auto()  # run the (expensive) detector
    TRACK = auto()  # cheap motion estimation between detections
    SLEEP = auto()  # idle; poll the detector only occasionally


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


@dataclass
class DetectionResult:
    """One frame's detections, handed from the loop thread to the preview."""

    frame: np.ndarray
    boxes: np.ndarray
    confidences: np.ndarray
    class_ids: np.ndarray
    fps: float = 0.0


class DetectionLoop:
    """Background thread that runs the detection state machine and publishes its state.

    Owns all loop state (current mode, FPS, heartbeat timing, latest result). The
    thread only does capture -> infer -> publish; ``cv2.imshow`` must stay on the
    main thread, so the preview reads results through ``wait_result``.
    """

    def __init__(
        self,
        config: Config,
        detector: Detector,
        grabber: LatestFrameGrabber,
        labels: list[str],
        class_ids_filter: set[int] | None,
    ) -> None:
        self._config = config
        self._detector = detector
        self._grabber = grabber
        self._labels = labels
        self._class_ids_filter = class_ids_filter

        # TRACK and SLEEP aren't implemented yet, so we never leave DETECT.
        self.mode = Mode.DETECT
        self.fps = 0.0
        self._previous_time = time.time()
        self._last_diagnostic_time = 0.0

        self.error: BaseException | None = (
            None  # Set if the thread died on an exception.
        )
        self._stop = threading.Event()
        self._done = threading.Event()
        self._cond = threading.Condition()
        self._result: DetectionResult | None = None
        self._result_seq = 0
        self._thread = threading.Thread(
            target=self._run, name="detection-loop", daemon=True
        )

    def start(self) -> "DetectionLoop":
        self._thread.start()
        return self

    def stop(self) -> None:
        """Ask the thread to exit after its current frame and wait for it."""
        self._stop.set()
        self._thread.join()

    @property
    def done(self) -> bool:
        return self._done.is_set()

    def wait(self, timeout: float) -> bool:
        """Block until the thread has exited; True if it did within ``timeout``."""
        return self._done.wait(timeout)

    def wait_result(
        self, last_seq: int, timeout: float = 0.1
    ) -> tuple[DetectionResult, int] | None:
        """Block until a result newer than ``last_seq`` exists; None on timeout or exit."""
        with self._cond:
            self._cond.wait_for(
                lambda: self._result_seq != last_seq or self._done.is_set(),
                timeout=timeout,
            )
            if self._result is None or self._result_seq == last_seq:
                return None
            return self._result, self._result_seq

    def _run(self) -> None:
        try:
            while not self._stop.is_set():
                got = self._grabber.latest()
                if got is None:
                    print(f"[{utc_ts()}] [detect] failed to read frame from camera")
                    break
                frame, captured_at = got

                if self.mode is Mode.DETECT:
                    result = self._detect(frame, captured_at)
                else:
                    raise NotImplementedError(
                        f"{self.mode} mode is not implemented yet"
                    )

                self._update_fps(len(result.boxes))
                result.fps = self.fps
                with self._cond:
                    self._result = result
                    self._result_seq += 1
                    self._cond.notify_all()
        except BaseException as exc:  # Re-raised on the main thread via ``error``.
            self.error = exc
        finally:
            self._done.set()
            with self._cond:
                self._cond.notify_all()

    def _detect(self, frame: np.ndarray, captured_at: float) -> DetectionResult:
        """Run the detector on a frame and publish the resulting state."""
        config = self._config
        assert config.model.input_size is not None  # load_config always resolves this
        infer_started_at = time.time()  # captured_at -> here is frame age.

        boxes, confidences, class_ids, fit = self._detector.infer(
            frame,
            config.model.input_size,
            config.model.fit,
            config.detection.confidence_threshold,
            config.detection.nms_iou_threshold,
            self._class_ids_filter,
        )
        inferred_at = time.time()
        frame_height, frame_width = frame.shape[:2]
        state = build_state(
            boxes,
            confidences,
            class_ids,
            self._labels,
            captured_at,
            infer_started_at,
            inferred_at,
            frame_size=(frame_width, frame_height),
            roi=roi_from_fit(fit, frame_width, frame_height, config.model.input_size),
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
        return DetectionResult(frame, boxes, confidences, class_ids)

    def _update_fps(self, num_detections: int) -> None:
        config = self._config
        now = time.time()
        self.fps = 0.9 * self.fps + 0.1 * (1.0 / max(now - self._previous_time, 1e-6))
        self._previous_time = now

        # Heartbeat log: print diagnostics on startup and every 1.0 second thereafter
        if now - self._last_diagnostic_time >= 1.0:
            print(
                f"[{utc_ts()}] [detect] mode={self.mode.name} fps={self.fps:.1f} "
                f"detections={num_detections} "
                f"backend={config.output.backend_url or 'disabled'} "
                f"use_vulkan={config.model.use_vulkan:1}"
            )
            self._last_diagnostic_time = now


def show_preview(loop: DetectionLoop, labels: list[str]) -> None:
    """Show annotated frames on the main thread until the loop ends or q is pressed."""
    last_seq = 0
    while not loop.done:
        got = loop.wait_result(last_seq)
        if got is not None:
            result, last_seq = got
            frame = result.frame.copy()  # The grabber still holds the original.
            draw_detections(
                frame, result.boxes, result.confidences, result.class_ids, labels
            )
            cv2.putText(
                frame,
                f"FPS: {result.fps:.1f}",
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

    loop = DetectionLoop(config, detector, grabber, labels, class_ids_filter).start()
    try:
        if config.headless:
            # Short timeouts keep the main thread responsive to Ctrl+C.
            while not loop.wait(0.5):
                pass
        else:
            show_preview(loop, labels)
    finally:
        loop.stop()
        cap.release()
        if not config.headless:
            cv2.destroyAllWindows()
    if loop.error is not None:
        raise loop.error


if __name__ == "__main__":
    main()
