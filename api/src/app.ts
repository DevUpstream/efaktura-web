import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { sql } from "drizzle-orm";
import { ZodError } from "zod";
import type { Db } from "./db/types.js";
import { DomainError } from "./domain/errors.js";
import { parseKey } from "./auth/crypto.js";
import { registerAuthContext } from "./auth/context.js";
import type { OidcProvider } from "./auth/entra.js";
import { authRoutes } from "./routes/auth.js";
import { userRoutes } from "./routes/users.js";

export interface AppDeps {
  db: Db; version: string; logLevel?: string;
  publicUrl: string; appKey: string; bootstrapAdminEmail?: string;
  entra?: { provider: OidcProvider; tenantId: string };
}

export async function buildApp(d: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: d.logLevel ?? "info", redact: ["req.headers.authorization", "req.headers.cookie"] },
    trustProxy: true,             // zad Caddy
    bodyLimit: 1024 * 1024,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DomainError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) return reply.status(400).send({ error: "bad_request", message: "Неисправни податоци.", issues: err.issues });
    const e = err as Error & { statusCode?: number; validation?: unknown };
    if (e.statusCode === 429) return reply.status(429).send({ error: "rate_limited", message: "Премногу обиди. Почекајте една минута." });
    if (e.validation || e.statusCode === 400) return reply.status(400).send({ error: "bad_request", message: e.message });
    req.log.error(err);
    return reply.status(500).send({ error: "internal", message: "Внатрешна грешка. Проверете го дневникот на серверот." });
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  registerAuthContext(app, d.db);

  app.get("/api/health", async (_req, reply) => {
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
  return app;
}
