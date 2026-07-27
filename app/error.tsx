"use client";

// Catch-all route error boundary. Any tab WITHOUT its own error.tsx falls back to
// this one, so a throw during a server render shows a readable message and a
// retry instead of a blank screen. /company and /seo override it with their own
// named versions.
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <>
      <div className="section-header">
        <div>
          <div className="page-title">Something went wrong</div>
          <div className="page-sub">This tab couldn&apos;t load.</div>
        </div>
      </div>
      <div className="chart-card">
        <div className="empty-state" style={{ height: "auto", padding: "30px 20px", display: "block", textAlign: "center" }}>
          <div style={{ fontWeight: 600, color: "var(--dark)", marginBottom: 8 }}>Couldn&apos;t load this tab</div>
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
