"""Publish detection state and snapshots to the web-serving process."""

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


def utc_ts() -> str:
    """Return the current time as an ISO 8601 UTC timestamp.

    This function takes the output of ``datetime.isoformat()`` and replaces the trailing
    ``+00:00`` with a ``Z``. For example, it would return ``2026-09-04T15:43:06.123Z``.
    """
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


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
    """Build a JSON-serializable detection message to be shared with the backend.

    ``timestamp`` is retained for backward compatibility and equals ``capturedAt``.
    ``capturedAt`` / ``inferredAt`` are stamped around capture and inference;
    ``sentAt`` is stamped immediately before the POST. These are Unix seconds
    on the shared Pi clock, allowing the backend to expose capture-to-receipt
    latency.

    ``frame_size`` ([w, h]) and ``roi`` ([x1, y1, x2, y2], frame pixels) describe
    the raw camera frame and the rectangle the model saw after ``--fit``. The frontend
    uses them to position the flower relative to the person's location in the real frame.
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
                "box": [round(float(value), 1) for value in box],
            }
            for box, conf, cls_id in zip(boxes, confidences, class_ids)
        ],
    }
    if frame_size is not None:
        state["frameSize"] = [int(frame_size[0]), int(frame_size[1])]
    if roi is not None:
        state["roi"] = [round(float(value), 1) for value in roi]
    return state


def write_state(path: Path, state: dict) -> None:
    """Atomically write detection state to a JSON file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as file:
            json.dump(state, file)
        os.replace(tmp_path, path)
    except BaseException:
        os.unlink(tmp_path)
        raise


# Log throttling for post_state(): a POST fires every frame, but printing every
# frame would flood stdout. Log at most once/sec while detections are present, and
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
    """Publish a throttled, resized JPEG snapshot through the current file IPC.

    This is the current approximation of a stream for the disabled debug view.
    It must stay cheap on a Pi 4 (<5ms/sec average), so almost every call is a no-op
    timestamp check; resize and encoding happen only about once per second regardless
    of the camera or inference frame rate. Atomic write, mirroring ``write_state``.
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
