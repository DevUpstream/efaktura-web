/** КИФ / КУФ (docs/13): преглед и CSV за Excel / сметководителот. */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { clients } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { bookCsv, kif, kuf } from "../domain/vatbooks.js";
import { assertClientAccess, assertModule, requireUser } from "../auth/context.js";
import { Id } from "./master.js";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Датум ГГГГ-ММ-ДД");

export async function vatBookRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.get("/api/clients/:clientId/vat-books/:kind", async (req, reply) => {
    const u = requireUser(req);
    const { clientId, kind } = z.object({ clientId: Id, kind: z.enum(["kif", "kuf"]) }).parse(req.params);
    if (kind === "kuf") await assertModule(db, u, clientId, "incoming"); else await assertClientAccess(db, u, clientId);
    const q = z.object({ from: Day, to: Day, format: z.enum(["json", "csv"]).default("json") }).parse(req.query);
    const b = kind === "kif" ? await kif(db, clientId, q.from, q.to) : await kuf(db, clientId, q.from, q.to);
    if (q.format === "json") return b;
    const [c] = await db.select({ p: clients.invoicePrefix }).from(clients).where(eq(clients.id, clientId));
    return reply.header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${c!.p}-${kind.toUpperCase()}-${q.from}_${q.to}.csv"`).send(bookCsv(b));
  });
}
