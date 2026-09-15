/**
 * The `user` cookie: who's doing the watering.
 *
 * Stored as JSON so it can carry more than a name later, and percent-encoded
 * because a raw JSON value contains characters (`;`, `,`, spaces) that aren't
 * legal in a cookie value. The backend reads it the mirror-image way in
 * `cookieUserName` (backend/src/index.ts) and stamps the name onto each
 * watering event.
 *
 * Everything here is optional by design -- no cookie, a malformed one, or a
 * blank name all mean "anonymous", which the flower renders as "Someone".
 */

const COOKIE = "user";
const ONE_YEAR_S = 60 * 60 * 24 * 365;

type UserCookie = { name?: string | null };

function readRaw(): string | null {
  for (const part of document.cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null; // malformed percent-encoding
    }
  }
  return null;
}

/** The stored name, or null if unset / blank / unparseable. */
export function getUserName(): string | null {
  const raw = readRaw();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as UserCookie;
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    return name || null;
  } catch {
    return null;
  }
}

/** Persist the name for a year. A blank name clears the cookie instead. */
export function setUserName(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) {
    clearUserName();
    return;
  }
  const value = encodeURIComponent(JSON.stringify({ name: trimmed }));
  document.cookie = `${COOKIE}=${value}; path=/; max-age=${ONE_YEAR_S}; samesite=lax`;
}

export function clearUserName(): void {
  document.cookie = `${COOKIE}=; path=/; max-age=0; samesite=lax`;
}
