import { useEffect, useMemo, useState, DragEvent } from "react";
import { createRoot } from "react-dom/client";
import { AiInsightsPanel } from "./components/AiInsightsPanel";
import { AudioPlayerSync } from "./components/AudioPlayerSync";
import { AudioRecorderModal } from "./components/AudioRecorderModal";
import { api, isTauri } from "./services/api";
import type {
  AiPreferences,
  AiProvider,
  Batch,
  BatchItem,
  Diagnostic,
  HistoryEntry,
  ModelDownloadProgress,
  Preferences,
  SourceKind,
  TranscriptBundle,
  TranscriptFormat,
  TranscriptSegment,
  WhisperModelInfo,
} from "./types";
import { parseSrtSegments, segmentsToSrt } from "./utils/srtParser";
import "./styles.css";

const statusLabel: Record<string, string> = {
  aguardando: "Aguardando",
  baixando: "Baixando",
  convertendo: "Convertendo",
  transcrevendo: "Transcrevendo",
  concluido: "Concluído",
  falhou: "Falhou",
  cancelado: "Cancelado",
};

const sourceBadgeConfig: Record<SourceKind, { label: string; className: string }> = {
  youtube: { label: "YouTube", className: "badge-yt" },
  drive: { label: "Google Drive", className: "badge-drive" },
  web: { label: "Web", className: "badge-web" },
  video_file: { label: "Vídeo local", className: "badge-local" },
  audio_file: { label: "Áudio local", className: "badge-audio" },
};

const SUPPORTED_EXTENSIONS = [
  "mp4", "mov", "m4v", "mkv", "webm", "avi",
  "mp3", "m4a", "wav", "aac", "ogg", "flac", "aiff", "opus",
];

interface ViewerTarget {
  title: string;
  source: string;
  source_kind: SourceKind;
  output_dir: string;
}

interface ViewerState {
  target: ViewerTarget;
  bundle: TranscriptBundle | null;
  segments: TranscriptSegment[];
  selectedFormat: TranscriptFormat;
  isEditing: boolean;
  editedTxt: string;
  loading: boolean;
  savingEdits: boolean;
  saveSuccess: boolean;
  error?: string;
}

function App() {
  const [activeTab, setActiveTab] = useState<"composer" | "history">("composer");
  const [urls, setUrls] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [diagnostic, setDiagnostic] = useState<Diagnostic | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [models, setModels] = useState<WhisperModelInfo[]>([]);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, ModelDownloadProgress>>({});
  const [historySearch, setHistorySearch] = useState("");

  const [showSettings, setShowSettings] = useState(false);
  const [showRecorder, setShowRecorder] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  // Ollama Models Detection State
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [checkingOllama, setCheckingOllama] = useState(false);
  const [ollamaStatusMsg, setOllamaStatusMsg] = useState<string | null>(null);

  const [message, setMessage] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<ViewerState | null>(null);
  const [viewerCopied, setViewerCopied] = useState(false);

  const refreshAll = async () => {
    try {
      const [loadedPrefs, loadedDiag, loadedBatch, loadedHistory, loadedModels] = await Promise.all([
        api.getPreferences(),
        api.diagnose(),
        api.getBatch(),
        api.getHistory().catch(() => []),
        api.listWhisperModels().catch(() => []),
      ]);
      setPrefs(loadedPrefs);
      setDiagnostic(loadedDiag);
      setBatch(loadedBatch);
      setHistory(loadedHistory);
      setModels(loadedModels);

      // Checar Ollama se for o provedor ativo
      if (loadedPrefs.ai?.provider === "ollama") {
        api.checkOllama(loadedPrefs.ai.ollama_endpoint)
          .then((m) => setOllamaModels(m))
          .catch(() => {});
      }
    } catch (error) {
      console.error(error);
    }
  };

  useEffect(() => {
    refreshAll().catch((error) => setMessage(String(error)));

    const unsubscribe = api.subscribeEvents(
      (newBatch) => {
        setBatch(newBatch);
        api.getHistory()
          .then((h) => setHistory(h))
          .catch(() => {});
      },
      (p) => {
        setDownloadProgress((prev) => ({ ...prev, [p.model_id]: p }));
        if (p.status === "completed" || p.status === "error") {
          api.listWhisperModels()
            .then((m) => setModels(m))
            .catch(() => {});
        }
      }
    );

    return () => {
      unsubscribe();
    };
  }, []);

  const cleanCount = useMemo(() => {
    const urlCount = new Set(
      urls
        .split(/\r?\n/)
        .map((url) => url.trim())
        .filter(Boolean)
    ).size;
    const fileCount = new Set(files).size;
    return urlCount + fileCount;
  }, [urls, files]);

  const dependenciesReady = diagnostic?.checks.every((check) => check.available) ?? false;

  const filteredHistory = useMemo(() => {
    if (!historySearch.trim()) return history;
    const q = historySearch.toLowerCase();
    return history.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.source.toLowerCase().includes(q) ||
        item.preview_text.toLowerCase().includes(q) ||
        item.created_at.toLowerCase().includes(q)
    );
  }, [history, historySearch]);

  const totalWordsTranscribed = useMemo(() => {
    return history.reduce((acc, curr) => acc + (curr.word_count || 0), 0);
  }, [history]);

  async function testOllamaConnection() {
    if (!prefs) return;
    setCheckingOllama(true);
    setOllamaStatusMsg(null);
    try {
      const detected = await api.checkOllama(prefs.ai?.ollama_endpoint);
      setOllamaModels(detected);
      setOllamaStatusMsg(`✓ Conectado! ${detected.length} modelo(s) encontrado(s).`);
      if (detected.length > 0 && prefs.ai && !detected.includes(prefs.ai.ollama_model)) {
        setPrefs({
          ...prefs,
          ai: { ...prefs.ai, ollama_model: detected[0] },
        });
      }
    } catch (err) {
      setOllamaStatusMsg(`⚠️ Não foi possível conectar ao Ollama: ${err}`);
    } finally {
      setCheckingOllama(false);
    }
  }

  async function start() {
    setMessage(null);
    try {
      const created = await api.createBatch(
        urls.split(/\r?\n/).filter(Boolean),
        files
      );
      setBatch(created);
      await api.startBatch();
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function selectFiles() {
    try {
      if (isTauri()) {
        const selected = await api.selectLocalFiles(SUPPORTED_EXTENSIONS);
        if (!selected || selected.length === 0) return;
        const paths = selected as string[];
        setFiles((current) => [...new Set([...current, ...paths])]);
      } else {
        const selected = await api.selectLocalFiles(SUPPORTED_EXTENSIONS);
        if (!selected || selected.length === 0) return;
        const fileList = selected as File[];
        setMessage("Fazendo upload dos arquivos para o servidor...");
        const uploadedPaths = await api.uploadFiles(fileList);
        setMessage(null);
        setFiles((current) => [...new Set([...current, ...uploadedPaths])]);
      }
    } catch (error) {
      setMessage(String(error));
    }
  }

  // Drag & Drop Handlers
  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
  };

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const validFiles: File[] = [];
      const droppedPaths: string[] = [];

      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        const file = e.dataTransfer.files[i];
        const ext = file.name.split(".").pop()?.toLowerCase();
        if (ext && SUPPORTED_EXTENSIONS.includes(ext)) {
          validFiles.push(file);
          const p = (file as unknown as { path?: string }).path;
          if (p) droppedPaths.push(p);
        }
      }

      if (isTauri() && droppedPaths.length > 0) {
        setFiles((current) => [...new Set([...current, ...droppedPaths])]);
        setActiveTab("composer");
        return;
      } else if (validFiles.length > 0) {
        try {
          setMessage("Fazendo upload dos arquivos arrastados...");
          const uploaded = await api.uploadFiles(validFiles);
          setMessage(null);
          setFiles((current) => [...new Set([...current, ...uploaded])]);
          setActiveTab("composer");
          return;
        } catch (err) {
          setMessage(`Erro no upload: ${err}`);
        }
      }
    }

    const textData = e.dataTransfer.getData("text");
    if (textData && textData.trim()) {
      setUrls((curr) => (curr ? `${curr}\n${textData.trim()}` : textData.trim()));
      setActiveTab("composer");
    }
  };

  async function cancel() {
    try {
      await api.cancelBatch();
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function savePrefs() {
    if (!prefs) return;
    try {
      const saved = await api.updatePreferences(prefs);
      setPrefs(saved);
      setDiagnostic(await api.diagnose());
      const updatedModels = await api.listWhisperModels();
      setModels(updatedModels);
      setShowSettings(false);
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function browseFile(
    field: "yt_dlp_path" | "ffmpeg_path" | "whisper_path" | "model_path",
    title: string,
    extensions?: string[]
  ) {
    try {
      const current = prefs ? (prefs[field] as string) : "";
      const selected = await api.browseFile(title, extensions, current);
      if (selected) {
        setPrefs((p) => (p ? { ...p, [field]: selected } : p));
        if (field === "model_path") {
          setTimeout(async () => {
            const m = await api.listWhisperModels();
            setModels(m);
          }, 100);
        }
      }
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function browseDirectory(
    field: "output_dir" | "obsidian_vault_path",
    title: string
  ) {
    try {
      const current = prefs ? (prefs[field] as string) || "" : "";
      const selected = await api.browseDirectory(title, current);
      if (selected) {
        setPrefs((p) => (p ? { ...p, [field]: selected } : p));
      }
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function openViewer(target: ViewerTarget, defaultFormat: TranscriptFormat = "sync") {
    setViewing({
      target,
      bundle: null,
      segments: [],
      selectedFormat: defaultFormat,
      isEditing: false,
      editedTxt: "",
      loading: true,
      savingEdits: false,
      saveSuccess: false,
    });
    setViewerCopied(false);
    try {
      const bundle = await api.readTranscriptBundle(target.output_dir);
      const parsedSegments = bundle.srt ? parseSrtSegments(bundle.srt) : [];
      setViewing({
        target,
        bundle,
        segments: parsedSegments,
        selectedFormat: defaultFormat === "ai" ? "ai" : parsedSegments.length > 0 ? "sync" : "txt",
        isEditing: false,
        editedTxt: bundle.txt,
        loading: false,
        savingEdits: false,
        saveSuccess: false,
      });
    } catch (error) {
      setViewing({
        target,
        bundle: null,
        segments: [],
        selectedFormat: "txt",
        isEditing: false,
        editedTxt: "",
        loading: false,
        savingEdits: false,
        saveSuccess: false,
        error: String(error),
      });
    }
  }

  async function saveEdits() {
    if (!viewing) return;
    setViewing((v) => (v ? { ...v, savingEdits: true, saveSuccess: false } : v));

    try {
      let finalTxt = viewing.editedTxt;
      let finalSrt: string | undefined = undefined;

      if (viewing.selectedFormat === "sync" && viewing.segments.length > 0) {
        finalSrt = segmentsToSrt(viewing.segments);
        finalTxt = viewing.segments.map((s) => s.text).join("\n\n");
      }

      await api.saveTranscriptEdits(
        viewing.target.output_dir,
        finalTxt,
        finalSrt
      );

      const updatedBundle = await api.readTranscriptBundle(viewing.target.output_dir);
      const updatedSegments = updatedBundle.srt ? parseSrtSegments(updatedBundle.srt) : viewing.segments;

      setViewing((v) =>
        v
          ? {
              ...v,
              bundle: updatedBundle,
              segments: updatedSegments,
              editedTxt: updatedBundle.txt,
              isEditing: false,
              savingEdits: false,
              saveSuccess: true,
            }
          : v
      );

      const updatedHistory = await api.getHistory();
      setHistory(updatedHistory);

      setTimeout(() => {
        setViewing((v) => (v ? { ...v, saveSuccess: false } : v));
      }, 3000);
    } catch (err) {
      setMessage(`Erro ao salvar edições: ${err}`);
      setViewing((v) => (v ? { ...v, savingEdits: false } : v));
    }
  }

  async function copyTranscript(outputDir: string, id: string) {
    try {
      const text = await api.readTranscript(outputDir);
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2200);
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function openInFinder(path: string) {
    try {
      await api.openInFinder(path);
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function deleteHistoryItem(id: string) {
    try {
      await api.deleteHistoryItem(id);
      const updated = await api.getHistory();
      setHistory(updated);
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function clearAllHistory() {
    if (!confirm("Deseja realmente limpar todo o histórico de transcrições?")) return;
    try {
      await api.clearHistory();
      setHistory([]);
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function downloadModel(modelId: string) {
    try {
      await api.downloadWhisperModel(modelId);
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function cancelDownloadModel(modelId: string) {
    try {
      await api.cancelModelDownload(modelId);
      setDownloadProgress((prev) => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function activateModel(modelPath: string) {
    try {
      const updated = await api.setActiveModel(modelPath);
      setPrefs(updated);
      const updatedModels = await api.listWhisperModels();
      setModels(updatedModels);
      setDiagnostic(await api.diagnose());
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function copyViewerCurrentText() {
    if (!viewing?.bundle) return;
    const content =
      viewing.selectedFormat === "sync" || viewing.selectedFormat === "txt"
        ? viewing.bundle.txt
        : viewing.selectedFormat === "srt"
        ? viewing.bundle.srt || viewing.bundle.txt
        : viewing.selectedFormat === "vtt"
        ? viewing.bundle.vtt || viewing.bundle.txt
        : viewing.selectedFormat === "md"
        ? viewing.bundle.md || viewing.bundle.txt
        : viewing.bundle.json || viewing.bundle.txt;

    try {
      await navigator.clipboard.writeText(content);
      setViewerCopied(true);
      setTimeout(() => setViewerCopied(false), 2200);
    } catch (error) {
      setMessage(String(error));
    }
  }

  const currentViewerText = useMemo(() => {
    if (!viewing?.bundle) return "";
    switch (viewing.selectedFormat) {
      case "srt":
        return viewing.bundle.srt || "Formato SRT não gerado para este item.";
      case "vtt":
        return viewing.bundle.vtt || "Formato WebVTT não gerado para este item.";
      case "md":
        return viewing.bundle.md || viewing.bundle.txt;
      case "json":
        return viewing.bundle.json || "Formato JSON não gerado para este item.";
      case "txt":
      default:
        return viewing.bundle.txt;
    }
  }, [viewing]);

  return (
    <div
      className={`app-container ${isDraggingOver ? "dragging-over" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Overlay Visual de Drag & Drop */}
      {isDraggingOver && (
        <div className="drag-drop-overlay">
          <div className="drag-drop-box">
            <span className="drag-icon">📥</span>
            <h2>Solte seus vídeos ou áudios aqui</h2>
            <p>Os arquivos serão adicionados à fila de transcrição instantaneamente.</p>
          </div>
        </div>
      )}

      <main>
        <header>
          <div>
            <p className="eyebrow">PROCESSAMENTO 100% LOCAL · PORTUGUÊS</p>
            <h1>Transcrições</h1>
          </div>
          <div className="header-actions">
            <div className="tab-nav">
              <button
                className={`tab-button ${activeTab === "composer" ? "active" : ""}`}
                onClick={() => setActiveTab("composer")}
              >
                ⚡ Nova Transcrição
              </button>
              <button
                className={`tab-button ${activeTab === "history" ? "active" : ""}`}
                onClick={() => setActiveTab("history")}
              >
                📚 Histórico {history.length > 0 && <span className="tab-count">{history.length}</span>}
              </button>
            </div>
            <button className="secondary" onClick={() => setShowRecorder(true)} title="Gravar áudio do microfone">
              🎙️ Gravar
            </button>
            <button className="secondary" onClick={() => setShowSettings(true)}>
              ⚙ Configurações
            </button>
          </div>
        </header>

        {message && (
          <div className="notice error">
            <span>{message}</span>
            <button onClick={() => setMessage(null)}>×</button>
          </div>
        )}

        {!dependenciesReady && (
          <div className="notice warning">
            <span>⚠️ Alguma dependência local não foi encontrada. Ajuste os caminhos nas Configurações antes de iniciar.</span>
            <button className="small-button" onClick={() => setShowSettings(true)}>
              Ajustar
            </button>
          </div>
        )}

        {/* ABA: COMPOSER / FILA ATIVA */}
        {activeTab === "composer" && (
          <>
            <section className="composer card">
              <label htmlFor="urls">Links de vídeos (YouTube, Google Drive ou Web)</label>
              <textarea
                id="urls"
                value={urls}
                onChange={(event) => setUrls(event.target.value)}
                placeholder={`https://www.youtube.com/watch?v=...\nhttps://youtu.be/...\nhttps://drive.google.com/file/d/.../view\nhttps://vimeo.com/...`}
                disabled={batch?.running}
              />

              <div className="file-picker">
                <div>
                  <strong>ou selecione / arraste arquivos deste Mac</strong>
                  <p>Vídeo ou áudio (MP4, MOV, MKV, MP3, M4A, WAV, etc.) — arraste e solte direto aqui.</p>
                </div>
                <div className="picker-buttons">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setShowRecorder(true)}
                    disabled={batch?.running}
                  >
                    🎙️ Gravar voz
                  </button>
                  <button className="secondary" onClick={selectFiles} disabled={batch?.running}>
                    Selecionar arquivos
                  </button>
                </div>
              </div>

              {files.length > 0 && (
                <div className="selected-files">
                  {files.map((file) => (
                    <span key={file}>
                      <b>{file.split("/").pop()}</b>
                      <button
                        aria-label={`Remover ${file}`}
                        onClick={() => setFiles((current) => current.filter((item) => item !== file))}
                        disabled={batch?.running}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div className="composer-footer">
                <span>
                  {cleanCount} {cleanCount === 1 ? "mídia única" : "mídias únicas"} selecionada{cleanCount === 1 ? "" : "s"}
                </span>
                <button onClick={start} disabled={!cleanCount || !dependenciesReady || Boolean(batch?.running)}>
                  {batch?.running ? "Processando lote..." : "Iniciar transcrição"}
                </button>
              </div>
            </section>

            {batch && (
              <section className="card queue">
                <div className="section-title">
                  <div>
                    <p className="eyebrow">LOTE ATUAL</p>
                    <h2>{batch.running ? "Em processamento" : batch.cancelled ? "Lote cancelado" : "Lote finalizado"}</h2>
                    <p className="path" title={batch.output_dir}>
                      📁 {batch.output_dir}
                    </p>
                  </div>
                  <div className="queue-actions">
                    <button className="secondary small-button" onClick={() => openInFinder(batch.output_dir)}>
                      Abrir pasta do lote
                    </button>
                    {batch.running && (
                      <button className="danger small-button" onClick={cancel}>
                        Cancelar lote
                      </button>
                    )}
                  </div>
                </div>

                <div className="items">
                  {batch.items.map((item, index) => {
                    const badge = sourceBadgeConfig[item.source_kind] || { label: "Web", className: "badge-web" };
                    const isRunningItem =
                      item.status === "baixando" || item.status === "convertendo" || item.status === "transcrevendo";

                    return (
                      <article className="item" key={item.id}>
                        <div className="item-status-col">
                          <span className={`status ${item.status} ${isRunningItem ? "pulsing" : ""}`}>
                            {statusLabel[item.status]}
                          </span>
                          <span className={`source-badge ${badge.className}`}>{badge.label}</span>
                          {isRunningItem && item.progress > 0 && (
                            <span className="progress-pill">{item.progress.toFixed(0)}%</span>
                          )}
                        </div>

                        <div className="item-content">
                          <div className="item-header">
                            <strong>
                              {String(index + 1).padStart(2, "0")} ·{" "}
                              {item.title ||
                                (item.source_kind === "drive"
                                  ? "Vídeo do Drive"
                                  : item.source_kind === "youtube"
                                  ? "Vídeo do YouTube"
                                  : item.source_kind === "video_file" || item.source_kind === "audio_file"
                                  ? "Arquivo local"
                                  : "Mídia Web")}
                            </strong>
                          </div>

                          <p className="url" title={item.source}>
                            {item.source_kind === "video_file" || item.source_kind === "audio_file"
                              ? `Local: ${item.source}`
                              : item.source}
                          </p>

                          {/* Barra de Progresso Granular */}
                          {isRunningItem && (
                            <div className="progress-bar-container">
                              <div
                                className="progress-bar-fill"
                                style={{ width: `${Math.max(item.progress, 5)}%` }}
                              />
                            </div>
                          )}

                          {item.stage && isRunningItem && <p className="stage-text">⚡ {item.stage}</p>}

                          {item.error && <p className="item-error">❌ {item.error}</p>}
                          {!isRunningItem && item.log.length > 0 && (
                            <p className="log">{item.log[item.log.length - 1]}</p>
                          )}

                          {item.status === "concluido" && (
                            <div className="item-actions">
                              <button
                                className="small-button primary"
                                onClick={() =>
                                  openViewer({
                                    title: item.title || "Transcrição",
                                    source: item.source,
                                    source_kind: item.source_kind,
                                    output_dir: item.output_dir,
                                  })
                                }
                              >
                                🎙️ Player & Transcrição
                              </button>
                              <button
                                className="small-button secondary"
                                onClick={() =>
                                  openViewer(
                                    {
                                      title: item.title || "Transcrição",
                                      source: item.source,
                                      source_kind: item.source_kind,
                                      output_dir: item.output_dir,
                                    },
                                    "ai"
                                  )
                                }
                              >
                                ✨ Insights IA
                              </button>
                              <button
                                className={`small-button secondary ${copiedId === item.id ? "success" : ""}`}
                                onClick={() => copyTranscript(item.output_dir, item.id)}
                              >
                                {copiedId === item.id ? "✓ Copiado!" : "📋 Copiar texto"}
                              </button>
                              <button className="small-button secondary" onClick={() => openInFinder(item.output_dir)}>
                                📁 Ver no Finder
                              </button>
                            </div>
                          )}
                        </div>

                        <div className="item-end">
                          {item.status === "concluido" && <span className="done">✓</span>}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}
          </>
        )}

        {/* ABA: HISTÓRICO LOCAL */}
        {activeTab === "history" && (
          <section className="card history-section">
            <div className="section-title history-header">
              <div>
                <p className="eyebrow">HISTÓRICO PERSISTENTE</p>
                <h2>Transcrições Realizadas</h2>
              </div>
              {history.length > 0 && (
                <button className="secondary small-button" onClick={clearAllHistory}>
                  🗑 Limpar histórico
                </button>
              )}
            </div>

            <div className="history-stats-bar">
              <div className="stat-card">
                <span className="stat-label">Total de transcrições</span>
                <strong className="stat-value">{history.length}</strong>
              </div>
              <div className="stat-card">
                <span className="stat-label">Palavras transcritas</span>
                <strong className="stat-value">{totalWordsTranscribed.toLocaleString("pt-BR")}</strong>
              </div>
              <div className="stat-card search-card">
                <input
                  className="search-input"
                  placeholder="🔍 Buscar por título, link, palavra-chave..."
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                />
                {historySearch && (
                  <button className="clear-search" onClick={() => setHistorySearch("")}>
                    ×
                  </button>
                )}
              </div>
            </div>

            {filteredHistory.length === 0 ? (
              <div className="empty-history">
                <div className="empty-icon">📂</div>
                <h3>{historySearch ? "Nenhuma transcrição encontrada para a busca." : "Nenhuma transcrição no histórico."}</h3>
                <p className="muted">
                  {historySearch
                    ? "Tente outro termo ou limpe a caixa de pesquisa."
                    : "As transcrições concluídas aparecerão aqui automaticamente."}
                </p>
              </div>
            ) : (
              <div className="history-list">
                {filteredHistory.map((item) => {
                  const badge = sourceBadgeConfig[item.source_kind] || { label: "Web", className: "badge-web" };
                  const formattedDate = new Date(item.created_at).toLocaleString("pt-BR", {
                    day: "2-digit",
                    month: "2-digit",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  });

                  return (
                    <article className="history-card" key={item.id}>
                      <div className="history-card-header">
                        <div className="history-meta">
                          <span className={`source-badge ${badge.className}`}>{badge.label}</span>
                          <span className="history-date">🕒 {formattedDate}</span>
                          <span className="history-model">🤖 {item.model_name}</span>
                          <span className="history-words">📝 {item.word_count.toLocaleString("pt-BR")} palavras</span>
                        </div>
                        <button
                          className="delete-history-btn"
                          title="Remover do histórico"
                          onClick={() => deleteHistoryItem(item.id)}
                        >
                          ×
                        </button>
                      </div>

                      <h3 className="history-title">{item.title}</h3>
                      <p className="history-source" title={item.source}>
                        🔗 {item.source}
                      </p>

                      {item.preview_text && (
                        <div className="history-preview">
                          <p>"{item.preview_text}..."</p>
                        </div>
                      )}

                      <div className="history-formats">
                        <span className="formats-label">Formatos:</span>
                        {item.formats.map((f) => (
                          <span className="format-tag" key={f}>
                            .{f.toUpperCase()}
                          </span>
                        ))}
                      </div>

                      <div className="history-actions">
                        <button
                          className="small-button primary"
                          onClick={() =>
                            openViewer({
                              title: item.title,
                              source: item.source,
                              source_kind: item.source_kind,
                              output_dir: item.output_dir,
                            })
                          }
                        >
                          🎙️ Player & Transcrição
                        </button>
                        <button
                          className="small-button secondary"
                          onClick={() =>
                            openViewer(
                              {
                                title: item.title,
                                source: item.source,
                                source_kind: item.source_kind,
                                output_dir: item.output_dir,
                              },
                              "ai"
                            )
                          }
                        >
                          ✨ Insights IA
                        </button>
                        <button
                          className={`small-button secondary ${copiedId === item.id ? "success" : ""}`}
                          onClick={() => copyTranscript(item.output_dir, item.id)}
                        >
                          {copiedId === item.id ? "✓ Copiado!" : "📋 Copiar texto"}
                        </button>
                        <button className="small-button secondary" onClick={() => openInFinder(item.output_dir)}>
                          📁 Ver no Finder
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* MODAL: VISUALIZADOR MULTI-FORMATO, PLAYER SINCRONIZADO & IA */}
        {viewing && (
          <div className="backdrop" onClick={() => setViewing(null)}>
            <section className="modal card viewer-modal" onClick={(e) => e.stopPropagation()}>
              <div className="section-title">
                <div className="viewer-title-row">
                  <span className={`source-badge ${sourceBadgeConfig[viewing.target.source_kind]?.className}`}>
                    {sourceBadgeConfig[viewing.target.source_kind]?.label}
                  </span>
                  <h2>{viewing.target.title}</h2>
                </div>
                <div className="viewer-top-actions">
                  {viewing.selectedFormat !== "ai" && (
                    <button
                      type="button"
                      className={`small-button ${viewing.isEditing ? "success" : "secondary"}`}
                      onClick={() => setViewing({ ...viewing, isEditing: !viewing.isEditing })}
                    >
                      {viewing.isEditing ? "👁️ Visualizar" : "✏️ Editar texto"}
                    </button>
                  )}
                  <button className="icon" onClick={() => setViewing(null)}>
                    ×
                  </button>
                </div>
              </div>

              {viewing.loading && <div className="viewer-loading">Carregando transcrição e recursos...</div>}

              {viewing.error && <div className="notice error">{viewing.error}</div>}

              {viewing.saveSuccess && (
                <div className="notice success">
                  <span>✓ Transcrição e arquivos atualizados com sucesso!</span>
                </div>
              )}

              {!viewing.loading && !viewing.error && viewing.bundle && (
                <>
                  {/* Barra de Abas de Formatos, Player & IA */}
                  <div className="viewer-tabs-bar">
                    <button
                      className={`viewer-tab ai-tab ${viewing.selectedFormat === "ai" ? "active" : ""}`}
                      onClick={() => setViewing({ ...viewing, selectedFormat: "ai", isEditing: false })}
                    >
                      ✨ Inteligência IA
                    </button>
                    {viewing.segments.length > 0 && (
                      <button
                        className={`viewer-tab ${viewing.selectedFormat === "sync" ? "active" : ""}`}
                        onClick={() => setViewing({ ...viewing, selectedFormat: "sync" })}
                      >
                        🎙️ Player Sincronizado
                      </button>
                    )}
                    <button
                      className={`viewer-tab ${viewing.selectedFormat === "txt" ? "active" : ""}`}
                      onClick={() => setViewing({ ...viewing, selectedFormat: "txt" })}
                    >
                      📄 Texto (.txt)
                    </button>
                    <button
                      className={`viewer-tab ${viewing.selectedFormat === "srt" ? "active" : ""}`}
                      onClick={() => setViewing({ ...viewing, selectedFormat: "srt" })}
                    >
                      🎬 Legendas (.srt)
                    </button>
                    <button
                      className={`viewer-tab ${viewing.selectedFormat === "vtt" ? "active" : ""}`}
                      onClick={() => setViewing({ ...viewing, selectedFormat: "vtt" })}
                    >
                      🌐 WebVTT (.vtt)
                    </button>
                    <button
                      className={`viewer-tab ${viewing.selectedFormat === "md" ? "active" : ""}`}
                      onClick={() => setViewing({ ...viewing, selectedFormat: "md" })}
                    >
                      📑 Markdown (.md)
                    </button>
                    <button
                      className={`viewer-tab ${viewing.selectedFormat === "json" ? "active" : ""}`}
                      onClick={() => setViewing({ ...viewing, selectedFormat: "json" })}
                    >
                      🧩 JSON (.json)
                    </button>
                  </div>

                  <div className="viewer-stats">
                    <span>
                      Palavras: <b>{viewing.bundle.txt.trim().split(/\s+/).filter(Boolean).length}</b>
                    </span>
                    <span>
                      Caracteres: <b>{viewing.bundle.txt.length}</b>
                    </span>
                    {viewing.segments.length > 0 && (
                      <span>
                        Segmentos: <b>{viewing.segments.length}</b>
                      </span>
                    )}
                    <span className="viewer-path" title={viewing.target.output_dir}>
                      📁 {viewing.target.output_dir}
                    </span>
                  </div>

                  {/* Conteúdo Principal da Aba */}
                  {viewing.selectedFormat === "ai" ? (
                    <AiInsightsPanel
                      outputDir={viewing.target.output_dir}
                      title={viewing.target.title}
                      prefs={prefs}
                      onOpenSettings={() => setShowSettings(true)}
                    />
                  ) : viewing.selectedFormat === "sync" ? (
                    <AudioPlayerSync
                      outputDir={viewing.target.output_dir}
                      segments={viewing.segments}
                      isEditing={viewing.isEditing}
                      onSegmentsChange={(updated) => setViewing({ ...viewing, segments: updated })}
                    />
                  ) : viewing.isEditing ? (
                    <div className="editor-container">
                      <textarea
                        className="full-editor-textarea"
                        value={viewing.editedTxt}
                        onChange={(e) => setViewing({ ...viewing, editedTxt: e.target.value })}
                        placeholder="Edite o texto completo da transcrição..."
                      />
                    </div>
                  ) : (
                    <div className="transcript-box">
                      <pre>{currentViewerText}</pre>
                    </div>
                  )}

                  <div className="modal-actions">
                    <button className="secondary" onClick={() => openInFinder(viewing.target.output_dir)}>
                      📁 Abrir pasta
                    </button>

                    {viewing.isEditing ? (
                      <button
                        className="primary success"
                        onClick={saveEdits}
                        disabled={viewing.savingEdits}
                      >
                        {viewing.savingEdits ? "Salvando..." : "💾 Salvar alterações"}
                      </button>
                    ) : viewing.selectedFormat !== "ai" ? (
                      <button className={`primary ${viewerCopied ? "success" : ""}`} onClick={copyViewerCurrentText}>
                        {viewerCopied
                          ? `✓ Copiado (.${viewing.selectedFormat})!`
                          : `📋 Copiar .${viewing.selectedFormat.toUpperCase()}`}
                      </button>
                    ) : null}

                    <button className="secondary" onClick={() => setViewing(null)}>
                      Fechar
                    </button>
                  </div>
                </>
              )}
            </section>
          </div>
        )}

        {/* MODAL: GRAVADOR DE ÁUDIO / MICROFONE */}
        <AudioRecorderModal
          isOpen={showRecorder}
          onClose={() => setShowRecorder(false)}
          onRecordingComplete={(savedPath) => {
            setFiles((current) => [...new Set([...current, savedPath])]);
            setActiveTab("composer");
          }}
        />

        {/* MODAL: CONFIGURAÇÕES & GERENCIADOR DE MODELOS / IA */}
        {showSettings && prefs && (
          <div className="backdrop" onClick={() => setShowSettings(false)}>
            <section className="modal card settings-modal" onClick={(e) => e.stopPropagation()}>
              <div className="section-title">
                <div>
                  <h2>Configurações locais & IA</h2>
                  <p className="muted">Gerencie modelos Whisper, provedores de IA (Ollama/Nuvem) e executáveis.</p>
                </div>
                <button className="icon" onClick={() => setShowSettings(false)}>
                  ×
                </button>
              </div>

              <div className="settings-fields">
                {/* CONFIGURAÇÃO DE IA / LLMS */}
                <div className="ai-settings-section">
                  <div className="models-header">
                    <h3>🤖 Provedor de Inteligência Artificial (Pós-processamento)</h3>
                    <p className="muted">Escolha entre Ollama local (100% privado) ou provedores em nuvem.</p>
                  </div>

                  <div className="provider-selector-row">
                    {(["ollama", "gemini", "openai", "groq"] as AiProvider[]).map((prov) => {
                      const labels: Record<AiProvider, string> = {
                        ollama: "🟢 Ollama (Local)",
                        gemini: "⚡ Google Gemini",
                        openai: "⚡ OpenAI (GPT)",
                        groq: "⚡ Groq (Ultra-rápido)",
                      };
                      return (
                        <button
                          key={prov}
                          type="button"
                          className={`provider-pill ${(prefs.ai?.provider || "ollama") === prov ? "active" : ""}`}
                          onClick={() =>
                            setPrefs({
                              ...prefs,
                              ai: { ...(prefs.ai || ({} as AiPreferences)), provider: prov },
                            })
                          }
                        >
                          {labels[prov]}
                        </button>
                      );
                    })}
                  </div>

                  {/* Configurações específicas do Ollama */}
                  {(prefs.ai?.provider || "ollama") === "ollama" && (
                    <div className="provider-fields">
                      <div className="field-group">
                        <label htmlFor="ollama_endpoint">Endpoint do Ollama</label>
                        <div className="input-with-button">
                          <input
                            id="ollama_endpoint"
                            value={prefs.ai?.ollama_endpoint || "http://127.0.0.1:11434"}
                            onChange={(e) =>
                              setPrefs({
                                ...prefs,
                                ai: { ...(prefs.ai || ({} as AiPreferences)), ollama_endpoint: e.target.value },
                              })
                            }
                            placeholder="http://127.0.0.1:11434"
                          />
                          <button
                            type="button"
                            className="secondary small-button"
                            onClick={testOllamaConnection}
                            disabled={checkingOllama}
                          >
                            {checkingOllama ? "Testando..." : "Testar conexão"}
                          </button>
                        </div>
                        {ollamaStatusMsg && (
                          <span
                            className={`diag-feedback ${
                              ollamaStatusMsg.startsWith("✓") ? "ok-text" : "warn-text"
                            }`}
                          >
                            {ollamaStatusMsg}
                          </span>
                        )}
                      </div>

                      <div className="field-group">
                        <label htmlFor="ollama_model">Modelo Ollama instalado</label>
                        {ollamaModels.length > 0 ? (
                          <select
                            id="ollama_model"
                            value={prefs.ai?.ollama_model || ollamaModels[0]}
                            onChange={(e) =>
                              setPrefs({
                                ...prefs,
                                ai: { ...(prefs.ai || ({} as AiPreferences)), ollama_model: e.target.value },
                              })
                            }
                          >
                            {ollamaModels.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            id="ollama_model"
                            value={prefs.ai?.ollama_model || "llama3.2:latest"}
                            onChange={(e) =>
                              setPrefs({
                                ...prefs,
                                ai: { ...(prefs.ai || ({} as AiPreferences)), ollama_model: e.target.value },
                              })
                            }
                            placeholder="Ex: llama3.2:latest ou qwen2.5:latest"
                          />
                        )}
                      </div>
                    </div>
                  )}

                  {/* Configurações Gemini */}
                  {prefs.ai?.provider === "gemini" && (
                    <div className="provider-fields">
                      <div className="field-group">
                        <label htmlFor="gemini_api_key">Chave de API do Google Gemini</label>
                        <input
                          id="gemini_api_key"
                          type="password"
                          value={prefs.ai?.gemini_api_key || ""}
                          onChange={(e) =>
                            setPrefs({
                              ...prefs,
                              ai: { ...(prefs.ai || ({} as AiPreferences)), gemini_api_key: e.target.value },
                            })
                          }
                          placeholder="AIzaSy..."
                        />
                      </div>
                      <div className="field-group">
                        <label htmlFor="gemini_model">Modelo Gemini</label>
                        <input
                          id="gemini_model"
                          list="gemini-models-datalist"
                          value={
                            prefs.ai?.gemini_model === "gemini-1.5-pro" || prefs.ai?.gemini_model === "gemini-2.5-pro"
                              ? "gemini-3.1-pro-preview"
                              : !prefs.ai?.gemini_model ||
                                prefs.ai?.gemini_model === "gemini-1.5-flash" ||
                                prefs.ai?.gemini_model === "gemini-2.0-flash" ||
                                prefs.ai?.gemini_model === "gemini-2.5-flash"
                              ? "gemini-3.7-flash"
                              : prefs.ai.gemini_model
                          }
                          onChange={(e) =>
                            setPrefs({
                              ...prefs,
                              ai: { ...(prefs.ai || ({} as AiPreferences)), gemini_model: e.target.value },
                            })
                          }
                          placeholder="Ex: gemini-3.7-flash ou gemini-3.1-pro-preview"
                        />
                        <datalist id="gemini-models-datalist">
                          <option value="gemini-3.7-flash">gemini-3.7-flash (Recomendado - Mais recente, Rápido & Inteligente)</option>
                          <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview (Máximo Raciocínio & Contexto Longo)</option>
                          <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                        </datalist>
                        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "4px" }}>
                          {[
                            { id: "gemini-3.7-flash", label: "⚡ gemini-3.7-flash (Padrão)" },
                            { id: "gemini-3.1-pro-preview", label: "🧠 gemini-3.1-pro-preview" },
                            { id: "gemini-2.5-flash", label: "🚀 gemini-2.5-flash" },
                          ].map((m) => {
                            const currentVal =
                              prefs.ai?.gemini_model === "gemini-1.5-pro" || prefs.ai?.gemini_model === "gemini-2.5-pro"
                                ? "gemini-3.1-pro-preview"
                                : !prefs.ai?.gemini_model ||
                                  prefs.ai?.gemini_model === "gemini-1.5-flash" ||
                                  prefs.ai?.gemini_model === "gemini-2.0-flash" ||
                                  prefs.ai?.gemini_model === "gemini-2.5-flash"
                                ? "gemini-3.7-flash"
                                : prefs.ai.gemini_model;
                            const isSelected = currentVal === m.id;
                            return (
                              <button
                                key={m.id}
                                type="button"
                                style={{
                                  padding: "4px 10px",
                                  fontSize: "11px",
                                  fontWeight: 500,
                                  borderRadius: "6px",
                                  cursor: "pointer",
                                  border: isSelected ? "1px solid #818cf8" : "1px solid #ffffff25",
                                  background: isSelected ? "#4f46e540" : "#ffffff10",
                                  color: isSelected ? "#a5b4fc" : "#cbd5e1",
                                  transition: "all 0.15s ease",
                                }}
                                onClick={() =>
                                  setPrefs({
                                    ...prefs,
                                    ai: { ...(prefs.ai || ({} as AiPreferences)), gemini_model: m.id },
                                  })
                                }
                              >
                                {m.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Configurações OpenAI */}
                  {prefs.ai?.provider === "openai" && (
                    <div className="provider-fields">
                      <div className="field-group">
                        <label htmlFor="openai_api_key">Chave de API OpenAI</label>
                        <input
                          id="openai_api_key"
                          type="password"
                          value={prefs.ai?.openai_api_key || ""}
                          onChange={(e) =>
                            setPrefs({
                              ...prefs,
                              ai: { ...(prefs.ai || ({} as AiPreferences)), openai_api_key: e.target.value },
                            })
                          }
                          placeholder="sk-..."
                        />
                      </div>
                      <div className="field-group">
                        <label htmlFor="openai_model">Modelo OpenAI</label>
                        <select
                          id="openai_model"
                          value={prefs.ai?.openai_model || "gpt-4o-mini"}
                          onChange={(e) =>
                            setPrefs({
                              ...prefs,
                              ai: { ...(prefs.ai || ({} as AiPreferences)), openai_model: e.target.value },
                            })
                          }
                        >
                          <option value="gpt-4o-mini">gpt-4o-mini (Recomendado)</option>
                          <option value="gpt-4o">gpt-4o (Completo)</option>
                        </select>
                      </div>
                    </div>
                  )}

                  {/* Configurações Groq */}
                  {prefs.ai?.provider === "groq" && (
                    <div className="provider-fields">
                      <div className="field-group">
                        <label htmlFor="groq_api_key">Chave de API Groq</label>
                        <input
                          id="groq_api_key"
                          type="password"
                          value={prefs.ai?.groq_api_key || ""}
                          onChange={(e) =>
                            setPrefs({
                              ...prefs,
                              ai: { ...(prefs.ai || ({} as AiPreferences)), groq_api_key: e.target.value },
                            })
                          }
                          placeholder="gsk_..."
                        />
                      </div>
                      <div className="field-group">
                        <label htmlFor="groq_model">Modelo Groq</label>
                        <select
                          id="groq_model"
                          value={prefs.ai?.groq_model || "llama-3.3-70b-versatile"}
                          onChange={(e) =>
                            setPrefs({
                              ...prefs,
                              ai: { ...(prefs.ai || ({} as AiPreferences)), groq_model: e.target.value },
                            })
                          }
                        >
                          <option value="llama-3.3-70b-versatile">llama-3.3-70b-versatile (Alta precisão)</option>
                          <option value="mixtral-8x7b-32768">mixtral-8x7b-32768 (Contexto longo)</option>
                          <option value="llama3-8b-8192">llama3-8b-8192 (Ultra veloz)</option>
                        </select>
                      </div>
                    </div>
                  )}
                </div>

                {/* INTEGRAÇÃO COM OBSIDIAN VAULT */}
                <div className="obsidian-settings-section">
                  <div className="models-header">
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span style={{ fontSize: "1.3rem" }}>💎</span>
                      <div>
                        <h3>Integração com Obsidian (Segundo Cérebro)</h3>
                        <p className="muted">
                          Configure seu cofre (Vault) para exportar notas Zettelkasten didáticas diretamente para o Obsidian.
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="field-group">
                    <div className="field-header">
                      <label htmlFor="obsidian_vault_path">Pasta do Obsidian Vault</label>
                      {prefs.obsidian_vault_path ? (
                        <span className="diag-badge ok">✓ Configurado</span>
                      ) : (
                        <span className="diag-badge optional">Opcional</span>
                      )}
                    </div>
                    <div className="input-with-button">
                      <input
                        id="obsidian_vault_path"
                        value={prefs.obsidian_vault_path || ""}
                        onChange={(e) => setPrefs({ ...prefs, obsidian_vault_path: e.target.value })}
                        placeholder="Ex: /Users/seu-usuario/Documents/MeuCofre"
                      />
                      <button
                        type="button"
                        className="secondary small-button"
                        onClick={() => browseDirectory("obsidian_vault_path", "Selecionar pasta do Obsidian Vault")}
                      >
                        Selecionar Vault...
                      </button>
                    </div>
                  </div>

                  <div className="field-group">
                    <label htmlFor="obsidian_subfolder">Subpasta de destino no cofre</label>
                    <input
                      id="obsidian_subfolder"
                      value={prefs.obsidian_subfolder || "Transcrições"}
                      onChange={(e) => setPrefs({ ...prefs, obsidian_subfolder: e.target.value })}
                      placeholder="Ex: Transcrições, Inbox ou Sources"
                    />
                    <span className="field-hint" style={{ fontSize: "0.8rem", color: "var(--muted)", marginTop: "4px", display: "block" }}>
                      As notas didáticas serão salvas automaticamente nesta pasta dentro do seu cofre.
                    </span>
                  </div>
                </div>

                {/* GERENCIADOR DE MODELOS WHISPER */}
                <div className="models-manager-section">
                  <div className="models-header">
                    <h3>🧠 Modelos Whisper GGML (whisper.cpp)</h3>
                    <p className="muted">Baixe e alterne modelos oficiais com 1 clique.</p>
                  </div>

                  <div className="models-grid">
                    {models.map((model) => {
                      const prog = downloadProgress[model.id];
                      const isDownloading = prog?.status === "downloading";

                      return (
                        <div
                          className={`model-card ${model.is_active ? "active-model" : ""} ${
                            model.is_downloaded ? "downloaded" : ""
                          }`}
                          key={model.id}
                        >
                          <div className="model-card-top">
                            <div className="model-name-row">
                              <strong>{model.name}</strong>
                              {model.is_active ? (
                                <span className="model-pill active">✓ Em uso</span>
                              ) : model.is_downloaded ? (
                                <span className="model-pill installed">Instalado</span>
                              ) : (
                                <span className="model-pill available">Disponível</span>
                              )}
                            </div>
                            <p className="model-desc">{model.description}</p>
                          </div>

                          <div className="model-specs">
                            <span>📦 {model.size_display}</span>
                            <span>🧠 {model.ram_display} RAM</span>
                            <span>⚡ {model.speed_display}</span>
                          </div>

                          {isDownloading && (
                            <div className="model-dl-progress">
                              <div className="progress-bar-container">
                                <div className="progress-bar-fill" style={{ width: `${prog.percentage}%` }} />
                              </div>
                              <div className="dl-status-row">
                                <span>{prog.percentage.toFixed(1)}% baixado</span>
                                <button className="small-button danger" onClick={() => cancelDownloadModel(model.id)}>
                                  Cancelar
                                </button>
                              </div>
                            </div>
                          )}

                          <div className="model-card-actions">
                            {model.is_downloaded ? (
                              model.is_active ? (
                                <button className="small-button secondary" disabled>
                                  Modelo selecionado
                                </button>
                              ) : (
                                <button
                                  className="small-button primary"
                                  onClick={() => model.local_path && activateModel(model.local_path)}
                                >
                                  Usar este modelo
                                </button>
                              )
                            ) : isDownloading ? (
                              <button className="small-button secondary" disabled>
                                Baixando...
                              </button>
                            ) : (
                              <button className="small-button secondary" onClick={() => downloadModel(model.id)}>
                                ⬇ Baixar ({model.size_display})
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* CAMINHOS MANUAIS DAS FERRAMENTAS */}
                <div className="tools-paths-section">
                  <h3>🛠️ Executáveis do Sistema</h3>

                  <div className="field-group">
                    <div className="field-header">
                      <label htmlFor="yt_dlp_path">yt-dlp (Download de mídia)</label>
                      {diagnostic?.checks.find((c) => c.name === "yt-dlp")?.available ? (
                        <span className="diag-badge ok">✓ Encontrado</span>
                      ) : (
                        <span className="diag-badge missing">⚠️ Não encontrado</span>
                      )}
                    </div>
                    <div className="input-with-button">
                      <input
                        id="yt_dlp_path"
                        value={prefs.yt_dlp_path}
                        onChange={(e) => setPrefs({ ...prefs, yt_dlp_path: e.target.value })}
                      />
                      <button
                        type="button"
                        className="secondary small-button"
                        onClick={() => browseFile("yt_dlp_path", "Selecionar executável yt-dlp")}
                      >
                        Procurar...
                      </button>
                    </div>
                  </div>

                  <div className="field-group">
                    <div className="field-header">
                      <label htmlFor="ffmpeg_path">ffmpeg (Conversão de áudio)</label>
                      {diagnostic?.checks.find((c) => c.name === "ffmpeg")?.available ? (
                        <span className="diag-badge ok">✓ Encontrado</span>
                      ) : (
                        <span className="diag-badge missing">⚠️ Não encontrado</span>
                      )}
                    </div>
                    <div className="input-with-button">
                      <input
                        id="ffmpeg_path"
                        value={prefs.ffmpeg_path}
                        onChange={(e) => setPrefs({ ...prefs, ffmpeg_path: e.target.value })}
                      />
                      <button
                        type="button"
                        className="secondary small-button"
                        onClick={() => browseFile("ffmpeg_path", "Selecionar executável ffmpeg")}
                      >
                        Procurar...
                      </button>
                    </div>
                  </div>

                  <div className="field-group">
                    <div className="field-header">
                      <label htmlFor="whisper_path">whisper-cli (whisper.cpp)</label>
                      {diagnostic?.checks.find((c) => c.name === "whisper-cli")?.available ? (
                        <span className="diag-badge ok">✓ Encontrado</span>
                      ) : (
                        <span className="diag-badge missing">⚠️ Não encontrado</span>
                      )}
                    </div>
                    <div className="input-with-button">
                      <input
                        id="whisper_path"
                        value={prefs.whisper_path}
                        onChange={(e) => setPrefs({ ...prefs, whisper_path: e.target.value })}
                      />
                      <button
                        type="button"
                        className="secondary small-button"
                        onClick={() => browseFile("whisper_path", "Selecionar executável whisper-cli")}
                      >
                        Procurar...
                      </button>
                    </div>
                  </div>

                  <div className="field-group">
                    <div className="field-header">
                      <label htmlFor="model_path">Caminho do modelo ativo (.bin)</label>
                      {diagnostic?.checks.find((c) => c.name === "Modelo Whisper")?.available ? (
                        <span className="diag-badge ok">✓ Encontrado</span>
                      ) : (
                        <span className="diag-badge missing">⚠️ Não encontrado</span>
                      )}
                    </div>
                    <div className="input-with-button">
                      <input
                        id="model_path"
                        value={prefs.model_path}
                        onChange={(e) => setPrefs({ ...prefs, model_path: e.target.value })}
                      />
                      <button
                        type="button"
                        className="secondary small-button"
                        onClick={() => browseFile("model_path", "Selecionar modelo Whisper", ["bin"])}
                      >
                        Procurar...
                      </button>
                    </div>
                  </div>

                  <div className="field-group">
                    <div className="field-header">
                      <label htmlFor="output_dir">Pasta-base de saída das transcrições</label>
                    </div>
                    <div className="input-with-button">
                      <input
                        id="output_dir"
                        value={prefs.output_dir}
                        onChange={(e) => setPrefs({ ...prefs, output_dir: e.target.value })}
                      />
                      <button
                        type="button"
                        className="secondary small-button"
                        onClick={() => browseDirectory("output_dir", "Selecionar pasta-base de saída")}
                      >
                        Selecionar...
                      </button>
                    </div>
                  </div>

                  <div className="field-group">
                    <label htmlFor="concurrency">Processamentos simultâneos</label>
                    <select
                      id="concurrency"
                      value={prefs.concurrency}
                      onChange={(e) => setPrefs({ ...prefs, concurrency: Number(e.target.value) })}
                    >
                      <option value="1">1 (recomendado para Whisper local)</option>
                      <option value="2">2 (maior uso de CPU/GPU)</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="modal-actions">
                <button className="secondary" onClick={() => setShowSettings(false)}>
                  Fechar
                </button>
                <button onClick={savePrefs}>Salvar configurações</button>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
