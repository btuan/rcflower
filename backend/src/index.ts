import { config } from "./config.ts";
import "./db.ts";
import { getState, watchDetections } from "./detections.ts";
import { handleEvents } from "./sse.ts";
import { recentWatering, recordWatering } from "./watering.ts";
import { proxyToVite, serveStatic } from "./http.ts";
import { startVite } from "./vite.ts";

const stopWatch = watchDetections();

if (config.dev) startVite();

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Client IP, preferring the reverse proxy's forwarded address. */
const clientIp = (req: Request, server: Bun.Server<undefined>): string | null => {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return server.requestIP(req)?.address ?? null;
};

/** POST /api/water -- log a watering event and broadcast it over SSE. */
async function handleWater(req: Request, server: Bun.Server<undefined>): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // empty / invalid body -- fall back to defaults
  }
  const event = recordWatering({
    trigger: typeof body.trigger === "string" ? body.trigger : "manual",
    durationMs: num(body.durationMs),
    volumeMl: num(body.volumeMl),
    notes: typeof body.notes === "string" ? body.notes : null,
    srcIp: clientIp(req, server),
  });
  return Response.json(event, { status: 201 });
}

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  // SSE connections are long-lived; don't let Bun time them out.
  idleTimeout: 0,

  async fetch(req, server) {
    const { pathname } = new URL(req.url);

    switch (pathname) {
      case "/api/health":
        return Response.json({ ok: true, dev: config.dev });
      case "/api/detections":
        return Response.json(getState());
      case "/api/events":
        return handleEvents(req);
      case "/api/water":
        return req.method === "POST"
          ? handleWater(req, server)
          : Response.json(recentWatering());
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
