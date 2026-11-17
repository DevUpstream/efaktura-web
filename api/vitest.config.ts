import { defineConfig } from "vitest/config";

// Секој тест прави нова PGlite база со сите миграции (0000–0023). На CI тоа трае ~3–5 s,
// па стандардните 5 s не се доволни (17.11.2026: КИФ/КУФ и увоз паднаа на 5,1 s).
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 30_000 } });
