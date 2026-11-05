/** Plakjanja i naplata (docs/08). Modulot "payments" se proveruva na sekoe baranje. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { bankStatementLines, bankStatements, clients, invoices, partnerAccounts, partners, paymentAllocations, payments, purchaseInvoices, type BankImportMapping } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "../domain/errors.js";
import { aging, allocateExisting, createPayment, openItems, unallocated, voidPayment } from "../domain/payments.js";
import { bookLine, bookSure, clientOwnAccounts, importStatement, statementDetail } from "../domain/statements.js";
import { normAccount } from "../domain/bank-txt.js";
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

  /* ------------------------------------------------- izvodi (docs/08) */
  app.get("/api/clients/:clientId/bank-statements", async (req) => {
    const { clientId } = await ctx(req);
    return db.select({ id: bankStatements.id, format: bankStatements.format, ownAccount: bankStatements.ownAccount, statementNo: bankStatements.statementNo,
      statementDate: bankStatements.statementDate, openingBalance: bankStatements.openingBalance, closingBalance: bankStatements.closingBalance,
      fileName: bankStatements.fileName, createdAt: bankStatements.createdAt,
      lines: sql<number>`(select count(*)::int from bank_statement_lines l where l.statement_id = bank_statements.id)`,
      open: sql<number>`(select count(*)::int from bank_statement_lines l left join payments y on y.id = l.payment_id
        where l.statement_id = bank_statements.id and not l.ignored and (l.payment_id is null or y.voided_at is not null))`,
      inflow: sql<string>`(select coalesce(sum(l.amount), 0) from bank_statement_lines l where l.statement_id = bank_statements.id and l.direction = 'in')`,
      outflow: sql<string>`(select coalesce(sum(l.amount), 0) from bank_statement_lines l where l.statement_id = bank_statements.id and l.direction = 'out')` })
      .from(bankStatements).where(eq(bankStatements.clientId, clientId)).orderBy(desc(bankStatements.statementDate), desc(bankStatements.id)).limit(500);
  });
  app.post("/api/clients/:clientId/bank-statements", async (req, reply) => {
    const { clientId, actor } = await ctx(req);
    const b = z.object({ text: z.string().min(1).max(2_000_000), fileName: z.string().max(200).optional().nullable(), autoBook: z.boolean().default(true) }).parse(req.body);
    return reply.status(201).send(await importStatement(db, clientId, b.text, b.fileName ?? null, actor, { autoBook: b.autoBook }));
  });
  app.get("/api/clients/:clientId/bank-statements/:id", async (req) => {
    const { clientId, id } = await ctx(req);
    return statementDetail(db, clientId, id!);
  });
  app.post("/api/clients/:clientId/bank-statements/:id/book-sure", async (req) => {
    const { clientId, id, actor } = await ctx(req);
    return bookSure(db, clientId, id!, actor);
  });
  app.post("/api/clients/:clientId/bank-lines/:id/book", async (req) => {
    const { clientId, id, actor } = await ctx(req);
    const b = z.object({ partnerId: Id, allocations: Alloc, learn: z.boolean().default(true) }).parse(req.body);
    const r = await bookLine(db, clientId, id!, { partnerId: b.partnerId, allocations: b.allocations ?? null, learn: b.learn }, actor);
    return { paymentId: r.id, allocated: r.allocated, unallocated: r.unallocated, learned: r.learned };
  });
  app.post("/api/clients/:clientId/bank-lines/:id/ignore", async (req) => {
    const { clientId, id } = await ctx(req);
    const b = z.object({ ignored: z.boolean(), reason: z.string().trim().max(200).optional().nullable() }).parse(req.body);
    const [l] = await db.select().from(bankStatementLines).where(and(eq(bankStatementLines.id, id!), eq(bankStatementLines.clientId, clientId)));
    if (!l) throw new DomainError("not_found", "Ставката не постои.", 404);
    if (b.ignored && l.paymentId) {
      const [p] = await db.select({ v: payments.voidedAt }).from(payments).where(eq(payments.id, l.paymentId));
      if (p && !p.v) throw new DomainError("validation", "Ставката е прокнижена: прво сторнирајте ја уплатата.", 422);
    }
    await db.update(bankStatementLines).set({ ignored: b.ignored, ignoreReason: b.ignored ? b.reason ?? null : null }).where(eq(bankStatementLines.id, l.id));
    return { ok: true };
  });

  /* ------------------------------------------- ziro-smetki na partner */
  app.get("/api/clients/:clientId/partners/:id/accounts", async (req) => {
    const { clientId, id } = await ctx(req);
    return db.select().from(partnerAccounts).where(and(eq(partnerAccounts.clientId, clientId), eq(partnerAccounts.partnerId, id!)));
  });
  app.post("/api/clients/:clientId/partners/:id/accounts", async (req, reply) => {
    const { clientId, id } = await ctx(req);
    const { account } = z.object({ account: z.string().trim().regex(/^\d{3}-?\d{10}-?\d{2}$/, "Жиро-сметка: XXX-XXXXXXXXXX-XX") }).parse(req.body);
    const [p] = await db.select({ id: partners.id }).from(partners).where(and(eq(partners.id, id!), eq(partners.clientId, clientId)));
    if (!p) throw new DomainError("not_found", "Партнерот не постои.", 404);
    const [own] = await db.select().from(clients).where(eq(clients.id, clientId));
    if (clientOwnAccounts(own!).has(normAccount(account))) throw new DomainError("validation", "Тоа е сметка на нашата фирма.", 422);
    const r = await db.insert(partnerAccounts).values({ clientId, partnerId: id!, account: normAccount(account), source: "manual" }).onConflictDoNothing().returning();
    if (!r.length) throw new DomainError("duplicate", "Сметката е веќе поврзана (можеби со друг партнер).", 409);
    return reply.status(201).send(r[0]);
  });
  app.delete("/api/clients/:clientId/partners/:id/accounts/:accId", async (req) => {
    const { clientId, id } = await ctx(req);
    const { accId } = z.object({ accId: Id }).parse(req.params);
    await db.delete(partnerAccounts).where(and(eq(partnerAccounts.id, accId), eq(partnerAccounts.partnerId, id!), eq(partnerAccounts.clientId, clientId)));
    return { ok: true };
  });
}
