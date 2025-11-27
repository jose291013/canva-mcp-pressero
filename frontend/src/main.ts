import { prepareDesignEditor } from "@canva/intents/design";
import { requestExport } from "@canva/design";

const BACKEND_BASE =
  (import.meta as any).env?.VITE_BACKEND_BASE ||
  "https://canva-mcp-pressero.onrender.com";

async function exportToPressero() {
  const res = await requestExport({ acceptedFileTypes: ["pdf_standard"] });
  if (res.status !== "completed") throw new Error("Export annulé.");

  const urls: string[] = [];
  const push = (u?: string) => u && u.startsWith("http") && urls.push(u);
  (res as any).exportBlobs?.forEach((b: any) => push(b?.url));
  (res as any).exportFiles?.forEach((f: any) => push(f?.url));
  (res as any).exportLocations?.forEach((l: any) => push(l?.url));
  if (!urls.length) throw new Error("Aucun PDF capturé.");

  // IMPORTANT: credentials pour poser le cookie 'sid'
  const r = await fetch(`${BACKEND_BASE}/canva/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ files: urls, exportTitle: "Canva → Pressero" })
  });

  const data = await r.json().catch(() => ({}));
  if (!data?.ok) throw new Error(data?.message || "Échec backend");
  return data.url as string | undefined;
}

prepareDesignEditor({
  render(root?: HTMLElement) {
    const box = document.createElement("div");
    box.style.cssText = "padding:16px;margin:8px;background:#f3e8ff;border:3px dashed #7c3aed;border-radius:12px;font:14px system-ui";
    const h = document.createElement("h3");
    h.textContent = "Canva → Pressero (SDK v2)";
    h.style.cssText = "margin:0 0 10px;font-weight:600";
    const btn = document.createElement("button");
    btn.textContent = "Envoyer vers Pressero (PDF)";
    btn.style.cssText = "padding:10px 14px;border-radius:10px;background:#1d3c89;color:#fff;border:none;cursor:pointer";

    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = "Export…";
      try {
        await exportToPressero(); // le backend pose/relit 'sid'
      } catch (e: any) {
        console.error(e);
        alert(`Erreur: ${e?.message || e}`);
      } finally {
        btn.disabled = false; btn.textContent = "Envoyer vers Pressero (PDF)";
      }
    };

    box.append(h, btn);
    if (root && "appendChild" in root) { root.innerHTML = ""; root.appendChild(box); }
    else (document.querySelector('[data-layer="panel"]') || document.body).appendChild(box);
  }
});















