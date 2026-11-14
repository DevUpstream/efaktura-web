/**
 * Праќање на УЈП преку агентот (docs/15).
 * Серверот не може да стигне до УЈП (IP филтер), а потписот бара USB токен -> агентот на компјутерот со токенот:
 *   1. зема задачи (take): серверот го гради JSON и ја означува задачата „sending“;
 *   2. ги освежува продавачот/купувачот од регистарот на УЈП, потпишува (JWS RS256) и праќа;
 *   3. го враќа резултатот (result): EUID, QR, време -> фактурата; грешка -> порака кај фактурата.
 * Фактура не се праќа двапати: една активна задача по фактура (уникатен индекс) и проверка на EUID.
 */
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { agentKeys, invoices, ujpJobs, ujpLog } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "./errors.js";
import { audit, type Actor } from "./audit.js";
import { buildInvoiceUjp } from "./ujp-payload.js";

/** Задача „sending“ подолго од ова: агентот можеби пратил, а не вратил одговор -> проверка на УЈП пред повторно. */
export const STUCK_MINUTES = 15;

/** „Прати на УЈП“ за една фактура. Проверките (problems) мора да се чисти; чекање на оригиналот е дозволено. */
export async function queueInvoice(db: Db, invoiceId: number, actor: Actor & { userId: number }) {
  const b = await buildInvoiceUjp(db, invoiceId);
  if (b.problems.length) throw new DomainError("validation", `Фактурата не е подготвена за УЈП:\n– ${b.problems.join("\n– ")}`, 422);
  const [inv] = await db.select({ clientId: invoices.clientId, number: invoices.number }).from(invoices).where(eq(invoices.id, invoiceId));
  try {
    const [j] = await db.insert(ujpJobs).values({ invoiceId, clientId: inv!.clientId, queuedBy: actor.userId, note: b.waitFor }).returning();
    await db.update(invoices).set({ ujpError: null }).where(eq(invoices.id, invoiceId));
    await audit(db, actor, { clientId: inv!.clientId, entity: "invoice", entityId: invoiceId, action: "ujp_queue", changes: { job: j!.id } });
    return { job: j!, waitFor: b.waitFor };
  } catch (e) {
    const x = e as { code?: string; message?: string; cause?: { code?: string; message?: string } };
    if ([x.code, x.cause?.code, x.message, x.cause?.message].some((v) => /23505|ujp_jobs_active_uq/.test(String(v ?? ""))))
      throw new DomainError("conflict", `Фактурата ${inv!.number} веќе чека за праќање.`, 409);
    throw e;
  }
}

/** Сите издадени, неиспратени фактури на фирмата што се подготвени (за копчето „Прати ги сите“). */
export async function queueAll(db: Db, clientId: number, actor: Actor & { userId: number }) {
  const rows = await db.select({ id: invoices.id, number: invoices.number }).from(invoices).where(and(eq(invoices.clientId, clientId),
    inArray(invoices.status, ["issued", "json_exported", "rejected"]), isNull(invoices.ujpId), eq(invoices.source, "app"), ne(invoices.docType, "PF"),
    sql`not exists (select 1 from ujp_jobs j where j.invoice_id = ${invoices.id} and j.status in ('queued','sending'))`)).orderBy(asc(invoices.id));
  const queued: string[] = [], skipped: { number: string | null; problems: string[] }[] = [];
  for (const r of rows) {
    try { await queueInvoice(db, r.id, actor); queued.push(r.number ?? String(r.id)); }
    catch (e) { skipped.push({ number: r.number, problems: (e as Error).message.split("\n– ").slice(1) }); }
  }
  return { queued, skipped };
}

/** Откажи задача што чека; „sending“ – само ако е заглавена (агентот не вратил одговор). */
export async function cancelJob(db: Db, invoiceId: number, actor: Actor & { userId: number }) {
  const [j] = await db.select().from(ujpJobs).where(and(eq(ujpJobs.invoiceId, invoiceId), inArray(ujpJobs.status, ["queued", "sending"])));
  if (!j) throw new DomainError("not_found", "Нема задача што чека.", 404);
  if (j.status === "sending" && Date.now() - j.takenAt!.getTime() < STUCK_MINUTES * 60_000)
    throw new DomainError("conflict", "Агентот токму сега ја праќа фактурата. Почекајте.", 409);
  await db.update(ujpJobs).set({ status: "cancelled", doneAt: new Date(), note: j.status === "sending" ? "Откажано по заглавено праќање – проверете на УЈП дали е примена." : j.note })
    .where(eq(ujpJobs.id, j.id));
  await audit(db, actor, { clientId: j.clientId, entity: "invoice", entityId: invoiceId, action: "ujp_cancel", changes: { job: j.id, was: j.status } });
  return { ok: true };
}

/** Агентот зема задачи. Секоја се гради сега (свежи податоци); со проблем -> error без праќање; чека оригинал -> останува. */
export async function takeJobs(db: Db, agent: { id: number; clientIds: number[] | null }, limit = 10) {
  const agentKeyId = agent.id;
  // агент на клиент: само фактури од неговите фирми (неговиот токен); бирото (null): сите
  const q = await db.select().from(ujpJobs).where(and(eq(ujpJobs.status, "queued"), agent.clientIds ? inArray(ujpJobs.clientId, agent.clientIds) : undefined))
    .orderBy(asc(ujpJobs.invoiceId)).limit(50);
  const out: { jobId: number; invoiceId: number; number: string; sellerEdb: string; docType: string; payload: unknown }[] = [];
  for (const j of q) {
    if (out.length >= limit) break;
    const b = await buildInvoiceUjp(db, j.invoiceId);
    if (b.problems.length) {
      const msg = `Не е испратено (проверка пред праќање): ${b.problems.join(" ")}`;
      await db.update(ujpJobs).set({ status: "error", doneAt: new Date(), agentKeyId, note: msg }).where(eq(ujpJobs.id, j.id));
      await db.update(invoices).set({ ujpError: msg }).where(eq(invoices.id, j.invoiceId));
      continue;
    }
    if (b.waitFor) { if (j.note !== b.waitFor) await db.update(ujpJobs).set({ note: b.waitFor }).where(eq(ujpJobs.id, j.id)); continue; }
    // атомски: само ако уште чека (два агента не ја земаат истата)
    const [t] = await db.update(ujpJobs).set({ status: "sending", takenAt: new Date(), agentKeyId, note: null })
      .where(and(eq(ujpJobs.id, j.id), eq(ujpJobs.status, "queued"))).returning();
    if (!t) continue;
    const [inv] = await db.select({ number: invoices.number }).from(invoices).where(eq(invoices.id, j.invoiceId));
    out.push({ jobId: j.id, invoiceId: j.invoiceId, number: inv!.number ?? "", sellerEdb: b.sellerEdb, docType: b.docTypeCode!, payload: b.payload });
  }
  return out;
}

export interface JobResult { ok: boolean; httpStatus?: number | null; euid?: string | null; qrLink?: string | null; timestamp?: string | null;
  message?: string | null; request?: string | null }

/** Резултат од агентот. Успех -> EUID/QR/време на фактурата и статус „Качена на УЈП“ (освен сторнирана/корегирана). */
export async function finishJob(db: Db, jobId: number, agentKeyId: number, r: JobResult) {
  return db.transaction(async (tx) => {
    const [j] = await tx.select().from(ujpJobs).where(eq(ujpJobs.id, jobId)).for("update");
    if (!j || j.status !== "sending") throw new DomainError("not_found", "Задачата не постои или не е во праќање.", 404);
    const ok = r.ok && !!r.euid;
    const msg = ok ? null : (r.message || `HTTP ${r.httpStatus ?? "?"}`).slice(0, 4000);
    await tx.insert(ujpLog).values({ invoiceId: j.invoiceId, clientId: j.clientId, action: "send", success: ok, httpStatus: r.httpStatus ?? null,
      euid: ok ? r.euid! : null, message: (r.message ?? "").slice(0, 60000) || null, request: r.request ?? null });
    await tx.update(ujpJobs).set({ status: ok ? "sent" : "error", doneAt: new Date(), note: msg }).where(eq(ujpJobs.id, j.id));
    if (ok) {
      const ts = r.timestamp && !Number.isNaN(Date.parse(r.timestamp)) ? new Date(r.timestamp) : null;
      await tx.update(invoices).set({ ujpId: r.euid!, ujpQrLink: r.qrLink ?? null, ujpTimestamp: ts, ujpSentAt: new Date(), ujpError: null,
        status: sql`case when ${invoices.status} in ('issued','json_exported','rejected') then 'sent_to_ujp'::invoice_status else ${invoices.status} end` })
        .where(eq(invoices.id, j.invoiceId));
    } else await tx.update(invoices).set({ ujpError: msg }).where(eq(invoices.id, j.invoiceId));
    await audit(tx as unknown as Db, { agentKeyId }, { clientId: j.clientId, entity: "invoice", entityId: j.invoiceId, action: ok ? "ujp_sent" : "ujp_error",
      changes: ok ? { euid: r.euid } : { http: r.httpStatus ?? null, message: msg } });
    return { ok };
  });
}

/** Агент активен = јавил во последните 3 мин. (агентот праша на секои 10 с; lastUsedAt се запишува најмногу еднаш во минута). */
export const AGENT_ACTIVE_MS = 3 * 60_000;

/** Агенти што можат да пратат за оваа фирма: врзани за неа или на бирото (без ограничување). */
export async function agentsForClient(db: Db, clientId: number) {
  const ks = await db.select({ id: agentKeys.id, name: agentKeys.name, lastUsedAt: agentKeys.lastUsedAt, clientIds: agentKeys.clientIds, agentVersion: agentKeys.agentVersion })
    .from(agentKeys).where(and(eq(agentKeys.isActive, true), sql`(${agentKeys.clientIds} is null or ${clientId} = any(${agentKeys.clientIds}))`));
  const list = ks.map((k) => ({ name: k.name, own: !!k.clientIds, lastUsedAt: k.lastUsedAt, version: k.agentVersion,
    active: !!k.lastUsedAt && Date.now() - k.lastUsedAt.getTime() < AGENT_ACTIVE_MS }));
  return { active: list.some((k) => k.active), agents: list };
}

/** За екранот на фактурата: JSON, проверки, задачи и записи. */
export async function invoiceUjpState(db: Db, invoiceId: number) {
  const b = await buildInvoiceUjp(db, invoiceId);
  const jobs = await db.select().from(ujpJobs).where(eq(ujpJobs.invoiceId, invoiceId)).orderBy(desc(ujpJobs.id)).limit(10);
  const log = await db.select({ id: ujpLog.id, at: ujpLog.createdAt, success: ujpLog.success, httpStatus: ujpLog.httpStatus, euid: ujpLog.euid, message: ujpLog.message })
    .from(ujpLog).where(eq(ujpLog.invoiceId, invoiceId)).orderBy(desc(ujpLog.id)).limit(20);
  const active = jobs.find((x) => x.status === "queued" || x.status === "sending") ?? null;
  const stuck = active?.status === "sending" && Date.now() - active.takenAt!.getTime() > STUCK_MINUTES * 60_000;
  const [inv] = await db.select({ clientId: invoices.clientId }).from(invoices).where(eq(invoices.id, invoiceId));
  return { ...b, jobs, log, active, stuck, agent: await agentsForClient(db, inv!.clientId) };
}
