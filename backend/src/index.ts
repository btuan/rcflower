import { config } from "./config.ts";
import { commit, startedAt } from "./buildinfo.ts";
import "./db.ts";
import {
  buildAuthorizeUrl,
  clearSessionCookieHeader,
  clearStateCookieHeader,
  exchangeCodeForToken,
  fetchRcProfile,
  getSession,
  parseCookies,
  randomState,
  sessionCookieHeader,
  stateCookieHeader,
  verifyState,
} from "./auth.ts";
import {
  getState,
  ingestDetectionState,
  isPersonInFrame,
  isSweeping,
  overrideRemainingMs,
  simulatePerson,
  simulateSweep,
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
    name,
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

/** POST /api/debug/simulate-sweep -- `{ seconds, direction: "ltr" | "rtl" }`: fake a person crossing the FOV. */
async function handleSimulateSweep(req: Request): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // defaults below
  }
  const seconds = num(body.seconds) ?? 4;
  if (seconds < 0.5 || seconds > 60) {
    return Response.json({ error: "seconds must be within 0.5..60" }, { status: 400 });
  }
  simulateSweep(seconds, body.direction === "rtl" ? "rtl" : "ltr");
  return Response.json({ sweeping: isSweeping() });
}

/** 401 JSON if the request has no valid RC session cookie; otherwise null (caller proceeds). */
const requireSession = (req: Request): Response | null =>
  getSession(req) ? null : Response.json({ error: "authentication required" }, { status: 401 });

/** GET /auth/rc/login -- stash a CSRF state cookie, then redirect to RC's OAuth authorize screen. */
function handleRcLogin(): Response {
  const state = randomState();
  return new Response(null, {
    status: 302,
    headers: { Location: buildAuthorizeUrl(state), "Set-Cookie": stateCookieHeader(state) },
  });
}

/** POST /auth/logout -- clear the session cookie. */
const handleLogout = (): Response =>
  new Response(null, { status: 204, headers: { "Set-Cookie": clearSessionCookieHeader() } });

/** GET /api/auth/me -- the current session, if any. */
function handleAuthMe(req: Request): Response {
  const session = getSession(req);
  return Response.json(
    session ? { authenticated: true, name: session.name } : { authenticated: false },
  );
}

/**
 * RC's OAuth `redirect_uri` is registered as this exact URL, so the callback
 * lands the browser back on `/debug` itself (mirroring phoneroom.recurse.com:
 * the same URL whether logging in or out) rather than a separate route. A
 * `code`/`state` query on `/debug` means this request IS that callback, not
 * a page load -- everything else falls through to the SPA as usual.
 */
async function handleDebugOAuthCallback(req: Request, url: URL): Promise<Response | null> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return null;

  if (!verifyState(req, state)) {
    return Response.json(
      { error: "invalid OAuth state" },
      { status: 400, headers: { "Set-Cookie": clearStateCookieHeader() } },
    );
  }

  const accessToken = await exchangeCodeForToken(code);
  const profile = accessToken ? await fetchRcProfile(accessToken) : null;
  if (!profile) {
    return Response.json(
      { error: "RC OAuth exchange failed" },
      { status: 502, headers: { "Set-Cookie": clearStateCookieHeader() } },
    );
  }

  const headers = new Headers({ Location: "/debug" });
  headers.append("Set-Cookie", clearStateCookieHeader());
  headers.append("Set-Cookie", sessionCookieHeader(profile));
  return new Response(null, { status: 302, headers });
}

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  // SSE connections are long-lived; don't let Bun time them out.
  idleTimeout: 0,

  async fetch(req, server) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/debug") {
      const callback = await handleDebugOAuthCallback(req, url);
      if (callback) return callback;
    }

    switch (pathname) {
      case "/api/health":
        return Response.json({ ok: true, dev: config.dev, commit, startedAt });
      case "/api/detections":
        return req.method === "POST" ? handleDetections(req) : Response.json(getState());
      case "/api/events":
        return handleEvents(req);
      case "/api/pour":
        return req.method === "POST" ? handlePour(req) : Response.json(pourState());
      case "/api/water":
        return req.method === "POST"
          ? handleWater(req, server)
          : Response.json(recentWatering());
      case "/auth/rc/login":
        return handleRcLogin();
      case "/auth/logout":
        return req.method === "POST"
          ? handleLogout()
          : new Response("Method Not Allowed", { status: 405 });
      case "/api/auth/me":
        return handleAuthMe(req);

      // debug-only: nothing but /debug depends on these (confirmed against
      // frontend call sites, see docs/design/video-and-annotation-pipeline.md).
      case "/api/time":
        return requireSession(req) ?? Response.json({ now: Date.now() });
      case "/api/detections/latest":
        return requireSession(req) ?? handleDetectionsLatest();
      case "/api/debug/latency":
        return requireSession(req) ?? Response.json({ samples: getSamples(), stats: getStats() });
      case "/api/debug/simulate-person":
        return (
          requireSession(req) ?? (req.method === "POST" ? handleSimulatePerson(req) : simulateStatus())
        );
      case "/api/debug/simulate-sweep":
        return (
          requireSession(req) ??
          (req.method === "POST" ? handleSimulateSweep(req) : Response.json({ sweeping: isSweeping() }))
        );
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
