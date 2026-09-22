"""One-off helper to (re)generate an NCNN model for the YOLOv8n detector.

The exported model is a runtime asset checked into the project root. Re-run
this only when changing the YOLOv8 size or input resolution. Requires the
``ultralytics`` development dependency (see ``pyproject.toml``).
"""

import argparse
import os
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


PROJECT_ROOT = Path(__file__).resolve().parents[1]


@contextmanager
def working_directory(path: Path) -> Iterator[None]:
    """Temporarily use ``path`` as the process working directory."""
    previous = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(previous)


def project_path(value: str) -> Path:
    """Interpret relative command-line paths from the Python project root."""
    path = Path(value)
    return path if path.is_absolute() else PROJECT_ROOT / path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--weights",
        default="yolov8n.pt",
        help="Ultralytics weights name/path, relative to the Python project root",
    )
    parser.add_argument("--imgsz", type=int, default=320, help="Square input resolution")
    parser.add_argument(
        "--precision",
        choices=["float32", "float16"],
        default="float32",
        help="float32 is more portable; float16 can be faster on some hardware.",
    )
    args = parser.parse_args()

    from ultralytics import YOLO

    # Ultralytics derives NCNN's output directory from the source weights path
    # and exposes no NCNN output-directory option. Running from PROJECT_ROOT
    # keeps any relative paths and supporting export artifacts there as well.
    with working_directory(PROJECT_ROOT):
        model = YOLO(project_path(args.weights))
        exported = model.export(
            format="ncnn",
            imgsz=args.imgsz,
            quantize=(16 if args.precision == "float16" else 32),
            simplify=True,
        )
        exported_path = Path(exported).resolve()

    print(f"Wrote {exported_path}")


if __name__ == "__main__":
    main()
