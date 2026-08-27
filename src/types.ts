export type ItemStatus =
  | "aguardando"
  | "baixando"
  | "convertendo"
  | "transcrevendo"
  | "concluido"
  | "falhou"
  | "cancelado";

export type SourceKind =
  | "youtube"
  | "drive"
  | "web"
  | "video_file"
  | "audio_file";

export type TranscriptFormat = "sync" | "txt" | "srt" | "vtt" | "md" | "json" | "ai";

export type AiProvider = "ollama" | "gemini" | "openai" | "groq";

export type AiTemplateId = "summary" | "actions" | "chapters" | "clean" | "obsidian" | "chat";

export interface AiPreferences {
  provider: AiProvider;
  ollama_endpoint: string;
  ollama_model: string;
  gemini_api_key: string;
  gemini_model: string;
  openai_api_key: string;
  openai_model: string;
  groq_api_key: string;
  groq_model: string;
}

export interface Preferences {
  yt_dlp_path: string;
  ffmpeg_path: string;
  whisper_path: string;
  model_path: string;
  output_dir: string;
  concurrency: number;
  ai?: AiPreferences;
  obsidian_vault_path?: string;
  obsidian_subfolder?: string;
}

export interface Check {
  name: string;
  path: string;
  available: boolean;
  message: string;
}

export interface Diagnostic {
  checks: Check[];
}

export interface TranscriptSegment {
  id: number;
  start: number; // em segundos
  end: number;   // em segundos
  startFormatted: string;
  endFormatted: string;
  text: string;
}

export interface BatchItem {
  id: string;
  source: string;
  source_kind: SourceKind;
  local_path?: string;
  title?: string;
  status: ItemStatus;
  progress: number;
  stage?: string;
  output_dir: string;
  error?: string;
  log: string[];
}

export interface Batch {
  id: string;
  output_dir: string;
  items: BatchItem[];
  running: boolean;
  cancelled: boolean;
}

export interface WhisperModelInfo {
  id: string;
  name: string;
  filename: string;
  size_bytes: number;
  size_display: string;
  ram_display: string;
  speed_display: string;
  description: string;
  download_url: string;
  is_downloaded: boolean;
  is_active: boolean;
  local_path?: string;
}

export interface ModelDownloadProgress {
  model_id: string;
  downloaded_bytes: number;
  total_bytes: number;
  percentage: number;
  status: "downloading" | "completed" | "error" | "cancelled";
  error?: string;
}

export interface TranscriptBundle {
  txt: string;
  srt?: string;
  vtt?: string;
  json?: string;
  md?: string;
}

export interface HistoryEntry {
  id: string;
  batch_id: string;
  created_at: string;
  title: string;
  source: string;
  source_kind: SourceKind;
  output_dir: string;
  status: ItemStatus;
  word_count: number;
  char_count: number;
  preview_text: string;
  model_name: string;
  formats: string[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
}

export interface SavedInsight {
  id: string;
  title: string;
  content: string;
  filename: string;
}

export interface ObsidianExportResult {
  saved_path: string;
  vault_name: string;
  obsidian_uri: string;
}
