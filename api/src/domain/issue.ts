/**
 * Izdavanje na faktura: proverki + broj + snimka na prodavac/kupuvac, se vo EDNA transakcija.
 * Zamena za tekot "eFaktura - Izdavanje v5". Brojot se dodeluva DURI pri izdavanje:
 *   {prefiks}[-{kod}]-{godina}-{00000}  npr. MC-2026-00001, MC-OD-2026-00003 (kod se izostava za INV).
 * Brojacot e atomski (INSERT ... ON CONFLICT DO UPDATE), a unikatniot indeks (klient, vid, godina, broj)
 * e dopolnitelna zastita - dupli broj e nevozmozen i pri paralelno izdavanje.
 */
import { and, eq, inArray, ne, sql, sum } from "drizzle-orm";
import { clients, counters, invoiceLines, invoices, partners } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { calcTotals, round } from "./calc.js";
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
    if (!client?.isActive) errors.push("Клиентот не е активен.");
    if (!partner?.isActive) errors.push("Купувачот не е активен.");

    // Povrzana faktura (storno, odobrenie, zadolzuvanje, korekcija)
    let related: typeof inv | undefined;
    if (NEEDS_RELATED.includes(inv.docType)) {
      if (!inv.relatedInvoiceId) errors.push("Недостасува поврзана фактура.");
      else {
        [related] = await tx.select().from(invoices).where(eq(invoices.id, inv.relatedInvoiceId)).for("update");
        if (!related || related.clientId !== inv.clientId || !ISSUED_LIKE.includes(related.status as never)
            || !["INV", "KR"].includes(related.docType))
          errors.push("Поврзаната фактура не постои, не е издадена или е сторнирана.");
      }
      if (inv.docType === "ST" && !inv.voidReasonCode) errors.push("Недостасува шифра на причина за сторно.");
      if (inv.docType === "KR" && (!inv.correctionReasonCode || !inv.correctionReason?.trim()))
        errors.push("Корекција бара C-шифра и опис.");
    }

    // Odbivanje avans (docs/04): samo INV/KR, ist kupuvac, izdadena avansna, najmnogu neiskoristeniot del
    const totals = calcTotals(lines.map((l) => ({ ...l, unitNet: "0" })), inv.advanceAmount ?? 0);
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
    await audit(tx as unknown as Db, actor, {
      clientId: inv.clientId, entity: "invoice", entityId: inv.id, action: "issue",
      changes: { number, seqNo, totals: { net: totals.netTotal, vat: totals.vatTotal, gross: totals.grossTotal } },
    });
    return issued!;
  });
}
