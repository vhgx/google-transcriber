use chrono::Local;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use url::Url;
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Preferences {
    pub yt_dlp_path: String,
    pub ffmpeg_path: String,
    pub whisper_path: String,
    pub model_path: String,
    pub output_dir: String,
    pub concurrency: u8,
}

impl Default for Preferences {
    fn default() -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/Users/Shared"));
        Self {
            yt_dlp_path: "/opt/homebrew/bin/yt-dlp".into(),
            ffmpeg_path: "/opt/homebrew/bin/ffmpeg".into(),
            whisper_path: "/opt/homebrew/bin/whisper-cli".into(),
            model_path: home.join("whisper-models/ggml-medium.bin").to_string_lossy().into(),
            output_dir: home.join("Downloads/Transcrições").to_string_lossy().into(),
            concurrency: 1,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Check {
    pub name: String,
    pub path: String,
    pub available: bool,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Diagnostic {
    pub checks: Vec<Check>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    Aguardando,
    Baixando,
    Convertendo,
    Transcrevendo,
    Concluido,
    Falhou,
    Cancelado,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Youtube,
    Drive,
    Web,
    VideoFile,
    AudioFile,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BatchItem {
    pub id: String,
    pub source: String,
    pub source_kind: SourceKind,
    pub local_path: Option<String>,
    pub title: Option<String>,
    pub status: ItemStatus,
    pub progress: f32,
    pub stage: Option<String>,
    pub output_dir: String,
    pub error: Option<String>,
    pub log: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Batch {
    pub id: String,
    pub output_dir: String,
    pub items: Vec<BatchItem>,
    pub running: bool,
    pub cancelled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WhisperModelCatalogItem {
    pub id: &'static str,
    pub name: &'static str,
    pub filename: &'static str,
    pub size_bytes: u64,
    pub size_display: &'static str,
    pub ram_display: &'static str,
    pub speed_display: &'static str,
    pub description: &'static str,
    pub download_url: &'static str,
}

pub const WHISPER_MODELS: &[WhisperModelCatalogItem] = &[
    WhisperModelCatalogItem {
        id: "tiny",
        name: "Tiny",
        filename: "ggml-tiny.bin",
        size_bytes: 77700000,
        size_display: "~75 MB",
        ram_display: "~390 MB",
        speed_display: "Ultra rápido (32x)",
        description: "Leve e veloz para testes rápidos.",
        download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
    },
    WhisperModelCatalogItem {
        id: "base",
        name: "Base",
        filename: "ggml-base.bin",
        size_bytes: 148000000,
        size_display: "~142 MB",
        ram_display: "~500 MB",
        speed_display: "Muito rápido (16x)",
        description: "Bom equilíbrio para falas claras e vídeos curtos.",
        download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
    },
    WhisperModelCatalogItem {
        id: "small",
        name: "Small",
        filename: "ggml-small.bin",
        size_bytes: 488000000,
        size_display: "~466 MB",
        ram_display: "~1.0 GB",
        speed_display: "Rápido (6x)",
        description: "Excelente precisão com consumo moderado de recursos.",
        download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    },
    WhisperModelCatalogItem {
        id: "medium",
        name: "Medium",
        filename: "ggml-medium.bin",
        size_bytes: 1533763059,
        size_display: "~1.5 GB",
        ram_display: "~2.6 GB",
        speed_display: "Equilibrado (2x)",
        description: "Padrão recomendado para Português com alta acurácia.",
        download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
    },
    WhisperModelCatalogItem {
        id: "large-v3-turbo",
        name: "Large v3 Turbo",
        filename: "ggml-large-v3-turbo.bin",
        size_bytes: 1620000000,
        size_display: "~1.6 GB",
        ram_display: "~3.0 GB",
        speed_display: "Rápido (8x)",
        description: "A alta precisão do modelo Large com velocidade otimizada.",
        download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
    },
    WhisperModelCatalogItem {
        id: "large-v3",
        name: "Large v3",
        filename: "ggml-large-v3.bin",
        size_bytes: 3100000000,
        size_display: "~3.1 GB",
        ram_display: "~4.7 GB",
        speed_display: "Máxima fidelidade (1x)",
        description: "Máxima precisão para sotaques, ruídos e vocabulário técnico.",
        download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
    },
];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WhisperModelInfo {
    pub id: String,
    pub name: String,
    pub filename: String,
    pub size_bytes: u64,
    pub size_display: String,
    pub ram_display: String,
    pub speed_display: String,
    pub description: String,
    pub download_url: String,
    pub is_downloaded: bool,
    pub is_active: bool,
    pub local_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModelDownloadProgress {
    pub model_id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percentage: f32,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TranscriptBundle {
    pub txt: String,
    pub srt: Option<String>,
    pub vtt: Option<String>,
    pub json: Option<String>,
    pub md: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: String,
    pub batch_id: String,
    pub created_at: String,
    pub title: String,
    pub source: String,
    pub source_kind: SourceKind,
    pub output_dir: String,
    pub status: ItemStatus,
    pub word_count: usize,
    pub char_count: usize,
    pub preview_text: String,
    pub model_name: String,
    pub formats: Vec<String>,
}

pub struct AppState {
    preferences: Mutex<Preferences>,
    batch: Mutex<Option<Batch>>,
    cancelled: AtomicBool,
    running_pids: Mutex<HashSet<u32>>,
    active_downloads: Mutex<HashSet<String>>,
    config_path: PathBuf,
    history_path: PathBuf,
}

fn lock<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, String> {
    mutex
        .lock()
        .map_err(|_| "O estado interno do aplicativo ficou indisponível.".into())
}

fn load_preferences(path: &Path) -> Preferences {
    fs::read_to_string(path)
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn persist_preferences(path: &Path, preferences: &Preferences) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("Não foi possível determinar a pasta de configurações.")?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Não foi possível criar a pasta de configurações: {e}"))?;
    let json = serde_json::to_string_pretty(preferences).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| format!("Não foi possível salvar as configurações: {e}"))
}

fn load_history(path: &Path) -> Vec<HistoryEntry> {
    fs::read_to_string(path)
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn persist_history(path: &Path, history: &[HistoryEntry]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("Não foi possível determinar a pasta do histórico.")?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Não foi possível criar pasta do histórico: {e}"))?;
    let json = serde_json::to_string_pretty(history).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| format!("Não foi possível salvar o histórico: {e}"))
}

fn append_history_entry(app: &AppHandle, entry: HistoryEntry) {
    let state = app.state::<AppState>();
    let mut history = load_history(&state.history_path);
    history.retain(|item| item.id != entry.id);
    history.insert(0, entry);
    let _ = persist_history(&state.history_path, &history);
}

pub fn parse_web_url(raw: &str) -> Result<(String, SourceKind), String> {
    let raw = raw.trim();
    let url = Url::parse(raw).map_err(|_| format!("URL inválida: {raw}"))?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err(format!("A URL deve usar HTTP ou HTTPS: {raw}"));
    }
    let host = url.host_str().unwrap_or("").to_lowercase();
    if host.is_empty() {
        return Err(format!("Host não encontrado na URL: {raw}"));
    }
    if host.contains("youtube.com") || host.contains("youtu.be") {
        Ok((url.to_string(), SourceKind::Youtube))
    } else if host.contains("drive.google.com") {
        if url.path().contains("/folders/") {
            return Err(format!(
                "Links de pastas do Google Drive não são aceitos nesta versão: {raw}"
            ));
        }
        if !url.path().contains("/file/")
            && !url.path().contains("/uc")
            && !url.path().contains("/open")
        {
            return Err(format!(
                "Use um link de arquivo compartilhado do Google Drive: {raw}"
            ));
        }
        Ok((url.to_string(), SourceKind::Drive))
    } else {
        Ok((url.to_string(), SourceKind::Web))
    }
}

pub fn local_source(raw: &str) -> Result<(PathBuf, SourceKind), String> {
    let path =
        fs::canonicalize(raw.trim()).map_err(|_| format!("Arquivo local não encontrado: {raw}"))?;
    if !path.is_file() {
        return Err(format!("O caminho não é um arquivo: {}", path.display()));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let kind = match extension.as_str() {
        "mp4" | "mov" | "m4v" | "mkv" | "webm" | "avi" => SourceKind::VideoFile,
        "mp3" | "m4a" | "wav" | "aac" | "ogg" | "flac" | "aiff" | "opus" => SourceKind::AudioFile,
        _ => {
            return Err(format!(
                "Formato não suportado: .{extension}. Selecione um vídeo ou uma faixa de áudio."
            ))
        }
    };
    Ok((path, kind))
}

fn emit_batch(app: &AppHandle) {
    if let Ok(batch) = lock(&app.state::<AppState>().batch).map(|batch| batch.clone()) {
        if let Some(batch) = batch {
            let _ = app.emit("batch-state", batch);
        }
    }
}

fn update_item<F>(app: &AppHandle, index: usize, update: F)
where
    F: FnOnce(&mut BatchItem),
{
    if let Ok(mut batch) = lock(&app.state::<AppState>().batch) {
        if let Some(batch) = batch.as_mut() {
            if let Some(item) = batch.items.get_mut(index) {
                update(item);
            }
        }
    }
    emit_batch(app);
}

fn find_downloaded_media(dir: &Path) -> Option<PathBuf> {
    let video_mp4 = dir.join("video.mp4");
    if video_mp4.is_file() {
        return Some(video_mp4);
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with("video.")
                        && !name.ends_with(".part")
                        && !name.ends_with(".ytdl")
                    {
                        return Some(path);
                    }
                }
            }
        }
    }
    None
}

fn resolve_models_directory(preferences: &Preferences) -> PathBuf {
    let current_model_path = Path::new(&preferences.model_path);
    if let Some(parent) = current_model_path.parent() {
        if parent.exists() && parent.is_dir() {
            return parent.to_path_buf();
        }
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/Users/Shared"));
    let default_dir = home.join("whisper-models");
    let _ = fs::create_dir_all(&default_dir);
    default_dir
}

fn generate_markdown_transcript(
    title: &str,
    source: &str,
    model_name: &str,
    text: &str,
    srt_content: Option<&str>,
) -> String {
    let now = Local::now().format("%d/%m/%Y às %H:%M").to_string();
    let word_count = text.trim().split_whitespace().count();
    let char_count = text.chars().count();

    let mut md = format!(
        "# Transcrição: {title}\n\n\
        - **Data de Processamento**: {now}\n\
        - **Origem**: {source}\n\
        - **Modelo Utilizado**: {model_name}\n\
        - **Estatísticas**: {word_count} palavras · {char_count} caracteres\n\n\
        ---\n\n\
        ## 📝 Texto Transcrito\n\n\
        {text}\n"
    );

    if let Some(srt) = srt_content {
        if !srt.trim().is_empty() {
            md.push_str("\n---\n\n## ⏱️ Linha do Tempo (Timestamps)\n\n```srt\n");
            md.push_str(srt.trim());
            md.push_str("\n```\n");
        }
    }

    md
}

#[tauri::command]
fn get_preferences(state: State<'_, AppState>) -> Result<Preferences, String> {
    Ok(lock(&state.preferences)?.clone())
}

#[tauri::command]
fn update_preferences(
    preferences: Preferences,
    state: State<'_, AppState>,
) -> Result<Preferences, String> {
    if !(1..=2).contains(&preferences.concurrency) {
        return Err("A concorrência deve ser 1 ou 2.".into());
    }
    for (label, path) in [
        ("yt-dlp", &preferences.yt_dlp_path),
        ("ffmpeg", &preferences.ffmpeg_path),
        ("whisper-cli", &preferences.whisper_path),
        ("modelo", &preferences.model_path),
        ("pasta de saída", &preferences.output_dir),
    ] {
        if path.trim().is_empty() {
            return Err(format!("O caminho de {label} não pode estar vazio."));
        }
    }
    persist_preferences(&state.config_path, &preferences)?;
    *lock(&state.preferences)? = preferences.clone();
    Ok(preferences)
}

#[tauri::command]
fn diagnose(state: State<'_, AppState>) -> Result<Diagnostic, String> {
    let preferences = lock(&state.preferences)?.clone();
    let checks = [
        ("yt-dlp", preferences.yt_dlp_path),
        ("ffmpeg", preferences.ffmpeg_path),
        ("whisper-cli", preferences.whisper_path),
        ("Modelo Whisper", preferences.model_path),
    ]
    .into_iter()
    .map(|(name, path)| {
        let available = Path::new(&path).is_file();
        Check {
            name: name.into(),
            path: path.clone(),
            available,
            message: if available {
                "Encontrado neste Mac.".into()
            } else {
                "Arquivo não encontrado. Ajuste o caminho em Configurações.".into()
            },
        }
    })
    .collect();
    Ok(Diagnostic { checks })
}

#[tauri::command]
fn list_whisper_models(state: State<'_, AppState>) -> Result<Vec<WhisperModelInfo>, String> {
    let preferences = lock(&state.preferences)?.clone();
    let models_dir = resolve_models_directory(&preferences);
    let active_model_path = PathBuf::from(&preferences.model_path);

    let list = WHISPER_MODELS
        .iter()
        .map(|model| {
            let file_path = models_dir.join(model.filename);
            let is_downloaded = file_path.is_file();
            let is_active = is_downloaded
                && active_model_path.file_name() == file_path.file_name()
                && (active_model_path == file_path || active_model_path.is_file());

            WhisperModelInfo {
                id: model.id.into(),
                name: model.name.into(),
                filename: model.filename.into(),
                size_bytes: model.size_bytes,
                size_display: model.size_display.into(),
                ram_display: model.ram_display.into(),
                speed_display: model.speed_display.into(),
                description: model.description.into(),
                download_url: model.download_url.into(),
                is_downloaded,
                is_active,
                local_path: if is_downloaded {
                    Some(file_path.to_string_lossy().to_string())
                } else {
                    None
                },
            }
        })
        .collect();

    Ok(list)
}

#[tauri::command]
async fn download_whisper_model(
    app: AppHandle,
    model_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let catalog_item = WHISPER_MODELS
        .iter()
        .find(|m| m.id == model_id)
        .ok_or_else(|| format!("Modelo não encontrado: {model_id}"))?;

    let preferences = lock(&state.preferences)?.clone();
    let models_dir = resolve_models_directory(&preferences);
    fs::create_dir_all(&models_dir)
        .map_err(|e| format!("Não foi possível criar a pasta de modelos: {e}"))?;

    let target_file = models_dir.join(catalog_item.filename);
    let part_file = models_dir.join(format!("{}.part", catalog_item.filename));

    {
        let mut active = lock(&state.active_downloads)?;
        if active.contains(&model_id) {
            return Err("Este modelo já está sendo baixado.".into());
        }
        active.insert(model_id.clone());
    }

    let model_id_clone = model_id.clone();
    let app_clone = app.clone();

    tauri::async_runtime::spawn(async move {
        let emit_progress = |status: &str, downloaded: u64, total: u64, pct: f32, err: Option<String>| {
            let _ = app_clone.emit(
                "model-download-progress",
                ModelDownloadProgress {
                    model_id: model_id_clone.clone(),
                    downloaded_bytes: downloaded,
                    total_bytes: total,
                    percentage: pct,
                    status: status.into(),
                    error: err,
                },
            );
        };

        emit_progress("downloading", 0, catalog_item.size_bytes, 0.0, None);

        let response = match reqwest::get(catalog_item.download_url).await {
            Ok(resp) => {
                if !resp.status().is_success() {
                    let err = format!("Servidor retornou status HTTP {}", resp.status());
                    emit_progress("error", 0, catalog_item.size_bytes, 0.0, Some(err));
                    if let Ok(mut active) = lock(&app_clone.state::<AppState>().active_downloads) {
                        active.remove(&model_id_clone);
                    }
                    return;
                }
                resp
            }
            Err(e) => {
                let err = format!("Erro ao conectar com Hugging Face: {e}");
                emit_progress("error", 0, catalog_item.size_bytes, 0.0, Some(err));
                if let Ok(mut active) = lock(&app_clone.state::<AppState>().active_downloads) {
                    active.remove(&model_id_clone);
                }
                return;
            }
        };

        let total_size = response
            .content_length()
            .unwrap_or(catalog_item.size_bytes);
        let mut downloaded: u64 = 0;
        let mut stream = response.bytes_stream();

        let mut file = match tokio::fs::File::create(&part_file).await {
            Ok(f) => f,
            Err(e) => {
                let err = format!("Não foi possível criar arquivo temporário: {e}");
                emit_progress("error", 0, total_size, 0.0, Some(err));
                if let Ok(mut active) = lock(&app_clone.state::<AppState>().active_downloads) {
                    active.remove(&model_id_clone);
                }
                return;
            }
        };

        use tokio::io::AsyncWriteExt;
        let mut last_emit = std::time::Instant::now();

        while let Some(chunk_result) = stream.next().await {
            let is_cancelled = {
                if let Ok(active) = lock(&app_clone.state::<AppState>().active_downloads) {
                    !active.contains(&model_id_clone)
                } else {
                    true
                }
            };

            if is_cancelled {
                let _ = tokio::fs::remove_file(&part_file).await;
                emit_progress("cancelled", downloaded, total_size, 0.0, None);
                return;
            }

            match chunk_result {
                Ok(chunk) => {
                    if let Err(e) = file.write_all(&chunk).await {
                        let err = format!("Erro de gravação em disco: {e}");
                        emit_progress("error", downloaded, total_size, 0.0, Some(err));
                        let _ = tokio::fs::remove_file(&part_file).await;
                        if let Ok(mut active) = lock(&app_clone.state::<AppState>().active_downloads) {
                            active.remove(&model_id_clone);
                        }
                        return;
                    }
                    downloaded += chunk.len() as u64;
                    if last_emit.elapsed().as_millis() > 200 || downloaded >= total_size {
                        let pct = (downloaded as f32 / total_size as f32) * 100.0;
                        emit_progress("downloading", downloaded, total_size, pct.min(99.9), None);
                        last_emit = std::time::Instant::now();
                    }
                }
                Err(e) => {
                    let err = format!("Falha no download dos dados: {e}");
                    emit_progress("error", downloaded, total_size, 0.0, Some(err));
                    let _ = tokio::fs::remove_file(&part_file).await;
                    if let Ok(mut active) = lock(&app_clone.state::<AppState>().active_downloads) {
                        active.remove(&model_id_clone);
                    }
                    return;
                }
            }
        }

        let _ = file.flush().await;
        drop(file);

        if let Err(e) = tokio::fs::rename(&part_file, &target_file).await {
            let err = format!("Erro ao finalizar arquivo do modelo: {e}");
            emit_progress("error", downloaded, total_size, 0.0, Some(err));
        } else {
            emit_progress("completed", total_size, total_size, 100.0, None);
        }

        if let Ok(mut active) = lock(&app_clone.state::<AppState>().active_downloads) {
            active.remove(&model_id_clone);
        }
    });

    Ok(())
}

#[tauri::command]
fn cancel_model_download(model_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut active = lock(&state.active_downloads)?;
    active.remove(&model_id);
    Ok(())
}

#[tauri::command]
fn set_active_model(model_path: String, state: State<'_, AppState>) -> Result<Preferences, String> {
    let path = PathBuf::from(&model_path);
    if !path.is_file() {
        return Err(format!("Arquivo de modelo não encontrado: {model_path}"));
    }
    let mut prefs = lock(&state.preferences)?.clone();
    prefs.model_path = model_path;
    persist_preferences(&state.config_path, &prefs)?;
    *lock(&state.preferences)? = prefs.clone();
    Ok(prefs)
}

#[tauri::command]
fn create_batch(
    urls: Vec<String>,
    files: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Batch, String> {
    if lock(&state.batch)?
        .as_ref()
        .is_some_and(|batch| batch.running)
    {
        return Err("Aguarde o lote atual terminar ou cancele-o antes de criar outro.".into());
    }
    let mut seen = HashSet::new();
    let mut sources: Vec<(String, SourceKind, Option<String>, Option<String>)> = Vec::new();
    for raw in urls {
        if raw.trim().is_empty() {
            continue;
        }
        let (url, kind) = parse_web_url(&raw)?;
        if seen.insert(url.clone()) {
            sources.push((url, kind, None, None));
        }
    }
    for raw in files {
        let (path, kind) = local_source(&raw)?;
        let key = path.to_string_lossy().to_string();
        if seen.insert(key.clone()) {
            let title = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Arquivo local")
                .to_string();
            sources.push((key.clone(), kind, Some(key), Some(title)));
        }
    }
    if sources.is_empty() {
        return Err(
            "Cole uma URL (YouTube, Drive ou Web) ou selecione pelo menos um arquivo local.".into(),
        );
    }
    let preferences = lock(&state.preferences)?.clone();
    let output_dir = PathBuf::from(preferences.output_dir)
        .join(Local::now().format("%Y-%m-%d_%H-%M-%S").to_string());
    fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Não foi possível criar a pasta do lote: {e}"))?;
    let items = sources
        .into_iter()
        .enumerate()
        .map(|(index, (source, source_kind, local_path, title))| {
            let item_dir = output_dir.join(format!("{:02}", index + 1));
            BatchItem {
                id: Uuid::new_v4().to_string(),
                source,
                source_kind,
                local_path,
                title,
                status: ItemStatus::Aguardando,
                progress: 0.0,
                stage: Some("Na fila".into()),
                output_dir: item_dir.to_string_lossy().into(),
                error: None,
                log: vec!["Na fila".into()],
            }
        })
        .collect();
    let batch = Batch {
        id: Uuid::new_v4().to_string(),
        output_dir: output_dir.to_string_lossy().into(),
        items,
        running: false,
        cancelled: false,
    };
    *lock(&state.batch)? = Some(batch.clone());
    state.cancelled.store(false, Ordering::SeqCst);
    Ok(batch)
}

#[tauri::command]
fn get_batch(state: State<'_, AppState>) -> Result<Option<Batch>, String> {
    Ok(lock(&state.batch)?.clone())
}

#[tauri::command]
fn start_batch(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let concurrency = lock(&state.preferences)?.concurrency;
    {
        let mut batch = lock(&state.batch)?;
        let batch = batch
            .as_mut()
            .ok_or("Crie um lote antes de iniciar.".to_string())?;
        if batch.running {
            return Err("Este lote já está em processamento.".into());
        }
        batch.running = true;
        batch.cancelled = false;
    }
    state.cancelled.store(false, Ordering::SeqCst);
    emit_batch(&app);
    tauri::async_runtime::spawn(async move {
        process_batch(app, concurrency).await;
    });
    Ok(())
}

#[tauri::command]
fn cancel_batch(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.cancelled.store(true, Ordering::SeqCst);
    if let Ok(mut batch) = lock(&state.batch) {
        if let Some(batch) = batch.as_mut() {
            batch.cancelled = true;
            for item in &mut batch.items {
                if !matches!(item.status, ItemStatus::Concluido | ItemStatus::Falhou) {
                    item.status = ItemStatus::Cancelado;
                    item.stage = Some("Cancelado".into());
                    item.log.push("Cancelado pelo usuário".into());
                }
            }
        }
    }
    let pids: Vec<u32> = lock(&state.running_pids)?.iter().copied().collect();
    for pid in pids {
        let _ = std::process::Command::new("/bin/kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }
    emit_batch(&app);
    Ok(())
}

#[tauri::command]
fn read_transcript(output_dir: String) -> Result<String, String> {
    let dir = PathBuf::from(output_dir);
    let transcript_path = dir.join("transcricao.txt");
    if !transcript_path.is_file() {
        return Err("O arquivo de transcrição (transcricao.txt) não foi encontrado.".into());
    }
    fs::read_to_string(&transcript_path)
        .map_err(|e| format!("Não foi possível ler a transcrição: {e}"))
}

#[tauri::command]
fn read_transcript_bundle(output_dir: String) -> Result<TranscriptBundle, String> {
    let dir = PathBuf::from(&output_dir);
    let txt_path = dir.join("transcricao.txt");
    if !txt_path.is_file() {
        return Err("Arquivo de transcrição (transcricao.txt) não encontrado.".into());
    }
    let txt = fs::read_to_string(&txt_path)
        .map_err(|e| format!("Não foi possível ler transcricao.txt: {e}"))?;
    let srt = fs::read_to_string(dir.join("transcricao.srt")).ok();
    let vtt = fs::read_to_string(dir.join("transcricao.vtt")).ok();
    let json = fs::read_to_string(dir.join("transcricao.json")).ok();
    let md = fs::read_to_string(dir.join("transcricao.md")).ok();

    Ok(TranscriptBundle {
        txt,
        srt,
        vtt,
        json,
        md,
    })
}

#[tauri::command]
fn get_history(state: State<'_, AppState>) -> Result<Vec<HistoryEntry>, String> {
    Ok(load_history(&state.history_path))
}

#[tauri::command]
fn delete_history_item(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut history = load_history(&state.history_path);
    history.retain(|item| item.id != id);
    persist_history(&state.history_path, &history)
}

#[tauri::command]
fn clear_history(state: State<'_, AppState>) -> Result<(), String> {
    persist_history(&state.history_path, &[])
}

#[tauri::command]
fn open_in_finder(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("O caminho não existe: {path}"));
    }
    let status = if target.is_dir() {
        std::process::Command::new("open").arg(&target).status()
    } else {
        std::process::Command::new("open")
            .args(["-R", target.to_string_lossy().as_ref()])
            .status()
    };
    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("Falha ao abrir no Finder (código {:?})", s.code())),
        Err(e) => Err(format!("Erro ao executar open: {e}")),
    }
}

async fn process_batch(app: AppHandle, concurrency: u8) {
    let mut workers = Vec::new();
    for _ in 0..concurrency {
        let worker_app = app.clone();
        workers.push(tauri::async_runtime::spawn(async move {
            worker(worker_app).await;
        }));
    }
    for worker in workers {
        let _ = worker.await;
    }
    let state = app.state::<AppState>();
    if let Ok(mut batch) = lock(&state.batch) {
        if let Some(batch) = batch.as_mut() {
            batch.running = false;
        }
    }
    emit_batch(&app);
}

async fn worker(app: AppHandle) {
    loop {
        let state = app.state::<AppState>();
        if state.cancelled.load(Ordering::SeqCst) {
            return;
        }
        let next = {
            let mut batch = match lock(&state.batch) {
                Ok(batch) => batch,
                Err(_) => return,
            };
            let Some(batch) = batch.as_mut() else { return };
            let Some(index) = batch
                .items
                .iter()
                .position(|item| item.status == ItemStatus::Aguardando)
            else {
                return;
            };
            batch.items[index].status = ItemStatus::Baixando;
            batch.items[index].progress = 5.0;
            let message = match batch.items[index].source_kind {
                SourceKind::Youtube => "Buscando informações do YouTube…",
                SourceKind::Drive => "Validando link do Google Drive…",
                SourceKind::Web => "Buscando informações do link Web…",
                SourceKind::VideoFile | SourceKind::AudioFile => "Preparando arquivo local…",
            };
            batch.items[index].stage = Some(message.into());
            batch.items[index].log.push(message.into());
            index
        };
        emit_batch(&app);
        process_item(&app, next).await;
    }
}

fn parse_ytdl_percentage(line: &str) -> Option<f32> {
    if let Some(pos) = line.find("%") {
        let start = line[..pos].rfind(|c: char| !c.is_numeric() && c != '.')?;
        let num_str = line[start + 1..pos].trim();
        num_str.parse::<f32>().ok()
    } else {
        None
    }
}

fn parse_whisper_percentage(line: &str) -> Option<f32> {
    if line.contains("progress =") {
        if let Some(pos) = line.find("progress =") {
            let remainder = &line[pos + "progress =".len()..];
            let num_str = remainder.trim_matches(|c: char| !c.is_numeric() && c != '.');
            num_str.parse::<f32>().ok()
        } else {
            None
        }
    } else {
        None
    }
}

async fn run_streaming_tool<F>(
    app: &AppHandle,
    program: &str,
    args: &[&str],
    cwd: &Path,
    mut on_line: F,
) -> Result<String, String>
where
    F: FnMut(&str) + Send + 'static,
{
    if is_cancelled(app) {
        return Err("Processamento cancelado.".into());
    }
    let state = app.state::<AppState>();
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Não foi possível executar {program}: {e}"))?;

    let pid = child
        .id()
        .ok_or("Não foi possível identificar o processo iniciado.")?;
    lock(&state.running_pids)?.insert(pid);

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let mut full_output = String::new();
    let mut stderr_tail = String::new();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    let tx_out = tx.clone();
    if let Some(out) = stdout {
        tokio::spawn(async move {
            let mut reader = BufReader::new(out).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = tx_out.send(line);
            }
        });
    }

    let tx_err = tx.clone();
    if let Some(err) = stderr {
        tokio::spawn(async move {
            let mut reader = BufReader::new(err).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = tx_err.send(line);
            }
        });
    }
    drop(tx);

    while let Some(line) = rx.recv().await {
        on_line(&line);
        full_output.push_str(&line);
        full_output.push('\n');
        stderr_tail = line;
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Erro ao aguardar {program}: {e}"))?;

    let _ = lock(&state.running_pids).map(|mut pids| pids.remove(&pid));

    if status.success() {
        return Ok(full_output);
    }
    if is_cancelled(app) {
        return Err("Processamento cancelado.".into());
    }

    Err(format!(
        "{program} falhou (código {}). {}",
        status
            .code()
            .map_or_else(|| "desconhecido".into(), |c| c.to_string()),
        stderr_tail.trim()
    ))
}

async fn process_item(app: &AppHandle, index: usize) {
    let state = app.state::<AppState>();
    let (batch_id, source, source_kind, local_path, item_dir, preferences) =
        match (|| -> Result<_, String> {
            let batch = lock(&state.batch)?;
            let batch_ref = batch.as_ref().ok_or("Lote não encontrado.")?;
            let item = batch_ref
                .items
                .get(index)
                .ok_or("Item da fila não encontrado.")?;
            Ok((
                batch_ref.id.clone(),
                item.source.clone(),
                item.source_kind,
                item.local_path.clone(),
                PathBuf::from(&item.output_dir),
                lock(&state.preferences)?.clone(),
            ))
        })() {
            Ok(value) => value,
            Err(error) => {
                fail_item(app, index, error);
                return;
            }
        };

    if let Err(error) = fs::create_dir_all(&item_dir) {
        fail_item(
            app,
            index,
            format!("Não foi possível criar a pasta do vídeo: {error}"),
        );
        return;
    }

    let mut item_title = None;

    let media_file = match source_kind {
        SourceKind::Youtube | SourceKind::Drive | SourceKind::Web => {
            let mut probe_args = vec![
                "--no-download",
                "--no-playlist",
                "--no-update",
                "--dump-single-json",
            ];
            if source_kind == SourceKind::Youtube {
                probe_args.extend(["--extractor-args", "youtube:player_client=ios,android,web,mweb"]);
            }
            probe_args.push(&source);
            let probe = run_tool(app, &preferences.yt_dlp_path, &probe_args, &item_dir).await;
            if let Ok(metadata) = probe {
                if let Ok(json) = serde_json::from_str::<Value>(&metadata) {
                    if let Some(title) = json.get("title").and_then(Value::as_str) {
                        item_title = Some(title.to_string());
                        update_item(app, index, |item| item.title = Some(title.into()));
                    }
                }
            }
            if is_cancelled(app) {
                return;
            }
            update_item(app, index, |item| {
                item.status = ItemStatus::Baixando;
                item.progress = 10.0;
                item.stage = Some("Baixando mídia via yt-dlp…".into());
                item.log.push("Baixando mídia via yt-dlp…".into());
            });
            let video_template = item_dir.join("video.%(ext)s").to_string_lossy().to_string();
            let mut download_args = vec![
                "--no-playlist",
                "--newline",
                "--no-update",
                "--ffmpeg-location",
                &preferences.ffmpeg_path,
                "--format",
                "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/bestvideo+bestaudio/best",
                "--merge-output-format",
                "mp4",
                "--recode-video",
                "mp4",
                "--output",
                &video_template,
            ];
            if source_kind == SourceKind::Youtube {
                download_args.extend(["--extractor-args", "youtube:player_client=ios,android,web,mweb"]);
            }
            download_args.push(&source);

            let app_download = app.clone();
            let dl_res = run_streaming_tool(
                app,
                &preferences.yt_dlp_path,
                &download_args,
                &item_dir,
                move |line| {
                    if let Some(pct) = parse_ytdl_percentage(line) {
                        let scaled = 10.0 + (pct * 0.25);
                        update_item(&app_download, index, |item| {
                            item.progress = scaled.min(35.0);
                            item.stage = Some(format!("Baixando mídia ({pct:.0}%)"));
                        });
                    }
                },
            )
            .await;

            if let Err(error) = dl_res {
                finish_error(app, index, error);
                return;
            }
            match find_downloaded_media(&item_dir) {
                Some(file) => file,
                None => {
                    finish_error(
                        app,
                        index,
                        "O download terminou, mas o arquivo de mídia não foi encontrado. Verifique o caminho do ffmpeg em Configurações.".into(),
                    );
                    return;
                }
            }
        }
        SourceKind::VideoFile | SourceKind::AudioFile => {
            let original = match local_path {
                Some(path) => PathBuf::from(path),
                None => {
                    fail_item(app, index, "O caminho do arquivo local está ausente.".into());
                    return;
                }
            };
            let extension = original
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("bin");
            let copied = item_dir.join(format!("original.{extension}"));
            update_item(app, index, |item| {
                item.status = ItemStatus::Convertendo;
                item.progress = 20.0;
                item.stage = Some("Copiando arquivo local para o lote…".into());
                item.log.push("Copiando arquivo local para o lote…".into());
            });
            if let Err(error) = fs::copy(&original, &copied) {
                fail_item(
                    app,
                    index,
                    format!("Não foi possível copiar o arquivo local: {error}"),
                );
                return;
            }
            copied
        }
    };
    if is_cancelled(app) {
        return;
    }

    update_item(app, index, |item| {
        item.status = ItemStatus::Convertendo;
        item.progress = 40.0;
        item.stage = Some("Extraindo áudio MP3…".into());
        item.log.push("Extraindo áudio MP3…".into());
    });
    let audio = item_dir.join("audio.mp3");
    let media_arg = media_file.to_string_lossy().to_string();
    let audio_arg = audio.to_string_lossy().to_string();
    let mut conversion_args = vec!["-y", "-i", media_arg.as_str()];
    if source_kind != SourceKind::AudioFile {
        conversion_args.push("-vn");
    }
    conversion_args.extend(["-codec:a", "libmp3lame", "-q:a", "2", audio_arg.as_str()]);
    if let Err(error) = run_tool(
        app,
        &preferences.ffmpeg_path,
        &conversion_args,
        &item_dir,
    )
    .await
    {
        finish_error(app, index, error);
        return;
    }
    if !audio.is_file() {
        finish_error(
            app,
            index,
            "A conversão terminou, mas não gerou audio.mp3.".into(),
        );
        return;
    }
    if is_cancelled(app) {
        return;
    }

    update_item(app, index, |item| {
        item.status = ItemStatus::Transcrevendo;
        item.progress = 50.0;
        item.stage = Some("Transcrevendo localmente em português…".into());
        item.log.push("Transcrevendo localmente em português…".into());
    });
    let model = preferences.model_path.clone();
    let audio = audio.to_string_lossy().to_string();

    let app_whisper = app.clone();
    let whisper_res = run_streaming_tool(
        app,
        &preferences.whisper_path,
        &[
            "-m",
            &model,
            "-f",
            &audio,
            "-l",
            "pt",
            "-otxt",
            "-osrt",
            "-ovtt",
            "-oj",
            "-pp",
            "-of",
            "transcricao",
        ],
        &item_dir,
        move |line| {
            if let Some(pct) = parse_whisper_percentage(line) {
                let scaled = 50.0 + (pct * 0.49);
                update_item(&app_whisper, index, |item| {
                    item.progress = scaled.min(99.0);
                    item.stage = Some(format!("Transcrevendo áudio ({pct:.0}%)"));
                });
            }
        },
    )
    .await;

    if let Err(error) = whisper_res {
        finish_error(app, index, error);
        return;
    }

    let txt_path = item_dir.join("transcricao.txt");
    if !txt_path.is_file() {
        finish_error(
            app,
            index,
            "A transcrição terminou, mas não gerou transcricao.txt.".into(),
        );
        return;
    }

    let raw_text = fs::read_to_string(&txt_path).unwrap_or_default();
    let srt_content = fs::read_to_string(item_dir.join("transcricao.srt")).ok();

    let model_filename = Path::new(&model)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("ggml-medium.bin");

    let final_title = item_title.unwrap_or_else(|| {
        if source_kind == SourceKind::Youtube {
            "Vídeo do YouTube".into()
        } else if source_kind == SourceKind::Drive {
            "Vídeo do Drive".into()
        } else if source_kind == SourceKind::VideoFile || source_kind == SourceKind::AudioFile {
            Path::new(&source)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("Mídia local")
                .into()
        } else {
            "Mídia Web".into()
        }
    });

    let md_content = generate_markdown_transcript(
        &final_title,
        &source,
        model_filename,
        &raw_text,
        srt_content.as_deref(),
    );
    let _ = fs::write(item_dir.join("transcricao.md"), md_content);

    let word_count = raw_text.trim().split_whitespace().count();
    let char_count = raw_text.chars().count();
    let preview_text: String = raw_text.chars().take(220).collect();

    let mut formats = vec!["txt".to_string(), "md".to_string()];
    if item_dir.join("transcricao.srt").is_file() {
        formats.push("srt".into());
    }
    if item_dir.join("transcricao.vtt").is_file() {
        formats.push("vtt".into());
    }
    if item_dir.join("transcricao.json").is_file() {
        formats.push("json".into());
    }

    let history_item = HistoryEntry {
        id: Uuid::new_v4().to_string(),
        batch_id,
        created_at: Local::now().to_rfc3339(),
        title: final_title.clone(),
        source: source.clone(),
        source_kind,
        output_dir: item_dir.to_string_lossy().into(),
        status: ItemStatus::Concluido,
        word_count,
        char_count,
        preview_text,
        model_name: model_filename.to_string(),
        formats,
    };
    append_history_entry(app, history_item);

    update_item(app, index, |item| {
        item.status = ItemStatus::Concluido;
        item.progress = 100.0;
        item.title = Some(final_title);
        item.stage = Some("Concluído: áudio, texto, legendas e Markdown prontos".into());
        item.log
            .push("Concluído: áudio, texto, legendas e Markdown prontos".into());
    });
}

fn is_cancelled(app: &AppHandle) -> bool {
    app.state::<AppState>().cancelled.load(Ordering::SeqCst)
}

fn fail_item(app: &AppHandle, index: usize, error: String) {
    update_item(app, index, |item| {
        item.status = ItemStatus::Falhou;
        item.progress = 0.0;
        item.stage = Some("Falhou".into());
        item.error = Some(error);
    });
}

fn finish_error(app: &AppHandle, index: usize, error: String) {
    if !is_cancelled(app) {
        fail_item(app, index, error);
    }
}

async fn run_tool(
    app: &AppHandle,
    program: &str,
    args: &[&str],
    cwd: &Path,
) -> Result<String, String> {
    if is_cancelled(app) {
        return Err("Processamento cancelado.".into());
    }
    let state = app.state::<AppState>();
    let child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Não foi possível executar {program}: {e}"))?;
    let pid = child
        .id()
        .ok_or("Não foi possível identificar o processo iniciado.")?;
    lock(&state.running_pids)?.insert(pid);
    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("Erro ao aguardar {program}: {e}"));
    let _ = lock(&state.running_pids).map(|mut pids| pids.remove(&pid));
    let output = output?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into());
    }
    if is_cancelled(app) {
        return Err("Processamento cancelado.".into());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let tail: String = stderr
        .chars()
        .rev()
        .take(700)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    Err(format!(
        "{program} falhou (código {}). {}",
        output
            .status
            .code()
            .map_or_else(|| "desconhecido".into(), |code| code.to_string()),
        tail.trim()
    ))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config_dir = app
                .path()
                .app_config_dir()
                .expect("pasta de configuração indisponível");
            let _ = fs::create_dir_all(&config_dir);
            let config_path = config_dir.join("preferences.json");
            let history_path = config_dir.join("history.json");
            let preferences = load_preferences(&config_path);

            app.manage(AppState {
                preferences: Mutex::new(preferences),
                batch: Mutex::new(None),
                cancelled: AtomicBool::new(false),
                running_pids: Mutex::new(HashSet::new()),
                active_downloads: Mutex::new(HashSet::new()),
                config_path,
                history_path,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_preferences,
            update_preferences,
            diagnose,
            list_whisper_models,
            download_whisper_model,
            cancel_model_download,
            set_active_model,
            create_batch,
            get_batch,
            start_batch,
            cancel_batch,
            read_transcript,
            read_transcript_bundle,
            get_history,
            delete_history_item,
            clear_history,
            open_in_finder
        ])
        .run(tauri::generate_context!())
        .expect("erro ao executar aplicativo Tauri");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_youtube_urls_correctly() {
        let (url, kind) = parse_web_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ").unwrap();
        assert_eq!(kind, SourceKind::Youtube);
        assert!(url.contains("youtube.com"));

        let (_, kind2) = parse_web_url("https://youtu.be/dQw4w9WgXcQ").unwrap();
        assert_eq!(kind2, SourceKind::Youtube);
    }

    #[test]
    fn parses_google_drive_urls_correctly() {
        let (_, kind) =
            parse_web_url("https://drive.google.com/file/d/abc123/view?usp=sharing").unwrap();
        assert_eq!(kind, SourceKind::Drive);

        let (_, kind2) = parse_web_url("https://drive.google.com/open?id=abc123").unwrap();
        assert_eq!(kind2, SourceKind::Drive);
    }

    #[test]
    fn parses_generic_web_urls() {
        let (_, kind) = parse_web_url("https://vimeo.com/76979871").unwrap();
        assert_eq!(kind, SourceKind::Web);
    }

    #[test]
    fn rejects_invalid_schemes_and_drive_folders() {
        assert!(parse_web_url("ftp://example.com/video.mp4").is_err());
        assert!(parse_web_url("https://drive.google.com/drive/folders/abc").is_err());
        assert!(parse_web_url("not-a-url").is_err());
    }

    #[test]
    fn default_preferences_use_local_tools() {
        let preferences = Preferences::default();
        assert_eq!(preferences.concurrency, 1);
        assert!(preferences.model_path.ends_with("ggml-medium.bin"));
    }

    #[test]
    fn parses_ytdl_and_whisper_percentages() {
        assert_eq!(
            parse_ytdl_percentage("[download]  42.5% of ~10.0MiB"),
            Some(42.5)
        );
        assert_eq!(
            parse_whisper_percentage("whisper_print_progress: progress = 67%"),
            Some(67.0)
        );
    }

    #[test]
    fn model_catalog_contains_expected_models() {
        assert_eq!(WHISPER_MODELS.len(), 6);
        assert!(WHISPER_MODELS.iter().any(|m| m.id == "tiny"));
        assert!(WHISPER_MODELS.iter().any(|m| m.id == "large-v3-turbo"));
    }

    #[test]
    fn classifies_supported_local_media_and_rejects_other_files() {
        let media = std::env::temp_dir().join(format!("yt-txt-{}.m4a", Uuid::new_v4()));
        fs::write(&media, b"test").unwrap();
        let (_, kind) = local_source(media.to_str().unwrap()).unwrap();
        assert_eq!(kind, SourceKind::AudioFile);
        fs::remove_file(&media).unwrap();
        assert!(local_source("/tmp/yt-txt-unsupported.pdf").is_err());
    }
}
