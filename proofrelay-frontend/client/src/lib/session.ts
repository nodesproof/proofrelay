/**
 * The wallet session, in the browser.
 *
 * The API has spoken SIWE since it was written — `POST /v1/auth/nonce`,
 * `POST /v1/auth/verify`, a bearer token whose sha256 is all the server keeps —
 * and `lib/api.ts` has had `authNonce` and `authVerify` since then too. Nothing
 * called either. So every request arrived unauthenticated, and `prepare`, which
 * spends the operator's own 0G on 0G Storage uploads, fell back to the `creator`
 * named in the request body: an address anyone can type. The route's own comment
 * says what closes that — "requiring a signed-in wallet is the complete fix, and
 * it needs the web app to implement SIWE first". This is that.
 *
 * Two rules the storage side has to hold:
 *
 * 1. **A token belongs to one address.** `tokenFor` takes the address the wallet
 *    is on *now* and returns nothing when the stored session was signed by
 *    another. A wallet that switches accounts must not keep acting as the
 *    previous one, and the API resolves the acting address from the session
 *    before it reads the body — so a stale token would silently file a task
 *    under an address the user is no longer using.
 * 2. **Storage is allowed to fail.** A private window, cleared site data, or a
 *    browser configured to refuse it all make `localStorage` throw on access,
 *    not return null. Every touch is wrapped; the worst outcome is a session
 *    that does not survive a reload.
 */
export interface StoredSession {
  token: string;
  /** Lowercased, so a comparison never turns on EIP-55 casing. */
  address: string;
  expiresAt: string;
}

const KEY = "proofrelay.session.v1";

function isSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.token === "string" &&
    candidate.token.length > 0 &&
    typeof candidate.address === "string" &&
    /^0x[0-9a-f]{40}$/.test(candidate.address) &&
    typeof candidate.expiresAt === "string" &&
    Number.isFinite(Date.parse(candidate.expiresAt))
  );
}

export function readSession(now = Date.now()): StoredSession | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearSession();
    return null;
  }
  if (!isSession(parsed)) {
    clearSession();
    return null;
  }
  // An expired token is a 401 waiting to happen. Dropping it here means the UI
  // shows "signed out" rather than "signed in, and every write fails".
  if (Date.parse(parsed.expiresAt) <= now) {
    clearSession();
    return null;
  }
  return parsed;
}

export function writeSession(session: StoredSession): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...session, address: session.address.toLowerCase() }));
  } catch {
    /* the session lives for this page view only; nothing else changes */
  }
}

export function clearSession(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}

/**
 * The bearer token for the address the wallet is on, or null.
 *
 * Pure, and given the address rather than reading it: this is the check that
 * has to be exact, and a module that reaches into wagmi to find out cannot be
 * tested without one.
 */
export function tokenFor(address: string | undefined, now = Date.now()): string | null {
  if (!address) return null;
  const session = readSession(now);
  if (!session) return null;
  return session.address === address.toLowerCase() ? session.token : null;
}

/**
 * Drops a session that belongs to a *different* address, and reports whether it
 * did.
 *
 * Called when the connected account changes. Leaving the row in place would not
 * authenticate anything — `tokenFor` already refuses it — but it would come back
 * the moment the first account reconnected, long after the user had any reason
 * to expect it to.
 *
 * No address is not a foreign address. wagmi restores the last connection
 * asynchronously, so `address` is undefined for the first render of every
 * reload; clearing on that would sign the user out of a session that was
 * about to become valid again, every single time the page loaded. Nothing is
 * at risk in the meantime because `tokenFor(undefined)` already returns null.
 */
export function forgetForeignSession(address: string | undefined, now = Date.now()): boolean {
  if (!address) return false;
  const session = readSession(now);
  if (!session || session.address === address.toLowerCase()) return false;
  clearSession();
  return true;
}
