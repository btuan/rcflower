"""
One-off helper to (re)generate models/yolov8n.tflite.

Not needed to run detect.py -- the exported model is already checked into
models/. Re-run this only if you want a different YOLOv8 size/input
resolution. Requires the extra dev deps: `pip install ultralytics onnx2tf
onnx onnxslim sng4onnx onnx_graphsurgeon tensorflow`.
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
        help="float32 is more portable; float16 halves model size",
    )
    parser.add_argument("--out", type=Path, default=Path(__file__).parent / "models" / "yolov8n.tflite")
    args = parser.parse_args()

    from ultralytics import YOLO

    model = YOLO(args.weights)
    onnx_path = model.export(format="onnx", imgsz=args.imgsz, simplify=True, opset=12)

    import onnx2tf

    out_dir = Path(onnx_path).with_suffix("") .as_posix() + "_saved_model"
    onnx2tf.convert(input_onnx_file_path=onnx_path, output_folder_path=out_dir, output_signaturedefs=True)

    stem = Path(onnx_path).stem
    produced = Path(out_dir) / f"{stem}_{args.precision}.tflite"
    args.out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(produced, args.out)
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
