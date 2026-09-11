import { useEffect, useMemo, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { rollAngle, tiltFromFlat, upInDevice } from "./orientation";
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

const fmt = (n: number | null | undefined, digits = 1) =>
  n === null || n === undefined ? "—" : n.toFixed(digits);

const PHASE_LABEL: Record<string, string> = {
  idle: "Hold upright, facing you",
  armed: "Ready — twist counterclockwise",
  fired: "Pouring — twist back to stop",
};

function wavePath(
  width: number,
  height: number,
  amplitude: number,
  freq: number,
  phase: number,
) {
  const points = 40;
  let d = `M0,${height}`;
  for (let i = 0; i <= points; i++) {
    const x = (width / points) * i;
    const y =
      0 + Math.sin((x / width) * freq * Math.PI * 2 + phase) * amplitude;
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

  const handleStart = () => {
    // Both the fullscreen request and screen.orientation.lock() require a
    // direct user gesture, so fire this from the same click as `start()`.
    void requestLock();
    void start();
  };

  const [twists, setTwists] = useState(0);
  const [pouring, setPouring] = useState(false);
  const [pourFrame, setPourFrame] = useState(0);

  useGSAP(
    () => {
      if (!pouring) return;
      const tick = () => {
        const t = gsap.ticker.time;
        pathRef.current?.setAttribute(
          "d",
          wavePath(1200, window.innerHeight, 12, 2, t * 2), // amplitude & freq can themselves vary with t
        );
      };
      gsap.ticker.add(tick);

      gsap.to(pathRef.current, {
        y: "100svh",
        duration: 5.0,
        ease: "power3.inOut",
      });

      return () => gsap.ticker.remove(tick);
    },
    { scope: rootRef, dependencies: [pouring] },
  );

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
        setPouring(true);
        pourStart.current = Date.now();
      },
      onUntwist: () => {
        setPouring(false);
        logWatering();
      },
      onCancel: () => {
        setPouring(false);
        logWatering();
      },
    }),
    [],
  );

  const { phase, progress } = useTwistGesture(listening, handlers);

  const { beta, gamma } = orientation;
  const hasTilt = beta !== null && gamma !== null;
  const up = hasTilt ? upInDevice(beta, gamma) : null;
  const roll = hasTilt ? rollAngle(beta, gamma) : null;
  const tilt = hasTilt ? tiltFromFlat(beta, gamma) : null;

  const rows: Array<[string, string]> = [
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
        Watering can (TEST)
      </h1>
      <p>With this line Katie is testing whether changes showing up on pi</p>

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
        <button
          onClick={handleStart}
          style={{
            fontSize: 18,
            padding: "14px 22px",
            borderRadius: 10,
            border: "1px solid #ccc",
            background: "white",
            cursor: "pointer",
          }}
        >
          Enable motion
        </button>
      )}

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

      <svg
        style={{
          width: "100svw",
          height: "100svh",
          position: "absolute",
          bottom: 0,
          left: 0,
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

      {error && (
        <p role="alert" style={{ color: "crimson", lineHeight: 1.5 }}>
          {error}
        </p>
      )}

      {permission === "unsupported" && (
        <p style={{ lineHeight: 1.5 }}>
          This browser doesn&apos;t expose device orientation. Check that the
          page is served over HTTPS.
        </p>
      )}

      {listening && (
        <>
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
        </>
      )}
    </div>
  );
}
