// Combined SEO metrics endpoint the SEO tab polls (PostHog + GSC + Metabase).
import { getSeoData } from "@/lib/seo";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from") || undefined;
  const to = searchParams.get("to") || undefined;
  const data = await getSeoData(from, to);
  return Response.json(data);
}
