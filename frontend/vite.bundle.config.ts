import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2019",
    minify: true,
    sourcemap: false,
    outDir: "dist",
    lib: {
      entry: "src/main.ts",
      name: "CanvaPresseroApp",
      fileName: () => "app.js",   // ✅ force "app.js"
      formats: ["iife"]
    },
    rollupOptions: { output: { inlineDynamicImports: true } }
  }
});


