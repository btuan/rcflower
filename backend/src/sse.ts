import { isPersonInFrame, onPersonChange } from "./detections.ts";
import { getMood, onMoodChange } from "./mood.ts";
import { onPourChange, pourState } from "./pour.ts";
import { onWatering, recentWatering } from "./watering.ts";

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
      send("mood", { mood: getMood() });
      send("pour", pourState());
      // Seed the newest watering so a page that just loaded can show who
      // watered last, instead of waiting for the next one to happen. Flagged
      // as a replay: it's history, possibly hours old, so the flower shows the
      // credit line for it but must not celebrate it as a fresh watering.
      const last = recentWatering(1)[0];
      if (last) send("watering", { ...last, replay: true });

      const offMood = onMoodChange((mood) => send("mood", { mood }));
      const off = onPersonChange((inFrame, timing) =>
        send("person", {
          inFrame,
          t: {
            capturedAt: timing.capturedAt,
            inferStartedAt: timing.inferStartedAt,
            inferredAt: timing.inferredAt,
            sentAt: timing.sentAt,
            receivedAt: timing.receivedAt,
            broadcastAt: timing.broadcastAt,
          },
        }),
      );
      const offPour = onPourChange((pouring, changedAt) =>
        send("pour", { pouring, changedAt }),
      );
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
        offMood();
        offPour();
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
