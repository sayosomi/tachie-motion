import type { Layer } from "./LayerTree";
import {
  validateCharacterProfileOpenTargets, type CharacterProfile,
} from "./characterProfile";
import type { ProjectFile } from "./projectFile";
import type { WavData } from "./utteranceItems";

export type PsdInspection = {
  fingerprint: string;
  layers: Layer[];
};
export type ProjectProblem = { key: string; path: string; message: string };
export type ProjectInspection = {
  psd: PsdInspection | null;
  wavs: Record<string, WavData>;
  problems: ProjectProblem[];
};
type ReadSource = <T>(type: "psd" | "wav", path: string) => Promise<T>;

/** Inspect every distinct referenced file before replacing any editor state. */
export async function inspectProjectSources(
  project: ProjectFile,
  psdPath: string,
  wavPaths: Record<string, string>,
  confirmedChanges: ReadonlySet<string>,
  read: ReadSource,
): Promise<ProjectInspection> {
  const problems: ProjectProblem[] = [];
  const wavs: Record<string, WavData> = {};
  let psd: PsdInspection | null = null;
  const source: CharacterProfile["source"] = project.character.source;
  try {
    const result = await read<PsdInspection>("psd", psdPath);
    if (result.fingerprint !== source.fingerprint ||
        result.layers.length !== source.layerPaths.length ||
        result.layers.some((layer, i) => layer.path !== source.layerPaths[i])) {
      throw new Error("PSDの内容またはレイヤー構造が保存時と一致しません");
    }
    validateCharacterProfileOpenTargets(project.character, result.layers);
    psd = result;
  } catch (error) {
    problems.push({ key: "psd", path: psdPath,
      message: error instanceof Error ? error.message : String(error) });
  }

  // A repeated WAV registration has a distinct edit ID but shares one read.
  const paths = [...new Set(project.items.map((item) => wavPaths[item.id] ?? item.wavPath))];
  const inspected = new Map<string, WavData | Error>();
  const BATCH_SIZE = 6;
  for (let start = 0; start < paths.length; start += BATCH_SIZE) {
    await Promise.all(paths.slice(start, start + BATCH_SIZE).map(async (path) => {
      try {
        inspected.set(path, await read<WavData>("wav", path));
      } catch (error) {
        inspected.set(path, error instanceof Error ? error : new Error(String(error)));
      }
    }));
  }
  for (const item of project.items) {
    const path = wavPaths[item.id] ?? item.wavPath;
    const result = inspected.get(path);
    if (!result || result instanceof Error) {
      problems.push({ key: item.id, path,
        message: result instanceof Error ? result.message : "WAVの確認に失敗しました" });
      continue;
    }
    if (!Number.isSafeInteger(result.samples) || result.samples < 1 ||
        !Number.isSafeInteger(result.sample_rate) || result.sample_rate < 1 ||
        typeof result.source_identity !== "string" || !result.source_identity ||
        !Number.isFinite(result.duration_seconds) ||
        Math.abs(result.duration_seconds - result.samples / result.sample_rate) > 0.001) {
      problems.push({ key: item.id, path, message: "WAVの解析結果が不正です" });
      continue;
    }
    // A path change is an explicit replacement by the operator. A changed
    // file at the same path needs an additional affirmative confirmation.
    if (path === item.wavPath && item.wav.source_identity !== result.source_identity &&
        !confirmedChanges.has(item.id)) {
      problems.push({ key: item.id, path,
        message: "保存時からWAVが変更されています。差し替えを明示的に承認してください" });
      continue;
    }
    wavs[item.id] = result;
  }
  return { psd, wavs, problems };
}
