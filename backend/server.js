import express from "express";
import cors from "cors";
import morgan from "morgan";
import axios from "axios";

const app = express();
app.use(morgan("tiny"));
app.use(express.json({ limit: "20mb" }));

// CORS : autorise Canva + localhost (dev)
app.use(
  cors({
    origin: [
      /\.canva\.com$/,
      "https://localhost:8080",
      "https://127.0.0.1:8080"
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// Reçoit l’URL PDF de Canva et la relaie vers Albato (exemple)
app.post("/canva/export", async (req, res) => {
  try {
    const { files = [], sessionId, exportTitle } = req.body || {};
    if (!files.length) return res.status(400).json({ ok: false, message: "No files" });

    const pdfUrl = files[0];
    const pdfResp = await axios.get(pdfUrl, { responseType: "arraybuffer" });
    const pdfB64 = Buffer.from(pdfResp.data).toString("base64");

    // Envoie vers ton webhook Albato (à définir dans les vars Render)
    const albatoUrl = process.env.ALBATO_WEBHOOK_URL;
    if (albatoUrl) {
      await axios.post(albatoUrl, {
        sessionId,
        exportTitle,
        filename: "design.pdf",
        fileBase64: pdfB64
      });
    }

    res.json({ ok: true, url: "https://example.com/designs/" + (sessionId || "sample") + ".pdf" });
  } catch (e) {
    console.error(e?.message || e);
    res.status(500).json({ ok: false, message: "Export failed" });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("🚀 Backend listening on", port));

