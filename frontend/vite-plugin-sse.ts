import type { Plugin } from "vite";

// Dev-only SSE endpoint at /api/events. Pushes a `tick` event every 2s so the
// client has something to receive.
export function ssePlugin(): Plugin {
  let moodState: "happy" | "sad" = "happy";

  return {
    name: "dev-sse",
    configureServer(server) {
      server.middlewares.use("/api/events", (_req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        let id = 0;
        const send = (event: string, data: unknown) => {
          res.write(`id: ${++id}\n`);
          res.write(`event: ${event}\n`);
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        send("hello", { message: "connected" });
        const timer = setInterval(
          () => send("tick", { at: new Date().toISOString(), n: id }),
          2000,
        );

        const moodTimer = setInterval(() => {
          const newMood = moodState === "happy" ? "sad" : "happy";
          moodState = newMood;
          send("mood", { mood: newMood, n: id });
          moodState = newMood;
        }, 3000);

        res.on("close", () => {
          clearInterval(timer);
          clearInterval(moodTimer);
          res.end();
        });
      });
    },
  };
}
