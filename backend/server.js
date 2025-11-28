// backend/server.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import axios from "axios";
import cookieParser from "cookie-parser";
import crypto from "crypto";

// ======== CONFIG OAUTH CANVA ========
const BASE = process.env.BASE_PUBLIC_URL || "https://canva-mcp-pressero.onrender.com";

const CANVA_CLIENT_ID     = process.env.CANVA_CLIENT_ID;
const CANVA_CLIENT_SECRET = process.env.CANVA_CLIENT_SECRET;
const CANVA_SCOPES        = process.env.CANVA_SCOPES || "design:content:write design:meta:read";

if (!CANVA_CLIENT_ID || !CANVA_CLIENT_SECRET) {
  console.warn("[WARN] CANVA_CLIENT_ID ou CANVA_CLIENT_SECRET manquant(s). OAuth ne fonctionnera pas.");
}

// redirect URI pour Canva
const CANVA_REDIRECT_URI = `${BASE}/canva/oauth/callback`;

// Stockage en mémoire : userKey -> tokens
const userTokens = global._userTokens || new Map();
global._userTokens = userTokens;

// Stockage des états OAuth (PKCE) : state -> { userKey, codeVerifier }
const oauthStates = global._oauthStates || new Map();
global._oauthStates = oauthStates;

// Helpers PKCE
function base64UrlEncode(buf) {
  return buf.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function generateCodeVerifier() {
  return base64UrlEncode(crypto.randomBytes(32));
}

function generateCodeChallenge(verifier) {
  const hash = crypto.createHash("sha256").update(verifier).digest();
  return base64UrlEncode(hash);
}

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

async function getAccessTokenForUser(userKey) {
  if (!userKey) return { ok: false, reason: "missing_userKey" };

  const rec = userTokens.get(userKey);
  if (!rec) {
    // Pas encore de token → besoin d’OAuth
    return { ok: false, reason: "no_token" };
  }

  const now = Date.now();
  // marge 60s avant l’expiration
  if (rec.expiresAt && rec.expiresAt - 60_000 > now) {
    return { ok: true, token: rec.accessToken };
  }

  // Token expiré → tenter un refresh
  if (!rec.refreshToken) {
    userTokens.delete(userKey);
    return { ok: false, reason: "no_refresh_token" };
  }

  try {
    const body = new URLSearchParams();
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", rec.refreshToken);
    body.set("client_id", CANVA_CLIENT_ID);
    body.set("client_secret", CANVA_CLIENT_SECRET);

    const resp = await axios.post(
      "https://api.canva.com/rest/v1/oauth/token",
      body.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 10000
      }
    );

    const data = resp.data;
    const accessToken  = data.access_token;
    const refreshToken = data.refresh_token || rec.refreshToken;
    const expiresIn    = data.expires_in || 3600;

    userTokens.set(userKey, {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000
    });

    return { ok: true, token: accessToken };
  } catch (err) {
    console.error("Erreur refresh token Canva pour", userKey, err?.response?.data || err.message);
    userTokens.delete(userKey);
    return { ok: false, reason: "refresh_failed" };
  }
}


// ========== NOUVEAU : PRESZERO -> créer un design Canva custom ==========
// ========== PRESZERO -> créer un design Canva custom, par utilisateur ==========
app.post("/canva/create-design", async (req, res) => {
  const sid = ensureSid(req, res);
  const { widthMm, heightMm, title, userKey } = req.body || {};

  try {
    if (!widthMm || !heightMm) {
      return res.status(400).json({ ok: false, message: "Missing widthMm/heightMm" });
    }
    if (!userKey) {
      return res.status(400).json({ ok: false, message: "Missing userKey" });
    }

    // 1) Token pour ce userKey
    const tokenResult = await getAccessTokenForUser(userKey);
    if (!tokenResult.ok) {
      const authUrl = `${BASE}/canva/oauth/start?userKey=${encodeURIComponent(userKey)}`;
      return res.json({
        ok: false,
        needAuth: true,
        authUrl,
        reason: tokenResult.reason
      });
    }

    const accessToken = tokenResult.token;
    const widthPx  = mmToPx(Number(widthMm));
    const heightPx = mmToPx(Number(heightMm));

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
          Authorization: `Bearer ${accessToken}`,
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
    const status = err?.response?.status;
    const data = err?.response?.data;

    console.error("Erreur /canva/create-design:", status, data || err.message);

    // 🔴 Cas spécial : token révoqué → on efface et on redemande une connexion
    if (
      status === 401 &&
      data &&
      (data.code === "revoked_access_token" || data.code === "invalid_grant")
    ) {
      if (userKey) {
        userTokens.delete(userKey);
        console.warn("[Canva OAuth] Tokens supprimés pour", userKey, "car access_token révoqué");
      }

      const authUrl = `${BASE}/canva/oauth/start?userKey=${encodeURIComponent(userKey || "")}`;
      return res.status(200).json({
        ok: false,
        needAuth: true,
        authUrl,
        reason: data.code,
        message: "Canva access token revoked, please reconnect."
      });
    }

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

// ======== OAUTH START : redirige vers Canva pour ce userKey ========
app.get("/canva/oauth/start", (req, res) => {
  try {
    const userKey = (req.query.userKey || "").toString();
    if (!userKey) {
      return res.status(400).send("Missing userKey");
    }
    if (!CANVA_CLIENT_ID) {
      return res.status(500).send("Canva OAuth not configured");
    }

    const codeVerifier  = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    const state = base64UrlEncode(crypto.randomBytes(16)) + "." + base64UrlEncode(Buffer.from(userKey));
    oauthStates.set(state, {
      userKey,
      codeVerifier,
      createdAt: Date.now()
    });

    const params = new URLSearchParams();
    params.set("client_id", CANVA_CLIENT_ID);
    params.set("redirect_uri", CANVA_REDIRECT_URI);
    params.set("response_type", "code");
    params.set("scope", CANVA_SCOPES);
    params.set("state", state);
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", "S256");

    const url = `https://www.canva.com/api/oauth/authorize?${params.toString()}`;
    return res.redirect(url);
  } catch (e) {
    console.error("Erreur /canva/oauth/start", e);
    return res.status(500).send("OAuth start error");
  }
});

// ======== OAUTH CALLBACK : Canva renvoie code + state ========
app.get("/canva/oauth/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).send("Missing code or state");
    }

    const record = oauthStates.get(state);
    if (!record) {
      return res.status(400).send("Invalid or expired state");
    }
    oauthStates.delete(state);

    const { userKey, codeVerifier } = record;
    if (!userKey || !codeVerifier) {
      return res.status(400).send("Invalid state payload");
    }

    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", code.toString());
    body.set("redirect_uri", CANVA_REDIRECT_URI);
    body.set("client_id", CANVA_CLIENT_ID);
    body.set("code_verifier", codeVerifier);
    // Si Canva exige aussi client_secret pour ce flow :
    body.set("client_secret", CANVA_CLIENT_SECRET);

    const resp = await axios.post(
      "https://api.canva.com/rest/v1/oauth/token",
      body.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 10000
      }
    );

    const data = resp.data;
    const accessToken  = data.access_token;
    const refreshToken = data.refresh_token;
    const expiresIn    = data.expires_in || 3600;

    userTokens.set(userKey, {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000
    });

    console.log("[Canva OAuth] Tokens enregistrés pour", userKey);

    // petite page que le client voit dans la popup
    return res.send(`
      <html>
        <head><meta charset="utf-8"><title>Canva connecté</title></head>
        <body style="font-family: system-ui; text-align:center; padding:20px;">
          <h2>Votre compte Canva est connecté</h2>
          <p>Vous pouvez fermer cette fenêtre et revenir sur Pressero.</p>
          <script>
            setTimeout(function(){
              if (window.close) window.close();
            }, 1500);
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("Erreur /canva/oauth/callback", err?.response?.data || err.message);
    return res.status(500).send("OAuth callback error");
  }
});


const port = process.env.PORT || 10000;
app.listen(port, () => console.log("🚀 Backend listening on", port));



