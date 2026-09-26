"""Nested config dataclasses for detect.py, and the generic YAML loader for them."""

import dataclasses
from dataclasses import dataclass, field
from pathlib import Path
from typing import TypeVar

MODEL_PATH = Path(__file__).parent / "yolov8n_ncnn_model" / "model.ncnn.param"
LABELS_PATH = Path(__file__).parent / "yolov8n_ncnn_model" / "metadata.yaml"
STATE_PATH = Path(__file__).parent.parent / "state" / "detections.json"
BACKEND_URL = "http://127.0.0.1:3000/api/detections"


@dataclass
class CameraConfig:
    source: int = 0  # Webcam device index
    width: int = 640  # Capture width
    height: int = 480  # Capture height


@dataclass
class ModelConfig:
    path: Path = MODEL_PATH  # NCNN .param export
    labels_path: Path = LABELS_PATH  # Model metadata YAML (export imgsz, class names)

    # Model input size in pixels (square). None defaults to the size the NCNN model was
    # exported at (metadata.yaml imgsz). The exported graph bakes its anchor grid for that
    # size, so any other value produces garbage boxes -- to change it, re-export the model
    # with dev/export_model.py --imgsz N and point path/labels_path at it.
    input_size: int | None = None

    # Strategy for fitting the camera frame into input_size: crop (center-crop to a square,
    # then resize), squish (resize directly, ignoring aspect ratio), or letterbox (resize
    # preserving aspect, pad with gray).
    fit: str = "crop"

    use_vulkan: bool = False  # Use Vulkan for GPU inference

    # NCNN CPU thread count. Pi 4B bench (320px, 2026-09-15): 1 thread=189ms/frame at 1.0
    # core, 3 threads=127ms at 2.8 cores -- threads scale poorly, so default to 1 and leave
    # cores for the UI.
    cpu_threads: int = 1


@dataclass
class DetectionConfig:
    confidence_threshold: float = 0.4
    nms_iou_threshold: float = 0.45

    # COCO labels to detect (see models/coco.names). Empty list detects all 80 classes.
    classes: list[str] = field(default_factory=lambda: ["person"])


@dataclass
class OutputConfig:
    state_path: Path = STATE_PATH  # Detection state JSON output path

    # JPEG snapshot output path for debugging, resized to 320px wide. Off by default: the Pi
    # is reachable over tailscale funnel and anything under state/ that the backend serves
    # would be public.
    snapshot_path: str = ""
    snapshot_interval: float = 1.0  # Minimum seconds between snapshot writes

    backend_url: str = BACKEND_URL  # POST target for detection state; "" disables it


@dataclass
class Config:
    """Detector configuration, loaded from --config's YAML. See detect-config.yaml."""

    camera: CameraConfig = field(default_factory=CameraConfig)
    model: ModelConfig = field(default_factory=ModelConfig)
    detection: DetectionConfig = field(default_factory=DetectionConfig)
    output: OutputConfig = field(default_factory=OutputConfig)

    # No GUI window -- just run detection and write output.state_path (Ctrl+C to quit).
    # True by default: the web-based /debug view has all but obsoleted the GUI window, which
    # mainly remains for ad hoc local debugging.
    headless: bool = True


T = TypeVar("T")


def build_config(cls: type[T], data: dict, path_ctx: str = "") -> T:
    """Recursively build a (possibly nested) dataclass from a YAML dict.

    A key missing at any level keeps that field's (or subtree's) dataclass default, so a
    config file only needs to list what it overrides.
    """
    field_names = {f.name for f in dataclasses.fields(cls)}
    unknown = set(data) - field_names
    if unknown:
        where = f" under '{path_ctx}'" if path_ctx else ""
        raise ValueError(f"Unknown config key(s){where}: {', '.join(sorted(unknown))}")

    kwargs = {}
    for f in dataclasses.fields(cls):
        if f.name not in data:
            continue
        value = data[f.name]
        if dataclasses.is_dataclass(f.type):
            value = build_config(f.type, value or {}, path_ctx=f.name)
        elif f.type is Path and value is not None:
            value = Path(value)
        kwargs[f.name] = value
    return cls(**kwargs)
