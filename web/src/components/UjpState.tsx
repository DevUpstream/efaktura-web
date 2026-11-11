import type { InvoiceRow } from "../api";

/** Status kon UJP: ceka / ✓ EUID / greska (isto kako vo Power Apps). */
export function UjpState({ r }: { r: Pick<InvoiceRow, "status" | "ujpId" | "ujpError" | "ujpStatusName"> & { source?: string } }) {
  if (r.status === "draft" || r.status === "cancelled_draft" || r.status === "to_issue") return <span className="muted">–</span>;
  // prenesena od ERPNext: izdadena nadvor od e-Faktura, ne se prakja (docs/11)
  if (r.source === "erpnext") return <span className="muted small" title="Пренесена од ERPNext: издадена надвор од е-Фактура">не се праќа</span>;
  if (r.ujpId) return <span className="chip ok" title={r.ujpStatusName ?? undefined}>✓ {r.ujpId}</span>;
  if (r.ujpError) return <span className="chip err" title={r.ujpError}>грешка</span>;
  return <span className="chip wait">чека</span>;
}
