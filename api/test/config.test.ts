import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";

describe("config", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  const f = (n: string, v: string) => { const p = join(dir, n); writeFileSync(p, v); return p; };
  const base = { DATABASE_URL: "postgres://u@db:5432/x", PUBLIC_URL: "https://ef.test/", APP_KEY_FILE: f("k", "a2V5\n") };

  it("Entra e iskluceno ako tajnata e prazna; prazni env vrednosti se ignoriraat", () => {
    const c = loadConfig({ ...base, ENTRA_TENANT_ID: "b4992b6b-a6e9-40b4-b296-9a937bcc6d04", ENTRA_CLIENT_ID: "bc476f85-e234-44f2-a88d-ecd6a420fd54",
      ENTRA_CLIENT_SECRET_FILE: f("empty", ""), BOOTSTRAP_ADMIN_EMAIL: "" });
    expect(c.entra).toBeUndefined();
    expect(c.bootstrapAdminEmail).toBeUndefined();
    expect(c.publicUrl).toBe("https://ef.test");
  });
  it("Entra e vkluceno so tajna (bez nov red)", () => {
    const c = loadConfig({ ...base, ENTRA_TENANT_ID: "b4992b6b-a6e9-40b4-b296-9a937bcc6d04", ENTRA_CLIENT_ID: "bc476f85-e234-44f2-a88d-ecd6a420fd54",
      ENTRA_CLIENT_SECRET_FILE: f("s", "abc\n"), BOOTSTRAP_ADMIN_EMAIL: "Dev@Upstream.mk" });
    expect(c.entra?.clientSecret).toBe("abc");
    expect(c.bootstrapAdminEmail).toBe("dev@upstream.mk");
  });
});
