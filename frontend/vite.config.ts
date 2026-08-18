import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { ssePlugin } from "./vite-plugin-sse.ts";
import mkcert from "vite-plugin-mkcert";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    mkcert(),
    tailwindcss(),
    ssePlugin(),
  ],
  server: {
    host: true, // bind 0.0.0.0 so the phone can reach it
  },
});
