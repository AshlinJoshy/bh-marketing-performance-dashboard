"use client";

// Route-level error boundary for /seo — if the server render throws, show a
// readable message + retry instead of a blank screen.
export default function SeoError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <>
      <div className="section-header">
        <div>
          <div className="page-title">SEO &amp; AIO</div>
          <div className="page-sub">Something went wrong loading this tab.</div>
        </div>
      </div>
      <div className="chart-card">
        <div className="empty-state" style={{ height: "auto", padding: "30px 20px", display: "block", textAlign: "center" }}>
          <div style={{ fontWeight: 600, color: "var(--dark)", marginBottom: 8 }}>Couldn&apos;t load the SEO tab</div>
          <div style={{ fontSize: 12, color: "var(--mid)", marginBottom: 14, wordBreak: "break-word" }}>
            {error?.message || "Unexpected error."}
            {error?.digest ? ` (ref ${error.digest})` : ""}
          </div>
          <button className="filter-btn" onClick={() => reset()}>Try again</button>
        </div>
      </div>
    </>
  );
}
