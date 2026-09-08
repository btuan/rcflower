"""
One-off helper to (re)generate an OpenVINO IR model for the YOLOv8n detector.

Not needed to run detect.py -- the exported model is already checked into
models/. Re-run this only if you want a different YOLOv8 size/input
resolution. Requires the dev deps: `pip install ultralytics openvino`.
"""

import argparse
import shutil
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
    # if exported_path.suffix.lower() != ".xml":
    #     xml_matches = sorted(exported_path.glob("*.xml"))
    #     if not xml_matches:
    #         raise FileNotFoundError(f"No OpenVINO XML model was produced at {exported_path}")
    #     exported_path = xml_matches[0]

    # exported_bin = exported_path.with_suffix(".bin")
    # if not exported_bin.exists():
    #     raise FileNotFoundError(f"OpenVINO bin file not found next to {exported_path}")

    print(f"Wrote {exported_path}")
    # print(f"Wrote {exported_bin}")


if __name__ == "__main__":
    main()
