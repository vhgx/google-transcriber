import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import React from "react";
import { AudioRecorderModal } from "./AudioRecorderModal";
import { api, isTauri } from "../services/api";

vi.mock("../services/api", () => ({
  api: {
    startNativeRecording: vi.fn().mockResolvedValue("/path"),
    stopNativeRecording: vi.fn().mockResolvedValue("/path"),
    cancelNativeRecording: vi.fn().mockResolvedValue(undefined),
    saveRecordedAudio: vi.fn().mockResolvedValue("/path"),
  },
  isTauri: vi.fn(),
}));

describe("AudioRecorderModal component comprehensive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isTauri as any).mockReturnValue(false);

    class MockAudioContext {
      createMediaStreamSource() {
        return { connect: vi.fn() };
      }
      createAnalyser() {
        return {
          fftSize: 256,
          frequencyBinCount: 128,
          getByteFrequencyData: vi.fn(),
        };
      }
      close() {
        return Promise.resolve();
      }
    }
    (window as any).AudioContext = MockAudioContext;

    class MockMediaRecorder {
      state = "inactive";
      ondataavailable: ((e: any) => void) | null = null;
      onstop: (() => void) | null = null;

      start() {
        this.state = "recording";
      }
      pause() {
        this.state = "paused";
      }
      resume() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        setTimeout(() => {
          this.ondataavailable?.({ data: new Blob(["dummy"]) });
          this.onstop?.();
        }, 10);
      }
    }

    (window as any).MediaRecorder = MockMediaRecorder;

    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: vi.fn() }],
        }),
      },
      configurable: true,
      writable: true,
    });
  });

  it("does not render when isOpen is false", () => {
    const { container } = render(
      <AudioRecorderModal
        isOpen={false}
        onClose={vi.fn()}
        onRecordingComplete={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders recorder modal when isOpen is true and closes", () => {
    const onClose = vi.fn();
    render(
      <AudioRecorderModal
        isOpen={true}
        onClose={onClose}
        onRecordingComplete={vi.fn()}
      />
    );

    expect(screen.getByText(/Gravação Direta do Microfone/)).toBeDefined();
    expect(screen.getByText(/Iniciar Gravação/)).toBeDefined();

    const closeBtn = screen.getByText("×");
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it("handles Web recording flow: start, pause, resume, stop & save", async () => {
    vi.useFakeTimers();
    (api.saveRecordedAudio as any).mockResolvedValue("/downloads/rec.wav");
    const onComplete = vi.fn();
    const onClose = vi.fn();

    render(
      <AudioRecorderModal
        isOpen={true}
        onClose={onClose}
        onRecordingComplete={onComplete}
      />
    );

    const startBtn = screen.getByText(/Iniciar Gravação/);
    await act(async () => {
      fireEvent.click(startBtn);
    });

    expect(screen.getByText(/Pausar/)).toBeDefined();

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    const pauseBtn = screen.getByText(/Pausar/);
    act(() => {
      fireEvent.click(pauseBtn);
    });

    expect(screen.getByText(/Retomar/)).toBeDefined();

    const resumeBtn = screen.getByText(/Retomar/);
    act(() => {
      fireEvent.click(resumeBtn);
    });

    expect(screen.getByText(/Concluir & Transcrever/)).toBeDefined();

    const finishBtn = screen.getByText(/Concluir & Transcrever/);
    await act(async () => {
      fireEvent.click(finishBtn);
      await vi.runAllTimersAsync();
    });

    expect(api.saveRecordedAudio).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith("/downloads/rec.wav");
    expect(onClose).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("handles Desktop Tauri native recording flow", async () => {
    (isTauri as any).mockReturnValue(true);
    Object.defineProperty(navigator, "mediaDevices", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    (api.startNativeRecording as any).mockResolvedValue("/local/native_rec.wav");
    (api.stopNativeRecording as any).mockResolvedValue("/local/native_rec.wav");
    const onComplete = vi.fn();
    const onClose = vi.fn();

    render(
      <AudioRecorderModal
        isOpen={true}
        onClose={onClose}
        onRecordingComplete={onComplete}
      />
    );

    const startBtn = screen.getByText(/Iniciar Gravação/);
    await act(async () => {
      fireEvent.click(startBtn);
    });

    await waitFor(() => {
      expect(api.startNativeRecording).toHaveBeenCalled();
    });

    await new Promise((r) => setTimeout(r, 1100));

    const finishBtn = screen.getByText(/Concluir & Transcrever/);
    await act(async () => {
      fireEvent.click(finishBtn);
    });

    await waitFor(() => {
      expect(api.stopNativeRecording).toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledWith("/local/native_rec.wav");
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("handles microphone error when user denies access", async () => {
    (isTauri as any).mockReturnValue(false);
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: vi.fn().mockRejectedValue(new Error("NotAllowedError")),
      },
      configurable: true,
      writable: true,
    });

    render(
      <AudioRecorderModal
        isOpen={true}
        onClose={vi.fn()}
        onRecordingComplete={vi.fn()}
      />
    );

    const startBtn = screen.getByText(/Iniciar Gravação/);
    await act(async () => {
      fireEvent.click(startBtn);
    });

    expect(screen.getByText(/Permissão de microfone negada/)).toBeDefined();
  });
});
