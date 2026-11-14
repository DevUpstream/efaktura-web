/**
 * Izdavanje na faktura: proverki + broj + snimka na prodavac/kupuvac, se vo EDNA transakcija.
 * Zamena za tekot "eFaktura - Izdavanje v5". Brojot se dodeluva DURI pri izdavanje:
 *   {prefiks}[-{kod}]-{godina}-{00000}  npr. MC-2026-00001, MC-OD-2026-00003 (kod se izostava za INV).
 * Brojacot e atomski (INSERT ... ON CONFLICT DO UPDATE), a unikatniot indeks (klient, vid, godina, broj)
 * e dopolnitelna zastita - dupli broj e nevozmozen i pri paralelno izdavanje.
 */
import { and, eq, inArray, isNull, ne, sql, sum } from "drizzle-orm";
import { clients, counters, invoiceLines, invoices, items, partners, STOCK_ITEM_TYPES, stockDocs } from "../db/schema.js";
import { defaultWarehouse, postStockDoc, reverseStockDoc } from "./stock.js";
import type { Db } from "../db/types.js";
import { calcTotals, round } from "./calc.js";
import { calcFxTotals, rateDateProblem } from "./fx.js";
import { assertDispatchesFree } from "./dispatch.js";
import { missingCostCenter } from "./costcenters.js";
import { DomainError } from "./errors.js";
import { audit, type Actor } from "./audit.js";

type DocType = (typeof invoices.$inferSelect)["docType"];

export function formatInvoiceNumber(prefix: string, docType: DocType, year: number, seq: number) {
  return `${prefix}${docType === "INV" ? "" : `-${docType}`}-${year}-${String(seq).padStart(5, "0")}`;
}

const NEEDS_RELATED: DocType[] = ["OD", "KZ", "ST", "KR"];
const ISSUED_LIKE = ["issued", "json_exported", "sent_to_ujp"] as const;

export async function issueInvoice(db: Db, invoiceId: number, actor: Actor & { userId: number }, now = new Date()) {
  return db.transaction(async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
    if (!inv) throw new DomainError("not_found", "Фактурата не постои.", 404);
    if (inv.status !== "draft" && inv.status !== "to_issue")
      throw new DomainError("not_draft", `Фактурата е веќе со статус „${inv.status}“.`, 409);

    const errors: string[] = [];
    const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
    if (lines.length === 0) errors.push("Фактурата нема ставки.");
    if (Number(inv.issueDate.slice(0, 4)) !== inv.year) errors.push("Годината не одговара на датумот на издавање.");
    if (inv.docType !== "AV" && !inv.supplyDate) errors.push("Недостасува датум на промет.");
    if (inv.docType === "AV" && inv.supplyDate) errors.push("Авансна фактура нема датум на промет.");

    const [client] = await tx.select().from(clients).where(eq(clients.id, inv.clientId));
    const [partner] = await tx.select().from(partners).where(eq(partners.id, inv.partnerId));
    if (!client?.isActive) errors.push("Фирмата не е активна.");
    if (!partner?.isActive) errors.push("Купувачот не е активен.");
    if (inv.docType !== "PF") { const m = missingCostCenter(client!.costCenterMode, inv.costCenterId, lines); if (m) errors.push(m); }
    // ispratnici (docs/12): povtorna proverka pri izdavanje (nekoj mozel da ja stavi vo druga faktura vo megjuvreme)
    const docIds = [...new Set(lines.map((l) => l.stockDocId).filter((x): x is number => !!x))];
    if (docIds.length) {
      try { await assertDispatchesFree(tx as unknown as Db, inv.clientId, inv.partnerId, docIds, [inv.id, ...(inv.relatedInvoiceId ? [inv.relatedInvoiceId] : [])]); }
      catch (e) { errors.push((e as Error).message); }
    }

    // Povrzana faktura (storno, odobrenie, zadolzuvanje, korekcija)
    let related: typeof inv | undefined;
    if (NEEDS_RELATED.includes(inv.docType)) {
      if (!inv.relatedInvoiceId) errors.push("Недостасува поврзана фактура.");
      else {
        [related] = await tx.select().from(invoices).where(eq(invoices.id, inv.relatedInvoiceId)).for("update");
        if (related && (related.currency !== inv.currency || related.exchangeRate !== inv.exchangeRate))
          errors.push("Валутата и курсот мора да се исти како кај оригиналната фактура.");
        if (!related || related.clientId !== inv.clientId || !ISSUED_LIKE.includes(related.status as never)
            || !["INV", "KR"].includes(related.docType))
          errors.push("Поврзаната фактура не постои, не е издадена или е сторнирана.");
      }
      if (inv.docType === "ST" && !inv.voidReasonCode) errors.push("Недостасува шифра на причина за сторно.");
      if (inv.docType === "KR" && (!inv.correctionReasonCode || !inv.correctionReason?.trim()))
        errors.push("Корекција бара C-шифра и опис.");
    }

    // Devizna faktura (docs/16): dokumentot vo valutata, denari po kursot; proverkite na iznosite se vo valutata.
    const fx = inv.currency !== "MKD";
    const ft = fx ? calcFxTotals(lines.map((l) => ({ netAmount: l.fxNetAmount ?? "0", vatAmount: l.fxVatAmount ?? "0", unitNet: "0", vatRatePct: l.vatRatePct })), inv.exchangeRate) : null;
    if (fx) {
      if (lines.some((l) => l.fxNetAmount === null)) errors.push("Девизна фактура: ставките немаат износи во валута. Зачувајте го нацртот повторно.");
      if (inv.docType === "AV" || inv.advanceInvoiceId) errors.push("Аванс засега е само во денари (MKD).");
      if (!NEEDS_RELATED.includes(inv.docType)) { const p = rateDateProblem(inv.exchangeRateDate, inv.supplyDate ?? inv.issueDate); if (p) errors.push(p); }
    }

    // Pravila od tekot v5: znak na iznosot, pricina, storno tocno ja ponistuva fakturata, odobrenija <= faktura
    const totals = ft ? ft.mkd : calcTotals(lines.map((l) => ({ ...l, unitNet: "0" })), inv.advanceAmount ?? 0);
    const docTotal = (x: { grossTotal: string | null; fxGrossTotal: string | null }) => Number((fx ? x.fxGrossTotal : x.grossTotal) ?? 0);
    const gross = Number((ft ? ft.fx : totals).grossTotal);
    if (["OD", "ST"].includes(inv.docType) ? gross >= 0 : gross <= 0)
      errors.push(["OD", "ST"].includes(inv.docType) ? "Износот мора да е негативен (намалување)." : "Износот мора да е поголем од 0.");
    if (NEEDS_RELATED.includes(inv.docType) && !inv.correctionReason?.trim()) errors.push("Внесете причина.");
    if (related && (inv.docType === "OD" || inv.docType === "ST")) {
      const [od] = await tx.select({ s: sum(fx ? invoices.fxGrossTotal : invoices.grossTotal) }).from(invoices).where(and(
        eq(invoices.relatedInvoiceId, related.id), eq(invoices.docType, "OD"), ne(invoices.id, inv.id),
        inArray(invoices.status, [...ISSUED_LIKE])));
      const priorOd = Number(od?.s ?? 0);
      if (inv.docType === "OD" && docTotal(related) + priorOd + gross < -0.005)
        errors.push("Вкупните одобренија се поголеми од фактурата.");
      if (inv.docType === "ST") {
        if (priorOd < -0.001) errors.push("Фактурата има издадени книжни одобренија: наместо сторно направете книжно одобрение за остатокот.");
        else if (Math.abs(gross + docTotal(related)) > 0.005 || Math.abs(Number(totals.vatTotal) + Number(related.vatTotal)) > 0.005)
          errors.push("Сторното мора точно да ја поништи фактурата (ист износ со минус).");
      }
    }

    // Odbivanje avans (docs/04): samo INV/KR, ist kupuvac, izdadena avansna, najmnogu neiskoristeniot del
    if (inv.advanceInvoiceId) {
      const [adv] = await tx.select().from(invoices).where(eq(invoices.id, inv.advanceInvoiceId)).for("update");
      if (!["INV", "KR"].includes(inv.docType)) errors.push("Аванс се одбива само кај фактура или корекција.");
      if (!adv || adv.docType !== "AV" || !ISSUED_LIKE.includes(adv.status as never) || adv.partnerId !== inv.partnerId)
        errors.push("Авансната фактура не е издадена или е за друг купувач.");
      else {
        const [agg] = await tx.select({ used: sum(invoices.advanceAmount) }).from(invoices).where(and(
          eq(invoices.advanceInvoiceId, adv.id), ne(invoices.id, inv.id),
          inArray(invoices.status, [...ISSUED_LIKE, "corrected"])));
        const remaining = round(adv.grossTotal, 2).minus(agg?.used ?? 0);
        const amt = round(inv.advanceAmount ?? 0, 2);
        if (amt.lte(0)) errors.push("Износот на авансот мора да е поголем од 0.");
        if (!amt.isInteger()) errors.push("Авансот се одбива во цели денари (за плаќање е секогаш без децимали).");
        if (amt.gt(remaining)) errors.push(`Авансот е поголем од неискористениот дел (${remaining.toFixed(2)}).`);
        if (amt.gt(round(totals.grossTotal, 0))) errors.push("Авансот е поголем од вкупниот износ на фактурата.");
      }
    }
    if (errors.length) throw new DomainError("validation", errors.join(" "), 422);

    const [counter] = await tx.insert(counters)
      .values({ clientId: inv.clientId, docType: inv.docType, year: inv.year, lastNo: 1 })
      .onConflictDoUpdate({ target: [counters.clientId, counters.docType, counters.year], set: { lastNo: sql`${counters.lastNo} + 1` } })
      .returning();
    const seqNo = counter!.lastNo;
    const number = formatInvoiceNumber(client!.invoicePrefix, inv.docType, inv.year, seqNo);

    const [issued] = await tx.update(invoices).set({
      status: "issued", seqNo, number, issuedBy: actor.userId, issuedAt: now, statusMessage: null,
      netTotal: totals.netTotal, vatTotal: totals.vatTotal, grossTotal: totals.grossTotal,
      payableAmount: totals.payableAmount, lineCount: lines.length,
      fxNetTotal: ft?.fx.netTotal ?? null, fxVatTotal: ft?.fx.vatTotal ?? null, fxGrossTotal: ft?.fx.grossTotal ?? null, fxPayableAmount: ft?.fx.payableAmount ?? null,
      sellerName: client!.name, sellerEdb: client!.edb, sellerVatNumber: client!.vatNumber,
      sellerAddress: client!.address, sellerCity: client!.city, sellerIban: client!.iban, sellerBank: client!.bankName,
      buyerName: partner!.name, buyerEdb: partner!.edb, buyerVatNumber: partner!.vatNumber,
      buyerAddress: partner!.address, buyerCity: partner!.city, buyerCountry: partner!.country,
      version: sql`${invoices.version} + 1`,
    }).where(eq(invoices.id, inv.id)).returning();

    if (related && (inv.docType === "ST" || inv.docType === "KR")) {
      await tx.update(invoices).set({ status: inv.docType === "ST" ? "voided" : "corrected", version: sql`${invoices.version} + 1` })
        .where(eq(invoices.id, related.id));
    }
    // Magacin (docs/07): izdavanje -> ispratnica; storno/korekcija -> tocno vrakjanje na ispratnicata od originalot.
    // Knizno odobrenie/zadolzuvanje i avans ne ja menuvaat zalihata.
    const stockWarnings: string[] = [];
    let stockDocNumber: string | null = null;
    if (client!.modules.includes("warehouse")) {
      const stx = tx as unknown as Db;
      const docDate = inv.supplyDate ?? inv.issueDate;
      if (related && (inv.docType === "ST" || inv.docType === "KR")) {
        const prev = await stx.select().from(stockDocs).where(and(eq(stockDocs.invoiceId, related.id), eq(stockDocs.kind, "issue"), isNull(stockDocs.reversesDocId)));
        for (const d of prev) {
          const [rev] = await stx.select({ id: stockDocs.id }).from(stockDocs).where(eq(stockDocs.reversesDocId, d.id));
          if (!rev) stockWarnings.push(...(await reverseStockDoc(stx, d.id, { docDate, createdBy: actor.userId, note: `${number}: враќање на ${d.number}` })).warnings);
        }
      }
      if (inv.docType === "INV" || inv.docType === "KR") {
        const ids = [...new Set(lines.map((l) => l.itemId).filter((x): x is number => !!x))];
        const its = ids.length ? await stx.select().from(items).where(inArray(items.id, ids)) : [];
        const stockIds = new Set(its.filter((i) => (STOCK_ITEM_TYPES as readonly string[]).includes(i.type)).map((i) => i.id));
        // stavkite od ispratnica (docs/12) se vekje izdadeni od magacinot -> ne se izdavaat povtorno
        const moves = lines.filter((l) => l.itemId && stockIds.has(l.itemId) && !l.stockDocId);
        if (moves.length) {
          const wh = inv.warehouseId ?? (await defaultWarehouse(stx, inv.clientId)).id;
          const r = await postStockDoc(stx, { clientId: inv.clientId, kind: "issue", warehouseId: wh, docDate, invoiceId: inv.id,
            note: `${number}, ${partner!.name}`, createdBy: actor.userId,
            moves: moves.map((l) => ({ warehouseId: wh, itemId: l.itemId!, qty: `-${String(l.qty).replace("-", "")}` })) });
          stockWarnings.push(...r.warnings); stockDocNumber = r.doc.number;
        }
      }
    }
    await audit(tx as unknown as Db, actor, {
      clientId: inv.clientId, entity: "invoice", entityId: inv.id, action: "issue",
      changes: { number, seqNo, totals: { net: totals.netTotal, vat: totals.vatTotal, gross: totals.grossTotal },
        ...(ft ? { currency: inv.currency, rate: inv.exchangeRate, rateDate: inv.exchangeRateDate, fx: { net: ft.fx.netTotal, vat: ft.fx.vatTotal, gross: ft.fx.grossTotal } } : {}),
        stockDocNumber, stockWarnings },
    });
    return { ...issued!, stockDocNumber, stockWarnings };
  });
}
