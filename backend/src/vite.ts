import type { Subprocess } from "bun";
import { config } from "./config.ts";

/**
 * Spawn the Vite dev server as a child process. The Bun server proxies HTTP to
 * it; HMR_CLIENT_PORT tells Vite's client to open its HMR websocket straight to
 * Vite (Bun doesn't proxy websockets), so the browser only ever types the Bun
 * port for normal requests.
 */
export function startVite(): Subprocess {
  const proc = Bun.spawn(
    [
      "bunx",
      "vite",
      "--host",
      config.viteHost,
      "--port",
      String(config.vitePort),
      "--strictPort",
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
