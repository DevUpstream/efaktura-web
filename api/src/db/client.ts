import { readFileSync } from "node:fs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as schema from "./schema.js";
import type { Db } from "./types.js";

/** DATABASE_URL bez lozinka + DATABASE_PASSWORD_FILE (Docker secret). Lozinkata nikogas ne e vo env/logovi. */
export function connect(url: string, passwordFile?: string) {
  const password = passwordFile ? readFileSync(passwordFile, "utf8").trim() : undefined;
  const sql = postgres(url, { password, max: 5, idle_timeout: 30, connect_timeout: 10, onnotice: () => {} });
  const db = drizzle(sql, { schema }) as unknown as Db;
  return { db, sql, migrate: () => migrate(drizzle(sql), { migrationsFolder: process.env.MIGRATIONS_DIR ?? "drizzle" }) };
}
