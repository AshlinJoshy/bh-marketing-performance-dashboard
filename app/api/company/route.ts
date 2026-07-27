// Company Performance data — refetched client-side when filters change.
import { getCompanyData } from "@/lib/company";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from") || undefined;
  const to = searchParams.get("to") || undefined;
  const brands = (searchParams.get("brands") || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  try {
    const data = await getCompanyData(from, to, brands);
    return Response.json(data);
  } catch (e) {
    console.error(`[api/company] ${e instanceof Error ? e.message : String(e)}`);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
