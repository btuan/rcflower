import { useEffect, useState } from "react";

type Line = { event: string; data: string };

export function SseDemo() {
  const [status, setStatus] = useState("connecting…");
  const [lines, setLines] = useState<Line[]>([]);
  const [inFrame, setInFrame] = useState<boolean | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/events");

    const push = (event: string) => (e: MessageEvent<string>) =>
      setLines((prev) => [...prev, { event, data: e.data }].slice(-20));

    es.onopen = () => setStatus("open");
    es.onerror = () => setStatus("error / reconnecting…");

    // Named events need their own listener; only unnamed ones hit onmessage.
    es.addEventListener("person", (e: MessageEvent<string>) => {
      push("person")(e);
      setInFrame((JSON.parse(e.data) as { inFrame: boolean }).inFrame);
    });

    return () => es.close();
  }, []);

  return (
    <div className="p-6 font-mono text-sm">
      <h1 className="font-bold">SSE test — {status}</h1>
      <p
        className="my-4 p-4 font-bold"
        style={{ background: inFrame ? "#1a5" : "#a33", color: "white" }}
      >
        {inFrame === null ? "no data yet" : inFrame ? "PERSON IN FRAME" : "no person"}
      </p>
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
