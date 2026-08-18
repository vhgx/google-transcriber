use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{atomic::{AtomicBool, Ordering}, Mutex},
};
use tauri::{AppHandle, Emitter, Manager, State};
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
pub struct Check { name: String, path: String, available: bool, message: String }
#[derive(Clone, Debug, Serialize)]
pub struct Diagnostic { checks: Vec<Check> }

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus { Aguardando, Baixando, Convertendo, Transcrevendo, Concluido, Falhou, Cancelado }

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind { Drive, VideoFile, AudioFile }

#[derive(Clone, Debug, Serialize)]
pub struct BatchItem {
    id: String,
    source: String,
    source_kind: SourceKind,
    local_path: Option<String>,
    title: Option<String>,
    status: ItemStatus,
    output_dir: String,
    error: Option<String>,
    log: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Batch {
    id: String,
    output_dir: String,
    items: Vec<BatchItem>,
    running: bool,
    cancelled: bool,
}

pub struct AppState {
    preferences: Mutex<Preferences>,
    batch: Mutex<Option<Batch>>,
    cancelled: AtomicBool,
    running_pids: Mutex<HashSet<u32>>,
    config_path: PathBuf,
}

fn lock<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, String> {
    mutex.lock().map_err(|_| "O estado interno do aplicativo ficou indisponível.".into())
}

fn load_preferences(path: &Path) -> Preferences {
    fs::read_to_string(path).ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn persist_preferences(path: &Path, preferences: &Preferences) -> Result<(), String> {
    let parent = path.parent().ok_or("Não foi possível determinar a pasta de configurações.")?;
    fs::create_dir_all(parent).map_err(|e| format!("Não foi possível criar a pasta de configurações: {e}"))?;
    let json = serde_json::to_string_pretty(preferences).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| format!("Não foi possível salvar as configurações: {e}"))
}

fn valid_drive_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    let url = Url::parse(raw).map_err(|_| format!("URL inválida: {raw}"))?;
    if url.scheme() != "https" { return Err(format!("A URL deve usar HTTPS: {raw}")); }
    if url.host_str() != Some("drive.google.com") { return Err(format!("A URL não é um arquivo do Google Drive: {raw}")); }
    if url.path().contains("/folders/") { return Err(format!("Links de pasta não são aceitos nesta versão: {raw}")); }
    if !url.path().contains("/file/") && !url.path().contains("/uc") && !url.path().contains("/open") {
        return Err(format!("Use um link de arquivo compartilhado do Google Drive: {raw}"));
    }
    Ok(url.into())
}

fn local_source(raw: &str) -> Result<(PathBuf, SourceKind), String> {
    let path = fs::canonicalize(raw.trim()).map_err(|_| format!("Arquivo local não encontrado: {raw}"))?;
    if !path.is_file() { return Err(format!("O caminho não é um arquivo: {}", path.display())); }
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    let kind = match extension.as_str() {
        "mp4" | "mov" | "m4v" | "mkv" | "webm" | "avi" => SourceKind::VideoFile,
        "mp3" | "m4a" | "wav" | "aac" | "ogg" | "flac" | "aiff" | "opus" => SourceKind::AudioFile,
        _ => return Err(format!("Formato não suportado: .{extension}. Selecione um vídeo ou uma faixa de áudio.")),
    };
    Ok((path, kind))
}

fn emit_batch(app: &AppHandle) {
    if let Ok(batch) = lock(&app.state::<AppState>().batch).map(|batch| batch.clone()) {
        if let Some(batch) = batch { let _ = app.emit("batch-state", batch); }
    }
}

fn update_item<F>(app: &AppHandle, index: usize, update: F)
where F: FnOnce(&mut BatchItem) {
    if let Ok(mut batch) = lock(&app.state::<AppState>().batch) {
        if let Some(batch) = batch.as_mut() {
            if let Some(item) = batch.items.get_mut(index) { update(item); }
        }
    }
    emit_batch(app);
}

#[tauri::command]
fn get_preferences(state: State<'_, AppState>) -> Result<Preferences, String> { Ok(lock(&state.preferences)?.clone()) }

#[tauri::command]
fn update_preferences(preferences: Preferences, state: State<'_, AppState>) -> Result<Preferences, String> {
    if !(1..=2).contains(&preferences.concurrency) { return Err("A concorrência deve ser 1 ou 2.".into()); }
    for (label, path) in [("yt-dlp", &preferences.yt_dlp_path), ("ffmpeg", &preferences.ffmpeg_path), ("whisper-cli", &preferences.whisper_path), ("modelo", &preferences.model_path), ("pasta de saída", &preferences.output_dir)] {
        if path.trim().is_empty() { return Err(format!("O caminho de {label} não pode estar vazio.")); }
    }
    persist_preferences(&state.config_path, &preferences)?;
    *lock(&state.preferences)? = preferences.clone();
    Ok(preferences)
}

#[tauri::command]
fn diagnose(state: State<'_, AppState>) -> Result<Diagnostic, String> {
    let preferences = lock(&state.preferences)?.clone();
    let checks = [
        ("yt-dlp", preferences.yt_dlp_path), ("ffmpeg", preferences.ffmpeg_path),
        ("whisper-cli", preferences.whisper_path), ("Modelo Whisper", preferences.model_path),
    ].into_iter().map(|(name, path)| {
        let available = Path::new(&path).is_file();
        Check { name: name.into(), path: path.clone(), available, message: if available { "Encontrado neste Mac.".into() } else { "Arquivo não encontrado. Ajuste o caminho em Configurações.".into() } }
    }).collect();
    Ok(Diagnostic { checks })
}

#[tauri::command]
fn create_batch(urls: Vec<String>, files: Vec<String>, state: State<'_, AppState>) -> Result<Batch, String> {
    if lock(&state.batch)?.as_ref().is_some_and(|batch| batch.running) { return Err("Aguarde o lote atual terminar ou cancele-o antes de criar outro.".into()); }
    let mut seen = HashSet::new();
    let mut sources: Vec<(String, SourceKind, Option<String>, Option<String>)> = Vec::new();
    for raw in urls {
        if raw.trim().is_empty() { continue; }
        let url = valid_drive_url(&raw)?;
        if seen.insert(url.clone()) { sources.push((url, SourceKind::Drive, None, None)); }
    }
    for raw in files {
        let (path, kind) = local_source(&raw)?;
        let key = path.to_string_lossy().to_string();
        if seen.insert(key.clone()) {
            let title = path.file_name().and_then(|name| name.to_str()).unwrap_or("Arquivo local").to_string();
            sources.push((key.clone(), kind, Some(key), Some(title)));
        }
    }
    if sources.is_empty() { return Err("Cole uma URL do Drive ou selecione pelo menos um arquivo local.".into()); }
    let preferences = lock(&state.preferences)?.clone();
    let output_dir = PathBuf::from(preferences.output_dir).join(Local::now().format("%Y-%m-%d_%H-%M-%S").to_string());
    fs::create_dir_all(&output_dir).map_err(|e| format!("Não foi possível criar a pasta do lote: {e}"))?;
    let items = sources.into_iter().enumerate().map(|(index, (source, source_kind, local_path, title))| {
        let item_dir = output_dir.join(format!("{:02}", index + 1));
        BatchItem { id: Uuid::new_v4().to_string(), source, source_kind, local_path, title, status: ItemStatus::Aguardando, output_dir: item_dir.to_string_lossy().into(), error: None, log: vec!["Na fila".into()] }
    }).collect();
    let batch = Batch { id: Uuid::new_v4().to_string(), output_dir: output_dir.to_string_lossy().into(), items, running: false, cancelled: false };
    *lock(&state.batch)? = Some(batch.clone());
    state.cancelled.store(false, Ordering::SeqCst);
    Ok(batch)
}

#[tauri::command]
fn get_batch(state: State<'_, AppState>) -> Result<Option<Batch>, String> { Ok(lock(&state.batch)?.clone()) }

#[tauri::command]
fn start_batch(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let concurrency = lock(&state.preferences)?.concurrency;
    {
        let mut batch = lock(&state.batch)?;
        let batch = batch.as_mut().ok_or("Crie um lote antes de iniciar.".to_string())?;
        if batch.running { return Err("Este lote já está em processamento.".into()); }
        batch.running = true;
        batch.cancelled = false;
    }
    state.cancelled.store(false, Ordering::SeqCst);
    emit_batch(&app);
    tauri::async_runtime::spawn(async move { process_batch(app, concurrency).await; });
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
                    item.log.push("Cancelado pelo usuário".into());
                }
            }
        }
    }
    let pids: Vec<u32> = lock(&state.running_pids)?.iter().copied().collect();
    for pid in pids { let _ = std::process::Command::new("/bin/kill").args(["-TERM", &pid.to_string()]).status(); }
    emit_batch(&app);
    Ok(())
}

async fn process_batch(app: AppHandle, concurrency: u8) {
    let mut workers = Vec::new();
    for _ in 0..concurrency {
        let worker_app = app.clone();
        workers.push(tauri::async_runtime::spawn(async move { worker(worker_app).await; }));
    }
    for worker in workers { let _ = worker.await; }
    let state = app.state::<AppState>();
    if let Ok(mut batch) = lock(&state.batch) {
        if let Some(batch) = batch.as_mut() { batch.running = false; }
    }
    emit_batch(&app);
}

async fn worker(app: AppHandle) {
    loop {
        let state = app.state::<AppState>();
        if state.cancelled.load(Ordering::SeqCst) { return; }
        let next = {
            let mut batch = match lock(&state.batch) { Ok(batch) => batch, Err(_) => return };
            let Some(batch) = batch.as_mut() else { return };
            let Some(index) = batch.items.iter().position(|item| item.status == ItemStatus::Aguardando) else { return };
            batch.items[index].status = ItemStatus::Baixando;
            let message = if batch.items[index].source_kind == SourceKind::Drive { "Validando link compartilhado…" } else { "Preparando arquivo local…" };
            batch.items[index].log.push(message.into());
            index
        };
        emit_batch(&app);
        process_item(&app, next).await;
    }
}

async fn process_item(app: &AppHandle, index: usize) {
    let state = app.state::<AppState>();
    let (source, source_kind, local_path, item_dir, preferences) = match (|| -> Result<_, String> {
        let batch = lock(&state.batch)?;
        let item = batch.as_ref().and_then(|b| b.items.get(index)).ok_or("Item da fila não encontrado.")?;
        Ok((item.source.clone(), item.source_kind.clone(), item.local_path.clone(), PathBuf::from(&item.output_dir), lock(&state.preferences)?.clone()))
    })() { Ok(value) => value, Err(error) => { fail_item(app, index, error); return; } };
    if let Err(error) = fs::create_dir_all(&item_dir) { fail_item(app, index, format!("Não foi possível criar a pasta do vídeo: {error}")); return; }

    let media_file = match source_kind {
        SourceKind::Drive => {
            let probe = run_tool(app, &preferences.yt_dlp_path, &["--no-download", "--no-playlist", "--dump-single-json", &source], &item_dir).await;
            let metadata = match probe { Ok(output) => output, Err(error) => { finish_error(app, index, error); return; } };
            if let Ok(json) = serde_json::from_str::<Value>(&metadata) {
                if let Some(title) = json.get("title").and_then(Value::as_str) { update_item(app, index, |item| item.title = Some(title.into())); }
            }
            if is_cancelled(app) { return; }
            update_item(app, index, |item| { item.status = ItemStatus::Baixando; item.log.push("Baixando e unindo vídeo em MP4…".into()); });
            let video_template = item_dir.join("video.%(ext)s").to_string_lossy().to_string();
            let download_args = ["--no-playlist", "--no-progress", "--ffmpeg-location", &preferences.ffmpeg_path, "--format", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best", "--merge-output-format", "mp4", "--recode-video", "mp4", "--output", &video_template, &source];
            if let Err(error) = run_tool(app, &preferences.yt_dlp_path, &download_args, &item_dir).await { finish_error(app, index, error); return; }
            let video = item_dir.join("video.mp4");
            if !video.is_file() { finish_error(app, index, "O yt-dlp baixou faixas separadas, mas não conseguiu uni-las em video.mp4. Verifique o caminho do ffmpeg em Configurações.".into()); return; }
            video
        }
        SourceKind::VideoFile | SourceKind::AudioFile => {
            let original = match local_path { Some(path) => PathBuf::from(path), None => { fail_item(app, index, "O caminho do arquivo local está ausente.".into()); return; } };
            let extension = original.extension().and_then(|value| value.to_str()).unwrap_or("bin");
            let copied = item_dir.join(format!("original.{extension}"));
            update_item(app, index, |item| { item.status = ItemStatus::Convertendo; item.log.push("Copiando arquivo local para o lote…".into()); });
            if let Err(error) = fs::copy(&original, &copied) { fail_item(app, index, format!("Não foi possível copiar o arquivo local: {error}")); return; }
            copied
        }
    };
    if is_cancelled(app) { return; }

    update_item(app, index, |item| { item.status = ItemStatus::Convertendo; item.log.push("Extraindo áudio MP3…".into()); });
    let audio = item_dir.join("audio.mp3");
    let media_arg = media_file.to_string_lossy().to_string(); let audio_arg = audio.to_string_lossy().to_string();
    let mut conversion_args = vec!["-y", "-i", media_arg.as_str()];
    if source_kind != SourceKind::AudioFile { conversion_args.push("-vn"); }
    conversion_args.extend(["-codec:a", "libmp3lame", "-q:a", "2", audio_arg.as_str()]);
    if let Err(error) = run_tool(app, &preferences.ffmpeg_path, &conversion_args, &item_dir).await { finish_error(app, index, error); return; }
    if !audio.is_file() { finish_error(app, index, "A conversão terminou, mas não gerou audio.mp3.".into()); return; }
    if is_cancelled(app) { return; }

    update_item(app, index, |item| { item.status = ItemStatus::Transcrevendo; item.log.push("Transcrevendo localmente em português…".into()); });
    let model = preferences.model_path.clone(); let audio = audio.to_string_lossy().to_string();
    if let Err(error) = run_tool(app, &preferences.whisper_path, &["-m", &model, "-f", &audio, "-l", "pt", "-otxt", "-of", "transcricao"], &item_dir).await { finish_error(app, index, error); return; }
    if !item_dir.join("transcricao.txt").is_file() { finish_error(app, index, "A transcrição terminou, mas não gerou transcricao.txt.".into()); return; }
    update_item(app, index, |item| { item.status = ItemStatus::Concluido; item.log.push("Concluído: arquivo original, audio.mp3 e transcricao.txt".into()); });
}

fn is_cancelled(app: &AppHandle) -> bool { app.state::<AppState>().cancelled.load(Ordering::SeqCst) }

fn fail_item(app: &AppHandle, index: usize, error: String) { update_item(app, index, |item| { item.status = ItemStatus::Falhou; item.error = Some(error); }); }
fn finish_error(app: &AppHandle, index: usize, error: String) { if !is_cancelled(app) { fail_item(app, index, error); } }

async fn run_tool(app: &AppHandle, program: &str, args: &[&str], cwd: &Path) -> Result<String, String> {
    if is_cancelled(app) { return Err("Processamento cancelado.".into()); }
    let state = app.state::<AppState>();
    let child = Command::new(program).args(args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
        .map_err(|e| format!("Não foi possível executar {program}: {e}"))?;
    let pid = child.id().ok_or("Não foi possível identificar o processo iniciado.")?;
    lock(&state.running_pids)?.insert(pid);
    let output = child.wait_with_output().await.map_err(|e| format!("Erro ao aguardar {program}: {e}"));
    let _ = lock(&state.running_pids).map(|mut pids| pids.remove(&pid));
    let output = output?;
    if output.status.success() { return Ok(String::from_utf8_lossy(&output.stdout).into()); }
    if is_cancelled(app) { return Err("Processamento cancelado.".into()); }
    let stderr = String::from_utf8_lossy(&output.stderr); let tail: String = stderr.chars().rev().take(700).collect::<String>().chars().rev().collect();
    Err(format!("{program} falhou (código {}). {}", output.status.code().map_or_else(|| "desconhecido".into(), |code| code.to_string()), tail.trim()))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config_path = app.path().app_config_dir().expect("pasta de configuração indisponível").join("preferences.json");
            let preferences = load_preferences(&config_path);
            app.manage(AppState { preferences: Mutex::new(preferences), batch: Mutex::new(None), cancelled: AtomicBool::new(false), running_pids: Mutex::new(HashSet::new()), config_path });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_preferences, update_preferences, diagnose, create_batch, get_batch, start_batch, cancel_batch])
        .run(tauri::generate_context!())
        .expect("erro ao executar aplicativo Tauri");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_supported_google_drive_file_links() {
        assert!(valid_drive_url("https://drive.google.com/file/d/abc123/view?usp=sharing").is_ok());
        assert!(valid_drive_url("https://drive.google.com/open?id=abc123").is_ok());
    }

    #[test]
    fn rejects_non_file_or_non_drive_links() {
        assert!(valid_drive_url("http://drive.google.com/file/d/abc/view").is_err());
        assert!(valid_drive_url("https://drive.google.com/drive/folders/abc").is_err());
        assert!(valid_drive_url("https://example.com/file/d/abc/view").is_err());
    }

    #[test]
    fn default_preferences_use_local_tools() {
        let preferences = Preferences::default();
        assert_eq!(preferences.concurrency, 1);
        assert!(preferences.model_path.ends_with("ggml-medium.bin"));
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
