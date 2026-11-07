import { loadConfig } from "./config.js";
import { connect } from "./db/client.js";
import { buildApp } from "./app.js";
import { entraProvider } from "./auth/entra.js";
import { purgeExpired } from "./auth/sessions.js";
import { runRecurring } from "./domain/recurring.js";

const cfg = loadConfig();
const { db, sql, migrate } = connect(cfg.databaseUrl, cfg.databasePasswordFile);

await migrate();                       // migraciite se idempotentni; se izvrsuvaat pri sekoe startuvanje
const app = await buildApp({
  db, version: cfg.version, logLevel: cfg.logLevel, publicUrl: cfg.publicUrl, appKey: cfg.appKey,
  bootstrapAdminEmail: cfg.bootstrapAdminEmail,
  webDir: process.env.WEB_DIR ?? "/app/public",
  entra: cfg.entra ? { provider: entraProvider(cfg.entra), tenantId: cfg.entra.tenantId } : undefined,
});
app.log.info({ version: cfg.version, entra: !!cfg.entra }, "migracii OK");

const purge = setInterval(() => purgeExpired(db).catch((e) => app.log.warn(e, "purge")), 3600_000);
// povtoruvacki fakturi: pri start i na sekoj cas (samo NACRTI; docs/10)
const recur = () => runRecurring(db).then((r) => r.created.length && app.log.info({ created: r.created.length }, "povtoruvacki"), (e) => app.log.warn(e, "povtoruvacki"));
setTimeout(recur, 30_000);
const recurTimer = setInterval(recur, 3600_000);
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    app.log.info(`${sig} - gasenje`);
    clearInterval(purge); clearInterval(recurTimer);
    await app.close();
    await sql.end({ timeout: 5 });
    process.exit(0);
  });
}
await app.listen({ host: "0.0.0.0", port: cfg.port });
