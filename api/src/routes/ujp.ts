/** Праќање на УЈП (docs/15): корисникот бара, агентот (компјутерот со токенот) потпишува и праќа. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { invoices } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "../domain/errors.js";
import { cancelJob, finishJob, invoiceUjpState, queueAll, queueInvoice, takeJobs } from "../domain/ujp-send.js";
import { assertClientAccess, requireUser } from "../auth/context.js";
import { requireAgent } from "./registry.js";
import { Id } from "./master.js";

export async function ujpRoutes(app: FastifyInstance, { db }: { db: Db }) {
  const load = async (req: FastifyRequest) => {
    const u = requireUser(req);
    const id = Id.parse((req.params as { id: string }).id);
    const [inv] = await db.select({ id: invoices.id, clientId: invoices.clientId, number: invoices.number }).from(invoices).where(eq(invoices.id, id));
    if (!inv) throw new DomainError("not_found", "Фактурата не постои.", 404);
    await assertClientAccess(db, u, inv.clientId);
    return { u, inv };
  };

  /* ---------------------------------------------------------- корисник */
  app.get("/api/invoices/:id/ujp", async (req) => { const { inv } = await load(req); return invoiceUjpState(db, inv.id); });

  /** JSON како датотека (само преглед: без requestTimestamp и без потпис; продавачот/купувачот ги освежува агентот). */
  app.get("/api/invoices/:id/ujp.json", async (req, reply) => {
    const { inv } = await load(req);
    const s = await invoiceUjpState(db, inv.id);
    return reply.header("content-type", "application/json; charset=utf-8")
      .header("content-disposition", `attachment; filename="${encodeURIComponent(inv.number ?? String(inv.id))}.ujp.json"`).send(JSON.stringify(s.payload, null, 2));
  });

  app.post("/api/invoices/:id/ujp-send", async (req) => {
    const { u, inv } = await load(req);
    const r = await queueInvoice(db, inv.id, { userId: u.id, ip: req.ip });
    return { ok: true, jobId: r.job.id, waitFor: r.waitFor };
  });

  app.post("/api/invoices/:id/ujp-cancel", async (req) => {
    const { u, inv } = await load(req);
    return cancelJob(db, inv.id, { userId: u.id, ip: req.ip });
  });

  app.post("/api/clients/:clientId/ujp-send-all", async (req) => {
    const u = requireUser(req);
    const { clientId } = z.object({ clientId: Id }).parse(req.params);
    await assertClientAccess(db, u, clientId);
    return queueAll(db, clientId, { userId: u.id, ip: req.ip });
  });

  /* ------------------------------------------------------------- агент */
  app.post("/api/agent/ujp-jobs/take", { logLevel: "silent" }, async (req) => {
    const k = await requireAgent(db, req);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(20).default(5) }).parse(req.body ?? {});
    return takeJobs(db, k.id, limit);
  });

  app.post("/api/agent/ujp-jobs/:id", { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const k = await requireAgent(db, req);
    const id = Id.parse((req.params as { id: string }).id);
    const b = z.object({
      ok: z.boolean(), httpStatus: z.number().int().nullable().optional(), euid: z.string().trim().max(40).nullable().optional(),
      qrLink: z.string().trim().max(255).nullable().optional(), timestamp: z.string().max(40).nullable().optional(),
      message: z.string().max(60000).nullable().optional(), request: z.string().max(6_000_000).nullable().optional(),
    }).parse(req.body);
    return finishJob(db, id, k.id, b);
  });
}
