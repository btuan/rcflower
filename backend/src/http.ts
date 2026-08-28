import { join, normalize } from "node:path";
import { config } from "./config.ts";

/** Production: serve the built frontend from frontendDist with SPA fallback. */
export async function serveStatic(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith("/")) pathname += "index.html";

  const filePath = normalize(join(config.frontendDist, pathname));
  if (
    filePath !== config.frontendDist &&
    !filePath.startsWith(config.frontendDist + "/")
  ) {
    return new Response("Forbidden", { status: 403 });
  }

  const file = Bun.file(filePath);
  if (await file.exists()) return new Response(file);

  const index = Bun.file(join(config.frontendDist, "index.html"));
  if (await index.exists()) {
    return new Response(index, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return new Response(
    "frontend/dist not found -- run `bun run build:frontend`",
    { status: 404 },
  );
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Dev: reverse-proxy everything that isn't an /api route to the Vite server. */
export async function proxyToVite(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const target = `http://${config.viteHost}:${config.vitePort}${url.pathname}${url.search}`;

  const headers = new Headers(req.headers);
  headers.set("host", `${config.viteHost}:${config.vitePort}`);

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.body,
      redirect: "manual",
    });

    const outHeaders = new Headers(upstream.headers);
    for (const h of HOP_BY_HOP) outHeaders.delete(h);

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });
  } catch {
    return new Response(
      `Vite dev server not reachable at ${config.viteHost}:${config.vitePort}`,
      { status: 502 },
    );
  }
}
