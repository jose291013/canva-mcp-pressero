// backend/server.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import axios from "axios";
import cookieParser from "cookie-parser";
import crypto from "crypto";

const app = express();
app.use(morgan("tiny"));
app.use(express.json({ limit: "20mb" }));
app.use(cookieParser());

// CORS avec credentials
app.use(
  cors({
    origin: true,                 // ou liste précise de tes origines
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,            // << IMPORTANT
    maxAge: 86400,
  })
);

// helpers cookie SameSite=None; Secure
function setSidCookie(res, sid) {
  res.cookie("sid", sid, {
    httpOnly: false,
    sameSite: "none",
    secure: true,
    path: "/",
    maxAge: 1000 * 60 * 60 * 4, // 4h
  });
}
function getOrCreateSid(req, res) {
  let sid = req.cookies?.sid;
  if (!sid) {
    sid = crypto.randomUUID();
    setSidCookie(res, sid);
  }
  return sid;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

// mémoire: sid -> { buffer, url, at, title }
const store = global._pdfStore || new Map();
global._pdfStore = store;

// POST /canva/export  => stocke par sessionId (obligatoire)
app.post("/canva/export", async (req, res) => {
  try {
    const { files = [], sessionId, exportTitle } = req.body || {};
    if (!Array.isArray(files) || !files.length)
      return res.status(400).json({ ok:false, message:"No files" });
    if (!sessionId || typeof sessionId !== "string")
      return res.status(400).json({ ok:false, message:"Missing sessionId" });

    const pdfUrl = files[0];
    const pdfResp = await axios.get(pdfUrl, { responseType: "arraybuffer" });
    const buf = Buffer.from(pdfResp.data);

    const base = process.env.BASE_PUBLIC_URL || "https://canva-mcp-pressero.onrender.com";
    const publicUrl = `${base}/files/${encodeURIComponent(sessionId)}.pdf`;

    store.set(sessionId, { buffer: buf, filename: "design.pdf", url: publicUrl, at: Date.now(), title: exportTitle || "" });

    return res.json({ ok: true, url: publicUrl });
  } catch (e) {
    console.error(e?.message || e);
    return res.status(500).json({ ok:false, message:"Export failed" });
  }
});

// Fichier exposé publiquement
app.get("/files/:sid.pdf", (req, res) => {
  const entry = store.get(req.params.sid);
  if (!entry?.buffer) return res.status(404).send("Not found");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Cache-Control", "no-store");
  res.send(entry.buffer);
});

// GET /pressero/ready?sessionId=... => renvoie uniquement l’état pour CET id
app.get("/pressero/ready", (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId || typeof sessionId !== "string")
    return res.json({ ready:false });

  const entry = store.get(sessionId);
  if (entry?.url) {
    // Optionnel: auto-expire les entrées >15min
    const maxAgeMs = 15 * 60 * 1000;
    if (Date.now() - (entry.at || 0) > maxAgeMs) {
      store.delete(sessionId);
      return res.json({ ready:false });
    }
    return res.json({ ready:true, url: entry.url });
  }
  return res.json({ ready:false });
});

// (optionnel) GET /files/:sessionId.pdf -> envoie & PURGE pour éviter réutilisation
app.get("/files/:sessionId.pdf", (req, res) => {
  const { sessionId } = req.params;
  const entry = store.get(sessionId);
  if (!entry?.buffer) return res.status(404).send("Not found");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Cache-Control", "no-store");
  res.send(entry.buffer);

  // 🧹 Facultatif : purge après premier téléchargement
  try { store.delete(sessionId); } catch {}
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("🚀 Backend listening on", port));

