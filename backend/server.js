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

// CORS large (Canva + Pressero)
app.use(cors({
  origin: true,
  credentials: true,
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400
}));

// Mémoire : sid -> { buffer, url, at }
const inbox = global._inbox || new Map();
global._inbox = inbox;

const BASE = process.env.BASE_PUBLIC_URL || "https://canva-mcp-pressero.onrender.com";

// Util: garantit un cookie sid
function ensureSid(req, res) {
  let sid = req.cookies?.sid;
  if (!sid) {
    sid = crypto.randomBytes(16).toString("hex");
    // SameSite=None + Secure pour l’iframe Canva
    res.cookie("sid", sid, {
      httpOnly: false,
      sameSite: "none",
      secure: true,
      maxAge: 1000 * 60 * 30 // 30 min
    });
  }
  return sid;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

// === CANVA → dépose un PDF sans sessionId (cookie sid suffit)
app.post("/canva/export", async (req, res) => {
  try {
    const sid = ensureSid(req, res);
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!files.length) return res.status(400).json({ ok:false, message:"No files" });

    const pdfUrl = files[0];
    const pdfResp = await axios.get(pdfUrl, { responseType: "arraybuffer" });
    const buf = Buffer.from(pdfResp.data);

    const publicUrl = `${BASE}/files/${encodeURIComponent(sid)}.pdf`;
    inbox.set(sid, { buffer: buf, url: publicUrl, at: Date.now() });

    return res.json({ ok:true, url: publicUrl });
  } catch (e) {
    console.error(e?.message || e);
    return res.status(500).json({ ok:false, message:"Export failed" });
  }
});

// === Fichier public (servi par sid)
app.get("/files/:sid.pdf", (req, res) => {
  const entry = inbox.get(req.params.sid);
  if (!entry?.buffer) return res.status(404).send("Not found");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Cache-Control", "no-store");
  return res.send(entry.buffer);
});

// === PRESZERO → poll par cookie sid
app.get("/pressero/ready", (req, res) => {
  // on ne lit plus ?sessionId — on lit le cookie
  const sid = req.cookies?.sid;
  const entry = sid ? inbox.get(sid) : null;
  console.log("🔎 ready? sid=", sid, "→", !!entry);
  if (entry?.url) return res.json({ ready:true, url: entry.url });
  return res.json({ ready:false });
});

// === PRESZERO → clear après injection pour éviter réinjection
app.post("/pressero/clear", (req, res) => {
  const sid = req.cookies?.sid;
  if (sid) inbox.delete(sid);
  return res.json({ ok:true });
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("🚀 Backend listening on", port));


