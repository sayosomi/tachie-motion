import { useEffect, useState } from "react";
import { decodeWavPeaks, MAX_WAVEFORM_BYTES } from "./wavPeaks";
import type { UtteranceItem } from "./utteranceItems";
import type { WavPlaybackControls } from "./WavPlayback";

type Result = { key: string; peaks: number[] | null; unavailable: boolean };

/** Decode the selected WAV without requiring playback. Never fetch all WAV rows. */
export default function useEditorWaveform(
  item: UtteranceItem, playback: WavPlaybackControls,
): { peaks: number[] | null; unavailable: boolean } {
  const key = item.id + "\0" + item.wavPath + "\0" + item.wav.source_identity;
  const [result, setResult] = useState<Result | null>(null);
  const playingThisWav = playback.activeId === item.id;
  const cached = result?.key === key ? result : null;

  useEffect(() => {
    // A running audio player already downloads and analyzes the same WAV.
    if (playingThisWav || cached) return;
    const controller = new AbortController();
    void (async () => {
      let peaks: number[] | null = null;
      try {
        // No need to download a WAV that cannot fit the existing decoder cap
        // even at the smallest possible uncompressed bytes per PCM sample.
        if (item.wav.samples <= MAX_WAVEFORM_BYTES) {
          const response = await fetch("/api/wav-playback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: item.wavPath }),
            signal: controller.signal,
          });
          if (response.ok) {
            const blob = await response.blob();
            if (!controller.signal.aborted) {
              peaks = await decodeWavPeaks(blob, controller.signal);
            }
          }
        }
      } catch {
        // A decoding/transport error is not an editing or source-write error.
      }
      if (!controller.signal.aborted) {
        setResult({ key, peaks, unavailable: !peaks });
      }
    })();
    return () => controller.abort();
  }, [key, playingThisWav, cached, item.wav.samples, item.wavPath]);

  const playbackPeaks = playingThisWav && playback.waveform?.sourceId === item.id
    ? playback.waveform.peaks : null;
  return {
    peaks: playbackPeaks ?? cached?.peaks ?? null,
    unavailable: !playingThisWav && !!cached?.unavailable,
  };
}
