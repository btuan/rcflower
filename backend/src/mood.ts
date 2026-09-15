import { onWatering, recentWatering } from "./watering.ts";

export type Mood = "happy" | "neutral" | "sad" | "dead";

// Health is derived from how long ago the flower was last watered (ms).
// `watered_at` and Date.now() are both ms epoch, so ages are a plain subtraction.
//
//   age < HAPPY_MS            -> happy    (freshly watered, thriving)
//   HAPPY_MS <= age < NEUTRAL_MS -> neutral (watered recently, doing fine)
//   NEUTRAL_MS <= age < DEAD_MS  -> sad     (getting thirsty)
//   age >= DEAD_MS            -> dead     (neglected; only watering revives it)
//
// Presence (person in frame) is intentionally NOT part of this -- it drives the
// bounce animation on the frontend, not which mood is shown.
const HAPPY_MS = 20_000;
const NEUTRAL_MS = 50_000;
const DEAD_MS = 60_000;

// ms epoch of the most recent watering, or null if we've never seen one.
// Seeded from the DB so a restart doesn't reset a thriving flower to "dead".
let lastWateredAt: number | null = recentWatering(1)[0]?.wateredAt ?? null;

/** Pure mapping from watering recency to mood. Exposed for testing. */
export function computeMood(now = Date.now()): Mood {
  // Never watered reads as an infinite age -> dead. `?? -Infinity` makes the
  // comparisons below fall straight through to the dead branch.
  const age = now - (lastWateredAt ?? -Infinity);
  if (age >= DEAD_MS) return "dead";
  if (age < HAPPY_MS) return "happy";
  if (age < NEUTRAL_MS) return "neutral";
  return "sad";
}

const listeners = new Set<(m: Mood) => void>();
let currentMood: Mood = computeMood();

/** Recompute and, if the mood changed, notify subscribers. */
function evaluate(): void {
  const next = computeMood();
  if (next === currentMood) return;
  currentMood = next;
  console.log(`[${new Date().toISOString()}] [mood] -> ${next}`);
  for (const fn of listeners) fn(next);
}

// Decay (neutral -> sad -> dead) happens purely with the passage of time, so we
// have to re-check on a timer -- no watering / detection event will fire while a
// flower is simply being ignored. 1s is plenty fine-grained for 50s/60s edges.
setInterval(evaluate, 1000);

// A watering event resets the clock; recompute immediately so the dead -> happy
// revival is instant rather than waiting up to a second for the next tick.
onWatering((event) => {
  lastWateredAt = event.wateredAt;
  evaluate();
});

export const getMood = (): Mood => currentMood;

/** ms epoch of the most recent watering, or null if never watered. */
export const getWateredAt = (): number | null => lastWateredAt;

/** 1 = just watered, 0 = dead; linear decay over DEAD_MS. Never watered -> 0. */
export function getHealth(now = Date.now()): number {
  if (lastWateredAt === null) return 0;
  const age = now - lastWateredAt;
  return Math.min(1, Math.max(0, 1 - age / DEAD_MS));
}

export function onMoodChange(fn: (m: Mood) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
