import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { App } from "./main";
import { api } from "./services/api";

vi.mock("./services/api", () => ({
  api: {
    getPreferences: vi.fn(),
    updatePreferences: vi.fn(),
    diagnose: vi.fn(),
    getBatch: vi.fn(),
    createBatch: vi.fn(),
    startBatch: vi.fn(),
    cancelBatch: vi.fn(),
    getHistory: vi.fn(),
    deleteHistoryItem: vi.fn(),
    clearHistory: vi.fn(),
    listWhisperModels: vi.fn(),
    downloadWhisperModel: vi.fn(),
    cancelModelDownload: vi.fn(),
    setActiveModel: vi.fn(),
    readTranscriptBundle: vi.fn(),
    saveTranscriptEdits: vi.fn(),
    readAudioBytes: vi.fn(),
    checkOllama: vi.fn(),
    listSavedInsights: vi.fn(),
    subscribeEvents: vi.fn().mockImplementation(() => () => {}),
    openInFinder: vi.fn(),
    selectLocalFiles: vi.fn(),
    uploadFiles: vi.fn(),
    browseFile: vi.fn(),
    browseDirectory: vi.fn(),
    exportToObsidian: vi.fn(),
    openInObsidian: vi.fn(),
  },
  isTauri: vi.fn().mockReturnValue(false),
}));

describe("App main component", () => {
  const mockPrefs = {
    yt_dlp_path: "/bin/yt-dlp",
    ffmpeg_path: "/bin/ffmpeg",
    whisper_path: "/bin/whisper-cli",
    model_path: "/models/ggml-medium.bin",
    output_dir: "/downloads",
    concurrency: 1,
    ai: {
      provider: "ollama",
      ollama_endpoint: "http://127.0.0.1:11434",
      ollama_model: "llama3.2:latest",
      gemini_api_key: "",
      gemini_model: "gemini-3.7-flash",
      openai_api_key: "",
      openai_model: "gpt-4o-mini",
      groq_api_key: "",
      groq_model: "llama-3.3-70b-versatile",
    },
    obsidian_vault_path: "/Users/test/Vault",
    obsidian_subfolder: "Transcrições",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (api.getPreferences as any).mockResolvedValue(mockPrefs);
    (api.diagnose as any).mockResolvedValue({
      checks: [
        { name: "yt-dlp", available: true, path: "/bin/yt-dlp", message: "OK" },
        { name: "ffmpeg", available: true, path: "/bin/ffmpeg", message: "OK" },
        { name: "whisper-cli", available: true, path: "/bin/whisper-cli", message: "OK" },
        { name: "Modelo Whisper", available: true, path: "/models/ggml-medium.bin", message: "OK" },
      ],
    });
    (api.getBatch as any).mockResolvedValue(null);
    (api.getHistory as any).mockResolvedValue([]);
    (api.listWhisperModels as any).mockResolvedValue([]);
    (api.checkOllama as any).mockResolvedValue(["llama3.2:latest"]);
  });

  it("renders main header, navigation bar, and input fields", async () => {
    render(<App />);

    expect(screen.getByText("Transcrições")).toBeDefined();
    expect(screen.getByPlaceholderText(/https:\/\/www\.youtube\.com/)).toBeDefined();

    await waitFor(() => {
      expect(api.getPreferences).toHaveBeenCalled();
      expect(api.diagnose).toHaveBeenCalled();
    });
  });

  it("allows entering YouTube URLs and clicking start", async () => {
    (api.createBatch as any).mockResolvedValue({
      id: "b1",
      output_dir: "/downloads/batch1",
      items: [
        {
          id: "item1",
          source: "https://youtu.be/test12345",
          source_kind: "youtube",
          status: "aguardando",
          progress: 0,
          output_dir: "/downloads/batch1",
          log: [],
        },
      ],
      running: true,
      cancelled: false,
    });

    render(<App />);

    await waitFor(() => {
      expect(api.diagnose).toHaveBeenCalled();
    });

    const textarea = screen.getByPlaceholderText(/https:\/\/www\.youtube\.com/);
    fireEvent.change(textarea, { target: { value: "https://youtu.be/test12345" } });

    await waitFor(() => {
      const startBtn = screen.getByRole("button", { name: "Iniciar transcrição" });
      expect(startBtn.hasAttribute("disabled")).toBe(false);
    });

    const startBtn = screen.getByRole("button", { name: "Iniciar transcrição" });
    fireEvent.click(startBtn);

    await waitFor(() => {
      expect(api.createBatch).toHaveBeenCalledWith(["https://youtu.be/test12345"], []);
      expect(api.startBatch).toHaveBeenCalled();
    });
  });

  it("opens preferences modal and shows Obsidian settings section", async () => {
    render(<App />);

    await waitFor(() => {
      expect(api.getPreferences).toHaveBeenCalled();
    });

    const settingsBtn = screen.getByRole("button", { name: /⚙ Configurações/ });
    fireEvent.click(settingsBtn);

    await waitFor(() => {
      expect(screen.getByLabelText(/Pasta do Obsidian Vault/i)).toBeDefined();
      expect(screen.getByLabelText(/Subpasta de destino/i)).toBeDefined();
    });
  });

  it("switches to history tab", async () => {
    (api.getHistory as any).mockResolvedValue([
      {
        id: "h1",
        batch_id: "b1",
        created_at: "2026-08-26T22:00:00Z",
        title: "Transcrição Histórica",
        source: "https://youtu.be/123",
        source_kind: "youtube",
        output_dir: "/downloads/item1",
        status: "concluido",
        word_count: 50,
        char_count: 250,
        preview_text: "Texto histórico de teste",
        model_name: "Medium",
        formats: ["txt", "srt"],
      },
    ]);

    render(<App />);

    const historyTab = screen.getByRole("button", { name: /📚 Histórico/ });
    fireEvent.click(historyTab);

    await waitFor(() => {
      expect(screen.getByText("Transcrição Histórica")).toBeDefined();
    });
  });

  it("opens audio recorder modal from header button", async () => {
    render(<App />);

    const recordBtn = screen.getByTitle("Gravar áudio do microfone");
    fireEvent.click(recordBtn);

    await waitFor(() => {
      expect(screen.getByText(/Gravação Direta do Microfone/)).toBeDefined();
    });
  });
});
