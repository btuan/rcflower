import { useEffect, useMemo, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { DEG, rollAngle, tiltFromFlat, upInDevice } from "./orientation";
import { useDeviceOrientation } from "./useDeviceOrientation";
import { useLockPortrait } from "./useLockPortrait";
import { useTwistGesture } from "./useTwistGesture";
import type { TwistHandlers } from "./useTwistGesture";
import wateringCanUpright256 from "./assets/WateringCan/WateringCanUpright-256.webp";
import wateringCanUpright512 from "./assets/WateringCan/WateringCanUpright-512.webp";
import wateringCanUpright1024 from "./assets/WateringCan/WateringCanUpright-1024.webp";
import wateringCanUpright2048 from "./assets/WateringCan/WateringCanUpright-2048.webp";
import wateringCanPour1256 from "./assets/WateringCan/WateringCanPour1-256.webp";
import wateringCanPour1512 from "./assets/WateringCan/WateringCanPour1-512.webp";
import wateringCanPour11024 from "./assets/WateringCan/WateringCanPour1-1024.webp";
import wateringCanPour12048 from "./assets/WateringCan/WateringCanPour1-2048.webp";
import wateringCanPour2256 from "./assets/WateringCan/WateringCanPour2-256.webp";
import wateringCanPour2512 from "./assets/WateringCan/WateringCanPour2-512.webp";
import wateringCanPour21024 from "./assets/WateringCan/WateringCanPour2-1024.webp";
import wateringCanPour22048 from "./assets/WateringCan/WateringCanPour2-2048.webp";

const IMG_SIZES = "min(90vw, 420px)";

const WATERING_CAN_IMAGES = {
  upright: {
    src: wateringCanUpright1024,
    srcSet: `${wateringCanUpright256} 256w, ${wateringCanUpright512} 512w, ${wateringCanUpright1024} 1024w, ${wateringCanUpright2048} 2048w`,
  },
  pour1: {
    src: wateringCanPour11024,
    srcSet: `${wateringCanPour1256} 256w, ${wateringCanPour1512} 512w, ${wateringCanPour11024} 1024w, ${wateringCanPour12048} 2048w`,
  },
  pour2: {
    src: wateringCanPour21024,
    srcSet: `${wateringCanPour2256} 256w, ${wateringCanPour2512} 512w, ${wateringCanPour21024} 1024w, ${wateringCanPour22048} 2048w`,
  },
} as const;

const POUR_FRAMES = [WATERING_CAN_IMAGES.pour1, WATERING_CAN_IMAGES.pour2];
const POUR_FRAME_MS = 140;
// Seconds of reported pouring it takes to drain a full can. The drain only
// advances while the can is tipped, so this is pour time, not wall-clock time.
const DRAIN_DURATION_S = 5;
// How hard the surface leans with the device. Damped rather than 1:1 -- a
// surface pinned exactly level reads as rigid, not as liquid settling.
const SURFACE_TILT_DAMPING = 0.3;

const fmt = (n: number | null | undefined, digits = 1) =>
  n === null || n === undefined ? "—" : n.toFixed(digits);

// Debug hook: `?debug=true` shows the pour counter, gesture phase and sensor
// readout. Everything behind it is development scaffolding -- the production
// page is just the can, the twist and the water.
function isDebugEnabled(): boolean {
  return new URLSearchParams(window.location.search).get("debug") === "true";
}

const PHASE_LABEL: Record<string, string> = {
  idle: "Hold upright, facing you",
  armed: "Ready — tilt counterclockwise",
  fired: "Pouring — tilt back to stop",
};

/**
 * Filled water shape: a wavy surface line across the top, straight sides, flat
 * bottom at `height`.
 *
 * `tiltDeg` leans the surface line only -- positive tips it clockwise on
 * screen -- pivoting about the horizontal centre so the body of water below
 * stays put. Applied to the geometry rather than as a transform on the <svg>,
 * which would swing the whole rectangle of water and expose its corners.
 */
function wavePath(
  width: number,
  height: number,
  amplitude: number,
  freq: number,
  phase: number,
  tiltDeg: number,
) {
  const points = 40;
  // Screen y grows downward, so a clockwise lean is a positive slope.
  const slope = Math.tan(tiltDeg * DEG);
  let d = `M0,${height}`;
  for (let i = 0; i <= points; i++) {
    const x = (width / points) * i;
    const y =
      slope * (x - width / 2) +
      Math.sin((x / width) * freq * Math.PI * 2 + phase) * amplitude;
    d += ` L${x},${y}`;
  }
  d += ` L${width},${height} Z`;
  return d;
}

export default function WateringCan() {
  const { permission, error, listening, orientation, start } =
    useDeviceOrientation();

  const rootRef = useRef<HTMLDivElement | null>(null);
  const { status: lockStatus, requestLock } = useLockPortrait(rootRef);

  const pathRef = useRef<SVGPathElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Latest roll/tilt, mirrored from React state so the gsap.ticker tick
  // (which runs every frame, outside React's render cycle) can read the
  // current value without needing to be a useGSAP dependency -- that would
  // tear down and rebuild the ticker callback on every sensor event.
  const orientationRef = useRef({ roll: 0, tilt: 0 });
  // How much water is left: 1 = full, 0 = empty. Mutated by the paused tween
  // below (which only advances while pouring) and read by the ticker each
  // frame, so draining never goes through React state.
  const levelRef = useRef({ value: 1 });
  const drainRef = useRef<gsap.core.Tween | null>(null);
  // The water box's own size, measured rather than taken from
  // window.innerWidth/innerHeight: on iOS those track the *visual* viewport
  // (they shrink as the URL bar shows) while a fixed element is laid out
  // against the larger layout viewport, so drawing to innerHeight left the
  // shape and its container disagreeing. Cached on resize instead of read per
  // frame, to keep the ticker from forcing a layout every tick.
  const boxRef = useRef({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  useEffect(() => {
    const measure = () => {
      const rect = svgRef.current?.getBoundingClientRect();
      boxRef.current = {
        width: rect?.width || window.innerWidth,
        height: rect?.height || window.innerHeight,
      };
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, []);

  const handleStart = () => {
    // Both the fullscreen request and screen.orientation.lock() require a
    // direct user gesture, so fire this from the same click as `start()`.
    void requestLock();
    void start();
  };

  // Lazy initialiser rather than a ref: reading `.current` during render is
  // what react-hooks/refs flags. Toggling the query param needs a reload,
  // which is fine for a debug switch.
  const [debug] = useState(isDebugEnabled);
  const [twists, setTwists] = useState(0);
  const [pouring, setPouring] = useState(false);
  const [pourFrame, setPourFrame] = useState(0);

  useGSAP(
    () => {
      let prevRoll = orientationRef.current.roll;
      let splash = 0; // decaying "energy" injected by sudden tilt movement

      const tick = () => {
        const t = gsap.ticker.time;
        const { roll: currentRoll } = orientationRef.current;
        const angularVelocity = currentRoll - prevRoll;
        prevRoll = currentRoll;

        // A sudden tilt spikes splash; it decays each frame so the wave
        // settles back to calm instead of staying permanently rough.
        splash = Math.max(
          splash * 0.9,
          Math.min(Math.abs(angularVelocity) * 4, 40),
        );

        const amplitude = 6 + splash; // 6 = calm baseline
        // Span the water box exactly: with only the surface leaning there are
        // no corners to hide, and this pivots the lean about the middle of the
        // screen instead of a point off to the right.
        const { width, height } = boxRef.current;
        if (pathRef.current) {
          pathRef.current.setAttribute(
            "d",
            wavePath(
              width,
              height,
              amplitude,
              2,
              t * 2,
              // The pour is a counterclockwise twist, which lifts the surface
              // on the left, so the lean follows the roll's sign directly.
              currentRoll * SURFACE_TILT_DAMPING,
            ),
          );
          // Push the whole body of water down as the level drops, so the wavy
          // top edge doubles as the surface. Recomputed from the live viewport
          // height each frame, so a resize or URL-bar collapse stays correct.
          pathRef.current.style.transform = `translateY(${
            (1 - levelRef.current.value) * height
          }px)`;
        }
      };
      gsap.ticker.add(tick);

      // Starts paused and is played/paused by pour state below -- nothing
      // drains until the can is actually tipped. Linear so the level falls at
      // a steady rate however many pours it is spread across.
      drainRef.current = gsap.to(levelRef.current, {
        value: 0,
        duration: DRAIN_DURATION_S,
        ease: "none",
        paused: true,
      });

      return () => gsap.ticker.remove(tick);
    },
    { scope: rootRef, dependencies: [] },
  );

  // Water falls only across the window the device is reporting "pouring" to
  // the backend -- same state, same transitions -- and stopping a pour holds
  // the level where it is rather than resetting it.
  useEffect(() => {
    if (pouring) drainRef.current?.play();
    else drainRef.current?.pause();
  }, [pouring]);

  // The frame counter is reset in onTwist (when a pour starts) rather than
  // here, so this effect only owns the interval.
  useEffect(() => {
    if (!pouring) return;
    const id = setInterval(
      () => setPourFrame((n) => (n + 1) % POUR_FRAMES.length),
      POUR_FRAME_MS,
    );
    return () => clearInterval(id);
  }, [pouring]);

  // Timestamp of the current pour's start, so we can log its duration on stop.
  const pourStart = useRef<number | null>(null);

  /**
   * Flip the pour state locally and tell the backend in the same breath, so
   * the water on screen falls over exactly the window the flower is being
   * told the can is tipped. Fire-and-forget: a dropped request shouldn't
   * strand the animation.
   */
  const reportPouring = (next: boolean) => {
    setPouring(next);
    void fetch("/api/pour", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pouring: next }),
    }).catch(() => {
      // best-effort: a missed ping shouldn't break the pour
    });
  };

  const logWatering = () => {
    const start = pourStart.current;
    pourStart.current = null;
    const durationMs = start === null ? null : Date.now() - start;
    void fetch("/api/water", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trigger: "manual", durationMs }),
    }).catch(() => {
      // best-effort: a missed log shouldn't break the animation
    });
  };

  const handlers: TwistHandlers = useMemo(
    () => ({
      onTwist: () => {
        setTwists((n) => n + 1);
        setPourFrame(0);
        reportPouring(true);
        pourStart.current = Date.now();
      },
      onUntwist: () => {
        reportPouring(false);
        logWatering();
      },
      onCancel: () => {
        reportPouring(false);
        logWatering();
      },
    }),
    [],
  );

  const { phase, progress } = useTwistGesture(listening, handlers, {
    // How square-on the screen has to be before a twist counts. |u.z| is the
    // sine of the phone's recline from vertical, so the default 0.35 demands
    // the phone be held within ~20deg of upright -- fussier than anyone
    // naturally holds a watering can. 0.6 allows ~37deg of forward/back tilt,
    // and the lenient mid-pour threshold moves with it to ~58deg so tipping
    // further while pouring still doesn't cancel.
    armFacing: 0.6,
    fireFacing: 0.85,
  });

  const { beta, gamma } = orientation;
  const hasTilt = beta !== null && gamma !== null;
  const up = hasTilt ? upInDevice(beta, gamma) : null;
  const roll = hasTilt ? rollAngle(beta, gamma) : null;
  const tilt = hasTilt ? tiltFromFlat(beta, gamma) : null;

  useEffect(() => {
    orientationRef.current = { roll: roll ?? 0, tilt: tilt ?? 0 };
  }, [roll, tilt]);

  const rows: Array<[string, string]> = !debug
    ? []
    : [
        ["absolute", String(orientation.absolute)],
        ["alpha", fmt(orientation.alpha)],
        ["beta", fmt(beta)],
        ["gamma", fmt(gamma)],
        ["u.x", fmt(up?.x, 3)],
        ["u.y", fmt(up?.y, 3)],
        ["u.z", fmt(up?.z, 3)],
        ["roll", fmt(roll)],
        ["tilt", fmt(tilt)],
        ["phase", phase],
        ["screen.orientation.type", lockStatus.orientationType ?? "—"],
        ["screen.orientation.angle", fmt(lockStatus.orientationAngle, 0)],
        [
          "lock",
          lockStatus.locked
            ? "native"
            : lockStatus.fallbackActive
              ? "css fallback"
              : "none",
        ],
      ];

  return (
    <div
      ref={rootRef}
      style={{
        fontFamily: "system-ui, sans-serif",
        padding: 20,
        maxWidth: 420,
        margin: "0 auto",
      }}
    >
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 16 }}>
        Water the RC flower 🚿
      </h1>
      <p></p>

      {(() => {
        const src = pouring
          ? POUR_FRAMES[pourFrame].src
          : WATERING_CAN_IMAGES.upright.src;
        return [WATERING_CAN_IMAGES.upright, ...POUR_FRAMES].map((frame) => (
          <img
            key={frame.src}
            src={frame.src}
            srcSet={frame.srcSet}
            sizes={IMG_SIZES}
            alt="Watering can"
            style={{
              display: frame.src === src ? "block" : "none",
              width: "100%",
              maxWidth: "420px",
              maxHeight: "70vh",
              objectFit: "contain",
            }}
          />
        ));
      })()}

      {!listening && (
        // Blocking overlay rather than an inline button: the tilt gesture is
        // the whole interaction, so there is nothing to do on this page until
        // motion is granted. The button is still a real tap, which is what
        // iOS requires before it will honour requestPermission().
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="motion-alert-title"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2000,
            display: "grid",
            placeItems: "center",
            padding: 24,
            background: "rgba(20, 22, 20, 0.55)",
            backdropFilter: "blur(2px)",
          }}
        >
          <div
            style={{
              width: "min(320px, 100%)",
              padding: 24,
              borderRadius: 16,
              background: "white",
              boxShadow: "0 18px 40px rgba(0, 0, 0, 0.28)",
              textAlign: "center",
            }}
          >
            <h2
              id="motion-alert-title"
              style={{ fontSize: 19, fontWeight: 600, margin: "0 0 8px" }}
            >
              Motion access
            </h2>
            <p
              style={{
                fontSize: 15,
                lineHeight: 1.5,
                color: "#5f5e5a",
                margin: "0 0 18px",
              }}
            >
              Pouring works by tilting the phone, so this page needs your
              device&apos;s orientation sensor.
            </p>

            {permission === "unsupported" && (
              <p
                style={{
                  fontSize: 14,
                  lineHeight: 1.5,
                  color: "#5f5e5a",
                  margin: "0 0 18px",
                }}
              >
                This browser doesn&apos;t expose device orientation. Check that
                the page is served over HTTPS.
              </p>
            )}

            {error && (
              <p
                role="alert"
                style={{
                  fontSize: 14,
                  lineHeight: 1.5,
                  color: "crimson",
                  margin: "0 0 18px",
                }}
              >
                {error}
              </p>
            )}

            <button
              onClick={handleStart}
              autoFocus
              style={{
                width: "100%",
                fontSize: 18,
                padding: "14px 22px",
                borderRadius: 10,
                border: "1px solid #ccc",
                background: "white",
                cursor: "pointer",
              }}
            >
              {error || permission === "denied" ? "Try again" : "Enable motion"}
            </button>
          </div>
        </div>
      )}

      {debug && (
        <button
          onClick={logWatering}
          style={{
            fontSize: 18,
            padding: "14px 22px",
            borderRadius: 10,
            border: "1px solid #ccc",
            background: "white",
            cursor: "pointer",
          }}
        >
          Debug: Trigger water
        </button>
      )}

      <svg
        ref={svgRef}
        style={{
          // Fixed, not absolute: with no positioned ancestor, `absolute`
          // anchors to the initial containing block, so `bottom: 0` was one
          // viewport-height down the *document* and slid away as the page
          // scrolled. Fixed pins it to the screen.
          //
          // inset: 0 rather than 100svw/100svh: `svh` is the *smallest*
          // viewport height (URL bar showing), which left an uncovered strip
          // at the top once the bar collapsed. With viewport-fit=cover in
          // index.html this now bleeds under the notch and home indicator.
          position: "fixed",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      >
        <path
          ref={pathRef}
          y="0"
          style={{
            fill: "rgba(56, 85, 165, 0.8)",
          }}
        ></path>
      </svg>

      {listening && error && (
        <p role="alert" style={{ color: "crimson", lineHeight: 1.5 }}>
          {error}
        </p>
      )}

      {listening && (
        <>
          {debug && (
            <div
              style={{
                padding: 28,
                marginBottom: 16,
                borderRadius: 12,
                textAlign: "center",
                background: pouring ? "#1d9e75" : "#f1efe8",
                color: pouring ? "white" : "#2c2c2a",
                transition: "background 200ms",
              }}
            >
              <div style={{ fontSize: 44, fontWeight: 500, lineHeight: 1.1 }}>
                {twists}
              </div>
              <div style={{ fontSize: 14, opacity: 0.85 }}>
                {twists === 1 ? "pour" : "pours"}
              </div>
            </div>
          )}

          {debug && (
            <div
              style={{
                height: 8,
                borderRadius: 4,
                background: "#e6e4dc",
                overflow: "hidden",
                marginBottom: 10,
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${progress * 100}%`,
                  background: pouring ? "#1d9e75" : "#85b7eb",
                  transition: "width 80ms linear",
                }}
              />
            </div>
          )}

          <p
            style={{
              fontSize: 15,
              color: "#5f5e5a",
              minHeight: 22,
              marginBottom: 24,
            }}
          >
            {PHASE_LABEL[phase]}
          </p>

          {debug && (
            <details>
              <summary
                style={{ fontSize: 14, color: "#5f5e5a", cursor: "pointer" }}
              >
                Sensor readout
              </summary>
              <table
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 13,
                  marginTop: 10,
                  borderSpacing: "12px 3px",
                }}
              >
                <tbody>
                  {rows.map(([label, value]) => (
                    <tr key={label}>
                      <td style={{ color: "#888780" }}>{label}</td>
                      <td style={{ textAlign: "right" }}>{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </>
      )}
    </div>
  );
}
