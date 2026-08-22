import { useEffect, useMemo, useState } from "react";
import { rollAngle, tiltFromFlat, upInDevice } from "./orientation";
import { useDeviceOrientation } from "./useDeviceOrientation";
import { useTwistGesture } from "./useTwistGesture";
import type { TwistHandlers } from "./useTwistGesture";
import wateringCanUpright from "./assets/WateringCan/WateringCanUpright.png";
import wateringCanPour1 from "./assets/WateringCan/WateringCanPour1.png";
import wateringCanPour2 from "./assets/WateringCan/WateringCanPour2.png";

const POUR_FRAMES = [wateringCanPour1, wateringCanPour2];
const POUR_FRAME_MS = 140;

const fmt = (n: number | null | undefined, digits = 1) =>
  n === null || n === undefined ? "—" : n.toFixed(digits);

const PHASE_LABEL: Record<string, string> = {
  idle: "Hold upright, facing you",
  armed: "Ready — twist counterclockwise",
  fired: "Pouring — twist back to stop",
};

export default function WateringCan() {
  const { permission, error, listening, orientation, start } =
    useDeviceOrientation();

  const [twists, setTwists] = useState(0);
  const [pouring, setPouring] = useState(false);
  const [pourFrame, setPourFrame] = useState(0);

  useEffect(() => {
    if (!pouring) {
      setPourFrame(0);
      return;
    }
    const id = setInterval(
      () => setPourFrame((n) => (n + 1) % POUR_FRAMES.length),
      POUR_FRAME_MS,
    );
    return () => clearInterval(id);
  }, [pouring]);

  const handlers: TwistHandlers = useMemo(
    () => ({
      onTwist: () => {
        setTwists((n) => n + 1);
        setPouring(true);
      },
      onUntwist: () => setPouring(false),
      onCancel: () => setPouring(false),
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
  ];

  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        padding: 20,
        maxWidth: 420,
        margin: "0 auto",
      }}
    >
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 16 }}>
        Watering can
      </h1>

      {(() => {
        const src = pouring ? POUR_FRAMES[pourFrame] : wateringCanUpright;
        return [wateringCanUpright, ...POUR_FRAMES].map((frame) => (
          <img
            key={frame}
            src={frame}
            alt="Watering can"
            style={{ display: frame === src ? "block" : "none" }}
          />
        ));
      })()}

      {!listening && (
        <button
          onClick={start}
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
