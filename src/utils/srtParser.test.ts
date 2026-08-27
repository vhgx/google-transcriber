import { describe, it, expect } from "vitest";
import {
  formatSecondsToTime,
  parseSrtSegments,
  segmentsToSrt,
} from "./srtParser";
import type { TranscriptSegment } from "../types";

describe("srtParser utils", () => {
  describe("formatSecondsToTime", () => {
    it("handles invalid or negative seconds gracefully", () => {
      expect(formatSecondsToTime(NaN)).toBe("00:00");
      expect(formatSecondsToTime(-5)).toBe("00:00");
    });

    it("formats minutes and seconds correctly", () => {
      expect(formatSecondsToTime(0)).toBe("00:00");
      expect(formatSecondsToTime(9)).toBe("00:09");
      expect(formatSecondsToTime(65)).toBe("01:05");
      expect(formatSecondsToTime(599)).toBe("09:59");
    });

    it("formats hours, minutes and seconds when hours > 0", () => {
      expect(formatSecondsToTime(3600)).toBe("01:00:00");
      expect(formatSecondsToTime(3665)).toBe("01:01:05");
      expect(formatSecondsToTime(7322)).toBe("02:02:02");
    });
  });

  describe("parseSrtSegments", () => {
    it("returns empty array for empty or whitespace content", () => {
      expect(parseSrtSegments("")).toEqual([]);
      expect(parseSrtSegments("   \n\n  \t ")).toEqual([]);
    });

    it("parses standard 3-part timestamp SRT blocks with commas", () => {
      const srt = `1
00:00:01,000 --> 00:00:04,500
Olá mundo, este é um teste.

2
00:00:05,000 --> 00:00:08,200
Segunda linha de fala.`;

      const segments = parseSrtSegments(srt);
      expect(segments).toHaveLength(2);
      expect(segments[0]).toEqual({
        id: 1,
        start: 1,
        end: 4.5,
        startFormatted: "00:01",
        endFormatted: "00:04",
        text: "Olá mundo, este é um teste.",
      });
      expect(segments[1]).toEqual({
        id: 2,
        start: 5,
        end: 8.2,
        startFormatted: "00:05",
        endFormatted: "00:08",
        text: "Segunda linha de fala.",
      });
    });

    it("parses timestamps with dots and 2-part timestamps (MM:SS.mmm)", () => {
      const srt = `01:15.500 --> 01:20.000
Trecho com timestamp curto.`;

      const segments = parseSrtSegments(srt);
      expect(segments).toHaveLength(1);
      expect(segments[0].start).toBe(75.5);
      expect(segments[0].end).toBe(80);
      expect(segments[0].text).toBe("Trecho com timestamp curto.");
    });

    it("parses single float timestamp fallback", () => {
      const srt = `45.5 --> 50.2
Trecho com segundos puros.`;

      const segments = parseSrtSegments(srt);
      expect(segments).toHaveLength(1);
      expect(segments[0].start).toBe(45.5);
      expect(segments[0].end).toBe(50.2);
    });

    it("handles multi-line text inside a single subtitle block", () => {
      const srt = `1
00:00:02,000 --> 00:00:06,000
Linha 1 do texto
Linha 2 do texto`;

      const segments = parseSrtSegments(srt);
      expect(segments).toHaveLength(1);
      expect(segments[0].text).toBe("Linha 1 do texto Linha 2 do texto");
    });

    it("ignores malformed blocks without valid timestamps or arrows", () => {
      const srt = `1
Malformed block without arrow
Texto solto

2
00:00:00,500 --> 00:00:02,500
Bloco válido.`;

      const segments = parseSrtSegments(srt);
      expect(segments).toHaveLength(1);
      expect(segments[0].text).toBe("Bloco válido.");
    });
  });

  describe("segmentsToSrt", () => {
    it("converts transcript segments back into formatted SRT text", () => {
      const segments: TranscriptSegment[] = [
        {
          id: 1,
          start: 1.25,
          end: 4.5,
          startFormatted: "00:01",
          endFormatted: "00:04",
          text: "Primeiro segmento.",
        },
        {
          id: 2,
          start: 3661.05,
          end: 3665.8,
          startFormatted: "01:01:01",
          endFormatted: "01:01:05",
          text: "Segundo segmento longo.",
        },
      ];

      const srt = segmentsToSrt(segments);
      expect(srt).toContain("1\n00:00:01,250 --> 00:00:04,500\nPrimeiro segmento.");
      expect(srt).toContain("2\n01:01:01,050 --> 01:01:05,800\nSegundo segmento longo.");
    });
  });
});
