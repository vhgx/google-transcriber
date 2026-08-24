import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { formatSecondsToTime } from "../utils/srtParser";

interface AudioRecorderModalProps {
  isOpen: boolean;
  onClose: () => void;
  onRecordingComplete: (filePath: string) => void;
}

export function AudioRecorderModal({
  isOpen,
  onClose,
  onRecordingComplete,
}: AudioRecorderModalProps) {
  const [recordingState, setRecordingState] = useState<"idle" | "recording" | "paused" | "saving">("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isOpen) {
      cleanup();
    }
  }, [isOpen]);

  const cleanup = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    setRecordingState("idle");
    setSeconds(0);
    setError(null);
    audioChunksRef.current = [];
  };

  const drawWaveform = () => {
    if (!analyserRef.current || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const bufferLength = analyserRef.current.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const render = () => {
      animationFrameRef.current = requestAnimationFrame(render);
      if (!analyserRef.current) return;

      analyserRef.current.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 2.5;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * (canvas.height * 0.85);

        // Gradiente vibrante esmeralda / turquesa
        const gradient = ctx.createLinearGradient(0, canvas.height, 0, 0);
        gradient.addColorStop(0, "rgba(16, 185, 129, 0.2)");
        gradient.addColorStop(0.5, "rgba(43, 201, 173, 0.8)");
        gradient.addColorStop(1, "rgba(94, 234, 212, 1)");

        ctx.fillStyle = gradient;
        ctx.fillRect(x, (canvas.height - barHeight) / 2, barWidth - 1, barHeight);

        x += barWidth;
      }
    };

    render();
  };

  const startRecording = async () => {
    setError(null);
    audioChunksRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      audioContextRef.current = audioCtx;

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      analyserRef.current = analyser;

      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);

      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.start(250);
      setRecordingState("recording");

      setSeconds(0);
      timerRef.current = window.setInterval(() => {
        setSeconds((prev) => prev + 1);
      }, 1000);

      drawWaveform();
    } catch (err) {
      setError(`Não foi possível acessar o microfone: ${err}`);
      setRecordingState("idle");
    }
  };

  const pauseRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.pause();
      setRecordingState("paused");
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  };

  const resumeRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "paused") {
      mediaRecorderRef.current.resume();
      setRecordingState("recording");
      timerRef.current = window.setInterval(() => {
        setSeconds((prev) => prev + 1);
      }, 1000);
    }
  };

  const finishRecording = async () => {
    if (!mediaRecorderRef.current) return;

    setRecordingState("saving");
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    mediaRecorderRef.current.onstop = async () => {
      try {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        const arrayBuffer = await audioBlob.arrayBuffer();
        const bytes = Array.from(new Uint8Array(arrayBuffer));

        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const filename = `gravacao_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
          now.getDate()
        )}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}.webm`;

        const savedPath = await invoke<string>("save_recorded_audio", {
          bytes,
          filename,
        });

        cleanup();
        onRecordingComplete(savedPath);
        onClose();
      } catch (err) {
        setError(`Erro ao salvar gravação: ${err}`);
        setRecordingState("paused");
      }
    };

    mediaRecorderRef.current.stop();
  };

  if (!isOpen) return null;

  return (
    <div className="backdrop" onClick={onClose}>
      <section className="modal card recorder-modal" onClick={(e) => e.stopPropagation()}>
        <div className="section-title">
          <div>
            <span className="eyebrow">GRAVADOR DE VOZ</span>
            <h2>Gravação Direta do Microfone</h2>
          </div>
          <button className="icon" onClick={onClose}>
            ×
          </button>
        </div>

        {error && <div className="notice error">{error}</div>}

        {/* Visualizador de Onda Sonora */}
        <div className="recorder-visualizer-container">
          <canvas ref={canvasRef} width={500} height={120} className="waveform-canvas" />
          {recordingState === "idle" && (
            <div className="recorder-placeholder">
              <span className="mic-icon">🎙️</span>
              <p>Clique em Iniciar para gravar uma nota de voz ou reunião.</p>
            </div>
          )}
        </div>

        {/* Cronômetro e Indicador de Estado */}
        <div className="recorder-status-row">
          <div className="recorder-timer">
            <span className={`record-dot ${recordingState === "recording" ? "pulsing-red" : ""}`} />
            <strong className="timer-text">{formatSecondsToTime(seconds)}</strong>
          </div>
          <span className="recorder-state-label">
            {recordingState === "recording"
              ? "Gravando..."
              : recordingState === "paused"
              ? "Pausado"
              : recordingState === "saving"
              ? "Salvando áudio..."
              : "Pronto para gravar"}
          </span>
        </div>

        {/* Controles do Gravador */}
        <div className="recorder-controls">
          {recordingState === "idle" ? (
            <button className="primary record-main-btn" onClick={startRecording}>
              🔴 Iniciar Gravação
            </button>
          ) : (
            <>
              {recordingState === "recording" ? (
                <button className="secondary" onClick={pauseRecording}>
                  ⏸ Pausar
                </button>
              ) : (
                <button className="secondary" onClick={resumeRecording}>
                  ▶ Retomar
                </button>
              )}

              <button className="danger" onClick={cleanup}>
                🗑 Descartar
              </button>

              <button
                className="primary"
                onClick={finishRecording}
                disabled={recordingState === "saving" || seconds < 1}
              >
                {recordingState === "saving" ? "Salvando..." : "⏹ Concluir & Transcrever"}
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
