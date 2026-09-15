import { isPersonInFrame, onPersonChange, onTrack } from "./detections.ts";
import { getHealth, getMood, getWateredAt, onMoodChange } from "./mood.ts";
import { onPourChange, pourState } from "./pour.ts";
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

      const sendMood = () => send("mood", { mood: getMood(), health: getHealth(), wateredAt: getWateredAt() });

      send("person", { inFrame: isPersonInFrame() });
      sendMood();
      send("pour", pourState());

      const offMood = onMoodChange(() => sendMood());
      // Health decays continuously even without a mood flip; re-send periodically.
      const healthTimer = setInterval(sendMood, 5_000);
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
      const offTrack = onTrack((event) => send("track", event));
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
        clearInterval(healthTimer);
        off();
        offMood();
        offPour();
        offWatering();
        offTrack();
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
