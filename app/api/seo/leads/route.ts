// Metabase leads for the SEO tab — a SEPARATE endpoint from /api/seo so the slow
// CRM view can't stall or kill the fast PostHog/GSC queries.
import { getSeoLeads } from "@/lib/seo";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from") || undefined;
  const to = searchParams.get("to") || undefined;
  // The source audit is a second full scan of a slow view, so it's opt-in —
  // requested only when the table is opened.
  const audit = searchParams.get("audit") === "1";
  try {
    const data = await getSeoLeads(from, to, audit);
    return Response.json(data);
  } catch (e) {
    console.error(`[api/seo/leads] ${e instanceof Error ? e.message : String(e)}`);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
