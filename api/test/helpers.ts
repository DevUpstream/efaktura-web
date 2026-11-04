import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/types.js";

export async function testDb() {
  const pg = new PGlite();
  const raw = drizzle(pg, { schema });
  await migrate(raw, { migrationsFolder: "drizzle" });
  const db = raw as unknown as Db;
  const { users, clients, partners, items } = schema;
  const [user] = await db.insert(users).values({ email: "dev@upstream.mk", displayName: "Dev", provider: "local", passwordHash: "x", role: "admin" }).returning();
  const [c1] = await db.insert(clients).values({ name: "MC ДООЕЛ", edb: "4030994180119", address: "ул. 1", city: "Скопје", invoicePrefix: "MC", vatNumber: "МК4030994180119", vatPayer: true }).returning();
  const [c2] = await db.insert(clients).values({ name: "УПСТРЕАМ", edb: "4015023508550", address: "ул. 2", city: "Скопје", invoicePrefix: "UPSTRI" }).returning();
  const [p1] = await db.insert(partners).values({ clientId: c1!.id, name: "Купувач А", edb: "4001235555678" }).returning();
  const [p2] = await db.insert(partners).values({ clientId: c2!.id, name: "Купувач Б" }).returning();
  const [vat18] = await db.select().from(schema.vatRates).where(eq(schema.vatRates.code, "S18"));
  return { pg, db, user: user!, c1: c1!, c2: c2!, p1: p1!, p2: p2!, vat18: vat18! };
}
