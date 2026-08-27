import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { AiInsightsPanel } from "./AiInsightsPanel";
import { api } from "../services/api";
import type { Preferences } from "../types";

vi.mock("../services/api", () => ({
  api: {
    listSavedInsights: vi.fn(),
    generateAiInsight: vi.fn(),
    askTranscriptAi: vi.fn(),
    exportToObsidian: vi.fn(),
    openInObsidian: vi.fn(),
    openInFinder: vi.fn(),
  },
}));

describe("AiInsightsPanel component comprehensive", () => {
  const mockPrefs: Preferences = {
    yt_dlp_path: "/opt/homebrew/bin/yt-dlp",
    ffmpeg_path: "/opt/homebrew/bin/ffmpeg",
    whisper_path: "/opt/homebrew/bin/whisper-cli",
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
    (api.listSavedInsights as any).mockResolvedValue([]);
  });

  it("renders with different providers (Gemini, OpenAI, Groq)", () => {
    const geminiPrefs: Preferences = {
      ...mockPrefs,
      ai: { ...mockPrefs.ai!, provider: "gemini", gemini_model: "gemini-3.7-flash" },
    };
    const { rerender } = render(
      <AiInsightsPanel
        outputDir="/downloads/test"
        title="Meu Vídeo"
        prefs={geminiPrefs}
        onOpenSettings={vi.fn()}
      />
    );
    expect(screen.getByText(/GEMINI/)).toBeDefined();

    const openaiPrefs: Preferences = {
      ...mockPrefs,
      ai: { ...mockPrefs.ai!, provider: "openai", openai_model: "gpt-4o" },
    };
    rerender(
      <AiInsightsPanel
        outputDir="/downloads/test"
        title="Meu Vídeo"
        prefs={openaiPrefs}
        onOpenSettings={vi.fn()}
      />
    );
    expect(screen.getByText(/OPENAI/)).toBeDefined();

    const groqPrefs: Preferences = {
      ...mockPrefs,
      ai: { ...mockPrefs.ai!, provider: "groq", groq_model: "llama-3.3-70b-versatile" },
    };
    rerender(
      <AiInsightsPanel
        outputDir="/downloads/test"
        title="Meu Vídeo"
        prefs={groqPrefs}
        onOpenSettings={vi.fn()}
      />
    );
    expect(screen.getByText(/GROQ/)).toBeDefined();
  });

  it("loads previously saved insights from disk on mount", async () => {
    (api.listSavedInsights as any).mockResolvedValue([
      ["obsidian", "Nota Obsidian", "# Nota Já Salva"],
    ]);

    render(
      <AiInsightsPanel
        outputDir="/downloads/test"
        title="Meu Vídeo"
        prefs={mockPrefs}
        onOpenSettings={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/# Nota Já Salva/)).toBeDefined();
    });
  });

  it("handles generation errors and allows dismissing error alert", async () => {
    (api.generateAiInsight as any).mockRejectedValue(new Error("Falha na conexão com Ollama"));

    render(
      <AiInsightsPanel
        outputDir="/downloads/test"
        title="Meu Vídeo"
        prefs={mockPrefs}
        onOpenSettings={vi.fn()}
      />
    );

    const generateBtn = screen.getByRole("button", { name: /Gerar Nota Obsidian/ });
    fireEvent.click(generateBtn);

    await waitFor(() => {
      expect(screen.getByText(/Falha na conexão com Ollama/)).toBeDefined();
    });

    const closeErrBtn = screen.getByText("×");
    fireEvent.click(closeErrBtn);
    expect(screen.queryByText(/Falha na conexão com Ollama/)).toBeNull();
  });

  it("copies markdown to clipboard and opens in finder", async () => {
    (api.listSavedInsights as any).mockResolvedValue([
      ["obsidian", "Nota Obsidian", "# Conteudo"],
    ]);

    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });

    render(
      <AiInsightsPanel
        outputDir="/downloads/test"
        title="Meu Vídeo"
        prefs={mockPrefs}
        onOpenSettings={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/Copiar Markdown/)).toBeDefined();
    });

    const copyBtn = screen.getByText(/Copiar Markdown/);
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(screen.getByText(/Markdown copiado!/)).toBeDefined();
    });

    const finderBtn = screen.getByText(/Abrir pasta/);
    fireEvent.click(finderBtn);
    expect(api.openInFinder).toHaveBeenCalledWith("/downloads/test");
  });

  it("handles suggestion pills click in chat mode and error in chat", async () => {
    (api.askTranscriptAi as any).mockRejectedValue("Timeout no chat");

    render(
      <AiInsightsPanel
        outputDir="/downloads/test"
        title="Meu Vídeo"
        prefs={mockPrefs}
        onOpenSettings={vi.fn()}
      />
    );

    const chatCard = screen.getByText("Pergunte ao Áudio");
    fireEvent.click(chatCard);

    const sugPill = screen.getByText(/Qual a ideia principal?/);
    fireEvent.click(sugPill);

    const input = screen.getByPlaceholderText(/Digite sua pergunta/) as HTMLInputElement;
    expect(input.value).toBe("Qual a ideia principal?");

    const submitBtn = screen.getByText("Enviar");
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText(/Erro no chat: Timeout no chat/)).toBeDefined();
    });
  });

  it("handles Obsidian export error when vault is not configured", async () => {
    const unconfiguredPrefs: Preferences = {
      ...mockPrefs,
      obsidian_vault_path: "",
    };
    (api.listSavedInsights as any).mockResolvedValue([
      ["obsidian", "Nota Obsidian", "# Conteudo"],
    ]);

    const onOpenSettings = vi.fn();
    render(
      <AiInsightsPanel
        outputDir="/downloads/test"
        title="Meu Vídeo"
        prefs={unconfiguredPrefs}
        onOpenSettings={onOpenSettings}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/Configurar Obsidian/)).toBeDefined();
    });

    const setupBtn = screen.getByText(/Configurar Obsidian/);
    fireEvent.click(setupBtn);
    expect(onOpenSettings).toHaveBeenCalled();
  });
});
