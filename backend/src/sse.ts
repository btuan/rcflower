import { isPersonInFrame, onPersonChange } from "./detections.ts";
import { onWatering } from "./watering.ts";

const encoder = new TextEncoder();

/** GET /api/events -- Server-Sent Events stream of `person` in/out-of-frame. */
export function handleEvents(req: Request): Response {
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          cleanup();
        }
      };

      send("person", { inFrame: isPersonInFrame() });

      const off = onPersonChange((inFrame) => send("person", { inFrame }));
      const offWatering = onWatering((event) => send("watering", event));
      // Comment line keeps proxies / load balancers from dropping the idle socket.
      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 15_000);

      cleanup = () => {
        clearInterval(ping);
        off();
        offWatering();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      req.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
