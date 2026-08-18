export const DEG = Math.PI / 180;

export type Orientation = {
  absolute: boolean;
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
};

export type PermissionState = "unknown" | "granted" | "denied" | "unsupported";

type DeviceOrientationEventIOS = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied" | "default">;
};

/** Earth's up vector expressed in device coordinates. */
export function upInDevice(beta: number, gamma: number) {
  const b = beta * DEG;
  const g = gamma * DEG;
  return {
    x: -Math.cos(b) * Math.sin(g),
    y: Math.sin(b),
    z: Math.cos(b) * Math.cos(g),
  };
}

/** Roll about the device z axis. 0 = top of screen up, positive = CCW. */
export function rollAngle(beta: number, gamma: number) {
  const u = upInDevice(beta, gamma);
  return Math.atan2(u.x, u.y) / DEG;
}

/** 0 = flat on a table, 90 = on edge in any direction. Alpha-independent. */
export function tiltFromFlat(beta: number, gamma: number) {
  const cos = Math.cos(beta * DEG) * Math.cos(gamma * DEG);
  return Math.acos(Math.max(-1, Math.min(1, cos))) / DEG;
}

/** Signed difference a - b, wrapped into [-180, 180). */
export function shortestDelta(a: number, b: number) {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

export async function requestOrientationPermission(): Promise<{
  state: PermissionState;
  error?: string;
}> {
  if (typeof DeviceOrientationEvent === "undefined") {
    return {
      state: "unsupported",
      error: "DeviceOrientationEvent is not available in this browser.",
    };
  }

  const DOE = DeviceOrientationEvent as DeviceOrientationEventIOS;
  if (typeof DOE.requestPermission !== "function") {
    return { state: "granted" };
  }

  try {
    const result = await DOE.requestPermission();
    return result === "granted"
      ? { state: "granted" }
      : { state: "denied", error: `Motion permission was ${result}.` };
  } catch {
    return {
      state: "denied",
      error: "requestPermission failed. Needs HTTPS and a direct user gesture.",
    };
  }
}
