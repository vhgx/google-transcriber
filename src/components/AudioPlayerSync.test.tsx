import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { AudioPlayerSync } from "./AudioPlayerSync";
import { api } from "../services/api";
import type { TranscriptSegment } from "../types";

vi.mock("../services/api", () => ({
  api: {
    readAudioBytes: vi.fn(),
  },
}));

window.URL.createObjectURL = vi.fn().mockReturnValue("blob:http://localhost/test-audio");
window.URL.revokeObjectURL = vi.fn();

window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
window.HTMLMediaElement.prototype.pause = vi.fn();
window.HTMLElement.prototype.scrollIntoView = vi.fn();

describe("AudioPlayerSync component comprehensive", () => {
  const mockSegments: TranscriptSegment[] = [
    {
      id: 1,
      start: 0,
      end: 4.5,
      startFormatted: "00:00",
      endFormatted: "00:04",
      text: "Primeiro trecho do vídeo.",
    },
    {
      id: 2,
      start: 5.0,
      end: 9.0,
      startFormatted: "00:05",
      endFormatted: "00:09",
      text: "Segundo trecho sincronizado.",
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    (api.readAudioBytes as any).mockResolvedValue([1, 2, 3]);
  });

  it("handles audio load error", async () => {
    (api.readAudioBytes as any).mockRejectedValue(new Error("Arquivo de áudio não encontrado"));

    render(
      <AudioPlayerSync
        outputDir="/downloads/test"
        segments={mockSegments}
        isEditing={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/Arquivo de áudio não encontrado/)).toBeDefined();
    });
  });

  it("handles relative seek buttons (-5s / +5s), autoscroll toggle, and scrubber", async () => {
    render(
      <AudioPlayerSync
        outputDir="/downloads/test"
        segments={mockSegments}
        isEditing={false}
      />
    );

    await waitFor(() => {
      expect(screen.getByTitle("Voltar 5 segundos")).toBeDefined();
    });

    const backBtn = screen.getByTitle("Voltar 5 segundos");
    fireEvent.click(backBtn);

    const fwdBtn = screen.getByTitle("Avançar 5 segundos");
    fireEvent.click(fwdBtn);

    const autoScrollBtn = screen.getByText(/Auto-scroll: Ativado/);
    fireEvent.click(autoScrollBtn);
    expect(screen.getByText(/Auto-scroll: Desativado/)).toBeDefined();

    const scrubber = screen.getByRole("slider");
    fireEvent.change(scrubber, { target: { value: "3" } });
  });

  it("supports editing segments inline when isEditing is true", async () => {
    const onSegmentsChange = vi.fn();
    render(
      <AudioPlayerSync
        outputDir="/downloads/test"
        segments={mockSegments}
        isEditing={true}
        onSegmentsChange={onSegmentsChange}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByRole("textbox").length).toBe(2);
    });

    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0], { target: { value: "Primeiro trecho editado." } });

    expect(onSegmentsChange).toHaveBeenCalledWith([
      { ...mockSegments[0], text: "Primeiro trecho editado." },
      mockSegments[1],
    ]);
  });
});
