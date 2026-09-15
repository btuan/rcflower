import { useEffect, useRef, useState } from "react";
import { frameToCanvas, pointToCanvas, type Box } from "./detectionViewMath";

const SNAPSHOT_POLL_MS = 1000;
const DETECTIONS_POLL_MS = 250;
const DISPLAY_WIDTH = 480;

type Detection = { label: string; confidence: number; box: Box };

type DetectionsResponse = {
  frameSize: [number, number] | null;
  roi: Box | null;
  detections: Detection[];
  capturedAt: number | null;
};

export type TrackPayload = {
  n: number;
  primary: { cx: number; cy: number; w: number; h: number; conf: number } | null;
  capturedAt: number | null;
};

/**
 * 1 Hz camera snapshot + detection boxes / ROI overlay for /debug. No video
 * streaming: just a still image refreshed on an interval, redrawn with the
 * latest boxes whenever either the image or the detections change.
 */
export function DetectionView({ latestTrack }: { latestTrack: TrackPayload | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [naturalSize, setNaturalSize] = useState<[number, number] | null>(null);
  const [lastImageLoadAt, setLastImageLoadAt] = useState<number | null>(null);
  const [hasImage, setHasImage] = useState(false);
  const [detections, setDetections] = useState<DetectionsResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Poll the snapshot image at 1 Hz. Keep the previous frame on failure.
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        imgRef.current = img;
        setNaturalSize([img.naturalWidth, img.naturalHeight]);
        setLastImageLoadAt(Date.now());
        setHasImage(true);
      };
      img.onerror = () => {
        // best-effort: keep showing the previous frame (e.g. 404 before the
        // detector has written its first snapshot).
      };
      img.src = `/api/debug/frame.jpg?t=${Date.now()}`;
    };
    poll();
    const id = setInterval(poll, SNAPSHOT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Poll boxes/roi at 250ms -- cheap JSON, independent of the image cadence.
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      fetch("/api/detections/latest")
        .then((r) => (r.ok ? (r.json() as Promise<DetectionsResponse>) : null))
        .then((data) => {
          if (!cancelled && data) setDetections(data);
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, DETECTIONS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Tick "snapshot age" display once a second.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Redraw whenever the image, boxes, or frame size change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !naturalSize) return;
    const [nw, nh] = naturalSize;
    const scale = DISPLAY_WIDTH / nw;
    const canvasW = DISPLAY_WIDTH;
    const canvasH = Math.round(nh * scale);
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvasW, canvasH);
    if (imgRef.current) {
      ctx.drawImage(imgRef.current, 0, 0, canvasW, canvasH);
    }

    const frameSize = detections?.frameSize ?? null;
    const canvasSize: [number, number] = [canvasW, canvasH];

    if (frameSize && detections?.roi) {
      const [x1, y1, x2, y2] = frameToCanvas(detections.roi, frameSize, canvasSize);
      ctx.save();
      ctx.strokeStyle = "rgba(180, 180, 180, 0.7)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.restore();
    }

    if (frameSize && detections?.detections) {
      ctx.save();
      ctx.strokeStyle = "#22c55e";
      ctx.fillStyle = "#22c55e";
      ctx.lineWidth = 2;
      ctx.font = "12px monospace";
      for (const det of detections.detections) {
        const [x1, y1, x2, y2] = frameToCanvas(det.box, frameSize, canvasSize);
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        ctx.fillText(`${det.label} ${det.confidence.toFixed(2)}`, x1 + 2, Math.max(10, y1 - 4));
      }
      ctx.restore();
    }

    if (frameSize && latestTrack?.primary) {
      const { cx, cy } = latestTrack.primary;
      const [px, py] = pointToCanvas([cx * frameSize[0], cy * frameSize[1]], frameSize, canvasSize);
      ctx.save();
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px - 8, py);
      ctx.lineTo(px + 8, py);
      ctx.moveTo(px, py - 8);
      ctx.lineTo(px, py + 8);
      ctx.stroke();
      ctx.restore();
    }
  }, [naturalSize, detections, latestTrack, lastImageLoadAt]);

  const ageS = lastImageLoadAt !== null ? ((now - lastImageLoadAt) / 1000).toFixed(1) : null;
  const frameSize = detections?.frameSize ?? null;
  const roi = detections?.roi ?? null;
  const n = latestTrack?.n ?? detections?.detections.length ?? 0;

  return (
    <div className="mb-6 rounded border border-neutral-700 p-3">
      <div className="mb-2 font-bold">detection snapshot</div>
      {hasImage ? (
        <canvas
          ref={canvasRef}
          className="block max-w-full rounded border border-neutral-800"
          style={{ width: DISPLAY_WIDTH }}
        />
      ) : (
        <p className="text-neutral-500">no snapshot yet</p>
      )}
      <p className="mt-2 text-neutral-400">
        frame {frameSize ? `${frameSize[0]}x${frameSize[1]}` : "—"} · roi{" "}
        {roi ? `[${roi.map((v) => Math.round(v)).join(",")}]` : "—"} · {n} persons · snapshot age{" "}
        {ageS !== null ? `${ageS} s` : "—"}
      </p>
      {latestTrack && (
        <p className="text-neutral-500">
          track n={latestTrack.n}
          {latestTrack.primary
            ? ` · cx=${latestTrack.primary.cx.toFixed(3)}, cy=${latestTrack.primary.cy.toFixed(3)}`
            : ""}
        </p>
      )}
    </div>
  );
}
