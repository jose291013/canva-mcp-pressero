import { prepareDesignEditor } from "@canva/intents/design";
import { requestExport } from "@canva/design";

// 👉 on lit la base backend depuis l'env Vite (fallback localhost)
const BACKEND_BASE =
  import.meta.env.VITE_BACKEND_BASE ?? "https://localhost:10000";

async function exportToPressero() {
  const result = await requestExport({ acceptedFileTypes: ["pdf_standard"] });
  if (result.status !== "completed" || !result.exportBlobs?.length) {
    throw new Error("Export annulé ou vide.");
  }
  const pdfUrl = result.exportBlobs[0].url;

  const resp = await fetch(`${BACKEND_BASE}/canva/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      files: [pdfUrl],
      sessionId: crypto.randomUUID(),
      exportTitle: "Canva → Pressero"
    })
  });
  const data = await resp.json();
  if (!data?.ok) throw new Error(data?.message || "Échec backend.");
  return data.url as string;
}

function renderButton() {
  const wrap = document.createElement("div");
  wrap.style.cssText = "padding:12px;font:14px system-ui";

  const btn = document.createElement("button");
  btn.textContent = "Envoyer vers Pressero (PDF)";
  btn.style.cssText = "padding:10px 14px;font:14px system-ui;cursor:pointer";
  btn.onclick = async () => {
    try {
      const url = await exportToPressero();
      alert(`Export OK:\n${url}`);
    } catch (e: any) {
      alert(`Erreur export: ${e?.message || e}`);
      console.error(e);
    }
  };

  wrap.appendChild(btn);
  return wrap;
}

// SDK v2 : enregistrement de l’intent Design Editor
prepareDesignEditor({
  render: () => renderButton()
});
