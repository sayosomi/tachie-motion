// Display-only analysis of the same WAV Blob used by the audio player.
export const WAVEFORM_BINS = 180;
export const MAX_WAVEFORM_BYTES = 16 * 1024 * 1024;

export function peakEnvelope(buffer: AudioBuffer): number[] {
  if (!buffer.length || !buffer.numberOfChannels) return [];
  const channels = Array.from({ length: buffer.numberOfChannels },
    (_, index) => buffer.getChannelData(index));
  const peaks: number[] = [];
  for (let bin = 0; bin < WAVEFORM_BINS; bin++) {
    const start = Math.floor(bin * buffer.length / WAVEFORM_BINS);
    const end = Math.max(start + 1, Math.floor((bin + 1) * buffer.length / WAVEFORM_BINS));
    let peak = 0;
    for (let frame = start; frame < end; frame++) {
      for (const channel of channels) {
        const value = Math.abs(channel[frame]);
        if (Number.isFinite(value) && value > peak) peak = value;
      }
    }
    peaks.push(Math.min(1, peak));
  }
  return peaks;
}

export async function decodeWavPeaks(wav: Blob): Promise<number[] | null> {
  // A large WAV can still play/seek without allocating a second decoded copy.
  if (wav.size > MAX_WAVEFORM_BYTES || typeof AudioContext === "undefined") return null;
  let context: AudioContext;
  try { context = new AudioContext(); }
  catch { return null; }
  try {
    const decoded = await context.decodeAudioData(await wav.arrayBuffer());
    const peaks = peakEnvelope(decoded);
    return peaks.length === WAVEFORM_BINS ? peaks : null;
  } catch {
    return null;
  } finally {
    await context.close().catch(() => {});
  }
}
