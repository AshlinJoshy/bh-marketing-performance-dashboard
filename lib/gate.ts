// Shared PIN-gate helpers. Kept tiny and dependency free because proxy.ts runs
// in the edge runtime, where Node's crypto module is unavailable — everything
// here uses Web Crypto, which exists in both runtimes.

/** The PIN. Overridable per deployment; defaults to the founding year. */
export const PIN = process.env.DASHBOARD_PIN || "1986";

/** Cookie the gate looks for. */
export const GATE_COOKIE = "bh_gate";

/**
 * The cookie's expected value: a digest of the PIN and a server secret.
 *
 * Deliberately NOT the PIN itself. A cookie holding "1986" could be set by hand
 * by anyone who guessed the scheme, which would make the gate decorative. The
 * secret never reaches the browser, so the token cannot be forged without it.
 *
 * SESSION_SECRET falls back to CRON_SECRET (already set in this deployment) and
 * then to a constant. The constant is a weak last resort, noted rather than
 * hidden: with it, the token is derivable by anyone reading this source.
 */
export async function expectedToken(): Promise<string> {
  const secret = process.env.SESSION_SECRET || process.env.CRON_SECRET || "bh-gate-fallback";
  const bytes = new TextEncoder().encode(`${PIN}|${secret}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time-ish compare, so the token can't be probed byte by byte. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
