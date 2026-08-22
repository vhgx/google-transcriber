import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Batch, BatchItem, Diagnostic, Preferences, SourceKind } from "./types";
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

interface ViewerState {
  item: BatchItem;
  text: string;
  loading: boolean;
  error?: string;
}

function App() {
  const [urls, setUrls] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [diagnostic, setDiagnostic] = useState<Diagnostic | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<ViewerState | null>(null);
  const [viewerCopied, setViewerCopied] = useState(false);

  const refresh = async () => {
    const [loadedPrefs, loadedDiagnostic, loadedBatch] = await Promise.all([
      invoke<Preferences>("get_preferences"),
      invoke<Diagnostic>("diagnose"),
      invoke<Batch | null>("get_batch"),
    ]);
    setPrefs(loadedPrefs);
    setDiagnostic(loadedDiagnostic);
    setBatch(loadedBatch);
  };

  useEffect(() => {
    refresh().catch((error) => setMessage(String(error)));
    let unlisten: (() => void) | undefined;
    listen<Batch>("batch-state", (event) => setBatch(event.payload)).then((stop) => {
      unlisten = stop;
    });
    return () => unlisten?.();
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

  async function openViewer(item: BatchItem) {
    setViewing({ item, text: "", loading: true });
    setViewerCopied(false);
    try {
      const text = await invoke<string>("read_transcript", { outputDir: item.output_dir });
      setViewing({ item, text, loading: false });
    } catch (error) {
      setViewing({ item, text: "", loading: false, error: String(error) });
    }
  }

  async function copyTranscript(item: BatchItem) {
    try {
      const text = await invoke<string>("read_transcript", { outputDir: item.output_dir });
      await navigator.clipboard.writeText(text);
      setCopiedId(item.id);
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

  async function copyViewerText() {
    if (!viewing?.text) return;
    try {
      await navigator.clipboard.writeText(viewing.text);
      setViewerCopied(true);
      setTimeout(() => setViewerCopied(false), 2200);
    } catch (error) {
      setMessage(String(error));
    }
  }

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">PROCESSAMENTO 100% LOCAL · PORTUGUÊS</p>
          <h1>Transcrições</h1>
        </div>
        <div className="header-actions">
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
          <button className="small-button" onClick={() => setShowSettings(true)}>Ajustar</button>
        </div>
      )}

      <section className="composer card">
        <label htmlFor="urls">Links de vídeos (YouTube, Google Drive ou Web)</label>
        <textarea
          id="urls"
          value={urls}
          onChange={(event) => setUrls(event.target.value)}
          placeholder={`https://www.youtube.com/watch?v=...\nhttps://youtu.be/...\nhttps://drive.google.com/file/d/.../view`}
          disabled={batch?.running}
        />

        <div className="file-picker">
          <div>
            <strong>ou selecione arquivos deste Mac</strong>
            <p>Vídeo ou faixa de áudio — todo o processamento é feito localmente no seu computador.</p>
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
            {batch?.running ? "Processando lote..." : "Iniciar lote"}
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
              const isRunningItem = item.status === "baixando" || item.status === "convertendo" || item.status === "transcrevendo";

              return (
                <article className="item" key={item.id}>
                  <div className="item-status-col">
                    <span className={`status ${item.status} ${isRunningItem ? "pulsing" : ""}`}>
                      {statusLabel[item.status]}
                    </span>
                    <span className={`source-badge ${badge.className}`}>{badge.label}</span>
                  </div>

                  <div className="item-content">
                    <div className="item-header">
                      <strong>
                        {String(index + 1).padStart(2, "0")} · {item.title || (item.source_kind === "drive" ? "Vídeo do Drive" : item.source_kind === "youtube" ? "Vídeo do YouTube" : "Mídia Web")}
                      </strong>
                    </div>

                    <p className="url" title={item.source}>
                      {item.source_kind === "video_file" || item.source_kind === "audio_file"
                        ? `Local: ${item.source}`
                        : item.source}
                    </p>

                    {item.error && <p className="item-error">❌ {item.error}</p>}
                    {item.log.length > 0 && <p className="log">{item.log[item.log.length - 1]}</p>}

                    {item.status === "concluido" && (
                      <div className="item-actions">
                        <button className="small-button primary" onClick={() => openViewer(item)}>
                          👁 Ver transcrição
                        </button>
                        <button
                          className={`small-button secondary ${copiedId === item.id ? "success" : ""}`}
                          onClick={() => copyTranscript(item)}
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

      {/* Modal de Transcrição */}
      {viewing && (
        <div className="backdrop" onClick={() => setViewing(null)}>
          <section className="modal card viewer-modal" onClick={(e) => e.stopPropagation()}>
            <div className="section-title">
              <div>
                <span className={`source-badge ${sourceBadgeConfig[viewing.item.source_kind]?.className}`}>
                  {sourceBadgeConfig[viewing.item.source_kind]?.label}
                </span>
                <h2>{viewing.item.title || "Transcrição"}</h2>
              </div>
              <button className="icon" onClick={() => setViewing(null)}>
                ×
              </button>
            </div>

            {viewing.loading && <div className="viewer-loading">Carregando transcrição...</div>}

            {viewing.error && <div className="notice error">{viewing.error}</div>}

            {!viewing.loading && !viewing.error && (
              <>
                <div className="viewer-stats">
                  <span>Palavras: <b>{viewing.text.trim().split(/\s+/).filter(Boolean).length}</b></span>
                  <span>Caracteres: <b>{viewing.text.length}</b></span>
                  <span className="viewer-path" title={viewing.item.output_dir}>
                    📁 {viewing.item.output_dir}/transcricao.txt
                  </span>
                </div>

                <div className="transcript-box">
                  <pre>{viewing.text}</pre>
                </div>

                <div className="modal-actions">
                  <button className="secondary" onClick={() => openInFinder(viewing.item.output_dir)}>
                    📁 Abrir pasta
                  </button>
                  <button
                    className={`primary ${viewerCopied ? "success" : ""}`}
                    onClick={copyViewerText}
                  >
                    {viewerCopied ? "✓ Transcrição copiada!" : "📋 Copiar transcrição"}
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

      {/* Modal de Configurações */}
      {showSettings && prefs && (
        <div className="backdrop" onClick={() => setShowSettings(false)}>
          <section className="modal card settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="section-title">
              <div>
                <h2>Configurações locais</h2>
                <p className="muted">Caminhos e ferramentas do processamento neste Mac.</p>
              </div>
              <button className="icon" onClick={() => setShowSettings(false)}>
                ×
              </button>
            </div>

            <div className="settings-fields">
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
                  <label htmlFor="model_path">Modelo Whisper GGML (.bin)</label>
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

