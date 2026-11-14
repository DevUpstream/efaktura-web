/** Праќање на УЈП (docs/15): корисникот бара, агентот (компјутерот со токенот) потпишува и праќа. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import yazl from "yazl";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { agentKeys, clients, invoices } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "../domain/errors.js";
import { agentsForClient, cancelJob, finishJob, invoiceUjpState, queueAll, queueInvoice, takeJobs } from "../domain/ujp-send.js";
import { audit } from "../domain/audit.js";
import { assertClientAccess, requireAdmin, requireUser } from "../auth/context.js";
import { requireAgent } from "./registry.js";
import { Id } from "./master.js";

/** Скриптите на агентот: во сликата /app/agent, во развој ../agent. */
const AGENT_DIR = process.env.AGENT_DIR ?? path.resolve(process.cwd(), existsSync("agent/UjpAgent.psm1") ? "agent" : "../agent");
const PACKAGE_FILES = ["UjpAgent.psm1", "Send-ServerInvoices.ps1", "Install-Agent.ps1"];
const ps = (v: string) => v.replace(/[`"$]/g, (c) => "`" + c);   // PowerShell низа во „…“
const crlf = (t: string) => t.replace(/\r?\n/g, "\r\n");

export async function ujpRoutes(app: FastifyInstance, { db, publicUrl }: { db: Db; publicUrl: string }) {
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

  /** Дали агентот за фирмата е вклучен (за копчето „Вклучи агент“). */
  app.get("/api/clients/:clientId/ujp-agent", async (req) => {
    const u = requireUser(req);
    const { clientId } = z.object({ clientId: Id }).parse(req.params);
    await assertClientAccess(db, u, clientId);
    return agentsForClient(db, clientId);
  });

  /** ZIP за компјутерот на клиентот: скрипти + поставки (без клучот – Install-Agent.ps1 го бара еднаш). Само администратор. */
  app.get("/api/agent-keys/:id/package.zip", async (req, reply) => {
    const u = requireAdmin(req);
    const id = Id.parse((req.params as { id: string }).id);
    const [k] = await db.select().from(agentKeys).where(eq(agentKeys.id, id));
    if (!k) throw new DomainError("not_found", "Клучот не постои.", 404);
    const firms = k.clientIds ? await db.select({ name: clients.name, edb: clients.edb }).from(clients).where(inArray(clients.id, k.clientIds)) : [];
    const zip = new yazl.ZipFile();
    const dir = "eFaktura-agent";
    for (const f of PACKAGE_FILES) zip.addBuffer(readFileSync(path.join(AGENT_DIR, f)), `${dir}/${f}`);
    const cfg = ["\uFEFF@{",
      "    # е-Фактура агент – поставки (docs/15). Install-Agent.ps1 ги пополнува сертификатот и ЕУЈП ИД.",
      `    # Клуч: „${ps(k.name)}“. Фирми: ${firms.length ? firms.map((f) => `${f.name} (${f.edb})`).join(", ") : "сите (бирото)"}`,
      "    # Тест-околина на УЈП. Продукција: само кога УЈП ќе ги објави адресите (AllowProduction = $true).",
      '    ApiBaseUrl = "https://efakturatest.ujp.gov.mk/einvoice_api"',
      '    SendUrl    = "https://efakturatest.ujp.gov.mk/JSONReceiver/api/v1/sales-invoices/send"',
      "    AllowProduction = $false",
      `    ServerUrl  = "${ps(publicUrl)}"`,
      '    EujpId = ""', "    EujpIdByEdb = @{}", '    CertThumbprint = ""', '    CertSerialNumber = ""', "    Tolerance = 0.05", "}", ""].join("\n");
    zip.addBuffer(Buffer.from(crlf(cfg), "utf8"), `${dir}/agent.config.psd1`);
    zip.addBuffer(Buffer.from(crlf(["\uFEFFе-Фактура агент – инсталација (еднаш, на компјутерот со токенот)", "",
      "1. Инсталирај PowerShell 7:  winget install Microsoft.PowerShell",
      "2. Инсталирај го драјверот на токенот; вметни го токенот.",
      "3. Кај УЈП: сертификатот од токенот асоцирај го со корисникот (апликација DigPotpis).",
      "4. Распакувај ја оваа папка, на пр. во C:\\eFaktura-agent.",
      "5. Отвори PowerShell 7 во папката и пушти:  pwsh -ExecutionPolicy Bypass -File .\\Install-Agent.ps1",
      "   Го бара клучот за агентот (од администраторот) и ЕУЈП ИД (efakturatest -> профил -> Кориснички податоци).",
      "", "Потоа агентот стартува сам при најава на Windows. Во апликацијата: „Прати на УЈП“; ако агентот не работи – „Вклучи агент“.", ""].join("\n")), "utf8"),
      `${dir}/УПАТСТВО.txt`);
    zip.end();
    await audit(db, { userId: u.id, ip: req.ip }, { entity: "agent_key", entityId: k.id, action: "package" });
    const out = new PassThrough(); zip.outputStream.pipe(out);
    return reply.header("content-type", "application/zip").header("content-disposition", `attachment; filename="eFaktura-agent-${k.id}.zip"`)
      .header("cache-control", "no-store").send(out);
  });

  /* ------------------------------------------------------------- агент */
  app.post("/api/agent/ujp-jobs/take", { logLevel: "silent" }, async (req) => {
    const k = await requireAgent(db, req);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(20).default(5) }).parse(req.body ?? {});
    return takeJobs(db, k, limit);
  });

  /** Агентот при старт: верзија, компјутер, сертификат (за прегледот на агентите и рокот на сертификатот). */
  app.post("/api/agent/hello", async (req) => {
    const k = await requireAgent(db, req);
    const b = z.object({ version: z.string().trim().max(20), computer: z.string().trim().max(100).nullish(), user: z.string().trim().max(100).nullish(),
      certSubject: z.string().trim().max(300).nullish(), certSerial: z.string().trim().max(80).nullish(), certNotAfter: z.string().trim().max(40).nullish(),
      eujpId: z.string().trim().max(20).nullish() }).parse(req.body);
    const { version, ...rest } = b;
    const info = Object.fromEntries(Object.entries(rest).filter(([, v]) => v)) as Record<string, string>;
    await db.update(agentKeys).set({ agentVersion: version, agentInfo: info, lastUsedAt: new Date() }).where(eq(agentKeys.id, k.id));
    const firms = k.clientIds ? await db.select({ name: clients.name, edb: clients.edb }).from(clients).where(inArray(clients.id, k.clientIds)) : null;
    return { name: k.name, firms };   // null = бирото (сите фирми)
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
