import { db } from "./db.ts";
import { markLastBroadcast, recordSample } from "./latency.ts";

export type Detection = {
  label: string;
  confidence?: number;
  box?: number[];
};

export type DetectionState = {
  timestamp: number;
  detections: Detection[];
  /** Unix seconds (float), from Python -- optional, absent from old clients / curl. */
  capturedAt?: number;
  inferredAt?: number;
  sentAt?: number;
};

/** Timing for one ingested state, ms epoch; null for any stage the client didn't send. */
export type StateTiming = {
  capturedAt: number | null;
  inferredAt: number | null;
  sentAt: number | null;
  receivedAt: number;
};

const EMPTY: DetectionState = { timestamp: 0, detections: [] };

let current: DetectionState = EMPTY;
let personInFrame = false;
const listeners = new Set<(inFrame: boolean, timing: StateTiming) => void>();

const insertStateChangeStmt = db.query<
  unknown,
  { $key: string; $value: string }
>(`INSERT INTO state_changes (key, value) VALUES ($key, $value)`);

function isDetection(d: unknown): d is Detection {
  if (!d || typeof d !== "object") return false;
  const rec = d as Record<string, unknown>;
  if (typeof rec.label !== "string") return false;
  if (rec.confidence !== undefined && typeof rec.confidence !== "number") return false;
  if (
    rec.box !== undefined &&
    !(Array.isArray(rec.box) && rec.box.every((v) => typeof v === "number"))
  ) {
    return false;
  }
  return true;
}

const optNum = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Validate an untyped payload as a DetectionState. Returns null if it doesn't match. */
export function parseDetectionState(data: unknown): DetectionState | null {
  if (!data || typeof data !== "object") return null;
  const rec = data as Record<string, unknown>;
  if (typeof rec.timestamp !== "number") return null;
  if (!Array.isArray(rec.detections) || !rec.detections.every(isDetection)) return null;
  return {
    timestamp: rec.timestamp,
    detections: rec.detections as Detection[],
    capturedAt: optNum(rec.capturedAt),
    inferredAt: optNum(rec.inferredAt),
    sentAt: optNum(rec.sentAt),
  };
}

/** Python sends unix seconds (float); everything downstream (latency ring, SSE) uses ms epoch. */
const toMs = (secs: number | undefined): number | null =>
  secs === undefined ? null : Math.round(secs * 1000);

/**
 * Apply a new detection state -- e.g. from POST /api/detections, sent by the
 * Python vision service (or `curl`, for testing). Records a state_changes
 * row and notifies SSE subscribers when `person_in_frame` flips.
 *
 * Returns the parsed state, or null if `data` didn't match the expected shape.
 */
export function ingestDetectionState(data: unknown): DetectionState | null {
  const parsed = parseDetectionState(data);
  if (!parsed) return null;

  const receivedAt = Date.now();
  const timing: StateTiming = {
    capturedAt: toMs(parsed.capturedAt),
    inferredAt: toMs(parsed.inferredAt),
    sentAt: toMs(parsed.sentAt),
    receivedAt,
  };

  current = parsed;
  const detected = parsed.detections.some((d) => d.label === "person");
  applyPersonState(detected, timing);
  return parsed;
}

/**
 * Resolve the effective person_in_frame (real detection OR an active debug
 * override), record a latency sample, and broadcast if it flipped.
 */
function applyPersonState(detected: boolean, timing: StateTiming): void {
  const next = detected || isOverrideActive();
  const transition = next !== personInFrame;

  recordSample({
    capturedAt: timing.capturedAt,
    inferredAt: timing.inferredAt,
    sentAt: timing.sentAt,
    receivedAt: timing.receivedAt,
    broadcastAt: null,
    personInFrame: next,
    transition,
  });

  if (transition) {
    personInFrame = next;
    insertStateChangeStmt.run({ $key: "person_in_frame", $value: String(next) });
    console.log(`[${new Date().toISOString()}] [detections] person_in_frame -> ${next}`);
    const broadcastAt = Date.now();
    markLastBroadcast(broadcastAt);
    for (const fn of listeners) fn(next, { ...timing, broadcastAt } as StateTiming & { broadcastAt: number });
  }
}

// --- Debug override: force person_in_frame=true for a while -----------------
// Lets /debug exercise the flower / latency UI without a live person in front
// of the camera. Real frames keep flowing (and keep feeding latency samples);
// they just can't flip the state back to false until the override expires.

let overrideUntil = 0;
let overrideTimer: ReturnType<typeof setTimeout> | null = null;

const isOverrideActive = (): boolean => Date.now() < overrideUntil;

/** Milliseconds left on the override, 0 if none. */
export const overrideRemainingMs = (): number => Math.max(0, overrideUntil - Date.now());

/**
 * Force person_in_frame for `seconds` (0 clears an existing override).
 * Broadcasts immediately, and again when the override expires if no real
 * person is in frame at that point.
 */
export function simulatePerson(seconds: number): void {
  if (overrideTimer) clearTimeout(overrideTimer);
  overrideTimer = null;
  overrideUntil = seconds > 0 ? Date.now() + seconds * 1000 : 0;

  const now = Date.now();
  const synthetic: StateTiming = { capturedAt: now, inferredAt: now, sentAt: now, receivedAt: now };
  const realDetected = current.detections.some((d) => d.label === "person");
  console.log(
    `[${new Date().toISOString()}] [detections] debug override ${seconds > 0 ? `on for ${seconds}s` : "cleared"}`,
  );
  applyPersonState(realDetected, synthetic);

  if (seconds > 0) {
    overrideTimer = setTimeout(() => {
      overrideTimer = null;
      const t = Date.now();
      const stillDetected = current.detections.some((d) => d.label === "person");
      applyPersonState(stillDetected, { capturedAt: t, inferredAt: t, sentAt: t, receivedAt: t });
    }, seconds * 1000 + 5);
  }
}

export const getState = (): DetectionState => current;
export const isPersonInFrame = (): boolean => personInFrame;

export function onPersonChange(
  fn: (inFrame: boolean, timing: StateTiming & { broadcastAt: number }) => void,
): () => void {
  listeners.add(fn as (inFrame: boolean, timing: StateTiming) => void);
  return () => listeners.delete(fn as (inFrame: boolean, timing: StateTiming) => void);
}
