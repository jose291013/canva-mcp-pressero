// backend/server.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import axios from "axios";

const app = express();

/* ===== Middlewares ===== */
app.use(morgan("tiny"));
app.use(express.json({ limit: "20mb" }));

// CORS ouvert (dev). En prod, remplace origin:true par un tableau restreint.
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  })
);

// Préflight générique (facilite les tests depuis Canva / navigateurs)
app.options("*", cors());

/* ===== Health ===== */
app.get("/health", (_req, res) => res.json({ ok: true }));

/* ===== Store en mémoire (demo) ===== */
const store = globalThis._pdfStore || new Map();
globalThis._pdfStore = store;

/* ===== /canva/export : reçoit l’URL PDF de Canva, télécharge et met en mémoire ===== */
app.post("/canva/export", async (req, res) => {
  try {
    const { files = [], sessionId, exportTitle } = req.body || {};
    console.log("📥 /canva/export", { sessionId, firstUrl: files?.[0] });
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ ok: false, message: "No files" });
    }
    if (!sessionId) {
      return res.status(400).json({ ok: false, message: "Missing sessionId" });
    }

    const pdfUrl = files[0];
    const pdfResp = await axios.get(pdfUrl, { responseType: "arraybuffer" });
    const buffer = Buffer.from(pdfResp.data);

    const base =
      process.env.BASE_PUBLIC_URL ||
      "https://canva-mcp-pressero.onrender.com";
    const publicUrl = `${base}/files/${encodeURIComponent(sessionId)}.pdf`;

    store.set(sessionId, {
      buffer,
      filename: "design.pdf",
      url: publicUrl,
      title: exportTitle || "Canva → Pressero",
      at: Date.now(),
    });

    return res.json({ ok: true, url: publicUrl });
  } catch (err) {
    console.error(err?.message || err);
    return res.status(500).json({ ok: false, message: "Export failed" });
  }
});

/* ===== /files/:sessionId.pdf : expose le PDF en HTTPS ===== */
app.get("/files/:sessionId.pdf", (req, res) => {
  const entry = store.get(req.params.sessionId);
  if (!entry?.buffer) {
    return res.status(404).send("Not found");
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Cache-Control", "no-store");
  return res.send(entry.buffer);
});

/* ===== /pressero/upload : (optionnel) dépôt direct depuis Albato en base64 ===== */
app.post("/pressero/upload", async (req, res) => {
  try {
    const { sessionId, filename = "design.pdf", fileBase64 } = req.body || {};
    if (!sessionId || !fileBase64) {
      return res
        .status(400)
        .json({ ok: false, message: "Missing sessionId or fileBase64" });
    }
    const buffer = Buffer.from(fileBase64, "base64");
    const base =
      process.env.BASE_PUBLIC_URL ||
      "https://canva-mcp-pressero.onrender.com";
    const publicUrl = `${base}/files/${encodeURIComponent(sessionId)}.pdf`;

    store.set(sessionId, {
      buffer,
      filename,
      url: publicUrl,
      at: Date.now(),
    });
console.log("✅ stored", sessionId);
    return res.json({ ok: true, url: publicUrl });
  } catch (err) {
    console.error(err?.message || err);
    return res.status(500).json({ ok: false, message: "Upload failed" });
  }
});

/* ===== /pressero/ready : poll depuis Pressero ===== */
app.get("/pressero/ready", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const id = req.query.sessionId;
  const has = id && store.has(id);
  const entry = has ? store.get(id) : null;
  console.log("🔎 ready?", id, "->", !!entry?.url);                        // 👈 debug
  return res.json(entry?.url ? { ready: true, url: entry.url } : { ready: false });
});

/* ===== Start ===== */
const port = process.env.PORT || 10000;
app.listen(port, () => console.log("🚀 Backend listening on", port));
