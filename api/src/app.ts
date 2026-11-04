import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { Db } from "./db/types.js";
import { DomainError } from "./domain/errors.js";

export interface AppDeps { db: Db; version: string; logLevel?: string }

export async function buildApp({ db, version, logLevel = "info" }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: logLevel, redact: ["req.headers.authorization", "req.headers.cookie", "req.headers['x-agent-key']"] },
    trustProxy: true,             // zad Caddy
    bodyLimit: 1024 * 1024,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DomainError) return reply.status(err.status).send({ error: err.code, message: (err as Error).message });
    if ((err as { validation?: unknown }).validation) return reply.status(400).send({ error: "bad_request", message: (err as Error).message });
    req.log.error(err);
    return reply.status(500).send({ error: "internal", message: "Внатрешна грешка. Проверете го дневникот на серверот." });
  });

  app.get("/api/health", async (_req, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { status: "ok", version, db: "ok", time: new Date().toISOString() };
    } catch {
      return reply.status(503).send({ status: "degraded", version, db: "down" });
    }
  });

  return app;
}
