import { loadConfig } from "./config.js";
import { connect } from "./db/client.js";
import { buildApp } from "./app.js";

const cfg = loadConfig();
const { db, sql, migrate } = connect(cfg.DATABASE_URL, cfg.DATABASE_PASSWORD_FILE);

await migrate();                       // migraciite se idempotentni; se izvrsuvaat pri sekoe startuvanje
const app = await buildApp({ db, version: cfg.APP_VERSION, logLevel: cfg.LOG_LEVEL });
app.log.info({ version: cfg.APP_VERSION }, "migracii OK");

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    app.log.info(`${sig} - gasenje`);
    await app.close();
    await sql.end({ timeout: 5 });
    process.exit(0);
  });
}
await app.listen({ host: "0.0.0.0", port: cfg.PORT });
