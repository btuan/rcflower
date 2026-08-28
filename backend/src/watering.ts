import { db } from "./db.ts";

export type WateringEvent = {
  id: number;
  trigger: string;
  durationMs: number | null;
  volumeMl: number | null;
  notes: string | null;
  srcIp: string | null;
  wateredAt: number;
};

const COLUMNS = `id, trigger, duration_ms AS durationMs, volume_ml AS volumeMl, notes, src_ip AS srcIp, watered_at AS wateredAt`;

const insertStmt = db.query<
  WateringEvent,
  {
    $trigger: string;
    $durationMs: number | null;
    $volumeMl: number | null;
    $notes: string | null;
    $srcIp: string | null;
  }
>(`
  INSERT INTO watering_events (trigger, duration_ms, volume_ml, notes, src_ip)
  VALUES ($trigger, $durationMs, $volumeMl, $notes, $srcIp)
  RETURNING ${COLUMNS}
`);

const recentStmt = db.query<WateringEvent, { $limit: number }>(`
  SELECT ${COLUMNS} FROM watering_events ORDER BY watered_at DESC LIMIT $limit
`);

const listeners = new Set<(e: WateringEvent) => void>();

/** Insert a watering event, then notify SSE subscribers. */
export function recordWatering(input: {
  trigger?: string;
  durationMs?: number | null;
  volumeMl?: number | null;
  notes?: string | null;
  srcIp?: string | null;
}): WateringEvent {
  const event = insertStmt.get({
    $trigger: input.trigger ?? "manual",
    $durationMs: input.durationMs ?? null,
    $volumeMl: input.volumeMl ?? null,
    $notes: input.notes ?? null,
    $srcIp: input.srcIp ?? null,
  })!;
  for (const fn of listeners) fn(event);
  return event;
}

export const recentWatering = (limit = 50): WateringEvent[] =>
  recentStmt.all({ $limit: limit });

export function onWatering(fn: (e: WateringEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
