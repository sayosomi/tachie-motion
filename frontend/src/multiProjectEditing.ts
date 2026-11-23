import type { CharacterProfile } from "./characterProfile";
import {
  NEXT_PROJECT_VERSION, parseNextProjectFile, type NextProjectFile,
  type ProductionCharacter, type SharedProjectWav,
} from "./multiProjectFile";
import type { NextProjectInspection } from "./multiProjectRestore";

/** New workflow has its own editor state; no v4 file or browser draft is overwritten. */
export function initialProductionProject(): NextProjectFile {
  return {
    format: "tachie-motion-project", version: NEXT_PROJECT_VERSION,
    fps: 30, waitSeconds: "1",
    wavs: [], characters: [], selectedWavId: null,
    naming: { projectName: "project", movTemplate: "{番号}_{キャラ名}_{WAV名}",
      otioTemplate: "{プロジェクト名}", outputDir: "" },
  };
}

/** Validate before publishing an edit; do not silently repair malformed input. */
export function checkedProductionEdit(next: NextProjectFile): NextProjectFile {
  return parseNextProjectFile(JSON.stringify(next));
}

export function addProductionCharacter(
  project: NextProjectFile, id: string, name: string, profile: CharacterProfile,
): NextProjectFile {
  if (!profile.collection.defaultId) {
    throw new Error("キャラクターの既定プリセットを設定してください");
  }
  const character: ProductionCharacter = {
    id, name, profile,
    animations: project.wavs.map((wav) => ({
      wavId: wav.id, presetId: profile.collection.defaultId!,
      presetChanges: [], lipMode: "none",
    })),
    waitOverrides: [],
  };
  return checkedProductionEdit({
    ...project, characters: [...project.characters, character],
  });
}

export function addProductionWav(
  project: NextProjectFile, entry: SharedProjectWav,
): NextProjectFile {
  return checkedProductionEdit({
    ...project,
    wavs: [...project.wavs, entry],
    selectedWavId: entry.id,
    characters: project.characters.map((character) => ({
      ...character,
      animations: [...character.animations, {
        wavId: entry.id,
        presetId: character.profile.collection.defaultId!,
        presetChanges: [], lipMode: "none" as const,
      }],
    })),
  });
}

export function removeProductionWav(project: NextProjectFile, wavId: string): NextProjectFile {
  return checkedProductionEdit({
    ...project,
    wavs: project.wavs.filter((wav) => wav.id !== wavId),
    selectedWavId: project.selectedWavId === wavId ? null : project.selectedWavId,
    characters: project.characters.map((character) => ({
      ...character,
      animations: character.animations.filter((entry) => entry.wavId !== wavId),
      waitOverrides: character.waitOverrides.filter((entry) => entry.wavId !== wavId),
    })),
  });
}

export function removeProductionCharacter(project: NextProjectFile, id: string): NextProjectFile {
  return checkedProductionEdit({
    ...project,
    wavs: project.wavs.map((wav) => wav.speakerId === id ?
      { ...wav, speakerId: null } : wav),
    characters: project.characters.filter((character) => character.id !== id),
  });
}

/** On approved replacement, keep newly inspected paths and WAV identities. */
export function applyProductionInspection(
  project: NextProjectFile, inspection: NextProjectInspection,
  psdPaths: Readonly<Record<string, string>>,
  wavPaths: Readonly<Record<string, string>>,
): NextProjectFile {
  if (inspection.problems.length) throw new Error("未解決の参照元があります");
  if (project.wavs.some((wav) => !inspection.wavs[wav.id]) ||
      project.characters.some((character) => !inspection.psds[character.id])) {
    throw new Error("元ファイルの検査結果が不足しています");
  }
  return checkedProductionEdit({
    ...project,
    wavs: project.wavs.map((wav) => ({
      ...wav, wavPath: wavPaths[wav.id] ?? wav.wavPath,
      wav: inspection.wavs[wav.id],
    })),
    characters: project.characters.map((character) => ({
      ...character,
      profile: {
        ...character.profile,
        source: {
          ...character.profile.source,
          path: psdPaths[character.id] ?? character.profile.source.path,
        },
      },
    })),
  });
}
