"""NCNN model loading, inference, and YOLOv8 result processing."""

from pathlib import Path
from typing import Any, cast

import cv2
import ncnn
import numpy as np
import yaml

from camera import Fit, preprocess

NCNN = cast(Any, ncnn)


def load_labels(path: Path) -> list[str]:
    """Load labels from a plain text list or from Ultralytics export metadata YAML."""
    if path.suffix.lower() in {".yaml", ".yml"}:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        names = data.get("names")
        if isinstance(names, dict):
            ordered = []
            for key in sorted(
                names, key=lambda item: int(item) if str(item).isdigit() else 999999
            ):
                ordered.append(names[key])
            return ordered
        if isinstance(names, list):
            return names
        raise ValueError(f"No label names found in metadata file: {path}")

    return path.read_text(encoding="utf-8").strip().splitlines()


def load_export_imgsz(metadata_path: Path) -> int | None:
    """Square input size the model was exported at, from Ultralytics metadata.yaml (None if unknown)."""
    if (
        metadata_path.suffix.lower() not in {".yaml", ".yml"}
        or not metadata_path.exists()
    ):
        return None
    data = yaml.safe_load(metadata_path.read_text(encoding="utf-8")) or {}
    imgsz = data.get("imgsz")
    if isinstance(imgsz, list) and imgsz and all(isinstance(v, int) for v in imgsz):
        return int(imgsz[0])
    if isinstance(imgsz, int):
        return imgsz
    return None


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
    cx, cy, w, h = (
        boxes_xywh[:, 0],
        boxes_xywh[:, 1],
        boxes_xywh[:, 2],
        boxes_xywh[:, 3],
    )
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


class Detector:
    """An NCNN YOLOv8 model configured for repeated camera-frame inference."""

    def __init__(self, model_path: Path, use_vulkan: bool, threads: int) -> None:
        model_bin = (
            model_path.with_suffix(".bin")
            if model_path.suffix.lower() == ".param"
            else model_path.parent / f"{model_path.stem}.bin"
        )
        self.net = NCNN.Net()
        self.net.opt.use_vulkan_compute = use_vulkan
        self.net.opt.num_threads = threads
        self.net.load_param(str(model_path))
        self.net.load_model(str(model_bin))

    def infer(
        self,
        frame: np.ndarray,
        input_size: int,
        fit_strategy: str,
        conf_threshold: float,
        iou_threshold: float,
        class_ids_filter: set[int] | None,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray, Fit]:
        """Run the model and return boxes, confidences, class IDs, and frame geometry."""
        tensor, fit = preprocess(frame, input_size, fit_strategy)
        extractor = self.net.create_extractor()
        extractor.input("in0", NCNN.Mat(tensor).clone())
        _, output = extractor.extract("out0")
        boxes, confidences, class_ids = postprocess(
            np.asarray(output), fit, conf_threshold, iou_threshold, class_ids_filter
        )
        return boxes, confidences, class_ids, fit
