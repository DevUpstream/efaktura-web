import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { testDb } from "./helpers.js";
import { buildApp } from "../src/app.js";

describe("API", () => {
  it("/api/health vrakja ok so verzija (bez najava)", async () => {
    const { db } = await testDb();
    const app = await buildApp({ db, version: "test-1", logLevel: "silent", publicUrl: "https://ef.test", appKey: randomBytes(32).toString("base64") });
    const r = await app.inject({ method: "GET", url: "/api/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "ok", version: "test-1", db: "ok" });
    expect((await app.inject({ method: "GET", url: "/api/clients" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/auth/entra/login" })).statusCode).toBe(404); // Entra ne e postaven
  });
});
