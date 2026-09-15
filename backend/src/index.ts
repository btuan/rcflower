import { join } from "node:path";
import { config } from "./config.ts";
import { commit, startedAt } from "./buildinfo.ts";
import "./db.ts";
import {
  getState,
  ingestDetectionState,
  isPersonInFrame,
  overrideRemainingMs,
  simulatePerson,
} from "./detections.ts";
import { getSamples, getStats } from "./latency.ts";
import { pourState, setPouring } from "./pour.ts";
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

/** Parse a `Cookie:` header into a plain object; a missing header yields `{}`. */
const parseCookies = (header: string | null): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value); // Decodes percent-encoding like %20 to spaces
    } catch {
      out[key] = value; // malformed percent-encoding -- keep it raw
    }
  }
  return out;
};

/** Display name from the `user` cookie, or null if absent / not valid JSON. */
const cookieUserName = (req: Request): string | null => {
  const raw = parseCookies(req.headers.get("cookie"))["user"];
  if (!raw) return null;
  try {
    const user = JSON.parse(raw) as Record<string, unknown>;
    return typeof user.name === "string" ? user.name : null;
  } catch {
    return null;
  }
};

/** POST /api/water -- log a watering event and broadcast it over SSE. */
async function handleWater(req: Request, server: Bun.Server<undefined>): Promise<Response> {
  let body: Record<string, unknown> = {};

  // Best-effort: pull the waterer's name from a `user` cookie if present. Every
  // step here is optional -- a missing header, missing cookie, or malformed JSON
  // must not 500 the watering request. (TODO: record `name` on the event.)
  const name = cookieUserName(req);
  void name;

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
 * POST /api/pour -- the watering can reports whether it is tipped *right now*
 * (`{ pouring: boolean }`), so the flower can react while the pour is still
 * happening. The completed pour is logged separately via POST /api/water.
 */
async function handlePour(req: Request): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // handled by the type check below
  }
  if (typeof body.pouring !== "boolean") {
    return Response.json({ error: "expected { pouring: boolean }" }, { status: 400 });
  }
  return Response.json(setPouring(body.pouring));
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

/** GET /api/detections/latest -- current frame geometry + detections for the debug page. */
const handleDetectionsLatest = (): Response => {
  const state = getState();
  return Response.json({
    frameSize: state.frameSize ?? null,
    roi: state.roi ?? null,
    detections: state.detections,
    capturedAt: state.capturedAt ?? null,
  });
};

/** GET /api/debug/frame.jpg -- latest snapshot written by python/detect.py. */
async function handleDebugFrame(): Promise<Response> {
  const filePath = join(config.repoRoot, "state", "frame.jpg");
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(file, {
    headers: { "Cache-Control": "no-store" },
  });
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
        return Response.json({ ok: true, dev: config.dev, commit, startedAt });
      case "/api/time":
        return Response.json({ now: Date.now() });
      case "/api/detections":
        return req.method === "POST" ? handleDetections(req) : Response.json(getState());
      case "/api/detections/latest":
        return handleDetectionsLatest();
      case "/api/debug/frame.jpg":
        return handleDebugFrame();
      case "/api/events":
        return handleEvents(req);
      case "/api/pour":
        return req.method === "POST" ? handlePour(req) : Response.json(pourState());
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

const openHost = config.host === "0.0.0.0" ? "localhost" : config.host;
const url = `http://${openHost}:${server.port}`;
if (config.dev) {
  console.log(
    [
      "",
      `[backend] DEV  ->  open ${url}  (commit ${commit})`,
      `[backend]   /api/*  handled here (Bun)`,
      `[backend]   /*      proxied to Vite, an internal child process on 127.0.0.1:${config.vitePort}`,
      `[backend]           (compiles TSX/Tailwind + hot reload; never open that port directly)`,
      "",
    ].join("\n"),
  );
} else {
  console.log(
    `[backend] PROD  ->  ${url}  (serving ${config.frontendDist}; no Vite process; commit ${commit})`,
  );
}
