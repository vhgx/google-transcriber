use axum::{
    extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Query, State},
    http::{header, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        Response,
    },
    routing::{delete, get, post},
    Json, Router,
};
use chrono::Local;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    convert::Infallible,
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tower_http::{
    cors::{Any, CorsLayer},
    services::ServeDir,
    trace::TraceLayer,
};
use tracing::info;
use url::Url;
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

// ============================================================================
// ESTRUTURAS DE DADOS (DATA STRUCTURES)
// ============================================================================

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AiPreferences {
    pub provider: String,
    pub ollama_endpoint: String,
    pub ollama_model: String,
    pub gemini_api_key: String,
    pub gemini_model: String,
    pub openai_api_key: String,
    pub openai_model: String,
    pub groq_api_key: String,
    pub groq_model: String,
}

impl Default for AiPreferences {
    fn default() -> Self {
        let ollama_endpoint = std::env::var("OLLAMA_ENDPOINT")
            .or_else(|_| std::env::var("OLLAMA_HOST"))
            .unwrap_or_else(|_| "http://127.0.0.1:11434".into());

        Self {
            provider: "ollama".into(),
            ollama_endpoint,
            ollama_model: "llama3.2:latest".into(),
            gemini_api_key: std::env::var("GEMINI_API_KEY").unwrap_or_default(),
            gemini_model: "gemini-3.7-flash".into(),
            openai_api_key: std::env::var("OPENAI_API_KEY").unwrap_or_default(),
            openai_model: "gpt-4o-mini".into(),
            groq_api_key: std::env::var("GROQ_API_KEY").unwrap_or_default(),
            groq_model: "llama-3.3-70b-versatile".into(),
        }
    }
}

fn default_obsidian_subfolder() -> String {
    "Transcrições".into()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Preferences {
    pub yt_dlp_path: String,
    pub ffmpeg_path: String,
    pub whisper_path: String,
    pub model_path: String,
    pub output_dir: String,
    pub concurrency: u8,
    #[serde(default)]
    pub ai: AiPreferences,
    #[serde(default)]
    pub obsidian_vault_path: String,
    #[serde(default = "default_obsidian_subfolder")]
    pub obsidian_subfolder: String,
}

impl Default for Preferences {
    fn default() -> Self {
        let data_dir = std::env::var("DATA_DIR").unwrap_or_else(|_| {
            let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
            home.join(".local/share/yt-txt").to_string_lossy().into()
        });
        let data_path = PathBuf::from(&data_dir);

        let yt_dlp = std::env::var("YT_DLP_PATH").unwrap_or_else(|_| {
            if Path::new("/usr/local/bin/yt-dlp").exists() {
                "/usr/local/bin/yt-dlp".into()
            } else if Path::new("/usr/bin/yt-dlp").exists() {
                "/usr/bin/yt-dlp".into()
            } else if Path::new("/opt/homebrew/bin/yt-dlp").exists() {
                "/opt/homebrew/bin/yt-dlp".into()
            } else {
                "yt-dlp".into()
            }
        });

        let ffmpeg = std::env::var("FFMPEG_PATH").unwrap_or_else(|_| {
            if Path::new("/usr/local/bin/ffmpeg").exists() {
                "/usr/local/bin/ffmpeg".into()
            } else if Path::new("/usr/bin/ffmpeg").exists() {
                "/usr/bin/ffmpeg".into()
            } else if Path::new("/opt/homebrew/bin/ffmpeg").exists() {
                "/opt/homebrew/bin/ffmpeg".into()
            } else {
                "ffmpeg".into()
            }
        });

        let whisper = std::env::var("WHISPER_PATH").unwrap_or_else(|_| {
            if Path::new("/usr/local/bin/whisper-cli").exists() {
                "/usr/local/bin/whisper-cli".into()
            } else if Path::new("/usr/bin/whisper-cli").exists() {
                "/usr/bin/whisper-cli".into()
            } else if Path::new("/opt/homebrew/bin/whisper-cli").exists() {
                "/opt/homebrew/bin/whisper-cli".into()
            } else {
                "whisper-cli".into()
            }
        });

        let model_path = std::env::var("MODEL_PATH").unwrap_or_else(|_| {
            data_path
                .join("models/ggml-medium.bin")
                .to_string_lossy()
                .into()
        });

        let output_dir = std::env::var("OUTPUT_DIR").unwrap_or_else(|_| {
            data_path.join("downloads").to_string_lossy().into()
        });

        Self {
            yt_dlp_path: yt_dlp,
            ffmpeg_path: ffmpeg,
            whisper_path: whisper,
            model_path,
            output_dir,
            concurrency: 1,
            ai: AiPreferences::default(),
            obsidian_vault_path: "".into(),
            obsidian_subfolder: "Transcrições".into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Check {
    pub name: String,
    pub path: String,
    pub available: bool,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
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

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum ServerEvent {
    #[serde(rename = "batch-state")]
    BatchState(Batch),
    #[serde(rename = "model-download-progress")]
    ModelDownloadProgress(ModelDownloadProgress),
}

// ============================================================================
// ESTADO GLOBAL DO SERVIDOR (SERVER APP STATE)
// ============================================================================

#[derive(Clone)]
pub struct AppState {
    pub preferences: Arc<Mutex<Preferences>>,
    pub batch: Arc<Mutex<Option<Batch>>>,
    pub cancelled: Arc<AtomicBool>,
    pub running_pids: Arc<Mutex<HashSet<u32>>>,
    pub active_downloads: Arc<Mutex<HashSet<String>>>,
    pub config_path: PathBuf,
    pub history_path: PathBuf,
    pub uploads_dir: PathBuf,
    pub events_tx: broadcast::Sender<ServerEvent>,
}

fn lock<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, String> {
    mutex
        .lock()
        .map_err(|_| "O estado interno do aplicativo ficou indisponível.".into())
}

fn load_preferences(path: &Path) -> Preferences {
    let mut prefs: Preferences = fs::read_to_string(path)
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    let current = prefs.ai.gemini_model.trim();
    if current.is_empty()
        || current == "gemini-1.5-flash"
        || current == "gemini-2.0-flash"
        || current == "gemini-2.5-flash"
    {
        prefs.ai.gemini_model = "gemini-3.7-flash".to_string();
    } else if current == "gemini-1.5-pro" || current == "gemini-2.5-pro" {
        prefs.ai.gemini_model = "gemini-3.1-pro-preview".to_string();
    }
    prefs
}

fn persist_preferences(path: &Path, preferences: &Preferences) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
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
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(history).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| format!("Não foi possível salvar o histórico: {e}"))
}

fn append_history_entry(state: &AppState, entry: HistoryEntry) {
    let mut history = load_history(&state.history_path);
    history.retain(|item| item.id != entry.id);
    history.insert(0, entry);
    let _ = persist_history(&state.history_path, &history);
}

fn emit_batch(state: &AppState) {
    if let Ok(batch_guard) = lock(&state.batch) {
        if let Some(ref batch) = *batch_guard {
            let _ = state
                .events_tx
                .send(ServerEvent::BatchState(batch.clone()));
        }
    }
}

fn emit_model_progress(state: &AppState, progress: ModelDownloadProgress) {
    let _ = state
        .events_tx
        .send(ServerEvent::ModelDownloadProgress(progress));
}

fn update_item<F>(state: &AppState, index: usize, update: F)
where
    F: FnOnce(&mut BatchItem),
{
    if let Ok(mut batch) = lock(&state.batch) {
        if let Some(batch) = batch.as_mut() {
            if let Some(item) = batch.items.get_mut(index) {
                update(item);
            }
        }
    }
    emit_batch(state);
}

fn fail_item(state: &AppState, index: usize, error: String) {
    update_item(state, index, |item| {
        item.status = ItemStatus::Falhou;
        item.progress = 0.0;
        item.stage = Some("Falhou".into());
        item.error = Some(error);
    });
}

fn finish_error(state: &AppState, index: usize, error: String) {
    if !is_cancelled(state) {
        fail_item(state, index, error);
    }
}

fn is_cancelled(state: &AppState) -> bool {
    state.cancelled.load(Ordering::SeqCst)
}

fn resolve_models_directory(preferences: &Preferences) -> PathBuf {
    let current_model_path = Path::new(&preferences.model_path);
    if let Some(parent) = current_model_path.parent() {
        if parent.exists() && parent.is_dir() {
            return parent.to_path_buf();
        }
    }
    let data_dir = std::env::var("DATA_DIR").unwrap_or_else(|_| {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
        home.join(".local/share/yt-txt").to_string_lossy().into()
    });
    let default_dir = PathBuf::from(data_dir).join("models");
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
                "Formato não suportado: .{extension}. Selecione um vídeo ou áudio."
            ))
        }
    };
    Ok((path, kind))
}

fn check_binary_or_file(path_str: &str) -> (bool, String) {
    let path = Path::new(path_str);
    if path.is_file() {
        return (true, "Arquivo encontrado.".into());
    }
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(':') {
            let full = Path::new(dir).join(path_str);
            if full.is_file() {
                return (true, format!("Encontrado no PATH: {}", full.display()));
            }
        }
    }
    (
        false,
        "Arquivo não encontrado. Ajuste o caminho em Configurações.".into(),
    )
}

// ============================================================================
// MOTOR DE IA / LLM (Ollama, Gemini, OpenAI, Groq)
// ============================================================================

async fn execute_llm_request(
    ai_prefs: &AiPreferences,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Erro ao criar cliente HTTP: {e}"))?;

    match ai_prefs.provider.as_str() {
        "ollama" => {
            let endpoint = ai_prefs.ollama_endpoint.trim_end_matches('/');
            let url = format!("{endpoint}/api/generate");
            let body = json!({
                "model": ai_prefs.ollama_model,
                "system": system_prompt,
                "prompt": user_prompt,
                "stream": false,
            });

            let res = client
                .post(&url)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Não foi possível conectar ao Ollama ({url}): {e}"))?;

            if !res.status().is_success() {
                let status = res.status();
                let err_text = res.text().await.unwrap_or_default();
                return Err(format!("Ollama retornou erro (HTTP {status}): {err_text}"));
            }

            let val = res
                .json::<Value>()
                .await
                .map_err(|e| format!("Erro ao decodificar JSON do Ollama: {e}"))?;

            let answer = val.get("response").and_then(Value::as_str).unwrap_or("");
            if answer.trim().is_empty() {
                return Err("Ollama retornou uma resposta vazia.".into());
            }
            Ok(answer.to_string())
        }
        "gemini" => {
            if ai_prefs.gemini_api_key.trim().is_empty() {
                return Err("Chave de API do Google Gemini não configurada.".into());
            }
            let raw_model = ai_prefs.gemini_model.trim();
            let model = match raw_model {
                "" | "gemini-1.5-flash" | "gemini-2.0-flash" | "gemini-2.5-flash" => {
                    "gemini-3.7-flash"
                }
                "gemini-1.5-pro" | "gemini-2.5-pro" => "gemini-3.1-pro-preview",
                other => other,
            };
            let url = format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={}",
                ai_prefs.gemini_api_key.trim()
            );

            let body = json!({
                "systemInstruction": {
                    "parts": [{ "text": system_prompt }]
                },
                "contents": [
                    {
                        "parts": [{ "text": user_prompt }]
                    }
                ]
            });

            let res = client
                .post(&url)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Erro ao conectar com API do Google Gemini: {e}"))?;

            if !res.status().is_success() {
                let status = res.status();
                let err_text = res.text().await.unwrap_or_default();
                return Err(format!("Google Gemini retornou erro (HTTP {status}): {err_text}"));
            }

            let val = res
                .json::<Value>()
                .await
                .map_err(|e| format!("Erro ao decodificar resposta do Gemini: {e}"))?;

            let text = val
                .get("candidates")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("content"))
                .and_then(|c| c.get("parts"))
                .and_then(|p| p.get(0))
                .and_then(|p| p.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("");

            if text.trim().is_empty() {
                return Err("Gemini retornou uma resposta vazia.".into());
            }
            Ok(text.to_string())
        }
        "openai" | "groq" => {
            let is_groq = ai_prefs.provider == "groq";
            let (api_key, model, url) = if is_groq {
                (
                    &ai_prefs.groq_api_key,
                    if ai_prefs.groq_model.trim().is_empty() {
                        "llama-3.3-70b-versatile"
                    } else {
                        &ai_prefs.groq_model
                    },
                    "https://api.groq.com/openai/v1/chat/completions",
                )
            } else {
                (
                    &ai_prefs.openai_api_key,
                    if ai_prefs.openai_model.trim().is_empty() {
                        "gpt-4o-mini"
                    } else {
                        &ai_prefs.openai_model
                    },
                    "https://api.openai.com/v1/chat/completions",
                )
            };

            if api_key.trim().is_empty() {
                let name = if is_groq { "Groq" } else { "OpenAI" };
                return Err(format!("Chave de API do {name} não configurada."));
            }

            let body = json!({
                "model": model,
                "messages": [
                    { "role": "system", "content": system_prompt },
                    { "role": "user", "content": user_prompt }
                ],
                "temperature": 0.3
            });

            let res = client
                .post(url)
                .bearer_auth(api_key.trim())
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Erro ao conectar com a API: {e}"))?;

            if !res.status().is_success() {
                let status = res.status();
                let err_text = res.text().await.unwrap_or_default();
                return Err(format!("API retornou erro (HTTP {status}): {err_text}"));
            }

            let val = res
                .json::<Value>()
                .await
                .map_err(|e| format!("Erro ao decodificar JSON: {e}"))?;

            let text = val
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(Value::as_str)
                .unwrap_or("");

            if text.trim().is_empty() {
                return Err("A IA retornou uma resposta vazia.".into());
            }
            Ok(text.to_string())
        }
        _ => Err(format!("Provedor de IA desconhecido: {}", ai_prefs.provider)),
    }
}

// ============================================================================
// EXECUÇÃO DE PROCESSOS E PROCESSAMENTO DE LOTES (PROCESSOR)
// ============================================================================

fn parse_ytdl_percentage(line: &str) -> Option<f32> {
    if let Some(pos) = line.find('%') {
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

async fn run_tool(
    state: &AppState,
    program: &str,
    args: &[&str],
    cwd: &Path,
) -> Result<String, String> {
    if is_cancelled(state) {
        return Err("Processamento cancelado.".into());
    }
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
    if is_cancelled(state) {
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

async fn run_streaming_tool<F>(
    state: &AppState,
    program: &str,
    args: &[&str],
    cwd: &Path,
    mut on_line: F,
) -> Result<String, String>
where
    F: FnMut(&str) + Send + 'static,
{
    if is_cancelled(state) {
        return Err("Processamento cancelado.".into());
    }
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
    if is_cancelled(state) {
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

async fn process_batch(state: AppState, concurrency: u8) {
    let mut workers = Vec::new();
    for _ in 0..concurrency {
        let worker_state = state.clone();
        workers.push(tokio::spawn(async move {
            worker(worker_state).await;
        }));
    }
    for worker in workers {
        let _ = worker.await;
    }
    if let Ok(mut batch) = lock(&state.batch) {
        if let Some(batch) = batch.as_mut() {
            batch.running = false;
        }
    }
    emit_batch(&state);
}

async fn worker(state: AppState) {
    loop {
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
        emit_batch(&state);
        process_item(&state, next).await;
    }
}

async fn process_item(state: &AppState, index: usize) {
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
                fail_item(state, index, error);
                return;
            }
        };

    if let Err(error) = fs::create_dir_all(&item_dir) {
        fail_item(
            state,
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
                probe_args
                    .extend(["--extractor-args", "youtube:player_client=ios,android,web,mweb"]);
            }
            probe_args.push(&source);
            let probe = run_tool(state, &preferences.yt_dlp_path, &probe_args, &item_dir).await;
            if let Ok(metadata) = probe {
                if let Ok(json) = serde_json::from_str::<Value>(&metadata) {
                    if let Some(title) = json.get("title").and_then(Value::as_str) {
                        item_title = Some(title.to_string());
                        update_item(state, index, |item| item.title = Some(title.into()));
                    }
                }
            }
            if is_cancelled(state) {
                return;
            }
            update_item(state, index, |item| {
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
                download_args
                    .extend(["--extractor-args", "youtube:player_client=ios,android,web,mweb"]);
            }
            download_args.push(&source);

            let state_download = state.clone();
            let dl_res = run_streaming_tool(
                state,
                &preferences.yt_dlp_path,
                &download_args,
                &item_dir,
                move |line| {
                    if let Some(pct) = parse_ytdl_percentage(line) {
                        let scaled = 10.0 + (pct * 0.25);
                        update_item(&state_download, index, |item| {
                            item.progress = scaled.min(35.0);
                            item.stage = Some(format!("Baixando mídia ({pct:.0}%)"));
                        });
                    }
                },
            )
            .await;

            if let Err(error) = dl_res {
                finish_error(state, index, error);
                return;
            }
            match find_downloaded_media(&item_dir) {
                Some(file) => file,
                None => {
                    finish_error(
                        state,
                        index,
                        "O download terminou, mas o arquivo de mídia não foi encontrado.".into(),
                    );
                    return;
                }
            }
        }
        SourceKind::VideoFile | SourceKind::AudioFile => {
            let original = match local_path {
                Some(path) => PathBuf::from(path),
                None => {
                    fail_item(state, index, "O caminho do arquivo local está ausente.".into());
                    return;
                }
            };
            let extension = original
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("bin");
            let copied = item_dir.join(format!("original.{extension}"));
            update_item(state, index, |item| {
                item.status = ItemStatus::Convertendo;
                item.progress = 20.0;
                item.stage = Some("Copiando arquivo local para o lote…".into());
                item.log.push("Copiando arquivo local para o lote…".into());
            });
            if let Err(error) = fs::copy(&original, &copied) {
                fail_item(
                    state,
                    index,
                    format!("Não foi possível copiar o arquivo local: {error}"),
                );
                return;
            }
            copied
        }
    };
    if is_cancelled(state) {
        return;
    }

    update_item(state, index, |item| {
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
        state,
        &preferences.ffmpeg_path,
        &conversion_args,
        &item_dir,
    )
    .await
    {
        finish_error(state, index, error);
        return;
    }
    if !audio.is_file() {
        finish_error(
            state,
            index,
            "A conversão terminou, mas não gerou audio.mp3.".into(),
        );
        return;
    }
    if is_cancelled(state) {
        return;
    }

    update_item(state, index, |item| {
        item.status = ItemStatus::Transcrevendo;
        item.progress = 50.0;
        item.stage = Some("Transcrevendo localmente em português…".into());
        item.log.push("Transcrevendo localmente em português…".into());
    });
    let model = preferences.model_path.clone();
    let audio = audio.to_string_lossy().to_string();

    let state_whisper = state.clone();
    let whisper_res = run_streaming_tool(
        state,
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
                update_item(&state_whisper, index, |item| {
                    item.progress = scaled.min(99.0);
                    item.stage = Some(format!("Transcrevendo áudio ({pct:.0}%)"));
                });
            }
        },
    )
    .await;

    if let Err(error) = whisper_res {
        finish_error(state, index, error);
        return;
    }

    let txt_path = item_dir.join("transcricao.txt");
    if !txt_path.is_file() {
        finish_error(
            state,
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
    append_history_entry(state, history_item);

    update_item(state, index, |item| {
        item.status = ItemStatus::Concluido;
        item.progress = 100.0;
        item.title = Some(final_title);
        item.stage = Some("Concluído: áudio, texto, legendas e Markdown prontos".into());
        item.log
            .push("Concluído: áudio, texto, legendas e Markdown prontos".into());
    });
}

// ============================================================================
// ROTAS HTTP E CONTROLADORES (HANDLERS)
// ============================================================================

// 1. Preferências & Diagnóstico
async fn get_preferences_handler(
    State(state): State<AppState>,
) -> Result<Json<Preferences>, (StatusCode, String)> {
    let prefs = lock(&state.preferences).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(prefs.clone()))
}

async fn update_preferences_handler(
    State(state): State<AppState>,
    Json(preferences): Json<Preferences>,
) -> Result<Json<Preferences>, (StatusCode, String)> {
    if !(1..=2).contains(&preferences.concurrency) {
        return Err((
            StatusCode::BAD_REQUEST,
            "A concorrência deve ser 1 ou 2.".into(),
        ));
    }
    for (label, path) in [
        ("yt-dlp", &preferences.yt_dlp_path),
        ("ffmpeg", &preferences.ffmpeg_path),
        ("whisper-cli", &preferences.whisper_path),
        ("modelo", &preferences.model_path),
        ("pasta de saída", &preferences.output_dir),
    ] {
        if path.trim().is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("O caminho de {label} não pode estar vazio."),
            ));
        }
    }
    persist_preferences(&state.config_path, &preferences)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    *lock(&state.preferences).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))? =
        preferences.clone();
    Ok(Json(preferences))
}

async fn diagnose_handler(
    State(state): State<AppState>,
) -> Result<Json<Diagnostic>, (StatusCode, String)> {
    let preferences = lock(&state.preferences)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .clone();

    let checks = [
        ("yt-dlp", preferences.yt_dlp_path),
        ("ffmpeg", preferences.ffmpeg_path),
        ("whisper-cli", preferences.whisper_path),
        ("Modelo Whisper", preferences.model_path),
    ]
    .into_iter()
    .map(|(name, path)| {
        let (available, message) = check_binary_or_file(&path);
        Check {
            name: name.into(),
            path,
            available,
            message,
        }
    })
    .collect();

    Ok(Json(Diagnostic { checks }))
}

// 2. Modelos Whisper
async fn list_models_handler(
    State(state): State<AppState>,
) -> Result<Json<Vec<WhisperModelInfo>>, (StatusCode, String)> {
    let preferences = lock(&state.preferences)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .clone();
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

    Ok(Json(list))
}

#[derive(Deserialize)]
struct ModelDownloadRequest {
    model_id: String,
}

async fn download_model_handler(
    State(state): State<AppState>,
    Json(payload): Json<ModelDownloadRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let catalog_item = WHISPER_MODELS
        .iter()
        .find(|m| m.id == payload.model_id)
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                format!("Modelo não encontrado: {}", payload.model_id),
            )
        })?;

    let preferences = lock(&state.preferences)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .clone();
    let models_dir = resolve_models_directory(&preferences);
    fs::create_dir_all(&models_dir).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Não foi possível criar a pasta de modelos: {e}"),
        )
    })?;

    let target_file = models_dir.join(catalog_item.filename);
    let part_file = models_dir.join(format!("{}.part", catalog_item.filename));

    {
        let mut active = lock(&state.active_downloads)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        if active.contains(&payload.model_id) {
            return Err((
                StatusCode::BAD_REQUEST,
                "Este modelo já está sendo baixado.".into(),
            ));
        }
        active.insert(payload.model_id.clone());
    }

    let model_id_clone = payload.model_id.clone();
    let state_clone = state.clone();

    tokio::spawn(async move {
        let emit_prog = |status: &str, downloaded: u64, total: u64, pct: f32, err: Option<String>| {
            emit_model_progress(
                &state_clone,
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

        emit_prog("downloading", 0, catalog_item.size_bytes, 0.0, None);

        let response = match reqwest::get(catalog_item.download_url).await {
            Ok(resp) => {
                if !resp.status().is_success() {
                    let err = format!("Servidor retornou status HTTP {}", resp.status());
                    emit_prog("error", 0, catalog_item.size_bytes, 0.0, Some(err));
                    if let Ok(mut active) = lock(&state_clone.active_downloads) {
                        active.remove(&model_id_clone);
                    }
                    return;
                }
                resp
            }
            Err(e) => {
                let err = format!("Erro ao conectar com Hugging Face: {e}");
                emit_prog("error", 0, catalog_item.size_bytes, 0.0, Some(err));
                if let Ok(mut active) = lock(&state_clone.active_downloads) {
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
                emit_prog("error", 0, total_size, 0.0, Some(err));
                if let Ok(mut active) = lock(&state_clone.active_downloads) {
                    active.remove(&model_id_clone);
                }
                return;
            }
        };

        use tokio::io::AsyncWriteExt;
        let mut last_emit = std::time::Instant::now();

        while let Some(chunk_result) = stream.next().await {
            let is_cancelled = {
                if let Ok(active) = lock(&state_clone.active_downloads) {
                    !active.contains(&model_id_clone)
                } else {
                    true
                }
            };

            if is_cancelled {
                let _ = tokio::fs::remove_file(&part_file).await;
                emit_prog("cancelled", downloaded, total_size, 0.0, None);
                return;
            }

            match chunk_result {
                Ok(chunk) => {
                    if let Err(e) = file.write_all(&chunk).await {
                        let err = format!("Erro de gravação em disco: {e}");
                        emit_prog("error", downloaded, total_size, 0.0, Some(err));
                        let _ = tokio::fs::remove_file(&part_file).await;
                        if let Ok(mut active) = lock(&state_clone.active_downloads) {
                            active.remove(&model_id_clone);
                        }
                        return;
                    }
                    downloaded += chunk.len() as u64;
                    if last_emit.elapsed().as_millis() > 200 || downloaded >= total_size {
                        let pct = (downloaded as f32 / total_size as f32) * 100.0;
                        emit_prog("downloading", downloaded, total_size, pct.min(99.9), None);
                        last_emit = std::time::Instant::now();
                    }
                }
                Err(e) => {
                    let err = format!("Falha no download dos dados: {e}");
                    emit_prog("error", downloaded, total_size, 0.0, Some(err));
                    let _ = tokio::fs::remove_file(&part_file).await;
                    if let Ok(mut active) = lock(&state_clone.active_downloads) {
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
            emit_prog("error", downloaded, total_size, 0.0, Some(err));
        } else {
            emit_prog("completed", total_size, total_size, 100.0, None);
        }

        if let Ok(mut active) = lock(&state_clone.active_downloads) {
            active.remove(&model_id_clone);
        }
    });

    Ok(Json(json!({ "success": true })))
}

#[derive(Deserialize)]
struct CancelModelRequest {
    model_id: String,
}

async fn cancel_model_download_handler(
    State(state): State<AppState>,
    Json(payload): Json<CancelModelRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let mut active =
        lock(&state.active_downloads).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    active.remove(&payload.model_id);
    Ok(Json(json!({ "success": true })))
}

#[derive(Deserialize)]
struct SetActiveModelRequest {
    model_path: String,
}

async fn set_active_model_handler(
    State(state): State<AppState>,
    Json(payload): Json<SetActiveModelRequest>,
) -> Result<Json<Preferences>, (StatusCode, String)> {
    let path = PathBuf::from(&payload.model_path);
    if !path.is_file() {
        return Err((
            StatusCode::NOT_FOUND,
            format!("Arquivo de modelo não encontrado: {}", payload.model_path),
        ));
    }
    let mut prefs = lock(&state.preferences)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .clone();
    prefs.model_path = payload.model_path;
    persist_preferences(&state.config_path, &prefs)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    *lock(&state.preferences).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))? =
        prefs.clone();
    Ok(Json(prefs))
}

// 3. Uploads de Arquivos
async fn upload_handler(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<Value>, (StatusCode, String)> {
    let mut saved_paths = Vec::new();
    let _ = fs::create_dir_all(&state.uploads_dir);

    while let Ok(Some(field)) = multipart.next_field().await {
        let _name = field.name().unwrap_or("file").to_string();
        let file_name = field
            .file_name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("upload_{}.bin", Uuid::new_v4()));

        let data = field
            .bytes()
            .await
            .map_err(|e| (StatusCode::BAD_REQUEST, format!("Erro no upload: {e}")))?;

        let unique_name = format!("{}_{}", Uuid::new_v4(), file_name);
        let target_path = state.uploads_dir.join(unique_name);

        fs::write(&target_path, &data).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Erro ao gravar arquivo em disco: {e}"),
            )
        })?;

        saved_paths.push(target_path.to_string_lossy().to_string());
    }

    Ok(Json(json!({ "paths": saved_paths })))
}

// 4. Lotes (Batch)
#[derive(Deserialize)]
struct CreateBatchRequest {
    urls: Vec<String>,
    files: Vec<String>,
}

async fn create_batch_handler(
    State(state): State<AppState>,
    Json(payload): Json<CreateBatchRequest>,
) -> Result<Json<Batch>, (StatusCode, String)> {
    if lock(&state.batch)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .as_ref()
        .is_some_and(|b| b.running)
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Aguarde o lote atual terminar ou cancele-o antes de criar outro.".into(),
        ));
    }

    let mut seen = HashSet::new();
    let mut sources: Vec<(String, SourceKind, Option<String>, Option<String>)> = Vec::new();

    for raw in payload.urls {
        if raw.trim().is_empty() {
            continue;
        }
        let (url, kind) =
            parse_web_url(&raw).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
        if seen.insert(url.clone()) {
            sources.push((url, kind, None, None));
        }
    }

    for raw in payload.files {
        let (path, kind) =
            local_source(&raw).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
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
        return Err((
            StatusCode::BAD_REQUEST,
            "Cole uma URL (YouTube, Drive ou Web) ou selecione pelo menos um arquivo.".into(),
        ));
    }

    let preferences = lock(&state.preferences)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .clone();
    let output_dir = PathBuf::from(preferences.output_dir)
        .join(Local::now().format("%Y-%m-%d_%H-%M-%S").to_string());
    fs::create_dir_all(&output_dir).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Não foi possível criar a pasta do lote: {e}"),
        )
    })?;

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

    *lock(&state.batch).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))? =
        Some(batch.clone());
    state.cancelled.store(false, Ordering::SeqCst);
    emit_batch(&state);
    Ok(Json(batch))
}

async fn get_batch_handler(
    State(state): State<AppState>,
) -> Result<Json<Option<Batch>>, (StatusCode, String)> {
    let batch = lock(&state.batch).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(batch.clone()))
}

async fn start_batch_handler(
    State(state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let concurrency = lock(&state.preferences)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .concurrency;

    {
        let mut batch =
            lock(&state.batch).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        let batch = batch
            .as_mut()
            .ok_or((StatusCode::BAD_REQUEST, "Crie um lote antes de iniciar.".into()))?;
        if batch.running {
            return Err((
                StatusCode::BAD_REQUEST,
                "Este lote já está em processamento.".into(),
            ));
        }
        batch.running = true;
        batch.cancelled = false;
    }

    state.cancelled.store(false, Ordering::SeqCst);
    emit_batch(&state);

    let state_worker = state.clone();
    tokio::spawn(async move {
        process_batch(state_worker, concurrency).await;
    });

    Ok(Json(json!({ "success": true })))
}

async fn cancel_batch_handler(
    State(state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, String)> {
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

    let pids: Vec<u32> = lock(&state.running_pids)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .iter()
        .copied()
        .collect();

    for pid in pids {
        let _ = std::process::Command::new("/bin/kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }

    emit_batch(&state);
    Ok(Json(json!({ "success": true })))
}

// 5. Server-Sent Events (SSE)
async fn sse_events_handler(
    State(state): State<AppState>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let rx = state.events_tx.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|res| async move {
        match res {
            Ok(event) => match serde_json::to_string(&event) {
                Ok(json_str) => {
                    let event_name = match &event {
                        ServerEvent::BatchState(_) => "batch-state",
                        ServerEvent::ModelDownloadProgress(_) => "model-download-progress",
                    };
                    Some(Ok(Event::default().event(event_name).data(json_str)))
                }
                Err(_) => None,
            },
            Err(_) => None,
        }
    });

    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    )
}

// 6. Transcrição e Arquivos
#[derive(Deserialize)]
struct OutputDirQuery {
    output_dir: String,
}

async fn read_transcript_handler(
    Query(query): Query<OutputDirQuery>,
) -> Result<String, (StatusCode, String)> {
    let dir = PathBuf::from(&query.output_dir);
    let transcript_path = dir.join("transcricao.txt");
    if !transcript_path.is_file() {
        return Err((
            StatusCode::NOT_FOUND,
            "Arquivo transcricao.txt não encontrado.".into(),
        ));
    }
    fs::read_to_string(&transcript_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Não foi possível ler a transcrição: {e}"),
        )
    })
}

async fn read_transcript_bundle_handler(
    Query(query): Query<OutputDirQuery>,
) -> Result<Json<TranscriptBundle>, (StatusCode, String)> {
    let dir = PathBuf::from(&query.output_dir);
    let txt_path = dir.join("transcricao.txt");
    if !txt_path.is_file() {
        return Err((
            StatusCode::NOT_FOUND,
            "Arquivo transcricao.txt não encontrado.".into(),
        ));
    }
    let txt = fs::read_to_string(&txt_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Não foi possível ler transcricao.txt: {e}"),
        )
    })?;
    let srt = fs::read_to_string(dir.join("transcricao.srt")).ok();
    let vtt = fs::read_to_string(dir.join("transcricao.vtt")).ok();
    let json = fs::read_to_string(dir.join("transcricao.json")).ok();
    let md = fs::read_to_string(dir.join("transcricao.md")).ok();

    Ok(Json(TranscriptBundle {
        txt,
        srt,
        vtt,
        json,
        md,
    }))
}

async fn read_audio_handler(
    Query(query): Query<OutputDirQuery>,
) -> Result<Response, (StatusCode, String)> {
    let dir = PathBuf::from(&query.output_dir);
    let audio_path = dir.join("audio.mp3");

    let final_path = if audio_path.is_file() {
        Some(audio_path)
    } else if let Ok(entries) = fs::read_dir(&dir) {
        entries.flatten().find_map(|entry| {
            let p = entry.path();
            if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                let lower = ext.to_ascii_lowercase();
                if matches!(
                    lower.as_str(),
                    "mp3" | "m4a" | "wav" | "aac" | "ogg" | "flac" | "opus" | "webm"
                ) {
                    return Some(p);
                }
            }
            None
        })
    } else {
        None
    };

    let Some(target) = final_path else {
        return Err((
            StatusCode::NOT_FOUND,
            "Arquivo de áudio não encontrado.".into(),
        ));
    };

    let bytes = fs::read(&target).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Erro ao ler áudio: {e}"),
        )
    })?;

    let mime_type = if target.extension().and_then(|e| e.to_str()) == Some("wav") {
        "audio/wav"
    } else if target.extension().and_then(|e| e.to_str()) == Some("webm") {
        "audio/webm"
    } else {
        "audio/mpeg"
    };

    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime_type)
        .header(header::CONTENT_LENGTH, bytes.len().to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .body(axum::body::Body::from(bytes))
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Erro ao construir resposta: {e}"),
            )
        })?;

    Ok(response)
}

#[derive(Deserialize)]
struct SaveTranscriptRequest {
    output_dir: String,
    txt: String,
    srt: Option<String>,
}

async fn save_transcript_handler(
    State(state): State<AppState>,
    Json(payload): Json<SaveTranscriptRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let dir = PathBuf::from(&payload.output_dir);
    if !dir.is_dir() {
        return Err((
            StatusCode::NOT_FOUND,
            format!("Pasta de saída não encontrada: {}", payload.output_dir),
        ));
    }

    let txt_path = dir.join("transcricao.txt");
    fs::write(&txt_path, &payload.txt).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Erro ao salvar transcricao.txt: {e}"),
        )
    })?;

    if let Some(ref srt_content) = payload.srt {
        let srt_path = dir.join("transcricao.srt");
        let _ = fs::write(&srt_path, srt_content);
    }

    let word_count = payload.txt.trim().split_whitespace().count();
    let char_count = payload.txt.chars().count();
    let preview_text: String = payload.txt.chars().take(220).collect();

    let mut history = load_history(&state.history_path);
    let mut title = "Transcrição".to_string();
    let mut source = "".to_string();
    let mut model_name = "ggml-medium.bin".to_string();

    if let Some(entry) = history.iter_mut().find(|h| h.output_dir == payload.output_dir) {
        entry.word_count = word_count;
        entry.char_count = char_count;
        entry.preview_text = preview_text;
        title = entry.title.clone();
        source = entry.source.clone();
        model_name = entry.model_name.clone();
    }
    let _ = persist_history(&state.history_path, &history);

    let md_content = generate_markdown_transcript(
        &title,
        &source,
        &model_name,
        &payload.txt,
        payload.srt.as_deref(),
    );
    let _ = fs::write(dir.join("transcricao.md"), md_content);

    Ok(Json(json!({ "success": true })))
}

#[derive(Deserialize)]
struct SaveRecordingRequest {
    bytes: Vec<u8>,
    filename: String,
}

async fn save_recording_handler(
    State(state): State<AppState>,
    Json(payload): Json<SaveRecordingRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    if payload.bytes.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Áudio gravado está vazio.".into()));
    }
    let preferences = lock(&state.preferences)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .clone();
    let recordings_dir = PathBuf::from(preferences.output_dir).join("Gravações");
    fs::create_dir_all(&recordings_dir).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Não foi possível criar a pasta de gravações: {e}"),
        )
    })?;

    let safe_name = if payload.filename.trim().is_empty() {
        format!(
            "gravacao_{}.webm",
            Local::now().format("%Y-%m-%d_%H-%M-%S")
        )
    } else {
        payload.filename
    };

    let target = recordings_dir.join(safe_name);
    fs::write(&target, payload.bytes).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Erro ao gravar áudio: {e}"),
        )
    })?;

    Ok(Json(json!({ "path": target.to_string_lossy().to_string() })))
}

// 7. IA Insights
#[derive(Deserialize)]
struct CheckOllamaRequest {
    endpoint: Option<String>,
}

async fn check_ollama_handler(
    Json(payload): Json<CheckOllamaRequest>,
) -> Result<Json<Vec<String>>, (StatusCode, String)> {
    let raw_endpoint = payload
        .endpoint
        .unwrap_or_else(|| "http://127.0.0.1:11434".into());
    let url = format!("{}/api/tags", raw_endpoint.trim_end_matches('/'));

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Erro HTTP: {e}")))?;

    let res = client
        .get(&url)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("Ollama indisponível em {raw_endpoint}: {e}")))?;

    if !res.status().is_success() {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("Ollama retornou HTTP {}", res.status()),
        ));
    }

    let val = res
        .json::<Value>()
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Erro JSON Ollama: {e}")))?;

    let mut models = Vec::new();
    if let Some(arr) = val.get("models").and_then(Value::as_array) {
        for m in arr {
            if let Some(name) = m.get("name").and_then(Value::as_str) {
                models.push(name.to_string());
            }
        }
    }

    Ok(Json(models))
}

#[derive(Deserialize)]
struct GenerateAiRequest {
    output_dir: String,
    template_id: String,
    custom_prompt: Option<String>,
}

async fn generate_ai_handler(
    State(state): State<AppState>,
    Json(payload): Json<GenerateAiRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let dir = PathBuf::from(&payload.output_dir);
    if !dir.is_dir() {
        return Err((
            StatusCode::NOT_FOUND,
            format!("Pasta de saída não encontrada: {}", payload.output_dir),
        ));
    }

    let txt_path = dir.join("transcricao.txt");
    if !txt_path.is_file() {
        return Err((
            StatusCode::NOT_FOUND,
            "Arquivo transcricao.txt não encontrado para análise.".into(),
        ));
    }

    let transcript_text = fs::read_to_string(&txt_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Não foi possível ler transcricao.txt: {e}"),
        )
    })?;

    let srt_text = fs::read_to_string(dir.join("transcricao.srt")).unwrap_or_default();
    let ai_prefs = lock(&state.preferences)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ai
        .clone();

    let (system_prompt, user_prompt, save_filename) = match payload.template_id.as_str() {
        "summary" => (
            "Você é um assistente executivo e analista sênior de conteúdo em língua portuguesa.".to_string(),
            format!(
                "Gere um Resumo Executivo estruturado e elegante em Markdown da transcrição a seguir.\n\n\
                Estrutura recomendada:\n\
                # 📝 Resumo Executivo\n\
                ## 📌 Visão Geral & Contexto\n\
                ## 💡 Principais Tópicos & Ideias Centrais\n\
                ## 🎯 Conclusões & Pontos Relevantes\n\n\
                Transcrição:\n\n{transcript_text}"
            ),
            "resumo.md",
        ),
        "actions" => (
            "Você é um especialista em produtividade, gestão de projetos e reuniões em língua portuguesa.".to_string(),
            format!(
                "Analise a transcrição a seguir e extraia um Plano de Ação e Lista de Tarefas claras em Markdown.\n\n\
                Estrutura recomendada:\n\
                # 🎯 Plano de Ação & Tarefas\n\
                ## 📌 Decisões Tomadas\n\
                ## 📋 Tarefas Identificadas (com responsáveis se citados)\n\
                ## ⏳ Prazos & Próximos Passos\n\n\
                Transcrição:\n\n{transcript_text}"
            ),
            "tarefas.md",
        ),
        "chapters" => (
            "Você é um editor de vídeo profissional especialista em minutagem e capítulos para YouTube em língua portuguesa.".to_string(),
            format!(
                "Crie os Capítulos / Minutagem (Timestamps) para o YouTube em formato de texto limpo a partir das legendas SRT abaixo.\n\n\
                Formato esperado:\n\
                00:00 Introdução\n\
                01:23 Título do Tópico\n\n\
                Legendas SRT com minutagem:\n\n{srt_text}"
            ),
            "capitulos.md",
        ),
        "clean" => (
            "Você é um redator e editor de texto profissional em língua portuguesa.".to_string(),
            format!(
                "Transforme a transcrição de fala espontânea abaixo em um Artigo / Transcrição Limpa e polida, removendo repetições e cacoetes sem perder o conteúdo original.\n\n\
                Transcrição:\n\n{transcript_text}"
            ),
            "transcricao_limpa.md",
        ),
        "obsidian" => {
            let today = chrono::Local::now().format("%Y-%m-%d").to_string();
            (
                "Você é um arquivista do conhecimento, pesquisador e especialista em Obsidian, Zettelkasten e Ciência da Aprendizagem Didática.".to_string(),
                format!(
                    "Transforme a transcrição a seguir em uma Nota Didática Completa para o Obsidian no formato Zettelkasten / Literature Note em Markdown.\n\n\
                    A nota deve seguir rigorosamente a estrutura abaixo:\n\n\
                    ---\n\
                    type: literature-note/video\n\
                    date: {today}\n\
                    tags:\n\
                      - transcricao\n\
                      - aprendizado\n\
                      - segundo-cerebro\n\
                    aliases: []\n\
                    status: processado\n\
                    ---\n\n\
                    # 📺 [[Título Didático e Preciso do Conteúdo]]\n\n\
                    > [!SUMMARY] Síntese Didática (Método Feynman)\n\
                    > Explicação concisa e clara da ideia central em 2 a 3 frases, facilitando a compreensão rápida.\n\n\
                    ## 💡 Big Ideas & Lições Centrais\n\
                    - 3 a 5 principais insights práticos e conclusões fundamentais extraídas da fala.\n\n\
                    ## 🧠 Conceitos-Chave & Conexões (com [[Wikilinks]])\n\
                    - Explique de forma didática os principais conceitos, termos técnicos ou metodologias abordadas.\n\
                    - OBRIGATÓRIO: Use colchetes duplos `[[Nome do Conceito]]` nos termos e tópicos centrais para interligar ao Grafo do Obsidian.\n\n\
                    ## ⏱️ Minutagem & Destaques Cronológicos\n\
                    - Se houver legendas/timestamps abaixo, liste os momentos-chave em `00:00 Nome do Trecho`.\n\n\
                    ## ❓ Perguntas para Fixação (Active Recall / Flashcards)\n\
                    - 3 a 4 perguntas e respostas para memorização ativa no formato `Pergunta::Resposta`.\n\n\
                    Legendas SRT:\n{}\n\n\
                    Transcrição:\n{transcript_text}",
                    if !srt_text.trim().is_empty() { &srt_text } else { "(Legendas com timestamps não disponíveis)" }
                ),
                "nota_obsidian.md",
            )
        }
        "custom" => {
            let custom_instruction = payload
                .custom_prompt
                .as_deref()
                .unwrap_or("Analise a transcrição e apresente os pontos principais.");
            (
                "Você é um assistente de IA prestativo em língua portuguesa.".to_string(),
                format!("{custom_instruction}\n\nTranscrição:\n\n{transcript_text}"),
                "analise_personalizada.md",
            )
        }
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("Template desconhecido: {}", payload.template_id),
            ))
        }
    };

    let result = execute_llm_request(&ai_prefs, &system_prompt, &user_prompt)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let save_path = dir.join(save_filename);
    let _ = fs::write(&save_path, &result);

    Ok(Json(json!({ "result": result })))
}

#[derive(Deserialize)]
struct ChatAiRequest {
    output_dir: String,
    question: String,
    history: Vec<(String, String)>,
}

async fn chat_ai_handler(
    State(state): State<AppState>,
    Json(payload): Json<ChatAiRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let dir = PathBuf::from(&payload.output_dir);
    let txt_path = dir.join("transcricao.txt");
    if !txt_path.is_file() {
        return Err((
            StatusCode::NOT_FOUND,
            "Arquivo transcricao.txt não encontrado.".into(),
        ));
    }

    let transcript_text = fs::read_to_string(&txt_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Não foi possível ler a transcrição: {e}"),
        )
    })?;

    let ai_prefs = lock(&state.preferences)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ai
        .clone();

    let system_prompt = format!(
        "Você é um assistente inteligente e prestativo conversando sobre a seguinte transcrição de áudio/vídeo em português:\n\n\
        --- INÍCIO DA TRANSCRIÇÃO ---\n\
        {transcript_text}\n\
        --- FIM DA TRANSCRIÇÃO ---\n\n\
        Responda às perguntas do usuário com precisão e clareza, sempre fundamentando suas respostas no conteúdo falado na transcrição acima."
    );

    let mut context_prompt = String::new();
    for (user_msg, assistant_msg) in payload.history.iter().rev().take(6).rev() {
        context_prompt.push_str(&format!("Usuário: {user_msg}\nAssistente: {assistant_msg}\n\n"));
    }
    context_prompt.push_str(&format!("Pergunta atual do Usuário: {}", payload.question));

    let answer = execute_llm_request(&ai_prefs, &system_prompt, &context_prompt)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(json!({ "answer": answer })))
}

async fn list_saved_insights_handler(
    Query(query): Query<OutputDirQuery>,
) -> Result<Json<Vec<(String, String, String)>>, (StatusCode, String)> {
    let dir = PathBuf::from(&query.output_dir);
    let mut insights = Vec::new();

    let mappings = [
        ("summary", "Resumo Executivo", "resumo.md"),
        ("actions", "Plano de Ação & Tarefas", "tarefas.md"),
        ("chapters", "Capítulos do YouTube", "capitulos.md"),
        ("clean", "Transcrição Limpa", "transcricao_limpa.md"),
        ("obsidian", "Nota Obsidian (Zettelkasten)", "nota_obsidian.md"),
        ("custom", "Análise Personalizada", "analise_personalizada.md"),
    ];

    for (id, title, filename) in mappings {
        let p = dir.join(filename);
        if p.is_file() {
            if let Ok(content) = fs::read_to_string(&p) {
                insights.push((id.to_string(), title.to_string(), content));
            }
        }
    }

    Ok(Json(insights))
}

#[derive(Deserialize)]
struct ObsidianExportRequest {
    output_dir: String,
    filename: Option<String>,
    content: Option<String>,
}

#[derive(Serialize)]
struct ObsidianExportResponse {
    saved_path: String,
    vault_name: String,
    obsidian_uri: String,
}

fn sanitize_filename(name: &str) -> String {
    let invalid_chars = ['/', '\\', ':', '*', '?', '"', '<', '>', '|', '\n', '\r', '\t'];
    let sanitized: String = name
        .chars()
        .map(|c| if invalid_chars.contains(&c) { ' ' } else { c })
        .collect();
    let trimmed = sanitized.split_whitespace().collect::<Vec<_>>().join(" ");
    let without_brackets = trimmed.trim_matches(|c| c == '[' || c == ']' || c == '#' || c == ' ');
    if without_brackets.is_empty() {
        "Nota Transcricao".to_string()
    } else {
        without_brackets.chars().take(80).collect()
    }
}

fn extract_title_from_note_or_dir(content: &str, output_dir: &str) -> String {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("# ") {
            let title = trimmed.trim_start_matches('#').trim();
            let cleaned = title
                .trim_start_matches(|c: char| !c.is_alphanumeric() && c != '[')
                .trim_matches(|c: char| c == '[' || c == ']' || c == ' ');
            if !cleaned.is_empty() {
                return cleaned.to_string();
            }
        }
    }

    Path::new(output_dir)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| "Nota Transcricao".to_string())
}

async fn export_to_obsidian_handler(
    State(state): State<AppState>,
    Json(payload): Json<ObsidianExportRequest>,
) -> Result<Json<ObsidianExportResponse>, (StatusCode, String)> {
    let prefs = lock(&state.preferences)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .clone();

    let vault_path_str = prefs.obsidian_vault_path.trim();
    if vault_path_str.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "Caminho do Obsidian Vault não configurado nas preferências.".into(),
        ));
    }

    let vault_path = PathBuf::from(vault_path_str);
    if !vault_path.is_dir() {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("A pasta do Obsidian Vault não existe: {vault_path_str}"),
        ));
    }

    let vault_name = vault_path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| "Obsidian".to_string());

    let md_content = if let Some(c) = payload.content {
        if !c.trim().is_empty() {
            c
        } else {
            let note_path = PathBuf::from(&payload.output_dir).join("nota_obsidian.md");
            if note_path.is_file() {
                fs::read_to_string(&note_path).map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Erro ao ler nota_obsidian.md: {e}"),
                    )
                })?
            } else {
                return Err((
                    StatusCode::NOT_FOUND,
                    "Nenhum conteúdo fornecido e nota_obsidian.md não foi encontrada.".into(),
                ));
            }
        }
    } else {
        let note_path = PathBuf::from(&payload.output_dir).join("nota_obsidian.md");
        if note_path.is_file() {
            fs::read_to_string(&note_path).map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Erro ao ler nota_obsidian.md: {e}"),
                )
            })?
        } else {
            return Err((
                StatusCode::NOT_FOUND,
                "A Nota do Obsidian ainda não foi gerada para este lote.".into(),
            ));
        }
    };

    let subfolder_name = if prefs.obsidian_subfolder.trim().is_empty() {
        "Transcrições".to_string()
    } else {
        prefs.obsidian_subfolder.trim().to_string()
    };

    let target_dir = vault_path.join(&subfolder_name);
    if let Err(e) = fs::create_dir_all(&target_dir) {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Falha ao criar subpasta no cofre: {e}"),
        ));
    }

    let base_filename = if let Some(f) = payload.filename {
        if !f.trim().is_empty() {
            f
        } else {
            extract_title_from_note_or_dir(&md_content, &payload.output_dir)
        }
    } else {
        extract_title_from_note_or_dir(&md_content, &payload.output_dir)
    };

    let sanitized_filename = sanitize_filename(&base_filename);
    let final_filename = if sanitized_filename.ends_with(".md") {
        sanitized_filename
    } else {
        format!("{sanitized_filename}.md")
    };

    let target_file_path = target_dir.join(&final_filename);
    if let Err(e) = fs::write(&target_file_path, &md_content) {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Erro ao gravar nota no cofre: {e}"),
        ));
    }

    let relative_path_no_ext = if subfolder_name.is_empty() {
        final_filename.trim_end_matches(".md").to_string()
    } else {
        format!("{}/{}", subfolder_name, final_filename.trim_end_matches(".md"))
    };

    let mut u = url::Url::parse("obsidian://open").unwrap_or_else(|_| url::Url::parse("obsidian://open").unwrap());
    u.query_pairs_mut()
        .append_pair("vault", &vault_name)
        .append_pair("file", &relative_path_no_ext);

    let obsidian_uri = u.to_string();

    Ok(Json(ObsidianExportResponse {
        saved_path: target_file_path.to_string_lossy().to_string(),
        vault_name,
        obsidian_uri,
    }))
}

#[derive(Deserialize)]
struct ObsidianOpenRequest {
    uri_or_path: String,
}

async fn open_in_obsidian_handler(
    Json(payload): Json<ObsidianOpenRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let uri = payload.uri_or_path.trim();
    if uri.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "URI ou caminho do Obsidian está vazio.".into(),
        ));
    }

    let status = std::process::Command::new("open")
        .arg(uri)
        .status()
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Erro ao disparar comando open: {e}"),
            )
        })?;

    if status.success() {
        Ok(Json(json!({ "success": true })))
    } else {
        Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Falha ao abrir no Obsidian (código: {:?})", status.code()),
        ))
    }
}

// 8. Histórico
async fn get_history_handler(
    State(state): State<AppState>,
) -> Result<Json<Vec<HistoryEntry>>, (StatusCode, String)> {
    Ok(Json(load_history(&state.history_path)))
}

async fn delete_history_item_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let mut history = load_history(&state.history_path);
    history.retain(|item| item.id != id);
    persist_history(&state.history_path, &history)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(json!({ "success": true })))
}

async fn clear_history_handler(
    State(state): State<AppState>,
) -> Result<Json<Value>, (StatusCode, String)> {
    persist_history(&state.history_path, &[])
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(json!({ "success": true })))
}

// 9. Exportar Lote como ZIP
async fn export_zip_handler(
    Query(query): Query<OutputDirQuery>,
) -> Result<Response, (StatusCode, String)> {
    let dir = PathBuf::from(&query.output_dir);
    if !dir.is_dir() {
        return Err((
            StatusCode::NOT_FOUND,
            format!("Pasta não encontrada: {}", query.output_dir),
        ));
    }

    let buf = Vec::new();
    let cursor = Cursor::new(buf);
    let mut zip = ZipWriter::new(cursor);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);

    fn add_dir_to_zip<W: Write + std::io::Seek>(
        zip: &mut ZipWriter<W>,
        current_dir: &Path,
        base_dir: &Path,
        options: SimpleFileOptions,
    ) -> Result<(), std::io::Error> {
        for entry in fs::read_dir(current_dir)? {
            let entry = entry?;
            let path = entry.path();
            let name = path.strip_prefix(base_dir).unwrap_or(&path);
            let name_str = name.to_string_lossy().replace('\\', "/");

            if path.is_dir() {
                zip.add_directory(format!("{name_str}/"), options)?;
                add_dir_to_zip(zip, &path, base_dir, options)?;
            } else if path.is_file() {
                zip.start_file(name_str, options)?;
                let data = fs::read(&path)?;
                zip.write_all(&data)?;
            }
        }
        Ok(())
    }

    add_dir_to_zip(&mut zip, &dir, &dir, options).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Erro ao criar ZIP: {e}"),
        )
    })?;

    let cursor = zip.finish().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Erro ao finalizar ZIP: {e}"),
        )
    })?;

    let zip_bytes = cursor.into_inner();

    let folder_name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("transcricoes_lote");

    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/zip")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{folder_name}.zip\""),
        )
        .header(header::CONTENT_LENGTH, zip_bytes.len().to_string())
        .body(axum::body::Body::from(zip_bytes))
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Erro ao criar resposta: {e}"),
            )
        })?;

    Ok(response)
}

// ============================================================================
// INICIALIZAÇÃO DO SERVIDOR (MAIN)
// ============================================================================

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::INFO.into()),
        )
        .init();

    let data_dir = std::env::var("DATA_DIR").unwrap_or_else(|_| {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
        home.join(".local/share/yt-txt").to_string_lossy().into()
    });
    let data_path = PathBuf::from(&data_dir);
    let config_dir = data_path.join("config");
    let uploads_dir = data_path.join("uploads");
    let _ = fs::create_dir_all(&config_dir);
    let _ = fs::create_dir_all(&uploads_dir);

    let config_path = config_dir.join("preferences.json");
    let history_path = config_dir.join("history.json");
    let preferences = load_preferences(&config_path);

    let (events_tx, _) = broadcast::channel(100);

    let state = AppState {
        preferences: Arc::new(Mutex::new(preferences)),
        batch: Arc::new(Mutex::new(None)),
        cancelled: Arc::new(AtomicBool::new(false)),
        running_pids: Arc::new(Mutex::new(HashSet::new())),
        active_downloads: Arc::new(Mutex::new(HashSet::new())),
        config_path,
        history_path,
        uploads_dir,
        events_tx,
    };

    let dist_dir = std::env::var("DIST_DIR").unwrap_or_else(|_| "./dist".into());
    let dist_path = PathBuf::from(&dist_dir);

    let api_routes = Router::new()
        .route("/preferences", get(get_preferences_handler).post(update_preferences_handler))
        .route("/diagnose", get(diagnose_handler))
        .route("/models", get(list_models_handler))
        .route("/models/download", post(download_model_handler))
        .route("/models/cancel", post(cancel_model_download_handler))
        .route("/models/active", post(set_active_model_handler))
        .route("/upload", post(upload_handler))
        .route("/batch", get(get_batch_handler).post(create_batch_handler))
        .route("/batch/start", post(start_batch_handler))
        .route("/batch/cancel", post(cancel_batch_handler))
        .route("/events", get(sse_events_handler))
        .route("/transcript", get(read_transcript_handler))
        .route("/transcript-bundle", get(read_transcript_bundle_handler))
        .route("/transcript/save", post(save_transcript_handler))
        .route("/audio", get(read_audio_handler))
        .route("/audio/save-recording", post(save_recording_handler))
        .route("/ai/check-ollama", post(check_ollama_handler))
        .route("/ai/generate", post(generate_ai_handler))
        .route("/ai/chat", post(chat_ai_handler))
        .route("/ai/insights", get(list_saved_insights_handler))
        .route("/history", get(get_history_handler).delete(clear_history_handler))
        .route("/history/{id}", delete(delete_history_item_handler))
        .route("/export-zip", get(export_zip_handler))
        .route("/obsidian/export", post(export_to_obsidian_handler))
        .route("/obsidian/open", post(open_in_obsidian_handler));

    let app = Router::new()
        .nest("/api", api_routes)
        .fallback_service(ServeDir::new(&dist_path).fallback(tower_http::services::ServeFile::new(dist_path.join("index.html"))))
        .layer(TraceLayer::new_for_http())
        .layer(DefaultBodyLimit::max(500 * 1024 * 1024)) // 500 MB upload limit
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state);

    let port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(3000);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));

    info!("🚀 Servidor yt-txt Web rodando em http://{}", addr);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Não foi possível iniciar o listener TCP");

    axum::serve(listener, app)
        .await
        .expect("Erro ao executar servidor Axum");
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
        assert_eq!(preferences.ai.provider, "ollama");
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

    #[test]
    fn generates_markdown_transcript_correctly() {
        let md = generate_markdown_transcript(
            "Vídeo de Teste",
            "https://youtu.be/test",
            "ggml-medium.bin",
            "Olá mundo, este é um teste.",
            Some("1\n00:00:00,000 --> 00:00:02,000\nOlá mundo"),
        );
        assert!(md.contains("# Transcrição: Vídeo de Teste"));
        assert!(md.contains("Olá mundo, este é um teste."));
        assert!(md.contains("## ⏱️ Linha do Tempo (Timestamps)"));
    }
}

