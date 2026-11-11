import { expect, test } from "@playwright/test";
import type { Layer } from "../src/LayerTree";
import type { PresetDraft } from "../src/presetDraftStorage";
import type { UtteranceItem } from "../src/utteranceItems";
import {
  parseProjectFile, projectPresetDraft, serializeProjectFile,
} from "../src/projectFile";

const source = "/tmp/立ち絵 e\u0301.psd";
const wavPath = "/tmp/音声 e\u0301.wav";
const layers = [
  { path: "0", kind: "group", visible: true },
  { path: "0/0", kind: "pixel", visible: true },
  { path: "0/1", kind: "pixel", visible: false },
] as Layer[];
const draft: PresetDraft = {
  version: 1, path: source, fingerprint: "1000:2000", nameDrafts: {},
  collection: { defaultId: "p1", items: [{
    id: "p1", name: "通常", blinkEnabled: false,
    base: layers.map((l) => ({ path: l.path, visible: l.visible })),
    openMouth: {
      closed: [{ path: "0/0", visible: true }, { path: "0/1", visible: false }],
      opened: [{ path: "0/0", visible: false }, { path: "0/1", visible: true }],
    },
  }] },
};
const makeWav = (id: string, order: number): UtteranceItem => ({
  id, registrationOrder: order, wavPath,
  wav: { samples: 48000, sample_rate: 48000, duration_seconds: 1,
    source_identity: "1:2:3:4:5" },
  presetId: "p1", mode: "open", fps: 30,
  outputDir: "/tmp/output", basename: "speech_" + order,
  conflictChoice: "overwrite", saveAsName: null,
  result: { mov: "do-not-store.mov", otio: "do-not-store.otio", frames: 30, sample_count: 48000 },
  error: "do-not-store",
});

function valid() {
  return JSON.parse(serializeProjectFile(draft, layers, [
    makeWav("a", 1), makeWav("b", 2),
  ], "b")) as Record<string, any>;
}

test("project JSON keeps duplicate WAV registrations, Unicode and exact settings", () => {
  const json = serializeProjectFile(draft, layers, [
    makeWav("a", 1), makeWav("b", 2),
  ], "b");
  const restored = parseProjectFile(json);
  expect(restored.items.map((x) => x.id)).toEqual(["a", "b"]);
  expect(restored.items[0].wavPath).toBe(wavPath);
  expect(restored.items[1].wavPath).toBe(wavPath);
  expect(restored.character.source.path).toBe(source);
  expect(restored.selectedId).toBe("b");
  expect(restored.items[0].mode).toBe("open");
  expect(restored.items[0].wav.source_identity).toBe("1:2:3:4:5");
  expect(projectPresetDraft(restored).collection.items[0].openMouth)
    .toEqual(draft.collection.items[0].openMouth);
  expect(json).not.toContain("do-not-store");
  expect(json).not.toContain("result");
  expect(json).not.toContain("nameDrafts");
});

test("project parser rejects malformed IDs, paths, versions, references and signatures", () => {
  const base = valid();
  const cases: ((v: Record<string, any>) => void)[] = [
    (v) => { v.version = 999; },
    (v) => { v.items[1].id = "a"; },
    (v) => { v.items[1].registrationOrder = 1; },
    (v) => { v.items[0].id = "__proto__"; },
    (v) => { v.items[0].wavPath = "relative.wav"; },
    (v) => { v.items[0].wav.source_identity = ""; },
    (v) => { v.items[0].wav.source_identity = "1:2:three:4:5"; },
    (v) => { v.items[0].presetId = "missing"; },
    (v) => { v.items[0].mode = "aiueo"; },
    (v) => { v.items[0].fps = 23; },
    (v) => { v.items[0].basename = "../escape"; },
    (v) => { v.items[0].outputDir = "relative"; },
    (v) => { v.items[0].wav.samples = 0; },
    (v) => { v.items[0].wav.duration_seconds = 9; },
    (v) => { v.selectedId = "not-present"; },
    (v) => { v.character.collection.defaultId = "absent"; },
    (v) => { v.character.source.layerPaths = ["0", "0/0", "0/0"]; },
    (v) => { v.items[0].extra = "invalid"; },
    (v) => { v.items = Array.from({ length: 2001 }, () => v.items[0]); },
  ];
  for (const change of cases) {
    const data = structuredClone(base);
    change(data);
    expect(() => parseProjectFile(JSON.stringify(data))).toThrow();
  }
});

test("project format does not accept character profile JSON or oversized data", () => {
  expect(() => parseProjectFile("{")).toThrow("解析");
  expect(() => parseProjectFile(JSON.stringify({
    ...valid(), format: "tachie-motion-character-profile",
  }))).toThrow("未対応");
  expect(() => parseProjectFile(" ".repeat(4_000_001))).toThrow("大きすぎ");
});

test("project snapshot returned for editing cannot mutate parsed source", () => {
  const parsed = parseProjectFile(JSON.stringify(valid()));
  const next = projectPresetDraft(parsed);
  next.collection.items[0].name = "変更した設定";
  expect(parsed.character.collection.items[0].name).toBe("通常");
});

test("v1 project imports naming defaults without changing saved WAV settings", () => {
  const v1 = valid();
  v1.version = 1;
  delete v1.naming;
  const parsed = parseProjectFile(JSON.stringify(v1));
  expect(parsed.version).toBe(2);
  expect(parsed.naming.movTemplate).toBe("{番号}_{キャラ名}_{WAV名}");
  expect(parsed.naming.otioTemplate).toBe("{プロジェクト名}");
  expect(parsed.items[0].wavPath).toBe(wavPath);
});
