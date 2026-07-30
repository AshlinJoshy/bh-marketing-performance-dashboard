import type { Metadata } from "next";
import CeoDashboard from "@/components/CeoDashboard";

export const metadata: Metadata = {
  title: "Dashboard — betterhomes Marketing Hub",
};

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <>
      <div className="page-title">Dashboard</div>
      <div className="page-sub">Commercial and marketing performance at a glance — every figure links to its tab.</div>
      <CeoDashboard />
    </>
  );
}
