import { expect, test } from "@playwright/test";
import type { CharacterProfile } from "../src/characterProfile";
import {
  NEXT_PROJECT_VERSION, parseNextProjectFile, reorderProjectWavs,
  resolveEffectiveLipMode, resolveWaitPreset, resolveWaitSeconds,
  serializeNextProjectFile, type NextProjectFile,
} from "../src/multiProjectFile";
import { inspectNextProjectSources } from "../src/multiProjectRestore";
import type { Layer } from "../src/LayerTree";

const wavPath = "/tmp/音声 e\u0301.wav";
const layers = [
  { path: "0", name: "顔", kind: "group", visible: true },
  { path: "0/0", name: "口", kind: "pixel", visible: true },
] as Layer[];

function characterProfile(id: string, path: string): CharacterProfile {
  return {
    format: "tachie-motion-character-profile", version: 2,
    source: { path, fingerprint: "1000:2000", layerPaths: ["0", "0/0"] },
    collection: {
      defaultId: id + "-default",
      items: [
        { id: id + "-default", name: "通常", blinkEnabled: false,
          base: layers.map((layer) => ({ path: layer.path, visible: layer.visible })) },
        { id: id + "-alternate", name: "笑顔", blinkEnabled: true,
          base: layers.map((layer) => ({ path: layer.path, visible: layer.visible })) },
      ],
    },
  };
}

function fixture(): NextProjectFile {
  const wav = { samples: 48000, sample_rate: 48000, duration_seconds: 1,
    source_identity: "1:2:3:4:5" };
  return {
    format: "tachie-motion-project", version: NEXT_PROJECT_VERSION,
    fps: 30, waitSeconds: "1.25", exportResolution: "half",
    openingWait: { enabled: true, secondsOverride: "0.75" },
    wavs: [
      { id: "speech-1", wavPath, wav, speakerId: "alice", speakerManual: true,
        waitAfter: true, waitSecondsOverride: "2.5" },
      { id: "speech-2", wavPath, wav, speakerId: null, speakerManual: false,
        waitAfter: false, waitSecondsOverride: null },
    ],
    characters: [
      { id: "alice", name: "あんこ e\u0301", profile: characterProfile("a", "/tmp/a.psd"),
        animations: [
          { wavId: "speech-1", presetId: "a-default", lipModeOverride: "open",
            presetChanges: [{ sample: 24000, presetId: "a-alternate" }] },
          { wavId: "speech-2", presetId: "a-alternate", lipModeOverride: null,
            presetChanges: [] },
        ],
        openingWaitPresetId: "a-alternate",
        waitOverrides: [{ wavId: "speech-1", presetId: "a-alternate" }] },
      { id: "bob", name: "ぼぶ", profile: characterProfile("b", "/tmp/b.psd"),
        animations: [
          { wavId: "speech-1", presetId: "b-default", lipModeOverride: "aiueo",
            presetChanges: [{ sample: 100, presetId: "b-alternate" }] },
          { wavId: "speech-2", presetId: "b-alternate", lipModeOverride: null,
            presetChanges: [] },
        ],
        openingWaitPresetId: null, waitOverrides: [] },
    ],
    selectedWavId: "speech-1",
    naming: { projectName: "作品", movTemplate: "{番号}_{キャラ名}_{WAV名}",
      otioTemplate: "{プロジェクト名}" },
  };
}

test("new model round-trips shared WAVs, independent character animations, and explicit waiting", () => {
  const saved = serializeNextProjectFile(fixture());
  const parsed = parseNextProjectFile(saved);
  expect(parsed.version).toBe(5);
  expect(parsed.fps).toBe(30);
  expect(parsed.waitSeconds).toBe("1.25");
  expect(parsed.exportResolution).toBe("half");
  expect(parsed.openingWait).toEqual({ enabled: true, secondsOverride: "0.75" });
  expect(parsed.wavs[0].speakerManual).toBe(true);
  expect(parsed.wavs[1].speakerManual).toBe(false);
  expect(resolveWaitSeconds(parsed, null)).toBe("0.75");
  expect(resolveWaitSeconds(parsed, "speech-1")).toBe("2.5");
  expect(parsed.wavs.map((wav) => wav.id)).toEqual(["speech-1", "speech-2"]);
  expect(parsed.wavs[0].wavPath).toBe(wavPath);
  expect(parsed.wavs[1].speakerId).toBeNull();
  expect(parsed.characters[0].animations[0].presetChanges).toEqual([
    { sample: 24000, presetId: "a-alternate" },
  ]);
  expect(parsed.characters[1].animations[0].lipModeOverride).toBe("aiueo");
  expect(resolveEffectiveLipMode(parsed, "bob", "speech-1", true)).toBe("none");
  expect(resolveWaitPreset(parsed, "alice", null)).toBe("a-alternate");
  expect(resolveWaitPreset(parsed, "bob", null)).toBe("b-default");
  expect(resolveWaitPreset(parsed, "alice", "speech-1")).toBe("a-alternate");
  expect(resolveWaitPreset(parsed, "bob", "speech-1")).toBe("b-default");
  expect(resolveWaitPreset(parsed, "bob", "speech-2")).toBeNull();
  expect(saved).not.toContain("outputDir");
  expect(saved).not.toContain("result");
  expect(saved).not.toContain("data:image");
});

test("reorder retains speaker, animation and wait override by stable WAV ID", () => {
  const source = parseNextProjectFile(serializeNextProjectFile(fixture()));
  const moved = reorderProjectWavs(source, "speech-2", "speech-1", false);
  const restored = parseNextProjectFile(serializeNextProjectFile(moved));
  expect(restored.wavs.map((entry) => entry.id)).toEqual(["speech-2", "speech-1"]);
  expect(restored.wavs[0].speakerId).toBeNull();
  expect(restored.wavs[1].speakerId).toBe("alice");
  expect(restored.characters[0].animations.find((entry) => entry.wavId === "speech-1")
    ?.presetChanges[0].sample).toBe(24000);
  expect(resolveWaitPreset(restored, "alice", "speech-1")).toBe("a-alternate");
  expect(resolveWaitSeconds(restored, "speech-1")).toBe("2.5");
  expect(resolveWaitSeconds(restored, null)).toBe("0.75");
  expect(source.wavs[0].id).toBe("speech-1");
});

test("default-linked waiting changes with the character default; override remains fixed", () => {
  const data = fixture();
  data.characters[1].profile.collection.defaultId = "b-alternate";
  data.characters[0].profile.collection.defaultId = "a-alternate";
  const result = parseNextProjectFile(serializeNextProjectFile(data));
  expect(resolveWaitPreset(result, "bob", "speech-1")).toBe("b-alternate");
  expect(resolveWaitPreset(result, "bob", null)).toBe("b-alternate");
  expect(resolveWaitPreset(result, "alice", "speech-1")).toBe("a-alternate");
  result.characters[0].profile.collection.defaultId = "a-default";
  expect(resolveWaitPreset(result, "alice", "speech-1")).toBe("a-alternate");
});

test("effective automatic/manual lip modes survive speaker changes and reset correctly", () => {
  const data = fixture();
  expect(resolveEffectiveLipMode(data, "alice", "speech-1", true)).toBe("open");
  expect(resolveEffectiveLipMode(data, "bob", "speech-1", true)).toBe("none");
  data.wavs[0].speakerId = "bob";
  expect(resolveEffectiveLipMode(data, "alice", "speech-1", false)).toBe("none");
  expect(resolveEffectiveLipMode(data, "bob", "speech-1", false)).toBe("aiueo");
  data.wavs[0].speakerId = "alice";
  const restored = parseNextProjectFile(serializeNextProjectFile(data));
  expect(resolveEffectiveLipMode(restored, "alice", "speech-1", true)).toBe("open");
  restored.characters[0].animations[0].lipModeOverride = null;
  expect(resolveEffectiveLipMode(restored, "alice", "speech-1", true)).toBe("aiueo");
  expect(resolveEffectiveLipMode(restored, "alice", "speech-1", false)).toBe("open");
  restored.characters[0].animations[0].lipModeOverride = "none";
  expect(resolveEffectiveLipMode(restored, "alice", "speech-1", true)).toBe("none");
});

test("base seconds follow the project; explicit seconds and opening presets do not", () => {
  const data = fixture();
  data.waitSeconds = "3";
  expect(resolveWaitSeconds(data, null)).toBe("0.75");
  expect(resolveWaitSeconds(data, "speech-1")).toBe("2.5");
  data.openingWait.secondsOverride = null;
  data.wavs[0].waitSecondsOverride = null;
  expect(resolveWaitSeconds(data, null)).toBe("3");
  expect(resolveWaitSeconds(data, "speech-1")).toBe("3");
  data.openingWait.enabled = false;
  data.characters[0].openingWaitPresetId = null;
  expect(resolveWaitSeconds(data, null)).toBeNull();
  expect(resolveWaitPreset(data, "alice", null)).toBeNull();
});

test("strict parser rejects dangling IDs, malformed sources, invalid timing and extra fields", () => {
  const cases: ((data: NextProjectFile & Record<string, any>) => void)[] = [
    (data) => { data.version = 4 as unknown as typeof data.version; },
    (data) => { data.format = "wrong" as unknown as typeof data.format; },
    (data) => { data.fps = 25 as unknown as typeof data.fps; },
    (data) => { data.exportResolution = "2x" as any; },
    (data) => { delete (data as any).exportResolution; },
    (data) => { (data.openingWait as any).enabled = "yes"; },
    (data) => { data.openingWait.secondsOverride = "3601"; },
    (data) => { data.openingWait.enabled = false; },
    (data) => { delete (data as any).openingWait; },
    (data) => { data.waitSeconds = "-1"; },
    (data) => { data.waitSeconds = "1e2"; },
    (data) => { data.waitSeconds = "3600.01"; },
    (data) => { data.waitSeconds = "0.1234567"; },
    (data) => { data.wavs[1].id = "speech-1"; },
    (data) => { data.wavs[1].id = "__proto__"; },
    (data) => { data.wavs[0].wavPath = "../relative.wav"; },
    (data) => { data.wavs[0].wav.source_identity = "bad"; },
    (data) => { data.wavs[0].wav.samples = 0; },
    (data) => { data.wavs[0].speakerId = "missing"; },
    (data) => { (data.wavs[0] as any).speakerManual = "manual"; },
    (data) => { data.wavs[0].waitSecondsOverride = "-1"; },
    (data) => { data.wavs[1].waitSecondsOverride = "1"; },
    (data) => { data.wavs[0].waitAfter = false; },
    (data) => { data.characters[1].id = "alice"; },
    (data) => { data.characters[1].name = "あんこ e\u0301"; },
    (data) => { data.characters[0].animations[0].wavId = "unknown"; },
    (data) => { data.characters[0].animations.pop(); },
    (data) => { data.characters[0].animations[1].wavId = "speech-1"; },
    (data) => { data.characters[0].animations[0].presetId = "missing"; },
    (data) => { data.characters[0].animations[0].presetChanges[0].sample = 48000; },
    (data) => { data.characters[0].animations[0].presetChanges[0].presetId = "missing"; },
    (data) => { (data.characters[1].animations[0] as any).lipModeOverride = "invalid"; },
    (data) => { data.characters[0].openingWaitPresetId = "missing"; },
    (data) => { data.characters[0].waitOverrides[0].wavId = "speech-2"; },
    (data) => { data.characters[0].waitOverrides[0].presetId = "missing"; },
    (data) => { data.selectedWavId = "no-such-id"; },
    (data) => { data.characters[0].profile.collection.defaultId = "broken"; },
    (data) => { data.characters[0].profile.source.path = "relative.psd"; },
    (data) => { (data.naming as any).outputDir = "/tmp/output"; },
    (data) => { data.unknown = true; },
    (data) => { (data.wavs[0] as any).unknown = true; },
    (data) => { (data.characters[0].animations[0] as any).unknown = true; },
    (data) => { (data.characters[0].waitOverrides[0] as any).unknown = true; },
  ];
  for (const change of cases) {
    const data = fixture() as NextProjectFile & Record<string, any>;
    change(data);
    expect(() => parseNextProjectFile(JSON.stringify(data))).toThrow();
  }
});

test("candidate parser rejects old v4 instead of silently consuming or rewriting it", () => {
  const old = fixture() as NextProjectFile & Record<string, any>;
  old.version = 4;
  expect(() => parseNextProjectFile(JSON.stringify(old))).toThrow("未対応");
  const actualV4Shape = { format: "tachie-motion-project", version: 4,
    character: {}, items: [], selectedId: null, naming: {} };
  expect(() => parseNextProjectFile(JSON.stringify(actualV4Shape))).toThrow("未対応");
  expect(() => parseNextProjectFile("{")).toThrow("解析");
  expect(() => parseNextProjectFile(" ".repeat(16_000_001))).toThrow("大きすぎ");
});

test("source inspection deduplicates reads and does not modify parsed project", async () => {
  const project = parseNextProjectFile(serializeNextProjectFile(fixture()));
  const before = JSON.stringify(project);
  const calls: string[] = [];
  const inspected = await inspectNextProjectSources(project, {}, {}, new Set(),
    async <T>(kind: "psd" | "wav", path: string): Promise<T> => {
      calls.push(kind + ":" + path);
      if (kind === "psd") return { fingerprint: "1000:2000", layers } as T;
      return { samples: 48000, sample_rate: 48000, duration_seconds: 1,
        source_identity: "1:2:3:4:5" } as T;
    });
  expect(inspected.problems).toEqual([]);
  expect(Object.keys(inspected.psds)).toHaveLength(2);
  expect(Object.keys(inspected.wavs)).toHaveLength(2);
  expect(calls.filter((call) => call.startsWith("wav:"))).toHaveLength(1);
  expect(JSON.stringify(project)).toBe(before);
});

test("replaced or changed WAV requires approval; changed sample topology cannot keep points", async () => {
  const project = fixture();
  const read = async <T>(kind: "psd" | "wav"): Promise<T> => {
    if (kind === "psd") return { fingerprint: "1000:2000", layers } as T;
    return { samples: 48000, sample_rate: 48000, duration_seconds: 1,
      source_identity: "9:8:7:6:5" } as T;
  };
  const pending = await inspectNextProjectSources(project, {}, {}, new Set(), read);
  expect(pending.problems.filter((error) => error.kind === "wav")).toHaveLength(2);
  const approved = await inspectNextProjectSources(project, {}, {},
    new Set(["speech-1", "speech-2"]), read);
  expect(approved.problems).toEqual([]);
  const incompatible = await inspectNextProjectSources(project, {}, {},
    new Set(["speech-1", "speech-2"]), async <T>(kind: "psd" | "wav"): Promise<T> =>
      kind === "psd"
        ? { fingerprint: "1000:2000", layers } as T
        : { samples: 24000, sample_rate: 48000, duration_seconds: 0.5,
          source_identity: "9:8:7:6:5" } as T);
  expect(incompatible.problems).toContainEqual(expect.objectContaining({
    kind: "wav", key: "speech-1",
  }));
});

test("missing or mismatching PSD cannot be silently restored", async () => {
  const project = fixture();
  const broken = await inspectNextProjectSources(project, {}, {}, new Set(),
    async <T>(kind: "psd" | "wav", path: string): Promise<T> => {
      if (kind === "psd" && path === "/tmp/a.psd") throw new Error("missing PSD");
      if (kind === "psd") return { fingerprint: "changed", layers } as T;
      return { ...project.wavs[0].wav } as T;
    });
  expect(broken.problems).toContainEqual(expect.objectContaining({ kind: "psd", key: "alice" }));
  expect(broken.problems).toContainEqual(expect.objectContaining({ kind: "psd", key: "bob" }));
  expect(Object.keys(broken.psds)).toHaveLength(0);
});
