import { expect, test } from "@playwright/test";
import type { UnifiedPreset } from "../src/presetModel";
import type { PresetDraft } from "../src/presetDraftStorage";
import { createUtterance } from "../src/utteranceItems";
import { aiueoMouthReady, effectiveLabSourceIdentity, exportPayload, exportReady, exportReadinessError } from "../src/utteranceExportRequest";

const base = [{ path: "0", visible: true }, { path: "0/0", visible: true }];
const keys = ["a", "i", "u", "e", "o", "n"] as const;
const shapes = Object.fromEntries(keys.map((key) => [
  key, [{ path: "0/0", visible: true }],
])) as NonNullable<UnifiedPreset["aiueoMouth"]>;
const preset: UnifiedPreset = {
  id: "p1", name: "通常", base,
  blinkEnabled: false, mouthMotionEnabled: true,
  aiueoMouth: shapes,
};
const draft: PresetDraft = {
  version: 2, path: "/tmp/portrait.psd", fingerprint: "1:2",
  nameDrafts: {}, collection: { defaultId: "p1", items: [preset],
    motionGroups: { mouth: ["0"] } },
};

test("aiueo is gated by six shapes and actual LAB status; Open and none stay valid", () => {
  const item = createUtterance("w1", "/tmp/声 e\u0301.wav", {
    samples: 1000, sample_rate: 1000, duration_seconds: 1,
    source_identity: "1:2:3:4:5",
  }, "p1", "/tmp", 1);
  const aiueo = { ...item, mode: "aiueo" as const };
  expect(aiueoMouthReady(preset)).toBe(true);
  expect(exportReady(preset, aiueo)).toBe(false);
  expect(exportReady(preset, aiueo, { status: "missing", reason: null })).toBe(false);
  expect(exportReady(preset, aiueo, { status: "invalid", reason: "bad" })).toBe(false);
  expect(exportReady(preset, aiueo, { status: "checking", reason: null })).toBe(false);
  expect(exportReady(preset, aiueo, { status: "valid", reason: null, source_identity: "1:2:3:4:5" })).toBe(true);
  // The rest mouth requires its own explicit choice even when base already shows that leaf.
  expect(aiueoMouthReady({ ...preset, aiueoMouth: { ...shapes, n: [] } })).toBe(false);
  expect(exportReady({ ...preset, aiueoMouth: { ...shapes, n: [] } },
    aiueo, { status: "valid", reason: null, source_identity: "1:2:3:4:5" })).toBe(false);
  expect(aiueoMouthReady({ ...preset, aiueoMouth: { ...shapes, a: [] } })).toBe(false);
  expect(exportReady({ ...preset, aiueoMouth: { ...shapes, a: [] } },
    aiueo, { status: "valid", reason: null, source_identity: "1:2:3:4:5" })).toBe(false);
  expect(exportReady(preset, item)).toBe(true);
  const fixed = { ...preset, mouthMotionEnabled: false };
  expect(exportReady(fixed, aiueo, { status: "missing", reason: null })).toBe(true);
});

test("corrupt aiueo shapes fail closed without throwing, including the explicit rest mouth", () => {
  const item = { ...createUtterance("w-corrupt", "/tmp/検証.wav", {
    samples: 1000, sample_rate: 1000, duration_seconds: 1,
    source_identity: "1:2:3:4:5",
  }, "p1", "/tmp", 1), mode: "aiueo" as const };
  const validLab = { status: "valid" as const, reason: null, source_identity: "lab:1" };
  const corrupt: Array<{ name: string; mouth: unknown; message: string }> = [
    { name: "missing entire mouth", mouth: undefined, message: "あ" },
    { name: "non-object mouth", mouth: "bad", message: "あ" },
    { name: "missing vowel", mouth: Object.fromEntries(keys.filter((key) => key !== "a")
      .map((key) => [key, shapes[key]])), message: "あ" },
    { name: "missing rest", mouth: Object.fromEntries(keys.filter((key) => key !== "n")
      .map((key) => [key, shapes[key]])), message: "ん" },
    { name: "empty rest", mouth: { ...shapes, n: [] }, message: "ん" },
    { name: "non-array vowel", mouth: { ...shapes, a: {} }, message: "あ" },
    { name: "null rest", mouth: { ...shapes, n: null }, message: "ん" },
    { name: "null entry", mouth: { ...shapes, n: [null] }, message: "ん" },
    { name: "non-string path", mouth: { ...shapes, n: [{ path: 4, visible: true }] }, message: "ん" },
    { name: "non-boolean visibility", mouth: { ...shapes, n: [{ path: "0/0", visible: "true" }] }, message: "ん" },
    { name: "only hidden rest", mouth: { ...shapes, n: [{ path: "0/0", visible: false }] }, message: "ん" },
    { name: "valid rest with corrupt extra entry", mouth: {
      ...shapes, n: [...shapes.n, { path: "0/1", visible: null }],
    }, message: "ん" },
    { name: "unknown mouth key", mouth: { ...shapes, x: shapes.a }, message: "不明なキー" },
  ];
  for (const { name, mouth, message } of corrupt) {
    const broken: UnifiedPreset = { ...preset,
      aiueoMouth: mouth as UnifiedPreset["aiueoMouth"] };
    expect(aiueoMouthReady(broken), name).toBe(false);
    expect(exportReady(broken, item, validLab), name).toBe(false);
    expect(exportReadinessError(broken, item, validLab), name).toContain(message);
    expect(exportReady({ ...broken, mouthMotionEnabled: false }, item, validLab), name).toBe(true);
  }
  expect(aiueoMouthReady(preset)).toBe(true);
  expect(exportReadinessError(preset, item, validLab)).toBeNull();
});

test("timeline change-point presets use the same defensive six-mouth guard", () => {
  const item = { ...createUtterance("w-timeline", "/tmp/検証.wav", {
    samples: 1000, sample_rate: 1000, duration_seconds: 1,
    source_identity: "1:2:3:4:5",
  }, "p1", "/tmp", 1), mode: "aiueo" as const,
    presetChanges: [{ sample: 500, presetId: "p2" }] };
  const broken: UnifiedPreset = { ...preset, id: "p2", name: "変更先",
    aiueoMouth: { ...shapes, n: null } as unknown as UnifiedPreset["aiueoMouth"] };
  const collection = { ...draft.collection, items: [preset, broken] };
  const lab = { status: "valid" as const, reason: null, source_identity: "lab:1" };
  expect(exportReadinessError(preset, item, lab, collection)).toContain("変更点 0.500秒");
  expect(exportReadinessError(preset, item, lab, collection)).toContain("ん");
  expect(exportReady(preset, item, lab, collection)).toBe(false);
  expect(exportReadinessError(preset, item, lab, {
    ...collection, items: [preset, { ...broken, aiueoMouth: shapes }],
  })).toBeNull();
});

test("mode-specific LAB identity is shared by the manifest and rendered payload", () => {
  const item = { ...createUtterance("w1", "/tmp/声 e\u0301.wav", {
    samples: 1000, sample_rate: 1000, duration_seconds: 1,
    source_identity: "1:2:3:4:5",
  }, "p1", "/tmp", 1), mode: "aiueo" as const };
  const one = exportPayload(draft, item, preset, "speech_001", "error", "1:2:3:4:5");
  expect(effectiveLabSourceIdentity(item, preset, "1:2:3:4:5")).toBe("1:2:3:4:5");
  expect(effectiveLabSourceIdentity({ ...item, mode: "none" }, preset, "1:2:3:4:5")).toBeNull();
  expect(effectiveLabSourceIdentity({ ...item, mode: "open" }, preset, "1:2:3:4:5")).toBeNull();
  expect(effectiveLabSourceIdentity(item, { ...preset, mouthMotionEnabled: false },
    "1:2:3:4:5")).toBeNull();
  expect(one).toMatchObject({
    mode: "aiueo", aiueo_mouth: shapes, mouth_groups: ["0"],
    source_identity: "1:2:3:4:5", lab_source_identity: "1:2:3:4:5",
  });
  const fixed = exportPayload(draft, item, {
    ...preset, mouthMotionEnabled: false,
  }, "speech_001", "error");
  expect(fixed.mode).toBe("none");
  expect(fixed.aiueo_mouth).toBeNull();
  expect(fixed.lab_source_identity).toBeNull();
  expect(exportPayload(draft, { ...item, mode: "none" }, preset,
    "speech_001", "error", "1:2:3:4:5").lab_source_identity).toBeNull();
  expect(exportPayload(draft, { ...item, mode: "open" }, preset,
    "speech_001", "error", "1:2:3:4:5").lab_source_identity).toBeNull();
});

test("preflight gives exact reason without changing single/batch readiness", () => {
  const item = createUtterance("w11", "/tmp/011_あんこもん.wav", {
    samples: 1000, sample_rate: 1000, duration_seconds: 1,
    source_identity: "1:2:3:4:5",
  }, "p1", "/tmp", 11);
  const reason = (p: UnifiedPreset | undefined, mode: typeof item.mode, lab?: {
    status: "valid" | "missing" | "invalid" | "checking" | "unavailable";
    reason: string | null; source_identity?: string | null;
  }, collection = draft.collection) =>
    exportReadinessError(p, { ...item, mode }, lab, collection);
  expect(reason(undefined, "none")).toContain("プリセットが存在しません");
  expect(reason(preset, "none")).toBeNull();
  expect(reason(preset, "open")).toContain("開いた口レイヤーが未設定");
  const openPreset = { ...preset, openMouth: {
    closed: [{ path: "0/0", visible: true }],
    opened: [{ path: "0/0", visible: true }],
  } };
  expect(reason(openPreset, "open")).toBeNull();

  expect(reason(preset, "aiueo", { status: "missing", reason: null })).toContain("LABファイルが見つかりません");
  expect(reason(preset, "aiueo", { status: "invalid", reason: "bad" })).toContain("LABの内容が不正");
  expect(reason(preset, "aiueo", { status: "checking", reason: null })).toContain("LABを確認中");
  expect(reason({ ...preset, aiueoMouth: { ...shapes, n: [] } }, "aiueo",
    { status: "valid", reason: null, source_identity: "1:2:3:4:5" })).toContain("ん");
  expect(reason(preset, "aiueo",
    { status: "valid", reason: null, source_identity: "1:2:3:4:5" })).toBeNull();

  const blinkPreset = { ...preset, blinkEnabled: true };
  expect(reason(blinkPreset, "none")).toContain("動作対象グループが未設定");
  const groups = { ...draft.collection, motionGroups: { mouth: ["0"], eyes: ["1"] } };
  expect(reason(blinkPreset, "none", undefined, groups)).toContain("閉じ目レイヤーが未選択");
  const withEyes = { ...blinkPreset, eyes: {
    opened: [], closed: [{ path: "0/0", visible: true }],
  } };
  expect(reason(withEyes, "none", undefined, groups)).toContain("瞬き時間を保存");
  const timing = { intervalMs: 3000, closedMs: 120, jitterMs: 500, phaseMs: 700, seed: 0 };
  expect(reason(withEyes, "none", undefined, { ...groups, blinkTiming: timing })).toBeNull();
  expect(reason(withEyes, "none", undefined, {
    ...groups, blinkTiming: { ...timing, closedMs: 1 },
  })).toContain("30fpsでは無効");
  expect(reason({ ...withEyes, mouthMotionEnabled: false }, "aiueo",
    { status: "missing", reason: null }, { ...groups, blinkTiming: timing })).toBeNull();
});
