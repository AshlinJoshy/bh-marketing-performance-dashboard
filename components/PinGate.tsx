"use client";

// The PIN prompt. Nothing here knows the PIN — it posts to /api/unlock, which
// compares it server side and sets an httpOnly cookie.
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { C } from "@/lib/theme";

export default function PinGate() {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const params = useSearchParams();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !pin) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (!res.ok) {
        setErr("Incorrect PIN.");
        setPin("");
        return;
      }
      // A full navigation, not router.push: the gate cookie was just set and the
      // pages are server rendered, so they need a fresh request to see it.
      const next = params.get("next");
      window.location.href = next && next.startsWith("/") ? next : "/";
    } catch {
      setErr("Couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "70vh" }}>
      <form onSubmit={submit} className="chart-card" style={{ width: 320, textAlign: "center" }}>
        <div style={{ fontFamily: "Georgia, serif", fontSize: 20, fontWeight: 700, marginBottom: 4 }}>betterhomes</div>
        <div style={{ fontSize: 12, color: C.mid, marginBottom: 18 }}>Marketing Hub</div>

        <label htmlFor="pin" style={{ display: "block", fontSize: 11, textTransform: "uppercase", letterSpacing: ".5px", color: C.mid, marginBottom: 6 }}>
          Enter PIN
        </label>
        <input
          id="pin"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          aria-invalid={!!err}
          style={{
            width: "100%",
            padding: "10px 12px",
            fontSize: 20,
            letterSpacing: "0.4em",
            textAlign: "center",
            border: `1px solid ${err ? C.red : "var(--border)"}`,
            borderRadius: 6,
            outline: "none",
          }}
        />
        <button className="filter-btn" type="submit" disabled={busy || !pin} style={{ width: "100%", marginTop: 12 }}>
          {busy ? "Checking…" : "Unlock"}
        </button>
        {err && <div style={{ color: C.red, fontSize: 12, marginTop: 10 }}>{err}</div>}
        <div style={{ fontSize: 11, color: C.mid, marginTop: 14, lineHeight: 1.5 }}>
          Data is only fetched after unlocking, so an idle tab costs no API quota.
        </div>
      </form>
    </div>
  );
}
