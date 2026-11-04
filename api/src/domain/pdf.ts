/**
 * PDF na faktura - format na UPSTREAM fakturata (Фактура-Испратница 2026/10/11), A4.
 * Zaglavjeto i podnozjeto doagjaat od clients.pdf_settings; ako nedostasuvaat, se koristat osnovnite podatoci za klientot.
 * Iznosite: makedonski format 1.234,56 (isto kako vo aplikacijata).
 */
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { clients, invoiceLines, invoices, PdfSettings } from "../db/schema.js";
import { calcTotals } from "./calc.js";

type Client = typeof clients.$inferSelect;
type Inv = typeof invoices.$inferSelect;
type Line = typeof invoiceLines.$inferSelect;

/* ------------------------------------------------------------------ fontovi */
const here = dirname(fileURLToPath(import.meta.url));
const fontDir = [join(here, "../../assets/fonts"), join(here, "../assets/fonts"), "/app/assets/fonts"].find((d) => existsSync(d))!;
const F = {
  r: join(fontDir, "OpenSans_400Regular.ttf"), s: join(fontDir, "OpenSans_600SemiBold.ttf"),
  b: join(fontDir, "OpenSans_700Bold.ttf"), x: join(fontDir, "OpenSans_800ExtraBold.ttf"),
};

/* ---------------------------------------------------------------- formati */
const nf2 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfP = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const nfQ = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 3 });
const m2 = (v: string | number | null | undefined) => nf2.format(Number(v ?? 0));
/** "За плаќање": секогаш цели денари, без децимали. */
const m0 = (v: string | number | null | undefined) => new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(Math.round(Number(v ?? 0)));
const day = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "");

const TITLE: Record<Inv["docType"], string> = { INV: "Фактура", AV: "Авансна фактура", OD: "Книжно одобрение",
  KZ: "Книжно задолжување", ST: "Сторно фактура", KR: "Корекција на фактура" };

export interface PdfInput { inv: Inv; lines: Line[]; client: Client; relatedNumber?: string | null; relatedDate?: string | null;
  advanceNumber?: string | null; itemCodes?: Record<number, string> }

/* ------------------------------------------------------------------ crtanje */
const PAGE = { w: 595.28, h: 841.89, l: 28, r: 567 };
const INK = "#000000", GREY = "#555555", RULE = "#000000";

export async function renderInvoicePdf(d: PdfInput): Promise<Buffer> {
  const { inv, client } = d;
  const ps: PdfSettings = client.pdfSettings ?? {};
  const lines = [...d.lines].sort((a, b) => a.lineNo - b.lineNo);
  const totals = calcTotals(lines.map((l) => ({ ...l, unitNet: "0" })), inv.advanceAmount ?? 0);
  const rates = [...totals.byRate].sort((a, b) => Number(a.vatRatePct) - Number(b.vatRatePct));   // 5% pred 18% (kako vo primerot)
  const qr = inv.ujpQrLink ? await QRCode.toBuffer(inv.ujpQrLink, { margin: 0, width: 220 }) : null;

  const doc = new PDFDocument({ size: "A4", margin: 0, bufferPages: true, info: {
    Title: `${TITLE[inv.docType]} ${inv.number ?? "(нацрт)"}`, Author: client.name, Creator: "е-Фактура" } });
  doc.registerFont("r", F.r).registerFont("s", F.s).registerFont("b", F.b).registerFont("x", F.x);
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));

  const text = (t: string, x: number, y: number, o: { font?: string; size?: number; width?: number; align?: "left" | "right" | "center"; color?: string } = {}) => {
    doc.font(o.font ?? "r").fontSize(o.size ?? 9).fillColor(o.color ?? INK)
      .text(t, x, y, { width: o.width, align: o.align ?? "left", lineGap: 0 });
    return doc.y;
  };
  /** "**del**" = zadebeleno; ostatokot obicno. */
  const rich = (t: string, x: number, y: number, size: number, width: number) => {
    const bold = /^\*\*(.*)\*\*$/.exec(t.trim());
    return text(bold ? bold[1]! : t, x, y, { font: bold ? "b" : "r", size, width });
  };

  /* ---------------------------------------------------- zaglavje: levo */
  const LW = 300;
  let y = 30;
  if (ps.tagline) y = text(ps.tagline, PAGE.l, y, { font: "b", size: 10.5, width: LW });
  y = text(ps.shortName || client.name, PAGE.l, y - 2, { font: "x", size: ps.shortName && ps.shortName.length <= 16 ? 30 : 18, width: LW });
  if (ps.subtitle) y = text(ps.subtitle, PAGE.l, y - 3, { font: "b", size: 9.5, width: LW });
  y += 8;
  if (ps.contactLine) y = text(ps.contactLine, PAGE.l, y, { size: 7.5, width: LW });
  const addr = ps.addressLines?.length ? ps.addressLines : [[client.address, [client.postalCode, client.city].filter(Boolean).join(" ")].filter(Boolean).join(", ")];
  for (const a of addr) y = rich(a, PAGE.l, y, 7.5, LW);
  const ids = [client.embs && `ЕМБС: ${client.embs}`, `ЕДБ: ${client.vatNumber || client.edb}`].filter(Boolean).join(" | ");
  y = text(ids, PAGE.l, y, { size: 7.5, width: LW });
  const banks = ps.bankAccounts?.length ? ps.bankAccounts : client.iban ? [{ account: client.iban, bank: client.bankName ?? "" }] : [];
  if (banks.length) {
    y = text("ЖИРО СМЕТКИ:", PAGE.l, y + 9, { font: "b", size: 8.5 }) + 8;
    for (const b of banks) {
      text(b.account, PAGE.l, y, { font: "b", size: 11 });
      y = text(b.bank ? `- ${b.bank}` : "", PAGE.l + 140, y, { size: 10.5, width: 330 - PAGE.l - 140 - 2 }) + 8;
    }
  }
  const leftBottom = y;

  /* --------------------------------------------------- zaglavje: desno */
  const RX = 330, RW = PAGE.r - RX;
  const title = inv.docType === "INV" ? ps.invoiceTitle || "Фактура" : TITLE[inv.docType];
  let ry = text(title, RX, 30, { font: "b", size: title.length > 20 ? 15 : 18.5, width: RW });
  doc.font("r").fontSize(17).fillColor(INK).text("број: ", RX, ry, { continued: true }).font("b").text(inv.number ?? "НАЦРТ");
  ry = doc.y + 6;
  const kv = (k: string, v: string) => {
    doc.font("r").fontSize(11.5).fillColor(INK).text(`${k}: `, RX, ry, { continued: true }).font("b").text(v);
    ry = doc.y;
  };
  kv("Датум", day(inv.issueDate));
  if (inv.supplyDate && inv.supplyDate !== inv.issueDate) kv("Датум на промет", day(inv.supplyDate));
  if (inv.docType === "AV") kv("Датум на авансно плаќање", day(inv.issueDate));
  if (inv.dueDate) kv("Рок за плаќање", day(inv.dueDate));
  if (d.relatedNumber) ry = text(`по фактура бр. ${d.relatedNumber}${d.relatedDate ? ` од ${day(d.relatedDate)}` : ""}`, RX, ry + 2, { size: 9.5, width: RW });
  ry += 14;
  ry = text("Купувач:", RX + 6, ry, { font: "b", size: 12 });
  const buyer = [inv.buyerName, [inv.buyerAddress, inv.buyerCity].filter(Boolean).join(", "),
    inv.buyerCountry && inv.buyerCountry !== "MK" ? inv.buyerCountry : "Р. С. Македонија",
    inv.buyerEdb && `ЕДБ: ${inv.buyerEdb}`, inv.buyerVatNumber && `ДДВ број: ${inv.buyerVatNumber}`].filter((x): x is string => !!x);
  for (const b of buyer) ry = text(b, RX + 6, ry, { size: 11.5, width: RW - 6 });

  /* -------------------------------------------------------------- tabela */
  const hasDisc = lines.some((l) => Number(l.discountPct) > 0);
  type Col = { k: string; t: string; w: number; a: "left" | "right" | "center" };
  const cols: Col[] = [
    { k: "no", t: "РБ", w: 20, a: "left" }, { k: "code", t: "Код", w: 44, a: "left" }, { k: "desc", t: "Опис", w: 0, a: "left" },
    { k: "unit", t: "Ед. мерка", w: 30, a: "center" }, { k: "qty", t: "Кол", w: 34, a: "right" },
    { k: "price", t: "Единечна цена", w: 46, a: "right" },
    ...(hasDisc ? [{ k: "disc", t: "Попуст %", w: 30, a: "right" as const }] : []),
    { k: "net", t: "Единечна цена x Количина", w: 50, a: "right" }, { k: "vatp", t: "ДДВ %", w: 22, a: "center" },
    { k: "vat", t: "Износ ДДВ", w: 42, a: "right" }, { k: "gross", t: "Вкупно со ДДВ", w: 52, a: "right" },
  ];
  const fixed = cols.reduce((s, c) => s + c.w, 0);
  cols.find((c) => c.k === "desc")!.w = PAGE.r - PAGE.l - fixed;
  const xs: number[] = []; cols.reduce((x, c) => (xs.push(x), x + c.w), PAGE.l);

  const head = (y0: number) => {
    doc.font("b").fontSize(6.3);
    const hs = cols.map((c) => doc.heightOfString(c.t, { width: c.w - 2, align: "center" }));
    const H = Math.max(22, ...hs);
    cols.forEach((c, i) => text(c.t, xs[i]! + 1, y0 + (H - hs[i]!) / 2, { font: "b", size: 6.3, width: c.w - 2, align: "center" }));
    const yb = y0 + H + 3;
    doc.moveTo(PAGE.l, yb).lineTo(PAGE.r, yb).lineWidth(0.8).strokeColor(RULE).stroke();
    return yb + 3;
  };

  let ty = head(Math.max(leftBottom, ry) + 22);
  const LIMIT = 395;   // posle ova odi na nova strana (podnozjeto bara prostor)
  const qtyAbs = (l: Line) => nfQ.format(Number(l.qty));
  lines.forEach((l, i) => {
    const net = Number(l.netAmount), vat = Number(l.vatAmount);
    const cells: Record<string, string> = {
      no: String(i + 1), code: l.itemId ? d.itemCodes?.[l.itemId] ?? "" : "", desc: l.description, unit: l.unit, qty: qtyAbs(l), price: nfP.format(Number(l.unitPrice)),
      disc: Number(l.discountPct) ? nfQ.format(Number(l.discountPct)) : "", net: m2(net), vatp: nfQ.format(Number(l.vatRatePct)),
      vat: m2(vat), gross: m2(Math.round((net + vat) * 100) / 100),
    };
    doc.font("r").fontSize(8);
    const h = Math.max(11, doc.heightOfString(cells.desc!, { width: cols.find((c) => c.k === "desc")!.w - 4 }));
    if (ty + h > LIMIT && i > 0) { doc.addPage(); ty = head(40); }
    cols.forEach((c, k) => text(cells[c.k] ?? "", xs[k]! + 2, ty, { size: c.k === "unit" ? 7 : 8, width: c.w - 4, align: c.a }));
    ty += h + 1.5;
  });
  ty = Math.max(ty + 18, 405);   // kako vo primerot: linijata e na ~ polovina strana
  if (ty > LIMIT + 40) { doc.addPage(); ty = 60; }
  doc.moveTo(PAGE.l, ty).lineTo(PAGE.l + 400, ty).lineWidth(0.8).strokeColor(RULE).stroke();
  text("Заклучно со Реден број:", PAGE.l + 230, ty + 3, { font: "b", size: 8.5 });
  text(String(lines.length), PAGE.l + 345, ty + 3, { font: "b", size: 9.5 });

  /* ----------------------------------------------- rekapitulacija i vkupno */
  let y2 = ty + 30;
  const RL = PAGE.l + 32, c1 = RL + 8, c2 = RL + 170, c3 = RL + 290;
  text("Рекапитулација по ДДВ стапки", RL, y2, { font: "b", size: 8.5 });
  y2 += 11;
  doc.moveTo(RL, y2).lineTo(c3 + 50, y2).lineWidth(0.6).stroke();
  text("ДДВ", c1, y2 + 1, { font: "b", size: 8.5, width: 50 });
  text("Основица", c2 - 60, y2 + 1, { font: "b", size: 8.5, width: 100, align: "right" });
  text("ДДВ Износ", c3 - 60, y2 + 1, { font: "b", size: 8.5, width: 110, align: "right" });
  y2 += 12;
  for (const g of rates) {
    text(`${nfQ.format(Number(g.vatRatePct))}%`, c1 + 8, y2, { size: 8.5, width: 40 });
    text(`${m2(g.net)} ден.`, c2 - 60, y2, { size: 8.5, width: 100, align: "right" });
    text(`${m2(g.vat)} ден.`, c3 - 60, y2, { size: 8.5, width: 110, align: "right" });
    y2 += 11;
  }
  doc.moveTo(RL, y2).lineTo(c3 + 50, y2).lineWidth(0.6).stroke();
  text("Вкупно:", RL + 8, y2 + 1, { font: "b", size: 8.5 });
  text(`${m2(totals.netTotal)} ден.`, c2 - 60, y2 + 1, { font: "b", size: 8.5, width: 100, align: "right" });
  text(`${m2(totals.vatTotal)} ден.`, c3 - 60, y2 + 1, { font: "b", size: 8.5, width: 110, align: "right" });

  // desno: blok so vkupno (istaknato)
  const BX = 430, BW = PAGE.r - BX;
  let by = ty + 52;
  const row = (k: string, v: string, big = false) => {
    text(k, BX, by + (big ? 0 : 1.5), { font: "b", size: big ? 9 : 7, width: 70, align: "right" });
    text(v, BX + 72, by, { font: "b", size: big ? 10 : 9.5, width: BW - 72, align: "right" });
    by += big ? 13 : 11;
  };
  row("Износ без ДДВ:", m2(totals.netTotal));
  for (const g of rates) row(`ДДВ ${nfQ.format(Number(g.vatRatePct))}%:`, m2(g.vat));
  if (inv.advanceAmount && Number(inv.advanceAmount) > 0) {
    row("Вкупно со ДДВ:", m2(totals.grossTotal));
    row(`Аванс${d.advanceNumber ? ` ${d.advanceNumber}` : ""}:`, `-${m2(inv.advanceAmount)}`);
  }
  doc.moveTo(BX + 10, by).lineTo(PAGE.r, by).lineWidth(0.6).stroke();
  text("За плаќање вкупно:", BX, by + 2, { font: "b", size: 9, width: BW, align: "right" });
  text(`${m0(totals.payableAmount)} ден.`, BX - 40, by + 15, { font: "b", size: 12.5, width: BW + 40, align: "right" });

  /* ------------------------------------------------- klauzuli i potpisi */
  let cy = Math.max(y2 + 28, by + 40);
  if (cy > 700) { doc.addPage(); cy = 50; }
  const CW = 330;
  if (ps.paymentNote) cy = text(ps.paymentNote, PAGE.l + 20, cy, { font: "b", size: 7.3, width: CW }) + 9;
  if (ps.clausesTitle) cy = text(ps.clausesTitle, PAGE.l + 20, cy, { font: "b", size: 7.3, width: CW }) + 9;
  const clauses = (inv.clauses ?? client.invoiceClauses ?? "").split(/\r?\n/).filter((x) => x.trim());
  for (const c of clauses) cy = text(c, PAGE.l + 20, cy, { size: 7.3, width: CW });
  if (inv.note) cy = text(`Забелешка: ${inv.note}`, PAGE.l + 20, cy + 6, { size: 7.3, width: CW });
  if (inv.correctionReason && ["OD", "KZ", "ST", "KR"].includes(inv.docType))
    cy = text(`Причина: ${[inv.voidReasonCode, inv.correctionReasonCode].filter(Boolean).join(" ")} ${inv.correctionReason}`.replace(/\s+/g, " "),
      PAGE.l + 20, cy + 6, { size: 7.3, width: CW });

  const SX = 400, BOTTOM = PAGE.h - 34;
  let sy = Math.max(y2 + 85, by + 75);
  sy = text("Лице овластено за потпишување на фактури:", SX, sy, { size: 8.5, width: PAGE.r - SX });
  if (ps.signatory) sy = text(ps.signatory, SX, sy, { font: "b", size: 8.5, width: PAGE.r - SX });
  sy += 56;   // prostor za potpis
  if (ps.showReceivedBy !== false) {
    text("Примил (Име и Презиме, Потпис):", SX, sy, { size: 8.5, width: PAGE.r - SX });
    sy += 46;
  }
  if (ps.receiverDeclaration) {
    doc.font("r").fontSize(7.3);
    const h = doc.heightOfString(ps.receiverDeclaration, { width: PAGE.r - 345 });
    const dy = Math.min(sy + 8, BOTTOM - h);   // pod "Примил", kako vo primerot, bez nova strana
    text(ps.receiverDeclaration, 345, dy, { size: 7.3, width: PAGE.r - 345 });
  }

  /* ---------------------------------------------------------- UJP, nacrt */
  if (qr) {
    // pod klauzulite; ako nema mesto - desno vo prazniot del od tabelata
    const fits = cy + 12 + 62 <= BOTTOM;
    const qx = fits ? PAGE.l + 20 : PAGE.r - 62, qy = fits ? cy + 12 : ty - 70;
    doc.image(qr, qx, qy, { width: 62 });
    text(`е-Фактура УЈП\nEUID: ${inv.ujpId ?? ""}`, fits ? qx + 68 : qx - 150, qy + 20, { size: 7, color: GREY, width: 145, align: fits ? "left" : "right" });
  }
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
    if (!inv.number) {
      doc.save().rotate(-35, { origin: [PAGE.w / 2, PAGE.h / 2] }).font("x").fontSize(110).fillColor("#000000").fillOpacity(0.06)
        .text("НАЦРТ", 0, PAGE.h / 2 - 60, { width: PAGE.w, align: "center" }).restore().fillOpacity(1);
    }
    if (pages.count > 1) text(`Страна ${i + 1} од ${pages.count}`, PAGE.l, PAGE.h - 20, { size: 7, color: GREY, width: PAGE.r - PAGE.l, align: "right" });
  }
  doc.end();
  return done;
}
