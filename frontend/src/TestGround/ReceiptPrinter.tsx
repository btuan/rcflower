import { useCallback, useEffect, useState, type FormEvent } from "react";

const RECEIPT_API = "https://receipt.recurse.com";
const CSRF_COOKIE = "receipt_csrf";

/**
 * Reads a cookie value by key. Returns null when it isn't set.
 *
 * The `receipt_csrf` cookie is created by Receipt Printer API with
 * `Domain=.recurse.com`, so it's only readable when this app is served from a
 * `*.recurse.com` subdomain.
 */
function readCookie(key: string): string | null {
  const match = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${key}=`));
  return match ? decodeURIComponent(match.slice(key.length + 1)) : null;
}

export function ReceiptPrinter() {
  const [csrfToken, setCsrfToken] = useState<string | null>(() =>
    readCookie(CSRF_COOKIE),
  );

  // When the user returns from the OAuth flow the cookie is present, but this
  // component may already be mounted, so re-check when the tab regains focus.
  useEffect(() => {
    const refresh = () => setCsrfToken(readCookie(CSRF_COOKIE));
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  // Step 2: send the user to Receipt Printer API's login, asking it to redirect
  // back to this exact page when the OAuth flow completes.
  const login = () => {
    const redirectUri = window.location.href;
    window.location.href = `${RECEIPT_API}/login?redirect_uri=${encodeURIComponent(redirectUri)}`;
  };

  /**
   * Step 4: make an authenticated request to Receipt Printer API.
   *
   * - `X-CSRF-Token` proves the request comes from a `*.recurse.com` subdomain.
   * - `credentials: "include"` tells the browser to send the session cookie so
   *   the API can verify the user is a Recurser.
   */
  const apiFetch = useCallback(
    (path: string, init: RequestInit = {}) => {
      if (!csrfToken) {
        throw new Error("Not authenticated with Receipt Printer API");
      }
      return fetch(`${RECEIPT_API}${path}`, {
        ...init,
        credentials: "include",
        headers: {
          ...init.headers,
          "X-CSRF-Token": csrfToken,
        },
      });
    },
    [csrfToken],
  );

  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  // POST /text — print text to the printer.
  const printText = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    setStatus("Printing…");
    try {
      const res = await apiFetch("/text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      setStatus(res.ok ? "Printed!" : `Error: ${res.status}`);
      if (res.ok) setText("");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Request failed");
    }
  };

  // Step 2 (skip case): if there's already a `receipt_csrf` cookie, the user is
  // authenticated, so no need to show the login button.
  if (!csrfToken) {
    return (
      <div>
        <p>Authenticate to print receipts.</p>
        <button type="button" onClick={login}>
          Log in with Recurse Center
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={printText}>
      <p>Authenticated with Receipt Printer API.</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Text to print (printable ASCII only)"
        rows={3}
      />
      <button type="submit" disabled={!text.trim()}>
        Print
      </button>
      {status && <p>{status}</p>}
    </form>
  );
}
