import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

const key  = fs.readFileSync(path.resolve(__dirname, "certs/localhost-key.pem"));
const cert = fs.readFileSync(path.resolve(__dirname, "certs/localhost.pem"));

export default defineConfig({
  plugins: [react()],
  server:  { port: 8080, https: { key, cert }, strictPort: true },
  preview: { port: 8080, https: { key, cert }, strictPort: true }
});

