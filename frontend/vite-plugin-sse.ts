import type { Plugin } from "vite";
import type { ServerResponse } from "node:http";

// Dev-only SSE endpoint at /api/events. A single timer flips the mood and
// broadcasts it to every connected client.
export function ssePlugin(): Plugin {
  return {
    name: "dev-sse",
    configureServer(server) {
      // Runs once, when the dev server starts.
      const clients = new Set<ServerResponse>();
      let moodState: "happy" | "sad" = "happy";
      let id = 0;

      const broadcast = (event: string, data: unknown) => {
        id++;
        const frame = `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const res of clients) res.write(frame);
      };

      const moodTimer = setInterval(() => {
        moodState = moodState === "happy" ? "sad" : "happy";
        broadcast("mood", { mood: moodState });
      }, 2000);

      server.httpServer?.on("close", () => clearInterval(moodTimer));

      // Runs once per connection.
      server.middlewares.use("/api/events", (_req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        clients.add(res);
        // Send current state right away so a fresh tab isn't blank until the
        // next tick.
        res.write(`event: mood\ndata: ${JSON.stringify({ mood: moodState })}\n\n`);

        res.on("close", () => {
          clients.delete(res);
          res.end();
        });
      });
    },
  };
}
