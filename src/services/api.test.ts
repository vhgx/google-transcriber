import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api, isTauri } from "./api";
import type { Preferences } from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockImplementation(() => {
    return Promise.resolve(vi.fn());
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

describe("api service comprehensive tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as any).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isTauri detection", () => {
    it("returns false when window.__TAURI_INTERNALS__ is undefined", () => {
      expect(isTauri()).toBe(false);
    });

    it("returns true when window.__TAURI_INTERNALS__ is set", () => {
      (window as any).__TAURI_INTERNALS__ = {};
      expect(isTauri()).toBe(true);
    });
  });

  describe("Web REST Mode", () => {
    beforeEach(() => {
      delete (window as any).__TAURI_INTERNALS__;
    });

    it("getPreferences calls /api/preferences via GET", async () => {
      const mockPrefs = { yt_dlp_path: "/bin/yt-dlp", obsidian_vault_path: "" };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => mockPrefs,
      });

      const res = await api.getPreferences();
      expect(res).toEqual(mockPrefs);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/preferences", expect.anything());
    });

    it("updatePreferences calls /api/preferences via POST with JSON body", async () => {
      const mockPrefs = { yt_dlp_path: "/bin/yt-dlp", concurrency: 1 } as Preferences;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => mockPrefs,
      });

      const res = await api.updatePreferences(mockPrefs);
      expect(res).toEqual(mockPrefs);
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/preferences", {
        method: "POST",
        body: JSON.stringify(mockPrefs),
        headers: { "Content-Type": "application/json" },
      });
    });

    it("diagnose calls /api/diagnose", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({ checks: [] }),
      });

      const diag = await api.diagnose();
      expect(diag.checks).toEqual([]);
    });

    it("handles error response in fetchApi with custom error text and fallback", async () => {
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: async () => "Erro customizado da API",
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => {
            throw new Error();
          },
        });

      await expect(api.diagnose()).rejects.toThrow("Erro customizado da API");
      await expect(api.diagnose()).rejects.toThrow("Erro desconhecido");
    });

    it("uploadFiles handles successful upload and error in Web mode", async () => {
      const file = new File(["dummy"], "video.mp4", { type: "video/mp4" });

      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ paths: ["/server/uploads/video.mp4"] }),
        })
        .mockResolvedValueOnce({
          ok: false,
          text: async () => "Upload falhou",
        });

      const paths = await api.uploadFiles([file]);
      expect(paths).toEqual(["/server/uploads/video.mp4"]);

      await expect(api.uploadFiles([file])).rejects.toThrow("Upload falhou");
    });

    it("selectLocalFiles programmatically clicks input and returns files", async () => {
      let createdInput: HTMLInputElement | null = null;
      const originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
        const el = originalCreateElement(tag);
        if (tag === "input") createdInput = el as HTMLInputElement;
        return el;
      }) as any);

      const promise = api.selectLocalFiles(["mp4", "mp3"]);
      expect(createdInput).toBeDefined();
      if (createdInput) {
        expect((createdInput as HTMLInputElement).accept).toBe(".mp4,.mp3");

        const file = new File(["dummy"], "audio.mp3", { type: "audio/mp3" });
        Object.defineProperty(createdInput, "files", {
          value: [file],
        });
        (createdInput as HTMLInputElement).onchange?.({} as any);
      }

      const files = await promise;
      expect(files).toHaveLength(1);
    });

    it("selectLocalFiles resolves empty array if no files chosen", async () => {
      let createdInput: HTMLInputElement | null = null;
      const originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
        const el = originalCreateElement(tag);
        if (tag === "input") createdInput = el as HTMLInputElement;
        return el;
      }) as any);

      const promise = api.selectLocalFiles(["mp4"]);
      if (createdInput) {
        Object.defineProperty(createdInput, "files", { value: [] });
        (createdInput as HTMLInputElement).onchange?.({} as any);
      }

      const files = await promise;
      expect(files).toEqual([]);
    });

    it("saveRecordedAudio in Web mode", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({ path: "/server/recordings/audio.wav" }),
      });

      const path = await api.saveRecordedAudio([1, 2, 3], "audio.wav");
      expect(path).toBe("/server/recordings/audio.wav");
    });

    it("startNativeRecording, stopNativeRecording, cancelNativeRecording in Web mode do nothing gracefully", async () => {
      await expect(api.startNativeRecording()).rejects.toThrow("Gravação nativa só está disponível no aplicativo Desktop.");
      await expect(api.stopNativeRecording()).rejects.toThrow("Gravação nativa só está disponível no aplicativo Desktop.");
      await api.cancelNativeRecording();
    });

    it("openInFinder sets window.location.href to download zip in Web mode", async () => {
      delete (window as any).location;
      (window as any).location = { href: "" };

      await api.openInFinder("/server/downloads/batch1");
      expect(window.location.href).toContain("/api/export-zip?output_dir=");
    });

    it("subscribeEvents sets up EventSource and handles events in Web mode", () => {
      let messageListeners: Record<string, Function> = {};
      const mockClose = vi.fn();

      class MockEventSource {
        constructor(public url: string) {}
        addEventListener(name: string, cb: Function) {
          messageListeners[name] = cb;
        }
        close = mockClose;
      }
      (globalThis as any).EventSource = MockEventSource;

      const onBatch = vi.fn();
      const onProgress = vi.fn();

      const unsubscribe = api.subscribeEvents(onBatch, onProgress);
      expect(messageListeners["batch-state"]).toBeDefined();
      expect(messageListeners["model-download-progress"]).toBeDefined();

      messageListeners["batch-state"]({
        data: JSON.stringify({ data: { id: "b1", items: [] } }),
      });
      expect(onBatch).toHaveBeenCalledWith({ id: "b1", items: [] });

      messageListeners["model-download-progress"]({
        data: JSON.stringify({ model_id: "tiny", percentage: 50 }),
      });
      expect(onProgress).toHaveBeenCalledWith({ model_id: "tiny", percentage: 50 });

      messageListeners["batch-state"]({ data: "invalid json" });

      unsubscribe();
      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe("Tauri Desktop Mode", () => {
    let invokeMock: any;
    let openDialogMock: any;

    beforeEach(async () => {
      (window as any).__TAURI_INTERNALS__ = {};
      const tauriCore = await import("@tauri-apps/api/core");
      const dialog = await import("@tauri-apps/plugin-dialog");
      invokeMock = tauriCore.invoke;
      openDialogMock = dialog.open;
    });

    it("calls Tauri invoke for all batch and media methods", async () => {
      invokeMock
        .mockResolvedValueOnce({ checks: [] }) // diagnose
        .mockResolvedValueOnce([{ id: "tiny" }]) // list_whisper_models
        .mockResolvedValueOnce(undefined) // download_whisper_model
        .mockResolvedValueOnce(undefined) // cancel_model_download
        .mockResolvedValueOnce({ model_path: "/m" }) // set_active_model
        .mockResolvedValueOnce({ id: "b1" }) // create_batch
        .mockResolvedValueOnce({ id: "b1" }) // get_batch
        .mockResolvedValueOnce(undefined) // start_batch
        .mockResolvedValueOnce(undefined) // cancel_batch
        .mockResolvedValueOnce("txt") // read_transcript
        .mockResolvedValueOnce({ txt: "bundle" }) // read_transcript_bundle
        .mockResolvedValueOnce([1, 2, 3]) // read_audio_bytes
        .mockResolvedValueOnce(undefined) // save_transcript_edits
        .mockResolvedValueOnce("/path/rec") // start_native_recording
        .mockResolvedValueOnce("/path/rec") // stop_native_recording
        .mockResolvedValueOnce(undefined) // cancel_native_recording
        .mockResolvedValueOnce(["m1"]) // check_ollama
        .mockResolvedValueOnce("insight") // generate_ai_insight
        .mockResolvedValueOnce("chat") // ask_transcript_ai
        .mockResolvedValueOnce([["1", "t", "c"]]) // list_saved_insights
        .mockResolvedValueOnce([]) // get_history
        .mockResolvedValueOnce(undefined) // delete_history_item
        .mockResolvedValueOnce(undefined) // clear_history
        .mockResolvedValueOnce(undefined); // open_in_finder

      await api.diagnose();
      await api.listWhisperModels();
      await api.downloadWhisperModel("tiny");
      await api.cancelModelDownload("tiny");
      await api.setActiveModel("/m");
      await api.createBatch(["u"], ["f"]);
      await api.getBatch();
      await api.startBatch();
      await api.cancelBatch();
      await api.readTranscript("/d");
      await api.readTranscriptBundle("/d");
      await api.readAudioBytes("/d");
      await api.saveTranscriptEdits("/d", "txt");
      await api.startNativeRecording();
      await api.stopNativeRecording();
      await api.cancelNativeRecording();
      await api.checkOllama();
      await api.generateAiInsight("/d", "summary");
      await api.askTranscriptAi("/d", "q", []);
      await api.listSavedInsights("/d");
      await api.getHistory();
      await api.deleteHistoryItem("1");
      await api.clearHistory();
      await api.openInFinder("/d");

      expect(invokeMock).toHaveBeenCalled();
    });

    it("uploadFiles and selectLocalFiles in Tauri mode", async () => {
      const file = new File([""], "test.mp4");
      (file as any).path = "/local/path/test.mp4";

      const uploaded = await api.uploadFiles([file]);
      expect(uploaded).toEqual(["/local/path/test.mp4"]);

      openDialogMock.mockResolvedValueOnce(["/file1.mp4", "/file2.mp4"]);
      const selectedArr = await api.selectLocalFiles(["mp4"]);
      expect(selectedArr).toEqual(["/file1.mp4", "/file2.mp4"]);

      openDialogMock.mockResolvedValueOnce("/single.mp4");
      const selectedSingle = await api.selectLocalFiles(["mp4"]);
      expect(selectedSingle).toEqual(["/single.mp4"]);

      openDialogMock.mockResolvedValueOnce(null);
      const selectedNone = await api.selectLocalFiles(["mp4"]);
      expect(selectedNone).toEqual([]);
    });

    it("subscribeEvents in Tauri mode registers listeners and unlistens on cleanup", async () => {
      const onBatch = vi.fn();
      const onProgress = vi.fn();

      const unsubscribe = api.subscribeEvents(onBatch, onProgress);
      expect(typeof unsubscribe).toBe("function");
      unsubscribe();
    });
  });
});
