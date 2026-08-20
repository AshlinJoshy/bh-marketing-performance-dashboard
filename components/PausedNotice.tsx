// Shown wherever Supermetrics figures would be, while an admin has it switched
// off. Its job is to stop "off" looking like "broken" — an empty chart with no
// explanation is the thing that generates the support message.
import { C } from "@/lib/theme";

export default function PausedNotice({ note, what }: { note?: string; what: string }) {
  return (
    <div className="chart-card" style={{ marginBottom: 18, borderColor: C.amber, background: "#fffdf7" }}>
      <div style={{ fontSize: 13, lineHeight: 1.6 }}>
        <strong>Supermetrics is switched off.</strong> {what} An admin paused it in Settings, so no API rows are
        being spent. Everything not sourced from Supermetrics is unaffected and still live.
        {note ? (
          <>
            <br />
            <span style={{ color: C.mid }}>Reason given: {note}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}
