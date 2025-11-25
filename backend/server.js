// backend/server.js
import express from "express";
import cors from "cors";          // <-- un seul import cors
import morgan from "morgan";
import axios from "axios";

const app = express();

app.use(morgan("tiny"));
app.use(express.json({ limit: "20mb" }));

// CORS ouvert (debug) : accepte Canva + tout origine
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  })
);

// (optionnel) préflight explicite
app.options("/canva/export", cors());

// Health
app.get("/health", (_req, res) => res.json({ ok: true }));

// Reçoit l’URL du PDF exporté par Canva et relaie vers Albato (si ALBATO_WEBHOOK_URL)
app.post("/canva/export", async (req, res) => {
  try {
    console.log("📥 Body reçu:", req.body);

    const raw = Array.isArray(req.body?.files) ? req.body.files : [];
    const files = raw.filter((u) => typeof u === "string" && /^https?:\/\//.test(u));
    if (files.length === 0) {
      return res.status(400).json({ ok: false, message: "No files" });
    }

    const pdfUrl = files[0];
    const pdfResp = await axios.get(pdfUrl, { responseType: "arraybuffer" });
    const pdfB64 = Buffer.from(pdfResp.data).toString("base64");

    const albatoUrl = process.env.ALBATO_WEBHOOK_URL;
    if (albatoUrl) {
      await axios.post(albatoUrl, {
        sessionId: req.body.sessionId,
        exportTitle: req.body.exportTitle,
        filename: "design.pdf",
        fileBase64: pdfB64,
      });
    }

    return res.json({
      ok: true,
      url: "https://example.com/designs/" + (req.body.sessionId || "sample") + ".pdf",
    });
  } catch (e) {
    console.error(e?.message || e);
    return res.status(500).json({ ok: false, message: "Export failed" });
  }
});

const port = process.env.PORT || 10000;
// --- Mémoire simple (démos) : sessionId -> { url | buffer } ---
const store = new Map();

// Expose un PDF en HTTPS par sessionId (demo)
// GET /files/:sessionId.pdf -> retourne le PDF téléchargé par Albato
app.get("/files/:sessionId.pdf", (req, res) => {
  const { sessionId } = req.params;
  const entry = store.get(sessionId);
  if (!entry || !entry.buffer) {
    return res.status(404).send("Not found");
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Cache-Control", "no-store");
  return res.send(entry.buffer);
});

// Albato -> Backend : dépose le PDF (base64) + sessionId
app.post("/pressero/upload", async (req, res) => {
  try {
    const { sessionId, filename = "design.pdf", fileBase64 } = req.body || {};
    if (!sessionId || !fileBase64) {
      return res.status(400).json({ ok: false, message: "Missing sessionId or fileBase64" });
    }
    const buf = Buffer.from(fileBase64, "base64");
    // on mémorise le buffer et une URL publique pour le front Pressero
    const publicUrl = `${process.env.BASE_PUBLIC_URL || "https://canva-mcp-pressero.onrender.com"}/files/${encodeURIComponent(sessionId)}.pdf`;
    store.set(sessionId, { buffer: buf, filename, url: publicUrl, at: Date.now() });
    return res.json({ ok: true, url: publicUrl });
  } catch (e) {
    console.error(e?.message || e);
    return res.status(500).json({ ok: false, message: "Upload failed" });
  }
});

// Front Pressero -> poll si prêt
// GET /pressero/ready?sessionId=...
app.get("/pressero/ready", async (req, res) => {
  const sessionId = req.query.sessionId;
  const entry = sessionId ? store.get(sessionId) : null;
  if (entry?.url) {
    return res.json({ ready: true, url: entry.url });
  }
  return res.json({ ready: false });
});

app.listen(port, () => console.log("🚀 Backend listening on", port));
