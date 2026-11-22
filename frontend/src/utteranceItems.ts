export type WavData = {
  samples: number;
  sample_rate: number;
  duration_seconds: number;
  source_identity: string;
};
export type ExportData = {
  mov: string;
   frames: number;
  sample_count: number;
  warning?: string;
};
export type LipMode = "none" | "open" | "aiueo";
export type Fps = 24 | 30 | 60;
/** Explicit gap following one WAV; never inferred from adjacent presets. */
export type IdleAfter = { id: string; presetId: string; frames: number; fps: Fps };
import type { PresetChangePoint } from "./presetChangePoints";

export type UtteranceItem = {
  id: string;
  registrationOrder: number;
  wavPath: string;
  wav: WavData;
  presetId: string;
  idleAfter?: IdleAfter | null;
  /** Optional for internal legacy fixtures; new registrations always own their own list. */
  presetChanges?: PresetChangePoint[];
  mode: LipMode;
  fps: Fps;
  outputDir: string;
  basename: string;
  // An explicit edit pins this name; otherwise the shared MOV template applies.
  basenameEdited: boolean;
  conflictChoice: "overwrite" | "rename";
  saveAsName: string | null;
  result: ExportData | null;
  error: string;
};

// Two registrations of the same source are intentionally different items.
export function createUtterance(
  id: string, wavPath: string, wav: WavData, presetId: string,
  outputDir: string, sequence: number,
): UtteranceItem {
  return {
    id, registrationOrder: sequence, wavPath, wav, presetId, idleAfter: null, presetChanges: [], mode: "none", fps: 30, outputDir,
    basename: "speech_" + String(sequence).padStart(3, "0"), basenameEdited: false,
    conflictChoice: "overwrite", saveAsName: null, result: null, error: "",
  };
}

export function updateUtterance(
  items: UtteranceItem[], id: string, patch: Partial<UtteranceItem>,
): UtteranceItem[] {
  return items.map((item) => item.id === id
    ? { ...item, ...patch, result: null, error: "" }
    : item);
}

export function moveUtterance(
  items: UtteranceItem[], id: string, delta: -1 | 1,
): UtteranceItem[] {
  const index = items.findIndex((item) => item.id === id);
  const next = index + delta;
  if (index < 0 || next < 0 || next >= items.length) return items;
  const result = [...items];
  [result[index], result[next]] = [result[next], result[index]];
  return result;
}

// Drag and drop preserves each item's ID and independent edit settings.
export function reorderUtterances(
  items: UtteranceItem[], sourceId: string, targetId: string, after: boolean,
): UtteranceItem[] {
  if (sourceId === targetId) return items;
  const sourceIndex = items.findIndex((item) => item.id === sourceId);
  if (sourceIndex < 0 || !items.some((item) => item.id === targetId)) return items;
  const result = [...items];
  const [source] = result.splice(sourceIndex, 1);
  const targetIndex = result.findIndex((item) => item.id === targetId);
  result.splice(targetIndex + (after ? 1 : 0), 0, source);
  return result;
}

export function wavFilename(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}
