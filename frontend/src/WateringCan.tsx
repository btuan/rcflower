import { useEffect, useState } from "react";

type Orientation = {
  absolute: boolean;
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
};

// requestPermission is WebKit-only and absent from lib.dom.d.ts
type DeviceOrientationEventIOS = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied" | "default">;
};

export default function WateringCan() {
  const [orientation, setOrientation] = useState<Orientation>({
    absolute: false,
    alpha: null,
    beta: null,
    gamma: null,
  });
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!listening) return;

    const handleOrientation = (event: DeviceOrientationEvent) => {
      setOrientation({
        absolute: event.absolute,
        alpha: event.alpha,
        beta: event.beta,
        gamma: event.gamma,
      });
    };

    window.addEventListener("deviceorientation", handleOrientation);
    return () =>
      window.removeEventListener("deviceorientation", handleOrientation);
  }, [listening]);

  async function handleClick() {
    setError(null);

    if (typeof DeviceOrientationEvent === "undefined") {
      setError("DeviceOrientationEvent is not supported in this browser.");
      return;
    }

    const DOE = DeviceOrientationEvent as DeviceOrientationEventIOS;

    if (typeof DOE.requestPermission === "function") {
      try {
        const permission = await DOE.requestPermission();
        if (permission !== "granted") {
          setError(`Permission ${permission}.`);
          return;
        }
      } catch {
        setError(
          "requestPermission failed — needs HTTPS and a direct user gesture.",
        );
        return;
      }
    }

    setListening(true);
  }

  const fmt = (n: number | null) => (n === null ? "—" : n.toFixed(1));

  return (
    <>
      <button onClick={handleClick} disabled={listening}>
        {listening ? "LISTENING" : "TEST"}
      </button>
      {error && <div role="alert">{error}</div>}
      <div>
        <div>Absolute: {String(orientation.absolute)}</div>
        <div>Alpha: {fmt(orientation.alpha)}</div>
        <div>Beta: {fmt(orientation.beta)}</div>
        <div>Gamma: {fmt(orientation.gamma)}</div>
      </div>
    </>
  );
}
