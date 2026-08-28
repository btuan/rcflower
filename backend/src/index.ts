import { config } from "./config.ts";
import { getState, watchDetections } from "./detections.ts";
import { handleEvents } from "./sse.ts";
import { proxyToVite, serveStatic } from "./http.ts";
import { startVite } from "./vite.ts";

const stopWatch = watchDetections();

if (config.dev) startVite();

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  // SSE connections are long-lived; don't let Bun time them out.
  idleTimeout: 0,

  async fetch(req) {
    const { pathname } = new URL(req.url);

    switch (pathname) {
      case "/api/health":
        return Response.json({ ok: true, dev: config.dev });
      case "/api/detections":
        return Response.json(getState());
      case "/api/events":
        return handleEvents(req);
    }

    if (pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    return config.dev ? proxyToVite(req) : serveStatic(req);
  },
});

console.log(
  `[backend] ${config.dev ? "dev" : "prod"} on http://${config.host}:${server.port}` +
    (config.dev ? ` (proxying to vite :${config.vitePort})` : ""),
);

process.on("exit", stopWatch);
