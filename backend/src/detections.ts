import { config } from "./config.ts";

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

async function readState(): Promise<DetectionState> {
  try {
    const data = (await Bun.file(config.statePath).json()) as unknown;
    if (
      data &&
      typeof data === "object" &&
      Array.isArray((data as DetectionState).detections)
    ) {
      return data as DetectionState;
    }
    return EMPTY;
  } catch {
    // File missing / mid-write / invalid JSON -- treat as no detections.
    return EMPTY;
  }
}

async function poll(): Promise<void> {
  current = await readState();
  const next = current.detections.some((d) => d.label === "person");
  if (next !== personInFrame) {
    personInFrame = next;
    for (const fn of listeners) fn(next);
  }
}

/** Begin polling the detection state file. Returns a stop function. */
export function watchDetections(): () => void {
  void poll();
  const timer = setInterval(() => void poll(), config.pollIntervalMs);
  return () => clearInterval(timer);
}

export const getState = (): DetectionState => current;
export const isPersonInFrame = (): boolean => personInFrame;

export function onPersonChange(fn: (inFrame: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
