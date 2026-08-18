import { useEffect, useState } from "react";

type Line = { event: string; data: string };

export function SseDemo() {
  const [status, setStatus] = useState("connecting…");
  const [lines, setLines] = useState<Line[]>([]);

  useEffect(() => {
    const es = new EventSource("/api/events");

    const push = (event: string) => (e: MessageEvent<string>) =>
      setLines((prev) => [...prev, { event, data: e.data }].slice(-20));

    es.onopen = () => setStatus("open");
    es.onerror = () => setStatus("error / reconnecting…");

    // Named events need their own listener; only unnamed ones hit onmessage.
    es.addEventListener("hello", push("hello"));
    es.addEventListener("tick", push("tick"));
    es.onmessage = push("message");

    return () => es.close();
  }, []);

  return (
    <div className="p-6 font-mono text-sm">
      <h1 className="font-bold">SSE test — {status}</h1>
      <ul>
        {lines.map((l, i) => (
          <li key={i}>
            <strong>{l.event}</strong>: {l.data}
          </li>
        ))}
      </ul>
    </div>
  );
}
