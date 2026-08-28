import { resolve } from "node:path";

// backend/src -> repo root
const repoRoot = resolve(import.meta.dir, "../..");

const fromRoot = (p: string) => resolve(repoRoot, p);

export const config = {
  repoRoot,
  dev: Bun.env.DEV === "1" || Bun.env.NODE_ENV === "development",
  port: Number(Bun.env.PORT ?? 3000),
  host: Bun.env.HOST ?? "0.0.0.0",
  statePath: fromRoot(Bun.env.STATE_PATH ?? "state/detections.json"),
  frontendDir: fromRoot("frontend"),
  frontendDist: fromRoot(Bun.env.FRONTEND_DIST ?? "frontend/dist"),
  viteHost: Bun.env.VITE_HOST ?? "127.0.0.1",
  vitePort: Number(Bun.env.VITE_PORT ?? 5173),
  pollIntervalMs: Number(Bun.env.POLL_INTERVAL_MS ?? 200),
};
