import { useEffect, useRef, useState } from "react";

// --- Types mirroring backend/src/latency.ts + the SSE `person` payload ---

type StageStats = {
  label: string;
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
};

type LatencySample = {
  capturedAt: number | null;
  inferredAt: number | null;
  sentAt: number | null;
  receivedAt: number;
  broadcastAt: number | null;
  personInFrame: boolean;
  transition: boolean;
};

type LatencyResponse = { samples: LatencySample[]; stats: StageStats[] };

type PersonEventTiming = {
  capturedAt: number | null;
  inferredAt: number | null;
  sentAt: number | null;
  receivedAt: number | null;
  broadcastAt: number | null;
};

type Transition = {
  inFrame: boolean;
  t: PersonEventTiming | null;
  /** Date.now() when this browser received the SSE event. */
  browserReceivedAt: number;
  /** browserReceivedAt corrected by the estimated clock offset (server clock). */
  browserReceivedAtCorrected: number;
};

const MAX_TRANSITIONS = 50;
const CLOCK_PROBES = 5;
const POLL_INTERVAL_MS = 2000;

/** NTP-style clock offset estimate: offset = serverNow - (t0 + rtt/2), min-rtt of a few probes. */
async function estimateClockOffset(
  probes = CLOCK_PROBES,
): Promise<{ offsetMs: number; rttMs: number } | null> {
  let best: { offsetMs: number; rttMs: number } | null = null;
  for (let i = 0; i < probes; i++) {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch("/api/time", { cache: "no-store" });
    } catch {
      continue;
    }
    const t1 = Date.now();
    if (!res.ok) continue;
    const { now: serverNow } = (await res.json()) as { now: number };
    const rttMs = t1 - t0;
    const offsetMs = serverNow - (t0 + rttMs / 2);
    if (!best || rttMs < best.rttMs) best = { offsetMs, rttMs };
  }
  return best;
}

const fmt = (ms: number | null): string => (ms === null ? "—" : `${ms.toFixed(0)} ms`);

/** b - a, or null if either side is missing. */
const delta = (a: number | null | undefined, b: number | null | undefined): number | null =>
  a == null || b == null ? null : b - a;

function StatsTable({ stats }: { stats: StageStats[] }) {
  return (
    <table className="w-full border-collapse text-left font-mono text-xs">
      <thead>
        <tr className="border-b border-neutral-500">
          <th className="py-1 pr-4">stage</th>
          <th className="py-1 pr-4">n</th>
          <th className="py-1 pr-4">p50</th>
          <th className="py-1 pr-4">p95</th>
          <th className="py-1 pr-4">max</th>
        </tr>
      </thead>
      <tbody>
        {stats.map((s) => (
          <tr key={s.label} className="border-b border-neutral-800">
            <td className="py-1 pr-4">{s.label}</td>
            <td className="py-1 pr-4">{s.count}</td>
            <td className="py-1 pr-4">{fmt(s.p50)}</td>
            <td className="py-1 pr-4">{fmt(s.p95)}</td>
            <td className="py-1 pr-4">{fmt(s.max)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Debug() {
  const [status, setStatus] = useState("connecting…");
  const [clock, setClock] = useState<{ offsetMs: number; rttMs: number } | null>(null);
  const [latency, setLatency] = useState<LatencyResponse | null>(null);
  const [transitions, setTransitions] = useState<Transition[]>([]);
  const clockRef = useRef(clock);
  useEffect(() => {
    clockRef.current = clock;
  }, [clock]);

  // Clock offset estimate, refreshed periodically -- Pi and browser drift, so
  // a one-shot estimate at page load would slowly go stale on a page left open.
  useEffect(() => {
    let cancelled = false;
    const probe = () => {
      estimateClockOffset().then((result) => {
        if (!cancelled && result) setClock(result);
      });
    };
    probe();
    const id = setInterval(probe, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // SSE stream, opened directly by this page (not shared with Flower.tsx).
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onopen = () => setStatus("open");
    es.onerror = () => setStatus("error / reconnecting…");

    es.addEventListener("person", (e: MessageEvent<string>) => {
      const browserReceivedAt = Date.now();
      const data = JSON.parse(e.data) as { inFrame: boolean; t?: PersonEventTiming };
      const offset = clockRef.current?.offsetMs ?? 0;
      setTransitions((prev) =>
        [
          ...prev,
          {
            inFrame: data.inFrame,
            t: data.t ?? null,
            browserReceivedAt,
            browserReceivedAtCorrected: browserReceivedAt - offset,
          },
        ].slice(-MAX_TRANSITIONS),
      );
    });

    return () => es.close();
  }, []);

  // Per-frame stage stats, polled -- these update every frame even without a
  // person transition, so SSE (transition-only) can't carry them.
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      fetch("/api/debug/latency")
        .then((r) => r.json())
        .then((data: LatencyResponse) => {
          if (!cancelled) setLatency(data);
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="min-h-screen bg-neutral-950 p-6 font-mono text-sm text-neutral-100">
      <h1 className="mb-1 text-lg font-bold">latency debug</h1>
      <p className="mb-4 text-neutral-400">
        SSE: {status} · clock offset:{" "}
        {clock ? `${clock.offsetMs.toFixed(0)} ms (browser ahead if positive)` : "estimating…"} ·
        RTT: {clock ? `${clock.rttMs.toFixed(0)} ms` : "—"}
      </p>

      <h2 className="mb-2 mt-6 font-bold">per-frame stage stats (last 300 samples)</h2>
      {latency ? <StatsTable stats={latency.stats} /> : <p>loading…</p>}

      <h2 className="mb-2 mt-8 font-bold">
        transitions ({transitions.length}/{MAX_TRANSITIONS})
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-neutral-500">
              <th className="py-1 pr-3">state</th>
              <th className="py-1 pr-3">capture→infer</th>
              <th className="py-1 pr-3">infer→sent</th>
              <th className="py-1 pr-3">sent→recv</th>
              <th className="py-1 pr-3">recv→broadcast</th>
              <th className="py-1 pr-3">broadcast→browser</th>
              <th className="py-1 pr-3">total (capture→browser)</th>
            </tr>
          </thead>
          <tbody>
            {[...transitions].reverse().map((tr, i) => {
              const t = tr.t;
              const captureToInfer = delta(t?.capturedAt, t?.inferredAt);
              const inferToSent = delta(t?.inferredAt, t?.sentAt);
              const sentToReceived = delta(t?.sentAt, t?.receivedAt);
              const receivedToBroadcast = delta(t?.receivedAt, t?.broadcastAt);
              const broadcastToBrowser = delta(t?.broadcastAt, tr.browserReceivedAtCorrected);
              const total = delta(t?.capturedAt, tr.browserReceivedAtCorrected);
              return (
                <tr key={i} className="border-b border-neutral-800">
                  <td className="py-1 pr-3">
                    <span
                      className="rounded px-1.5 py-0.5 font-bold"
                      style={{ background: tr.inFrame ? "#1a5" : "#a33" }}
                    >
                      {tr.inFrame ? "in frame" : "out"}
                    </span>
                  </td>
                  <td className="py-1 pr-3">{fmt(captureToInfer)}</td>
                  <td className="py-1 pr-3">{fmt(inferToSent)}</td>
                  <td className="py-1 pr-3">{fmt(sentToReceived)}</td>
                  <td className="py-1 pr-3">{fmt(receivedToBroadcast)}</td>
                  <td className="py-1 pr-3">{fmt(broadcastToBrowser)}</td>
                  <td className="py-1 pr-3 font-bold">{fmt(total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-6 max-w-2xl text-neutral-500">
        Python and the backend share a clock (same Pi), so capture/infer/sent/received/broadcast
        deltas need no correction. The browser is a separate device -- the "broadcast→browser" and
        "total" columns use browserReceivedAt corrected by the estimated clock offset above
        (NTP-style: probe /api/time a few times, take the min-RTT sample, offset = serverNow -
        (t0 + rtt/2)). If the offset estimate is off, those two columns are the ones to distrust.
      </p>
    </div>
  );
}
