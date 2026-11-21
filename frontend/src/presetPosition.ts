/** Display conversions only. Persist and render integer PCM sample positions. */
export function sampleFromSeconds(seconds: number, sampleRate: number): number {
  return Math.round(seconds * sampleRate);
}

export function sampleFromPercent(percent: number, samples: number): number {
  return Math.round(percent / 100 * samples);
}

export function secondsFromSample(sample: number, sampleRate: number): string {
  return (sample / sampleRate).toFixed(9);
}

export function percentFromSample(sample: number, samples: number): string {
  return (sample / samples * 100).toFixed(6);
}

export function validEditSample(sample: number, samples: number): boolean {
  return Number.isSafeInteger(sample) && sample > 0 && sample < samples;
}
