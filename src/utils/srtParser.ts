import type { TranscriptSegment } from "../types";

function parseTimeToSeconds(timeStr: string): number {
  // Format: 00:00:01,000 or 00:00:01.000 or 00:01.000
  const parts = timeStr.trim().replace(",", ".").split(":");
  if (parts.length === 3) {
    const hours = parseFloat(parts[0]);
    const minutes = parseFloat(parts[1]);
    const seconds = parseFloat(parts[2]);
    return hours * 3600 + minutes * 60 + seconds;
  } else if (parts.length === 2) {
    const minutes = parseFloat(parts[0]);
    const seconds = parseFloat(parts[1]);
    return minutes * 60 + seconds;
  }
  return parseFloat(timeStr) || 0;
}

export function formatSecondsToTime(totalSeconds: number): string {
  if (isNaN(totalSeconds) || totalSeconds < 0) return "00:00";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  const pad = (n: number) => String(n).padStart(2, "0");
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

export function parseSrtSegments(srtContent: string): TranscriptSegment[] {
  if (!srtContent || !srtContent.trim()) return [];

  const normalized = srtContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawBlocks = normalized.split(/\n\n+/);
  const segments: TranscriptSegment[] = [];

  for (let i = 0; i < rawBlocks.length; i++) {
    const block = rawBlocks[i].trim();
    if (!block) continue;

    const lines = block.split("\n");
    if (lines.length < 2) continue;

    // Line 0 could be index (number) or timestamp
    let timeLineIndex = 0;
    if (/^\d+$/.test(lines[0].trim()) && lines.length >= 2) {
      timeLineIndex = 1;
    }

    const timeLine = lines[timeLineIndex];
    if (!timeLine || !timeLine.includes("-->")) continue;

    const [startStr, endStr] = timeLine.split("-->").map((s) => s.trim());
    if (!startStr || !endStr) continue;

    const start = parseTimeToSeconds(startStr);
    const end = parseTimeToSeconds(endStr);
    const textLines = lines.slice(timeLineIndex + 1).join(" ").trim();

    if (textLines) {
      segments.push({
        id: segments.length + 1,
        start,
        end,
        startFormatted: formatSecondsToTime(start),
        endFormatted: formatSecondsToTime(end),
        text: textLines,
      });
    }
  }

  return segments;
}

export function segmentsToSrt(segments: TranscriptSegment[]): string {
  return segments
    .map((seg, idx) => {
      const formatTimestamp = (s: number) => {
        const hrs = Math.floor(s / 3600);
        const mins = Math.floor((s % 3600) / 60);
        const secs = Math.floor(s % 60);
        const ms = Math.floor((s % 1) * 1000);
        const pad = (n: number, len = 2) => String(n).padStart(len, "0");
        return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(ms, 3)}`;
      };
      return `${idx + 1}\n${formatTimestamp(seg.start)} --> ${formatTimestamp(seg.end)}\n${seg.text}\n`;
    })
    .join("\n");
}
