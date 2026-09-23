"""Camera capture, frame preprocessing, and local display helpers."""

import threading
import time
from dataclasses import dataclass

import cv2
import numpy as np


@dataclass
class Fit:
    """Maps model-space pixel coordinates back to frame-space coordinates.

    model_x = (frame_x - offset_x) * scale_x
    model_y = (frame_y - offset_y) * scale_y
    so frame_x = model_x / scale_x + offset_x, etc.
    """

    scale_x: float
    scale_y: float
    offset_x: float
    offset_y: float


def letterbox(frame: np.ndarray, size: int) -> tuple[np.ndarray, float, int, int]:
    """Resize and pad a frame to a square while preserving aspect ratio."""
    h, w = frame.shape[:2]
    scale = size / max(h, w)
    nh, nw = int(round(h * scale)), int(round(w * scale))
    resized = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_LINEAR)

    padded = np.full((size, size, 3), 114, dtype=np.uint8)
    top = (size - nh) // 2
    left = (size - nw) // 2
    padded[top : top + nh, left : left + nw] = resized
    return padded, scale, left, top


def preprocess(
    frame: np.ndarray, size: int, fit: str = "crop"
) -> tuple[np.ndarray, Fit]:
    """Fit a frame into a square model input and return its tensor and geometry.

    fit: "crop" (center-crop to a square, then resize -- no padding),
    "squish" (resize directly to (size, size), ignoring aspect ratio), or
    "letterbox" (resize preserving aspect, pad with 114 gray to a square).
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
        geom = Fit(
            scale_x=scale, scale_y=scale, offset_x=-left / scale, offset_y=-top / scale
        )
    else:
        raise ValueError(f"Unknown fit strategy: {fit}")

    rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
    tensor = rgb.astype(np.float32) / 255.0
    tensor = np.ascontiguousarray(np.transpose(tensor, (2, 0, 1)))  # HWC -> CHW
    return tensor, geom


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


def draw_detections(
    frame: np.ndarray,
    boxes: np.ndarray,
    confidences: np.ndarray,
    class_ids: np.ndarray,
    labels: list[str],
) -> None:
    """Draw detection annotations on a camera frame in place."""
    for (x1, y1, x2, y2), conf, cls_id in zip(boxes, confidences, class_ids):
        x1, y1, x2, y2 = map(int, (x1, y1, x2, y2))
        label = labels[cls_id] if cls_id < len(labels) else str(cls_id)
        cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
        cv2.putText(
            frame,
            f"{label} {conf:.2f}",
            (x1, max(0, y1 - 6)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (0, 255, 0),
            1,
            cv2.LINE_AA,
        )


class LatestFrameGrabber:
    """Background thread that drains the camera continuously and keeps only the newest frame.

    Why: with a plain ``cap.read()`` in the inference loop, V4L2 queues frames
    (4 deep on the Pi) faster than we consume them (~6 fps vs 30 fps), so
    ``read()`` returns instantly with the *oldest* buffered frame -- ~100-130 ms
    stale, and invisible to any timestamp taken after ``read()`` returns.
    ``CAP_PROP_BUFFERSIZE`` is ignored by the V4L2 backend, so the only robust
    fix is to read at sensor rate on a separate thread (OpenCV releases the
    GIL inside ``read()``) and let inference grab whatever is newest. A frame
    is then at most ~one sensor period old when inference starts, and
    ``captured_at`` is stamped the moment the driver handed it over.
    """

    def __init__(self, cap: cv2.VideoCapture) -> None:
        self._cap = cap
        self._cond = threading.Condition()
        self._frame: np.ndarray | None = None
        self._captured_at = 0.0
        self._seq = 0
        self._consumed_seq = 0
        self._failed = False
        self.dropped = 0  # Frames read but never inferred (expected: most of them).
        self._thread = threading.Thread(
            target=self._run, name="camera-grab", daemon=True
        )

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

        Returns ``(frame, captured_at)``, or None if the camera failed or timed out.
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
