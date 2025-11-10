import express from "express";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "50mb" }));
// Autoriser les appels depuis Canva (CORS simple)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "https://www.canva.com");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});


// Dossier pour stocker les PDF reçus
const FILES_DIR = path.join(__dirname, "public", "canva");
fs.mkdirSync(FILES_DIR, { recursive: true });

// Map en mémoire: sessionId -> fileUrl
// (pour la prod, tu mettras ça en base ou Redis)
const sessionStore = {};

// === 1) Compat: ancien endpoint Publish Extension (si jamais dispo un jour) ===
app.post("/publish/resources/upload", async (req, res) => {
  try {
    const { assets = [], state } = req.body;

    if (!assets.length || !assets[0].url) {
      console.error("Missing asset URL in Canva payload:", req.body);
      return res.status(400).json({
        type: "ERROR",
        message: "Missing asset URL from Canva.",
      });
    }

    const asset = assets[0];
    const fileId = uuidv4();
    const filePath = path.join(FILES_DIR, `${fileId}.pdf`);

    const fileResp = await axios.get(asset.url, {
      responseType: "arraybuffer",
    });

    fs.writeFileSync(filePath, fileResp.data);

    const base = (process.env.BASE_PUBLIC_URL || "").replace(/\/+$/, "");
    if (!base) {
      console.error("BASE_PUBLIC_URL not set");
      return res.status(500).json({
        type: "ERROR",
        message: "Server misconfigured (no BASE_PUBLIC_URL).",
      });
    }

    const fileUrl = `${base}/public/canva/${fileId}.pdf`;

    // si state contient un sessionId, on le stocke aussi
    if (state) {
      sessionStore[state] = fileUrl;
    }

    console.log("✅ [Legacy] Canva publish stored:", { fileUrl, state });

    return res.json({
      type: "SUCCESS",
      url: fileUrl,
      state,
    });
  } catch (error) {
    console.error("❌ [Legacy] Canva upload error:", error?.response?.data || error);
    return res.status(500).json({
      type: "ERROR",
      message: "Failed to process Canva design.",
    });
  }
});

// === 2) Nouveau endpoint: utilisé par l'Apps SDK (requestExport) ===
//
// App Canva t'enverra:
// {
//   "files": ["https://...pdf"],
//   "sessionId": "abc123",    // optionnel
//   "exportTitle": "Nom du design"
// }
app.post("/canva/export", async (req, res) => {
  try {
    const { files = [], sessionId, exportTitle } = req.body;

    if (!files.length) {
      console.error("No files in /canva/export payload:", req.body);
      return res.status(400).json({ ok: false, message: "No file URLs provided." });
    }

    const exportUrl = files[0];
    const fileId = uuidv4();
    const filePath = path.join(FILES_DIR, `${fileId}.pdf`);

    const pdfResp = await axios.get(exportUrl, { responseType: "arraybuffer" });
    fs.writeFileSync(filePath, pdfResp.data);

    const base = (process.env.BASE_PUBLIC_URL || "").replace(/\/+$/, "");
    if (!base) {
      console.error("BASE_PUBLIC_URL not set");
      return res.status(500).json({
        ok: false,
        message: "Server misconfigured (no BASE_PUBLIC_URL).",
      });
    }

    const publicUrl = `${base}/public/canva/${fileId}.pdf`;

    // sessionId venant de Pressero si fourni
    const key = sessionId || fileId;
    sessionStore[key] = publicUrl;

    console.log("✅ [Export] PDF stored", {
      sessionId: key,
      exportTitle,
      publicUrl,
    });

    return res.json({
      ok: true,
      sessionId: key,
      url: publicUrl,
    });
  } catch (err) {
    console.error("❌ /canva/export error:", err?.response?.data || err);
    return res.status(500).json({
      ok: false,
      message: "Failed to save exported design.",
    });
  }
});

// === 3) Endpoint pour que Pressero récupère le PDF par sessionId ===
app.get("/canva/session/:id", (req, res) => {
  const id = req.params.id;
  const url = sessionStore[id];

  if (!url) {
    return res.status(404).json({ ok: false, message: "No file for this sessionId yet." });
  }

  return res.json({ ok: true, url });
});

// Fichiers statiques
app.use("/public", express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.send("Canva MCP for Pressero is running.");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Canva MCP listening on port ${port}`);
});

