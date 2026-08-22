import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  Batch,
  BatchItem,
  Diagnostic,
  HistoryEntry,
  ModelDownloadProgress,
  Preferences,
  SourceKind,
  TranscriptBundle,
  TranscriptFormat,
  WhisperModelInfo,
} from "./types";
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

interface ViewerTarget {
  title: string;
  source: string;
  source_kind: SourceKind;
  output_dir: string;
}

interface ViewerState {
  target: ViewerTarget;
  bundle: TranscriptBundle | null;
  selectedFormat: TranscriptFormat;
  loading: boolean;
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
  const [message, setMessage] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<ViewerState | null>(null);
  const [viewerCopied, setViewerCopied] = useState(false);

  const refreshAll = async () => {
    try {
      const [loadedPrefs, loadedDiag, loadedBatch, loadedHistory, loadedModels] = await Promise.all([
        invoke<Preferences>("get_preferences"),
        invoke<Diagnostic>("diagnose"),
        invoke<Batch | null>("get_batch"),
        invoke<HistoryEntry[]>("get_history").catch(() => []),
        invoke<WhisperModelInfo[]>("list_whisper_models").catch(() => []),
      ]);
      setPrefs(loadedPrefs);
      setDiagnostic(loadedDiag);
      setBatch(loadedBatch);
      setHistory(loadedHistory);
      setModels(loadedModels);
    } catch (error) {
      console.error(error);
    }
  };

  useEffect(() => {
    refreshAll().catch((error) => setMessage(String(error)));

    let unlistenBatch: (() => void) | undefined;
    listen<Batch>("batch-state", (event) => {
      setBatch(event.payload);
      invoke<HistoryEntry[]>("get_history")
        .then((h) => setHistory(h))
        .catch(() => {});
    }).then((stop) => {
      unlistenBatch = stop;
    });

    let unlistenModelProgress: (() => void) | undefined;
    listen<ModelDownloadProgress>("model-download-progress", (event) => {
      const p = event.payload;
      setDownloadProgress((prev) => ({ ...prev, [p.model_id]: p }));
      if (p.status === "completed" || p.status === "error") {
        invoke<WhisperModelInfo[]>("list_whisper_models")
          .then((m) => setModels(m))
          .catch(() => {});
      }
    }).then((stop) => {
      unlistenModelProgress = stop;
    });

    return () => {
      unlistenBatch?.();
      unlistenModelProgress?.();
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

  async function start() {
    setMessage(null);
    try {
      const created = await invoke<Batch>("create_batch", {
        urls: urls.split(/\r?\n/),
        files,
      });
      setBatch(created);
      await invoke("start_batch");
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function selectFiles() {
    try {
      const selected = await open({
        multiple: true,
        directory: false,
        filters: [
          {
            name: "Vídeo e áudio",
            extensions: [
              "mp4", "mov", "m4v", "mkv", "webm", "avi",
              "mp3", "m4a", "wav", "aac", "ogg", "flac", "aiff", "opus",
            ],
          },
        ],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      setFiles((current) => [...new Set([...current, ...paths])]);
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function cancel() {
    try {
      await invoke("cancel_batch");
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function savePrefs() {
    if (!prefs) return;
    try {
      const saved = await invoke<Preferences>("update_preferences", { preferences: prefs });
      setPrefs(saved);
      setDiagnostic(await invoke<Diagnostic>("diagnose"));
      const updatedModels = await invoke<WhisperModelInfo[]>("list_whisper_models");
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
      const selected = await open({
        multiple: false,
        directory: false,
        title,
        filters: extensions ? [{ name: "Arquivos suportados", extensions }] : undefined,
      });
      if (selected && typeof selected === "string") {
        setPrefs((p) => (p ? { ...p, [field]: selected } : p));
        if (field === "model_path") {
          setTimeout(async () => {
            const m = await invoke<WhisperModelInfo[]>("list_whisper_models");
            setModels(m);
          }, 100);
        }
      }
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function browseDirectory(field: "output_dir", title: string) {
    try {
      const selected = await open({
        multiple: false,
        directory: true,
        title,
      });
      if (selected && typeof selected === "string") {
        setPrefs((p) => (p ? { ...p, [field]: selected } : p));
      }
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function openViewer(target: ViewerTarget) {
    setViewing({
      target,
      bundle: null,
      selectedFormat: "txt",
      loading: true,
    });
    setViewerCopied(false);
    try {
      const bundle = await invoke<TranscriptBundle>("read_transcript_bundle", {
        outputDir: target.output_dir,
      });
      setViewing({
        target,
        bundle,
        selectedFormat: "txt",
        loading: false,
      });
    } catch (error) {
      setViewing({
        target,
        bundle: null,
        selectedFormat: "txt",
        loading: false,
        error: String(error),
      });
    }
  }

  async function copyTranscript(outputDir: string, id: string) {
    try {
      const text = await invoke<string>("read_transcript", { outputDir });
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2200);
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function openInFinder(path: string) {
    try {
      await invoke("open_in_finder", { path });
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function deleteHistoryItem(id: string) {
    try {
      await invoke("delete_history_item", { id });
      const updated = await invoke<HistoryEntry[]>("get_history");
      setHistory(updated);
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function clearAllHistory() {
    if (!confirm("Deseja realmente limpar todo o histórico de transcrições?")) return;
    try {
      await invoke("clear_history");
      setHistory([]);
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function downloadModel(modelId: string) {
    try {
      await invoke("download_whisper_model", { modelId });
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function cancelDownloadModel(modelId: string) {
    try {
      await invoke("cancel_model_download", { modelId });
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
      const updated = await invoke<Preferences>("set_active_model", { modelPath });
      setPrefs(updated);
      const updatedModels = await invoke<WhisperModelInfo[]>("list_whisper_models");
      setModels(updatedModels);
      setDiagnostic(await invoke<Diagnostic>("diagnose"));
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function copyViewerCurrentText() {
    if (!viewing?.bundle) return;
    const content =
      viewing.selectedFormat === "txt"
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
                <strong>ou selecione arquivos deste Mac</strong>
                <p>Vídeo ou áudio — processamento 100% no seu computador com whisper.cpp.</p>
              </div>
              <button className="secondary" onClick={selectFiles} disabled={batch?.running}>
                Selecionar arquivos
              </button>
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
                              👁 Ver transcrição & formatos
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
                      <span className="formats-label">Formatos gerados:</span>
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
                        👁 Ver transcrição & formatos
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

      {/* MODAL: VISUALIZADOR MULTI-FORMATO */}
      {viewing && (
        <div className="backdrop" onClick={() => setViewing(null)}>
          <section className="modal card viewer-modal" onClick={(e) => e.stopPropagation()}>
            <div className="section-title">
              <div>
                <span className={`source-badge ${sourceBadgeConfig[viewing.target.source_kind]?.className}`}>
                  {sourceBadgeConfig[viewing.target.source_kind]?.label}
                </span>
                <h2>{viewing.target.title}</h2>
              </div>
              <button className="icon" onClick={() => setViewing(null)}>
                ×
              </button>
            </div>

            {viewing.loading && <div className="viewer-loading">Carregando formatos de transcrição...</div>}

            {viewing.error && <div className="notice error">{viewing.error}</div>}

            {!viewing.loading && !viewing.error && viewing.bundle && (
              <>
                <div className="viewer-tabs-bar">
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
                  <span className="viewer-path" title={viewing.target.output_dir}>
                    📁 {viewing.target.output_dir}
                  </span>
                </div>

                <div className="transcript-box">
                  <pre>{currentViewerText}</pre>
                </div>

                <div className="modal-actions">
                  <button className="secondary" onClick={() => openInFinder(viewing.target.output_dir)}>
                    📁 Abrir pasta
                  </button>
                  <button className={`primary ${viewerCopied ? "success" : ""}`} onClick={copyViewerCurrentText}>
                    {viewerCopied
                      ? `✓ Copiado (.${viewing.selectedFormat})!`
                      : `📋 Copiar .${viewing.selectedFormat.toUpperCase()}`}
                  </button>
                  <button className="secondary" onClick={() => setViewing(null)}>
                    Fechar
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {/* MODAL: CONFIGURAÇÕES & GERENCIADOR DE MODELOS */}
      {showSettings && prefs && (
        <div className="backdrop" onClick={() => setShowSettings(false)}>
          <section className="modal card settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="section-title">
              <div>
                <h2>Configurações locais & Modelos</h2>
                <p className="muted">Gerencie os modelos Whisper GGML e executáveis no Mac.</p>
              </div>
              <button className="icon" onClick={() => setShowSettings(false)}>
                ×
              </button>
            </div>

            <div className="settings-fields">
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
  );
}

createRoot(document.getElementById("root")!).render(<App />);
