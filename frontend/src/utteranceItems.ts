export type WavData = {
  samples: number;
  sample_rate: number;
  duration_seconds: number;
};
export type ExportData = {
  mov: string;
  otio: string;
  frames: number;
  sample_count: number;
  warning?: string;
};
export type LipMode = "none" | "open";
export type Fps = 24 | 30 | 60;

export type UtteranceItem = {
  id: string;
  registrationOrder: number;
  wavPath: string;
  wav: WavData;
  presetId: string;
  mode: LipMode;
  fps: Fps;
  outputDir: string;
  basename: string;
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
    id, registrationOrder: sequence, wavPath, wav, presetId, mode: "none", fps: 30, outputDir,
    basename: "speech_" + String(sequence).padStart(3, "0"),
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

export function wavFilename(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}
