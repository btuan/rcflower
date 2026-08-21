"""
Minimal web interface for the USB webcam + YOLOv8n TFLite detector.

Runs the same capture/inference/NMS pipeline as detect.py, but serves the
annotated video as an MJPEG stream over HTTP instead of an OpenCV window --
useful for viewing the feed from a browser on the Pi or another machine on
the same network.
"""

import argparse
import threading
import time

import cv2
from ai_edge_litert.interpreter import Interpreter
from flask import Flask, Response

from detect import (
    LABELS_PATH,
    MODEL_PATH,
    draw_detections,
    load_labels,
    postprocess,
    preprocess,
)

app = Flask(__name__)

frame_lock = threading.Lock()
latest_jpeg: bytes | None = None


INDEX_HTML = """<!doctype html>
<html>
<head>
  <title>YOLOv8n Webcam Stream</title>
  <style>
    body { background: #111; color: #eee; font-family: sans-serif; text-align: center; }
    img { max-width: 100%; height: auto; border: 2px solid #444; }
  </style>
</head>
<body>
  <h1>YOLOv8n Webcam Stream</h1>
  <img src="/stream">
</body>
</html>
"""


def capture_loop(args: argparse.Namespace) -> None:
    global latest_jpeg

    labels = load_labels(args.labels)

    interpreter = Interpreter(model_path=str(args.model), num_threads=args.threads)
    interpreter.allocate_tensors()
    input_details = interpreter.get_input_details()[0]
    output_details = interpreter.get_output_details()[0]
    input_size = input_details["shape"][1]

    cap = cv2.VideoCapture(args.camera)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open camera index {args.camera}")

    fps = 0.0
    prev_time = time.time()

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                print("Failed to read frame from camera")
                break

            tensor, scale, pad_left, pad_top = preprocess(frame, input_size)
            interpreter.set_tensor(input_details["index"], tensor)
            interpreter.invoke()
            output = interpreter.get_tensor(output_details["index"])

            boxes, confidences, class_ids = postprocess(
                output, scale, pad_left, pad_top, args.conf, args.iou
            )
            draw_detections(frame, boxes, confidences, class_ids, labels)

            now = time.time()
            fps = 0.9 * fps + 0.1 * (1.0 / max(now - prev_time, 1e-6))
            prev_time = now
            cv2.putText(
                frame, f"FPS: {fps:.1f}", (10, 24),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2, cv2.LINE_AA,
            )

            ok, jpeg = cv2.imencode(".jpg", frame)
            if not ok:
                continue

            with frame_lock:
                latest_jpeg = jpeg.tobytes()
    finally:
        cap.release()


def mjpeg_generator():
    while True:
        with frame_lock:
            jpeg = latest_jpeg
        if jpeg is None:
            time.sleep(0.05)
            continue
        yield (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n"
        )
        time.sleep(0.03)


@app.route("/")
def index():
    return INDEX_HTML


@app.route("/stream")
def stream():
    return Response(
        mjpeg_generator(),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--camera", type=int, default=0, help="Webcam device index")
    parser.add_argument("--model", type=type(MODEL_PATH), default=MODEL_PATH)
    parser.add_argument("--labels", type=type(LABELS_PATH), default=LABELS_PATH)
    parser.add_argument("--conf", type=float, default=0.4, help="Confidence threshold")
    parser.add_argument("--iou", type=float, default=0.45, help="NMS IoU threshold")
    parser.add_argument("--width", type=int, default=640, help="Capture width")
    parser.add_argument("--height", type=int, default=480, help="Capture height")
    parser.add_argument("--threads", type=int, default=4, help="Interpreter CPU threads")
    parser.add_argument("--host", default="0.0.0.0", help="Web server bind address")
    parser.add_argument("--port", type=int, default=8000, help="Web server port")
    args = parser.parse_args()

    thread = threading.Thread(target=capture_loop, args=(args,), daemon=True)
    thread.start()

    app.run(host=args.host, port=args.port, threaded=True)


if __name__ == "__main__":
    main()
