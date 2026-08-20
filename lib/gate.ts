// Shared PIN-gate helpers for the two access levels.
//
// Kept tiny and dependency free because proxy.ts runs in the edge runtime, where
// Node's crypto module is unavailable — everything here uses Web Crypto, which
// exists in both runtimes.

/** Which door is being opened. */
export type Scope = "app" | "settings";

/**
 * The PINs. Overridable per deployment.
 *
 * Two levels on purpose: the app PIN stops idle tabs spending API quota, while
 * the settings PIN protects values that change everyone's numbers — portal
 * spend feeds cost per deal, and the ad-account list drives how much quota a
 * single page load consumes.
 */
export const PINS: Record<Scope, string> = {
  app: process.env.DASHBOARD_PIN || "1986",
  settings: process.env.SETTINGS_PIN || "2000",
};

export const COOKIES: Record<Scope, string> = {
  app: "bh_gate",
  settings: "bh_gate_settings",
};

export const isScope = (v: unknown): v is Scope => v === "app" || v === "settings";

/**
 * The cookie's expected value: a digest of the scope, its PIN, and a server
 * secret.
 *
 * Deliberately NOT the PIN itself — a cookie holding "1986" could be set by hand
 * by anyone who guessed the scheme, making the gate decorative. The scope is
 * mixed in so an app cookie cannot be replayed as a settings cookie.
 */
export async function expectedToken(scope: Scope): Promise<string> {
  const secret = process.env.SESSION_SECRET || process.env.CRON_SECRET || "bh-gate-fallback";
  const bytes = new TextEncoder().encode(`${scope}|${PINS[scope]}|${secret}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time-ish compare, so a token can't be probed byte by byte. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
