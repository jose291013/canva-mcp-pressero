// backend/server.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import axios from "axios";
import cookieParser from "cookie-parser";
import crypto from "crypto";

/* =========================
   CONFIG
========================= */
const BASE = process.env.BASE_PUBLIC_URL || "https://canva-mcp-pressero.onrender.com";

const CANVA_CLIENT_ID = process.env.CANVA_CLIENT_ID;
const CANVA_CLIENT_SECRET = process.env.CANVA_CLIENT_SECRET;
const CANVA_SCOPES =
  process.env.CANVA_SCOPES || "design:content:write design:meta:read";

const CANVA_REDIRECT_URI = `${BASE}/canva/oauth/callback`;

const ADMIN_API_KEY = process.env.ADMIN_API_KEY || ""; // pour endpoints /admin/*
const MAX_INBOX_AGE_MS = Number(process.env.MAX_INBOX_AGE_MS || 1000 * 60 * 30); // 30 min
const MAX_OAUTH_STATE_AGE_MS = Number(process.env.MAX_OAUTH_STATE_AGE_MS || 1000 * 60 * 15); // 15 min
const TOKEN_REFRESH_SKEW_MS = 60_000; // 1 min

if (!CANVA_CLIENT_ID || !CANVA_CLIENT_SECRET) {
  console.warn("[WARN] CANVA_CLIENT_ID/CANVA_CLIENT_SECRET manquant(s). OAuth ne fonctionnera pas.");
}

/* =========================
   TENANTS (CORS whitelist)
   TENANTS_JSON='{"tenantA":{"allowedOrigins":["https://..."]}}'
========================= */
let TENANTS = {};
try {
  TENANTS = JSON.parse(process.env.TENANTS_JSON || "{}");
} catch (e) {
  console.warn("[WARN] TENANTS_JSON invalide, CORS sera permissif.");
  TENANTS = {};
}

function sanitizeTenantId(raw) {
  const t = String(raw || "").trim();
  if (!t) return "default";
  return t.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "default";
}

function getTenantCfg(tenantId) {
  return TENANTS[tenantId] || TENANTS.default || {};
}

/* =========================
   IN-MEMORY STORES
========================= */
// tokens: key = `${tenantId}|${userKeyLower}`
const userTokens = global._userTokens || new Map();
global._userTokens = userTokens;

// oauthStates: state -> { tenantId, userKey, codeVerifier, createdAt }
const oauthStates = global._oauthStates || new Map();
global._oauthStates = oauthStates;

// inbox: sessionId -> { buffer, url, at, tenantId }
const inbox = global._inbox || new Map();
global._inbox = inbox;

/* =========================
   PKCE HELPERS
========================= */
function base64UrlEncode(buf) {
  return buf
    .toString("base64")
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

/* =========================
   SESSION ID (no 3rd-party cookies)
========================= */
function ensureSessionId(req, res, { allowSetCookie = true } = {}) {
  const explicit =
    req.body?.sessionId ||
    req.query?.sessionId ||
    req.headers?.["x-session-id"];

  if (explicit) return String(explicit);

  // fallback legacy cookie
  let sid = req.cookies?.sid;
  if (!sid) {
    sid = crypto.randomBytes(16).toString("hex");
    if (allowSetCookie) {
      res.cookie("sid", sid, {
        httpOnly: false,
        sameSite: "none",
        secure: true,
        maxAge: MAX_INBOX_AGE_MS
      });
    }
  }
  return sid;
}

function tokenKey(tenantId, userKey) {
  return `${tenantId}|${String(userKey || "").toLowerCase()}`;
}

/* =========================
   MM -> PX
========================= */
const MM_PER_INCH = 25.4;
const DPI = Number(process.env.CANVA_DPI || "96");
function mmToPx(mm) {
  return Math.round((mm / MM_PER_INCH) * DPI);
}

/* =========================
   APP
========================= */
const app = express();
app.use(morgan("tiny"));
app.use(express.json({ limit: "20mb" }));
app.use(cookieParser());

/* =========================
   CORS (per-tenant if TENANTS_JSON exists)
========================= */
app.use(
  cors((req, cb) => {
    const origin = req.header("Origin");
    if (!origin) {
      return cb(null, {
        origin: false,
        credentials: true,
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "X-Session-Id"],
        maxAge: 86400
      });
    }

    const hasTenants = Object.keys(TENANTS || {}).length > 0;

    // If no tenants configured => permissive (dev)
    if (!hasTenants) {
      return cb(null, {
        origin: true,
        credentials: true,
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "X-Session-Id"],
        maxAge: 86400
      });
    }

    // Try to extract tenantId from /t/:tenantId/*
    const m = (req.path || "").match(/^\/t\/([^/]+)/);
    const tenantId = sanitizeTenantId(m?.[1] || "default");
    const cfg = getTenantCfg(tenantId);
    const allowed = Array.isArray(cfg.allowedOrigins) ? cfg.allowedOrigins : [];

    const ok =
      allowed.includes("*") || allowed.includes(origin);

    return cb(null, {
      origin: ok ? origin : false,
      credentials: true,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Session-Id"],
      maxAge: 86400
    });
  })
);

app.get("/health", (_req, res) => res.json({ ok: true }));

/* =========================
   TOKEN HANDLING
========================= */
async function getAccessTokenForUser(tenantId, userKey) {
  if (!userKey) return { ok: false, reason: "missing_userKey" };
  const k = tokenKey(tenantId, userKey);
  const rec = userTokens.get(k);
  if (!rec) return { ok: false, reason: "no_token" };

  const now = Date.now();
  if (rec.expiresAt && rec.expiresAt - TOKEN_REFRESH_SKEW_MS > now) {
    return { ok: true, token: rec.accessToken };
  }

  if (!rec.refreshToken) {
    userTokens.delete(k);
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
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000 }
    );

    const data = resp.data;
    const accessToken = data.access_token;
    const refreshToken = data.refresh_token || rec.refreshToken;
    const expiresIn = data.expires_in || 3600;

    userTokens.set(k, {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000
    });

    return { ok: true, token: accessToken };
  } catch (err) {
    console.error("[Canva] refresh token failed:", err?.response?.data || err.message);
    userTokens.delete(k);
    return { ok: false, reason: "refresh_failed" };
  }
}

/* =========================
   FILE SERVING
========================= */
app.get("/files/:sessionId.pdf", (req, res) => {
  const entry = inbox.get(req.params.sessionId);
  if (!entry?.buffer) return res.status(404).send("Not found");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Cache-Control", "no-store");
  res.send(entry.buffer);
});

/* =========================
   MULTI-TENANT ROUTER
========================= */
const tenantRouter = express.Router({ mergeParams: true });

tenantRouter.post("/canva/create-design", async (req, res) => {
  const tenantId = sanitizeTenantId(req.params.tenantId);
  const sessionId = ensureSessionId(req, res, { allowSetCookie: true });

  const { widthMm, heightMm, title, userKey } = req.body || {};

  if (!widthMm || !heightMm) {
    return res.status(400).json({ ok: false, message: "Missing widthMm/heightMm", sessionId });
  }
  if (!userKey) {
    return res.status(400).json({ ok: false, message: "Missing userKey", sessionId });
  }

  const tokenResult = await getAccessTokenForUser(tenantId, userKey);
  if (!tokenResult.ok) {
    const authUrl = `${BASE}/t/${encodeURIComponent(tenantId)}/canva/oauth/start?userKey=${encodeURIComponent(userKey)}&sessionId=${encodeURIComponent(sessionId)}`;
    return res.json({
      ok: false,
      needAuth: true,
      authUrl,
      reason: tokenResult.reason,
      sessionId
    });
  }

  const accessToken = tokenResult.token;

  try {
    const widthPx = mmToPx(Number(widthMm));
    const heightPx = mmToPx(Number(heightMm));

    const body = {
      design_type: { type: "custom", width: widthPx, height: heightPx },
      title: title || `Pressero ${widthMm}×${heightMm} mm`
    };

    const resp = await axios.post("https://api.canva.com/rest/v1/designs", body, {
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      timeout: 10000
    });

    const data = resp.data || {};
    const editUrl =
      data?.design?.urls?.edit_url ||
      data?.urls?.edit_url ||
      data?.urls?.edit ||
      data?.edit_url;

    if (!editUrl) {
      console.error("[Canva] no edit_url returned:", JSON.stringify(data).slice(0, 800));
      return res.status(500).json({ ok: false, message: "No edit_url returned by Canva", sessionId });
    }

    return res.json({ ok: true, editUrl, sessionId });
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error("[Canva] create-design failed:", status, data || err.message);

    // If token revoked, clear and force reauth
    if (status === 401 && data && (data.code === "revoked_access_token" || data.code === "invalid_grant")) {
      userTokens.delete(tokenKey(tenantId, userKey));
      const authUrl = `${BASE}/t/${encodeURIComponent(tenantId)}/canva/oauth/start?userKey=${encodeURIComponent(userKey)}&sessionId=${encodeURIComponent(sessionId)}`;
      return res.json({
        ok: false,
        needAuth: true,
        authUrl,
        reason: data.code,
        message: "Canva token revoked. Please reconnect.",
        sessionId
      });
    }

    return res.status(500).json({ ok: false, message: "Canva create-design failed", sessionId });
  }
});

tenantRouter.post("/canva/export", async (req, res) => {
  const tenantId = sanitizeTenantId(req.params.tenantId);
  const sessionId = ensureSessionId(req, res, { allowSetCookie: false });

  try {
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!files.length) return res.status(400).json({ ok: false, message: "No files", sessionId });
    if (!sessionId) return res.status(400).json({ ok: false, message: "Missing sessionId", sessionId });

    const pdfUrl = files[0];
    const pdfResp = await axios.get(pdfUrl, { responseType: "arraybuffer" });
    const buf = Buffer.from(pdfResp.data);

    const publicUrl = `${BASE}/files/${encodeURIComponent(sessionId)}.pdf`;
    inbox.set(sessionId, { buffer: buf, url: publicUrl, at: Date.now(), tenantId });

    return res.json({ ok: true, url: publicUrl, sessionId });
  } catch (e) {
    console.error("[Export] failed:", e?.response?.data || e.message);
    return res.status(500).json({ ok: false, message: "Export failed", sessionId });
  }
});

tenantRouter.get("/pressero/ready", (req, res) => {
  const sessionId =
    (req.query?.sessionId && String(req.query.sessionId)) ||
    (req.headers?.["x-session-id"] && String(req.headers["x-session-id"])) ||
    req.cookies?.sid;

  const entry = sessionId ? inbox.get(sessionId) : null;
  if (entry?.url) return res.json({ ready: true, url: entry.url, sessionId });
  return res.json({ ready: false, sessionId });
});

tenantRouter.post("/pressero/clear", (req, res) => {
  const sessionId =
    (req.body?.sessionId && String(req.body.sessionId)) ||
    (req.query?.sessionId && String(req.query.sessionId)) ||
    req.cookies?.sid;

  if (sessionId) inbox.delete(sessionId);
  return res.json({ ok: true });
});

app.use("/t/:tenantId", tenantRouter);

/* =========================
   LEGACY ROUTES (compat)
   Your existing Pressero script continues to work
========================= */
app.post("/canva/create-design", (req, res) => {
  req.params.tenantId = "default";
  return tenantRouter.handle(req, res);
});
app.post("/canva/export", (req, res) => {
  req.params.tenantId = "default";
  return tenantRouter.handle(req, res);
});
app.get("/pressero/ready", (req, res) => {
  req.params.tenantId = "default";
  return tenantRouter.handle(req, res);
});
app.post("/pressero/clear", (req, res) => {
  req.params.tenantId = "default";
  return tenantRouter.handle(req, res);
});

/* =========================
   OAUTH START (multi-tenant)
========================= */
app.get("/t/:tenantId/canva/oauth/start", (req, res) => {
  try {
    const tenantId = sanitizeTenantId(req.params.tenantId);
    const userKey = (req.query.userKey || "").toString();
    if (!userKey) return res.status(400).send("Missing userKey");
    if (!CANVA_CLIENT_ID) return res.status(500).send("Canva OAuth not configured");

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    // state embeds tenantId + userKey, but also store verifier server-side
    const payload = JSON.stringify({ tenantId, userKey });
    const state =
      base64UrlEncode(crypto.randomBytes(16)) + "." + base64UrlEncode(Buffer.from(payload));

    oauthStates.set(state, { tenantId, userKey, codeVerifier, createdAt: Date.now() });

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
    console.error("[OAuth start] error:", e.message);
    return res.status(500).send("OAuth start error");
  }
});

// Legacy oauth start
app.get("/canva/oauth/start", (req, res) => {
  req.params.tenantId = "default";
  return app._router.handle(req, res);
});

/* =========================
   OAUTH CALLBACK
========================= */
app.get("/canva/oauth/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing code or state");

    const record = oauthStates.get(state);
    if (!record) return res.status(400).send("Invalid or expired state");
    oauthStates.delete(state);

    const { tenantId, userKey, codeVerifier } = record;
    if (!tenantId || !userKey || !codeVerifier) return res.status(400).send("Invalid state payload");

    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", code.toString());
    body.set("redirect_uri", CANVA_REDIRECT_URI);
    body.set("client_id", CANVA_CLIENT_ID);
    body.set("code_verifier", codeVerifier);
    body.set("client_secret", CANVA_CLIENT_SECRET);

    const resp = await axios.post("https://api.canva.com/rest/v1/oauth/token", body.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 10000
    });

    const data = resp.data;
    const accessToken = data.access_token;
    const refreshToken = data.refresh_token;
    const expiresIn = data.expires_in || 3600;

    userTokens.set(tokenKey(tenantId, userKey), {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000
    });

    console.log("[OAuth] tokens saved for", tenantId, userKey);

    return res.send(`
      <html>
        <head><meta charset="utf-8"><title>Canva connected</title></head>
        <body style="font-family: system-ui; text-align:center; padding:20px;">
          <h2>Canva account connected</h2>
          <p>You can close this window and return to Pressero.</p>
          <script>setTimeout(function(){ if (window.close) window.close(); }, 1200);</script>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("[OAuth callback] error:", err?.response?.data || err.message);
    return res.status(500).send("OAuth callback error");
  }
});

/* =========================
   ADMIN (optional, but recommended)
========================= */
function requireAdmin(req, res, next) {
  if (!ADMIN_API_KEY) return res.status(403).json({ ok: false, message: "ADMIN_API_KEY not set" });
  const key = req.header("x-admin-key") || req.query?.adminKey;
  if (key !== ADMIN_API_KEY) return res.status(401).json({ ok: false, message: "Unauthorized" });
  next();
}

// Create/update tenant config (in-memory; you will persist via env or DB later)
app.post("/admin/tenants", requireAdmin, (req, res) => {
  const tenantId = sanitizeTenantId(req.body?.tenantId);
  const allowedOrigins = Array.isArray(req.body?.allowedOrigins) ? req.body.allowedOrigins : [];
  if (!tenantId) return res.status(400).json({ ok: false, message: "Missing tenantId" });

  TENANTS[tenantId] = { allowedOrigins };
  return res.json({ ok: true, tenantId, allowedOrigins });
});

// Returns a ready-to-copy Pressero snippet with tenantId baked in
app.get("/admin/tenants/:tenantId/snippet", requireAdmin, (req, res) => {
  const tenantId = sanitizeTenantId(req.params.tenantId);
  const backend = BASE;

  // Note: selector for #fileUploads[0] must escape []
  const snippet = `<!-- Canva → Pressero (tenant: ${tenantId}) -->
<script>
(function(){
  'use strict';
  const BACKEND_BASE = "${backend}";
  const TENANT_ID = "${tenantId}";
  const EMAIL_SELECTOR = "#correo";
  const UPLOAD_SELECTOR = "#fileUploads\\\\[0\\\\]";
  const POLL_MS = 2000;

  function getOrCreateLocalKey(k){
    try{
      let v = localStorage.getItem(k);
      if (v) return v;
      v = "u_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
      localStorage.setItem(k, v);
      return v;
    }catch(_){
      return "u_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
    }
  }
  function getSessionId(){ return getOrCreateLocalKey("canva_pressero_session_" + TENANT_ID); }
  function getUserKey(){
    const n = document.querySelector(EMAIL_SELECTOR);
    if(n){
      const t = (n.textContent||"").trim();
      const m = t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/i);
      if(m && m[0]) return m[0].toLowerCase();
    }
    return getOrCreateLocalKey("canva_pressero_user_" + TENANT_ID);
  }

  let calcAttributes=null;
  const prev = window.intCalcFinish || null;
  window.intCalcFinish = function(e,a){
    calcAttributes=a;
    if(typeof prev==="function"){ try{ prev(e,a); }catch(_){} }
  };

  function getDims(){
    let w=null,h=null;
    if(calcAttributes && Array.isArray(calcAttributes.Attributes)){
      calcAttributes.Attributes.forEach(attr=>{
        if(!attr||!attr.Key) return;
        if(attr.Key==="Largeur") w=Number(String(attr.Value).replace(",","."));
        if(attr.Key==="Hauteur") h=Number(String(attr.Value).replace(",","."));
      });
    }
    if(w>0 && h>0) return { widthMm:w, heightMm:h };
    const q2=document.querySelector('input[name="Q2"]');
    const q3=document.querySelector('input[name="Q3"]');
    if(q2&&q3&&q2.value&&q3.value){
      const ww=Number(String(q2.value).replace(",","."));
      const hh=Number(String(q3.value).replace(",","."));
      if(ww>0 && hh>0) return { widthMm:ww, heightMm:hh };
    }
    return null;
  }

  function findUpload(){
    return document.querySelector(UPLOAD_SELECTOR) || document.querySelector('input[type="file"]');
  }

  async function injectFromUrl(url){
    const input=findUpload();
    if(!input) throw new Error("Upload slot not found");
    const r=await fetch(url,{credentials:"omit",cache:"no-store"});
    if(!r.ok) throw new Error("PDF download failed");
    const blob=await r.blob();
    const file=new File([blob],"Canva.pdf",{type:"application/pdf"});
    const dt=new DataTransfer(); dt.items.add(file);
    input.files=dt.files;
    ["change","input"].forEach(ev=>input.dispatchEvent(new Event(ev,{bubbles:true})));
  }

  function pollReady(sessionId,cb){
    const t=setInterval(async()=>{
      try{
        const r=await fetch(\`\${BACKEND_BASE}/t/\${encodeURIComponent(TENANT_ID)}/pressero/ready?sessionId=\${encodeURIComponent(sessionId)}\`,
          {credentials:"omit",cache:"no-store"});
        if(!r.ok) return;
        const j=await r.json().catch(()=>({}));
        if(j.ready && j.url){ clearInterval(t); cb(j.url); }
      }catch(_){}
    },POLL_MS);
    return ()=>clearInterval(t);
  }

  function mount(){
    const input=findUpload(); if(!input) return;

    const holder=document.createElement("div");
    holder.style.cssText="margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;";
    const btn=document.createElement("button");
    btn.type="button";
    btn.textContent="Create with Canva";
    btn.style.cssText="padding:10px 14px;border-radius:8px;background:#1d3c89;color:#fff;border:none;cursor:pointer;";
    const hint=document.createElement("div");
    hint.textContent="The PDF will be returned here automatically.";
    hint.style.cssText="font:12px/1.35 system-ui;color:#334155;";
    holder.append(btn,hint);
    (input.closest(".form-group")||input.parentElement).appendChild(holder);

    let stop=null,popup=null;

    btn.onclick=async()=>{
      const userKey=getUserKey();
      const sessionId=getSessionId();
      const dims=getDims();
      if(!dims){ alert("Cannot detect dimensions."); return; }

      const title=\`Pressero \${dims.widthMm}x\${dims.heightMm}mm [PRES:\${TENANT_ID}:\${sessionId}]\`;

      btn.disabled=true; btn.textContent="Preparing Canva…";

      const resp=await fetch(\`\${BACKEND_BASE}/t/\${encodeURIComponent(TENANT_ID)}/canva/create-design\`,{
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        credentials:"omit",
        body: JSON.stringify({ widthMm:dims.widthMm, heightMm:dims.heightMm, title, userKey, sessionId })
      });

      const data=await resp.json().catch(()=>({}));

      if(data.needAuth && data.authUrl){
        window.open(data.authUrl,"canvaAuth","width=650,height=820");
        btn.disabled=false; btn.textContent="Create with Canva";
        alert("Connect your Canva account, then click again.");
        return;
      }

      if(!data.ok || !data.editUrl){
        btn.disabled=false; btn.textContent="Create with Canva";
        alert(data.message || "Canva error");
        return;
      }

      btn.textContent="Waiting for PDF…";
      if(stop) stop();
      stop=pollReady(sessionId, async (pdfUrl)=>{
        try{
          await injectFromUrl(pdfUrl);
          await fetch(\`\${BACKEND_BASE}/t/\${encodeURIComponent(TENANT_ID)}/pressero/clear\`,{
            method:"POST",
            headers:{ "Content-Type":"application/json" },
            credentials:"omit",
            body: JSON.stringify({ sessionId })
          });
          hint.textContent="PDF received ✅";
        }catch(e){
          alert(e.message || "Injection error");
        }finally{
          btn.disabled=false; btn.textContent="Create with Canva";
          try{ if(popup && !popup.closed) popup.close(); }catch(_){}
        }
      });

      popup=window.open(data.editUrl,"canvaEditor","width=1280,height=860");
      if(!popup){
        btn.disabled=false; btn.textContent="Create with Canva";
        hint.innerHTML='Popup blocked. <a target="_blank" href="'+data.editUrl+'">Open Canva</a>.';
      }
    };
  }

  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
</script>`;

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(snippet);
});

/* =========================
   CLEANUP (TTL)
========================= */
function cleanupStores() {
  const now = Date.now();

  // inbox TTL
  for (const [sid, rec] of inbox.entries()) {
    if (!rec?.at || now - rec.at > MAX_INBOX_AGE_MS) {
      inbox.delete(sid);
    }
  }

  // oauth state TTL
  for (const [state, rec] of oauthStates.entries()) {
    if (!rec?.createdAt || now - rec.createdAt > MAX_OAUTH_STATE_AGE_MS) {
      oauthStates.delete(state);
    }
  }
}
setInterval(cleanupStores, 60_000).unref?.();

/* =========================
   START
========================= */
const port = process.env.PORT || 10000;
app.listen(port, () => console.log("🚀 Backend listening on", port));




