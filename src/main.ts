// src/main.tsx — SDK v2
import React from "react";
import { createRoot } from "react-dom/client";
import { Button, Stack, Text } from "@canva/app-ui-kit";
import { prepareDesignEditor } from "@canva/intents/design";
import { requestExport } from "@canva/design";

const BACKEND_BASE = import.meta.env.VITE_BACKEND_BASE ?? "http://localhost:3000";

async function exportToPressero() {
  const result = await requestExport({ acceptedFileTypes: ["pdf_standard"] });
  if (result.status !== "completed" || !result.exportBlobs?.length) {
    throw new Error("Export annulé ou sans fichier.");
  }
  const canvaUrl = result.exportBlobs[0].url;

  const resp = await fetch(`${BACKEND_BASE}/canva/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      files: [canvaUrl],
      sessionId: crypto.randomUUID(),
      exportTitle: "Design Canva → Pressero"
    })
  });
  const data = await resp.json();
  if (!data?.ok) throw new Error(data?.message || "Échec export backend.");
  return data.url as string;
}

function App() {
  const onClick = async () => {
    try {
      const url = await exportToPressero();
      alert(`Export OK:\n${url}`);
    } catch (e: any) {
      alert(`Erreur export: ${e?.message || e}`);
      console.error(e);
    }
  };

  return (
    <Stack space="2u">
      <Text size="medium">Canva → Pressero</Text>
      <Button variant="primary" onClick={onClick}>Envoyer vers Pressero (PDF)</Button>
    </Stack>
  );
}

// 👉 v2 : on enregistre l'intent Design Editor ici
prepareDesignEditor({
  render: () => {
    const container = document.createElement("div");
    createRoot(container).render(<App />);
    return container;
  }
});

