import { useCallback, useEffect, useRef, useState } from "react";
import type { PermissionState } from "./orientation";

export type Motion = {
  /** Device acceleration with gravity removed, m/s^2, device axes. */
  x: number;
  y: number;
  z: number;
  /** Same but including gravity; null when the browser doesn't provide it. */
  gx: number | null;
  gy: number | null;
  gz: number | null;
  /** ms between samples as reported by the browser. */
  interval: number;
};

type DeviceMotionEventIOS = typeof DeviceMotionEvent & {
  requestPermission?: () => Promise<"granted" | "denied" | "default">;
};

export async function requestMotionPermission(): Promise<{
  state: PermissionState;
  error?: string;
}> {
  if (typeof DeviceMotionEvent === "undefined") {
    return {
      state: "unsupported",
      error: "DeviceMotionEvent is not available in this browser.",
    };
  }
  const DME = DeviceMotionEvent as DeviceMotionEventIOS;
  if (typeof DME.requestPermission !== "function") {
    return { state: "granted" };
  }
  try {
    const result = await DME.requestPermission();
    if (result === "granted") return { state: "granted" };
    return { state: "denied", error: `Motion permission ${result}.` };
  } catch (err) {
    return {
      state: "denied",
      error:
        err instanceof Error
          ? err.message
          : "Motion permission request failed (needs HTTPS + a user gesture).",
    };
  }
}

/**
 * Latest devicemotion sample, kept in a ref (no re-render per sample; read it
 * from an animation loop). `start()` must be called from a user gesture on iOS.
 */
export function useDeviceMotion() {
  const [permission, setPermission] = useState<PermissionState>("unknown");
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [sampleCount, setSampleCount] = useState(0);
  const latest = useRef<Motion | null>(null);

  const start = useCallback(async () => {
    setError(null);
    const { state, error: err } = await requestMotionPermission();
    setPermission(state);
    if (err) setError(err);
    if (state === "granted") setListening(true);
  }, []);

  const stop = useCallback(() => setListening(false), []);

  useEffect(() => {
    if (!listening) return;
    let n = 0;
    const handle = (e: DeviceMotionEvent) => {
      const a = e.acceleration;
      const g = e.accelerationIncludingGravity;
      latest.current = {
        x: a?.x ?? 0,
        y: a?.y ?? 0,
        z: a?.z ?? 0,
        gx: g?.x ?? null,
        gy: g?.y ?? null,
        gz: g?.z ?? null,
        interval: e.interval,
      };
      n += 1;
      if (n % 60 === 0) setSampleCount(n);
    };
    window.addEventListener("devicemotion", handle);
    return () => {
      window.removeEventListener("devicemotion", handle);
      latest.current = null;
    };
  }, [listening]);

  return { permission, error, listening, sampleCount, latest, start, stop };
}
