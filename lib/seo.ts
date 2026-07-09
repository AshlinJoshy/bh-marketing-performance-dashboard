// SEO tab aggregator — pulls the three live sources in parallel:
//   • PostHog   → traffic by channel, AI sessions (+ by source), organic pageviews
//   • GSC       → organic clicks / impressions + target-keyword rankings
//   • Metabase  → organic & AI leads, pipeline stage, open/closed status
// Each source degrades to a "not connected" shape on its own, so a missing
// credential only blanks its section — the rest of the tab still renders.
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
  leads: LeadsData;
}

const isDate = (s?: string): string | null => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Resolve a from/to range; defaults to the last 30 days ending today. */
export function seoRange(fromRaw?: string, toRaw?: string): { from: string; to: string } {
  const to = isDate(toRaw) ?? ymd(new Date());
  const from = isDate(fromRaw) ?? ymd(new Date(Date.now() - 29 * 864e5));
  return from <= to ? { from, to } : { from: to, to: from };
}

export async function getSeoData(fromRaw?: string, toRaw?: string): Promise<SeoData> {
  const { from, to } = seoRange(fromRaw, toRaw);
  const cfg = await getSeoConfig();
  const [traffic, gsc, leads] = await Promise.all([
    getSeoTraffic(from, to),
    getGscMetrics(from, to, cfg.keywords),
    getLeadsData(from, to),
  ]);
  return { from, to, label: `${from} → ${to}`, keywords: cfg.keywords, traffic, gsc, leads };
}
