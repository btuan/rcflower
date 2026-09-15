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
  inferStartedAt?: number;
  inferredAt?: number;
  sentAt?: number;
  /** Raw camera frame dims [w, h], pixels -- optional, absent from old clients / curl. */
  frameSize?: [number, number];
  /** Frame-pixel rectangle [x1, y1, x2, y2] the model actually saw, after --fit. */
  roi?: [number, number, number, number];
};

/** A person detection's box, normalized 0..1 relative to frameSize, plus confidence. */
export type PrimaryTrack = { cx: number; cy: number; w: number; h: number; conf: number };

export type TrackEvent = { n: number; primary: PrimaryTrack | null; capturedAt: number | null };

/** Timing for one ingested state, ms epoch; null for any stage the client didn't send. */
export type StateTiming = {
  capturedAt: number | null;
  inferStartedAt: number | null;
  inferredAt: number | null;
  sentAt: number | null;
  receivedAt: number;
};

const EMPTY: DetectionState = { timestamp: 0, detections: [] };

let current: DetectionState = EMPTY;
let personInFrame = false;
let lastTrackN = 0;
const listeners = new Set<(inFrame: boolean, timing: StateTiming) => void>();
const trackListeners = new Set<(event: TrackEvent) => void>();

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

const isPairOfNums = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n));

const isQuadOfNums = (v: unknown): v is [number, number, number, number] =>
  Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number" && Number.isFinite(n));

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
    inferStartedAt: optNum(rec.inferStartedAt),
    inferredAt: optNum(rec.inferredAt),
    sentAt: optNum(rec.sentAt),
    frameSize: isPairOfNums(rec.frameSize) ? rec.frameSize : undefined,
    roi: isQuadOfNums(rec.roi) ? rec.roi : undefined,
  };
}

/**
 * Pick the `person` detection with the largest box area, normalize its box
 * to 0..1 relative to `frameSize`. Pure function, exported for testing.
 * Returns null if there's no frameSize, no box, or no person detection.
 */
export function computePrimaryTrack(
  detections: Detection[],
  frameSize: [number, number] | undefined,
): PrimaryTrack | null {
  if (!frameSize) return null;
  const [fw, fh] = frameSize;
  if (!(fw > 0) || !(fh > 0)) return null;

  let best: { box: number[]; conf: number; area: number } | null = null;
  for (const d of detections) {
    if (d.label !== "person" || !d.box || d.box.length !== 4) continue;
    const [x1, y1, x2, y2] = d.box;
    const area = Math.max(0, x2! - x1!) * Math.max(0, y2! - y1!);
    if (!best || area > best.area) best = { box: d.box, conf: d.confidence ?? 0, area };
  }
  if (!best) return null;

  const [x1, y1, x2, y2] = best.box;
  return {
    cx: ((x1! + x2!) / 2) / fw,
    cy: ((y1! + y2!) / 2) / fh,
    w: (x2! - x1!) / fw,
    h: (y2! - y1!) / fh,
    conf: best.conf,
  };
}

/** Intersection-over-union of two [x1, y1, x2, y2] boxes. Pure, exported for testing. */
export function iou(a: number[], b: number[]): number {
  const [ax1, ay1, ax2, ay2] = a;
  const [bx1, by1, bx2, by2] = b;
  const ix1 = Math.max(ax1!, bx1!);
  const iy1 = Math.max(ay1!, by1!);
  const ix2 = Math.min(ax2!, bx2!);
  const iy2 = Math.min(ay2!, by2!);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const interArea = iw * ih;
  if (interArea <= 0) return 0;
  const areaA = Math.max(0, ax2! - ax1!) * Math.max(0, ay2! - ay1!);
  const areaB = Math.max(0, bx2! - bx1!) * Math.max(0, by2! - by1!);
  const union = areaA + areaB - interArea;
  return union > 0 ? interArea / union : 0;
}

type Track = {
  id: number;
  box: number[]; // [x1, y1, x2, y2] frame px
  conf: number;
  lastSeenMs: number;
  hits: number;
};

const IOU_MATCH_THRESHOLD = 0.3;
const TRACK_EMA_ALPHA = 0.6;
const TRACK_STALE_MS = 700;
const PRIMARY_MIN_HITS = 2;

/**
 * A small pure(-ish; internal mutable state) IoU tracker that keeps the
 * "primary" person sticky across frames instead of re-picking the largest
 * box every frame. Exported for testing.
 */
export class PrimaryTracker {
  private tracks: Track[] = [];
  private nextId = 1;
  private primaryId: number | null = null;

  /**
   * Advance the tracker by one frame. `detections` should already be
   * filtered/left as-is -- only `person` detections with a box are used.
   * Returns the normalized primary (plus its track id), or null.
   */
  update(
    detections: Detection[],
    frameSize: [number, number] | undefined,
    nowMs: number,
  ): (PrimaryTrack & { id: number }) | null {
    const people = detections.filter(
      (d): d is Detection & { box: number[] } =>
        d.label === "person" && Array.isArray(d.box) && d.box.length === 4,
    );

    // Greedily match detections to existing tracks by IoU, highest first.
    const candidates: { trackIdx: number; detIdx: number; iou: number }[] = [];
    for (let ti = 0; ti < this.tracks.length; ti++) {
      for (let di = 0; di < people.length; di++) {
        const score = iou(this.tracks[ti]!.box, people[di]!.box);
        if (score >= IOU_MATCH_THRESHOLD) candidates.push({ trackIdx: ti, detIdx: di, iou: score });
      }
    }
    candidates.sort((a, b) => b.iou - a.iou);

    const matchedTracks = new Set<number>();
    const matchedDets = new Set<number>();
    for (const c of candidates) {
      if (matchedTracks.has(c.trackIdx) || matchedDets.has(c.detIdx)) continue;
      matchedTracks.add(c.trackIdx);
      matchedDets.add(c.detIdx);
      const track = this.tracks[c.trackIdx]!;
      const det = people[c.detIdx]!;
      const newBox = det.box;
      track.box = track.box.map((v, i) => v * (1 - TRACK_EMA_ALPHA) + newBox[i]! * TRACK_EMA_ALPHA);
      track.conf = det.confidence ?? 0;
      track.lastSeenMs = nowMs;
      track.hits += 1;
    }

    // Unmatched detections start new tracks.
    for (let di = 0; di < people.length; di++) {
      if (matchedDets.has(di)) continue;
      const det = people[di]!;
      this.tracks.push({
        id: this.nextId++,
        box: [...det.box],
        conf: det.confidence ?? 0,
        lastSeenMs: nowMs,
        hits: 1,
      });
    }

    // Drop stale tracks.
    this.tracks = this.tracks.filter((t) => nowMs - t.lastSeenMs <= TRACK_STALE_MS);

    // Sticky primary: keep it if it still exists.
    let primary = this.primaryId !== null ? this.tracks.find((t) => t.id === this.primaryId) : undefined;

    if (!primary) {
      const eligible = this.tracks.filter((t) => t.hits >= PRIMARY_MIN_HITS);
      let best: Track | null = null;
      let bestArea = -1;
      for (const t of eligible) {
        const [x1, y1, x2, y2] = t.box;
        const area = Math.max(0, x2! - x1!) * Math.max(0, y2! - y1!);
        if (area > bestArea) {
          bestArea = area;
          best = t;
        }
      }
      primary = best ?? undefined;
      this.primaryId = primary ? primary.id : null;
    }

    if (!primary || !frameSize) return null;
    const [fw, fh] = frameSize;
    if (!(fw > 0) || !(fh > 0)) return null;

    const [x1, y1, x2, y2] = primary.box;
    return {
      id: primary.id,
      cx: ((x1! + x2!) / 2) / fw,
      cy: ((y1! + y2!) / 2) / fh,
      w: (x2! - x1!) / fw,
      h: (y2! - y1!) / fh,
      conf: primary.conf,
    };
  }
}

const primaryTracker = new PrimaryTracker();

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
    inferStartedAt: toMs(parsed.inferStartedAt),
    inferredAt: toMs(parsed.inferredAt),
    sentAt: toMs(parsed.sentAt),
    receivedAt,
  };

  current = parsed;
  const detected = parsed.detections.some((d) => d.label === "person");
  applyPersonState(detected, timing);
  emitTrack(parsed, timing);
  return parsed;
}

/**
 * Broadcast a `track` event on every ingested frame while persons are
 * present, and exactly once with `n: 0, primary: null` on the transition to
 * zero persons (not repeatedly while empty).
 */
function emitTrack(parsed: DetectionState, timing: StateTiming): void {
  const n = parsed.detections.filter((d) => d.label === "person").length;
  const nowMs = timing.capturedAt ?? timing.receivedAt;
  const tracked = primaryTracker.update(parsed.detections, parsed.frameSize, nowMs);

  if (n === 0 && lastTrackN === 0) return;
  lastTrackN = n;

  const primary = n > 0 ? tracked : null;
  if (n > 0 && !primary) return; // no frameSize -- can't normalize, skip per contract

  const event: TrackEvent = { n, primary, capturedAt: timing.capturedAt };
  for (const fn of trackListeners) fn(event);
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
    inferStartedAt: timing.inferStartedAt,
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
  const synthetic: StateTiming = { capturedAt: now, inferStartedAt: now, inferredAt: now, sentAt: now, receivedAt: now };
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
      applyPersonState(stillDetected, { capturedAt: t, inferStartedAt: t, inferredAt: t, sentAt: t, receivedAt: t });
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

export function onTrack(fn: (event: TrackEvent) => void): () => void {
  trackListeners.add(fn);
  return () => trackListeners.delete(fn);
}
