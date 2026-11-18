/** Character-wide blink timing, expressed in integer milliseconds.
 * Suggested form values are not automatically saved or applied to video.
 */
export type BlinkTiming = {
  intervalMs: number;
  closedMs: number;
  jitterMs: number;
  phaseMs: number;
  seed: number;
};

/** Initial form suggestions, not a hidden output default or an auto-save. */
export const SUGGESTED_BLINK_TIMING: BlinkTiming = {
  intervalMs: 3000, closedMs: 120, jitterMs: 500, phaseMs: 700, seed: 0,
};

const KEYS = ["intervalMs", "closedMs", "jitterMs", "phaseMs", "seed"] as const;

export function validBlinkTiming(value: unknown): value is BlinkTiming {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const timing = value as Record<string, unknown>;
  if (Object.keys(timing).length !== KEYS.length ||
      KEYS.some((key) => !Number.isSafeInteger(timing[key]))) return false;
  const fields = timing as BlinkTiming;
  return fields.intervalMs >= 1 && fields.intervalMs <= 600000 &&
    fields.closedMs >= 1 && fields.closedMs <= 10000 &&
    fields.jitterMs >= 0 && fields.jitterMs <= 600000 &&
    fields.phaseMs >= 0 && fields.phaseMs <= 600000 &&
    fields.closedMs + fields.jitterMs < fields.intervalMs;
}

export type BlinkFrames = {
  interval_frames: number;
  closed_frames: number;
  jitter_frames: number;
  phase_frames: number;
  seed: number;
};

/** Conversion belongs at the export boundary; time remains FPS independent. */
export function blinkFrames(timing: unknown, fps: number): BlinkFrames | null {
  if (!validBlinkTiming(timing) || ![24, 30, 60].includes(fps)) return null;
  const interval_frames = Math.round(timing.intervalMs * fps / 1000);
  const closed_frames = Math.round(timing.closedMs * fps / 1000);
  const jitter_frames = Math.round(timing.jitterMs * fps / 1000);
  const phase_frames = Math.round(timing.phaseMs * fps / 1000);
  if (closed_frames < 1 || interval_frames - jitter_frames <= closed_frames) return null;
  return { interval_frames, closed_frames, jitter_frames, phase_frames, seed: timing.seed };
}
