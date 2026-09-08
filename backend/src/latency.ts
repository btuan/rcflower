/**
 * In-memory latency tracking for the person-detection pipeline:
 * frame capture (Python) -> inference (Python) -> POST sent (Python) ->
 * received/ingested (backend) -> broadcast over SSE (backend, transitions
 * only) -> browser (frontend, see /debug).
 *
 * All timestamps stored here are ms epoch, on the Pi's clock (Python and the
 * backend share a clock -- no skew correction needed for these stages; the
 * frontend is a separate device and does its own clock-offset estimation via
 * GET /api/time, see Debug.tsx).
 *
 * This is a plain in-memory ring buffer, not persisted -- it's diagnostic
 * data, cheap to lose on restart, and doesn't need SQLite's durability.
 */

export type LatencySample = {
  /** Python: cap.read() returned (ms epoch), or null if the client didn't send it. */
  capturedAt: number | null;
  /** Python: interpreter.invoke() + postprocess done (ms epoch), or null. */
  inferredAt: number | null;
  /** Python: about to POST (ms epoch), or null. */
  sentAt: number | null;
  /** Backend: Date.now() when ingestDetectionState ran. */
  receivedAt: number;
  /** Backend: Date.now() when this sample caused a `person` SSE broadcast, if it did. */
  broadcastAt: number | null;
  personInFrame: boolean;
  transition: boolean;
};

const RING_SIZE = 300;
const ring: LatencySample[] = [];

export function recordSample(sample: LatencySample): void {
  ring.push(sample);
  if (ring.length > RING_SIZE) ring.shift();
}

/** Attach a broadcastAt to the most recently recorded sample (called right after recordSample on a transition). */
export function markLastBroadcast(at: number): void {
  const last = ring[ring.length - 1];
  if (last) last.broadcastAt = at;
}

export function getSamples(): LatencySample[] {
  return ring;
}

type Stage = {
  label: string;
  from: keyof LatencySample;
  to: keyof LatencySample;
};

const STAGES: Stage[] = [
  { label: "capture->infer", from: "capturedAt", to: "inferredAt" },
  { label: "infer->sent", from: "inferredAt", to: "sentAt" },
  { label: "sent->received", from: "sentAt", to: "receivedAt" },
  { label: "received->broadcast", from: "receivedAt", to: "broadcastAt" },
];

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

export type StageStats = {
  label: string;
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
};

export function getStats(): StageStats[] {
  return STAGES.map(({ label, from, to }) => {
    const deltas: number[] = [];
    for (const s of ring) {
      const a = s[from];
      const b = s[to];
      if (typeof a === "number" && typeof b === "number") {
        deltas.push(b - a);
      }
    }
    deltas.sort((x, y) => x - y);
    return {
      label,
      count: deltas.length,
      p50: percentile(deltas, 50),
      p95: percentile(deltas, 95),
      max: deltas.length ? deltas[deltas.length - 1]! : null,
    };
  });
}
