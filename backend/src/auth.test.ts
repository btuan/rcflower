import { describe, expect, test } from "bun:test";
import {
  clearSessionCookieHeader,
  getSession,
  parseCookies,
  sessionCookieHeader,
  verifyState,
} from "./auth.ts";

const reqWithCookie = (cookie: string): Request =>
  new Request("http://localhost/", { headers: { cookie } });

/** Pull the `name=value` pair out of a `Set-Cookie` header, ignoring attributes. */
const cookiePair = (setCookieHeader: string): string => setCookieHeader.split(";")[0]!;

describe("parseCookies", () => {
  test("parses multiple cookies", () => {
    expect(parseCookies("a=1; b=2")).toEqual({ a: "1", b: "2" });
  });

  test("returns {} for a missing header", () => {
    expect(parseCookies(null)).toEqual({});
  });

  test("decodes percent-encoded values, keeping malformed ones raw", () => {
    expect(parseCookies("a=hello%20world")).toEqual({ a: "hello world" });
    expect(parseCookies("a=%")).toEqual({ a: "%" });
  });
});

describe("session cookie round-trip", () => {
  test("a freshly issued session verifies", () => {
    const header = sessionCookieHeader({ personId: 42, name: "Ada Lovelace" });
    const req = reqWithCookie(cookiePair(header));
    expect(getSession(req)).toEqual({ personId: 42, name: "Ada Lovelace" });
  });

  test("a tampered payload is rejected", () => {
    const header = sessionCookieHeader({ personId: 42, name: "Ada Lovelace" });
    const sig = cookiePair(header).replace("rc_session=", "").split(".")[1];
    const tamperedBody = Buffer.from(
      JSON.stringify({ personId: 99, name: "Eve", exp: Date.now() + 1e9 }),
    ).toString("base64url");
    const req = reqWithCookie(`rc_session=${tamperedBody}.${sig}`);
    expect(getSession(req)).toBeNull();
  });

  test("a garbage cookie value is rejected", () => {
    expect(getSession(reqWithCookie("rc_session=not-a-real-token"))).toBeNull();
  });

  test("a missing cookie yields no session", () => {
    expect(getSession(new Request("http://localhost/"))).toBeNull();
  });

  test("clearSessionCookieHeader expires the cookie immediately", () => {
    expect(clearSessionCookieHeader()).toContain("Max-Age=0");
  });
});

describe("verifyState", () => {
  test("matches when state equals the stashed cookie", () => {
    const req = reqWithCookie("rc_oauth_state=abc123");
    expect(verifyState(req, "abc123")).toBe(true);
  });

  test("rejects a mismatched state", () => {
    const req = reqWithCookie("rc_oauth_state=abc123");
    expect(verifyState(req, "wrong")).toBe(false);
  });

  test("rejects when there's no state cookie at all", () => {
    expect(verifyState(new Request("http://localhost/"), "abc123")).toBe(false);
  });

  test("rejects a null state", () => {
    const req = reqWithCookie("rc_oauth_state=abc123");
    expect(verifyState(req, null)).toBe(false);
  });
});
