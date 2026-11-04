import type { InvoiceRow } from "../api";

/** Status kon UJP: ceka / ✓ EUID / greska (isto kako vo Power Apps). */
export function UjpState({ r }: { r: Pick<InvoiceRow, "status" | "ujpId" | "ujpError" | "ujpStatusName"> }) {
  if (r.status === "draft" || r.status === "cancelled_draft" || r.status === "to_issue") return <span className="muted">–</span>;
  if (r.ujpId) return <span className="chip ok" title={r.ujpStatusName ?? undefined}>✓ {r.ujpId}</span>;
  if (r.ujpError) return <span className="chip err" title={r.ujpError}>грешка</span>;
  return <span className="chip wait">чека</span>;
}
