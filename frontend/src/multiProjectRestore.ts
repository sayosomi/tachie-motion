import { validateCharacterProfileOpenTargets } from "./characterProfile";
import { assertPresetChangePoints } from "./presetChangePoints";
import type { PsdInspection, ProjectProblem } from "./projectRestore";
import type { NextProjectFile } from "./multiProjectFile";
import type { WavData } from "./utteranceItems";

export type NextProjectInspection = {
  psds: Record<string, PsdInspection>;
  wavs: Record<string, WavData>;
  problems: ProjectProblem[];
};

type ReadSource = <T>(kind: "psd" | "wav", path: string) => Promise<T>;

/** Each distinct source is read once; repeated WAV rows remain separate edit IDs. */
async function readDistinct<T>(
  paths: readonly string[], kind: "psd" | "wav", read: ReadSource,
): Promise<Map<string, T | Error>> {
  const results = new Map<string, T | Error>();
  const distinct = [...new Set(paths)];
  const BATCH_SIZE = 6;
  for (let start = 0; start < distinct.length; start += BATCH_SIZE) {
    await Promise.all(distinct.slice(start, start + BATCH_SIZE).map(async (path) => {
      try {
        results.set(path, await read<T>(kind, path));
      } catch (error) {
        results.set(path, error instanceof Error ? error : new Error(String(error)));
      }
    }));
  }
  return results;
}

/**
 * Resolve all references before committing any multi-character editor state.
 * The caller owns the confirmation, staging and atomic UI state replacement.
 * Failed inspection never writes to project files, PSDs, WAVs, LABs or storage.
 */
export async function inspectNextProjectSources(
  project: NextProjectFile,
  psdPaths: Readonly<Record<string, string>>,
  wavPaths: Readonly<Record<string, string>>,
  approvedWavChanges: ReadonlySet<string>,
  read: ReadSource,
): Promise<NextProjectInspection> {
  const problems: ProjectProblem[] = [];
  const psds: Record<string, PsdInspection> = Object.create(null);
  const wavs: Record<string, WavData> = Object.create(null);

  const psdPathFor = (id: string, saved: string) => psdPaths[id] ?? saved;
  const wavPathFor = (id: string, saved: string) => wavPaths[id] ?? saved;
  const inspectedPsds = await readDistinct<PsdInspection>(
    project.characters.map((character) =>
      psdPathFor(character.id, character.profile.source.path)), "psd", read);
  const inspectedWavs = await readDistinct<WavData>(
    project.wavs.map((wav) => wavPathFor(wav.id, wav.wavPath)), "wav", read);

  for (const character of project.characters) {
    const source = character.profile.source;
    const path = psdPathFor(character.id, source.path);
    const result = inspectedPsds.get(path);
    try {
      if (!result || result instanceof Error) {
        throw result ?? new Error("PSDの確認に失敗しました");
      }
      if (result.fingerprint !== source.fingerprint ||
          result.layers.length !== source.layerPaths.length ||
          result.layers.some((layer, index) => layer.path !== source.layerPaths[index])) {
        throw new Error("PSDの内容またはレイヤー構造が保存時と一致しません");
      }
      validateCharacterProfileOpenTargets(character.profile, result.layers);
      psds[character.id] = result;
    } catch (error) {
      problems.push({ kind: "psd", key: character.id, path,
        message: error instanceof Error ? error.message : String(error) });
    }
  }

  for (const wav of project.wavs) {
    const path = wavPathFor(wav.id, wav.wavPath);
    const result = inspectedWavs.get(path);
    try {
      if (!result || result instanceof Error) {
        throw result ?? new Error("WAVの確認に失敗しました");
      }
      if (!Number.isSafeInteger(result.samples) || result.samples < 1 ||
          !Number.isSafeInteger(result.sample_rate) || result.sample_rate < 1 ||
          typeof result.source_identity !== "string" ||
          !/^[0-9]+(:[0-9]+){4}$/.test(result.source_identity) ||
          !Number.isFinite(result.duration_seconds) ||
          Math.abs(result.duration_seconds - result.samples / result.sample_rate) > 0.001) {
        throw new Error("WAVの解析結果が不正です");
      }
      if (path === wav.wavPath && result.source_identity !== wav.wav.source_identity &&
          !approvedWavChanges.has(wav.id)) {
        throw new Error("保存時からWAVが変更されています。差し替えを明示的に承認してください");
      }
      const hasChangePoints = project.characters.some((character) =>
        character.animations.some((entry) =>
          entry.wavId === wav.id && entry.presetChanges.length > 0));
      if (hasChangePoints &&
          (result.samples !== wav.wav.samples || result.sample_rate !== wav.wav.sample_rate)) {
        throw new Error("変更点のあるWAVのサンプル数またはサンプルレートが保存時と異なります");
      }
      for (const character of project.characters) {
        const settings = character.animations.find((entry) => entry.wavId === wav.id);
        if (!settings) throw new Error("WAV×キャラの設定参照が不正です");
        assertPresetChangePoints(settings.presetChanges, result.samples,
          new Set(character.profile.collection.items.map((entry) => entry.id)));
      }
      wavs[wav.id] = result;
    } catch (error) {
      problems.push({ kind: "wav", key: wav.id, path,
        message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { psds, wavs, problems };
}
