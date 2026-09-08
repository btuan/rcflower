import { config } from "./config.ts";
import "./db.ts";
import {
  getState,
  ingestDetectionState,
  isPersonInFrame,
  overrideRemainingMs,
  simulatePerson,
} from "./detections.ts";
import { getSamples, getStats } from "./latency.ts";
import { handleEvents } from "./sse.ts";
import { recentWatering, recordWatering } from "./watering.ts";
import { proxyToVite, serveStatic } from "./http.ts";
import { startVite } from "./vite.ts";

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

  const rawCookieHeader = req.headers.get("cookie");
  const cookies = rawCookieHeader.split(";").reduce((acc, cookie) => {
    const [key, value] = cookie.trim().split("=");
    acc[key] = decodeURIComponent(value); // Decodes percent-encoding like %20 to spaces
    return acc;
  }, {});
  const name = JSON.parse(cookies["user"]).name; // TODO: use this when record watering

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

/**
 * POST /api/detections -- ingest a detection state update from the Python
 * vision service (or a manual `curl` for testing). Body:
 * `{ timestamp: number, detections: { label, confidence?, box? }[] }`.
 */
async function handleDetections(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const state = ingestDetectionState(body);
  if (!state) {
    return Response.json(
      {
        error:
          "expected { timestamp: number, detections: { label: string, confidence?: number, box?: number[] }[] }",
      },
      { status: 400 },
    );
  }
  return Response.json({ ok: true, personInFrame: isPersonInFrame() }, { status: 202 });
}

const simulateStatus = () =>
  Response.json({ personInFrame: isPersonInFrame(), overrideRemainingMs: overrideRemainingMs() });

/**
 * POST /api/debug/simulate-person -- force person_in_frame=true for
 * `{ seconds }` (0 clears), so the UI can be exercised without a live person.
 */
async function handleSimulatePerson(req: Request): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // default below
  }
  const seconds = num(body.seconds) ?? 10;
  if (seconds < 0 || seconds > 3600) {
    return Response.json({ error: "seconds must be within 0..3600" }, { status: 400 });
  }
  simulatePerson(seconds);
  return simulateStatus();
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
      case "/api/time":
        return Response.json({ now: Date.now() });
      case "/api/detections":
        return req.method === "POST" ? handleDetections(req) : Response.json(getState());
      case "/api/events":
        return handleEvents(req);
      case "/api/water":
        return req.method === "POST"
          ? handleWater(req, server)
          : Response.json(recentWatering());
      case "/api/debug/latency":
        return Response.json({ samples: getSamples(), stats: getStats() });
      case "/api/debug/simulate-person":
        return req.method === "POST" ? handleSimulatePerson(req) : simulateStatus();
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
