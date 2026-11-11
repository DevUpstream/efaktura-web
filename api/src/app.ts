import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { ZodError } from "zod";
import type { Db } from "./db/types.js";
import { zodMessage } from "./domain/zod-mk.js";
import { DomainError } from "./domain/errors.js";
import { parseKey } from "./auth/crypto.js";
import { registerAuthContext } from "./auth/context.js";
import type { OidcProvider } from "./auth/entra.js";
import { authRoutes } from "./routes/auth.js";
import { userRoutes } from "./routes/users.js";
import { masterRoutes } from "./routes/master.js";
import { invoiceRoutes } from "./routes/invoices.js";
import { registryRoutes } from "./routes/registry.js";
import { crmRoutes } from "./routes/crm.js";
import { stockRoutes } from "./routes/stock.js";
import { productionRoutes } from "./routes/production.js";
import { paymentRoutes } from "./routes/payments.js";
import { recurringRoutes } from "./routes/recurring.js";
import { dispatchRoutes } from "./routes/dispatch.js";
import { receivableRoutes } from "./routes/receivables.js";
import { todayRoutes } from "./routes/today.js";
import { exportRoutes } from "./routes/export.js";
import { vatBookRoutes } from "./routes/vatbooks.js";

export interface AppDeps {
  db: Db; version: string; logLevel?: string;
  publicUrl: string; appKey: string; bootstrapAdminEmail?: string;
  entra?: { provider: OidcProvider; tenantId: string };
  webDir?: string;      // izgradenata React aplikacija (index.html + assets)
}

export async function buildApp(d: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: d.logLevel ?? "info", redact: ["req.headers.authorization", "req.headers.cookie"] },
    trustProxy: true,             // zad Caddy
    bodyLimit: 1024 * 1024,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DomainError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) return reply.status(400).send({ error: "bad_request", message: zodMessage(err.issues), issues: err.issues });
    const e = err as Error & { statusCode?: number; validation?: unknown };
    if (e.statusCode === 429) return reply.status(429).send({ error: "rate_limited", message: "Премногу обиди. Почекајте една минута." });
    if (e.validation || e.statusCode === 400) return reply.status(400).send({ error: "bad_request", message: e.message });
    req.log.error(err);
    return reply.status(500).send({ error: "internal", message: "Внатрешна грешка. Проверете го дневникот на серверот." });
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  registerAuthContext(app, d.db);

  // bez zapis vo dnevnikot: proverkata na Docker/Caddy/nadvoresniot monitor (na sekoi nekolku sekundi)
  app.get("/api/health", { logLevel: "silent" }, async (_req, reply) => {
    try {
      await d.db.execute(sql`select 1`);
      return { status: "ok", version: d.version, db: "ok", time: new Date().toISOString() };
    } catch {
      return reply.status(503).send({ status: "degraded", version: d.version, db: "down" });
    }
  });

  await authRoutes(app, { db: d.db, appKey: parseKey(d.appKey), publicUrl: d.publicUrl,
    bootstrapAdminEmail: d.bootstrapAdminEmail, entra: d.entra });
  await userRoutes(app, { db: d.db, publicUrl: d.publicUrl });
  await masterRoutes(app, { db: d.db });
  await invoiceRoutes(app, { db: d.db });
  await registryRoutes(app, { db: d.db });
  await crmRoutes(app, { db: d.db });
  await stockRoutes(app, { db: d.db });
  await productionRoutes(app, { db: d.db });
  await paymentRoutes(app, { db: d.db });
  await recurringRoutes(app, { db: d.db });
  await dispatchRoutes(app, { db: d.db });
  await receivableRoutes(app, { db: d.db });
  await todayRoutes(app, { db: d.db });
  await exportRoutes(app, { db: d.db });
  await vatBookRoutes(app, { db: d.db });
  // Veb-aplikacija: assets so dolg kes (imeto ima hash), index.html bez kes; SPA - nepoznatite pateki -> index.html
  if (d.webDir && existsSync(d.webDir)) {
    await app.register(fastifyStatic, {
      root: resolve(d.webDir), wildcard: false, index: false,
      setHeaders: (res, path) => res.setHeader("cache-control", path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache"),
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== "GET" || req.url.startsWith("/api/")) return reply.status(404).send({ error: "not_found", message: "Не постои." });
      return reply.header("cache-control", "no-cache").sendFile("index.html");
    });
  }
  return app;
}
