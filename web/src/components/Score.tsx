import { useEffect, useState } from "react";
import { api } from "../api";

export interface PartnerScore { partnerId: number; grade: "A" | "B" | "V" | "G" | "-"; avgDaysLate: number | null; paidCount: number; lateShare: number | null;
  open: string; overdue: string; maxDaysOverdue: number; trend: "better" | "worse" | "same" | null; creditLimit: string | null; limitUsed: number | null; warnings: string[] }

export const GRADE: Record<string, { label: string; cls: string; text: string }> = {
  A: { label: "А", cls: "ok", text: "плаќа навреме" }, B: { label: "Б", cls: "ok", text: "мало задоцнување" },
  V: { label: "В", cls: "wait", text: "често задоцнува" }, G: { label: "Г", cls: "err", text: "ризик: многу задоцнува" }, "-": { label: "–", cls: "", text: "нема историја" },
};
export function GradeChip({ s }: { s: PartnerScore | undefined }) {
  if (!s) return <span className="muted">–</span>;
  const g = GRADE[s.grade]!;
  return <span className={`chip grade ${g.cls}`} title={`${g.text}${s.avgDaysLate !== null ? `, просечно ${s.avgDaysLate} дена по рокот` : ""}`}>{g.label}</span>;
}

/** Bizнис мрежа нема јавна адреса за пребарување по ЕДБ: копираме ЕДБ и ја отвораме страницата (секој со своја сметка). */
export function BiznisMrezaButton({ edb, name }: { edb: string | null; name: string }) {
  const [copied, setCopied] = useState(false);
  async function open() {
    const v = edb ?? name;
    try { await navigator.clipboard.writeText(v); setCopied(true); setTimeout(() => setCopied(false), 4000); } catch { /* без дозвола за clipboard */ }
    window.open("https://biznismreza.mk/", "_blank", "noopener,noreferrer");
  }
  return <button className="btn" onClick={open} title="Се отвора Бизнис мрежа во нов таб (со вашата сметка). ЕДБ-то се копира: залепете го во пребарувањето.">
    {copied ? `ЕДБ ${edb ?? ""} е копиран` : "Провери во Бизнис мрежа"}</button>;
}

/** Predupreduvanje pri faktura: zadocnet dolg, nadminat limit, ocenka G. */
export function useScore(clientId: number, partnerId: number | "" | null, extra: number, enabled: boolean) {
  const [s, setS] = useState<PartnerScore | null>(null);
  useEffect(() => {
    if (!enabled || !partnerId) { setS(null); return; }
    const h = setTimeout(() => api.get<PartnerScore>(`/api/clients/${clientId}/partners/${partnerId}/score?extra=${Math.max(0, Math.round(extra))}`).then(setS, () => setS(null)), 400);
    return () => clearTimeout(h);
  }, [clientId, partnerId, Math.round(extra), enabled]);
  return s;
}
