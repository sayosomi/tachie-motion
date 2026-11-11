import { wavFilename } from "./utteranceItems";

/** A deliberately small file naming language: no functions or escape syntax. */
export const DEFAULT_MOV_TEMPLATE = "{番号}_{キャラ名}_{WAV名}";
export const DEFAULT_OTIO_TEMPLATE = "{プロジェクト名}";

export type BatchNaming = {
  projectName: string;
  characterName: string;
  movTemplate: string;
  otioTemplate: string;
  outputDir: string;
};
export const initialNaming = (psd = "", outputDir = ""): BatchNaming => ({
  projectName: "project",
  characterName: psd.split(/[\\/]/).at(-1)?.replace(/\.psd$/i, "") || "character",
  movTemplate: DEFAULT_MOV_TEMPLATE,
  otioTemplate: DEFAULT_OTIO_TEMPLATE,
  outputDir,
});

const allNames = new Set(["番号", "WAV名", "キャラ名", "プロジェクト名"]);
const timelineNames = new Set(["プロジェクト名"]);

export function validateOutputName(value: string): string {
  if (!value || [...value].length > 120 ||
      new TextEncoder().encode(value).length > 180 ||
      value === "." || value === ".." || value.startsWith(".") ||
      /[ .]$/.test(value) || /[\\/:\*\?"<>\|]/u.test(value) ||
      [...value].some((char) => /\p{Cc}|\p{Cf}|\p{Cs}|\p{Co}/u.test(char)) ||
      /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(value)) {
    throw new Error("保存名に使用できない文字・長さがあります：" + value);
  }
  return value;
}

export function expandName(template: string, values: Record<string, string>,
  timeline = false): string {
  if (!template || template.length > 512) throw new Error("名前テンプレートが不正です");
  const accepted = timeline ? timelineNames : allNames;
  let result = "";
  let cursor = 0;
  for (const match of template.matchAll(/\{([^{}]+)\}/gu)) {
    const index = match.index;
    const plain = template.slice(cursor, index);
    if (/[{}]/u.test(plain)) throw new Error("プレースホルダーの括弧が不正です");
    result += plain;
    const name = match[1];
    if (!accepted.has(name)) throw new Error("使えないプレースホルダー：" + match[0]);
    result += values[name] ?? "";
    cursor = index + match[0].length;
  }
  const last = template.slice(cursor);
  if (/[{}]/u.test(last)) throw new Error("プレースホルダーの括弧が不正です");
  return validateOutputName(result + last);
}

export function movName(template: string, order: number, wavPath: string,
  characterName: string, projectName: string): string {
  if (!Number.isSafeInteger(order) || order < 1) throw new Error("順番が不正です");
  const name = wavFilename(wavPath).replace(/\.wav$/i, "");
  return expandName(template, {
    番号: String(order).padStart(3, "0"),
    WAV名: name,
    キャラ名: characterName,
    プロジェクト名: projectName,
  });
}

export function otioName(template: string, projectName: string): string {
  return expandName(template, { プロジェクト名: projectName }, true);
}

export function validateBatchNaming(value: unknown): BatchNaming {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("プロジェクトの命名設定が不正です");
  const o = value as Record<string, unknown>;
  const keys = ["projectName", "characterName", "movTemplate", "otioTemplate", "outputDir"];
  if (Object.keys(o).length !== keys.length ||
      keys.some((key) => typeof o[key] !== "string" || (o[key] as string).length > 8192)) {
    throw new Error("制作プロジェクトの命名設定が不正です");
  }
  const result = o as BatchNaming;
  validateOutputName(result.projectName);
  validateOutputName(result.characterName);
  movName(result.movTemplate, 1, "/tmp/example.wav",
    result.characterName, result.projectName);
  otioName(result.otioTemplate, result.projectName);
  if (!result.outputDir || !(
    result.outputDir.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(result.outputDir) ||
    result.outputDir.startsWith("\\\\")
  ) || result.outputDir.includes("\0")) {
    throw new Error("制作プロジェクトの出力フォルダが不正です");
  }
  return { ...result };
}
