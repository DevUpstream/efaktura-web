/** Трошковни места (docs/14): шифрарник, масовно доделување, извештај. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { clients, costCenters } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "../domain/errors.js";
import { audit } from "../domain/audit.js";
import { assignCostCenter, costCenterDocs, costCenterReport } from "../domain/costcenters.js";
import { assertClientAccess, requireUser } from "../auth/context.js";
import { Id } from "./master.js";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Датум ГГГГ-ММ-ДД");
const n = (v: string) => v.replace(".", ",");
const q = (s: string) => (/[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export async function costCenterRoutes(app: FastifyInstance, { db }: { db: Db }) {
  const ctx = async (req: FastifyRequest) => {
    const u = requireUser(req);
    const p = z.object({ clientId: Id, id: Id.optional() }).parse(req.params);
    await assertClientAccess(db, u, p.clientId);
    return { u, ...p, actor: { userId: u.id, ip: req.ip } };
  };
  const unique = async (clientId: number, code: string, exceptId?: number) => {
    const [dup] = await db.select({ id: costCenters.id }).from(costCenters).where(and(eq(costCenters.clientId, clientId),
      sql`upper(${costCenters.code}) = upper(${code})`, ...(exceptId ? [ne(costCenters.id, exceptId)] : [])));
    if (dup) throw new DomainError("validation", `Шифрата ${code} веќе постои.`, 422);
  };
  const In = z.object({ code: z.string().trim().min(1).max(20), name: z.string().trim().min(1).max(120), isActive: z.boolean().default(true) });

  app.get("/api/clients/:clientId/cost-centers", async (req) => {
    const { clientId } = await ctx(req);
    return db.select().from(costCenters).where(eq(costCenters.clientId, clientId)).orderBy(asc(costCenters.code));
  });
  app.post("/api/clients/:clientId/cost-centers", async (req, reply) => {
    const { clientId, actor } = await ctx(req);
    const b = In.parse(req.body);
    await unique(clientId, b.code);
    const [c] = await db.insert(costCenters).values({ clientId, ...b }).returning();
    await audit(db, actor, { clientId, entity: "cost_center", entityId: c!.id, action: "create", changes: b });
    return reply.status(201).send(c);
  });
  app.patch("/api/clients/:clientId/cost-centers/:id", async (req) => {
    const { clientId, id, actor } = await ctx(req);
    const b = In.partial().parse(req.body);
    if (b.code) await unique(clientId, b.code, id);
    const [c] = await db.update(costCenters).set(b).where(and(eq(costCenters.id, id!), eq(costCenters.clientId, clientId))).returning();
    if (!c) throw new DomainError("not_found", "Трошковното место не постои.", 404);
    await audit(db, actor, { clientId, entity: "cost_center", entityId: c.id, action: "update", changes: b });
    return c;
  });

  /** Масовно доделување: dryRun = само број на документи. */
  app.post("/api/clients/:clientId/cost-centers/assign", async (req) => {
    const { clientId, actor } = await ctx(req);
    const b = z.object({ kind: z.enum(["invoice", "purchase"]), from: Day, to: Day, partnerId: Id.optional().nullable(), onlyEmpty: z.boolean().default(true),
      costCenterId: Id, dryRun: z.boolean().default(true) }).parse(req.body);
    return assignCostCenter(db, clientId, b, actor);
  });

  app.get("/api/clients/:clientId/reports/cost-centers", async (req, reply) => {
    const { clientId } = await ctx(req);
    const p = z.object({ from: Day, to: Day, format: z.enum(["json", "csv"]).default("json") }).parse(req.query);
    const r = await costCenterReport(db, clientId, p.from, p.to);
    if (p.format === "json") return r;
    const [c] = await db.select({ p: clients.invoicePrefix }).from(clients).where(eq(clients.id, clientId));
    const csv = ["Шифра;Трошковно место;Приходи (нето);Трошоци (нето);Разлика;Излезни документи;Влезни документи",
      ...r.rows.map((x) => [q(x.code), q(x.name), n(x.revenue), n(x.costs), n(x.result), x.revenueDocs, x.costDocs].join(";")),
      ["", "ВКУПНО", n(r.totals.revenue), n(r.totals.costs), n(r.totals.result), "", ""].join(";")].join("\r\n");
    return reply.header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${c!.p}-TM-${p.from}_${p.to}.csv"`).send(`﻿${csv}\r\n`);
  });
  /** Документи за ТМ (id=0 → без ТМ). */
  app.get("/api/clients/:clientId/reports/cost-centers/:cc", async (req) => {
    const { clientId } = await ctx(req);
    const { cc } = z.object({ cc: z.coerce.number().int().min(0) }).parse(req.params);
    const p = z.object({ from: Day, to: Day }).parse(req.query);
    return costCenterDocs(db, clientId, cc || null, p.from, p.to);
  });
}
