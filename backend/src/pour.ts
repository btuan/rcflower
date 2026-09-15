/**
 * Live "the can is tipped right now" state, reported by the watering-can
 * client while a pour is in progress and broadcast over SSE.
 *
 * This is deliberately separate from watering.ts: a watering *event* is a
 * completed pour with a duration, written to the DB once at the end. This is
 * the transient in-between state, held in memory only.
 */

/**
 * A pour that never gets a stop signal (phone locked, tab closed, network
 * dropped mid-pour) would otherwise leave the flower pouring forever, so a
 * start expires on its own after this long.
 */
const MAX_POUR_MS = 30_000;

let pouring = false;
let changedAt = Date.now();
let expiry: ReturnType<typeof setTimeout> | null = null;

const listeners = new Set<(pouring: boolean, changedAt: number) => void>();

export type PourState = { pouring: boolean; changedAt: number };

export const pourState = (): PourState => ({ pouring, changedAt });

export const isPouring = (): boolean => pouring;

/** Set the live pour state; no-ops (and notifies nobody) if unchanged. */
export function setPouring(next: boolean): PourState {
  if (expiry) {
    clearTimeout(expiry);
    expiry = null;
  }
  if (next) expiry = setTimeout(() => setPouring(false), MAX_POUR_MS);

  if (next === pouring) return pourState();

  pouring = next;
  changedAt = Date.now();
  for (const fn of listeners) fn(pouring, changedAt);
  return pourState();
}

export function onPourChange(
  fn: (pouring: boolean, changedAt: number) => void,
): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
