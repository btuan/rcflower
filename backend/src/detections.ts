import { db } from "./db.ts";

export type Detection = {
  label: string;
  confidence?: number;
  box?: number[];
};

export type DetectionState = {
  timestamp: number;
  detections: Detection[];
};

const EMPTY: DetectionState = { timestamp: 0, detections: [] };

let current: DetectionState = EMPTY;
let personInFrame = false;
const listeners = new Set<(inFrame: boolean) => void>();

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

/** Validate an untyped payload as a DetectionState. Returns null if it doesn't match. */
export function parseDetectionState(data: unknown): DetectionState | null {
  if (!data || typeof data !== "object") return null;
  const rec = data as Record<string, unknown>;
  if (typeof rec.timestamp !== "number") return null;
  if (!Array.isArray(rec.detections) || !rec.detections.every(isDetection)) return null;
  return { timestamp: rec.timestamp, detections: rec.detections as Detection[] };
}

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

  current = parsed;
  const next = parsed.detections.some((d) => d.label === "person");
  if (next !== personInFrame) {
    personInFrame = next;
    insertStateChangeStmt.run({ $key: "person_in_frame", $value: String(next) });
    console.log(`[${new Date().toISOString()}] [detections] person_in_frame -> ${next}`);
    for (const fn of listeners) fn(next);
  }
  return parsed;
}

export const getState = (): DetectionState => current;
export const isPersonInFrame = (): boolean => personInFrame;

export function onPersonChange(fn: (inFrame: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
