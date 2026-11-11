/**
 * Ednostavni dokumenti vo PDF (docs/12): ispratnica, IOS, izjava za kompenzacija, opomena.
 * Ist font i zaglavje kako fakturata (kratok naziv, adresa, EDB, ziro-smetki), A4, poveke strani.
 */
import PDFDocument from "pdfkit";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { clients, PdfSettings } from "../db/schema.js";

type Client = typeof clients.$inferSelect;
const here = dirname(fileURLToPath(import.meta.url));
const fontDir = [join(here, "../../assets/fonts"), join(here, "../assets/fonts"), "/app/assets/fonts"].find((d) => existsSync(d))!;
const F = { r: join(fontDir, "OpenSans_400Regular.ttf"), b: join(fontDir, "OpenSans_700Bold.ttf"), x: join(fontDir, "OpenSans_800ExtraBold.ttf") };

const nf2 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfQ = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 3 });
export const m2 = (v: string | number | null | undefined) => nf2.format(Number(v ?? 0));
export const q3 = (v: string | number | null | undefined) => nfQ.format(Number(v ?? 0));
export const day = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "");

export interface Party { name: string; edb?: string | null; address?: string | null; city?: string | null }
export interface Col { title: string; width: number; align?: "left" | "right" }
export interface SimpleDoc {
  client: Client; title: string; number?: string | null; date: string; partner?: Party | null; partnerLabel?: string;
  /** dopolnitelni redovi desno pod datumot ("Магацин: Главен") */
  meta?: [string, string][];
  intro?: string[];                     // pasusi pred tabelata
  sections: { heading?: string; cols: Col[]; rows: string[][]; total?: string[] }[];
  outro?: string[];                     // pasusi po tabelata
  signatures?: string[];                // potpisi na dnoto ("Издал", "Примил")
}

const L = 36, R = 559, W = R - L;

export async function renderSimpleDoc(d: SimpleDoc): Promise<Buffer> {
  const ps: PdfSettings = d.client.pdfSettings ?? {};
  const doc = new PDFDocument({ size: "A4", margin: 0, bufferPages: true, info: { Title: `${d.title} ${d.number ?? ""}`.trim(), Author: d.client.name, Creator: "е-Фактура" } });
  doc.registerFont("r", F.r).registerFont("b", F.b).registerFont("x", F.x);
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));
  const text = (t: string, x: number, y: number, o: { font?: string; size?: number; width?: number; align?: "left" | "right" | "center" } = {}) => {
    doc.font(o.font ?? "r").fontSize(o.size ?? 9).fillColor("#000").text(t, x, y, { width: o.width, align: o.align ?? "left" });
    return doc.y;
  };

  // --- zaglavje: nasha firma levo, naslov desno
  let y = 34;
  y = text(ps.shortName || d.client.name, L, y, { font: "x", size: 16, width: 280 });
  const addr = ps.addressLines?.length ? ps.addressLines.map((a) => a.replace(/\*\*/g, "")) : [[d.client.address, [d.client.postalCode, d.client.city].filter(Boolean).join(" ")].filter(Boolean).join(", ")];
  for (const a of addr) y = text(a, L, y, { size: 8, width: 280 });
  y = text([d.client.embs && `ЕМБС: ${d.client.embs}`, `ЕДБ: ${d.client.vatNumber || d.client.edb}`].filter(Boolean).join(" | "), L, y, { size: 8, width: 280 });
  const banks = ps.bankAccounts?.length ? ps.bankAccounts : d.client.iban ? [{ account: d.client.iban, bank: d.client.bankName ?? "" }] : [];
  for (const b of banks) y = text(`Ж-ска: ${b.account}${b.bank ? ` – ${b.bank}` : ""}`, L, y, { size: 8, width: 280 });
  let ry = text(d.title, 330, 34, { font: "b", size: d.title.length > 24 ? 13 : 16, width: R - 330 });
  if (d.number) ry = text(`број: ${d.number}`, 330, ry + 2, { font: "b", size: 11, width: R - 330 });
  ry = text(`датум: ${day(d.date)}`, 330, ry + 2, { size: 10, width: R - 330 });
  for (const [k, v] of d.meta ?? []) ry = text(`${k}: ${v}`, 330, ry + 1, { size: 9, width: R - 330 });
  y = Math.max(y, ry) + 14;

  if (d.partner) {
    doc.rect(L, y, W, 0.6).fill("#000");
    y = text(d.partnerLabel ?? "Партнер", L, y + 5, { size: 8 });
    y = text(d.partner.name, L, y, { font: "b", size: 11, width: W });
    const pl = [[d.partner.address, d.partner.city].filter(Boolean).join(", "), d.partner.edb ? `ЕДБ: ${d.partner.edb}` : ""].filter(Boolean).join(" | ");
    if (pl) y = text(pl, L, y, { size: 9, width: W });
    y += 10;
  }
  for (const p of d.intro ?? []) y = text(p, L, y, { size: 9.5, width: W }) + 6;

  const newPageIfNeeded = (need: number) => { if (y + need > 790) { doc.addPage(); y = 40; } };
  for (const s of d.sections) {
    newPageIfNeeded(60);
    if (s.heading) y = text(s.heading, L, y + 4, { font: "b", size: 10, width: W }) + 3;
    const scale = W / s.cols.reduce((a, c) => a + c.width, 0);
    const xs: number[] = []; let x = L;
    for (const c of s.cols) { xs.push(x); x += c.width * scale; }
    const row = (cells: string[], font: string, fill?: string) => {
      const hs = cells.map((c, i) => doc.font(font).fontSize(8.5).heightOfString(c ?? "", { width: s.cols[i]!.width * scale - 6 }));
      const h = Math.max(...hs) + 6;
      newPageIfNeeded(h);
      if (fill) doc.rect(L, y, W, h).fill(fill);
      cells.forEach((c, i) => doc.font(font).fontSize(8.5).fillColor("#000")
        .text(c ?? "", xs[i]! + 3, y + 3, { width: s.cols[i]!.width * scale - 6, align: s.cols[i]!.align ?? "left" }));
      y += h;
      doc.rect(L, y, W, 0.3).fill("#999");
    };
    row(s.cols.map((c) => c.title), "b", "#eeeeee");
    for (const r of s.rows) row(r, "r");
    if (s.total) row(s.total, "b", "#f5f5f5");
    y += 10;
  }
  for (const p of d.outro ?? []) { newPageIfNeeded(40); y = text(p, L, y, { size: 9.5, width: W }) + 6; }

  if (d.signatures?.length) {
    newPageIfNeeded(80);
    y = Math.max(y + 30, 700);
    const w = W / d.signatures.length;
    d.signatures.forEach((s, i) => {
      doc.rect(L + i * w + 10, y + 30, w - 20, 0.6).fill("#000");
      text(s, L + i * w + 10, y + 34, { size: 8.5, width: w - 20, align: "center" });
    });
  }
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
    text(`${d.client.name} · ${d.title}${d.number ? ` ${d.number}` : ""} · страна ${i + 1} од ${pages.count}`, L, 815, { size: 7, width: W, align: "center" });
  }
  doc.end();
  return done;
}
