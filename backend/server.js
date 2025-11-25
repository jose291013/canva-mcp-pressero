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
app.listen(port, () => console.log("🚀 Backend listening on", port));
