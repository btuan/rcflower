"""
One-off helper to (re)generate an NCNN model for the YOLOv8n detector.

Not needed to run detect.py -- the exported model is already checked into
models/. Re-run this only if you want a different YOLOv8 size/input
resolution. Requires the dev dependency `ultralytics` (see `pyproject.toml`).
"""

import argparse
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", default="yolov8n.pt", help="Ultralytics weights name/path")
    parser.add_argument("--imgsz", type=int, default=320, help="Square input resolution")
    parser.add_argument(
        "--precision", choices=["float32", "float16"], default="float32",
        help="float32 is more portable; float16 can be faster on some hardware.",
    )
    args = parser.parse_args()

    from ultralytics import YOLO

    model = YOLO(args.weights)
    exported = model.export(
        format="ncnn",
        imgsz=args.imgsz,
        quantize=(16 if args.precision == "float16" else 32),
        simplify=True,
    )

    exported_path = Path(exported)
    print(f"Wrote {exported_path}")


if __name__ == "__main__":
    main()
