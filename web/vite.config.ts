import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Presmetkite se ISTIOT kod kako na serverot (api/src/domain/calc.ts) - za pregled vo zivo.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@calc": fileURLToPath(new URL("../api/src/domain/calc.ts", import.meta.url)),
      "decimal.js": fileURLToPath(new URL("./node_modules/decimal.js/decimal.mjs", import.meta.url)),
    },
  },
  server: { proxy: { "/api": "http://localhost:8080" } },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 600 },
});
