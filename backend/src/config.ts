import { resolve } from "node:path";

// backend/src -> repo root
const repoRoot = resolve(import.meta.dir, "../..");

const fromRoot = (p: string) => resolve(repoRoot, p);

export const config = {
  repoRoot,
  dev: Bun.env.DEV === "1" || Bun.env.NODE_ENV === "development",
  port: Number(Bun.env.PORT ?? 3000),
  host: Bun.env.HOST ?? "0.0.0.0",
  dbPath: fromRoot(Bun.env.DB_PATH ?? "state/rcflower.db"),
  frontendDir: fromRoot("frontend"),
  frontendDist: fromRoot(Bun.env.FRONTEND_DIST ?? "frontend/dist"),
  viteHost: Bun.env.VITE_HOST ?? "127.0.0.1",
  vitePort: Number(Bun.env.VITE_PORT ?? 5173),

  // RC OAuth2 (see docs/design/video-and-annotation-pipeline.md) -- secrets,
  // always per-machine in .env.local, never committed to .env.
  rcOAuthClientId: Bun.env.RC_OAUTH_CLIENT_ID ?? "",
  rcOAuthClientSecret: Bun.env.RC_OAUTH_CLIENT_SECRET ?? "",
  rcOAuthRedirectUri: Bun.env.RC_OAUTH_REDIRECT_URI ?? "",
  sessionSecret: Bun.env.SESSION_SECRET ?? "",
};
