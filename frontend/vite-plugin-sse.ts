import type { Plugin } from "vite";
import type { ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../state/detections.json",
);

type Detection = { label: string };
type DetectionState = { detections: Detection[] };

function personInFrame(): boolean {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    const state = JSON.parse(raw) as DetectionState;
    return state.detections.some((d) => d.label === "person");
  } catch {
    return false;
  }
}

// Dev-only SSE endpoint at /api/events. Polls state/detections.json
// (written by python/detect.py) and pushes a `person` event with
// { inFrame: boolean } whenever a person enters or leaves frame.
export function ssePlugin(): Plugin {
  return {
    name: "dev-sse",
    configureServer(server) {
      const clients = new Set<ServerResponse>();
      let inFrame = personInFrame();

      const broadcast = () => {
        const next = personInFrame();
        if (next === inFrame) return;
        inFrame = next;
        const payload = `event: person\ndata: ${JSON.stringify({ inFrame })}\n\n`;
        console.log("payload", payload, new Date().getTime());
        for (const res of clients) res.write(payload);
      };

      const pollTimer = setInterval(broadcast, 200);
      server.httpServer?.on("close", () => clearInterval(pollTimer));

      server.middlewares.use("/api/events", (_req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        clients.add(res);
        res.write(`event: person\ndata: ${JSON.stringify({ inFrame })}\n\n`);

        res.on("close", () => {
          clients.delete(res);
          res.end();
        });
      });
    },
  };
}
