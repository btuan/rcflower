import { useEffect, useRef, useState } from "react";
import { frameToCanvas, pointToCanvas, type Box } from "./detectionViewMath";

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
 * Detection boxes / ROI drawn on a blank frame for /debug. The camera image
 * itself is deliberately NOT shown: the Pi is exposed via tailscale funnel, so
 * anything the backend serves is public. Bring the snapshot back once the
 * debug routes sit behind auth.
 */
export function DetectionView({ latestTrack }: { latestTrack: TrackPayload | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [detections, setDetections] = useState<DetectionsResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());

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

  // Redraw whenever the boxes or frame size change.
  useEffect(() => {
    const canvas = canvasRef.current;
    const fs = detections?.frameSize;
    if (!canvas || !fs) return;
    const [nw, nh] = fs;
    const scale = DISPLAY_WIDTH / nw;
    const canvasW = DISPLAY_WIDTH;
    const canvasH = Math.round(nh * scale);
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#1f1f1f";
    ctx.fillRect(0, 0, canvasW, canvasH);
    // Mirrored horizontally so the view matches what a person facing the
    // display sees (camera and display face the same way); boxes are mirrored
    // in coordinate space so their labels stay readable.
    const mirrorBox = ([x1, y1, x2, y2]: Box): Box => [canvasW - x2, y1, canvasW - x1, y2];

    const frameSize = detections?.frameSize ?? null;
    const canvasSize: [number, number] = [canvasW, canvasH];

    if (frameSize && detections?.roi) {
      const [x1, y1, x2, y2] = mirrorBox(frameToCanvas(detections.roi, frameSize, canvasSize));
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
        const [x1, y1, x2, y2] = mirrorBox(frameToCanvas(det.box, frameSize, canvasSize));
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        ctx.fillText(`${det.label} ${det.confidence.toFixed(2)}`, x1 + 2, Math.max(10, y1 - 4));
      }
      ctx.restore();
    }

    if (frameSize && latestTrack?.primary) {
      const { cx, cy } = latestTrack.primary;
      const [px0, py] = pointToCanvas([cx * frameSize[0], cy * frameSize[1]], frameSize, canvasSize);
      const px = canvasW - px0;
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
  }, [detections, latestTrack]);

  const capturedAgeS =
    detections?.capturedAt != null
      ? ((now - detections.capturedAt * 1000) / 1000).toFixed(1)
      : null;
  const frameSize = detections?.frameSize ?? null;
  const roi = detections?.roi ?? null;
  const n = latestTrack?.n ?? detections?.detections.length ?? 0;

  return (
    <div className="mb-6 rounded border border-neutral-700 p-3">
      <div className="mb-2 font-bold">detections (boxes only -- camera image disabled while public)</div>
      {frameSize ? (
        <canvas
          ref={canvasRef}
          className="block max-w-full rounded border border-neutral-800"
          style={{ width: DISPLAY_WIDTH }}
        />
      ) : (
        <p className="text-neutral-500">waiting for the detector…</p>
      )}
      <p className="mt-2 text-neutral-400">
        frame {frameSize ? `${frameSize[0]}x${frameSize[1]}` : "—"} · roi{" "}
        {roi ? `[${roi.map((v) => Math.round(v)).join(",")}]` : "—"} · {n} persons · mirrored · frame age{" "}
        {capturedAgeS !== null ? `${capturedAgeS} s` : "—"}
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
