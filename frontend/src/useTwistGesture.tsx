import { useEffect, useRef, useState } from "react";
import { DEG, shortestDelta, upInDevice } from "./orientation";

export type TwistPhase = "idle" | "armed" | "fired";

export type TwistHandlers = {
  onTwist?: () => void;
  onUntwist?: () => void;
  /** Armed but abandoned, or the pose was lost mid-gesture. */
  onCancel?: () => void;
};

export type TwistOptions = {
  armRoll?: number;
  armFacing?: number;
  fireRoll?: number;
  resetRoll?: number;
  maxMs?: number;
  smoothing?: number;
};

export function useTwistGesture(
  active: boolean,
  handlers: TwistHandlers,
  options: TwistOptions = {},
) {
  const {
    armRoll = 20,
    armFacing = 0.35,
    fireRoll = 60,
    resetRoll = 25,
    maxMs = 1500,
    smoothing = 0.2,
  } = options;

  const cb = useRef(handlers);
  cb.current = handlers;

  const [phase, setPhase] = useState<TwistPhase>("idle");
  const [progress, setProgress] = useState(0);

  const phaseRef = useRef<TwistPhase>("idle");
  const accum = useRef(0);
  const lastRoll = useRef<number | null>(null);
  const armedAt = useRef(0);
  const smooth = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;

    const setPhaseBoth = (next: TwistPhase) => {
      if (phaseRef.current === next) return;
      phaseRef.current = next;
      setPhase(next);
    };

    const publishProgress = () => {
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        const p = Math.max(0, Math.min(1, accum.current / fireRoll));
        setProgress(p);
      });
    };

    const handle = (event: DeviceOrientationEvent) => {
      if (event.beta === null || event.gamma === null) return;

      const u = upInDevice(event.beta, event.gamma);

      if (smooth.current === null) {
        smooth.current = { x: u.x, y: u.y };
      } else {
        smooth.current = {
          x: smooth.current.x + smoothing * (u.x - smooth.current.x),
          y: smooth.current.y + smoothing * (u.y - smooth.current.y),
        };
      }

      const roll = Math.atan2(smooth.current.x, smooth.current.y) / DEG;

      if (lastRoll.current === null) lastRoll.current = roll;
      const delta = shortestDelta(roll, lastRoll.current);
      lastRoll.current = roll;

      const facing = Math.abs(u.z) < armFacing;
      const now = performance.now();

      switch (phaseRef.current) {
        case "idle":
          if (facing && Math.abs(roll) < armRoll) {
            accum.current = 0;
            armedAt.current = now;
            setPhaseBoth("armed");
            publishProgress();
          }
          break;

        case "armed":
          accum.current += delta;
          publishProgress();
          if (
            !facing ||
            accum.current < -resetRoll ||
            now - armedAt.current > maxMs
          ) {
            accum.current = 0;
            setPhaseBoth("idle");
            cb.current.onCancel?.();
          } else if (accum.current > fireRoll) {
            setPhaseBoth("fired");
            cb.current.onTwist?.();
          }
          break;

        case "fired":
          accum.current += delta;
          publishProgress();
          if (!facing) {
            accum.current = 0;
            setPhaseBoth("idle");
            cb.current.onCancel?.();
          } else if (accum.current < resetRoll) {
            accum.current = 0;
            setPhaseBoth("idle");
            cb.current.onUntwist?.();
          }
          break;
      }
    };

    window.addEventListener("deviceorientation", handle);
    return () => {
      window.removeEventListener("deviceorientation", handle);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      lastRoll.current = null;
      smooth.current = null;
      accum.current = 0;
      phaseRef.current = "idle";
      setPhase("idle");
      setProgress(0);
    };
  }, [active, armRoll, armFacing, fireRoll, resetRoll, maxMs, smoothing]);

  return { phase, progress };
}
