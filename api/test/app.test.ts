import { describe, it, expect } from "vitest";
import { testDb } from "./helpers.js";
import { buildApp } from "../src/app.js";

describe("API", () => {
  it("/api/health vrakja ok so verzija", async () => {
    const { db } = await testDb();
    const app = await buildApp({ db, version: "test-1", logLevel: "silent" as never });
    const r = await app.inject({ method: "GET", url: "/api/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "ok", version: "test-1", db: "ok" });
  });
});
