import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { TranscriptSegment } from "../types";
import { formatSecondsToTime } from "../utils/srtParser";

interface AudioPlayerSyncProps {
  outputDir: string;
  segments: TranscriptSegment[];
  isEditing: boolean;
  onSegmentsChange?: (segments: TranscriptSegment[]) => void;
}

export function AudioPlayerSync({
  outputDir,
  segments,
  isEditing,
  onSegmentsChange,
}: AudioPlayerSyncProps) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loadingAudio, setLoadingAudio] = useState(true);
  const [audioError, setAudioError] = useState<string | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [volume, setVolume] = useState(1.0);
  const [autoScroll, setAutoScroll] = useState(true);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const segmentsContainerRef = useRef<HTMLDivElement | null>(null);
  const activeSegmentRef = useRef<HTMLDivElement | null>(null);

  // Carregar bytes do áudio e criar ObjectURL
  useEffect(() => {
    let objectUrl: string | null = null;
    setLoadingAudio(true);
    setAudioError(null);

    invoke<number[]>("read_audio_bytes", { outputDir })
      .then((bytes) => {
        const blob = new Blob([new Uint8Array(bytes)], { type: "audio/mp3" });
        objectUrl = URL.createObjectURL(blob);
        setAudioUrl(objectUrl);
        setLoadingAudio(false);
      })
      .catch((err) => {
        setAudioError(String(err));
        setLoadingAudio(false);
      });

    return () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [outputDir]);

  // Sincronizar velocidade e volume
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
      audioRef.current.volume = volume;
    }
  }, [playbackRate, volume]);

  // Auto-scroll suave para o segmento ativo
  useEffect(() => {
    if (autoScroll && activeSegmentRef.current && segmentsContainerRef.current) {
      activeSegmentRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }, [currentTime, autoScroll]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch(() => {});
    }
  };

  const seek = (time: number) => {
    if (!audioRef.current) return;
    const target = Math.max(0, Math.min(time, duration || 0));
    audioRef.current.currentTime = target;
    setCurrentTime(target);
  };

  const seekRelative = (offsetSeconds: number) => {
    if (!audioRef.current) return;
    seek(audioRef.current.currentTime + offsetSeconds);
  };

  const seekToSegment = (seg: TranscriptSegment) => {
    if (!audioRef.current) return;
    seek(seg.start);
    if (!isPlaying) {
      audioRef.current.play().catch(() => {});
    }
  };

  const handleSegmentTextChange = (id: number, newText: string) => {
    if (!onSegmentsChange) return;
    const updated = segments.map((s) => (s.id === id ? { ...s, text: newText } : s));
    onSegmentsChange(updated);
  };

  const activeSegmentIndex = segments.findIndex(
    (s) => currentTime >= s.start && currentTime <= s.end
  );

  return (
    <div className="audio-sync-container">
      {/* Elemento de Áudio Oculto */}
      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          onTimeUpdate={() => audioRef.current && setCurrentTime(audioRef.current.currentTime)}
          onLoadedMetadata={() => audioRef.current && setDuration(audioRef.current.duration)}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
        />
      )}

      {/* Painel do Player de Áudio */}
      <div className="audio-player-card">
        {loadingAudio ? (
          <div className="audio-player-loading">Carregando faixa de áudio...</div>
        ) : audioError ? (
          <div className="audio-player-error">
            ⚠️ {audioError} (visualização de texto sincronizado ainda disponível)
          </div>
        ) : (
          <div className="audio-player-controls">
            <div className="player-top-row">
              <div className="player-buttons">
                <button
                  type="button"
                  className="player-btn icon-btn"
                  title="Voltar 5 segundos"
                  onClick={() => seekRelative(-5)}
                >
                  ⏪ -5s
                </button>
                <button
                  type="button"
                  className="player-play-btn"
                  onClick={togglePlay}
                  title={isPlaying ? "Pausar" : "Reproduzir"}
                >
                  {isPlaying ? "⏸" : "▶"}
                </button>
                <button
                  type="button"
                  className="player-btn icon-btn"
                  title="Avançar 5 segundos"
                  onClick={() => seekRelative(5)}
                >
                  +5s ⏩
                </button>
              </div>

              <div className="player-time-display">
                <span className="current-time">{formatSecondsToTime(currentTime)}</span>
                <span className="time-divider">/</span>
                <span className="total-time">{formatSecondsToTime(duration)}</span>
              </div>

              <div className="player-speed-selector">
                {[0.75, 1.0, 1.25, 1.5, 2.0].map((rate) => (
                  <button
                    key={rate}
                    type="button"
                    className={`speed-pill ${playbackRate === rate ? "active" : ""}`}
                    onClick={() => setPlaybackRate(rate)}
                  >
                    {rate}x
                  </button>
                ))}
              </div>

              <div className="player-autoscroll-toggle">
                <button
                  type="button"
                  className={`small-button ${autoScroll ? "secondary" : "secondary muted-btn"}`}
                  onClick={() => setAutoScroll(!autoScroll)}
                  title="Rolar o texto automaticamente com o áudio"
                >
                  {autoScroll ? "🎯 Auto-scroll: Ativado" : "Auto-scroll: Desativado"}
                </button>
              </div>
            </div>

            {/* Barra de Progresso / Scrubbing */}
            <div className="scrubber-wrapper">
              <input
                type="range"
                min={0}
                max={duration || 100}
                step={0.1}
                value={currentTime}
                onChange={(e) => seek(parseFloat(e.target.value))}
                className="audio-scrubber"
              />
              <div
                className="scrubber-progress-fill"
                style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Lista de Segmentos Sincronizados */}
      <div className="sync-segments-list" ref={segmentsContainerRef}>
        {segments.length === 0 ? (
          <div className="no-segments-notice">
            Nenhum segmento com timestamp encontrado nesta transcrição. Use a aba "Texto (.txt)" para leitura contínua.
          </div>
        ) : (
          segments.map((seg, index) => {
            const isActive = index === activeSegmentIndex;

            return (
              <div
                key={seg.id}
                ref={isActive ? activeSegmentRef : null}
                className={`sync-segment-item ${isActive ? "active-segment" : ""}`}
                onClick={() => !isEditing && seekToSegment(seg)}
              >
                <div className="segment-timestamp-col">
                  <button
                    type="button"
                    className="timestamp-badge"
                    onClick={(e) => {
                      e.stopPropagation();
                      seekToSegment(seg);
                    }}
                    title="Pular áudio para este momento"
                  >
                    ▶ {seg.startFormatted}
                  </button>
                </div>

                <div className="segment-text-col">
                  {isEditing ? (
                    <textarea
                      className="segment-edit-input"
                      value={seg.text}
                      rows={Math.max(2, Math.ceil(seg.text.length / 70))}
                      onChange={(e) => handleSegmentTextChange(seg.id, e.target.value)}
                    />
                  ) : (
                    <p className="segment-text">{seg.text}</p>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
