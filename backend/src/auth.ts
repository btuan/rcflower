/**
 * RC OAuth2 login gate for /debug and its backing APIs (see
 * docs/design/video-and-annotation-pipeline.md). Two cookies:
 *
 * - `rc_oauth_state`: short-lived CSRF token, set right before redirecting to
 *   RC and checked when RC redirects back.
 * - `rc_session`: a signed, stateless session (RC person id + name + expiry).
 *   Signed rather than backed by a DB row -- this app doesn't need to revoke
 *   individual sessions, and rotating SESSION_SECRET invalidates all of them
 *   at once if that's ever needed. The RC access token itself is used once,
 *   to look up the profile, and then discarded.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";

const RC_BASE = "https://www.recurse.com";

const STATE_COOKIE = "rc_oauth_state";
const STATE_TTL_SEC = 5 * 60;

const SESSION_COOKIE = "rc_session";
const SESSION_TTL_SEC = 30 * 24 * 60 * 60;

export type Session = { personId: number; name: string };
type SessionPayload = Session & { exp: number };

/** Parse a `Cookie:` header into a plain object; a missing header yields `{}`. */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value); // Decodes percent-encoding like %20 to spaces
    } catch {
      out[key] = value; // malformed percent-encoding -- keep it raw
    }
  }
  return out;
}

/**
 * Build a `Set-Cookie` value. `Secure` is set unconditionally: the browser
 * decides based on the URL it loaded the page from (the funnel's https://
 * URL in prod, or the localhost exception in dev), not on what scheme Bun
 * itself sees -- same caveat as device-orientation elsewhere in this repo,
 * a raw LAN-IP dev URL over plain HTTP won't get the cookie.
 */
function buildCookie(name: string, value: string, maxAgeSec?: number): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax"];
  if (maxAgeSec !== undefined) parts.push(`Max-Age=${maxAgeSec}`);
  return parts.join("; ");
}

const clearCookie = (name: string): string => buildCookie(name, "", 0);

const sign = (data: string): string => createHmac("sha256", config.sessionSecret).update(data).digest().toString("base64url");

/** Constant-time comparison of two strings of possibly-different length. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// --- CSRF state: ties GET /auth/rc/login to the redirect_uri callback ---

export const randomState = (): string => randomBytes(24).toString("base64url");

export const stateCookieHeader = (state: string): string => buildCookie(STATE_COOKIE, state, STATE_TTL_SEC);

export const clearStateCookieHeader = (): string => clearCookie(STATE_COOKIE);

/** True if `state` matches the value stashed in the `rc_oauth_state` cookie. */
export function verifyState(req: Request, state: string | null): boolean {
  if (!state) return false;
  const cookieState = parseCookies(req.headers.get("cookie"))[STATE_COOKIE];
  return cookieState !== undefined && timingSafeEqualStr(state, cookieState);
}

// --- Session ---

export function sessionCookieHeader(session: Session): string {
  const payload: SessionPayload = { ...session, exp: Date.now() + SESSION_TTL_SEC * 1000 };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return buildCookie(SESSION_COOKIE, `${body}.${sign(body)}`, SESSION_TTL_SEC);
}

export const clearSessionCookieHeader = (): string => clearCookie(SESSION_COOKIE);

/** Verify and decode the `rc_session` cookie from a request. Null if missing/invalid/expired. */
export function getSession(req: Request): Session | null {
  const raw = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 0) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!timingSafeEqualStr(sig, sign(body))) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    if (typeof payload.personId !== "number" || typeof payload.name !== "string") return null;
    return { personId: payload.personId, name: payload.name };
  } catch {
    return null;
  }
}

// --- RC OAuth2 (authorization-code flow -- see Recurse-Center-API.md) ---

export function buildAuthorizeUrl(state: string): string {
  const url = new URL("/oauth/authorize", RC_BASE);
  url.searchParams.set("client_id", config.rcOAuthClientId);
  url.searchParams.set("redirect_uri", config.rcOAuthRedirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

/** Exchange an authorization code for an access token. Null on any failure. */
export async function exchangeCodeForToken(code: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`${RC_BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: config.rcOAuthClientId,
        client_secret: config.rcOAuthClientSecret,
        redirect_uri: config.rcOAuthRedirectUri,
      }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { access_token?: string } | null;
  return typeof data?.access_token === "string" ? data.access_token : null;
}

/** Fetch the authenticated RC profile's id + display name. Null on any failure. */
export async function fetchRcProfile(accessToken: string): Promise<Session | null> {
  let res: Response;
  try {
    res = await fetch(`${RC_BASE}/api/v1/profiles/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { id?: number; name?: string } | null;
  if (typeof data?.id !== "number" || typeof data.name !== "string") return null;
  return { personId: data.id, name: data.name };
}
