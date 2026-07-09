import type { Metadata } from "next";
import SeoDashboard from "@/components/SeoDashboard";
import { getSeoData } from "@/lib/seo";

export const metadata: Metadata = {
  title: "SEO & AIO — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export default async function SeoPage() {
  const initial = await getSeoData();
  return <SeoDashboard initial={initial} />;
}
