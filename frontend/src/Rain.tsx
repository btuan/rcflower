import { forwardRef, useImperativeHandle, useRef } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

// Size of the droplet pool. These nodes are created once and recycled every
// pass, so this is the ceiling on how much rain is ever in the air at once.
export const RAIN_DROPS = 40;
// How long one pass through the pool takes. While a pour is live the timeline
// restarts back to back, so this doubles as the rain's loop length.
export const RAIN_CYCLE_S = 1.4;
export const SPLASH_S = 0.34;

export type RainHandle = {
  /** Run a single pass of rain, unless one is already falling. */
  start(): void;
  /**
   * `true` starts rain and keeps it looping until called with `false`.
   * `false` lets the current pass finish without restarting.
   */
  setRaining(on: boolean): void;
};

/**
 * Fixed-position rain overlay: a pool of droplets driven by a paused gsap
 * timeline. Shared between the 2D `Flower` page and the 3D `FlowerLive`
 * page -- mount it once per page and drive it via the imperative handle.
 */
export const Rain = forwardRef<RainHandle>(function Rain(_props, ref) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rainTlRef = useRef<gsap.core.Timeline | null>(null);
  // Whether the can is tipped *right now*. A ref, not state, because the
  // timeline's onComplete reads it every pass and must not close over a stale
  // value -- and because rain is pure animation, nothing here needs a render.
  const rainingRef = useRef(false);

  useImperativeHandle(
    ref,
    () => ({
      start() {
        const tl = rainTlRef.current;
        // Null when the timeline was never built (reduced motion).
        if (!tl || tl.isActive()) return;
        tl.invalidate().restart();
      },
      setRaining(on: boolean) {
        rainingRef.current = on;
        if (on) {
          const tl = rainTlRef.current;
          if (!tl || tl.isActive()) return;
          tl.invalidate().restart();
        }
      },
    }),
    [],
  );

  useGSAP(
    () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

      const drops = gsap.utils.toArray<HTMLElement>(
        rootRef.current?.querySelectorAll(".rain-drop") ?? [],
      );

      const tl = gsap.timeline({
        paused: true,
        onComplete: () => {
          // Keep going for as long as the can is tipped. invalidate() throws
          // away the recorded start/end values so the random functions below
          // run again and the next pass lands somewhere new.
          if (rainingRef.current) tl.invalidate().restart();
        },
      });

      drops.forEach((drop, i) => {
        const body = drop.querySelector(".rain-drop-body");
        const splash = drop.querySelector(".rain-drop-splash");
        if (!body || !splash) return;

        // Fall time is fixed per drop so the splash can be scheduled against
        // it; *where* the drop falls is re-randomised on every pass.
        const fall = gsap.utils.random(0.62, 1.05);
        const at = (i / RAIN_DROPS) * RAIN_CYCLE_S + gsap.utils.random(0, 0.08);

        tl.fromTo(
          drop,
          {
            opacity: 1,
            x: () => gsap.utils.random(0, window.innerWidth),
            y: () => window.innerHeight * -0.15,
          },
          {
            // Landing depth varies so the rain reads as a volume rather than
            // a flat curtain hitting one line.
            y: () => window.innerHeight * gsap.utils.random(0.55, 0.95),
            duration: fall,
            ease: "power1.in", // gravity: slow start, quick finish
          },
          at,
        )
          // Hand off from falling drop to splash ring at the landing point.
          .set(body, { opacity: 0 }, at + fall)
          .fromTo(
            splash,
            { opacity: 0.9, scaleX: 0.25, scaleY: 0.6 },
            {
              opacity: 0,
              scaleX: 1.5,
              scaleY: 1,
              duration: SPLASH_S,
              ease: "power2.out",
            },
            at + fall,
          )
          // Park the drop invisibly, ready to be reused next pass.
          .set(drop, { opacity: 0 }, at + fall + SPLASH_S)
          .set(body, { opacity: 1 }, at + fall + SPLASH_S);
      });

      rainTlRef.current = tl;
    },
    { scope: rootRef, dependencies: [] },
  );

  return (
    <div ref={rootRef}>
      <style>
        {`
          .rain {
            position: fixed;
            inset: 0;
            overflow: hidden;
            pointer-events: none;
            /* Above the three.js canvas / flower art, below any debug overlay. */
            z-index: 5;
          }

          .rain-drop {
            position: absolute;
            top: 0;
            left: 0;
            opacity: 0;
            will-change: transform;
          }

          .rain-drop-body {
            display: block;
            width: 4px;
            height: 20px;
            border-radius: 50% 50% 50% 50% / 62% 62% 38% 38%;
            background: linear-gradient(
              rgba(130, 180, 235, 0.15),
              rgba(86, 142, 214, 0.9)
            );
          }

          .rain-drop-splash {
            position: absolute;
            /* Centred on the 4px body, sitting just under its tip. */
            left: -10px;
            top: 15px;
            display: block;
            width: 24px;
            height: 7px;
            border: 1.5px solid rgba(86, 142, 214, 0.75);
            border-top-color: transparent;
            border-radius: 999px;
            opacity: 0;
          }

          @media (prefers-reduced-motion: reduce) {
            .rain {
              display: none;
            }
          }
        `}
      </style>

      {/* A fixed pool of droplets parked off-screen for GSAP to recycle. */}
      <div className="rain" aria-hidden="true">
        {Array.from({ length: RAIN_DROPS }, (_, i) => (
          <span key={i} className="rain-drop">
            <i className="rain-drop-body" />
            <i className="rain-drop-splash" />
          </span>
        ))}
      </div>
    </div>
  );
});
