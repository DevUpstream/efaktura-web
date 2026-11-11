/**
 * Преглед „Денес“ и состојба на агентот (docs/12).
 * /api/health/agent е јавен (без податоци): за надворешен монитор (на пр. UptimeRobot) што праќа е-пошта кога агентот не работи.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { Decimal as D } from "decimal.js";
import { z } from "zod";
import { agentKeys, clientAccess, clients, registryRequests } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { openItems } from "../domain/payments.js";
import { listDispatches } from "../domain/dispatch.js";
import { assertClientAccess, requireUser } from "../auth/context.js";
import { effectiveModules } from "../domain/modules.js";
import { Id } from "./master.js";

/** Агентот го освежува last_used_at најмногу еднаш во минута; 3 минути без јавување = не работи. */
export const AGENT_STALE_MS = 3 * 60_000;
const rowsOf = (r: unknown) => (Array.isArray(r) ? r : (r as { rows?: unknown[] }).rows ?? []) as Record<string, string | number | null>[];
const todayStr = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Skopje" });
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

export async function agentState(db: Db) {
  const [k] = await db.select({ name: agentKeys.name, last: agentKeys.lastUsedAt }).from(agentKeys).where(eq(agentKeys.isActive, true))
    .orderBy(sql`${agentKeys.lastUsedAt} desc nulls last`).limit(1);
  const [pending] = await db.select({ n: sql<number>`count(*)::int`, oldest: sql<string | null>`min(${registryRequests.createdAt})` })
    .from(registryRequests).where(eq(registryRequests.status, "pending"));
  const ok = !!k?.last && Date.now() - k.last.getTime() < AGENT_STALE_MS;
  return { configured: !!k, ok, name: k?.name ?? null, lastSeenAt: k?.last?.toISOString() ?? null, pendingRequests: pending?.n ?? 0, oldestPending: pending?.oldest ?? null };
}

export async function todayRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.get("/api/health/agent", { logLevel: "silent" }, async (_req, reply) => {
    const a = await agentState(db);
    return reply.status(a.ok ? 200 : 503).send({ agent: a.ok ? "ok" : "down", lastSeenAt: a.lastSeenAt });
  });

  app.get("/api/status", async (req) => {
    requireUser(req);
    return { agent: await agentState(db) };
  });

  app.get("/api/clients/:clientId/today", async (req) => {
    const u = requireUser(req);
    const { clientId } = z.object({ clientId: Id }).parse(req.params);
    await assertClientAccess(db, u, clientId);
    const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
    const [acc] = u.role === "admin" ? [] : await db.select({ m: clientAccess.modules }).from(clientAccess).where(and(eq(clientAccess.clientId, clientId), eq(clientAccess.userId, u.id)));
    const mods = effectiveModules(client!.modules, u.role, acc?.m ?? null);
    const t = todayStr(), week = plus(t, 7);
    const sum = (xs: { remaining: string }[]) => xs.reduce((a, x) => a.plus(x.remaining), new D(0)).toFixed(2);
    const pick = (xs: Awaited<ReturnType<typeof openItems>>) => xs.slice(0, 8).map((x) => ({ id: x.id, number: x.number, partnerName: x.partnerName,
      dueDate: x.dueDate, remaining: x.remaining, daysOverdue: x.daysOverdue }));

    const out: Record<string, unknown> = { date: t, modules: mods };
    if (mods.includes("payments")) {
      const recv = await openItems(db, clientId, "in");
      const overdue = recv.filter((x) => x.daysOverdue > 0).sort((a, b) => Number(b.remaining) - Number(a.remaining));
      const dueSoon = recv.filter((x) => x.daysOverdue === 0 && (x.dueDate ?? x.issueDate) >= t && (x.dueDate ?? x.issueDate) <= week);
      out.receivables = { overdue: { count: overdue.length, amount: sum(overdue), top: pick(overdue) },
        dueSoon: { count: dueSoon.length, amount: sum(dueSoon), top: pick(dueSoon) }, open: { count: recv.length, amount: sum(recv) } };
      const [st] = rowsOf(await db.execute(sql`select count(*)::int n from bank_statement_lines l left join payments y on y.id = l.payment_id
        where l.client_id = ${clientId} and not l.ignored and (l.payment_id is null or y.voided_at is not null)`));
      out.statementLinesOpen = Number(st?.n ?? 0);
    }
    if (mods.includes("payments") && mods.includes("incoming")) {
      const pay = await openItems(db, clientId, "out");
      const overdue = pay.filter((x) => x.daysOverdue > 0).sort((a, b) => Number(b.remaining) - Number(a.remaining));
      const dueSoon = pay.filter((x) => x.daysOverdue === 0 && (x.dueDate ?? x.issueDate) >= t && (x.dueDate ?? x.issueDate) <= week);
      out.payables = { overdue: { count: overdue.length, amount: sum(overdue), top: pick(overdue) }, dueSoon: { count: dueSoon.length, amount: sum(dueSoon), top: pick(dueSoon) } };
    }
    const [inv] = rowsOf(await db.execute(sql`select
        count(*) filter (where status = 'draft' and doc_type <> 'PF')::int drafts,
        count(*) filter (where status = 'issued' and ujp_id is null and source = 'app' and doc_type <> 'PF')::int waiting_ujp,
        min(issue_date) filter (where status = 'issued' and ujp_id is null and source = 'app' and doc_type <> 'PF') oldest_waiting,
        count(*) filter (where ujp_error is not null and ujp_id is null and status not in ('voided','cancelled_draft'))::int ujp_errors
      from invoices where client_id = ${clientId}`));
    out.invoices = { drafts: Number(inv?.drafts ?? 0), waitingUjp: Number(inv?.waiting_ujp ?? 0), oldestWaiting: inv?.oldest_waiting ?? null, ujpErrors: Number(inv?.ujp_errors ?? 0) };
    if (mods.includes("warehouse")) {
      const ds = await listDispatches(db, clientId, { onlyOpen: true });
      out.dispatches = { count: ds.length, oldest: ds.length ? ds[ds.length - 1]!.docDate : null };
    }
    if (mods.includes("crm")) {
      const [f] = rowsOf(await db.execute(sql`select count(*)::int n from partner_notes where client_id = ${clientId}
        and follow_up_at is not null and follow_up_done_at is null and follow_up_at <= ${t}`));
      out.followupsDue = Number(f?.n ?? 0);
    }
    out.agent = await agentState(db);
    return out;
  });
}
