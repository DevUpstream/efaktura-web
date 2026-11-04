import { readFileSync } from "node:fs";
import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().url(),                  // bez lozinka
  DATABASE_PASSWORD_FILE: z.string().optional(),   // Docker secret
  APP_VERSION: z.string().default("dev"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  PUBLIC_URL: z.string().url(),                    // npr. https://92-5-149-62.sslip.io
  APP_KEY_FILE: z.string(),                        // 32 bajti base64: kolacinja i TOTP tajni
  BOOTSTRAP_ADMIN_EMAIL: z.preprocess((v) => v || undefined, z.string().email().optional()), // prv administrator (samo dodeka nema admin)
  ENTRA_TENANT_ID: z.preprocess((v) => v || undefined, z.string().uuid().optional()),
  ENTRA_CLIENT_ID: z.preprocess((v) => v || undefined, z.string().uuid().optional()),
  ENTRA_CLIENT_SECRET_FILE: z.string().optional(),
});
export type Env = z.infer<typeof Env>;

export interface Config {
  env: Env["NODE_ENV"]; port: number; version: string; logLevel: Env["LOG_LEVEL"];
  databaseUrl: string; databasePasswordFile?: string;
  publicUrl: string; appKey: string; bootstrapAdminEmail?: string;
  entra?: { tenantId: string; clientId: string; clientSecret: string };
}

const readSecret = (f: string) => readFileSync(f, "utf8").trim();

export function loadConfig(env = process.env): Config {
  const r = Env.safeParse(env);
  if (!r.success) {
    throw new Error("Neispravna konfiguracija: " + r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const e = r.data;
  // prazna datoteka so tajna = najavata so Microsoft e isklucena
  const entraSecret = e.ENTRA_CLIENT_SECRET_FILE ? readSecret(e.ENTRA_CLIENT_SECRET_FILE) : "";
  const entra = e.ENTRA_TENANT_ID && e.ENTRA_CLIENT_ID && entraSecret
    ? { tenantId: e.ENTRA_TENANT_ID, clientId: e.ENTRA_CLIENT_ID, clientSecret: entraSecret }
    : undefined;
  return {
    env: e.NODE_ENV, port: e.PORT, version: e.APP_VERSION, logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL, databasePasswordFile: e.DATABASE_PASSWORD_FILE,
    publicUrl: e.PUBLIC_URL.replace(/\/$/, ""), appKey: readSecret(e.APP_KEY_FILE),
    bootstrapAdminEmail: e.BOOTSTRAP_ADMIN_EMAIL?.toLowerCase(), entra,
  };
}
