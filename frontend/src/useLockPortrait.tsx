import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

export type LockPortraitStatus = {
  /** True if screen.orientation.lock("portrait") succeeded natively. */
  locked: boolean;
  /** True while the CSS counter-rotation fallback is actively rotating. */
  fallbackActive: boolean;
  orientationType: string | null;
  orientationAngle: number | null;
  error: string | null;
};

const ROOT_ID = "lock-portrait-root";

function getAngle(): number {
  const so = screen.orientation as ScreenOrientation | undefined;
  if (so && typeof so.angle === "number") return so.angle;
  // Older Safari / some browsers only expose window.orientation.
  const legacy = (window as Window & { orientation?: number }).orientation;
  if (typeof legacy === "number") return legacy;
  return 0;
}

function getType(): string | null {
  const so = screen.orientation as ScreenOrientation | undefined;
  return so?.type ?? null;
}

/**
 * Best-effort portrait lock for the watering-can page.
 *
 * Turning the phone to twist it naturally triggers the browser's normal
 * screen-rotation behavior, which is exactly what we don't want here (the
 * page, and the watering-can image, shouldn't spin as part of the
 * gesture). Two layers, both requiring a user gesture to invoke:
 *
 * 1. Native lock: `screen.orientation.lock("portrait")`. On Android/Chrome
 *    this only works in fullscreen, so we request fullscreen first. iOS
 *    Safari doesn't implement `lock()` at all (it throws / is undefined),
 *    so this layer silently no-ops there.
 * 2. CSS counter-rotation fallback: listen for orientation changes
 *    (`screen.orientation` "change", falling back to `orientationchange`
 *    / polling `window.orientation`) and rotate our root element by
 *    `-angle` degrees, swapping width/height so it fills the now-rotated
 *    viewport. This keeps the content visually pinned to portrait even
 *    though the OS/browser did rotate the layout viewport underneath it.
 *
 * Note: device-orientation math (beta/gamma in useTwistGesture /
 * orientation.ts) is unaffected by any of this — beta/gamma/alpha are
 * always reported in the DEVICE's own frame, not the screen/CSS frame,
 * so the gesture logic needs no changes regardless of screen rotation
 * or which of these layers is active.
 */
export function useLockPortrait(rootRef: RefObject<HTMLElement | null>) {
  const [status, setStatus] = useState<LockPortraitStatus>({
    locked: false,
    fallbackActive: false,
    orientationType: getType(),
    orientationAngle: getAngle(),
    error: null,
  });

  const attempted = useRef(false);

  const applyFallback = useCallback(() => {
    const el = rootRef.current;
    const angle = getAngle();
    const type = getType();

    setStatus((s) => ({ ...s, orientationType: type, orientationAngle: angle }));

    if (!el) return;

    if (!angle || status.locked) {
      // Nothing to counter-rotate (already portrait, or native lock has
      // it covered).
      el.style.transform = "";
      el.style.width = "";
      el.style.height = "";
      el.style.position = "";
      el.style.top = "";
      el.style.left = "";
      setStatus((s) => (s.fallbackActive ? { ...s, fallbackActive: false } : s));
      return;
    }

    const rotated = angle === 90 || angle === 270 || angle === -90;
    el.style.position = "fixed";
    el.style.top = "50%";
    el.style.left = "50%";
    el.style.width = rotated ? "100vh" : "100vw";
    el.style.height = rotated ? "100vw" : "100vh";
    el.style.transformOrigin = "center center";
    el.style.transform = `translate(-50%, -50%) rotate(${-angle}deg)`;
    setStatus((s) => (s.fallbackActive ? s : { ...s, fallbackActive: true }));
  }, [rootRef, status.locked]);

  useEffect(() => {
    const so = screen.orientation as ScreenOrientation | undefined;
    if (so && typeof so.addEventListener === "function") {
      so.addEventListener("change", applyFallback);
      return () => so.removeEventListener("change", applyFallback);
    }
    // Fallback event for browsers without the Screen Orientation API.
    window.addEventListener("orientationchange", applyFallback);
    return () => window.removeEventListener("orientationchange", applyFallback);
  }, [applyFallback]);

  /** Call from a user-gesture handler (e.g. the "Enable motion" button). */
  const requestLock = useCallback(async () => {
    if (attempted.current) return;
    attempted.current = true;

    let locked = false;
    let error: string | null = null;

    try {
      const el = document.documentElement;
      if (el.requestFullscreen && !document.fullscreenElement) {
        await el.requestFullscreen().catch(() => {
          // Fullscreen can be refused (e.g. iOS Safari); that's fine,
          // we just fall through to the CSS fallback below.
        });
      }

      const so = screen.orientation as
        | (ScreenOrientation & { lock?: (o: string) => Promise<void> })
        | undefined;
      if (so && typeof so.lock === "function") {
        await so.lock("portrait");
        locked = true;
      }
    } catch (err) {
      // Expected on iOS Safari (unsupported) and anywhere lock is denied
      // outside fullscreen/user-gesture. Never throw — just fall back.
      error = err instanceof Error ? err.message : String(err);
    }

    setStatus((s) => ({ ...s, locked, error }));
    applyFallback();
  }, [applyFallback]);

  return { status, requestLock, rootId: ROOT_ID };
}
