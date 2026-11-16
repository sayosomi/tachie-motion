import { expect, test } from "@playwright/test";
import {
  expandName, initialNaming, movName, otioName, validateBatchNaming, validateOutputName,
} from "../src/nameTemplate";

test("four placeholders expand with numbered order and unchanged Unicode NFD", () => {
  const n = initialNaming("/Volumes/立ち絵/ずんだもん.psd", "/tmp/out");
  expect(n.characterName).toBe("ずんだもん");
  expect(n.projectName).toBe("project");
  const wav = "/Volumes/音声/あんこもん た\u0301゙んもん.wav";
  const one = movName("{番号}_{キャラ名}_{WAV名}", 1, wav, "ずんだもん", "作品");
  const two = movName("{番号}_{キャラ名}_{WAV名}", 2, wav, "あんこもん", "作品");
  expect(one).toBe("001_ずんだもん_あんこもん た\u0301゙んもん");
  expect(two).toBe("002_あんこもん_あんこもん た\u0301゙んもん");
  expect(otioName("{プロジェクト名}", "作品")).toBe("作品");
  expect(validateBatchNaming({ ...n, projectName: "作品" }).projectName).toBe("作品");
});

test("reject unknown, nested, partial and timeline-invalid placeholders", () => {
  for (const template of ["{name}", "{番号:03}", "{{番号}}", "{番号", "番号}", ""]) {
    expect(() => movName(template, 1, "/tmp/a.wav", "キャラ", "作品")).toThrow();
  }
  for (const template of ["{番号}", "{WAV名}", "{キャラ名}", "{謎}"]) {
    expect(() => otioName(template, "作品")).toThrow();
  }
  expect(() => expandName("{番号}_{キャラ名}", { 番号: "001", キャラ名: "2" })).not.toThrow();
});

test("output names cannot be unsafe paths, reserved names or invalid Unicode", () => {
  for (const s of ["", "../escape", ".hidden", "CON", "NUL", "hi/bad", "hi\\bad",
                    "test?", "bad.", "bad ", "abc\nx", "a".repeat(181)]) {
    expect(() => validateOutputName(s)).toThrow();
  }
});
