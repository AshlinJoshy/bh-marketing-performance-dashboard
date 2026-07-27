// SEO tab aggregator.
//
// PostHog (traffic) + GSC live together in getSeoData — both are fast and load
// with the page. Metabase leads are pulled SEPARATELY via getSeoLeads (fetched
// client-side) because that CRM view is slow; keeping it off the page's server
// render means a slow Metabase query can never stall or kill the fast PostHog /
// GSC queries (they no longer share one function invocation).
import { getSeoTraffic, type SeoTraffic } from "@/lib/posthog";
import { getGscMetrics, type GscData } from "@/lib/gsc";
import { getLeadsData, type LeadsData } from "@/lib/metabase";
import { getSeoConfig } from "@/lib/data";

export interface SeoData {
  from: string;
  to: string;
  label: string;
  keywords: string[];
  traffic: SeoTraffic;
  gsc: GscData;
  /** When the sources were queried, ISO — the "updated" stamp. */
  generatedAt: string;
}

const isDate = (s?: string): string | null => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Resolve a from/to range; defaults to the last 30 days ending today. */
export function seoRange(fromRaw?: string, toRaw?: string): { from: string; to: string } {
  const to = isDate(toRaw) ?? ymd(new Date());
  const from = isDate(fromRaw) ?? ymd(new Date(Date.now() - 29 * 864e5));
  return from <= to ? { from, to } : { from: to, to: from };
}

/** Fast half: PostHog traffic + GSC (loads with the page). */
export async function getSeoData(fromRaw?: string, toRaw?: string): Promise<SeoData> {
  const { from, to } = seoRange(fromRaw, toRaw);
  const cfg = await getSeoConfig();
  const [traffic, gsc] = await Promise.all([getSeoTraffic(from, to), getGscMetrics(from, to, cfg.keywords)]);
  return { from, to, label: `${from} → ${to}`, keywords: cfg.keywords, traffic, gsc, generatedAt: new Date().toISOString() };
}

/** Slow half: Metabase leads (fetched separately, client-side). */
export async function getSeoLeads(fromRaw?: string, toRaw?: string, audit = false): Promise<LeadsData> {
  const { from, to } = seoRange(fromRaw, toRaw);
  return getLeadsData(from, to, { audit });
}
