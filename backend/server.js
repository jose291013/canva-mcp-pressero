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

// ------------------- util cookie sid -------------------
function ensureSid(req, res) {
  let sid = req.cookies?.sid;
  if (!sid) {
    sid = crypto.randomBytes(16).toString("hex");
    res.cookie("sid", sid, {
      httpOnly: false,
      sameSite: "none",
      secure: true,
      maxAge: 1000 * 60 * 30 // 30 min
    });
  }
  return sid;
}

// ------------------- util mm -> px -------------------
const MM_PER_INCH = 25.4;
const DPI = Number(process.env.CANVA_DPI || "96");

function mmToPx(mm) {
  return Math.round((mm / MM_PER_INCH) * DPI);
}

app.get("/health", (_req, res) => res.json({ ok: true }));

// ========== NOUVEAU : PRESZERO -> créer un design Canva custom ==========
app.post("/canva/create-design", async (req, res) => {
  try {
    const sid = ensureSid(req, res); // on pose le cookie si besoin
    const { widthMm, heightMm, title } = req.body || {};

    if (!widthMm || !heightMm) {
      return res.status(400).json({ ok: false, message: "Missing widthMm/heightMm" });
    }

    const widthPx  = mmToPx(Number(widthMm));
    const heightPx = mmToPx(Number(heightMm));

    const token = process.env.CANVA_ACCESS_TOKEN;
    if (!token) {
      return res.status(500).json({ ok: false, message: "Missing CANVA_ACCESS_TOKEN env var" });
    }

    const body = {
      design_type: {
        type: "custom",
        width: widthPx,
        height: heightPx
      },
      title: title || `Pressero ${widthMm}×${heightMm} mm`
    };

    const resp = await axios.post(
      "https://api.canva.com/rest/v1/designs",
      body,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        timeout: 10000
      }
    );

    const data = resp.data || {};
    const editUrl =
      data?.design?.urls?.edit_url ||
      data?.urls?.edit_url ||
      data?.urls?.edit ||
      data?.edit_url;

    if (!editUrl) {
      console.error("Canva /designs => pas de edit_url", JSON.stringify(data).slice(0, 500));
      return res.status(500).json({ ok: false, message: "No edit_url returned by Canva" });
    }

    return res.json({ ok: true, editUrl });
  } catch (err) {
    console.error("Erreur /canva/create-design:", err?.response?.status, err?.response?.data || err.message);
    return res.status(500).json({ ok: false, message: "Canva create-design failed" });
  }
});

// ========== CANVA → dépose un PDF ==========
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

// ========== Fichier public (servi par sid) ==========
app.get("/files/:sid.pdf", (req, res) => {
  const entry = inbox.get(req.params.sid);
  if (!entry?.buffer) return res.status(404).send("Not found");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Cache-Control", "no-store");
  return res.send(entry.buffer);
});

// ========== PRESZERO → poll par cookie sid ==========
app.get("/pressero/ready", (req, res) => {
  const sid = req.cookies?.sid;
  const entry = sid ? inbox.get(sid) : null;
  console.log("🔎 ready? sid=", sid, "→", !!entry);
  if (entry?.url) return res.json({ ready:true, url: entry.url });
  return res.json({ ready:false });
});

// ========== PRESZERO → clear ==========
app.post("/pressero/clear", (req, res) => {
  const sid = req.cookies?.sid;
  if (sid) inbox.delete(sid);
  return res.json({ ok:true });
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("🚀 Backend listening on", port));



