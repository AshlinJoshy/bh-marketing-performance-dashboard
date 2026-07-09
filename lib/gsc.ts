// Google Search Console (Search Analytics) — organic clicks, impressions, CTR,
// average position, and per-keyword rankings. Server-only.
//
// Auth is a Google service account (no user OAuth): sign a JWT with the account's
// private key, exchange it for an access token, then call the Search Analytics
// API. Set three env vars (all optional — missing → a graceful "not connected"):
//   GSC_SITE_URL     e.g. "sc-domain:bhomes.com"  (defaults to that)
//   GSC_CLIENT_EMAIL the service account email
//   GSC_PRIVATE_KEY  the service account private key ("\n" escapes are handled)
// The service account must be added as a user on the GSC property.
import crypto from "node:crypto";

const SITE = process.env.GSC_SITE_URL || "sc-domain:bhomes.com";

export interface GscTotals {
  clicks: number;
  impressions: number;
  ctr: number; // 0..1
  position: number; // avg position (lower = better)
}
export interface GscKeyword {
  keyword: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null; // null = not ranking / no data in range
}
export interface GscData {
  connected: boolean;
  totals: GscTotals | null;
  keywords: GscKeyword[];
  label: string;
  error?: string;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// Cache the access token in-process for its lifetime (~1h) to avoid re-signing.
let tokenCache: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string | null> {
  const email = process.env.GSC_CLIENT_EMAIL;
  let key = process.env.GSC_PRIVATE_KEY;
  if (!email || !key) return null;
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.exp - 60 > now) return tokenCache.token;
  key = key.replace(/\\n/g, "\n");
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: email,
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    }),
  );
  const signingInput = `${header}.${claim}`;
  let signature: string;
  try {
    signature = b64url(crypto.createSign("RSA-SHA256").update(signingInput).sign(key));
  } catch {
    return null; // malformed private key
  }
  const jwt = `${signingInput}.${signature}`;
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j?.access_token) return null;
    tokenCache = { token: j.access_token as string, exp: now + Number(j.expires_in || 3600) };
    return tokenCache.token;
  } catch {
    return null;
  }
}

async function gscQuery(body: Record<string, unknown>): Promise<any | null> {
  const token = await accessToken();
  if (!token) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: ctrl.signal,
      },
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Organic totals for the range + avg position for each target keyword. */
export async function getGscMetrics(from: string, to: string, targetKeywords: string[] = []): Promise<GscData> {
  const connected = !!(process.env.GSC_CLIENT_EMAIL && process.env.GSC_PRIVATE_KEY);
  const base: GscData = { connected, totals: null, keywords: [], label: `${from} → ${to}` };
  if (!connected) return base;

  const [totalsRes, kwRes] = await Promise.all([
    gscQuery({ startDate: from, endDate: to, dimensions: [], dataState: "all" }),
    targetKeywords.length
      ? gscQuery({ startDate: from, endDate: to, dimensions: ["query"], rowLimit: 5000, dataState: "all" })
      : Promise.resolve(null),
  ]);

  const row = totalsRes?.rows?.[0];
  base.totals = row
    ? { clicks: row.clicks || 0, impressions: row.impressions || 0, ctr: row.ctr || 0, position: row.position || 0 }
    : { clicks: 0, impressions: 0, ctr: 0, position: 0 };

  if (targetKeywords.length) {
    const byQ = new Map<string, any>();
    for (const r of kwRes?.rows ?? []) byQ.set(String(r.keys?.[0] || "").toLowerCase(), r);
    base.keywords = targetKeywords.map((k) => {
      const r = byQ.get(k.trim().toLowerCase());
      return {
        keyword: k,
        clicks: r?.clicks || 0,
        impressions: r?.impressions || 0,
        ctr: r?.ctr || 0,
        position: r ? Math.round((r.position || 0) * 10) / 10 : null,
      };
    });
  }
  return base;
}
