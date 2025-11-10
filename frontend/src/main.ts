import { requestExport } from "@canva/design";

// URL publique de ton backend (server.js)
const BACKEND_BASE = "https://canva-mcp-pressero.onrender.com";

const btn = document.getElementById("send") as HTMLButtonElement;
const link = document.getElementById("link") as HTMLAnchorElement;

btn?.addEventListener("click", async () => {
  btn.disabled = true;
  btn.textContent = "Export en cours…";
  link.textContent = "";
  link.removeAttribute("href");

  try {
    // 1) Ouvrir le dialogue d’export (SDK v2)
    const result = await requestExport({
      acceptedFileTypes: ["pdf_standard"], // jpg|png|pdf_standard|video|gif|pptx|svg
    });

    if (result.status !== "completed" || !result.exportBlobs?.length) {
      throw new Error("Export annulé ou sans fichier.");
    }

    const canvaUrl = result.exportBlobs[0].url; // URL signée fournie par Canva

    // 2) Envoyer l’URL au backend pour qu’il télécharge et serve le PDF
    const resp = await fetch(`${BACKEND_BASE}/canva/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [canvaUrl],
        sessionId: crypto.randomUUID(),
        exportTitle: "Design Canva → Pressero",
      }),
    });

    const data = await resp.json();
    if (!data?.ok) throw new Error(data?.message || "Échec export backend.");

    link.href = data.url;
    link.textContent = "Voir le PDF exporté";
  } catch (e: any) {
    alert(e?.message || "Erreur export");
    console.error(e);
  } finally {
    btn.disabled = false;
    btn.textContent = "Envoyer vers Pressero (PDF)";
  }
});
