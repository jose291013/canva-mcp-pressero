import { defineConfig } from "vite";

// on sort le build directement dans /public/app
export default defineConfig({
  base: "./",
  build: {
    outDir: "../public/app",
    emptyOutDir: true
  }
});
