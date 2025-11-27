import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: path.resolve(__dirname, "src/main.ts"),
      name: "CanvaPresseroApp",          // nom global (n’impacte pas Canva)
      fileName: () => "app.js",
      formats: ["iife"]                  // bundle unique pour Canva
    },
    rollupOptions: {
      output: { inlineDynamicImports: true } // pas de chunks
    },
    sourcemap: false
  }
});



