/**
 * A change point selects the stable preset ID from a PCM sample boundary
 * until the next change point. The utterance's presetId is the state at sample 0.
 * A position is never stored as floating-point seconds or a video frame index.
 */
export type PresetChangePoint = Readonly<{ sample: number; presetId: string }>;
export const MAX_PRESET_CHANGE_POINTS = 2048;

function validSampleCount(samples: number): boolean {
  return Number.isSafeInteger(samples) && samples >= 1;
}

function validatePosition(sample: number, samples: number): void {
  if (!validSampleCount(samples) || !Number.isSafeInteger(sample) ||
      sample < 1 || sample >= samples) {
    throw new Error("変更点はWAVの開始より後、終了より前のPCMサンプル位置で指定してください");
  }
}

/** Fail closed on malformed imported data; do not sort or silently repair it. */
export function assertPresetChangePoints(
  value: unknown, samples: number, presetIds: ReadonlySet<string>,
): asserts value is PresetChangePoint[] {
  if (!validSampleCount(samples) || !Array.isArray(value) ||
      value.length > MAX_PRESET_CHANGE_POINTS) {
    throw new Error("プリセット変更点の件数またはWAV尺が不正です");
  }
  let previous = 0;
  for (const raw of value as unknown[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("プリセット変更点の形式が不正です");
    }
    const point = raw as Record<string, unknown>;
    if (Object.keys(point).length !== 2 ||
        !Object.hasOwn(point, "sample") || !Object.hasOwn(point, "presetId") ||
        typeof point.sample !== "number" ||
        typeof point.presetId !== "string" ||
        !point.presetId || point.presetId.length > 256 ||
        !presetIds.has(point.presetId)) {
      throw new Error("プリセット変更点の項目または参照先が不正です");
    }
    validatePosition(point.sample, samples);
    if (point.sample <= previous) {
      throw new Error("プリセット変更点の時刻が重複または逆順です");
    }
    previous = point.sample;
  }
}

export function addPresetChangePoint(
  current: readonly PresetChangePoint[], sample: number, presetId: string,
  samples: number, presetIds: ReadonlySet<string>,
): PresetChangePoint[] {
  assertPresetChangePoints(current, samples, presetIds);
  validatePosition(sample, samples);
  if (!presetIds.has(presetId)) throw new Error("変更先のプリセットが見つかりません");
  if (current.length >= MAX_PRESET_CHANGE_POINTS) {
    throw new Error("プリセット変更点の上限を超えています");
  }
  if (current.some((point) => point.sample === sample)) {
    throw new Error("この時刻にはすでにプリセット変更点があります");
  }
  return [...current, { sample, presetId }].sort((a, b) => a.sample - b.sample);
}

export function movePresetChangePoint(
  current: readonly PresetChangePoint[], oldSample: number, newSample: number,
  samples: number, presetIds: ReadonlySet<string>,
): PresetChangePoint[] {
  assertPresetChangePoints(current, samples, presetIds);
  validatePosition(newSample, samples);
  if (!current.some((point) => point.sample === oldSample)) {
    throw new Error("移動元のプリセット変更点が見つかりません");
  }
  if (newSample !== oldSample && current.some((point) => point.sample === newSample)) {
    throw new Error("移動先にはすでにプリセット変更点があります");
  }
  return current.map((point) => point.sample === oldSample
    ? { ...point, sample: newSample } : { ...point })
    .sort((a, b) => a.sample - b.sample);
}

export function replacePresetChangePoint(
  current: readonly PresetChangePoint[], sample: number, presetId: string,
  samples: number, presetIds: ReadonlySet<string>,
): PresetChangePoint[] {
  assertPresetChangePoints(current, samples, presetIds);
  if (!presetIds.has(presetId)) throw new Error("変更先のプリセットが見つかりません");
  if (!current.some((point) => point.sample === sample)) {
    throw new Error("プリセット変更点が見つかりません");
  }
  return current.map((point) => point.sample === sample
    ? { ...point, presetId } : { ...point });
}

export function removePresetChangePoint(
  current: readonly PresetChangePoint[], sample: number,
  samples: number, presetIds: ReadonlySet<string>,
): PresetChangePoint[] {
  assertPresetChangePoints(current, samples, presetIds);
  if (!current.some((point) => point.sample === sample)) {
    throw new Error("プリセット変更点が見つかりません");
  }
  return current.filter((point) => point.sample !== sample).map((point) => ({ ...point }));
}

/** Resolve the latest change at or before the requested integer PCM sample. */
export function presetAtSample(
  initialPresetId: string, points: readonly PresetChangePoint[], sample: number,
): string {
  if (!Number.isSafeInteger(sample) || sample < 0) {
    throw new Error("PCMサンプル位置が不正です");
  }
  let result = initialPresetId;
  for (const point of points) {
    if (point.sample > sample) break;
    result = point.presetId;
  }
  return result;
}

/**
 * Match the existing aiueo rule: sample the center of the video frame in
 * WAV sample-time, clamping the final partial frame to the last PCM sample.
 * BigInt avoids JS number overflow for long clips or high sample rates.
 */
export function frameCenterSample(
  frame: number, fps: 24 | 30 | 60, sampleRate: number, samples: number,
): number {
  if (!Number.isSafeInteger(frame) || frame < 0 ||
      ![24, 30, 60].includes(fps) ||
      !Number.isSafeInteger(sampleRate) || sampleRate < 1 ||
      !validSampleCount(samples)) {
    throw new Error("動画フレームまたはWAV尺が不正です");
  }
  const position = (BigInt(2) * BigInt(frame) + BigInt(1)) *
    BigInt(sampleRate) / (BigInt(2) * BigInt(fps));
  return Number(position >= BigInt(samples) ? BigInt(samples - 1) : position);
}
