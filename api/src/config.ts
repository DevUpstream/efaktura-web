import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().url(),                  // bez lozinka
  DATABASE_PASSWORD_FILE: z.string().optional(),   // Docker secret
  APP_VERSION: z.string().default("dev"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});
export type Config = z.infer<typeof Env>;

export function loadConfig(env = process.env): Config {
  const r = Env.safeParse(env);
  if (!r.success) {
    throw new Error("Neispravna konfiguracija: " + r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return r.data;
}
