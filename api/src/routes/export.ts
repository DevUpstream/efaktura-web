/**
 * Извоз на сите податоци на една фирма во ZIP (docs/12): CSV по табела (UTF-8 со BOM, „;“ – се отвора во Excel),
 * PDF на секоја издадена фактура, прилозите на влезните фактури, README. Само администратор.
 */
import type { FastifyInstance } from "fastify";
import { PassThrough } from "node:stream";
import yazl from "yazl";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { clients, invoiceLines, invoices, items, purchaseFiles, purchaseInvoices } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "../domain/errors.js";
import { audit } from "../domain/audit.js";
import { renderInvoicePdf } from "../domain/pdf.js";
import { requireAdmin } from "../auth/context.js";
import { Id } from "./master.js";

const rowsOf = (r: unknown) => (Array.isArray(r) ? r : (r as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[];

/** Табели: име -> SQL (сите се ограничени на фирмата). Бинарните колони (податоци на прилози) не се во CSV. */
const TABLES = (c: number) => ({
  partneri: sql`select * from partners where client_id = ${c} order by id`,
  partneri_smetki: sql`select * from partner_accounts where client_id = ${c} order by id`,
  partneri_kontakti: sql`select k.* from partner_contacts k join partners p on p.id = k.partner_id where p.client_id = ${c} order by k.id`,
  partneri_beleski: sql`select * from partner_notes where client_id = ${c} order by id`,
  artikli: sql`select * from items where client_id = ${c} order by id`,
  dogovoreni_ceni: sql`select * from partner_prices where client_id = ${c} order by id`,
  fakturi: sql`select * from invoices where client_id = ${c} order by year, id`,
  fakturi_stavki: sql`select l.* from invoice_lines l join invoices i on i.id = l.invoice_id where i.client_id = ${c} order by l.invoice_id, l.line_no`,
  povtoruvacki: sql`select * from recurring_invoices where client_id = ${c} order by id`,
  vlezni_fakturi: sql`select id, client_id, partner_id, warehouse_id, status, year, seq_no, number, supplier_number, issue_date, received_date, due_date,
    net_total, vat_total, gross_total, payable_amount, note, source, fixed_amounts, turnover_date, ujp_doc_type, created_at, posted_at, voided_at, void_reason
    from purchase_invoices where client_id = ${c} order by year, id`,
  vlezni_stavki: sql`select l.* from purchase_lines l join purchase_invoices p on p.id = l.purchase_invoice_id where p.client_id = ${c} order by l.purchase_invoice_id, l.line_no`,
  vlezni_prilozi: sql`select f.id, f.purchase_invoice_id, f.file_name, f.content_type, f.size, f.sha256, f.created_at from purchase_files f
    join purchase_invoices p on p.id = f.purchase_invoice_id where p.client_id = ${c} order by f.id`,
  plakjanja: sql`select * from payments where client_id = ${c} order by pay_date, id`,
  plakjanja_raspored: sql`select a.* from payment_allocations a join payments y on y.id = a.payment_id where y.client_id = ${c} order by a.id`,
  kompenzacii: sql`select * from compensations where client_id = ${c} order by id`,
  opomeni: sql`select * from dunning_letters where client_id = ${c} order by id`,
  izvodi: sql`select * from bank_statements where client_id = ${c} order by id`,
  izvodi_stavki: sql`select * from bank_statement_lines where client_id = ${c} order by statement_id, line_no`,
  magacini: sql`select * from warehouses where client_id = ${c} order by id`,
  magacin_dokumenti: sql`select * from stock_docs where client_id = ${c} order by doc_date, id`,
  magacin_dvizenja: sql`select * from stock_moves where client_id = ${c} order by id`,
  lotovi: sql`select l.* from lots l join items i on i.id = l.item_id where i.client_id = ${c} order by l.id`,
  normativi: sql`select * from boms where client_id = ${c} order by id`,
  normativi_stavki: sql`select l.* from bom_lines l join boms b on b.id = l.bom_id where b.client_id = ${c} order by l.id`,
  rabotni_nalozi: sql`select * from work_orders where client_id = ${c} order by id`,
  revizija: sql`select * from audit_log where client_id = ${c} order by id`,
});

const cell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const t = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[;"\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "﻿";
  const cols = Object.keys(rows[0]!);
  return "﻿" + [cols.join(";"), ...rows.map((r) => cols.map((c) => cell(r[c])).join(";"))].join("\r\n") + "\r\n";
}

export async function exportRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.get("/api/clients/:clientId/export.zip", async (req, reply) => {
    const u = requireAdmin(req);
    const { clientId } = z.object({ clientId: Id }).parse(req.params);
    const { pdf } = z.object({ pdf: z.enum(["0", "1"]).default("1") }).parse(req.query);
    const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
    if (!client) throw new DomainError("not_found", "Фирмата не постои.", 404);
    const zip = new yazl.ZipFile();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const counts: string[] = [];
    for (const [name, q] of Object.entries(TABLES(clientId))) {
      let rows: Record<string, unknown>[] = [];
      try { rows = rowsOf(await db.execute(q)); } catch { continue; }   // tabela sto ja nema vo postara baza
      zip.addBuffer(Buffer.from(toCsv(rows), "utf8"), `csv/${name}.csv`);
      counts.push(`${name}.csv: ${rows.length}`);
    }
    zip.addBuffer(Buffer.from(toCsv([client as unknown as Record<string, unknown>]), "utf8"), "csv/firma.csv");
    let pdfs = 0, att = 0;
    if (pdf === "1") {
      const invs = await db.select().from(invoices).where(and(eq(invoices.clientId, clientId), sql`${invoices.status} not in ('draft','cancelled_draft','to_issue')`)).orderBy(asc(invoices.id));
      const codes = Object.fromEntries((await db.select({ id: items.id, code: items.code }).from(items).where(eq(items.clientId, clientId))).map((r) => [r.id, r.code]));
      const num = new Map(invs.map((i) => [i.id, i]));
      for (const inv of invs) {
        const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
        const rel = inv.relatedInvoiceId ? num.get(inv.relatedInvoiceId) : undefined;
        const b = await renderInvoicePdf({ inv, lines, client, relatedNumber: rel?.number, relatedDate: rel?.issueDate,
          advanceNumber: inv.advanceInvoiceId ? num.get(inv.advanceInvoiceId)?.number : null, itemCodes: codes });
        zip.addBuffer(b, `fakturi_pdf/${inv.year}/${(inv.number ?? String(inv.id)).replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`);
        pdfs++;
      }
      const pids = (await db.select({ id: purchaseInvoices.id, number: purchaseInvoices.number }).from(purchaseInvoices).where(eq(purchaseInvoices.clientId, clientId)));
      const pnum = new Map(pids.map((p) => [p.id, p.number ?? `nacrt-${p.id}`]));
      if (pids.length) {
        // eden po eden: prilozite se vo bazata (bytea), da ne se vcituvaat site naednash
        const fl = await db.select({ id: purchaseFiles.id, pid: purchaseFiles.purchaseInvoiceId, name: purchaseFiles.fileName }).from(purchaseFiles)
          .where(inArray(purchaseFiles.purchaseInvoiceId, pids.map((p) => p.id)));
        for (const f of fl) {
          const [d] = await db.select({ data: purchaseFiles.data }).from(purchaseFiles).where(eq(purchaseFiles.id, f.id));
          zip.addBuffer(Buffer.from(d!.data as unknown as Uint8Array), `vlezni_prilozi/${pnum.get(f.pid)!.replace(/[^A-Za-z0-9._-]/g, "_")}/${f.id}_${f.name.replace(/[\\/:*?"<>|]/g, "_")}`);
          att++;
        }
      }
    }
    zip.addBuffer(Buffer.from([
      `Извоз на податоци: ${client.name} (ЕДБ ${client.edb})`, `Направен: ${new Date().toISOString()} од ${u.email}`, "",
      "csv/ – секоја табела посебно; UTF-8, разделувач „;“, се отвора директно во Excel.",
      "  Износите се со децимална точка. Датумите се ГГГГ-ММ-ДД. Колоните *_id се врски меѓу табелите (на пр. fakturi_stavki.invoice_id = fakturi.id).",
      `fakturi_pdf/ – PDF на секоја издадена фактура (${pdfs}).`, `vlezni_prilozi/ – прилози на влезните фактури (${att}).`, "", ...counts,
    ].join("\r\n"), "utf8"), "README.txt");
    zip.end();
    await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "client", entityId: clientId, action: "export", changes: { pdfs, attachments: att } });
    const out = new PassThrough();
    zip.outputStream.pipe(out);
    const fname = `${client.invoicePrefix}-izvoz-${stamp}.zip`;
    return reply.header("content-type", "application/zip").header("content-disposition", `attachment; filename="${fname}"`).header("cache-control", "no-store").send(out);
  });
}
