import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Batch, Diagnostic, Preferences } from "./types";
import "./styles.css";

const statusLabel: Record<string, string> = {
  aguardando: "Aguardando", baixando: "Baixando", convertendo: "Convertendo",
  transcrevendo: "Transcrevendo", concluido: "Concluído", falhou: "Falhou", cancelado: "Cancelado"
};

function App() {
  const [urls, setUrls] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [diagnostic, setDiagnostic] = useState<Diagnostic | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async () => {
    const [loadedPrefs, loadedDiagnostic, loadedBatch] = await Promise.all([
      invoke<Preferences>("get_preferences"), invoke<Diagnostic>("diagnose"), invoke<Batch | null>("get_batch")
    ]);
    setPrefs(loadedPrefs); setDiagnostic(loadedDiagnostic); setBatch(loadedBatch);
  };

  useEffect(() => {
    refresh().catch((error) => setMessage(String(error)));
    let unlisten: (() => void) | undefined;
    listen<Batch>("batch-state", (event) => setBatch(event.payload)).then((stop) => { unlisten = stop; });
    return () => unlisten?.();
  }, []);

  const cleanCount = useMemo(() => new Set(urls.split(/\r?\n/).map((url) => url.trim()).filter(Boolean)).size + new Set(files).size, [urls, files]);
  const dependenciesReady = diagnostic?.checks.every((check) => check.available) ?? false;

  async function start() {
    setMessage(null);
    try {
      const created = await invoke<Batch>("create_batch", { urls: urls.split(/\r?\n/), files });
      setBatch(created);
      await invoke("start_batch");
    } catch (error) { setMessage(String(error)); }
  }

  async function selectFiles() {
    try {
      const selected = await open({ multiple: true, directory: false, filters: [{ name: "Vídeo e áudio", extensions: ["mp4", "mov", "m4v", "mkv", "webm", "avi", "mp3", "m4a", "wav", "aac", "ogg", "flac", "aiff", "opus"] }] });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      setFiles((current) => [...new Set([...current, ...paths])]);
    } catch (error) { setMessage(String(error)); }
  }

  async function cancel() {
    try { await invoke("cancel_batch"); } catch (error) { setMessage(String(error)); }
  }

  async function savePrefs() {
    if (!prefs) return;
    try {
      const saved = await invoke<Preferences>("update_preferences", { preferences: prefs });
      setPrefs(saved); setDiagnostic(await invoke<Diagnostic>("diagnose")); setShowSettings(false);
    } catch (error) { setMessage(String(error)); }
  }

  return <main>
    <header><div><p className="eyebrow">PROCESSAMENTO 100% LOCAL</p><h1>Transcrições</h1></div><button className="secondary" onClick={() => setShowSettings(true)}>Configurações</button></header>
    {message && <div className="notice error">{message}<button onClick={() => setMessage(null)}>×</button></div>}
    {!dependenciesReady && <div className="notice warning">Alguma dependência local não foi encontrada. Ajuste os caminhos em Configurações antes de iniciar.</div>}
    <section className="composer card">
      <label htmlFor="urls">Links públicos de arquivos do Google Drive</label>
      <textarea id="urls" value={urls} onChange={(event) => setUrls(event.target.value)} placeholder={"https://drive.google.com/file/d/.../view\nhttps://drive.google.com/file/d/.../view"} disabled={batch?.running} />
      <div className="file-picker"><div><strong>ou use arquivos deste Mac</strong><p>Vídeo ou faixa de áudio — o processamento também é local.</p></div><button className="secondary" onClick={selectFiles} disabled={batch?.running}>Selecionar arquivos</button></div>
      {files.length > 0 && <div className="selected-files">{files.map((file) => <span key={file}><b>{file.split("/").pop()}</b><button aria-label={`Remover ${file}`} onClick={() => setFiles((current) => current.filter((item) => item !== file))} disabled={batch?.running}>×</button></span>)}</div>}
      <div className="composer-footer"><span>{cleanCount} vídeo{cleanCount === 1 ? "" : "s"} único{cleanCount === 1 ? "" : "s"}</span><button onClick={start} disabled={!cleanCount || !dependenciesReady || Boolean(batch?.running)}>Iniciar lote</button></div>
    </section>
    {batch && <section className="card queue">
      <div className="section-title"><div><p className="eyebrow">LOTE ATUAL</p><h2>{batch.running ? "Em processamento" : batch.cancelled ? "Lote cancelado" : "Lote finalizado"}</h2><p className="path">{batch.output_dir}</p></div>{batch.running && <button className="danger" onClick={cancel}>Cancelar lote</button>}</div>
      <div className="items">{batch.items.map((item, index) => <article className="item" key={item.id}><span className={`status ${item.status}`}>{statusLabel[item.status]}</span><div><strong>{String(index + 1).padStart(2, "0")} · {item.title || "Vídeo do Drive"}</strong><p className="url">{item.source_kind === "drive" ? item.source : `Arquivo local · ${item.source}`}</p>{item.error && <p className="item-error">{item.error}</p>}{item.log.length > 0 && <p className="log">{item.log[item.log.length - 1]}</p>}</div>{item.status === "concluido" && <span className="done">✓</span>}</article>)}</div>
    </section>}
    {showSettings && prefs && <div className="backdrop"><section className="modal card"><div className="section-title"><h2>Configurações locais</h2><button className="icon" onClick={() => setShowSettings(false)}>×</button></div><p className="muted">Os caminhos são usados somente neste Mac.</p>
      {(["yt_dlp_path", "ffmpeg_path", "whisper_path", "model_path", "output_dir"] as const).map((key) => <label key={key}>{({yt_dlp_path:"yt-dlp",ffmpeg_path:"ffmpeg",whisper_path:"whisper-cli",model_path:"Modelo Whisper",output_dir:"Pasta-base de saída"}[key])}<input value={prefs[key]} onChange={(event) => setPrefs({...prefs, [key]: event.target.value})}/></label>)}
      <label>Processamentos simultâneos<select value={prefs.concurrency} onChange={(event) => setPrefs({...prefs, concurrency: Number(event.target.value)})}><option value="1">1 (recomendado)</option><option value="2">2</option></select></label>
      <div className="modal-actions"><button className="secondary" onClick={() => setShowSettings(false)}>Fechar</button><button onClick={savePrefs}>Salvar</button></div></section></div>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
