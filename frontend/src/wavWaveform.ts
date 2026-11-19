// Display-only analysis of the WAV Blob already used by the audio player.
// Web Audio decode cannot reliably be interrupted: keep one outstanding decode
// at a time and drop cancelled requests before the peak scan.
export const WAVEFORM_BINS = 180;
export const MAX_WAVEFORM_BYTES = 16 * 1024 * 1024;
export const MAX_DECODED_PCM_BYTES = 24 * 1024 * 1024;
const SAMPLES_PER_BIN = 256;
const HEADER_BYTES = 64 * 1024;

type WavFormat = { sampleRate: number; channels: number; blockAlign: number };
// A single active decode plus abortable waiters: cancelled queued requests
// settle immediately rather than retaining old WAV Blobs behind a slow decode.
type DecodeWaiter = {
  signal: AbortSignal;
  resolve: (release: (() => void) | null) => void;
  onAbort: () => void;
};
let decodeBusy = false;
const decodeWaiters: DecodeWaiter[] = [];

function releaseDecode() {
  while (decodeWaiters.length) {
    const next = decodeWaiters.shift()!;
    next.signal.removeEventListener("abort", next.onAbort);
    if (next.signal.aborted) {
      next.resolve(null);
      continue;
    }
    next.resolve(releaseDecode);
    return;
  }
  decodeBusy = false;
}

function acquireDecode(signal: AbortSignal): Promise<(() => void) | null> {
  if (signal.aborted) return Promise.resolve(null);
  if (!decodeBusy) {
    decodeBusy = true;
    return Promise.resolve(releaseDecode);
  }
  return new Promise((resolve) => {
    const waiter: DecodeWaiter = { signal, resolve, onAbort: () => {
      const at = decodeWaiters.indexOf(waiter);
      if (at >= 0) decodeWaiters.splice(at, 1);
      resolve(null);
    } };
    decodeWaiters.push(waiter);
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    if (signal.aborted) waiter.onAbort();
  });
}

// Do not trust Blob size alone: an 8 kHz WAV decoded at a 48 kHz context rate
// can allocate six times as many Float32 samples. Reject unknown layouts.
async function inspectWavFormat(wav: Blob): Promise<WavFormat | null> {
  const bytes = await wav.slice(0, HEADER_BYTES).arrayBuffer();
  const data = new DataView(bytes);
  if (data.byteLength < 36 ||
      data.getUint32(0, false) !== 0x52494646 ||
      data.getUint32(8, false) !== 0x57415645) return null;
  let offset = 12;
  while (offset + 8 <= data.byteLength) {
    const size = data.getUint32(offset + 4, true);
    const next = offset + 8 + size + (size % 2);
    if (next > data.byteLength) return null;
    if (data.getUint32(offset, false) === 0x666d7420) {
      if (size < 16) return null;
      const format = data.getUint16(offset + 8, true);
      const channels = data.getUint16(offset + 10, true);
      const sampleRate = data.getUint32(offset + 12, true);
      const blockAlign = data.getUint16(offset + 20, true);
      const bits = data.getUint16(offset + 22, true);
      if ((format !== 1 && format !== 3) || channels < 1 || channels > 8 ||
          sampleRate < 8000 || sampleRate > 96000 ||
          ![8, 16, 24, 32].includes(bits) ||
          (format === 3 && bits !== 32) ||
          blockAlign !== channels * (bits / 8)) return null;
      return { sampleRate, channels, blockAlign };
    }
    offset = next;
  }
  return null;
}

export function peakEnvelope(buffer: AudioBuffer, signal?: AbortSignal): number[] {
  if (!buffer.length || !buffer.numberOfChannels || signal?.aborted) return [];
  const channels = Array.from({ length: buffer.numberOfChannels },
    (_, index) => buffer.getChannelData(index));
  const peaks: number[] = [];
  for (let bin = 0; bin < WAVEFORM_BINS; bin++) {
    if (signal?.aborted) return [];
    const start = Math.floor(bin * buffer.length / WAVEFORM_BINS);
    const end = Math.max(start + 1, Math.floor((bin + 1) * buffer.length / WAVEFORM_BINS));
    const count = Math.min(SAMPLES_PER_BIN, end - start);
    let peak = 0;
    // Peak visualization is approximate but the main-thread workload is bounded.
    for (let i = 0; i < count; i++) {
      const frame = start + Math.floor(i * (end - start) / count);
      for (const channel of channels) {
        const value = Math.abs(channel[frame]);
        if (Number.isFinite(value) && value > peak) peak = value;
      }
    }
    peaks.push(Math.min(1, peak));
  }
  return peaks;
}

export async function decodeWavPeaks(wav: Blob, signal: AbortSignal): Promise<number[] | null> {
  if (signal.aborted || wav.size > MAX_WAVEFORM_BYTES ||
      typeof AudioContext === "undefined") return null;
  const format = await inspectWavFormat(wav).catch(() => null);
  if (signal.aborted || !format) return null;
  // Blob bytes / PCM block alignment is a conservative bound on source frames.
  // Matching the AudioContext's rate to the source prevents hidden upsampling.
  const maxFrames = Math.ceil(wav.size / format.blockAlign) + 1;
  if (maxFrames * format.channels * Float32Array.BYTES_PER_ELEMENT >
      MAX_DECODED_PCM_BYTES) return null;

  // Never overlap AudioContexts. Aborted queued requests release Blob references
  // immediately, even when the current browser decoder has not settled.
  const release = await acquireDecode(signal);
  if (!release) return null;
  try {
    if (signal.aborted) return null;
    let context: AudioContext;
    try { context = new AudioContext({ sampleRate: format.sampleRate }); }
    catch { return null; }
    let closing: Promise<void> | null = null;
    const close = () => {
      if (!closing) closing = context.close().catch(() => {});
      return closing;
    };
    const onAbort = () => { void close(); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal.aborted || context.sampleRate !== format.sampleRate) return null;
      const decoded = await context.decodeAudioData(await wav.arrayBuffer());
      if (signal.aborted || decoded.length * decoded.numberOfChannels * 4 >
          MAX_DECODED_PCM_BYTES) return null;
      const peaks = peakEnvelope(decoded, signal);
      return !signal.aborted && peaks.length === WAVEFORM_BINS ? peaks : null;
    } catch {
      return null; // Waveform failure never disables audio playback or its range.
    } finally {
      signal.removeEventListener("abort", onAbort);
      await close();
    }
  } finally {
    release();
  }
}
