import type { Metadata } from "next";
import WebsiteAnalytics from "@/components/WebsiteAnalytics";
import { getWebMetrics } from "@/lib/posthog";

export const metadata: Metadata = {
  title: "Website — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export default async function WebsitePage() {
  const initial = await getWebMetrics(30);
  return <WebsiteAnalytics initial={initial} />;
}
