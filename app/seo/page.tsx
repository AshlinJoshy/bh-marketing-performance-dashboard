import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "SEO — betterhomes Marketing Hub",
};

export default function SeoPage() {
  return (
    <>
      <div className="section-header">
        <div>
          <div className="page-title">SEO</div>
          <div className="page-sub">Search performance — keyword rankings, backlinks &amp; SERP visibility</div>
        </div>
      </div>
      <div className="chart-card">
        <div className="empty-state" style={{ height: 240 }}>
          Nothing here yet — SEO tracking is coming soon.
        </div>
      </div>
    </>
  );
}
