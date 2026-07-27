import type { Metadata } from "next";
import CompanyPerformance from "@/components/CompanyPerformance";
import { getCompanyData } from "@/lib/company";

export const metadata: Metadata = {
  title: "Company Performance — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";
export const maxDuration = 45;

export default async function CompanyPage() {
  const initial = await getCompanyData();
  return <CompanyPerformance initial={initial} />;
}
