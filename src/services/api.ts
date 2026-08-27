import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  Batch,
  Diagnostic,
  HistoryEntry,
  ModelDownloadProgress,
  ObsidianExportResult,
  Preferences,
  TranscriptBundle,
  WhisperModelInfo,
} from "../types";

export const isTauri = (): boolean => {
  return typeof window !== "undefined" && Boolean((window as any).__TAURI_INTERNALS__);
};

const BASE_URL = "";

// Utilitário para requisições HTTP REST
async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}/api${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers || {}),
    },
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "Erro desconhecido");
    throw new Error(errorText || `HTTP ${res.status}`);
  }

  const contentType = res.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    return res.json();
  }
  return (await res.text()) as unknown as T;
}

export const api = {
  // 1. Preferências & Diagnóstico
  async getPreferences(): Promise<Preferences> {
    if (isTauri()) {
      return invoke<Preferences>("get_preferences");
    }
    return fetchApi<Preferences>("/preferences");
  },

  async updatePreferences(preferences: Preferences): Promise<Preferences> {
    if (isTauri()) {
      return invoke<Preferences>("update_preferences", { preferences });
    }
    return fetchApi<Preferences>("/preferences", {
      method: "POST",
      body: JSON.stringify(preferences),
    });
  },

  async diagnose(): Promise<Diagnostic> {
    if (isTauri()) {
      return invoke<Diagnostic>("diagnose");
    }
    return fetchApi<Diagnostic>("/diagnose");
  },

  // 2. Modelos Whisper
  async listWhisperModels(): Promise<WhisperModelInfo[]> {
    if (isTauri()) {
      return invoke<WhisperModelInfo[]>("list_whisper_models");
    }
    return fetchApi<WhisperModelInfo[]>("/models");
  },

  async downloadWhisperModel(modelId: string): Promise<void> {
    if (isTauri()) {
      return invoke("download_whisper_model", { modelId });
    }
    await fetchApi("/models/download", {
      method: "POST",
      body: JSON.stringify({ model_id: modelId }),
    });
  },

  async cancelModelDownload(modelId: string): Promise<void> {
    if (isTauri()) {
      return invoke("cancel_model_download", { modelId });
    }
    await fetchApi("/models/cancel", {
      method: "POST",
      body: JSON.stringify({ model_id: modelId }),
    });
  },

  async setActiveModel(modelPath: string): Promise<Preferences> {
    if (isTauri()) {
      return invoke<Preferences>("set_active_model", { modelPath });
    }
    return fetchApi<Preferences>("/models/active", {
      method: "POST",
      body: JSON.stringify({ model_path: modelPath }),
    });
  },

  // 3. Upload de Arquivos (Modo Web)
  async uploadFiles(files: File[]): Promise<string[]> {
    if (isTauri()) {
      return files.map((f) => (f as any).path || f.name);
    }
    const formData = new FormData();
    for (const f of files) {
      formData.append("files", f, f.name);
    }
    const res = await fetch(`${BASE_URL}/api/upload`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "Erro no upload");
      throw new Error(err);
    }
    const data = await res.json();
    return data.paths || [];
  },

  // 4. Seletor de Arquivos (Diálogo nativo no Desktop ou fallback input)
  async selectLocalFiles(supportedExtensions: string[]): Promise<string[] | File[]> {
    if (isTauri()) {
      const selected = await open({
        multiple: true,
        directory: false,
        filters: [
          {
            name: "Vídeo e áudio",
            extensions: supportedExtensions,
          },
        ],
      });
      if (!selected) return [];
      return Array.isArray(selected) ? selected : [selected];
    }

    // No modo Web, abre um input file programaticamente
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = supportedExtensions.map((ext) => `.${ext}`).join(",");
      input.onchange = () => {
        if (input.files && input.files.length > 0) {
          resolve(Array.from(input.files));
        } else {
          resolve([]);
        }
      };
      input.click();
    });
  },

  async browseFile(title: string, extensions?: string[], currentValue = ""): Promise<string | null> {
    if (isTauri()) {
      const selected = await open({
        multiple: false,
        directory: false,
        title,
        filters: extensions ? [{ name: "Arquivos suportados", extensions }] : undefined,
      });
      if (selected && typeof selected === "string") {
        return selected;
      }
      return null;
    }
    const newVal = prompt(`Informe o caminho completo no servidor para ${title}:`, currentValue);
    if (newVal !== null && newVal.trim()) {
      return newVal.trim();
    }
    return null;
  },

  async browseDirectory(title: string, currentValue = ""): Promise<string | null> {
    if (isTauri()) {
      const selected = await open({
        multiple: false,
        directory: true,
        title,
      });
      if (selected && typeof selected === "string") {
        return selected;
      }
      return null;
    }
    const newVal = prompt(`Informe o caminho da pasta de saída no servidor:`, currentValue);
    if (newVal !== null && newVal.trim()) {
      return newVal.trim();
    }
    return null;
  },

  // 5. Lotes (Batch)
  async createBatch(urls: string[], files: string[]): Promise<Batch> {
    if (isTauri()) {
      return invoke<Batch>("create_batch", { urls, files });
    }
    return fetchApi<Batch>("/batch", {
      method: "POST",
      body: JSON.stringify({ urls, files }),
    });
  },

  async getBatch(): Promise<Batch | null> {
    if (isTauri()) {
      return invoke<Batch | null>("get_batch");
    }
    return fetchApi<Batch | null>("/batch");
  },

  async startBatch(): Promise<void> {
    if (isTauri()) {
      return invoke("start_batch");
    }
    await fetchApi("/batch/start", { method: "POST" });
  },

  async cancelBatch(): Promise<void> {
    if (isTauri()) {
      return invoke("cancel_batch");
    }
    await fetchApi("/batch/cancel", { method: "POST" });
  },

  // 6. Transcrição e Mídias
  async readTranscript(outputDir: string): Promise<string> {
    if (isTauri()) {
      return invoke<string>("read_transcript", { outputDir });
    }
    return fetchApi<string>(`/transcript?output_dir=${encodeURIComponent(outputDir)}`);
  },

  async readTranscriptBundle(outputDir: string): Promise<TranscriptBundle> {
    if (isTauri()) {
      return invoke<TranscriptBundle>("read_transcript_bundle", { outputDir });
    }
    return fetchApi<TranscriptBundle>(
      `/transcript-bundle?output_dir=${encodeURIComponent(outputDir)}`
    );
  },

  async readAudioBytes(outputDir: string): Promise<number[]> {
    if (isTauri()) {
      return invoke<number[]>("read_audio_bytes", { outputDir });
    }
    const res = await fetch(`${BASE_URL}/api/audio?output_dir=${encodeURIComponent(outputDir)}`);
    if (!res.ok) {
      throw new Error(`Erro ao carregar áudio (${res.status})`);
    }
    const buffer = await res.arrayBuffer();
    return Array.from(new Uint8Array(buffer));
  },

  async saveTranscriptEdits(
    outputDir: string,
    txt: string,
    srt?: string
  ): Promise<void> {
    if (isTauri()) {
      return invoke("save_transcript_edits", { outputDir, txt, srt });
    }
    await fetchApi("/transcript/save", {
      method: "POST",
      body: JSON.stringify({ output_dir: outputDir, txt, srt }),
    });
  },

  async saveRecordedAudio(bytes: number[], filename: string): Promise<string> {
    if (isTauri()) {
      return invoke<string>("save_recorded_audio", { bytes, filename });
    }
    const res = await fetchApi<{ path: string }>("/audio/save-recording", {
      method: "POST",
      body: JSON.stringify({ bytes, filename }),
    });
    return res.path;
  },

  async startNativeRecording(): Promise<string> {
    if (isTauri()) {
      return invoke<string>("start_native_recording");
    }
    throw new Error("Gravação nativa só está disponível no aplicativo Desktop.");
  },

  async stopNativeRecording(): Promise<string> {
    if (isTauri()) {
      return invoke<string>("stop_native_recording");
    }
    throw new Error("Gravação nativa só está disponível no aplicativo Desktop.");
  },

  async cancelNativeRecording(): Promise<void> {
    if (isTauri()) {
      return invoke("cancel_native_recording");
    }
  },

  // 7. IA Insights
  async checkOllama(endpoint?: string): Promise<string[]> {
    if (isTauri()) {
      return invoke<string[]>("check_ollama", { endpoint });
    }
    return fetchApi<string[]>("/ai/check-ollama", {
      method: "POST",
      body: JSON.stringify({ endpoint }),
    });
  },

  async generateAiInsight(
    outputDir: string,
    templateId: string,
    customPrompt?: string | null
  ): Promise<string> {
    if (isTauri()) {
      return invoke<string>("generate_ai_insight", {
        outputDir,
        templateId,
        customPrompt,
      });
    }
    const res = await fetchApi<{ result: string }>("/ai/generate", {
      method: "POST",
      body: JSON.stringify({
        output_dir: outputDir,
        template_id: templateId,
        custom_prompt: customPrompt,
      }),
    });
    return res.result;
  },

  async askTranscriptAi(
    outputDir: string,
    question: string,
    history: Array<[string, string]>
  ): Promise<string> {
    if (isTauri()) {
      return invoke<string>("ask_transcript_ai", {
        outputDir,
        question,
        history,
      });
    }
    const res = await fetchApi<{ answer: string }>("/ai/chat", {
      method: "POST",
      body: JSON.stringify({
        output_dir: outputDir,
        question,
        history,
      }),
    });
    return res.answer;
  },

  async listSavedInsights(outputDir: string): Promise<Array<[string, string, string]>> {
    if (isTauri()) {
      return invoke<Array<[string, string, string]>>("list_saved_insights", { outputDir });
    }
    return fetchApi<Array<[string, string, string]>>(
      `/ai/insights?output_dir=${encodeURIComponent(outputDir)}`
    );
  },

  // 8. Histórico
  async getHistory(): Promise<HistoryEntry[]> {
    if (isTauri()) {
      return invoke<HistoryEntry[]>("get_history");
    }
    return fetchApi<HistoryEntry[]>("/history");
  },

  async deleteHistoryItem(id: string): Promise<void> {
    if (isTauri()) {
      return invoke("delete_history_item", { id });
    }
    await fetchApi(`/history/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  async clearHistory(): Promise<void> {
    if (isTauri()) {
      return invoke("clear_history");
    }
    await fetchApi("/history", { method: "DELETE" });
  },

  // 9. Abrir no Finder / Baixar ZIP
  async openInFinder(path: string): Promise<void> {
    if (isTauri()) {
      return invoke("open_in_finder", { path });
    }
    // No modo Web, baixa o ZIP com todos os arquivos do lote
    window.location.href = `${BASE_URL}/api/export-zip?output_dir=${encodeURIComponent(path)}`;
  },

  // 10. Integração com Obsidian
  async exportToObsidian(
    outputDir: string,
    filename?: string,
    content?: string
  ): Promise<ObsidianExportResult> {
    if (isTauri()) {
      return invoke<ObsidianExportResult>("export_to_obsidian", {
        outputDir,
        filename,
        content,
      });
    }
    return fetchApi<ObsidianExportResult>("/obsidian/export", {
      method: "POST",
      body: JSON.stringify({
        output_dir: outputDir,
        filename: filename || null,
        content: content || null,
      }),
    });
  },

  async openInObsidian(uriOrPath: string): Promise<void> {
    if (isTauri()) {
      return invoke("open_in_obsidian", { uriOrPath });
    }
    await fetchApi("/obsidian/open", {
      method: "POST",
      body: JSON.stringify({ uri_or_path: uriOrPath }),
    });
  },

  // 11. Assinatura de Eventos em Tempo Real (Tauri Events ou SSE)
  subscribeEvents(
    onBatchState: (batch: Batch) => void,
    onModelProgress: (progress: ModelDownloadProgress) => void
  ): () => void {
    if (isTauri()) {
      let unlistenBatch: UnlistenFn | null = null;
      let unlistenModel: UnlistenFn | null = null;

      listen<Batch>("batch-state", (event) => onBatchState(event.payload)).then(
        (fn) => (unlistenBatch = fn)
      );
      listen<ModelDownloadProgress>("model-download-progress", (event) =>
        onModelProgress(event.payload)
      ).then((fn) => (unlistenModel = fn));

      return () => {
        unlistenBatch?.();
        unlistenModel?.();
      };
    }

    // No modo Web, usa Server-Sent Events (SSE)
    const eventSource = new EventSource(`${BASE_URL}/api/events`);

    eventSource.addEventListener("batch-state", (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data);
        const data = payload.data ? payload.data : payload;
        onBatchState(data);
      } catch (err) {
        console.error("Erro ao processar evento batch-state:", err);
      }
    });

    eventSource.addEventListener("model-download-progress", (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data);
        const data = payload.data ? payload.data : payload;
        onModelProgress(data);
      } catch (err) {
        console.error("Erro ao processar evento model-download-progress:", err);
      }
    });

    return () => {
      eventSource.close();
    };
  },
};
