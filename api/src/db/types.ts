import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema.js";
/** Zaednicki tip za postgres-js (produkcija) i PGlite (testovi). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
