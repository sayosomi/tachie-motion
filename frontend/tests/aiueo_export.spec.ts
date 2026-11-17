import { expect, test } from "@playwright/test";
import type { UnifiedPreset } from "../src/presetModel";
import type { PresetDraft } from "../src/presetDraftStorage";
import { createUtterance } from "../src/utteranceItems";
import { aiueoMouthReady, exportPayload, exportReady } from "../src/utteranceExportRequest";

const base = [{ path: "0", visible: true }, { path: "0/0", visible: true }];
const keys = ["a", "i", "u", "e", "o", "n"] as const;
const shapes = Object.fromEntries(keys.map((key) => [
  key, [{ path: "0/0", visible: key !== "a" }],
])) as NonNullable<UnifiedPreset["aiueoMouth"]>;
const preset: UnifiedPreset = {
  id: "p1", name: "通常", base,
  blinkEnabled: false, mouthMotionEnabled: true,
  aiueoMouth: shapes,
};
const draft: PresetDraft = {
  version: 1, path: "/tmp/portrait.psd", fingerprint: "1:2",
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
  expect(exportReady(preset, aiueo, { status: "valid", reason: null })).toBe(true);
  expect(exportReady({ ...preset, aiueoMouth: { ...shapes, n: [] } },
    aiueo, { status: "valid", reason: null })).toBe(false);
  expect(exportReady(preset, item)).toBe(true);
  const fixed = { ...preset, mouthMotionEnabled: false };
  expect(exportReady(fixed, aiueo, { status: "missing", reason: null })).toBe(true);
});

test("single and batch construct the same aiueo renderer payload", () => {
  const item = { ...createUtterance("w1", "/tmp/声 e\u0301.wav", {
    samples: 1000, sample_rate: 1000, duration_seconds: 1,
    source_identity: "1:2:3:4:5",
  }, "p1", "/tmp", 1), mode: "aiueo" as const };
  const one = exportPayload(draft, item, preset, "speech_001", "error");
  const batch = exportPayload(draft, item, preset, "speech_001", "error");
  expect(batch).toEqual(one);
  expect(one).toMatchObject({
    mode: "aiueo", aiueo_mouth: shapes, mouth_groups: ["0"],
    source_identity: "1:2:3:4:5",
  });
  const fixed = exportPayload(draft, item, {
    ...preset, mouthMotionEnabled: false,
  }, "speech_001", "error");
  expect(fixed.mode).toBe("none");
  expect(fixed.aiueo_mouth).toBeNull();
});
