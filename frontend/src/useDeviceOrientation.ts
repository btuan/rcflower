import { useCallback, useEffect, useRef, useState } from "react";
import type { Orientation, PermissionState } from "./orientation";
import { requestOrientationPermission } from "./orientation";

// Remembers that this browser has granted motion access before. The grant
// itself lives with the browser -- this is only a hint that a silent retry is
// worth attempting, so losing it (private mode, cleared storage) costs nothing
// beyond one more tap.
const GRANTED_KEY = "rcflower:motion-granted";

function wasGranted(): boolean {
  try {
    return localStorage.getItem(GRANTED_KEY) === "1";
  } catch {
    return false; // storage disabled
  }
}

function rememberGranted(granted: boolean): void {
  try {
    if (granted) localStorage.setItem(GRANTED_KEY, "1");
    else localStorage.removeItem(GRANTED_KEY);
  } catch {
    // storage disabled -- we just ask again next time
  }
}

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

  // True only while the silent retry below is in flight, so the page can hold
  // off on prompting rather than flashing a dialog it's about to dismiss.
  const [resuming, setResuming] = useState(wasGranted);

  const start = useCallback(async () => {
    setError(null);
    const { state, error: err } = await requestOrientationPermission();
    setPermission(state);
    rememberGranted(state === "granted");
    if (err) setError(err);
    if (state === "granted") setListening(true);
  }, []);

  // Granted here before? Try again without waiting to be asked. iOS requires a
  // user gesture for requestPermission and will reject this, which is fine --
  // we fall through to prompting exactly as before. Browsers that don't gate
  // motion at all (Android, desktop) resolve it immediately and never prompt
  // again. Deliberately only runs once the user has granted at least once, so
  // the first visit still goes through the button, whose gesture is also what
  // requestLock() needs for fullscreen and the native orientation lock.
  useEffect(() => {
    if (!wasGranted()) return;
    let cancelled = false;
    void (async () => {
      const { state } = await requestOrientationPermission();
      if (cancelled) return;
      if (state === "granted") {
        setPermission("granted");
        setListening(true);
      } else {
        // Revoked, or this browser needs the gesture. Drop the hint so we
        // don't keep retrying, and let the prompt do its job. No error is
        // surfaced: an unasked-for attempt failing isn't the user's problem.
        rememberGranted(false);
      }
      setResuming(false);
    })();
    return () => {
      cancelled = true;
    };
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

  return { permission, error, listening, orientation, resuming, start, stop };
}
