import type { Subprocess } from "bun";
import { config } from "./config.ts";

/**
 * DEV ONLY. Spawn Vite as an internal child process that compiles the
 * frontend (TSX, Tailwind, React Compiler) and serves hot-module reloads.
 *
 * Vite is NOT the app server and you should never open its port directly:
 *   - it binds to 127.0.0.1 only (VITE_HOST), so it isn't reachable from
 *     other machines anyway;
 *   - it runs with --logLevel warn so it prints no "Local: http://..." banner
 *     of its own -- the only URL printed at startup is the Bun one;
 *   - the Bun server (PORT, default 3000) proxies every non-/api request to
 *     it, so the browser only ever talks to Bun.
 *
 * The one exception is the HMR websocket: Bun doesn't proxy websockets, so
 * HMR_CLIENT_PORT tells Vite's browser client to open that socket straight
 * to Vite's port. That's transparent to the developer.
 *
 * In production there is no Vite process at all: `bun run build:frontend`
 * runs `vite build` once and Bun serves the static output (see http.ts).
 */
export function startVite(): Subprocess {
  const proc = Bun.spawn(
    [
      "bunx",
      // Without this, bunx honors vite's `#!/usr/bin/env node` shebang and
      // shells out to whatever `node` is first on PATH -- which may be an
      // old/stray install incompatible with Vite/rolldown. --bun forces it
      // to run under Bun's own runtime instead.
      "--bun",
      "vite",
      "--host",
      config.viteHost,
      "--port",
      String(config.vitePort),
      "--strictPort",
      "--clearScreen",
      "false",
      // Suppress Vite's startup banner + per-request chatter; warnings and
      // errors (the only Vite output a developer needs) still come through.
      "--logLevel",
      "warn",
    ],
    {
      cwd: config.frontendDir,
      stdio: ["inherit", "inherit", "inherit"],
      env: {
        ...process.env,
        HMR_CLIENT_PORT: String(config.vitePort),
      },
    },
  );

  const kill = () => {
    try {
      proc.kill();
    } catch {
      // already gone
    }
  };
  process.on("exit", kill);
  process.on("SIGINT", () => {
    kill();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    kill();
    process.exit(0);
  });

  return proc;
}
