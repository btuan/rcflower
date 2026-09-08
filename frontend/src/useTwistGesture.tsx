import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_TWIST_OPTIONS,
  initialTwistState,
  step,
  type TwistDirection,
  type TwistPhase,
  type TwistState,
} from "./twistMachine";

export type { TwistPhase, TwistDirection };

export type TwistHandlers = {
  onTwist?: () => void;
  onUntwist?: () => void;
  /** A pour was in progress and got cancelled (pose lost mid-pour). */
  onCancel?: () => void;
};

export type TwistOptions = {
  armRoll?: number;
  armFacing?: number;
  fireFacing?: number;
  fireRoll?: number;
  resetRoll?: number;
  maxMs?: number;
  smoothing?: number;
  direction?: TwistDirection;
};

export function useTwistGesture(
  active: boolean,
  handlers: TwistHandlers,
  options: TwistOptions = {},
) {
  const {
    armRoll = DEFAULT_TWIST_OPTIONS.armRoll,
    armFacing = DEFAULT_TWIST_OPTIONS.armFacing,
    fireFacing = DEFAULT_TWIST_OPTIONS.fireFacing,
    fireRoll = DEFAULT_TWIST_OPTIONS.fireRoll,
    resetRoll = DEFAULT_TWIST_OPTIONS.resetRoll,
    maxMs = DEFAULT_TWIST_OPTIONS.maxMs,
    smoothing = DEFAULT_TWIST_OPTIONS.smoothing,
    direction = DEFAULT_TWIST_OPTIONS.direction,
  } = options;

  const cb = useRef(handlers);
  cb.current = handlers;

  const [phase, setPhase] = useState<TwistPhase>("idle");
  const [progress, setProgress] = useState(0);

  const machine = useRef<TwistState>(initialTwistState);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;

    machine.current = initialTwistState;

    const opts = {
      armRoll,
      armFacing,
      fireFacing,
      fireRoll,
      resetRoll,
      maxMs,
      smoothing,
      direction,
    };

    const publish = () => {
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        setPhase(machine.current.phase);
        setProgress(machine.current.progress);
      });
    };

    const handle = (event: DeviceOrientationEvent) => {
      if (event.beta === null || event.gamma === null) return;

      const { state, events } = step(
        machine.current,
        { beta: event.beta, gamma: event.gamma, t: performance.now() },
        opts,
      );
      machine.current = state;
      publish();

      for (const e of events) {
        if (e === "twist") cb.current.onTwist?.();
        else if (e === "untwist") cb.current.onUntwist?.();
        else if (e === "cancel") cb.current.onCancel?.();
      }
    };

    window.addEventListener("deviceorientation", handle);
    return () => {
      window.removeEventListener("deviceorientation", handle);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      machine.current = initialTwistState;
      setPhase("idle");
      setProgress(0);
    };
  }, [
    active,
    armRoll,
    armFacing,
    fireFacing,
    fireRoll,
    resetRoll,
    maxMs,
    smoothing,
    direction,
  ]);

  return { phase, progress };
}
