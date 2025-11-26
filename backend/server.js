// backend/server.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import axios from "axios";

const app = express();
app.use(morgan("tiny"));
app.use(express.json({ limit: "20mb" }));

app.use(cors({ origin: true, methods: ["GET","POST","OPTIONS"] }));

// Mémoire: sessionId -> { buffer, url, at }
const store = global._pdfStore || new Map();
global._pdfStore = store;

// Health
app.get("/health", (_req, res) => res.json({ ok: true }));

// Canva -> enregistre le PDF pour un sessionId
app.post("/canva/export", async (req, res) => {
  try {
    const { files = [], sessionId, exportTitle } = req.body || {};
    if (!Array.isArray(files) || !files.length) return res.status(400).json({ ok:false, message:"No files" });
    if (!sessionId) return res.status(400).json({ ok:false, message:"Missing sessionId" });

    const pdfUrl = files[0];
    const r = await axios.get(pdfUrl, { responseType: "arraybuffer" });
    const buf = Buffer.from(r.data);

    const base = process.env.BASE_PUBLIC_URL || "https://canva-mcp-pressero.onrender.com";
    const publicUrl = `${base}/files/${encodeURIComponent(sessionId)}.pdf`;

    store.set(sessionId, { buffer: buf, url: publicUrl, title: exportTitle || "", at: Date.now() });
    return res.json({ ok: true, url: publicUrl });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, message:"Export failed" });
  }
});

// Pressero -> polling
app.get("/pressero/ready", (req, res) => {
  const sessionId = req.query.sessionId;
  const entry = sessionId ? store.get(sessionId) : null;
  if (entry?.url) return res.json({ ready:true, url: entry.url });
  return res.json({ ready:false });
});

// Pressero -> clear (après injection)
app.post("/pressero/clear", (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId) store.delete(sessionId);
  return res.json({ ok:true });
});

// Fichier public
app.get("/files/:sessionId.pdf", (req, res) => {
  const entry = store.get(req.params.sessionId);
  if (!entry?.buffer) return res.status(404).send("Not found");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Cache-Control", "no-store");
  return res.send(entry.buffer);
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("🚀 Backend listening on", port));


