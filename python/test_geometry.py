"""Tests for preprocess/postprocess geometry across --fit strategies.

Frame is 640x480 (w x h). Model input size is 224.
"""

import numpy as np
import pytest

from detect import preprocess, postprocess

FRAME_W, FRAME_H = 640, 480
SIZE = 224


def make_frame() -> np.ndarray:
    return np.zeros((FRAME_H, FRAME_W, 3), dtype=np.uint8)


def make_output(cx: float, cy: float, w: float, h: float, num_classes: int = 80) -> np.ndarray:
    """Build a fake (4 + num_classes, 1) YOLOv8-style output with one confident box.

    Class 0 gets a high score; everything else is low, so exactly one box
    survives confidence filtering and NMS.
    """
    num_boxes = 1
    output = np.zeros((4 + num_classes, num_boxes), dtype=np.float32)
    output[0, 0] = cx
    output[1, 0] = cy
    output[2, 0] = w
    output[3, 0] = h
    output[4, 0] = 0.9  # class 0 confidence
    return output


def test_crop_output_shape_and_dtype():
    frame = make_frame()
    tensor, fit = preprocess(frame, SIZE, "crop")
    assert tensor.shape == (3, SIZE, SIZE)
    assert tensor.dtype == np.float32


def test_letterbox_center_box_maps_back():
    frame = make_frame()
    _, fit = preprocess(frame, SIZE, "letterbox")
    # 640x480 -> scale = 224/640 = 0.35; nh = 480*0.35 = 168; pad_top = (224-168)/2 = 28
    # A model-space box centered at the model's center should map back to the frame's center.
    boxes, confidences, class_ids = postprocess(
        make_output(SIZE / 2, SIZE / 2, 20, 20), fit, conf_threshold=0.5, iou_threshold=0.45
    )
    assert len(boxes) == 1
    x1, y1, x2, y2 = boxes[0]
    cx = (x1 + x2) / 2
    cy = (y1 + y2) / 2
    assert cx == pytest.approx(FRAME_W / 2, abs=1.0)
    assert cy == pytest.approx(FRAME_H / 2, abs=1.0)


def test_crop_edge_box_maps_back():
    frame = make_frame()
    _, fit = preprocess(frame, SIZE, "crop")
    # side = min(640, 480) = 480; left crop origin = (640-480)/2 = 80.
    # model x = 0 should map back to frame x = 80 (the crop's left edge).
    boxes, confidences, class_ids = postprocess(
        make_output(0.0, SIZE / 2, 0.0, 20), fit, conf_threshold=0.5, iou_threshold=0.45
    )
    assert len(boxes) == 1
    x1, y1, x2, y2 = boxes[0]
    assert x1 == pytest.approx(80.0, abs=1.0)


def test_squish_different_x_y_scale():
    frame = make_frame()
    _, fit = preprocess(frame, SIZE, "squish")
    assert fit.scale_x == pytest.approx(SIZE / FRAME_W)
    assert fit.scale_y == pytest.approx(SIZE / FRAME_H)
    # Model-space box spanning the full model width/height should map back to
    # the full frame width/height.
    boxes, confidences, class_ids = postprocess(
        make_output(SIZE / 2, SIZE / 2, SIZE, SIZE), fit, conf_threshold=0.5, iou_threshold=0.45
    )
    assert len(boxes) == 1
    x1, y1, x2, y2 = boxes[0]
    assert x1 == pytest.approx(0.0, abs=1.0)
    assert y1 == pytest.approx(0.0, abs=1.0)
    assert x2 == pytest.approx(FRAME_W, abs=1.0)
    assert y2 == pytest.approx(FRAME_H, abs=1.0)
