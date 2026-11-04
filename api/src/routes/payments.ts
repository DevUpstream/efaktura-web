/** Plakjanja i naplata (docs/08). Modulot "payments" se proveruva na sekoe baranje. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { clients, invoices, partners, paymentAllocations, payments, purchaseInvoices, type BankImportMapping } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "../domain/errors.js";
import { aging, allocateExisting, createPayment, openItems, unallocated, voidPayment } from "../domain/payments.js";
import { findInvoiceNumbers, normalizeName, parseStatement } from "../domain/bank-import.js";
import { assertModule, requireUser } from "../auth/context.js";
import { Id } from "./master.js";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Датум ГГГГ-ММ-ДД");
const Dir = z.enum(["in", "out"]);
const Money = z.coerce.number().positive().max(1e12);
const Alloc = z.array(z.object({ id: Id, amount: Money })).max(500).nullable().optional();
const PaymentBody = z.object({ direction: Dir, partnerId: Id, payDate: Day, amount: Money, method: z.enum(["bank", "cash", "card", "compensation", "other"]).default("bank"),
  reference: z.string().trim().max(200).optional().nullable(), note: z.string().trim().max(1000).optional().nullable(), allocations: Alloc });
const Mapping = z.object({
  delimiter: z.enum([";", ",", "\\t", "|"]), skipRows: z.number().int().min(0).max(50), dateCol: z.number().int().min(0).max(60),
  dateFormat: z.enum(["dd.MM.yyyy", "yyyy-MM-dd", "dd/MM/yyyy"]), amountMode: z.enum(["signed", "split"]),
  amountCol: z.number().int().min(0).max(60).optional(), creditCol: z.number().int().min(0).max(60).optional(), debitCol: z.number().int().min(0).max(60).optional(),
  decimal: z.enum([",", "."]), nameCol: z.number().int().min(0).max(60).optional(), accountCol: z.number().int().min(0).max(60).optional(),
  referenceCols: z.array(z.number().int().min(0).max(60)).max(5),
}).superRefine((m, ctx) => {
  if (m.amountMode === "signed" && m.amountCol === undefined) ctx.addIssue({ code: "custom", message: "Изберете колона за износ." });
  if (m.amountMode === "split" && (m.creditCol === undefined || m.debitCol === undefined)) ctx.addIssue({ code: "custom", message: "Изберете колони за прилив и одлив." });
});

export async function paymentRoutes(app: FastifyInstance, { db }: { db: Db }) {
  const ctx = async (req: FastifyRequest) => {
    const u = requireUser(req);
    const p = z.object({ clientId: Id, id: Id.optional() }).parse(req.params);
    await assertModule(db, u, p.clientId, "payments");
    return { u, actor: { userId: u.id, ip: req.ip }, ...p };
  };

  /* --------------------------------------------------- otvoreni stavki */
  app.get("/api/clients/:clientId/open-items", async (req) => {
    const { clientId } = await ctx(req);
    const q = z.object({ direction: Dir.default("in"), partnerId: Id.optional(), asOf: Day.optional(), includeClosed: z.coerce.boolean().default(false) }).parse(req.query);
    const items = await openItems(db, clientId, q.direction, q);
    const free = await unallocated(db, clientId, q.direction, q.partnerId);
    const by = new Map<number, { partnerId: number; partnerName: string; items: typeof items }>();
    for (const i of items) { const g = by.get(i.partnerId) ?? { partnerId: i.partnerId, partnerName: i.partnerName, items: [] }; g.items.push(i); by.set(i.partnerId, g); }
    for (const pid of free.keys()) if (!by.has(pid)) {
      const [p] = await db.select({ name: partners.name }).from(partners).where(eq(partners.id, pid));
      by.set(pid, { partnerId: pid, partnerName: p?.name ?? "", items: [] });
    }
    const byPartner = [...by.values()].map((g) => ({ partnerId: g.partnerId, partnerName: g.partnerName, count: g.items.filter((i) => Number(i.remaining) > 0).length,
      ...aging(g.items.filter((i) => Number(i.remaining) > 0)), unallocated: free.get(g.partnerId) ?? "0.00" }))
      .sort((a, b) => Number(b.total) - Number(a.total));
    return { items, aging: aging(items.filter((i) => Number(i.remaining) > 0)), byPartner };
  });

  /* ----------------------------------------------------------- uplati */
  app.get("/api/clients/:clientId/payments", async (req) => {
    const { clientId } = await ctx(req);
    const q = z.object({ direction: Dir.optional(), partnerId: Id.optional(), from: Day.optional(), to: Day.optional() }).parse(req.query);
    const conds = [eq(payments.clientId, clientId)];
    if (q.direction) conds.push(eq(payments.direction, q.direction));
    if (q.partnerId) conds.push(eq(payments.partnerId, q.partnerId));
    if (q.from) conds.push(gte(payments.payDate, q.from));
    if (q.to) conds.push(lte(payments.payDate, q.to));
    return db.select({ id: payments.id, direction: payments.direction, payDate: payments.payDate, amount: payments.amount, method: payments.method,
      reference: payments.reference, partnerId: payments.partnerId, partnerName: partners.name, voidedAt: payments.voidedAt,
      allocated: sql<string>`coalesce((select sum(a.amount) from payment_allocations a where a.payment_id = ${payments.id}), 0)`,
      fromStatement: sql<boolean>`${payments.statementLineKey} is not null` })
      .from(payments).innerJoin(partners, eq(partners.id, payments.partnerId)).where(and(...conds))
      .orderBy(desc(payments.payDate), desc(payments.id)).limit(1000);
  });
  app.get("/api/clients/:clientId/payments/:id", async (req) => {
    const { clientId, id } = await ctx(req);
    const [p] = await db.select({ p: payments, partnerName: partners.name }).from(payments).innerJoin(partners, eq(partners.id, payments.partnerId))
      .where(and(eq(payments.id, id!), eq(payments.clientId, clientId)));
    if (!p) throw new DomainError("not_found", "Уплатата не постои.", 404);
    const allocs = await db.select({ id: paymentAllocations.id, amount: paymentAllocations.amount, invoiceId: paymentAllocations.invoiceId,
      purchaseInvoiceId: paymentAllocations.purchaseInvoiceId, invoiceNumber: invoices.number, purchaseNumber: purchaseInvoices.number,
      supplierNumber: purchaseInvoices.supplierNumber, createdAt: paymentAllocations.createdAt })
      .from(paymentAllocations).leftJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
      .leftJoin(purchaseInvoices, eq(purchaseInvoices.id, paymentAllocations.purchaseInvoiceId)).where(eq(paymentAllocations.paymentId, p.p.id));
    const allocated = allocs.reduce((s, a) => s + Number(a.amount), 0);
    return { ...p.p, partnerName: p.partnerName, allocations: allocs, unallocated: (Number(p.p.amount) - allocated).toFixed(2) };
  });
  app.post("/api/clients/:clientId/payments", async (req, reply) => {
    const { clientId, actor } = await ctx(req);
    const b = PaymentBody.parse(req.body);
    const r = await db.transaction(async (tx) => createPayment(tx as unknown as Db, { ...b, clientId }, actor));
    return reply.status(201).send(r);
  });
  app.post("/api/clients/:clientId/payments/:id/allocate", async (req) => {
    const { clientId, id, actor } = await ctx(req);
    const b = z.object({ items: Alloc }).parse(req.body ?? {});
    return { allocated: await db.transaction(async (tx) => allocateExisting(tx as unknown as Db, id!, clientId, b.items ?? null, actor)) };
  });
  app.post("/api/clients/:clientId/payments/:id/void", async (req) => {
    const { clientId, id, actor } = await ctx(req);
    const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
    const v = await db.transaction(async (tx) => voidPayment(tx as unknown as Db, id!, clientId, reason, actor));
    return { id: v.id, voidedAt: v.voidedAt };
  });

  /* ------------------------------------------------------ uvoz na izvod */
  app.get("/api/clients/:clientId/bank-mapping", async (req) => {
    const { clientId } = await ctx(req);
    const [c] = await db.select({ m: clients.bankImportMapping }).from(clients).where(eq(clients.id, clientId));
    return c?.m ?? null;
  });
  app.put("/api/clients/:clientId/bank-mapping", async (req) => {
    const { clientId } = await ctx(req);
    const m = Mapping.parse(req.body) as BankImportMapping;
    await db.update(clients).set({ bankImportMapping: m }).where(eq(clients.id, clientId));
    return m;
  });

  app.post("/api/clients/:clientId/payments/import/preview", async (req) => {
    const { clientId } = await ctx(req);
    const b = z.object({ text: z.string().max(2_000_000), mapping: Mapping.optional() }).parse(req.body);
    const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
    const mapping = (b.mapping ?? client!.bankImportMapping) as BankImportMapping | null;
    if (!mapping) throw new DomainError("validation", "Прво поставете како се чита изводот (колони).", 422);
    const { rows, skipped } = parseStatement(b.text, mapping);
    const keys = rows.map((r) => r.key);
    const done = keys.length ? new Set((await db.select({ k: payments.statementLineKey }).from(payments)
      .where(and(eq(payments.clientId, clientId), inArray(payments.statementLineKey, keys), sql`${payments.voidedAt} is null`))).map((x) => x.k)) : new Set();
    const ps = await db.select().from(partners).where(and(eq(partners.clientId, clientId), eq(partners.isActive, true)));
    const recv = await openItems(db, clientId, "in"), pay = await openItems(db, clientId, "out");
    const ownAccounts = new Set([client!.iban, ...(client!.pdfSettings?.bankAccounts ?? []).map((b) => b.account)].filter(Boolean).map((a) => String(a).replace(/[\s-]/g, "")));
    const out = rows.map((r) => {
      const text = `${r.name} ${r.reference}`;
      const open = r.direction === "in" ? recv : pay;
      // 1) broj na faktura vo referencata
      const nums = findInvoiceNumbers(text, [client!.invoicePrefix]);
      const byNum = open.filter((o) => nums.some((n) => o.number.toUpperCase().startsWith(n)));
      // 2) partner: ziro-smetka -> EDB vo tekstot -> naziv
      const acc = r.account.replace(/-/g, "");
      let partner = acc && !ownAccounts.has(acc) ? ps.find((p) => p.bankAccount && p.bankAccount.replace(/[\s-]/g, "") === acc) : undefined;
      let how = partner ? "жиро-сметка" : "";
      if (!partner) { partner = ps.find((p) => p.edb && text.includes(p.edb)); if (partner) how = "ЕДБ"; }
      if (!partner && byNum.length) { partner = ps.find((p) => p.id === byNum[0]!.partnerId); if (partner) how = "број на фактура"; }
      if (!partner && r.name) {
        const n = normalizeName(r.name);
        const cands = ps.filter((p) => { const pn = normalizeName(p.name); return pn.length > 3 && (n.includes(pn) || pn.includes(n)); });
        if (cands.length === 1) { partner = cands[0]; how = "назив"; }
      }
      // 3) fakturi: po broj; inaku tocen iznos kaj partnerot; inaku avtomatski od najstarata (null)
      let allocations: { id: number; number: string; amount: string }[] | null = null;
      const mine = partner ? open.filter((o) => o.partnerId === partner!.id) : [];
      const numMine = byNum.filter((o) => !partner || o.partnerId === partner.id);
      if (numMine.length) {
        let left = Number(r.amount);
        allocations = numMine.map((o) => { const a = Math.min(left, Number(o.remaining)); left -= a; return { id: o.id, number: o.number, amount: a.toFixed(2) }; }).filter((a) => Number(a.amount) > 0);
      } else {
        const exact = mine.find((o) => o.remaining === r.amount);
        if (exact) allocations = [{ id: exact.id, number: exact.number, amount: exact.remaining }];
      }
      return { ...r, imported: done.has(r.key), partnerId: partner?.id ?? null, partnerName: partner?.name ?? null, matchedBy: how,
        allocations, openForPartner: mine.map((o) => ({ id: o.id, number: o.number, remaining: o.remaining, dueDate: o.dueDate })) };
    });
    return { rows: out, skipped, mapping };
  });

  app.post("/api/clients/:clientId/payments/import/commit", async (req) => {
    const { clientId, actor } = await ctx(req);
    const b = z.object({ rows: z.array(z.object({ key: z.string().min(16).max(64), payDate: Day, amount: Money, direction: Dir, partnerId: Id,
      reference: z.string().max(200).optional().nullable(), allocations: Alloc })).min(1).max(2000) }).parse(req.body);
    const results: { key: string; ok: boolean; paymentId?: number; message?: string }[] = [];
    const existing = new Set((await db.select({ k: payments.statementLineKey }).from(payments).where(and(eq(payments.clientId, clientId),
      inArray(payments.statementLineKey, b.rows.map((r) => r.key)), sql`${payments.voidedAt} is null`))).map((x) => x.k));
    for (const r of b.rows) {
      if (existing.has(r.key)) { results.push({ key: r.key, ok: false, message: "Веќе увезено." }); continue; }
      try {
        const p = await db.transaction(async (tx) => createPayment(tx as unknown as Db, { clientId, direction: r.direction, partnerId: r.partnerId, payDate: r.payDate,
          amount: r.amount, method: "bank", reference: r.reference ?? null, statementLineKey: r.key, allocations: r.allocations }, actor));
        results.push({ key: r.key, ok: true, paymentId: p.id });
      } catch (e) {
        const code = ((e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code);
        results.push({ key: r.key, ok: false, message: code === "23505" ? "Веќе увезено." : (e as Error).message });
      }
    }
    return { imported: results.filter((r) => r.ok).length, results };
  });
}
