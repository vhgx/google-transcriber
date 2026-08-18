export type ItemStatus =
  | "aguardando"
  | "baixando"
  | "convertendo"
  | "transcrevendo"
  | "concluido"
  | "falhou"
  | "cancelado";

export interface Preferences {
  yt_dlp_path: string;
  ffmpeg_path: string;
  whisper_path: string;
  model_path: string;
  output_dir: string;
  concurrency: number;
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

export interface BatchItem {
  id: string;
  source: string;
  source_kind: "drive" | "video_file" | "audio_file";
  local_path?: string;
  title?: string;
  status: ItemStatus;
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
