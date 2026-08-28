import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, "");
  const allowedHosts = (env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);

  // Set by the backend when it runs Vite behind its reverse proxy: the HMR
  // websocket connects straight to Vite (Bun doesn't proxy websockets).
  const hmrClientPort = process.env.HMR_CLIENT_PORT
    ? Number(process.env.HMR_CLIENT_PORT)
    : undefined;

  return {
    plugins: [
      react(),
      babel({ presets: [reactCompilerPreset()] }),
      tailwindcss(),
    ],
    server: {
      allowedHosts,
      host: "0.0.0.0",
      port: 5173,
      hmr: hmrClientPort ? { clientPort: hmrClientPort } : undefined,
      fs: {
        allow: [path.resolve(import.meta.dirname, "..")],
      },
    },
  };
});
