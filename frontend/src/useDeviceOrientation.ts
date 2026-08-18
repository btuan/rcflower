import { useCallback, useEffect, useRef, useState } from "react";
import type { Orientation, PermissionState } from "./orientation";
import { requestOrientationPermission } from "./orientation";

export function useDeviceOrientation() {
  const [permission, setPermission] = useState<PermissionState>("unknown");
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [orientation, setOrientation] = useState<Orientation>({
    absolute: false,
    alpha: null,
    beta: null,
    gamma: null,
  });

  const latest = useRef<Orientation | null>(null);
  const frame = useRef<number | null>(null);

  const start = useCallback(async () => {
    setError(null);
    const { state, error: err } = await requestOrientationPermission();
    setPermission(state);
    if (err) setError(err);
    if (state === "granted") setListening(true);
  }, []);

  const stop = useCallback(() => setListening(false), []);

  useEffect(() => {
    if (!listening) return;

    const handle = (event: DeviceOrientationEvent) => {
      latest.current = {
        absolute: event.absolute,
        alpha: event.alpha,
        beta: event.beta,
        gamma: event.gamma,
      };
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        if (latest.current) setOrientation(latest.current);
      });
    };

    window.addEventListener("deviceorientation", handle);
    return () => {
      window.removeEventListener("deviceorientation", handle);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      latest.current = null;
    };
  }, [listening]);

  return { permission, error, listening, orientation, start, stop };
}
